/**
 * Wire protocol shared by the Express backend and the Preact WebUI.
 *
 * Kept dependency-free so the web bundle stays light. The server maps pi-agent-core's
 * {@link AgentMessage} into {@link WireMessage} at this boundary; the rest of the app
 * only ever sees these shapes.
 */

// ---------- content blocks ----------

export interface TextBlock {
	readonly type: "text";
	text: string;
}
export interface ImageBlock {
	readonly type: "image";
	data: string;
	mimeType: string;
}
export interface ToolCallBlock {
	readonly type: "toolCall";
	id: string;
	name: string;
	input: unknown;
}
export interface ThinkingBlock {
	readonly type: "thinking";
	text: string;
}
export interface ToolResultBlock {
	readonly type: "toolResult";
	toolCallId: string;
	content: (TextBlock | ImageBlock)[];
	isError?: boolean;
}

// ---------- messages (storage + wire) ----------

export interface UserMessage {
	role: "user";
	content: string | (TextBlock | ImageBlock)[];
	timestamp: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: (TextBlock | ToolCallBlock | ThinkingBlock)[];
	timestamp: number;
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}
export interface ToolResultMessage {
	role: "toolResult";
	content: ToolResultBlock[];
	timestamp: number;
}

export type WireMessage = UserMessage | AssistantMessage | ToolResultMessage;

// ---------- projects ----------

export interface ProjectConfig {
	/** pi-ai provider id, e.g. "anthropic" | "openai". */
	provider: string;
	/** Model id within that provider, e.g. "claude-sonnet-4-6". */
	model: string;
	/** Env var holding the API key. Falls back to provider defaults when unset. */
	apiKeyEnv?: string;
	/** Env var holding a custom base URL (proxies / gateways). */
	baseUrlEnv?: string;
	/** Directories to scan for SKILL.md skills (relative to project path or absolute). */
	skillsDirs: string[];
	/** Optional base system prompt prepended to the assembled prompt. */
	systemPrompt?: string;
	/** Named agent to run for sessions (default "system"). Overrides resolve to the built-ins. */
	agent?: string;
	/**
	 * Reasoning effort for the model, passed straight through to the provider:
	 * "off" (default) | "minimal" | "low" | "medium" | "high" | "xhigh" | "max".
	 * Off costs the least and is enough for most work; raising it buys deliberation
	 * on tasks where the first plausible answer is often the wrong one, at the cost
	 * of output tokens. `CLOWNFISH_THINKING` sets the default for new sessions.
	 */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/**
	 * Cross-session control (the assistant project): the session's agent gets the
	 * `sessions` / `session_send` / `session_read` tools, served over the
	 * worker→server session_control RPC. Flows into the worker spawn config.
	 */
	sessionControl?: boolean;
	/**
	 * Context-window budget in tokens. Caps the model's declared window (it can
	 * only shrink it — a window the model doesn't have cannot be granted) and
	 * drives auto-compaction. Takes effect on the session's next worker spawn.
	 */
	contextWindow?: number;
}

/** The context-window choices the settings UI offers, in tokens. */
export const CONTEXT_WINDOW_CHOICES = [128_000, 256_000, 512_000, 1_024_000] as const;

/**
 * The 我的助理 project — a synthetic, always-first record pinned above the real
 * projects. Not persisted in projects.json: injected by ProjectManager.list/get,
 * so every `ctx.projects.get(ASSISTANT_PROJECT_ID)` site works unchanged. Its
 * single session has the same fixed id, and its workspace is
 * `<dataDir>/workspace` (the same fallback cwd project-less spawns use).
 */
export const ASSISTANT_PROJECT_ID = "assistant";

export interface Project {
	id: string;
	name: string;
	/** Workspace directory the coding tools operate in (their cwd). */
	path: string;
	createdAt: number;
	updatedAt: number;
	config: ProjectConfig;
}

