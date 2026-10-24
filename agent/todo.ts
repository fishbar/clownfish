/**
 * Session plan — the orchestrator's task list, doubling as a delegation ledger.
 *
 * Two writers, deliberately split:
 *
 *  - **The model** owns the *plan*: it calls the `todo` tool with the whole list
 *    (Claude-Code style — rewrite, don't patch), so the decomposition it invented
 *    is externalized instead of living only in one assistant message.
 *  - **The framework** owns the *execution state*: `run_agent` marks an item
 *    running / done / failed and attaches which specialist took it, in which
 *    working tree, and where its transcript landed. Models forget to update
 *    status; the runtime does not.
 *
 * A rewrite therefore MERGES by id rather than replacing outright, so the model
 * restating its plan cannot wipe the ledger fields underneath it.
 *
 * Persisted next to the transcript (`<sessionsDir>/<sessionId>.todo.json`) so a
 * tab that opens a session with no running worker still sees the plan, and
 * broadcast on every change so live tabs update.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "./tools/definition";

export type TodoStatus = "pending" | "running" | "done" | "failed" | "stopped";

export interface TodoItem {
	/** Stable id (`t1`, `t2`, …). The model may reuse one to update an item. */
	id: string;
	/** One line, in the user's language — what this step accomplishes. */
	task: string;
	status: TodoStatus;
	/** Specialist the step was delegated to, filled by run_agent. */
	agent?: string;
	/** Working tree the delegation ran in (a git worktree, when fanned out). */
	cwd?: string;
	/** Path of the delegation's own transcript, for after-the-fact review. */
	transcript?: string;
	/** Short outcome note (failure reason, budget exhaustion, …). */
	note?: string;
}

/** What the model may set. Everything else is the framework's to fill. */
interface TodoDraft {
	id?: string;
	task: string;
	status?: TodoStatus;
}

const STATUSES: TodoStatus[] = ["pending", "running", "done", "failed", "stopped"];

export class TodoStore {
	private items: TodoItem[] = [];
	private seq = 0;
	private writing: Promise<void> = Promise.resolve();

	constructor(
		private readonly sessionsDir: string,
		private readonly sessionId: string,
		/** Called after every change (broadcast to subscribed tabs). */
		private readonly onChange?: (items: TodoItem[]) => void,
	) {}

	path(): string {
		return join(this.sessionsDir, `${this.sessionId}.todo.json`);
	}

	list(): TodoItem[] {
		return this.items.map((i) => ({ ...i }));
	}

	/** Restore the plan from disk (session resume). Never throws. */
	async load(): Promise<void> {
		const raw = await readFile(this.path(), "utf8").catch(() => null);
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) return;
			this.items = parsed.filter(isTodoItem);
			for (const item of this.items) {
				const n = Number(item.id.replace(/^t/, ""));
				if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
			}
		} catch {
			/* corrupt plan file — start empty rather than failing the session */
		}
	}

	/**
	 * Replace the plan with the model's list, merging by id so the ledger fields
	 * (agent / cwd / transcript) and a status the framework already set survive a
	 * restatement. Items the model drops are gone — that is how it removes one.
	 */
	rewrite(drafts: TodoDraft[]): TodoItem[] {
		const byId = new Map(this.items.map((i) => [i.id, i]));
		// Identity fallback: models restate a plan without ids more often than not,
		// and a fresh id would orphan the ledger fields — which specialist ran the
		// step, in which tree, and where its transcript went. Identical task text is
		// the same step, so it keeps its history.
		const byTask = new Map<string, TodoItem>();
		for (const item of this.items) if (!byTask.has(item.task)) byTask.set(item.task, item);
		const claimed = new Set<string>();
		this.items = drafts.map((d) => {
			let prior = d.id ? byId.get(d.id) : undefined;
			if (!prior) {
				const match = byTask.get(d.task);
				if (match && !claimed.has(match.id)) prior = match;
			}
			if (!prior) return { id: this.nextId(), task: d.task, status: d.status ?? "pending" };
			claimed.add(prior.id);
			return { ...prior, task: d.task, status: d.status ?? prior.status };
		});
		this.flush();
		return this.list();
	}

	/** Framework write: start (or adopt) a delegation's item. Returns its id. */
	begin(entry: { id?: string; task: string; agent: string; cwd?: string; transcript?: string }): string {
		const existing = entry.id ? this.items.find((i) => i.id === entry.id) : undefined;
		const item: TodoItem = existing ?? { id: this.nextId(), task: entry.task, status: "pending" };
		item.status = "running";
		// Only overwrite what this call actually carries: the second begin()
		// (which attaches the transcript) must not wipe the cwd the first one
		// recorded — measured as "the plan never shows the worktree".
		if (entry.agent) item.agent = entry.agent;
		if (entry.cwd !== undefined) item.cwd = entry.cwd;
		if (entry.transcript !== undefined) item.transcript = entry.transcript;
		item.note = undefined;
		if (!existing) this.items.push(item);
		this.flush();
		return item.id;
	}

	/** Framework write: settle a delegation's item. */
	end(id: string, status: TodoStatus, note?: string): void {
		const item = this.items.find((i) => i.id === id);
		if (!item) return;
		item.status = status;
		item.note = note;
		this.flush();
	}

	/** Compact rendering handed back to the model, so it sees the ids it can reuse. */
	render(): string {
		if (this.items.length === 0) return "(plan is empty)";
		return this.items
			.map((i) => {
				const marks = [i.agent, i.cwd, i.note].filter(Boolean).join(" · ");
				return `${i.id} [${i.status}] ${i.task}${marks ? ` — ${marks}` : ""}`;
			})
			.join("\n");
	}

	async close(): Promise<void> {
		await this.writing.catch(() => {});
	}

	async remove(): Promise<void> {
		await rm(this.path(), { force: true });
	}

	private nextId(): string {
		return `t${++this.seq}`;
	}

	/** Broadcast + persist. Writes are serialized; a failed write never propagates. */
	private flush(): void {
		const snapshot = this.list();
		this.onChange?.(snapshot);
		this.writing = this.writing
			.then(async () => {
				await mkdir(dirname(this.path()), { recursive: true });
				await writeFile(this.path(), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
			})
			.catch(() => {
				/* the plan is a convenience; losing a write must not fail the turn */
			});
	}
}

