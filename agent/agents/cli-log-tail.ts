/**
 * Session-log tailing for external CLI sub-agents — the UI/progress channel.
 *
 * Display deliberately does NOT parse the CLI's stdout (VT100, spinners,
 * repaints — brittle and information-poor). Both Codex and Claude Code write
 * their FULL structured conversation to disk as JSONL:
 *   claude:  ~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl
 *            (line = {type:"user"|"assistant"|"system", message, uuid,
 *             parentUuid, timestamp, cwd, sessionId, isSidechain, …})
 *   codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl
 *            (line = {timestamp, type:"session_meta"|"response_item", payload}
 *             — the deleted agent/codex-mirror.ts was grounded in openai/codex's
 *             Rust source for exactly this shape)
 * We tail those files and adapt each line into pi AgentEvents under the
 * delegation's bus id — so the existing drill-in chat view, progress rows and
 * transcript mirroring render a CLI sub-agent EXACTLY like an in-process one,
 * with zero new wire frames.
 *
 * Discovery: claude's `--session-id` is caller-chosen (we generate the UUID),
 * so its log path is deterministic. codex names rollouts itself, so the tailer
 * snapshots the day's directory before spawn and afterwards polls for a NEW
 * rollout whose session_meta cwd matches the delegation's workdir.
 */
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

/** A fabricated assistant message's provider bookkeeping — the CLI's own
 *  numbers are unknown here; the UI only reads text/toolCall blocks. */
const CLI_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } } as AssistantMessage["usage"];

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "messages" as AssistantMessage["api"],
		provider: "cli" as AssistantMessage["provider"],
		model: "external-cli",
		usage: CLI_USAGE,
		stopReason: "stop",
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

/** One adapted log line's worth of output: events to emit, messages to record. */
export interface AdaptedLine {
	events: AgentEvent[];
	messages: AgentMessage[];
}

/** Minimal surface the adapters' consumer must provide. */
export interface LogTailHooks {
	/** Emit a bus event under the delegation's agentId (drill-in + progress). */
	emitEvent(event: AgentEvent): void;
	/** Record a message into the mirrored transcript. */
	recordMessage(message: AgentMessage): void;
}

/**
 * Incremental JSONL reader: polls a file from a byte offset every
 * `intervalMs`, buffering a partial trailing line until its newline. Polling
 * over fs.watch on purpose — at most a couple of files per delegation, and
 * immune to editor/watcher flakiness.
 */
export class JsonlTail {
	private offset = 0;
	private buffer = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;

	constructor(
		private readonly file: string,
		private readonly onLine: (line: string) => void,
		private readonly intervalMs = 500,
	) {}

	/** Path being tailed (for logging/provenance). */
	get path(): string {
		return this.file;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll(), this.intervalMs);
		// Do not hold the event loop open just to tail.
		this.timer.unref?.();
		void this.poll();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One poll cycle — also called directly by tests. */
	async poll(): Promise<void> {
		if (this.stopped) return;
		const size = await stat(this.file)
			.then((s) => s.size)
			.catch(() => null);
		if (size === null || size <= this.offset) return;
		let chunk: string;
		try {
			chunk = await readFile(this.file, { encoding: "utf8", flag: "r" });
		} catch {
			return; // vanished mid-read — next poll retries
		}
		// Re-read whole-file slices rather than fh.readAt: simpler, and these
		// files are bounded by one delegation's conversation.
		const fresh = chunk.slice(this.offset);
		this.offset = chunk.length;
		this.buffer += fresh;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? ""; // keep the unterminated tail
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) this.onLine(trimmed);
		}
	}
}

// ---------------------------------------------------------------------------
// claude session-log adapter
// ---------------------------------------------------------------------------

/** claude's per-project dir: `~/.claude/projects/<cwd with / → ->`. Two
 *  measured details: claude slugs the RESOLVED cwd (on macOS a /var/folders
 *  workdir lands under /private/var), and it replaces slashes WITHOUT
 *  filtering empties — an absolute path keeps its LEADING dash
 *  (`/private/var/x` → `-private-var-x`). */
