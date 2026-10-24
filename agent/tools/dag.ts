/**
 * Execution-plan DAG tools.
 *
 * Exposed (scoped to the calling agent) as `plan` / `decompose` / `update_node`
 * / `get_status`. They operate on the session's shared {@link DagStore}; every
 * mutation is authority-checked (the agent may touch only its node + descendants).
 *
 * - `plan`        — create a new DAG (you become its dagRoot) with top-level steps.
 * - `decompose`   — break a node you own into child steps.
 * - `update_node` — mark progress / attach a result.
 * - `get_status`  — read your subtree.
 *
 * Driving the DAG (spawning a subagent per `delegate` node, async escalation) is
 * layered on top in later phases; these tools only manage DAG state.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "./definition";
import type { DagNodeMode, DagNodeStatus, DagNodeView, DagStore } from "../dag";
import { formatNodeView } from "../dag";

export interface DagToolsDeps {
	dags: DagStore;
	/** The agent these tools are scoped to (mutations are authority-checked against it). */
	agentId: string;
	/**
	 * Coordinator privilege (main agent only): `get_status` also shows trees the
	 * agent does NOT own — async DAGs belong to their dagRoot, and the main
	 * agent must be able to read their state to relay/reason about them. Read
	 * ONLY: mutation tools stay authority-scoped either way.
	 */
	seeAllTrees?: boolean;
}

const statusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
	{ description: "New status for the node." },
);
const modeSchema = Type.Union(
	[Type.Literal("inline"), Type.Literal("delegate")],
	{ description: "'inline' = you do it yourself with your coding tools; 'delegate' = a child agent will handle it." },
);
const childSchema = Type.Object({
	description: Type.String({ description: "A self-contained description of what this step accomplishes." }),
	mode: Type.Optional(modeSchema),
	deps: Type.Optional(Type.Array(Type.String(), { description: "Sibling step ids this step must wait on (ordering within the same parent)." })),
});


/** Depth-first search for the ROOT view containing `nodeId` (read-only lookup). */
function findRootOf(views: DagNodeView[], nodeId: string): DagNodeView | undefined {
	const contains = (n: DagNodeView): boolean => n.id === nodeId || n.children.some(contains);
	return views.find(contains);
}

const planSchema = Type.Object({
	goal: Type.Optional(Type.String({ description: "One-line goal for the whole plan (the DAG root)." })),
	nodes: Type.Array(childSchema, { description: "Top-level steps of the plan." }),
});
const decomposeSchema = Type.Object({
	parent_node_id: Type.String({ description: "The node to break into child steps (you must own it)." }),
	children: Type.Array(childSchema, { description: "Child steps to create under the parent." }),
});
const updateSchema = Type.Object({
	node_id: Type.String({ description: "The node to update." }),
	status: Type.Optional(statusSchema),
	result: Type.Optional(Type.String({ description: "Short result summary (set with status 'completed')." })),
	mode: Type.Optional(modeSchema),
	replan: Type.Optional(Type.Array(childSchema, { description: "Replace ALL of this node's children with these steps (a re-breakdown). Mutually exclusive with the other fields." })),
});
const statusQuerySchema = Type.Object({
	node_id: Type.Optional(Type.String({ description: "Subtree to read; omit for every DAG you own." })),
});

export const PLAN_TOOL_META = {
	name: "plan",
	mode: "W",
	parameters: planSchema,
	description:
		"Decompose a complex task into a shared execution-plan DAG that you (as its root) will drive. Creates the DAG and its top-level steps. Use when a task has several distinct parts worth tracking; for trivial work, just do it.",
	prompt: {
		snippet: "Decompose a task into a tracked plan (DAG)",
		guidelines: [
			"Only plan when the task genuinely has multiple steps; otherwise act directly.",
			"Each step is self-contained. Mark a step 'delegate' when a sub-agent should own it, 'inline' when you'll do it yourself.",
			"After planning, drive the steps to completion (delegate or do inline), updating each as you go.",
		],
	},
} satisfies ToolMeta;

export const DECOMPOSE_TOOL_META = {
	name: "decompose",
	mode: "W",
	parameters: decomposeSchema,
	description:
		"Break a node you own into child steps (a sub-branch of the plan). Use when a step turns out to need its own decomposition. You must own the parent node.",
	prompt: {
		snippet: "Decompose a plan step into child steps",
		guidelines: ["Only decompose a node you own. Children inherit your authority until delegated."],
	},
} satisfies ToolMeta;

export const UPDATE_NODE_TOOL_META = {
	name: "update_node",
	mode: "W",
	parameters: updateSchema,
	description:
		"Update a node you own: mark it in_progress/completed, attach a result summary, change its mode, or replace its children (replan). You must own the node (or an ancestor of it).",
	prompt: {
		snippet: "Mark plan progress / attach a result",
		guidelines: [
			"Set status 'in_progress' when starting a step, 'completed' with a concise `result` when done.",
			"Keep results short — they summarize the step for the plan, they are not the work itself.",
			"`replan` replaces ALL children of the node — use it when the old breakdown proved wrong, not to append steps (decompose does that).",
		],
	},
} satisfies ToolMeta;