export interface CreateProjectBody {
	/** Defaults to the directory\'s basename. */
	name?: string;
	path: string;
	config?: Partial<ProjectConfig>;
}
export interface UpdateProjectBody {
	name?: string;
	config?: Partial<ProjectConfig>;
}

/** A filesystem path autocomplete suggestion for the project-creation form. */
export interface PathSuggestion {
	/** Full absolute path; directories include a trailing slash. */
	path: string;
	/** Display name — the final path segment. */
	name: string;
}

// ---------- sessions ----------

/**
 * How a session's agent actually runs. Absent/`builtin` = clownfish's own
 * agent loop (the default, unchanged behavior). `cli` hands the whole session
 * to an external CLI process (Codex, Claude Code, or anything else) under a
 * real pty, streamed byte-for-byte to an embedded terminal — clownfish does
 * not intercept its tool calls or manage its model/provider config, since the
 * CLI is assumed to already be configured (e.g. `codex login` done on the
 * host). `env` is the one knob clownfish adds on spawn (proxy vars etc.);
 * everything else is inherited from an allowlist, never the worker's full
 * credentialed environment. `label` is display-only (e.g. "Codex").
 *
 * `preset` identifies a known CLI (independent of the editable `label`) so a
 * REOPEN can resume instead of starting over: `started` flips true after the
 * first successful spawn, and from then on agent/manager.ts's `spawnCli`
 * appends that preset's own resume flags (`codex resume --last` /
 * `claude --continue`) instead of the bare command. A `custom` command has no
 * known resume convention and always launches plain.
 */
export type SessionBackend =
	| { kind: "builtin" }
	| { kind: "cli"; command: string; args?: string[]; env?: Record<string, string>; label?: string; preset?: "codex" | "claude"; started?: boolean };

export interface SessionMeta {
	id: string;
	projectId: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
	/** Defaults to `{kind:"builtin"}` when absent. */
	backend?: SessionBackend;
}

export interface CreateSessionBody {
	title?: string;
	backend?: SessionBackend;
}

export type Session = SessionMeta & { messages: WireMessage[] };

/** A page of a session transcript (most-recent-first window). */
export interface SessionPage extends SessionMeta {
	messages: WireMessage[];
	/** Total messages in the transcript. */
	total: number;
	/** Line index (0-based) of the oldest message in this page. */
	oldestIndex: number;
	/** Older messages exist beyond this page. */
	hasMore: boolean;
}


// ---------- execution-plan DAG (UI tree) ----------

/** A node in the session's execution-plan DAG (mirrors the worker's DagNode). */
export interface DagNodeWire {
	id: string;
	description: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	parentId: string | null;
	childIds: string[];
	/** Agent currently owning this node (== the agent whose stream drives it). */
	ownerAgent: string;
	mode: "inline" | "delegate";
	deps: string[];
	result?: string;
}
/** One plan tree (flat node map rooted at rootId). */
export interface DagTreeWire {
	id: string;
	rootId: string;
	ownerAgent: string;
	goal?: string;
	nodes: Record<string, DagNodeWire>;
}
/** Every plan in the session (the side panel renders each tree). null if none. */
export interface DagStateWire {
	dags: DagTreeWire[];
}

// ---------- realtime (WebSocket) ----------

export type ClientToServer =
	| { type: "hello"; projectId: string; sessionId: string; agentId?: string }
	| { type: "subscribe"; agentId?: string }
	/** `mode` only applies while the main agent streams: "steer" injects into the
	 *  running loop, "followup" queues for after it ends. Without it: plain prompt. */
	| { type: "prompt"; text: string; mode?: "steer" | "followup" }
	| { type: "abort" }
	/** 转后台：把正在同步运行的 run_agent 子代理转为后台（用户触发，非模型）。 */
	| { type: "detach_agent"; agentId: string }
	| { type: "tool_decision"; toolCallId: string; approved: boolean }
	/** CLI-backed (pty) sessions only: keystrokes/paste going to the terminal. */
	| { type: "pty_input"; data: string }
	/** CLI-backed (pty) sessions only: the browser terminal's size changed. */
	| { type: "pty_resize"; cols: number; rows: number };