function isTodoItem(v: unknown): v is TodoItem {
	const i = v as Partial<TodoItem> | null;
	return Boolean(i && typeof i.id === "string" && typeof i.task === "string" && STATUSES.includes(i.status as TodoStatus));
}

/** Read a session's plan without a running worker (the REST/UI path). */
export async function readTodos(sessionsDir: string, sessionId: string): Promise<TodoItem[]> {
	const store = new TodoStore(sessionsDir, sessionId);
	await store.load();
	return store.list();
}

const todoSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "Existing item id to update (omit to add a new step)." })),
			task: Type.String({ description: "One line: what this step accomplishes, in the user's language." }),
			status: Type.Optional(
				Type.Unsafe<TodoStatus>({
					type: "string",
					enum: STATUSES,
					description: "Only set this for steps you do yourself; delegated steps are tracked automatically.",
				}),
			),
		}),
		{ description: "The complete plan, in order. Items you omit are removed." },
	),
});

/** The model-facing `todo` tool. Only the top-level agent gets it (sub-agents plan in their heads). */
export const TODO_TOOL_META = {
	name: "todo",
	mode: "R",
	parameters: todoSchema,
	description:
		"Record or update the plan for this session: the ordered list of steps you intend to take. Pass the WHOLE list every time — items you omit are dropped, and passing an existing `id` updates that step instead of adding one. The plan is shown to the user and survives across turns; steps you delegate with run_agent are marked running/done automatically, so you do not need to set their status.",
	prompt: {
		snippet: "Record the plan for this session",
		guidelines: [
			"Write a plan before starting work that has more than about three steps, or any work you intend to split across specialists — the user sees it, and it is what you still have after the details fall out of context.",
			"Keep it at the altitude of outcomes, not tool calls: 'migrate the session store to SQLite', not 'read models/sessions.ts'. Three to seven steps is usually right.",
			"Re-send the whole list to revise it, reusing each step's `id`; adding, reordering, or dropping steps as you learn is expected, not a failure.",
			"Do not hand-maintain the status of delegated steps — run_agent sets running / done / failed and records which specialist and worktree took them, PROVIDED you pass the step id as its `todo` argument.",
			"Steps you do yourself are yours to close: set them to `done` as you finish, so the plan never shows work that is already behind you as still pending.",
		],
	},
} satisfies ToolMeta;

export function createTodoTool(store: TodoStore) {
	return defineTool<typeof todoSchema, undefined>({
		...TODO_TOOL_META,
		label: "todo",
		parameters: todoSchema,
		async execute(_toolCallId, { items }) {
			store.rewrite(items);
			return {
				content: [
					{
						type: "text",
						text: `Plan updated:\n${store.render()}\n\nWhen you delegate one of these with run_agent, pass its id as \`todo\` so the step is tracked instead of duplicated.`,
					},
				],
				details: undefined,
			};
		},
	});
}