export const GET_STATUS_TOOL_META = {
	name: "get_status",
	mode: "R",
	parameters: statusQuerySchema,
	description:
		"Read the current plan state: a specific node's subtree (pass node_id) or every DAG at the root (omit node_id). The main agent sees ALL trees in the session (async workflows owned by their dagRoot agents included, marked read-only); other agents see only their own subtree.",
	prompt: { snippet: "Inspect the current plan state" },
} satisfies ToolMeta;

export function createDagTools(deps: DagToolsDeps) {
	const plan = defineTool<typeof planSchema, undefined>({
		...PLAN_TOOL_META,
		label: "plan",
		parameters: planSchema,
		async execute(_id, params): Promise<AgentToolResult<undefined>> {
			const { dagId, rootNodeId } = deps.dags.createDag(deps.agentId, params.goal);
			const nodeIds = params.nodes.length ? deps.dags.plan(deps.agentId, rootNodeId, params.nodes) : [];
			const summary =
				`Created plan ${dagId} (root ${rootNodeId}) with ${nodeIds.length} step(s):\n` +
				params.nodes.map((n, i) => `- ${nodeIds[i] ?? "?"} [${n.mode ?? "delegate"}] ${n.description}`).join("\n");
			return { content: [{ type: "text", text: summary }], details: undefined };
		},
	});

	const decompose = defineTool<typeof decomposeSchema, undefined>({
		...DECOMPOSE_TOOL_META,
		label: "decompose",
		parameters: decomposeSchema,
		async execute(_id, params): Promise<AgentToolResult<undefined>> {
			const ids = deps.dags.plan(deps.agentId, params.parent_node_id, params.children);
			const summary =
				`Decomposed ${params.parent_node_id} into ${ids.length} step(s):\n` +
				params.children.map((n, i) => `- ${ids[i] ?? "?"} [${n.mode ?? "delegate"}] ${n.description}`).join("\n");
			return { content: [{ type: "text", text: summary }], details: undefined };
		},
	});

	const updateNode = defineTool<typeof updateSchema, undefined>({
		...UPDATE_NODE_TOOL_META,
		label: "update_node",
		parameters: updateSchema,
		async execute(_id, params): Promise<AgentToolResult<undefined>> {
			if (params.replan) {
				// Mutual exclusion is documented on the schema but not machine-enforced
				// there — enforce it here: a call carrying both would silently drop the
				// status/mode/result half (the replan branch returns early).
				if (params.status !== undefined || params.mode !== undefined || params.result !== undefined) {
					return {
						content: [
							{ type: "text", text: "update_node: `replan` is mutually exclusive with `status`/`mode`/`result` — split it into two calls (replan first, then the status update)." },
						],
						details: undefined,
					};
				}
				const ids = deps.dags.replanChildren(deps.agentId, params.node_id, params.replan);
				const summary =
					`Replanned ${params.node_id}: old children replaced with ${ids.length} step(s):\n` +
					params.replan.map((n, i) => `- ${ids[i] ?? "?"} [${n.mode ?? "delegate"}] ${n.description}`).join("\n");
				return { content: [{ type: "text", text: summary }], details: undefined };
			}
			deps.dags.updateNode(deps.agentId, params.node_id, {
				status: params.status as DagNodeStatus | undefined,
				result: params.result,
				mode: params.mode as DagNodeMode | undefined,
			});
			return { content: [{ type: "text", text: `Updated ${params.node_id}: ${params.status ?? params.mode ?? "result"}${params.result ? ` — ${params.result}` : ""}` }], details: undefined };
		},
	});

	const getStatus = defineTool<typeof statusQuerySchema, undefined>({
		...GET_STATUS_TOOL_META,
		label: "get_status",
		parameters: statusQuerySchema,
		async execute(_id, params): Promise<AgentToolResult<undefined>> {
			if (params.node_id) {
				// Owned subtree first; the coordinator may also READ any other
				// node's subtree (an async DAG it handed off earlier).
				const owned = deps.dags.view(deps.agentId, params.node_id);
				if (owned) return { content: [{ type: "text", text: formatNodeView(owned) }], details: undefined };
				if (deps.seeAllTrees) {
					const found = findRootOf(deps.dags.viewAll(), params.node_id);
					if (found) {
						return {
							content: [{ type: "text", text: `(read-only — owned by ${found.ownerAgent})\n${formatNodeView([found])}` }],
							details: undefined,
						};
					}
				}
				return { content: [{ type: "text", text: formatNodeView(null) }], details: undefined };
			}
			const mine = deps.dags.view(deps.agentId) ?? [];
			if (!deps.seeAllTrees) return { content: [{ type: "text", text: formatNodeView(mine) }], details: undefined };
			// Coordinator view: own trees first, then every other tree (async DAGs
			// owned by dagRoot agents) marked read-only.
			const mineIds = new Set(mine.map((v) => v.id));
			const others = deps.dags.viewAll().filter((v) => !mineIds.has(v.id));
			const parts: string[] = [];
			if (mine.length) parts.push(`# Your plans\n${formatNodeView(mine)}`);
			if (others.length) {
				parts.push(
					`# Other plans in this session (read-only — you don't own them)\n${formatNodeView(others)}`,
				);
			}
			return { content: [{ type: "text", text: parts.length ? parts.join("\n\n") : formatNodeView(null) }], details: undefined };
		},
	});

	return [plan, decompose, updateNode, getStatus];
}