/** One step of the session plan (see `agent/todo.ts`). */
export interface TodoItem {
	id: string;
	task: string;
	status: "pending" | "running" | "done" | "failed" | "stopped";
	/** Specialist a delegated step went to. */
	agent?: string;
	/** Working tree the delegation ran in (a git worktree, when fanned out). */
	cwd?: string;
	/** Path of that delegation's transcript. */
	transcript?: string;
	/** Short outcome note. */
	note?: string;
}

/** One cross-session memory entry, as listed and edited on the settings page. */
export interface MemoryInfo {
	name: string;
	kind: "preference" | "lesson";
	summary: string;
	/** Workspace path this entry is scoped to; absent = applies everywhere. */
	project?: string;
	updated: string;
	path: string;
	/** The raw `.md` file (frontmatter + body) the editor round-trips. */
	content: string;
}

// ---------- keybindings ----------

/**
 * Every rebindable UI action. Kept in the shared protocol because both the
 * settings editor and the chat page resolve the same table, and the server
 * validates against it.
 */
export const KEY_ACTIONS = [
	"send",
	"newline",
	"cycle-mode",
	"abort",
	"focus-composer",
	"new-session",
	"close-session",
	"next-session",
	"prev-session",
	"toggle-plan",
	"open-compact",
	"open-checkpoints",
	"open-settings",
	"open-projects",
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];

/**
 * Binding syntax: `Mod+Shift+K`. `Mod` is ⌘ on macOS and Ctrl elsewhere, so one
 * table fits both. The final segment is the key itself (`Enter`, `Tab`, `/`, `K`).
 */
export const DEFAULT_KEYBINDINGS: Record<KeyAction, string> = {
	send: "Enter",
	newline: "Shift+Enter",
	"cycle-mode": "Shift+Tab",
	abort: "Escape",
	"focus-composer": "Mod+/",
	"new-session": "Mod+Shift+N",
	"close-session": "Mod+Shift+W",
	"next-session": "Mod+Alt+ArrowDown",
	"prev-session": "Mod+Alt+ArrowUp",
	"toggle-plan": "Mod+Shift+P",
	"open-compact": "Mod+Shift+U",
	"open-checkpoints": "Mod+Shift+Z",
	"open-settings": "Mod+,",
	"open-projects": "Mod+Shift+O",
};

/** What each action does, shown next to its key in the settings list. */
export const KEY_ACTION_LABELS: Record<KeyAction, string> = {
	send: "发送消息",
	newline: "输入框内换行",
	"cycle-mode": "切换执行模式（auto → plan → ask）",
	abort: "中止当前回合",
	"focus-composer": "聚焦输入框",
	"new-session": "在当前项目新建会话",
	"close-session": "关闭当前会话标签",
	"next-session": "切到下一个会话",
	"prev-session": "切到上一个会话",
	"toggle-plan": "展开/收起计划面板",
	"open-compact": "查看压缩摘要",
	"open-checkpoints": "打开检查点 / 回滚",
	"open-settings": "打开设置",
	"open-projects": "回到项目列表",
};

/** One row of the settings page's shortcut list. */
export interface KeybindingInfo {
	action: KeyAction;
	/** Effective binding (override if present, else the default). */
	keys: string;
	/** The built-in binding a reset restores. */
	defaultKeys: string;
	label: string;
	/** True when the user has rebound it. */
	overridden: boolean;
	/** Another action bound to the same keys — the UI flags it. */
	conflictsWith?: KeyAction[];
}

/** Structured progress snapshot for a tool that runs several sub-agents
 *  (`run_agent`'s fan-out / `until` rounds, and the workflow script engine).
 *  Sent in full on every update — the UI replaces rather than patches.
 *  `agentId` (when known) makes a row clickable: it drills into that sub-agent. */
export interface WorkflowProgressWire {
	name: string;
	phases: string[];
	currentPhase?: string;
	logs: string[];
	agents: Array<{ label: string; phase?: string; status: "running" | "done" | "error"; preview?: string; agentId?: string }>;
}

