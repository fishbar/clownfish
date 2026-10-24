/**
 * Internal protocol between the AgentManager (server) and an agent worker over
 * the Unix-domain WebSocket. Distinct from the browser wire protocol
 * ({@link ClientToServer} / {@link ServerToClient} in ../server/protocol), which is
 * unchanged.
 *
 * The worker ships raw pi {@link AgentEvent}s up as `event` frames; the server
 * maps them to browser wire frames (see {@link mapEventToFrames} in proxy.ts), so
 * the worker never needs to know the browser format.
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** A single active tool the worker reports back in a snapshot. */
import type { TodoItem } from "./todo";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	/** Latest partial result the tool reported (e.g. a sub-agent's live progress). */
	progress?: string;
	/** Wall-clock start (ms epoch) — lets a joining UI show true elapsed time. */
	startedAt: number;
	/** OS pid when the tool runs a separate process (bash). For resource stats. */
	pid?: number;
}

/** One agent's live state (main or sub) inside the session snapshot. */
export interface AgentSnapshot {
	agentId: string;
	label: string;
	/** "wfRoot" = a workflow run's anchor agent (the UI folds it into its parent's row). */
	kind: "main" | "dagRoot" | "dagSub" | "wfRoot";
	/** Tree assembly: parent agent's id (undefined on main). */
	parentAgentId?: string;
	/** run_agent only: the tool call that spawned this sub (drill-down link). */
	toolCallId?: string;
	/** run_agent only: the sub's agent TYPE (e.g. "coder") — shown in the drill head. */
	name?: string;
	/** Has an in-flight turn right now. */
	active: boolean;
	/** Wall-clock spawn (main: worker boot) time in ms epoch. */
	agentStartedAt: number;
	/** Assistant text streamed in the current, unfinished message. */
	streamingText: string;
	activeTools: ActiveTool[];
	/** Cumulative provider usage for this agent (all turns since worker boot). */
	usage?: { inputTokens: number; outputTokens: number; messages: number };
}

/** Run state reconstructed for a UI that joins mid-turn: every agent (main +
 *  subs) in the session, tree-assembled client-side via parentAgentId. */
export interface WorkerSnapshot {
	active: boolean;
	agents: AgentSnapshot[];
	/**
	 * The session plan, so a joining tab sees it without waiting for a change.
	 * Session-level, not per-agent: only the top-level agent gets the `todo` tool,
	 * so one plan belongs to the session rather than to any one agent in it.
	 */
	todos?: TodoItem[];
}

/** Session execution mode for the main agent (user-selectable). */
export type ExecutionMode = "plan" | "auto" | "ask";

/** Server → worker commands. */
export type ManagerFrame =
	/** `mode` only applies while the main agent is streaming: "steer" injects
	 *  into the running loop (next assistant turn), "followup" waits for the
	 *  run to end and starts a new one. Without a mode (or when idle) it is a
	 *  plain prompt. */
	| { type: "prompt"; text: string; mode?: "steer" | "followup" }
	| { type: "abort" }
	/** User-initiated: convert a running SYNC run_agent sub to background (its
	 *  tool call resolves early with a marker; the result arrives as a message). */
	| { type: "detach_agent"; agentId: string }
	| { type: "snapshot" }
	| { type: "compact" }
	/**
	 * Admin panel write landed (registry / prompt / skill / mcp.json): swap in a
	 * freshly discovered asset set. An idle worker reloads immediately; a busy
	 * one defers to its next turn so the first LLM request of that turn already
	 * carries the new prompt/toolset.
	 */
	| { type: "reload_assets" }
	| { type: "set_mode"; mode: ExecutionMode }
	| { type: "tool_decision"; toolCallId: string; approved: boolean }
	/** Reply to a worker-initiated `session_control` frame, matched by ref. */
	| { type: "session_control_result"; ref: number; ok: boolean; data?: unknown; error?: string }
	/** CLI-backed (pty) sessions only: bytes to write to the pty's stdin. */
	| { type: "pty_input"; data: string }
	/** CLI-backed (pty) sessions only: the browser terminal's size changed. */
	| { type: "pty_resize"; cols: number; rows: number }
	/**
	 * Ask the worker to exit. `reason` decides whether the session is worth
	 * reflecting on: a reap or an explicit stop ENDS a session (reflect), a
	 * server shutdown does not — the operator hit Ctrl-C, and firing one model
	 * call per live session on the way out is not what they asked for.
	 */
	| { type: "shutdown"; reason?: "stop" | "reap" | "server" };

