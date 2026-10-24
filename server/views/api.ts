/**
 * REST + WebSocket client for the Clownfish server.
 *
 * Uses relative URLs (/api, /chat); in dev Vite proxies them to the server, in
 * prod the server serves both the API and the built UI from the same origin.
 */
import type {
	AgentPromptInfo,
	ToolPromptInfo,
	TodoItem,
	KeyAction,
	KeybindingInfo,
	MemoryInfo,
	ClientToServer,
	CreateProjectBody,
	CronJobWire,
	DagStateWire,
	FileVersionWire,
	InventoryItemWire,
	InventoryWire,
	MemoryBlockWire,
	PathSuggestion,
	Project,
	ServerToClient,
	SessionBackend,
	SessionMeta,
	SessionPage,
	WireMessage,
	WorkflowProgressWire,
} from "../protocol";

const BASE = "/api";

/**
 * Inventory REST base: a pid scopes discovery to that project's tree; an empty
 * pid is the 全局 scope (`/api/inventory` — builtin + global assets only).
 */
function inv(pid: string): string {
	return pid ? `/projects/${pid}/inventory` : "/inventory";
}

export interface Health {
	ok: boolean;
	provider: string;
	model: string;
}

/** Live status of a running agent worker (subset of the server's AgentStatusInfo). */
export interface AgentStatus {
	sessionId: string;
	projectId: string;
	status: string;
	busy: boolean;
	mode?: string;
}

/** A skill discoverable for a project (drives the `/` command menu). */
export interface SkillInfo {
	name: string;
	description: string;
}

/** A slash command (project / global / plugin `commands/*.md`). */
export interface CommandInfo {
	name: string;
	description: string;
	/** Frontmatter `argument-hint`, e.g. `[file]`. */
	argumentHint?: string;
	/** "global" | "project" | "plugin:<name>". */
	source: string;
}

/** A plugin bundle and which of its assets clownfish wired up. */
export interface PluginInfo {
	name: string;
	dir: string;
	scope: "global" | "project";
	skills: boolean;
	agents: boolean;
	commands: boolean;
	mcp: boolean;
	/** Recognized but not executed yet. */
	hooks: boolean;
}

/** A turn checkpoint of the agent's write/edit mutations. */
export interface CheckpointInfo {
	seq: number;
	ts: number;
	entries: Array<{ rel: string; created?: boolean }>;
}

/** One configured external CLI agent (`<dataDir>/cli-agents.json`). */
export interface CliAgentInfo {
	name: string;
	description?: string;
	/** Session-log format to tail: claude / codex / none. */
	log: string;
	/** Executable — full path or a PATH name. */
	command: string;
	/** Complete argv with `{session-id}` `{workdir}` `{model}` `{result-file}` placeholders. */
	args: string[];
	env?: Record<string, string>;
	instructions?: string;
	model?: string;
	access?: string;
	/** Server-side: does the command resolve on PATH right now. */
	available?: boolean;
}