export type ServerToClient =
	| { type: "ready" }
	| { type: "agent_start"; agentId?: string }
	| { type: "message_start"; message: WireMessage; agentId?: string }
	| { type: "text_delta"; delta: string; agentId?: string }
	| { type: "message_end"; message: WireMessage; agentId?: string }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown; interactive?: boolean; agentId?: string }
	/**
	 * Progress from a running tool. Two independent producers, hence the optional
	 * fields: `toolName`/`text` carry a sub-agent's live progress line, `pid` the
	 * OS pid of a bash child. A frame may carry either.
	 */
	| { type: "tool_update"; toolCallId: string; toolName?: string; text?: string; pid?: number; agentId?: string }
	| { type: "tool_update"; toolCallId: string; pid?: number; text?: string; progress?: WorkflowProgressWire; agentId?: string }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; text: string; agentId?: string }
	| { type: "turn_end"; agentId?: string }
	| { type: "agent_end"; agentId?: string }
	| { type: "todos"; items: TodoItem[] }
	| { type: "notice"; message: string }
	| { type: "error"; message: string }
	/** Ask mode: a write-capable tool is awaiting the user's approval. */
	| { type: "tool_approval"; toolCallId: string; toolName: string; args: unknown; agentId?: string }
	/** Side-channel: the session's title changed (e.g. auto-generated). Not part of the chat. */
	| { type: "session_meta"; title?: string }
	/** The session's execution mode changed (another tab / REST). Sync your picker. */
	| { type: "mode_changed"; mode: "plan" | "auto" | "ask" }
	/**
	 * A new agent exists in the session (the main agent, or a spawned
	 * dagRoot/dagSub/wfRoot). UIs may subscribe to its stream. Mirrors the
	 * worker `agent_spawned` frame.
	 */
	| {
			type: "agent_spawned";
			agentId: string;
			parentAgentId?: string;
			kind: "main" | "dagRoot" | "dagSub" | "wfRoot";
			label?: string;
			/** run_agent only: the tool call that spawned this sub (UI drill-down link). */
			toolCallId?: string;
			/** run_agent only: the sub's agent TYPE (e.g. "coder") — shown in the drill head. */
			name?: string;
			usage?: { inputTokens: number; outputTokens: number; messages: number };
		}
	/** An agent finished and will emit no more frames. Mirrors the worker `agent_ended` frame. */
	| { type: "agent_ended"; agentId: string }
	/** Pending steer/followup queue depths for the main agent (toolbar counters). */
	| { type: "queue_state"; steer: number; followup: number }
	/** CLI-backed (pty) sessions only: a chunk of raw terminal output (may include ANSI). */
	| { type: "pty_data"; data: string }
	/** CLI-backed (pty) sessions only: the external CLI process exited. */
	| { type: "pty_exit"; code: number | null };

// ---------- agent prompts (settings page) ----------

/**
 * One discovered agent prompt definition, as the settings page sees it.
 *
 * `content` is the whole `.md` file (frontmatter + body) — the editor round-trips
 * it verbatim. When `overridden` is true the effective file lives in
 * `<dataDir>/agent_overwrite/` and `base*` describe what a reset restores.
 */
export interface AgentPromptInfo {
	/** Agent name = the `.md` filename stem. */
	name: string;
	/** One-line role description from the frontmatter. */
	description?: string;
	/** Framework-internal agent (e.g. `sys-compact`) — not delegatable via run_agent. */
	internal: boolean;
	/** Tool access policy when run as a sub-agent: "R" read-only, "RW" all. */
	access?: "R" | "RW";
	/** The effective `.md` file verbatim. */
	content: string;
	/** Absolute path of the file that won. */
	path: string;
	/** Origin of the winning file: "builtin" | "global" | "project" | "plugin:<n>" | "override". */
	source: string;
	/** True when a copy-on-write override is what's in effect. */
	overridden: boolean;
	/** Origin/path/content a reset would restore. Absent for an override with no base. */
	baseSource?: string;
	basePath?: string;
	baseContent?: string;
}

