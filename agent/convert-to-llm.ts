/**
 * convertToLlm — strips anything the LLM shouldn't see.
 *
 * pi's {@link AgentMessage} is `Message | Custom…`; we forward only the three
 * standard roles. Custom messages are dropped. Errored assistant turns are
 * dropped too: a provider-killed run (429/5xx/stream stall) appends an EMPTY
 * assistant message, and Anthropic-compatible APIs reject empty assistant
 * content — without this strip, one provider error would 400 every later turn
 * of the session. An errored turn never carries executed tool calls (the loop
 * exits before running them), so dropping it cannot orphan a toolResult.
 * Contract: never throws.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export function convertToLlm(messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") continue;
		if (m.role === "assistant" && m.stopReason === "error" && (m.content as unknown[]).length === 0) continue;
		out.push(m as Message);
	}
	return out;
}
