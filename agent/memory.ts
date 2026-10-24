/**
 * MemoryStore — where cross-session memory lives.
 *
 * Writers are the AGENT itself: the `memory` tool during a turn, and the
 * end-of-session reflection. Both take effect immediately — there is no
 * confirmation queue, by choice. What stands in for one is this module's audit
 * log, the visible `[id]` on every line (so the model revises rather than
 * contradicts), and a settings page where a human edits or deletes anything.
 *
 * Layout under `<dataDir>/memory/` (plain text for now — DB / vector match is a
 * later upgrade; the shape deliberately mirrors what a per-category store
 * needs):
 *
 *   memory/
 *     applied/            — the memory itself, one markdown file per scope/category:
 *       global/<category>.md         (about the user or the machine)
 *       projects/<pid>/<category>.md (only true of that codebase)
 *     cursors.json        — how far reflection has processed each session
 *     runs.jsonl          — append-only audit of every write and removal
 *
 * Everyone writes through this module; paths never leak. Categories are a
 * closed set (see {@link MEMORY_CATEGORIES}) so the files stay predictable.
 */
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId } from "./id";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "./tools/definition";

/** Local `YYYY-MM-DD HH:MM:SS` — what a person reading their own memory expects. */
function localStamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Closed category set — the "归类存放" axis. */
/**
 * Closed category set. `lessons` sits apart from the four preference-shaped
 * categories on purpose: a mistake plus its root cause ages differently from a
 * standing preference, and mixing them makes both harder to review.
 */
