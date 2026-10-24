/**
 * Context compaction — fold the oldest real messages into a running summary
 * produced by the `sys-compact` sub-agent, so the agent's context stays bounded
 * as a session grows. The transcript file is never modified by compaction; the
 * result is recorded in a sidecar `<sid>.compact.json` (see {@link CompactRecord}).
 *
 * Compaction is itself an LLM call: a fresh in-process `sys-compact`
 * {@link ClownfishAgent} summarizes the to-be-folded messages (no new process).
 * Repeated compaction re-summarizes the prior summary + newer messages and
 * advances the offset; the on-disk file keeps the full history for browsing.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { lastAssistantText } from "./messages";
import { ClownfishAgent } from "./clownfish-agent";
import type { ResolvedRuntime } from "./models";
import type { Skill } from "./skills";
import type { AgentDefinition, AgentPromptVars } from "./agents/types";
import { renderPrompt } from "./agents/loader";
import type { CompactRecord } from "./transcript";

const COMPACT_AGENT = "sys-compact";
const DEFAULT_KEEP_RECENT = 6;

export interface CompactInput {
	agents: AgentDefinition[];
	runtime: ResolvedRuntime;
	cwd: string;
	skills: Skill[];
	vars: AgentPromptVars;
	sessionId?: string;
}

export interface CompactOptions {
	/**
	 * Real messages currently in the agent's memory (the virtual summary already
	 * stripped). `realMessages[i]` corresponds to transcript line `offset + i`.
	 */
	realMessages: AgentMessage[];
	/** Current compaction offset (0 if none). Real messages before it are already summarized. */
	offset: number;
	/** Minimum number of recent real messages to leave un-compacted. */
	keepRecent?: number;
}

export interface CompactResult {
	/** New compaction record to persist in `<sid>.compact.json`. */
	record: CompactRecord;
	/** Real messages from the new cut onward — the tail to keep in context. */
	tail: AgentMessage[];
}

/** Build the virtual summary message injected at the front of the agent's context. */
export function makeSummaryMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: `[Earlier conversation summary]\n${summary.trim()}` }],
		timestamp: Date.now(),
	} as AgentMessage;
}

type GenericBlock = { type?: string; text?: string; name?: string; arguments?: unknown; isError?: boolean };

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as GenericBlock[])
		.map((b) => {
			switch (b.type) {
				case "text":
					return b.text ?? "";
				case "thinking":
					return `[thinking] ${b.text ?? ""}`;
				case "toolCall":
					return `[tool call ${b.name}] ${typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments)}`;
				case "toolResult":
					return `[tool result${b.isError ? " (error)" : ""}] ${b.text ?? ""}`;
				default:
					return "";
			}
		})
		.join("\n")
		.trim();
}

/** Render messages into readable transcript text for the summarizer. */
function serializeForSummary(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		lines.push(`### ${(m as { role?: string }).role ?? "message"}`);
		lines.push(blockText((m as { content?: unknown }).content) || "(empty)");
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Run compaction: pick a safe cut (a fresh user-turn boundary, leaving
 * `keepRecent` recent messages), summarize everything before it via the
 * `sys-compact` sub-agent, and return the new record + the kept tail.
 *
 * Returns null when there's nothing safe to compact (too few messages, or no
 * user-turn boundary in the compactible range). Throws if the sub-agent fails.
 */
export async function runCompaction(input: CompactInput, opts: CompactOptions): Promise<CompactResult | null> {
	const { realMessages, offset } = opts;
	const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;

	// Fold at most up to (length - keepRecent); need at least one user-turn at
	// index >= 1 so the tail starts cleanly (no orphaned tool result).
	const maxFoldEnd = realMessages.length - keepRecent;
	let cut = -1;
	for (let i = maxFoldEnd; i >= 1; i--) {
		if (realMessages[i].role === "user") {
			cut = i;
			break;
		}
	}
	if (cut <= 0) return null;

	const toSummarize = realMessages.slice(0, cut);
	const tail = realMessages.slice(cut);
	const newOffset = offset + cut;

	const def = input.agents.find((a) => a.name === COMPACT_AGENT && a.internal);
	if (!def) {
		// Losing the built-in definition silently degrades every later turn's
		// context, so make it loud rather than falling back to a one-liner.
		throw new Error(`compaction agent '${COMPACT_AGENT}' not found among loaded agent definitions`);
	}
	const baseSystemPrompt = renderPrompt(def.body, input.vars);

	const sub = new ClownfishAgent({
		cwd: input.cwd,
		runtime: input.runtime,
		skills: [],
		sessionId: input.sessionId ? `${input.sessionId}->compact` : undefined,
		baseSystemPrompt,
		initialMessages: [],
		toolDefs: [],
	});

	const prompt =
		"Produce the running summary for the conversation excerpt below. Follow your instructions; output only the summary.\n\n" +
		`--- EXCERPT START ---\n${serializeForSummary(toSummarize)}\n--- EXCERPT END ---`;

	await sub.prompt(prompt);
	const summary = lastAssistantText(sub.state.messages).trim();
	if (!summary) throw new Error("compaction sub-agent produced no summary");

	return { record: { summary, offset: newOffset }, tail };
}