export function claudeProjectDir(workdir: string, configDir?: string): string {
	const root = configDir ?? join(homedir(), ".claude");
	let resolved = workdir;
	try {
		resolved = realpathSync(workdir);
	} catch {
		/* absent yet — slug the path as given */
	}
	return join(root, "projects", resolved.split("/").join("-"));
}

/**
 * Where a CLI writes its logs, resolved from the env the CHILD actually runs
 * with — not the worker's own. The two differ by design (the child gets an
 * allowlist plus the entry's `env:{}`), so an entry that sets
 * CLAUDE_CONFIG_DIR / CODEX_HOME / HOME moves the log, and the tail must
 * follow it there.
 */
export function cliLogRoot(kind: "claude" | "codex", env: Record<string, string | undefined>): string {
	const explicit = kind === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
	if (explicit) return explicit;
	return join(env.HOME || homedir(), kind === "claude" ? ".claude" : ".codex");
}

/** Deterministic claude log path for a caller-chosen session id. */
export function claudeLogPath(workdir: string, sessionId: string, configDir?: string): string {
	return join(claudeProjectDir(workdir, configDir), `${sessionId}.jsonl`);
}

/** Any JSON content block shape (claude is liberal). */
type AnyBlock = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blockText(blocks: AnyBlock[]): string {
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/**
 * Adapt one claude session-log line. Skips sidechains (its OWN sub-agents),
 * system/meta noise, and command envelopes; maps assistant `tool_use` blocks
 * to tool events, and the matching `tool_result` user line to their end.
 */
export function adaptClaudeLine(line: string, idSeq: () => string): AdaptedLine {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return { events: [], messages: [] };
	}
	if (entry.isSidechain === true || entry.isMeta === true) return { events: [], messages: [] };
	const type = entry.type;
	const message = entry.message as { role?: string; content?: string | AnyBlock[] } | undefined;
	if (type !== "user" && type !== "assistant") return { events: [], messages: [] };
	if (!message || typeof message.role !== "string") return { events: [], messages: [] };
	const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || Date.now() : Date.now();
	const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : ((message.content ?? []) as AnyBlock[]);

	if (type === "user") {
		// A user line is either plain text or a tool_result payload.
		const toolResults = blocks.filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
		if (toolResults.length) {
			const out: AdaptedLine = { events: [], messages: [] };
			for (const r of toolResults) {
				const inner = Array.isArray(r.content) ? blockText(r.content as AnyBlock[]) : typeof r.content === "string" ? r.content : "";
				const isError = r.is_error === true;
				out.events.push({
					type: "tool_execution_end",
					toolCallId: r.tool_use_id!,
					toolName: "",
					result: { content: [{ type: "text", text: inner.slice(0, 4000) }] },
					isError,
				});
				const tr: ToolResultMessage = {
					role: "toolResult",
					toolCallId: r.tool_use_id!,
					toolName: "",
					content: [{ type: "text", text: inner.slice(0, 4000) }],
					isError,
					timestamp: ts,
				};
				out.messages.push(tr);
			}
			return out;
		}
		const text = blockText(blocks).trim();
		if (!text) return { events: [], messages: [] };
		const msg = userMessage(text, ts);
		return { events: [{ type: "message_end", message: msg }], messages: [msg] };
	}

	// assistant
	const text = blockText(blocks);
	const toolUses = blocks.filter((b) => b.type === "tool_use" && typeof b.id === "string");
	const msg = assistantMessage(text, ts);
	// Tool calls ride the transcript as part of the assistant message (pi's
	// own shape), while the bus gets start/end events keyed by claude's ids.
	for (const u of toolUses) {
		(msg.content as Array<{ type: string; id?: string; name?: string; arguments?: unknown }>).push({
			type: "toolCall",
			id: u.id,
			name: typeof u.name === "string" ? u.name : "tool",
			arguments: u.input,
		});
	}
	const events: AgentEvent[] = [{ type: "message_start", message: msg }, { type: "message_end", message: msg }];
	for (const u of toolUses) {
		events.push({
			type: "tool_execution_start",
			toolCallId: u.id!,
			toolName: typeof u.name === "string" ? u.name : "tool",
			args: u.input ?? {},
		});
	}
	// toolName is unknown at tool_execution_end time (claude logs it only on
	// the call side) — the id matches the start event, which is what the UI
	// keys on; `idSeq` exists for adapters that must synthesize ids.
	void idSeq;
	return { events, messages: [msg] };
}