/** Worker → server frames. */
export type WorkerFrame =
	| { type: "register"; sessionId: string; agentId?: string }
	| { type: "ready" }
	| { type: "event"; event: AgentEvent; agentId?: string }
	| { type: "snapshot"; snapshot: WorkerSnapshot; agentId?: string }
	| { type: "persisted"; count: number }
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "error"; message: string }
	| { type: "heartbeat"; busy: boolean }
	/** Compaction finished: the worker folded older messages into a summary. */
	| { type: "compacted"; offset: number; kept: number }
	/** Execution mode changed (set_mode ack). */
	| { type: "mode_changed"; mode: ExecutionMode }
	/** Ask mode: a write-capable tool is awaiting the user's approval. */
	| { type: "tool_approval"; toolCallId: string; toolName: string; args: unknown; agentId?: string }
	/** Side-channel: the worker generated a session title (never part of the chat). */
	| { type: "set_title"; title: string }
	/** The session plan changed (model rewrote it, or a delegation moved a step). */
	| { type: "todos"; items: TodoItem[] }
	/**
	 * Something the operator should see but which is not a failure — a whole-tree
	 * rollback, say. Distinct from `error`, which also rejects pending acks.
	 */
	| { type: "notice"; message: string }
	/**
	 * A new agent came into existence within the session (the main agent on boot, or
	 * a spawned dagRoot/dagSub/wfRoot agent). The server forwards this to subscribed
	 * UIs so they can offer a stream for it. `kind`: "main" = session root,
	 * "dagRoot" = a DAG's driving agent, "dagSub" = a DAG branch agent, "wfRoot" =
	 * one workflow run's anchor agent.
	 */
	| {
			type: "agent_spawned";
			agentId: string;
			parentAgentId?: string;
			kind: "main" | "dagRoot" | "dagSub" | "wfRoot";
			label?: string;
			/** run_agent only: the tool call that spawned this sub — lets the UI drill from the tool row into the sub's stream. */
			toolCallId?: string;
			/** run_agent only: the sub's agent TYPE (e.g. "coder") — shown in the drill head. */
			name?: string;
		}
	/** An agent finished and will emit no more frames. */
	| { type: "agent_ended"; agentId: string }
	/** Pending steer/followup queue depths for the main agent (sent after every
	 *  enqueue and after every drain / run end — drives the toolbar counters). */
	| { type: "queue_state"; steer: number; followup: number }
	/**
	 * Session-control RPC (the assistant's cross-session tools). The worker is
	 * the initiator — it parks a pending promise on `ref` and the server answers
	 * with `session_control_result` (the same shape as tool_approval ↔
	 * tool_decision, reversed). `send` delivers `text` to a session exactly as
	 * if the user typed it in the chat UI (steer/followup semantics apply);
	 * `list` enumerates projects/sessions with live state; `read` returns a
	 * session's recent transcript tail.
	 */
	| {
			type: "session_control";
			ref: number;
			action: "list" | "send" | "read";
			projectId?: string;
			sessionId?: string;
			text?: string;
			mode?: "steer" | "followup";
	  }
	/** CLI-backed (pty) sessions only: a chunk of raw pty output (stdout+stderr, may include ANSI). */
	| { type: "pty_data"; data: string }
	/** CLI-backed (pty) sessions only: the external CLI process exited; the worker exits right after. */
	| { type: "pty_exit"; code: number | null };

/** Spawn config the server passes to the worker via the CLOWNFISH_WORKER_CONFIG env. */
export interface WorkerSpawnConfig {
	projectId: string;
	sessionId: string;
	cwd: string;
	/** Project name (for the {project} prompt var). */
	projectName: string;
	projectConfig: {
		provider: string;
		model: string;
		apiKeyEnv?: string;
		baseUrlEnv?: string;
		skillsDirs: string[];
		systemPrompt?: string;
		/** Named agent to run (default "system"). */
		agent?: string;
		/** Reasoning effort passed to the provider; see ProjectConfig.thinking. */
		thinking?: string;
		/** Cross-session control (the assistant project): adds the `sessions` /
		 *  `session_send` tools, served over the session_control RPC. */
		sessionControl?: boolean;
		contextWindow?: number;
	};
	dataDir: string;
	sessionsDir: string;
	udsPath: string;
	/** Initial execution mode (default "auto"). */
	mode?: ExecutionMode;
}

export const WORKER_CONFIG_ENV = "CLOWNFISH_WORKER_CONFIG";

/** Spawn config for a CLI-backed (pty) session's worker — see agent/pty-worker.ts. */
export interface PtyWorkerSpawnConfig {
	sessionId: string;
	cwd: string;
	command: string;
	args?: string[];
	/** Layered over the allowlisted base env (see agent/mcp.ts's env pattern) — never the full worker env. */
	env?: Record<string, string>;
	udsPath: string;
}

export const PTY_WORKER_CONFIG_ENV = "CLOWNFISH_PTY_WORKER_CONFIG";
