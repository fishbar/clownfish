/**
 * SessionTranscript — append-only JSONL transcript(s) for a session.
 *
 * A session owns a **directory** `${sessionsDir}/<sessionId>/` containing:
 *   - `index.jsonl`      — the main agent's transcript (the session root).
 *   - `<agentUuid>.jsonl` — one per spawned subagent (dagRoot/dagSub), same envelope
 *                           format; each subagent gets its own SessionTranscript.
 *   - `compact.json`     — the compaction sidecar (summary + offset).
 *   - `dag.json`         — the shared DAG state sidecar (all concurrent DAGs).
 *
 * Modeled on Claude Code's session storage (`~/.claude/projects/<cwd>/<sid>.jsonl`,
 * one file per conversation, each line a JSON object with an id) and Codex's per-
 * session rollout files. Unlike opencode (one giant shared SQLite DB), each session
 * is isolated, so an agent worker writes only its own files and agents never contend.
 *
 * Each line is an **envelope** `{ id, ts, message }`:
 *   - `id`  — stable per-message id → UI dedup (live item vs. history) and a future
 *             branching hook (`parentId`, à la Claude Code's `parentUuid`).
 *   - `ts`  — the message timestamp (falls back to now).
 *   - `message` — the raw pi {@link AgentMessage}, round-trips back into the Agent.
 *
 * Pagination keys off **append order (the line index)**, not the id: these ids are
 * not ordered, so it can't drive cursoring. The line index is the time-ordered cursor.
 *
 * Older sessions used a flat `${sessionsDir}/<sessionId>.jsonl` (+ `.compact.json`);
 * {@link SessionTranscript.migrate} moves them into the directory on first access.
 */
import { generateId } from "./id";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface TranscriptEntry {
	id: string;
	ts: number;
	message: AgentMessage;
}

/**
 * Compaction record — a running summary that replaces the oldest messages in the
 * agent's context. Stored as a sidecar at `<sessionId>/compact.json`; the transcript
 * file itself is never modified by compaction (the full history is kept on disk
 * for browsing; only what's fed to the model is shortened).
 *   - `summary` — the compacted context (text produced by the sys-compact agent).
 *   - `offset`  — number of leading real messages (== transcript line index) the
 *                 summary stands in for. On load the agent context is the summary
 *                 plus real messages from this index onward.
 */
export interface CompactRecord {
	summary: string;
	offset: number;
}

export interface TranscriptPage {
	messages: AgentMessage[];
	/** Total envelopes in the file. */
	total: number;
	/** Line index (0-based) of the oldest message in this page. */
	oldestIndex: number;
	/** Older messages exist beyond this page. */
	hasMore: boolean;
}

function messageTimestamp(m: AgentMessage): number {
	const ts = (m as { timestamp?: number }).timestamp;
	return typeof ts === "number" ? ts : Date.now();
}

