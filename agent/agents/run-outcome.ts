/**
 * Run-outcome helpers — telling a FINISHED run from an INTERRUPTED one.
 *
 * pi's agent loop stops the whole run on the first provider error (stopReason
 * "error" on the last assistant message) and `prompt()` then RESOLVES — from
 * the caller's side a 429-killed run looks exactly like a completed one unless
 * you inspect the final message. These helpers are the single seam every
 * background runner (dagRoot / delegate / goalRoot) uses to tell them apart,
 * so an interrupted run is never mistaken for success (which would poison the
 * DAG with fake-completed nodes and make resume impossible).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Concatenated text of the last assistant message that produced any. */
export function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = (m.content as Array<{ type?: string; text?: string }>)
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export interface RunOutcome {
	/** False when the run died on a provider error (429 / 5xx / network / stall). */
	ok: boolean;
	/** Last assistant text (empty string when the run died before producing any). */
	summary: string;
	/** The provider error message when `ok` is false. */
	error?: string;
}

/**
 * Classify a finished `prompt()` run. A provider-killed turn ends with an
 * assistant message whose stopReason is "error" and whose content is empty —
 * that shape is the interruption signal; everything else counts as finished.
 */
export function runOutcome(messages: AgentMessage[]): RunOutcome {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const errored = m.stopReason === "error";
		if (!errored) break;
		return { ok: false, summary: "", error: (m as { errorMessage?: string }).errorMessage || "provider error" };
	}
	return { ok: true, summary: lastAssistantText(messages) };
}

/**
 * Drop trailing failed-turn messages so the SAME agent instance can be
 * re-prompted cleanly (goal rounds re-prompt in place). A provider-killed turn
 * appends an EMPTY assistant message; leaving it in poisons the next request
 * (Anthropic-compatible APIs reject empty assistant content). Aborted turns
 * with partial content stay — they are valid payloads and useful context.
 */
export function trimErroredTail(messages: AgentMessage[]): AgentMessage[] {
	const out = [...messages];
	while (out.length > 0) {
		const last = out[out.length - 1];
		const content = (last as { content?: unknown[] }).content;
		if (last.role === "assistant" && last.stopReason === "error" && (!content || content.length === 0)) out.pop();
		else break;
	}
	return out;
}
