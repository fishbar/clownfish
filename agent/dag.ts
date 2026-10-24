/**
 * DagStore — the session's shared execution-plan DAG state.
 *
 * One store per session (held by the {@link AgentRuntime}), persisted to
 * `<sessionId>/dag.json`. It is the single source of truth for every concurrent
 * DAG: the main agent, a spawned dagRoot agent, and any nested dagSub agents all
 * operate on it through scoped handles (see {@link DagStore.canModify}).
 *
 * Topology is a **tree**: each node owns a subtree. An agent is bound to a node
 * (its `ownerAgent`) and may modify that node and its descendants — never an
 * upstream or sibling node. Cross-branch data flows through the PARENT, which
 * sees all its children's results and can fold them into a child's context.
 *
 * v1 (this file) owns the model + scoped mutations + persistence only. Driving
 * the DAG (spawning agents per `delegate` node, async top-level escalation) lands
 * in later phases; the store is agnostic to how nodes are executed.
 */
import { generateId } from "./id";

export type DagNodeStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type DagNodeMode = "inline" | "delegate";

export interface DagNode {
	id: string;
	description: string;
	status: DagNodeStatus;
	parentId: string | null;
	childIds: string[];
	/** Agent currently responsible for this node (executes / may re-plan it). */
	ownerAgent: string;
	mode: DagNodeMode;
	/** Sibling node ids this node waits on (ordering hint within the same parent). */
	deps: string[];
	/** Summary result, set when the node reaches `completed`. */
	result?: string;
}

export interface DagTree {
	id: string;
	rootId: string;
	/** The dagRoot agent driving this DAG (== root node's ownerAgent). */
	ownerAgent: string;
	/** The overall goal / originating prompt for this DAG. */
	goal?: string;
	/**
	 * Isolation worktree of an async coding run, persisted so a resumed DAG (after
	 * a worker exit) re-attaches to the SAME branch/dir instead of writing the
	 * user's main tree. Undefined for non-worktree runs.
	 */
	worktree?: { path: string; branch: string; baseSha: string };
	/**
	 * True for a worktree-only record (e.g. a `run_goal` coding goal) with no
	 * plan behind it: deciding its worktree (worktree_decide) drops the whole
	 * tree instead of leaving an empty husk.
	 */
	standalone?: boolean;
	nodes: Record<string, DagNode>;
}

interface DagStoreJson {
	dags: DagTree[];
}

interface NodeCtx {
	tree: DagTree;
	node: DagNode;
}

/** A read-only view of a node + its descendants (what an agent / the UI sees). */
export interface DagNodeView {
	id: string;
	description: string;
	status: DagNodeStatus;
	mode: DagNodeMode;
	ownerAgent: string;
	deps: string[];
	result?: string;
	children: DagNodeView[];
}

export interface ChildSpec {
	description: string;
	mode?: DagNodeMode;
	deps?: string[];
}

export interface NodePatch {
	status?: DagNodeStatus;
	result?: string;
	mode?: DagNodeMode;
	/** Re-bind the node to a different agent (used when delegating). */
	ownerAgent?: string;
}

export class DagStore {
	private readonly dags = new Map<string, DagTree>();

	/**
	 * Persistence is a serialized, coalescing chain: mutations are synchronous
	 * and each marks the store dirty; the chained writer flushes the NEWEST
	 * snapshot once per turn of the microtask queue. Without this, two
	 * concurrent mutations (parallel tool batch — `toolExecution: "parallel"`)
	 * fire overlapping full-file writes on `dag.json` and the older snapshot
	 * can land last (lost updates) or splice into invalid JSON (which the boot
	 * loader then silently drops — losing ALL DAG + worktree state).
	 */
	private persistChain: Promise<void> = Promise.resolve();
	private persistDirty = false;