/**
 * One tool's model-facing prompt surface, as listed and edited on the settings
 * page. `content` is the editable `.md` (frontmatter `snippet`/`guidelines` +
 * body = the schema description); `baseContent` is what a reset restores.
 */
export interface ToolPromptInfo {
	/** Tool name as the model calls it (e.g. "read", "run_agent"). */
	name: string;
	/** Capability mode: "R" read-only, "W" mutating, "RW" unrestricted. */
	mode: "R" | "W" | "RW";
	/** "all" = every agent incl. sub-agents, "main" = top-level agent only, "assistant" = only 我的助理. */
	scope: "all" | "main" | "assistant" | "dag";
	/** Description sent to the provider in the tool schema (after overrides). */
	description: string;
	/** One-line summary in the system prompt's tool index. */
	snippet?: string;
	/** Bullets appended under the tool's heading in the system prompt. */
	guidelines?: string[];
	/** The effective prompt as an editable `.md` file. */
	content: string;
	/** Absolute path of the override file, when one is in effect. */
	path?: string;
	/** "builtin" (defined in code) or "override". */
	source: string;
	/** True when a copy-on-write override is what's in effect. */
	overridden: boolean;
	/** The code-defined prompt a reset would restore. */
	baseContent: string;
	/**
	 * Pretty-printed JSON of exactly what the provider receives for this tool:
	 * `{name, description, input_schema}`. Read-only — the editor never writes it.
	 */
	schema?: string;
	/** Rough token cost of that schema (chars / 3.6). */
	schemaTokens?: number;
	/** Rough token cost of the prompt text (description + snippet + guidelines). */
	promptTokens?: number;
}

// ---------- cron (scheduled tasks) ----------

/** A scheduled job row for the cron listing (session jobs + internal tasks). */
export interface CronJobWire {
	key: string;
	sessionId: string;
	projectId: string;
	jobId: string;
	expr: string;
	name?: string;
	prompt: string;
	/** True for scheduler-internal tasks (e.g. nightly memory distill). */
	internal?: boolean;
	/** ms epoch of the next scheduled fire (undefined = not yet computed). */
	nextRun?: number;
	lastRun?: number;
	failures: number;
}

// ---------- cross-session memory ----------

/** One memory file (scope × category → markdown bullets). */
export interface MemoryBlockWire {
	scope: { kind: "global" } | { kind: "project"; projectId: string };
	category: "rules" | "style" | "facts" | "preferences" | "lessons";
	/** The raw `.md` file, which is also exactly what the model is shown. */
	body: string;
	/** The same content parsed into rows, so a UI can act on one entry. */
	entries: MemoryEntryWire[];
}

/** One memory line: `- [id] content (YYYY-MM-DD HH:MM:SS)`. */
export interface MemoryEntryWire {
	id: string;
	content: string;
	/** Local wall-clock stamp as written, to the second. */
	at: string;
}

// ---------- server config ----------

/** One admin-panel asset row (agent/skill/tool/plugin). */
export interface InventoryItemWire {
	name: string;
	description?: string;
	/** builtin | global | project | plugin:<name> | builtin-tool | mcp */
	source: string;
	path?: string;
	enabled: boolean;
	writable: boolean;
}
/** The admin panel's asset inventory for one project. */
export interface InventoryWire {
	agents: InventoryItemWire[];
	skills: InventoryItemWire[];
	tools: InventoryItemWire[];
	plugins: InventoryItemWire[];
}
/** A vim-style timestamped backup of an agent prompt / SKILL.md. */
export interface FileVersionWire {
	version: string;
	size: number;
}

export interface ServerConfig {
	/** Root data directory (default ~/.clownfish). */
	dataDir: string;
	/** Port the Express + WS server listens on. */
	port: number;
	/** Default provider/model for newly created projects (env-driven). */
	provider: string;
	model: string;
}