export const MEMORY_CATEGORIES = ["rules", "style", "facts", "preferences", "lessons"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryScope = { kind: "global" } | { kind: "project"; projectId: string };

/** Per-session cursor: how far reflection has already processed a session. */
/**
 * How far reflection has already processed one session.
 *
 * A session can END MORE THAN ONCE: the worker is idle-reaped, you reopen the
 * session, a new worker restores the history and is reaped again. Without a
 * cursor that second reflection would re-read everything the first one already
 * distilled and write the same memories twice. So the cursor is not a batch
 * optimisation — it is what makes reflection idempotent across resumes.
 */
export interface ReflectCursor {
	/** Messages already reflected on. The next pass starts here. */
	count: number;
	updatedAt: number;
}

// ------------------------------------------------------------------ helpers ----

function isCategory(v: string): v is MemoryCategory {
	return (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

function scopeDir(root: string, scope: MemoryScope): string {
	return scope.kind === "global" ? join(root, "applied", "global") : join(root, "applied", "projects", scope.projectId);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	const raw = await readFile(file, "utf8").catch(() => null);
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

// -------------------------------------------------------------------- store ----

export class MemoryStore {
	constructor(private readonly root: string) {}

	// ----- cursors -----

	private cursorFile(): string {
		return join(this.root, "cursors.json");
	}

	async cursors(): Promise<Record<string, ReflectCursor>> {
		return readJson<Record<string, ReflectCursor>>(this.cursorFile(), {});
	}

	async saveCursor(sessionId: string, cursor: ReflectCursor): Promise<void> {
		const all = await this.cursors();
		all[sessionId] = cursor;
		await mkdir(dirname(this.cursorFile()), { recursive: true });
		await writeFile(this.cursorFile(), JSON.stringify(all, null, 2), "utf8");
	}

	// ----- pending proposals -----

	/** Append proposals (dedup: identical scope+category+content is skipped). */

	/**
	 * Resolve a proposal: accept → append to the applied file (merged with any
	 * existing summary), reject → drop. Returns the applied text on accept.
	 */

	// ----- applied memory -----

	/** Append one memory bullet to the scope/category file (creates on demand). */
	/**
	 * Append one memory. Returns the short id stamped on the line.
	 *
	 * The line carries an id and a local timestamp to the SECOND:
	 *
	 *   - [a3f2] 用户偏好中文回复 (2026-08-29 15:04:32)
	 *
	 * The id is what makes a memory correctable — `forget(id)` removes exactly
	 * one line, and the model sees the ids in its prompt, so it can revise what it
	 * wrote rather than appending a contradiction next to it. The timestamp is
	 * there because memory goes stale and a reader needs to know how old a claim
	 * is; full provenance (session, writer) stays in runs.jsonl, keyed by the id,
	 * so the prompt budget pays for a date rather than a paragraph.
	 */
	async append(scope: MemoryScope, category: MemoryCategory, content: string, id = generateId().slice(0, 4)): Promise<string> {
		if (!isCategory(category)) throw new Error(`unknown memory category '${category}'`);
		const file = join(scopeDir(this.root, scope), `${category}.md`);
		await mkdir(dirname(file), { recursive: true });
		const prev = await readFile(file, "utf8").catch(() => "");
		const body = content.replace(/\s*\n\s*/g, " ").trim();
		const bullet = `- [${id}] ${body} (${localStamp()})\n`;
		await writeFile(file, prev + bullet, "utf8");
		return id;
	}

	/**
	 * Drop one memory by id, wherever it lives. Returns true when a line was
	 * removed — false means the id was already gone, which a caller should report
	 * rather than treat as success.
	 */
	async forget(id: string): Promise<boolean> {
		const dirs = [join(this.root, "applied", "global")];
		const projectsDir = join(this.root, "applied", "projects");
		for (const pid of await readdir(projectsDir).catch(() => [])) dirs.push(join(projectsDir, pid));
		const marker = `- [${id}] `;
		for (const dir of dirs) {
			for (const name of await readdir(dir).catch(() => [])) {
				if (!name.endsWith(".md")) continue;
				const file = join(dir, name);
				const body = await readFile(file, "utf8").catch(() => "");
				if (!body.includes(marker)) continue;
				const kept = body.split("\n").filter((line) => !line.startsWith(marker));
				await writeFile(file, kept.join("\n").replace(/\n+$/, "\n"), "utf8");
				return true;
			}
		}
		return false;
	}

	/** All applied memory as labeled blocks (for prompt injection / the UI). */
	async readAll(): Promise<Array<{ scope: MemoryScope; category: MemoryCategory; body: string }>> {
		const out: Array<{ scope: MemoryScope; category: MemoryCategory; body: string }> = [];
		const readScope = async (dir: string, scope: MemoryScope): Promise<void> => {
			for (const name of await readdir(dir).catch(() => [])) {
				if (!name.endsWith(".md")) continue;
				const category = name.slice(0, -3);
				if (!isCategory(category)) continue;
				const body = await readFile(join(dir, name), "utf8").catch(() => "");
				if (body.trim()) out.push({ scope, category, body });
			}
		};
		await readScope(join(this.root, "applied", "global"), { kind: "global" });
		const projectsDir = join(this.root, "applied", "projects");
		for (const pid of await readdir(projectsDir).catch(() => [])) {
			await readScope(join(projectsDir, pid), { kind: "project", projectId: pid });
		}
		return out;
	}

	/** The `## Memory` prompt block for a session in the given project (8k cap). */
	async promptBlock(projectId: string | undefined): Promise<string> {
		const blocks = await this.readAll();
		const relevant = blocks.filter((b) => b.scope.kind === "global" || (projectId && b.scope.kind === "project" && b.scope.projectId === projectId));
		if (!relevant.length) return "";
		const CAP = 8000;
		const label = (b: { scope: MemoryScope; category: MemoryCategory }): string =>
			b.scope.kind === "global" ? `global / ${b.category}` : `project / ${b.category}`;
		let text = relevant.map((b) => `### ${label(b)}\n${b.body.trim()}`).join("\n\n");
		if (text.length > CAP) text = `${text.slice(0, CAP)}\n(truncated)`;
		return (
			"## Memory\n" +
			"What you have learned about this user and their projects in earlier sessions. Treat it as standing " +
			"preferences, rules and hard-won facts — but not as gospel: the workspace may have moved on since a line " +
			"was written, and each carries the date it was.\n" +
			"Each line starts with its `[id]`. When something here turns out to be wrong or outdated, call the `memory` " +
			"tool with that id to REVISE it rather than leaving a contradiction next to it.\n\n" +
			text
		);
	}

	// ----- run log -----

	async appendRunRecord(rec: MemoryWriteRecord): Promise<void> {
		const file = join(this.root, "runs.jsonl");
		await mkdir(dirname(file), { recursive: true });
		const { appendFile } = await import("node:fs/promises");
		await appendFile(file, `${JSON.stringify(rec)}\n`, "utf8");
	}
}

/** convenience: build a MemoryStore over `<dataDir>/memory`. */
export function memoryRoot(dataDir: string): string {
	return join(dataDir, "memory");
}

/** Used by tests / future UI: remove an applied file (category reset). */
export async function removeAppliedCategory(root: string, scope: MemoryScope, category: MemoryCategory): Promise<void> {
	await rm(join(scopeDir(root, scope), `${category}.md`), { force: true });
}

// ---------------------------------------------------------------- audit ----

/**
 * One agent-initiated memory write or removal, appended to `runs.jsonl` beside
 * every write and removal, in order.
 *
 * With no confirmation step in front of an autonomous writer, this log IS the
 * safety net: the memory file itself carries only what the model needs to read
 * back (id, content, date), and everything a human needs to audit it — exact
 * time, which session, which writer — lives here, joined by the id.
 */
export interface MemoryWriteRecord {
	ts: number;
	/** The line id in the category file (or the one that was removed). */
	id: string;
	op: "write" | "forget";
	/** Which writer acted: the model's own tool, or the end-of-session reflection. */
	by: "memory-tool" | "sys-reflect";
	/** Session the write came from, when known. */
	session?: string;
	scope?: MemoryScope;
	category?: MemoryCategory;
	content?: string;
}

// ------------------------------------------------------------- the tool ----

export interface MemoryToolDeps {
	dataDir: string;
	/** Current project id, so a `project`-scoped memory files itself correctly. */
	projectId?: string;
	/** Session id, recorded in the audit log. */
	sessionId?: string;
	/** Called after a change so the caller can refresh the injected block. */
	onChange?: () => void;
}

const memorySchema = Type.Object({
	op: Type.Unsafe<"remember" | "forget">({
		type: "string",
		enum: ["remember", "forget"],
		description: "`remember` stores a new memory (or replaces one by passing its id); `forget` removes one.",
	}),
	content: Type.Optional(
		Type.String({
			description:
				"remember: the memory itself — ONE self-contained sentence or two, in the user's language, stating the rule AND the reason. Not a restatement of the task you just did.",
		}),
	),
	category: Type.Optional(
		Type.Unsafe<MemoryCategory>({
			type: "string",
			enum: [...MEMORY_CATEGORIES],
			description:
				"rules (hard constraints) | style (how to write/reply) | facts (environment truths) | preferences (how this user likes to work) | lessons (a mistake WITH its root cause).",
		}),
	),
	scope: Type.Optional(
		Type.Unsafe<"global" | "project">({
			type: "string",
			enum: ["global", "project"],
			description: "`project` when it is only true of this codebase; `global` when it is about the user or the machine. Default: global.",
		}),
	),
	id: Type.Optional(
		Type.String({
			description: "forget: the id to remove, as shown in `[brackets]` in your Memory block. remember: pass an id to REPLACE that entry instead of adding a second one.",
		}),
	),
});

/**
 * The model's own handle on memory: `remember` writes, `forget` removes by id.
 *
 * Writes take effect immediately — there is deliberately no confirmation queue
 * in this path. The guards that replace it are the audit log, the fact that the
 * ids are visible in the prompt (so the model can correct itself rather than
 * pile contradictions on), and a memory page where a human can edit or delete
 * anything at any time.
 */

export const MEMORY_TOOL_META = {
	name: "memory",
	mode: "W",
	parameters: memorySchema,
	description:
		"Remember something across sessions, or forget it. Use it when you learn something DURABLE — a preference the user states or corrects you on, an environment fact that cost you a detour, a mistake worth not repeating. Do not use it for anything specific to the task at hand, or for anything the repository already says: that gets re-read anyway.",
	prompt: {
		snippet: "Store or drop a cross-session memory",
		guidelines: [
			"Write a memory only when you can point at the moment that justifies it — a correction, a repeated request, a trap you actually hit. One-off task detail is not memory.",
			"Prefer replacing over appending: if an existing entry covers the ground, pass its id so the entry is revised instead of contradicted by a newer line.",
			"Scope it `project` unless it is genuinely about the user or the machine; a project-specific rule filed globally will misfire in every other repo.",
			"A `lesson` must carry its root cause. \"Be careful with X\" is not a lesson; \"X fails because Y, do Z instead\" is.",
		],
	},
} satisfies ToolMeta;

export function createMemoryTool(deps: MemoryToolDeps) {
	const store = new MemoryStore(memoryRoot(deps.dataDir));

	return defineTool<typeof memorySchema, undefined>({
		...MEMORY_TOOL_META,
		label: "Memory",
		parameters: memorySchema,
		async execute(_toolCallId, { op, content, category, scope, id }) {
			const record = async (rec: MemoryWriteRecord): Promise<void> => {
				await store.appendRunRecord(rec).catch(() => undefined);
			};
			if (op === "forget") {
				if (!id) return { content: [{ type: "text", text: "forget needs the `id` of the entry to remove." }], details: undefined };
				const gone = await store.forget(id);
				if (gone) await record({ ts: Date.now(), id, op: "forget", by: "memory-tool", session: deps.sessionId });
				deps.onChange?.();
				return {
					content: [{ type: "text", text: gone ? `Forgot memory [${id}].` : `No memory with id [${id}] — it may already be gone.` }],
					details: undefined,
				};
			}
			if (!content?.trim() || !category) {
				return { content: [{ type: "text", text: "remember needs `content` and a `category`." }], details: undefined };
			}
			const target: MemoryScope =
				scope === "project" && deps.projectId ? { kind: "project", projectId: deps.projectId } : { kind: "global" };
			// Passing an id REPLACES: drop the old line first so a revision does not
			// leave its own contradiction sitting above it.
			if (id) await store.forget(id);
			const newId = await store.append(target, category, content, id);
			await record({ ts: Date.now(), id: newId, op: "write", by: "memory-tool", session: deps.sessionId, scope: target, category, content: content.trim() });
			deps.onChange?.();
			return {
				content: [{ type: "text", text: `Remembered as [${newId}] under ${target.kind}/${category}.` }],
				details: undefined,
			};
		},
	});
}