/** The session's compaction record (the running summary the model sees). */
export interface CompactSummaryInfo {
	summary: string;
	offset: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "content-type": "application/json" },
		...init,
	});
	// Auth is on but we have no session — bounce to the login entry, which the
	// server 302s to whichever provider is enabled (Google consent / simple
	// login page). The SPA never needs to know the provider.
	if (res.status === 401) {
		window.location.assign("/auth/login");
		throw new Error("redirecting to login");
	}
	if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => res.statusText)}`);
	return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
	health: () => req<Health>("/health"),
	/** Autocomplete a filesystem path (prefix match, directories only). */
	completePath: (prefix: string) =>
		req<{ suggestions: PathSuggestion[] }>(`/path/complete?${new URLSearchParams({ prefix }).toString()}`),
	listProjects: () => req<Project[]>("/projects"),
	getProject: (id: string) => req<Project>(`/projects/${id}`),
	createProject: (b: CreateProjectBody) => req<Project>("/projects", { method: "POST", body: JSON.stringify(b) }),
	updateProject: (id: string, b: { name?: string; config?: Record<string, unknown> }) =>
		req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
	deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
	listSessions: (pid: string) => req<SessionMeta[]>(`/projects/${pid}/sessions`),
	createSession: (pid: string, title?: string, backend?: SessionBackend) =>
		req<SessionMeta>(`/projects/${pid}/sessions`, { method: "POST", body: JSON.stringify({ title, backend }) }),
	/** Load one transcript page (most recent first). `before` = oldest line index held. */
	getSession: (pid: string, sid: string, opts?: { limit?: number; before?: number }) => {
		const q = new URLSearchParams();
		if (opts?.limit) q.set("limit", String(opts.limit));
		if (opts?.before !== undefined) q.set("before", String(opts.before));
		const qs = q.toString();
		return req<SessionPage>(`/projects/${pid}/sessions/${sid}${qs ? `?${qs}` : ""}`);
	},
	deleteSession: (pid: string, sid: string) => req<void>(`/projects/${pid}/sessions/${sid}`, { method: "DELETE" }),
	renameSession: (pid: string, sid: string, title: string) =>
		req<SessionMeta>(`/projects/${pid}/sessions/${sid}`, { method: "PATCH", body: JSON.stringify({ title }) }),
	/** Stop a session's process (agent worker or CLI pty) — graceful, SIGKILL after 5s. */
	stopAgent: (pid: string, sid: string) =>
		req<{ stopped: boolean }>(`/projects/${pid}/sessions/${sid}/agent/stop`, { method: "POST" }),
	/** Live status of every running agent worker (drives the sidebar status dots). */
	listAgents: () => req<AgentStatus[]>("/agents"),
	/** Skills discoverable for a project (drives the `/` command menu). */
	listSkills: (pid: string) => req<SkillInfo[]>(`/projects/${pid}/skills`),
	/** Slash commands for a project (the other half of the `/` menu). */
	listCommands: (pid: string) => req<CommandInfo[]>(`/projects/${pid}/commands`),
	/** Plugin bundles visible to a project, and which assets are wired. */
	listPlugins: (pid: string) => req<PluginInfo[]>(`/projects/${pid}/plugins`),
	/** Compact a session's context: fold older messages into a summary. */
	compactSession: (pid: string, sid: string) =>
		req<{ status: AgentStatus }>(`/projects/${pid}/sessions/${sid}/agent/compact`, { method: "POST" }),
	/** Live status of one running agent (incl. execution mode). */
	agentStatus: (pid: string, sid: string) =>
		req<AgentStatus>(`/projects/${pid}/sessions/${sid}/agent/status`),
	/** Switch the session's execution mode (plan/auto/ask). */
	setMode: (pid: string, sid: string, mode: "plan" | "auto" | "ask") =>
		req<{ mode: string }>(`/projects/${pid}/sessions/${sid}/agent/mode`, { method: "POST", body: JSON.stringify({ mode }) }),
	/** Turn checkpoints (pre-change snapshots of the agent's write/edit mutations). */
	listCheckpoints: (pid: string, sid: string) => req<CheckpointInfo[]>(`/projects/${pid}/sessions/${sid}/checkpoints`),
	/** Restore a checkpoint's pre-images (undo that turn's file edits). */
	restoreCheckpoint: (pid: string, sid: string, seq: number) =>
		req<{ restored: number }>(`/projects/${pid}/sessions/${sid}/checkpoints/${seq}/restore`, { method: "POST" }),
	/** The session's compaction record (running summary the model sees), or null. */
	getCompact: (pid: string, sid: string) => req<CompactSummaryInfo | null>(`/projects/${pid}/sessions/${sid}/compact`),
	/** Every discovered agent prompt. `pid` widens the scan to that project's own agents/plugins. */
	listAgentPrompts: (pid?: string) =>
		req<AgentPromptInfo[]>(`/agent-prompts${pid ? `?${new URLSearchParams({ projectId: pid }).toString()}` : ""}`),
	/** Save an agent's prompt as a copy-on-write override (never touches the source file). */
	saveAgentPrompt: (name: string, content: string) =>
		req<{ name: string; path: string }>(`/agent-prompts/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify({ content }),
		}),
	/** Drop the override so the underlying definition takes effect again. */
	resetAgentPrompt: (name: string) => req<void>(`/agent-prompts/${encodeURIComponent(name)}`, { method: "DELETE" }),
	/** Timestamped backups of an agent's override (newest first) — kept across a reset. */
	listAgentPromptVersions: (name: string) =>
		req<{ versions: FileVersionWire[] }>(`/agent-prompts/${encodeURIComponent(name)}/versions`),
	getAgentPromptVersion: (name: string, version: string) =>
		req<{ content: string }>(`/agent-prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`),
	/** Restore a backup as the override (the current one is backed up first). */
	rollbackAgentPrompt: (name: string, version: string) =>
		req<{ content: string }>(`/agent-prompts/${encodeURIComponent(name)}/rollback`, { method: "POST", body: JSON.stringify({ version }) }),

	listTodos: (pid: string, sid: string) => req<TodoItem[]>(`/projects/${pid}/sessions/${sid}/todos`),




	listKeybindings: () => req<KeybindingInfo[]>("/keybindings"),

	setKeybinding: (action: KeyAction, keys: string) =>
		req<{ action: KeyAction; keys: string; bindings: KeybindingInfo[] }>(`/keybindings/${action}`, {
			method: "PUT",
			body: JSON.stringify({ keys }),
		}),

	resetKeybinding: (action: KeyAction) =>
		req<{ action: KeyAction; keys: string; bindings: KeybindingInfo[] }>(`/keybindings/${action}`, { method: "DELETE" }),

	resetAllKeybindings: () => req<KeybindingInfo[]>("/keybindings", { method: "DELETE" }),

	listToolPrompts: () => req<ToolPromptInfo[]>("/tool-prompts"),

	saveToolPrompt: (name: string, content: string) =>
		req<{ name: string; path: string }>(`/tool-prompts/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify({ content }),
		}),

	resetToolPrompt: (name: string) => req<void>(`/tool-prompts/${encodeURIComponent(name)}`, { method: "DELETE" }),

	/** External CLI agents (settings → Agent): the effective list + the shipped
	 *  recommended configs (the form's example) + whether the feature is gated on. */
	listCliAgents: () => req<{ agents: CliAgentInfo[]; defaults: CliAgentInfo[]; enabled: boolean }>("/cli-agents"),

	saveCliAgent: (agent: CliAgentInfo) =>
		req<{ ok: true; agent: CliAgentInfo }>(`/cli-agents/${encodeURIComponent(agent.name)}`, {
			method: "PUT",
			body: JSON.stringify(agent),
		}),

	deleteCliAgent: (name: string) => req<{ ok: true }>(`/cli-agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
	/** The session's execution-plan DAG state (side-panel tree), or null. */
	getDag: (pid: string, sid: string) => req<DagStateWire | null>(`/projects/${pid}/sessions/${sid}/dag`),
	/** Sub-agents with a persisted transcript: id + delegation prompt (the first
	 * user message) — links a run_agent tool call to the sub it spawned. */
	listSubAgents: (pid: string, sid: string) => req<{ agentId: string; prompt: string }[]>(`/projects/${pid}/sessions/${sid}/agents`),
	/** One sub-agent's full transcript (the drill-down view). */
	getSubAgent: (pid: string, sid: string, agentId: string) =>
		req<{ messages: WireMessage[] }>(`/projects/${pid}/sessions/${sid}/agents/${agentId}`),
	/** Scheduled (cron) jobs across all sessions + internal tasks. */
	listCron: () => req<{ jobs: CronJobWire[] }>("/cron"),
	/** Cancel a session's scheduled job. */
	cancelCron: (sessionId: string, jobId: string) => req<{ ok: boolean }>(`/cron/${sessionId}/${jobId}/cancel`, { method: "POST" }),
	/** Every memory, grouped by scope + category. */
	listMemory: () => req<{ blocks: MemoryBlockWire[] }>("/memory"),
	/** Drop one memory by its `[id]`. */
	forgetMemory: (id: string) => req<void>(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
	/**
	 * The admin panel's asset inventory (agents/skills/tools/plugins). `pid`
	 * empty = the 全局 scope: discovery runs against dataDir, so builtin +
	 * global assets are listed (same REST surface, mounted at /inventory).
	 */
	listInventory: (pid: string) => req<InventoryWire>(inv(pid)),
	/** Enable/disable one asset (registry.json; idle workers recycle to pick it up). */
	toggleInventory: (pid: string, kind: "agents" | "skills" | "tools" | "plugins", name: string, enabled: boolean) =>
		req<{ ok: boolean }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
	/** An agent prompt / SKILL.md body. */
	getInventoryDoc: (pid: string, kind: "agents" | "skills", name: string) =>
		req<{ content: string; item: InventoryItemWire }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}/doc`),
	/** Versioned write (current content is backed up first). */
	putInventoryDoc: (pid: string, kind: "agents" | "skills", name: string, content: string) =>
		req<{ ok: boolean }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}/doc`, { method: "PUT", body: JSON.stringify({ content }) }),
	/** Timestamped backups of an agent prompt / SKILL.md, newest first. */
	listInventoryVersions: (pid: string, kind: "agents" | "skills", name: string) =>
		req<{ versions: FileVersionWire[] }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}/versions`),
	/** One backup's content (diff base / rollback preview). */
	getInventoryVersion: (pid: string, kind: "agents" | "skills", name: string, version: string) =>
		req<{ content: string }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}/versions/${version}`),
	/** Restore a backup as the current content (the replaced content is itself backed up). */
	rollbackInventory: (pid: string, kind: "agents" | "skills", name: string, version: string) =>
		req<{ ok: boolean; content: string }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}/rollback`, { method: "POST", body: JSON.stringify({ version }) }),
	/** Create a new agent prompt in the global dir. */
	createInventoryAgent: (pid: string, name: string, content: string) =>
		req<{ ok: boolean; path: string }>(`${inv(pid)}/agents`, { method: "POST", body: JSON.stringify({ name, content }) }),
	/** Create a new skill (global `<dataDir>/skills/<name>/SKILL.md`). */
	createInventorySkill: (pid: string, name: string, content: string) =>
		req<{ ok: boolean; path: string }>(`${inv(pid)}/skills`, { method: "POST", body: JSON.stringify({ name, content }) }),
	/** Create a global plugin bundle skeleton. */
	createInventoryPlugin: (pid: string, name: string) =>
		req<{ ok: boolean; dir: string }>(`${inv(pid)}/plugins`, { method: "POST", body: JSON.stringify({ name }) }),
	/** Delete an agent/skill/plugin (writable sources only). */
	deleteInventory: (pid: string, kind: "agents" | "skills" | "plugins", name: string) =>
		req<{ ok: boolean }>(`${inv(pid)}/${kind}/${encodeURIComponent(name)}`, { method: "DELETE" }),
	/** The global MCP config file (mcp.json), raw for the JSON editor. */
	getMcpConfig: (pid: string) => req<{ content: string | null }>(`${inv(pid)}/mcp`),
	/** Validate + persist the global MCP config. */
	putMcpConfig: (pid: string, content: string) =>
		req<{ ok: boolean }>(`/projects/${pid}/inventory/mcp`, { method: "PUT", body: JSON.stringify({ content }) }),
};

export type { AgentPromptInfo, ToolPromptInfo, TodoItem, KeybindingInfo, KeyAction, MemoryInfo };

// -------------------------------- auth --------------------------------------

export interface AuthUser {
	email: string;
	name?: string;
	picture?: string;
}
export interface AuthMe {
	enabled: boolean;
	authenticated: boolean;
	user: AuthUser | null;
}

/** Auth status probe + logout. `/auth/me` is always 200 (never a redirect trigger). */
export const auth = {
	me: (): Promise<AuthMe> => fetch("/auth/me").then((r) => r.json()),
	logout: (): Promise<{ ok: boolean }> =>
		fetch("/auth/logout", { method: "POST" }).then((r) => r.json()),
};

// --------------------------- realtime (chat) --------------------------------

export interface ChatHandlers {
	onReady?: () => void;
	/** `agentId` is undefined/omitted for the main agent; a sub-agent's id otherwise. */
	onAgentStart?: (agentId?: string) => void;
	onMessageStart?: (m: WireMessage, agentId?: string) => void;
	onTextDelta?: (delta: string, agentId?: string) => void;
	onMessageEnd?: (m: WireMessage, agentId?: string) => void;
	onToolStart?: (e: { toolCallId: string; toolName: string; args: unknown; interactive?: boolean; agentId?: string }) => void;
	/**
	 * A running tool's partial update. Several producers, so every payload is
	 * optional: `pid` is a bash child's OS pid, `text` a sub-agent's live progress
	 * line or a workflow's snapshot, `progress` a workflow's structured steps.
	 */
	onToolUpdate?: (e: { toolCallId: string; toolName?: string; text?: string; pid?: number; progress?: WorkflowProgressWire; agentId?: string }) => void;
	onToolEnd?: (e: { toolCallId: string; toolName: string; isError: boolean; text: string; agentId?: string }) => void;
	/** Ask mode: a write-capable tool is awaiting the user's approval. */
	onToolApproval?: (e: { toolCallId: string; toolName: string; args: unknown }) => void;
	onTurnEnd?: (agentId?: string) => void;
	onAgentEnd?: (agentId?: string) => void;
	/** A sub-agent came into being (its stream frames carry its agentId). */
	onAgentSpawned?: (e: { agentId: string; parentAgentId?: string; kind: "main" | "dagRoot" | "dagSub" | "wfRoot"; label?: string; toolCallId?: string; name?: string; usage?: { inputTokens: number; outputTokens: number; messages: number } }) => void;
	/** An agent finished and will emit no more frames. */
	onAgentEnded?: (e: { agentId: string }) => void;
	/** Pending steer/followup queue depths for the main agent (toolbar counters). */
	onQueueState?: (steer: number, followup: number) => void;
	onError?: (message: string) => void;
	/** The session plan changed (model rewrote it, or a delegation moved a step). */
	onTodos?: (items: TodoItem[]) => void;
	/** Something worth seeing that is not a failure (e.g. a whole-tree rollback). */
	onNotice?: (message: string) => void;
	/** Side-channel: the session title changed (auto-generated or renamed). */
	onSessionMeta?: (title?: string) => void;
	/** The execution mode changed (another tab / REST call). */
	onModeChanged?: (mode: "plan" | "auto" | "ask") => void;
	/** CLI-backed (pty) sessions only: a chunk of raw terminal output. */
	onPtyData?: (data: string) => void;
	/** CLI-backed (pty) sessions only: the external CLI process exited. */
	onPtyExit?: (code: number | null) => void;
	onClose?: () => void;
}

export class ChatClient {
	private ws?: WebSocket;
	/** True after close() — an intentional close must not trigger reconnect. */
	private closed = false;
	private reconnectTimer = 0;
	private retries = 0;

	constructor(
		private readonly projectId: string,
		private readonly sessionId: string,
		private readonly h: ChatHandlers,
	) {}

	connect(): void {
		this.closed = false;
		this.open();
	}

	private open(): void {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${location.host}/chat`);
		this.ws = ws;
		ws.onopen = () => {
			this.retries = 0;
			this.send({ type: "hello", projectId: this.projectId, sessionId: this.sessionId });
		};
		ws.onmessage = (ev) => {
			let frame: ServerToClient;
			try {
				frame = JSON.parse(ev.data as string) as ServerToClient;
			} catch {
				return;
			}
			this.dispatch(frame);
		};
		// Auto-reconnect: the dev server restarts (tsx watch) or the network
		// blips — without this the UI stays dead (ready stuck false) until a
		// full page reload. Back off 1s → 2s → … capped at 10s; on reopen the
		// server replays the in-flight snapshot and re-sends `ready`, so the
		// page recovers its live state by itself.
		ws.onclose = () => {
			this.ws = undefined;
			this.h.onClose?.();
			if (this.closed) return;
			const delay = Math.min(1000 * 2 ** this.retries, 10_000);
			this.retries += 1;
			this.reconnectTimer = window.setTimeout(() => this.open(), delay);
		};
		ws.onerror = () => this.h.onError?.("websocket error");
	}

	/** `mode` only applies while the main agent streams: "steer" injects into
	 *  the running loop, "followup" queues for after it ends. */
	prompt(text: string, mode?: "steer" | "followup"): boolean {
		return this.send({ type: "prompt", text, ...(mode ? { mode } : {}) });
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	/** 转后台：把正在同步运行的 run_agent 子代理转为后台（结果之后以消息送达）。 */
	detachAgent(agentId: string): boolean {
		return this.send({ type: "detach_agent", agentId });
	}

	/** Ask mode: answer a pending tool approval. */
	decideTool(toolCallId: string, approved: boolean): void {
		this.send({ type: "tool_decision", toolCallId, approved });
	}

	/** CLI-backed (pty) sessions only: keystrokes/paste going to the terminal. */
	sendPtyInput(data: string): void {
		this.send({ type: "pty_input", data });
	}

	/** CLI-backed (pty) sessions only: the browser terminal's size changed. */
	sendPtyResize(cols: number, rows: number): void {
		this.send({ type: "pty_resize", cols, rows });
	}

	/**
	 * Switch this socket's agentId interest server-side (drill into one agent's
	 * stream / back to the whole session). The rich chat UI keeps interest
	 * undefined and routes frames client-side; this is for lightweight clients.
	 */
	setInterest(agentId?: string): void {
		this.send({ type: "subscribe", agentId });
	}

	close(): void {
		this.closed = true;
		window.clearTimeout(this.reconnectTimer);
		this.ws?.close();
		this.ws = undefined;
	}

	get readyState(): number {
		return this.ws?.readyState ?? WebSocket.CLOSED;
	}

	/** Send a frame. Returns false (without throwing) if the socket isn't open. */
	private send(frame: ClientToServer): boolean {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(frame));
			return true;
		}
		return false;
	}

	private dispatch(f: ServerToClient): void {
		switch (f.type) {
			case "ready":
				return this.h.onReady?.();
			case "agent_start":
				return this.h.onAgentStart?.(f.agentId);
			case "message_start":
				return this.h.onMessageStart?.(f.message, f.agentId);
			case "text_delta":
				return this.h.onTextDelta?.(f.delta, f.agentId);
			case "message_end":
				return this.h.onMessageEnd?.(f.message, f.agentId);
			case "tool_start":
				return this.h.onToolStart?.(f);
			case "tool_update":
				return this.h.onToolUpdate?.(f);
			case "tool_end":
				return this.h.onToolEnd?.(f);
			case "tool_approval":
				return this.h.onToolApproval?.(f);
			case "turn_end":
				return this.h.onTurnEnd?.(f.agentId);
			case "agent_end":
				return this.h.onAgentEnd?.(f.agentId);
			case "agent_spawned":
				return this.h.onAgentSpawned?.(f);
			case "agent_ended":
				return this.h.onAgentEnded?.(f);
			case "todos":
				return this.h.onTodos?.(f.items);
			case "notice":
				return this.h.onNotice?.(f.message);
			case "queue_state":
				return this.h.onQueueState?.(f.steer, f.followup);
			case "session_meta":
				return this.h.onSessionMeta?.(f.title);
			case "mode_changed":
				return this.h.onModeChanged?.(f.mode);
			case "error":
				return this.h.onError?.(f.message);
			case "pty_data":
				return this.h.onPtyData?.(f.data);
			case "pty_exit":
				return this.h.onPtyExit?.(f.code);
		}
	}
}