	constructor(
		private readonly onPersist?: (data: DagStoreJson) => Promise<void>,
		/** Liveness probe for replan protection (worker-side live-agent set). */
		private readonly isLiveAgent?: (agentId: string) => boolean,
	) {}

	/** Load persisted state (called once at boot, before any mutation). */
	hydrate(data: unknown): void {
		if (!data || typeof data !== "object") return;
		const list = (data as { dags?: DagTree[] }).dags;
		if (!Array.isArray(list)) return;
		for (const tree of list) {
			if (this.validateTree(tree)) this.dags.set(tree.id, tree);
		}
	}

	/**
	 * Structural validation + repair of a persisted tree. Drops the tree when
	 * its links are cyclic or the root is ownerless (both would wedge the boot
	 * resume path); prunes unreachable nodes (garbage from pre-fix replans)
	 * otherwise. Returns false when the tree must be dropped entirely.
	 */
	private validateTree(tree: DagTree | undefined): tree is DagTree {
		if (!tree || typeof tree.id !== "string" || !tree.nodes || typeof tree.nodes !== "object") return false;
		const root = tree.nodes[tree.rootId];
		if (!root || typeof root.ownerAgent !== "string" || !root.ownerAgent) return false;
		// Sanitize statuses from older/corrupt files (unknown → pending).
		const STATUSES = new Set<DagNodeStatus>(["pending", "in_progress", "completed", "cancelled"]);
		for (const n of Object.values(tree.nodes)) {
			if (!STATUSES.has(n.status)) n.status = "pending";
		}
		// Sanitize child links: drop dangling ids and self-references.
		for (const n of Object.values(tree.nodes)) {
			if (Array.isArray(n.childIds)) n.childIds = n.childIds.filter((cid) => cid !== n.id && tree.nodes[cid]);
			else n.childIds = [];
		}
		// Reachability from the root prunes orphaned nodes and proves the child
		// links are acyclic (a cycle would loop the walk forever).
		const seen = new Set<string>([tree.rootId]);
		const stack = [tree.rootId];
		while (stack.length) {
			const n = tree.nodes[stack.pop()!];
			if (!n) return false; // dangling link survived sanitize — treat as corrupt
			for (const cid of n.childIds) {
				if (seen.has(cid)) return false; // childIds cycle
				seen.add(cid);
				stack.push(cid);
			}
		}
		// Parent chains feed canModify's authority walk — a cycle there would
		// spin the event loop, so require acyclic lineages too.
		for (const n of Object.values(tree.nodes)) {
			const lineage = new Set<string>();
			let cur = n.parentId ? tree.nodes[n.parentId] : undefined;
			while (cur) {
				if (lineage.has(cur.id)) return false;
				lineage.add(cur.id);
				cur = cur.parentId ? tree.nodes[cur.parentId] : undefined;
			}
		}
		for (const id of Object.keys(tree.nodes)) if (!seen.has(id)) delete tree.nodes[id];
		return true;
	}

	/** Snapshot every DAG (for persistence). */
	toJson(): DagStoreJson {
		return { dags: [...this.dags.values()] };
	}

	/**
	 * Read-only view of EVERY tree in the session, ignoring authority. This is
	 * the coordinator's (main agent's) `get_status` companion: async DAGs are
	 * owned by their dagRoot agent, so the authority-scoped `view()` would hide
	 * them from the very agent that must relay their state to the user. It sees
	 * everything but authorizes nothing — mutations stay scoped.
	 */
	viewAll(): DagNodeView[] {
		const out: DagNodeView[] = [];
		for (const tree of this.dags.values()) {
			const root = tree.nodes[tree.rootId];
			if (root) out.push(this.subtreeView(tree, root));
		}
		return out;
	}

	private schedulePersist(): void {
		const persist = this.onPersist;
		if (!persist) return;
		this.persistDirty = true;
		this.persistChain = this.persistChain.then(async () => {
			if (!this.persistDirty) return;
			this.persistDirty = false;
			try {
				await persist(this.toJson());
			} catch {
				/* a failed write must not break the chain — the next mutation retries */
			}
		});
	}

