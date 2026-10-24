/**
 * Server-side proxy helpers: map raw pi {@link AgentEvent}s to browser wire
 * frames, reconstruct an in-flight turn from a snapshot, and fan frames out to
 * subscribers with backpressure. Pure except for the final `ws.send`.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ServerToClient, WorkflowProgressWire } from "../server/protocol";
import { WebSocket } from "ws";
import { toWireMessage, toolResultText } from "./messages";
import type { WorkerSnapshot } from "./protocol";
import type { AgentSocket } from "./agent-socket";

/** Backpressure cap (bytes). Past this, intermediate deltas are dropped for a slow client. */
const MAX_BUFFERED = 1 << 20; // 1 MiB

export { toolResultText } from "./messages";

/** Shape-check a workflow tool's `details` into a wire-safe progress snapshot.
 *  Unknown/malformed → undefined (the field is simply dropped, text still rides). */
function workflowProgress(details: unknown): WorkflowProgressWire | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (typeof d.name !== "string" || !Array.isArray(d.phases) || !Array.isArray(d.agents) || !Array.isArray(d.logs)) return undefined;
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const agents: WorkflowProgressWire["agents"] = [];
	for (const a of d.agents) {
		if (!a || typeof a !== "object") return undefined;
		const r = a as Record<string, unknown>;
		if (typeof r.label !== "string" || (r.status !== "running" && r.status !== "done" && r.status !== "error")) return undefined;
		const label = r.label;
		const status = r.status;
		const phase = str(r.phase);
		const preview = str(r.preview);
		const agentId = str(r.agentId);
		agents.push({
			label,
			status,
			...(phase !== undefined ? { phase } : {}),
			...(preview !== undefined ? { preview } : {}),
			...(agentId !== undefined ? { agentId } : {}),
		});
	}
	const phases = d.phases.filter((p): p is string => typeof p === "string");
	const currentPhase = str(d.currentPhase);
	return { name: d.name, phases, ...(currentPhase !== undefined ? { currentPhase } : {}), logs: d.logs.filter((l): l is string => typeof l === "string"), agents };
}

/** Map one raw pi AgentEvent to zero or more browser wire frames. Pure. */
export function mapEventToFrames(event: AgentEvent, agentId?: string): ServerToClient[] {
	switch (event.type) {
		case "agent_start":
			return [{ type: "agent_start", agentId }];
		case "message_start": {
			if (event.message.role !== "assistant") return [];
			const wire = toWireMessage(event.message);
			return wire ? [{ type: "message_start", message: wire, agentId }] : [];
		}
		case "message_update": {
			const e = event.assistantMessageEvent;
			return e.type === "text_delta" ? [{ type: "text_delta", delta: e.delta, agentId }] : [];
		}
		case "message_end": {
			// User-role message_end = pi drained a steer/followup message into
			// the loop (initial prompts also end up here). The UI appends the row
			// only for pending QUEUED submissions — normal sends already appended
			// optimistically, so those must not duplicate.
			if (event.message.role === "user") {
				const uw = toWireMessage(event.message);
				return uw ? [{ type: "message_end", message: uw, agentId }] : [];
			}
			if (event.message.role !== "assistant") return [];
			const frames: ServerToClient[] = [];
			const am = event.message as { stopReason?: string; errorMessage?: string };
			if (am.stopReason === "error" || am.stopReason === "aborted") {
				frames.push({ type: "error", message: am.errorMessage ?? `assistant ${am.stopReason}` });
			}
			const wire = toWireMessage(event.message);
			if (wire) frames.push({ type: "message_end", message: wire, agentId });
			return frames;
		}
		case "tool_execution_start":
			return [{ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, agentId }];
		case "tool_execution_update": {
			// Three payloads ride the wire: the process monitor (pid from bash),
			// the partial text (workflow's progress snapshot — full text each
			// time, so the UI can just replace), and workflow's STRUCTURED
			// progress (steps + per-agent status) for its drill-in view.
			const partial = event.partialResult as
				| { details?: { pid?: number; name?: unknown; phases?: unknown; currentPhase?: unknown; logs?: unknown; agents?: unknown }; content?: Array<{ type?: string; text?: string }> }
				| undefined;
			const pid = partial?.details?.pid;
			const text = partial?.content?.find((b) => b?.type === "text")?.text;
			const progress = workflowProgress(partial?.details);
			return pid !== undefined || text !== undefined || progress !== undefined
				? [
						{
							type: "tool_update",
							toolCallId: event.toolCallId,
							...(pid !== undefined ? { pid } : {}),
							...(text !== undefined ? { text } : {}),
							...(progress !== undefined ? { progress } : {}),
							agentId,
						},
					]
				: [];
		}
		case "tool_execution_end":
			return [
				{ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, text: toolResultText(event.result), agentId },
			];
		case "turn_end":
			return [{ type: "turn_end", agentId }];
		case "agent_end":
			return [{ type: "agent_end", agentId }];
		default:
			return [];
	}
}

