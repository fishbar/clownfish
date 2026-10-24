/**
 * Cross-session control tools — the assistant's handle on every OTHER session.
 *
 * Available only to sessions spawned with `projectConfig.sessionControl` (the
 * 我的助理 project). Every action is served by the SERVER over the
 * `session_control` worker→server RPC (see agent/protocol.ts): the worker
 * sends a frame with a ref, parks a promise, and the manager answers with
 * `session_control_result`. The tools here are thin — the server owns the
 * projects/sessions models and the prompt-delivery path, so what the model
 * drives is exactly what the chat UI drives (`AgentManager.prompt`).
 *
 *   sessions       (R)  list projects, their sessions, and live run state
 *   session_send   (W)  deliver a message to a session AS IF the user typed it
 *                       in the chat UI — idle sessions start a turn (activate),
 *                       running ones queue (steer/followup)
 *   session_read   (R)  a session's recent transcript tail (to read the reply)
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition, type ToolMeta } from "./definition";

/** What the server returns for `list`. */
interface SessionEntry {
	id: string;
	title?: string;
	updatedAt: number;
	/** Live worker state (absent = no worker spawned). */
	running?: boolean;
	queued?: { steer: number; followup: number };
}
interface ProjectEntry {
	projectId: string;
	name: string;
	path: string;
	sessions: SessionEntry[];
}

/** Payload for one session_control action. Mirrors the wire frame minus ref. */
export interface SessionControlPayload {
	projectId?: string;
	sessionId?: string;
	text?: string;
	mode?: "steer" | "followup";
}

export interface SessionControlToolDeps {
	/** Perform one RPC round-trip to the server (AgentRuntime.sessionControl). */
	control: (action: "list" | "send" | "read", payload?: SessionControlPayload) => Promise<unknown>;
}

const listSchema = Type.Object({}, { description: "List every project, its sessions, and each session's live state (running / queued)." });

const sendSchema = Type.Object(
	{
		project_id: Type.String({ description: "Target project id (from `sessions`)." }),
		session_id: Type.String({ description: "Target session id (from `sessions`)." }),
		text: Type.String({ description: "The message to deliver, as if the user typed it in the chat UI. Self-contained — the target session shares no context with this one." }),
		mode: Type.Optional(
			Type.Union([Type.Literal("steer"), Type.Literal("followup")], {
				description: 'Delivery when the target is mid-run: "steer" injects into the running loop, "followup" (default) queues a fresh turn after it.',
			}),
		),
	},
	{ description: "Send a user message to another session (activates an idle one)." },
);

const readSchema = Type.Object(
	{
		project_id: Type.String({ description: "Project id of the session to read." }),
		session_id: Type.String({ description: "Session id to read." }),
	},
	{ description: "Read a session's recent transcript tail (its latest replies)." },
);

function err<D = undefined>(tool: string, message: string): AgentToolResult<D> {
	// details is typed as never-filled on the error path — the caller's shape
	// decides the generic, so this drops into any tool's execute return.
	return { content: [{ type: "text", text: `${tool}: ${message}` }], details: undefined as D };
}

function fmtList(projects: ProjectEntry[]): string {
	if (!projects.length) return "(no projects)";
	const lines: string[] = [];
	for (const p of projects) {
		lines.push(`${p.projectId}  ${p.name}  (${p.path})`);
		if (!p.sessions.length) {
			lines.push("    (no sessions)");
			continue;
		}
		for (const s of p.sessions) {
			const when = new Date(s.updatedAt).toLocaleString();
			const state = s.running ? "RUNNING" : s.queued?.steer || s.queued?.followup ? `queued(steer ${s.queued.steer}, followup ${s.queued.followup})` : "idle";
			lines.push(`    ${s.id}  ${state}  ${when}  ${s.title ? `«${s.title}»` : "(untitled)"}`);
		}
	}
	return lines.join("\n");
}

/** Shape the model sees from `read`: role + text, oldest first. */
interface ReadReply {
	messages: Array<{ role: string; text: string }>;
}