// ---------------------------------------------------------------------------
// codex rollout adapter
// ---------------------------------------------------------------------------

/** codex's sessions dir for a date: `~/.codex/sessions/YYYY/MM/DD`. */
export function codexSessionDir(date = new Date(), configDir?: string): string {
	const root = configDir ?? join(homedir(), ".codex");
	const y = date.getFullYear();
	const m = `${date.getMonth() + 1}`.padStart(2, "0");
	const d = `${date.getDate()}`.padStart(2, "0");
	return join(root, "sessions", `${y}`, `${m}`, `${d}`);
}

/** Filenames already present in a dir (used to spot the NEW rollout later). */
export async function snapshotDir(dir: string): Promise<Set<string>> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	return new Set(entries.filter((e) => e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")).map((e) => e.name));
}

/**
 * Find the rollout file for our delegation: a file NOT in the pre-spawn
 * snapshot whose first parsed line is a session_meta with our cwd. One final
 * sweep after process exit covers a codex that flushes late.
 */
export async function findCodexRollout(dirs: Array<{ dir: string; before: Set<string> }>, cwd: string): Promise<string | undefined> {
	for (const { dir, before } of dirs) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			if (!e.isFile() || before.has(e.name) || !e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) continue;
			const first = await readFile(join(dir, e.name), "utf8")
				.then((raw) => raw.split("\n", 1)[0] ?? "")
				.catch(() => "");
			if (!first) continue;
			try {
				const meta = JSON.parse(first) as { type?: string; payload?: { cwd?: string } };
				if (meta.type === "session_meta" && meta.payload?.cwd === cwd) return join(dir, e.name);
			} catch {
				/* partially flushed first line — not ours (yet) */
			}
		}
	}
	return undefined;
}

/** Map a codex rollout payload type to the adapter's output. */
export function adaptCodexLine(line: string, idSeq: () => string): AdaptedLine {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return { events: [], messages: [] };
	}
	if (entry.type !== "response_item") return { events: [], messages: [] };
	const payload = entry.payload as { type?: string; role?: string; content?: AnyBlock[]; name?: string; arguments?: string; call_id?: string; output?: string } | undefined;
	if (!payload || typeof payload.type !== "string") return { events: [], messages: [] };
	const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) || Date.now() : Date.now();

	if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
		const blocks = (payload.content ?? []).filter((b) => b.type === "input_text" || b.type === "output_text");
		const text = blocks.map((b) => b.text ?? "").join("\n").trim();
		if (!text) return { events: [], messages: [] };
		const msg = payload.role === "user" ? userMessage(text, ts) : assistantMessage(text, ts);
		return { events: [{ type: "message_end", message: msg }], messages: [msg] };
	}

	if (payload.type === "function_call" && typeof payload.call_id === "string") {
		const name = typeof payload.name === "string" ? payload.name : "tool";
		let args: unknown = {};
		try {
			args = payload.arguments ? JSON.parse(payload.arguments) : {};
		} catch {
			args = { raw: payload.arguments };
		}
		return {
			events: [{ type: "tool_execution_start", toolCallId: payload.call_id, toolName: name, args }],
			messages: [],
		};
	}

	if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
		const text = typeof payload.output === "string" ? payload.output : "";
		const tr: ToolResultMessage = {
			role: "toolResult",
			toolCallId: payload.call_id,
			toolName: "",
			content: [{ type: "text", text: text.slice(0, 4000) }],
			isError: false,
			timestamp: ts,
		};
		return {
			events: [{ type: "tool_execution_end", toolCallId: payload.call_id, toolName: "", result: { content: tr.content }, isError: false }],
			messages: [tr],
		};
	}

	void idSeq;
	return { events: [], messages: [] };
}