	// --------------------------------------------------------------- locate ----

	private locate(nodeId: string): NodeCtx | undefined {
		for (const tree of this.dags.values()) {
			const node = tree.nodes[nodeId];
			if (node) return { tree, node };
		}
		return undefined;
	}

	/**
	 * Authority check: `agentId` may modify a node iff it owns that node OR an
	 * ancestor of it (subtree authority). The parent always retains authority over
	 * its subtree even after delegating a child to a subagent.
	 */
	private canModify(agentId: string, ctx: NodeCtx): boolean {
		let cur: DagNode | null = ctx.node;
		const visited = new Set<string>();
		while (cur) {
			if (cur.ownerAgent === agentId) return true;
			if (visited.has(cur.id)) break; // corrupt lineage — bail, don't spin
			visited.add(cur.id);
			cur = cur.parentId ? (ctx.tree.nodes[cur.parentId] ?? null) : null;
		}
		return false;
	}

	// ----------------------------------------------------------------- ops ----

	/**
	 * Create a new DAG owned by `ownerAgent` (the dagRoot), with a root node.
	 * Returns the dag id + root node id.
	 */
	createDag(ownerAgent: string, goal?: string): { dagId: string; rootNodeId: string } {
		const dagId = generateId();
		const rootId = generateId();
		const root: DagNode = {
			id: rootId,
			description: goal?.trim() || "(dag root)",
			status: "pending",
			parentId: null,
			childIds: [],
			ownerAgent,
			mode: "inline",
			deps: [],
		};
		const tree: DagTree = { id: dagId, rootId, ownerAgent, goal, nodes: { [rootId]: root } };
		this.dags.set(dagId, tree);
		this.schedulePersist();
		return { dagId, rootNodeId: rootId };
	}

	/**
	 * Add child nodes under `parentNodeId`, scoped to `agentId`. New children are
	 * initially owned by the planner (re-bound to a subagent on delegation).
	 * Returns the created node ids.
	 */
	plan(agentId: string, parentNodeId: string, children: ChildSpec[]): string[] {
		const ctx = this.locate(parentNodeId);
		if (!ctx) throw new Error(`plan: unknown node '${parentNodeId}'`);
		if (!this.canModify(agentId, ctx)) throw new Error(`plan: agent '${agentId}' is out of scope for node '${parentNodeId}'`);
		const parent = ctx.node;
		const created: string[] = [];
		for (const c of children) {
			const id = generateId();
			ctx.tree.nodes[id] = {
				id,
				description: c.description,
				status: "pending",
				parentId: parent.id,
				childIds: [],
				ownerAgent: agentId,
				mode: c.mode ?? "delegate",
				deps: c.deps ?? [],
			};
			parent.childIds.push(id);
			created.push(id);
		}
		this.schedulePersist();
		return created;
	}

	/** Update a node (status / result / mode / owner), scoped to `agentId`. */
	updateNode(agentId: string, nodeId: string, patch: NodePatch): void {
		const ctx = this.locate(nodeId);
		if (!ctx) throw new Error(`update_node: unknown node '${nodeId}'`);
		if (!this.canModify(agentId, ctx)) throw new Error(`update_node: agent '${agentId}' is out of scope for node '${nodeId}'`);
		const node = ctx.node;
		if (patch.status) {
			// A cancelled tree is the user's verdict — terminal. A straggler agent
			// finishing after the cancel may still ATTACH its result (history),
			// but cannot flip statuses back to life.
			const root = ctx.tree.nodes[ctx.tree.rootId];
			if (root?.status === "cancelled" && node.status !== patch.status) {
				throw new Error(`update_node: dag '${ctx.tree.id}' is cancelled — statuses are final (node '${nodeId}')`);
			}
			node.status = patch.status;
		}
		if (patch.result !== undefined) node.result = patch.result;
		if (patch.mode) node.mode = patch.mode;
		if (patch.ownerAgent) node.ownerAgent = patch.ownerAgent;
		this.schedulePersist();
	}