export const SESSIONS_TOOL_META = {
	name: "sessions",
	mode: "R",
	parameters: listSchema,
	description: "List every project and its sessions with live state (running / queued / idle), plus session ids for `session_send`.",
	prompt: {
		snippet: "List projects and their sessions",
		guidelines: ["Call this before `session_send` — the ids it returns are the ones the send tool needs."],
	},
} satisfies ToolMeta;

export const SESSION_SEND_TOOL_META = {
	name: "session_send",
	mode: "W",
	parameters: sendSchema,
	description:
		'Deliver a message to another session exactly as if the user typed it in the chat UI. An idle session starts a turn on it (activation); a running session queues it (default "followup" = a fresh turn after the current one). Use `sessions` for the ids, `session_read` to see the reply later.',
	prompt: {
		snippet: "Message (and activate) another session",
		guidelines: [
			"The text is delivered verbatim as a user turn — make it self-contained; the target shares nothing with this conversation.",
			"Delivery is not completion: the reply arrives asynchronously. Poll `session_read`, or tell the operator where to watch.",
		],
	},
} satisfies ToolMeta;

export const SESSION_READ_TOOL_META = {
	name: "session_read",
	mode: "R",
	parameters: readSchema,
	description: "Read another session's recent transcript tail — the replies to what `session_send` delivered.",
	prompt: {
		snippet: "Read a session's latest messages",
		guidelines: ["A fresh turn may still be running — an absent reply is not a refusal; re-read after a wait."],
	},
} satisfies ToolMeta;

export function createSessionControlTools(deps: SessionControlToolDeps): ToolDefinition[] {
	const sessionsTool: ToolDefinition<typeof listSchema> = defineTool({
		...SESSIONS_TOOL_META,
		label: "sessions",
		parameters: listSchema,
		async execute(): Promise<AgentToolResult<undefined>> {
			try {
				const data = await deps.control("list");
				return { content: [{ type: "text", text: fmtList(data as ProjectEntry[]) }], details: undefined };
			} catch (e) {
				return err("sessions", e instanceof Error ? e.message : String(e));
			}
		},
	});

	const sendTool: ToolDefinition<typeof sendSchema, { delivered?: boolean }> = defineTool<typeof sendSchema, { delivered?: boolean }>({
		...SESSION_SEND_TOOL_META,
		label: "session_send",
		parameters: sendSchema,
		async execute(_id, p): Promise<AgentToolResult<{ delivered?: boolean }>> {
			try {
				const data = (await deps.control("send", {
					projectId: p.project_id,
					sessionId: p.session_id,
					text: p.text,
					mode: p.mode ?? "followup",
				})) as { delivered?: boolean; note?: string };
				return {
					content: [{ type: "text", text: `delivered to ${p.project_id}/${p.session_id}${data?.note ? ` — ${data.note}` : ""}` }],
					details: { delivered: data?.delivered ?? true },
				};
			} catch (e) {
				return err<{ delivered?: boolean }>("session_send", e instanceof Error ? e.message : String(e));
			}
		},
	});

	const readTool: ToolDefinition<typeof readSchema> = defineTool({
		...SESSION_READ_TOOL_META,
		label: "session_read",
		parameters: readSchema,
		async execute(_id, p): Promise<AgentToolResult<undefined>> {
			try {
				const data = (await deps.control("read", { projectId: p.project_id, sessionId: p.session_id })) as ReadReply;
				const msgs = Array.isArray(data?.messages) ? data.messages : [];
				return {
					content: [{
						type: "text",
						text: msgs.length
							? msgs.map((m) => `${m.role === "user" ? "USER" : m.role === "assistant" ? "AGENT" : m.role.toUpperCase()}: ${m.text}`).join("\n\n")
							: "(no messages yet)",
					}],
					details: undefined,
				};
			} catch (e) {
				return err("session_read", e instanceof Error ? e.message : String(e));
			}
		},
	});

	return [sessionsTool, sendTool, readTool];
}