function parseEnvelopes(raw: string): TranscriptEntry[] {
	const out: TranscriptEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const e = JSON.parse(line) as Partial<TranscriptEntry>;
			if (e && e.message) out.push(e as TranscriptEntry);
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

export class SessionTranscript {
	constructor(
		private readonly sessionsDir: string,
		private readonly sessionId: string,
		/**
		 * The agent this transcript belongs to. The main agent (agentId === sessionId
		 * or unset) writes `index.jsonl`; a subagent writes `<agentId>.jsonl`. Every
		 * file lives under the per-session directory {@link SessionTranscript.dir}.
		 */
		private readonly agentId?: string,
	) {}

	/** Per-session directory: `<sessionsDir>/<sessionId>/`. */
	dir(): string {
		return join(this.sessionsDir, this.sessionId);
	}

	private get fileName(): string {
		return !this.agentId || this.agentId === this.sessionId ? "index.jsonl" : `${this.agentId}.jsonl`;
	}

	path(): string {
		return join(this.dir(), this.fileName);
	}

	/** Full read — the worker rebuilds agent context from this. */
	async load(): Promise<AgentMessage[]> {
		await this.migrate();
		const raw = await readFile(this.path(), "utf8").catch(() => null);
		if (!raw) return [];
		return parseEnvelopes(raw).map((e) => e.message);
	}

	/**
	 * Sub-agent transcript ids persisted in this session dir (`<agentId>.jsonl`
	 * files; the main `index.jsonl` is excluded). The server uses this to link a
	 * run_agent tool call to the sub-agent transcript it produced.
	 */
	async listSubAgentIds(): Promise<string[]> {
		const entries = await readdir(this.dir(), { withFileTypes: true }).catch(() => []);
		return entries
			.filter((e) => e.isFile() && /^[A-Za-z0-9_-]{6,64}\.jsonl$/.test(e.name) && e.name !== "index.jsonl")
			.map((e) => e.name.slice(0, -".jsonl".length))
			.sort();
	}

	/**
	 * The first user message's concatenated text — the delegation prompt, which
	 * run_agent builds as `${task}\n\nContext:\n${context}` — or undefined when
	 * the transcript is empty / unreadable. The UI matches it against the run_agent
	 * tool-call args to find a HISTORICAL sub's transcript (frames are long gone).
	 */
	async firstPrompt(): Promise<string | undefined> {
		const messages = await this.load();
		for (const m of messages) {
			if (m.role !== "user") continue;
			const text =
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((b) => b.type === "text")
							.map((b) => (b as { text: string }).text)
							.join("");
			return text || undefined;
		}
		return undefined;
	}

	/**
	 * Cursor page read for the REST/UI. `before` is an exclusive upper-bound line
	 * index (the oldest index the client already holds); omit it for the most
	 * recent page. Returns the page plus paging metadata.
	 */
	async loadPage(limit: number, before?: number): Promise<TranscriptPage> {
		await this.migrate();
		const raw = await readFile(this.path(), "utf8").catch(() => null);
		const entries = raw ? parseEnvelopes(raw) : [];
		const total = entries.length;
		const upper = before === undefined ? total : Math.max(0, Math.min(before, total));
		const lower = Math.max(0, upper - limit);
		const slice = entries.slice(lower, upper);
		return {
			messages: slice.map((e) => e.message),
			total,
			oldestIndex: lower,
			hasMore: lower > 0,
		};
	}

	/** Path of the sidecar compaction record (independent of the transcript file). */
	compactPath(): string {
		return join(this.dir(), "compact.json");
	}

	/** Path of the DAG state sidecar (all concurrent DAGs in the session). */
	dagPath(): string {
		return join(this.dir(), "dag.json");
	}

	/** Read the DAG state sidecar, or null if absent / malformed. */
	async loadDag(): Promise<unknown | null> {
		const raw = await readFile(this.dagPath(), "utf8").catch(() => null);
		if (!raw) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	async writeDag(data: unknown): Promise<void> {
		// Atomic (tmp + rename): concurrent DagStore flushes must never observe
		// a half-written file — a torn dag.json parses as null on next boot and
		// silently drops ALL DAG + worktree state.
		await mkdir(this.dir(), { recursive: true });
		const tmp = `${this.dagPath()}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
		await rename(tmp, this.dagPath());
	}

	/**
	 * One-time layout migration: older sessions kept a flat `<sessionId>.jsonl` (and
	 * `<sessionId>.compact.json`) directly under `sessionsDir`. Move them into the
	 * per-session directory as `index.jsonl` / `compact.json`. Idempotent and
	 * race-safe (a lost `rename` just means another process already moved it). Also
	 * ensures the session directory exists.
	 */
	private async migrate(): Promise<void> {
		await mkdir(this.dir(), { recursive: true });
		const oldTranscript = join(this.sessionsDir, `${this.sessionId}.jsonl`);
		if (!(await pathExists(this.path()))) {
			try {
				await rename(oldTranscript, this.path());
			} catch {
				/* no flat transcript to migrate (fresh session) */
			}
		}
		const oldCompact = join(this.sessionsDir, `${this.sessionId}.compact.json`);
		if (!(await pathExists(this.compactPath()))) {
			try {
				await rename(oldCompact, this.compactPath());
			} catch {
				/* no flat compact sidecar to migrate */
			}
		}
	}

	/** Read the compaction record, or null if the session has never been compacted. */
	async loadCompact(): Promise<CompactRecord | null> {
		const raw = await readFile(this.compactPath(), "utf8").catch(() => null);
		if (!raw) return null;
		try {
			const r = JSON.parse(raw) as Partial<CompactRecord>;
			if (typeof r.summary === "string" && typeof r.offset === "number") {
				return { summary: r.summary, offset: r.offset };
			}
		} catch {
			/* malformed compact file — ignore */
		}
		return null;
	}

	async writeCompact(rec: CompactRecord): Promise<void> {
		await mkdir(dirname(this.compactPath()), { recursive: true });
		await writeFile(this.compactPath(), JSON.stringify(rec, null, 2), "utf8");
	}

	async clearCompact(): Promise<void> {
		await rm(this.compactPath(), { force: true });
	}

	private envelope(m: AgentMessage): TranscriptEntry {
		return { id: generateId(), ts: messageTimestamp(m), message: m };
	}

	/** Append envelopes for the given (new) messages. Pure append — never rewrites. */
	async appendMessages(messages: AgentMessage[]): Promise<void> {
		if (messages.length === 0) return;
		await mkdir(dirname(this.path()), { recursive: true });
		const lines = messages.map((m) => JSON.stringify(this.envelope(m)));
		await appendFile(this.path(), `${lines.join("\n")}\n`, "utf8");
	}

	/**
	 * Rewrite the entire transcript from `messages` (truncate / regenerate / abort).
	 * Invalidates any compaction record — line indices no longer line up — so the
	 * caller should also clearCompact() and drop the in-memory summary.
	 */
	async rewriteAll(messages: AgentMessage[]): Promise<void> {
		await mkdir(dirname(this.path()), { recursive: true });
		const lines = messages.map((m) => JSON.stringify(this.envelope(m)));
		await writeFile(this.path(), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
	}

	async remove(): Promise<void> {
		// A session is one directory (main transcript + subagents + dag + compact);
		// deleting the session removes all of it.
		await rm(this.dir(), { recursive: true, force: true });
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}
