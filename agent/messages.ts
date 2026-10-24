/**
 * pi → wire message conversion.
 *
 * Storage holds raw pi {@link AgentMessage} JSON (round-trips back into the
 * Agent with zero drift). The WebUI only ever sees the lighter {@link
 * WireMessage} shape defined in ../server/protocol, produced here at the REST /
 * realtime boundary.
 *
 * AgentMessage narrows to pi's standard UserMessage / AssistantMessage /
 * ToolResultMessage, whose content blocks are themselves discriminated unions —
 * so this is fully type-checked with no casts.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	WireMessage,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	TextBlock,
	ImageBlock,
	ToolCallBlock,
	ThinkingBlock,
	ToolResultBlock,
} from "../server/protocol";

function mapTextImage(content: readonly (TextBlock | ImageBlock)[]): (TextBlock | ImageBlock)[] {
	return content.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "image", data: b.data, mimeType: b.mimeType }));
}

/** Convert one pi agent message to the UI wire shape. Returns undefined for
 * pi-harness-specific message types (BashExecution, branch summaries, etc.)
 * that the basic loop never emits here. */
export function toWireMessage(m: AgentMessage): WireMessage | undefined {
	if (m.role === "user") {
		const content = typeof m.content === "string" ? m.content : mapTextImage(m.content);
		return { role: "user", content, timestamp: m.timestamp };
	}

	if (m.role === "assistant") {
		const content: (TextBlock | ToolCallBlock | ThinkingBlock)[] = [];
		for (const b of m.content) {
			if (b.type === "text") content.push({ type: "text", text: b.text });
			else if (b.type === "thinking") content.push({ type: "thinking", text: b.thinking });
			else if (b.type === "toolCall") content.push({ type: "toolCall", id: b.id, name: b.name, input: b.arguments });
		}
		return {
			role: "assistant",
			content,
			timestamp: m.timestamp,
			stopReason: m.stopReason,
			usage: { inputTokens: m.usage.input, outputTokens: m.usage.output },
		};
	}

	if (m.role === "toolResult") {
		const inner = mapTextImage(m.content);
		const block: ToolResultBlock = { type: "toolResult", toolCallId: m.toolCallId, content: inner, isError: m.isError };
		return { role: "toolResult", content: [block], timestamp: m.timestamp } satisfies ToolResultMessage;
	}

	return undefined;
}

export function toWireMessages(messages: readonly AgentMessage[]): WireMessage[] {
	return messages.map(toWireMessage).filter((m): m is WireMessage => m !== undefined);
}

// Keep the wire message types referenced for downstream typing.
export type { UserMessage, AssistantMessage, ToolResultMessage };

/**
 * Text of a tool result (or a partial one). Lives here rather than in `proxy.ts`
 * so the worker can read progress payloads without importing the WebSocket
 * transport for a string helper.
 */
export function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		// A result may carry several text blocks (e.g. read of an image appends a
		// caption block) — keep them ALL, joined, not just the first.
		const texts = content
			.filter((b: { type?: string }) => b?.type === "text")
			.map((b: { text?: string }) => (typeof b.text === "string" ? b.text : ""))
			.filter(Boolean);
		if (texts.length) return texts.join("\n");
	}
	return "";
}

/**
 * Concatenated text of the last assistant message that has any — a sub-agent's
 * final answer, and the tail a compaction summarizes from.
 */
export function lastAssistantText(messages: readonly AgentMessage[]): string {
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
