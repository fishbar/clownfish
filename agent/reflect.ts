/**
 * End-of-session reflection — the agent's own look back at what just happened.
 *
 * Runs ONCE, when a session genuinely ends (idle reap or an explicit stop), and
 * writes straight into memory. There is no confirmation queue in front of it by
 * design: what replaces one is the audit log (`runs.jsonl`), the fact that every
 * entry carries a visible id the model can revise, and a memory page where a
 * human deletes anything they disagree with.
 *
 * A server-wide Ctrl-C passes `reason: "server"` and skips this — quitting the
 * dev loop must not fire one model call per live session.
 *
 * Deliberately conservative, because a noisy memory store is worse than an empty
 * one: skipped under {@link MIN_MESSAGES} messages, at most
 * {@link MAX_NEW_ENTRIES} entries per session, only the last
 * {@link MAX_MESSAGES_FED} messages are read, a hard time ceiling, and it never
 * throws into the shutdown path. `CLOWNFISH_REFLECT=0` turns it off entirely.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ClownfishAgent } from "./clownfish-agent";
import { renderPrompt } from "./agents/loader";
import type { AgentDefinition, AgentPromptVars } from "./agents/types";
import type { ResolvedRuntime } from "./models";
import { MemoryStore, memoryRoot, MEMORY_CATEGORIES, type MemoryCategory, type MemoryScope, type MemoryWriteRecord } from "./memory";

/** A session shorter than this has nothing durable in it. */
const MIN_MESSAGES = 8;
/** Ceiling per session — reflection proposes a few things, never a backlog. */
const MAX_NEW_ENTRIES = 3;
/** Only the tail is read: the end of a session is where its conclusions are. */
const MAX_MESSAGES_FED = 60;
/** Wall-clock ceiling — shutdown must not wait on a slow model. */
const TIMEOUT_MS = 90_000;

const REFLECT_AGENT = "sys-reflect";

export interface ReflectInput {
	runtime: ResolvedRuntime;
	agents: AgentDefinition[];
	dataDir: string;
	cwd: string;
	vars: AgentPromptVars;
	/** Files a `project`-scoped memory under this id. */
	projectId?: string;
	sessionId?: string;
	/** Compaction summary of what fell out of the window, when there is one. */
	priorSummary?: string;
}

export function reflectionEnabled(): boolean {
	return process.env.CLOWNFISH_REFLECT !== "0";
}

interface Draft {
	content: string;
	category: MemoryCategory;
	scope: "global" | "project";
	/** Set when the model is REVISING an existing entry rather than adding one. */
	id?: string;
}

type GenericBlock = { type?: string; text?: string };

function textOf(m: AgentMessage): string {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return (c as GenericBlock[])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

function serialize(messages: AgentMessage[]): string {
	return messages
		.slice(-MAX_MESSAGES_FED)
		.map((m) => `[${m.role}] ${textOf(m).slice(0, 2000)}`)
		.filter((l) => l.length > 8)
		.join("\n\n");
}

/** Parse the reflection's JSON array leniently — fences and prose are stripped. */
function parseDrafts(text: string): Draft[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const out: Draft[] = [];
	for (const item of raw) {
		if (out.length >= MAX_NEW_ENTRIES) break;
		const o = item as Record<string, unknown>;
		const content = typeof o.content === "string" ? o.content.trim() : "";
		const category = o.category as MemoryCategory;
		if (!content || !MEMORY_CATEGORIES.includes(category)) continue;
		out.push({
			content,
			category,
			scope: o.scope === "project" ? "project" : "global",
			id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : undefined,
		});
	}
	return out;
}

/**
 * Run one reflection pass. Returns the ids written (possibly none). Never
 * throws — callers run this on the way out.
 */
export async function runReflection(input: ReflectInput, messages: AgentMessage[]): Promise<string[]> {
	if (!reflectionEnabled()) return [];
	const def = input.agents.find((a) => a.name === REFLECT_AGENT && a.internal);
	if (!def) return [];
	try {
		const store = new MemoryStore(memoryRoot(input.dataDir));
		// A session can end MORE THAN ONCE — reaped, reopened, reaped again — and
		// the second worker restores the whole history. Without this cursor the
		// second pass would re-read what the first already distilled and write the
		// same memories a second time. A cursor past the end means the history was
		// rewritten under us (compaction), so start over rather than skip.
		const cursors = input.sessionId ? await store.cursors() : {};
		const prior = input.sessionId ? cursors[input.sessionId]?.count ?? 0 : 0;
		const from = prior <= messages.length ? prior : 0;
		const fresh = messages.slice(from);
		if (fresh.length < MIN_MESSAGES) return [];
		const existing = await store.readAll();
		const sub = new ClownfishAgent({
			cwd: input.cwd,
			runtime: input.runtime,
			skills: [],
			sessionId: input.sessionId ? `${input.sessionId}/reflect` : undefined,
			baseSystemPrompt: renderPrompt(def.body, input.vars),
			initialMessages: [],
			// No tools: reflection reads a conversation and returns JSON. Giving it
			// the workspace would let it wander instead of concluding.
			toolDefs: [],
		});
		const existingBlock = existing.length
			? existing
					.map((b) => `## ${b.scope.kind}/${b.category}\n${b.body.trim()}`)
					.join("\n\n")
			: "(memory is empty)";
		const prompt =
			`Workspace: ${input.cwd}\n\nExisting memory (revise by reusing an id, do not restate):\n${existingBlock}\n\n` +
			`${input.priorSummary ? `Earlier in this session (summarized):\n${input.priorSummary}\n\n` : ""}` +
			`--- CONVERSATION START ---\n${serialize(fresh)}\n--- CONVERSATION END ---\n\n` +
			"Return the JSON array now. `[]` if nothing here is worth remembering.";

		const run = sub.prompt(prompt);
		const timed = await Promise.race([
			run.then(() => "done" as const),
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), TIMEOUT_MS)),
		]);
		if (timed === "timeout") {
			sub.abort();
			return [];
		}

		const answer = [...sub.state.messages].reverse().find((m) => m.role === "assistant");
		const drafts = parseDrafts(answer ? textOf(answer) : "");
		const written: string[] = [];
		for (const d of drafts) {
			const scope: MemoryScope =
				d.scope === "project" && input.projectId ? { kind: "project", projectId: input.projectId } : { kind: "global" };
			// A revision replaces its predecessor rather than sitting above it.
			if (d.id) await store.forget(d.id);
			const id = await store.append(scope, d.category, d.content, d.id);
			const rec: MemoryWriteRecord = {
				ts: Date.now(),
				id,
				op: "write",
				by: "sys-reflect",
				session: input.sessionId,
				scope,
				category: d.category,
				content: d.content,
			};
			await store.appendRunRecord(rec as never).catch(() => undefined);
			written.push(id);
		}
		// Advance only on a completed pass: a failure must not silently skip the
		// window it could not read.
		if (input.sessionId) await store.saveCursor(input.sessionId, { count: messages.length, updatedAt: Date.now() });
		return written;
	} catch {
		return [];
	}
}