	/**
	 * Compare-and-set claim of a node for delegation: the caller must hold
	 * subtree authority AND the node must not already be running. Without the
	 * CAS, two `delegate` calls for the same node in one parallel tool batch
	 * (a model echo/retry) would spawn two sub-agents driving one subtree.
	 */
	claimNode(agentId: string, nodeId: string, subId: string): void {
		const ctx = this.locate(nodeId);
		if (!ctx) throw new Error(`delegate: unknown node '${nodeId}'`);
		if (!this.canModify(agentId, ctx)) throw new Error(`delegate: agent '${agentId}' is out of scope for node '${nodeId}'`);
		if (ctx.node.status === "in_progress" && ctx.node.ownerAgent !== subId) {
			throw new Error(`delegate: node '${nodeId}' is already in progress (owned by '${ctx.node.ownerAgent}')`);
		}
		ctx.node.status = "in_progress";
		ctx.node.ownerAgent = subId;
		this.schedulePersist();
	}

	/**
	 * Replace a node's children wholesale (re-plan): old subtrees are dropped
	 * recursively, new ones created owned by the planner. Scoped to `agentId`,
	 * which must own the parent. Refusing to replan a node with completed
	 * descendants would be safer — but the agent may legitimately discard a bad
	 * branch — so we allow it and let the planner's judgement rule. A child
	 * whose owner is a LIVE spawned agent is refused: the parallel-batch race
	 * (delegate + replan in one message) would strand a running sub-agent on
	 * deleted nodes.
	 */
	replanChildren(agentId: string, nodeId: string, children: ChildSpec[]): string[] {
		const ctx = this.locate(nodeId);
		if (!ctx) throw new Error(`replan: unknown node '${nodeId}'`);
		if (!this.canModify(agentId, ctx)) throw new Error(`replan: agent '${agentId}' is out of scope for node '${nodeId}'`);
		for (const cid of ctx.node.childIds) {
			const child = ctx.tree.nodes[cid];
			if (child && this.isLiveAgent?.(child.ownerAgent) && child.ownerAgent !== agentId) {
				throw new Error(`replan: child '${cid}' is being executed by a live agent ('${child.ownerAgent}') — wait for it to finish or abort it first`);
			}
		}
		// Drop old subtrees RECURSIVELY (a shallow delete stranded grandchildren
		// in the map, growing dag.json forever) — cycle-guarded for corrupt files.
		for (const cid of ctx.node.childIds) this.dropSubtree(ctx.tree, cid);
		ctx.node.childIds = [];
		// Delegate to plan() for creation + scoping (it re-locates; same agent).
		return this.plan(agentId, nodeId, children);
	}

	private dropSubtree(tree: DagTree, nodeId: string, visited = new Set<string>()): void {
		if (visited.has(nodeId)) return;
		visited.add(nodeId);
		const n = tree.nodes[nodeId];
		if (!n) return;
		for (const cid of n.childIds) this.dropSubtree(tree, cid, visited);
		delete tree.nodes[nodeId];
	}

	/**
	 * Read a subtree (nodeId given) or every DAG the agent owns at the root
	 * (nodeId omitted). Out-of-scope reads return null.
	 */
	view(agentId: string, nodeId?: string): DagNodeView[] | null {
		if (nodeId) {
			const ctx = this.locate(nodeId);
			if (!ctx || !this.canModify(agentId, ctx)) return null;
			return [this.subtreeView(ctx.tree, ctx.node)];
		}
		const out: DagNodeView[] = [];
		for (const tree of this.dags.values()) {
			const root = tree.nodes[tree.rootId];
			if (root?.ownerAgent === agentId) out.push(this.subtreeView(tree, root));
		}
		return out;
	}