/**
 * Reconstruct the in-flight state for a UI joining mid-run, as the same wire
 * frames it would have seen live. Per agent (main + live subs): agent_spawned
 * (registry/label/parent), agent_start, accumulated streaming text, running
 * tool_start frames. The UI's patchSub/agents/liveTools logic is shared between
 * live and replayed frames — no special-casing anywhere.
 */
export function snapshotToFrames(s: WorkerSnapshot, agentId?: string): ServerToClient[] {
	const frames: ServerToClient[] = [];
	// The plan is session-level and worth replaying even to a tab that joins
	// between turns, so it goes out before any per-agent frames.
	if (s.todos && s.todos.length > 0) frames.push({ type: "todos", items: s.todos });
	for (const a of s.agents) {
		// Sub-agents replay with their identity so the tree/registry self-heals.
		if (a.kind !== "main") {
			// `usage` seeds a joining tab's per-agent token counter with the
			// worker's ledger — the frames that built it live were missed.
			frames.push({ type: "agent_spawned", agentId: a.agentId, parentAgentId: a.parentAgentId, kind: a.kind, label: a.label, ...(a.toolCallId ? { toolCallId: a.toolCallId } : {}), ...(a.name ? { name: a.name } : {}), ...(a.usage ? { usage: a.usage } : {}) });
		} else if (!a.active && a.activeTools.length === 0 && !a.streamingText) {
			continue; // idle main agent — nothing to replay
		}
		const id = a.kind === "main" ? agentId : a.agentId;
		if (a.active || a.activeTools.length > 0 || a.streamingText) {
			frames.push({ type: "agent_start", agentId: id });
			if (a.streamingText) {
				// message_start resets the streaming bubble (content ignored by the UI);
				// the delta carries the accumulated text so far.
				frames.push({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }], timestamp: Date.now() }, agentId: id });
				frames.push({ type: "text_delta", delta: a.streamingText, agentId: id });
			}
			for (const t of a.activeTools) {
				frames.push({ type: "tool_start", toolCallId: t.toolCallId, toolName: t.toolName, args: t.args, agentId: id });
				// A bash child's pid arrives after spawn — replay it so the joining
				// tab's tree shows the same `pid N` badge a live tab sees.
				if (t.pid !== undefined) frames.push({ type: "tool_update", toolCallId: t.toolCallId, pid: t.pid, agentId: id });
				// Same for a sub-agent's progress line, which is the only thing a
				// run_agent card shows while the child works.
				if (t.progress) frames.push({ type: "tool_update", toolCallId: t.toolCallId, toolName: t.toolName, text: t.progress, agentId: id });
			}
		}
	}
	return frames;
}

/** Send one frame to a subscriber, dropping intermediate deltas under backpressure. */
export function deliver(ws: AgentSocket, frame: ServerToClient): void {
	if (ws.readyState !== WebSocket.OPEN) return;
	if (frame.type === "text_delta" && ws.bufferedAmount > MAX_BUFFERED) return;
	ws.send(JSON.stringify(frame));
}

/**
 * Agent-stream frames: tied to ONE agent's token/tool stream. These are subject to
 * subscriber-interest filtering — a drill-in view (interest = agentId X) only gets
 * X's stream. Everything else (`ready`/`error`/`tool_approval`/`session_meta`/
 * `agent_spawned`/`agent_ended`) is session-structural and always delivered.
 */
const AGENT_STREAM_TYPES = new Set<ServerToClient["type"]>([
	"agent_start",
	"message_start",
	"text_delta",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"turn_end",
	"agent_end",
]);

/**
 * Whether a frame should reach a subscriber with the given interest.
 *   interest === undefined → whole-session view, receives everything.
 *   interest === agentId   → drill-in, receives only that agent's stream + structural frames.
 */
function shouldDeliver(interest: string | undefined, frame: ServerToClient): boolean {
	if (interest === undefined) return true;
	if (!AGENT_STREAM_TYPES.has(frame.type)) return true;
	return (frame as { agentId?: string }).agentId === interest;
}

/**
 * Fan frames out to subscribers, filtered by each subscriber's interest.
 * `subscribers` maps each socket → its agentId interest (`undefined` = whole session).
 */
export function fanOut(subscribers: Map<WebSocket, string | undefined>, frames: ServerToClient[]): void {
	if (subscribers.size === 0 || frames.length === 0) return;
	for (const [ws, interest] of subscribers) {
		if (ws.readyState !== WebSocket.OPEN) continue;
		for (const frame of frames) if (shouldDeliver(interest, frame)) deliver(ws, frame);
	}
}