	private subtreeView(tree: DagTree, node: DagNode, visited = new Set<string>()): DagNodeView {
		visited.add(node.id);
		return {
			id: node.id,
			description: node.description,
			status: node.status,
			mode: node.mode,
			ownerAgent: node.ownerAgent,
			deps: node.deps,
			result: node.result,
			children: node.childIds
				.filter((cid) => tree.nodes[cid] && !visited.has(cid))
				.map((cid) => this.subtreeView(tree, tree.nodes[cid], visited)),
		};
	}

	/** Look up a DAG by id (for status queries). */
	getDag(dagId: string): DagTree | undefined {
		return this.dags.get(dagId);
	}

	/**
	 * Register a stand-alone worktree with no plan behind it (a `run_goal`
	 * coding goal). It surfaces to `worktree_decide` exactly like a workflow
	 * worktree — without this, a finished goal's branch/dir could never be
	 * merged or cleaned up through the sanctioned tool.
	 */
	recordStandaloneWorktree(ownerAgent: string, goal: string | undefined, worktree: NonNullable<DagTree["worktree"]>): string {
		const { dagId, rootNodeId } = this.createDag(ownerAgent, goal);
		const tree = this.dags.get(dagId)!;
		tree.standalone = true;
		const root = tree.nodes[rootNodeId];
		root.status = "completed";
		root.result = "goal worktree (awaiting merge/keep/discard decision)";
		tree.worktree = worktree;
		this.schedulePersist();
		return dagId;
	}

	/**
	 * Find a pending worktree by dag id or branch name (the worktree_decide
	 * lookup — both identifiers appear in the completion wake message). When a
	 * dag id is given it SCOPES the search: no falling through to a branch
	 * match from a different tree (a stale id must not retarget the decision).
	 */
	findWorktree(dagId?: string, branch?: string): { dagId: string; path: string; branch: string; baseSha: string } | undefined {
		for (const tree of this.dags.values()) {
			if (!tree.worktree) continue;
			if (dagId) {
				if (tree.id === dagId) return { dagId: tree.id, ...tree.worktree };
				continue;
			}
			if (branch && tree.worktree.branch === branch) return { dagId: tree.id, ...tree.worktree };
		}
		return undefined;
	}

	/** Drop the worktree record once decided (merged/kept/dropped for good). */
	clearWorktree(dagId: string): void {
		const tree = this.dags.get(dagId);
		if (!tree?.worktree) return;
		if (tree.standalone) this.dags.delete(dagId);
		else tree.worktree = undefined;
		this.schedulePersist();
	}
}

/**
 * Render one or more subtree views as an indented text outline. Shared by
 * `get_status` (what an agent sees of its subtree) and a spawned agent's
 * BRANCH_VIEW (its initial scope briefing). Pure. Node results are capped —
 * they are model-authored free text and a verbose one would balloon every
 * status call and every dagRoot's system prompt.
 */
const RESULT_CAP = 240;
const capText = (s: string): string => (s.length > RESULT_CAP ? `${s.slice(0, RESULT_CAP)}…` : s);

export function formatNodeView(views: DagNodeView[] | null): string {
	if (!views || views.length === 0) return "(no DAG state visible to you)";
	const lines: string[] = [];
	const walk = (n: DagNodeView, depth: number): void => {
		const indent = "  ".repeat(depth);
		const tag = n.mode === "delegate" ? "delegate" : "inline";
		const res = n.result ? ` → ${capText(n.result)}` : "";
		const deps = n.deps.length ? ` [after ${n.deps.join(", ")}]` : "";
		lines.push(`${indent}- [${n.status}] (${tag}) ${n.description}${deps}${res}`);
		for (const c of n.children) walk(c, depth + 1);
	};
	for (const v of views) walk(v, 0);
	return lines.join("\n");
}
