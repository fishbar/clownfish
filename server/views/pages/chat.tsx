import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, ChatClient, type CheckpointInfo, type CompactSummaryInfo, type TodoItem } from "../api";
import { useGlobalKeys, useKeymap } from "../keymap";
import { StatusIcon, IconChain, IconBolt, IconDoc, IconWindow, IconTree, IconX, IconSpinner, type IconStatus } from "../icons";
import { MarkdownBody, DemoFrame, CodeBlock } from "../html-demo";
import type { DagNodeWire, DagStateWire, DagTreeWire, TextBlock, WireMessage, WorkflowProgressWire } from "../../protocol";

interface UserItem {
	kind: "user";
	text: string;
}
interface AssistantItem {
	kind: "assistant";
	text: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}
interface ToolItem {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	status: "pending" | "denied" | "running" | "ok" | "error";
	text: string;
	args?: unknown;
	/** Needs user interaction (approval / question) → rendered inline, never collapsed. */
	interactive?: boolean;
	/** workflow only: latest structured progress snapshot (steps + per-agent
	 *  status), streamed via tool_update — drives the drill-in view live. */
	progress?: WorkflowProgressWire;
}
type LogItem = UserItem | AssistantItem | ToolItem;

/** The ONE preview parked in the right dock (single slot — new previews
 *  replace the current one). Tool details re-resolve live from the log (so a
 *  running tool keeps updating in place); demos carry their URL. */
type DockItem =
	| { kind: "tool"; key: string; toolCallId: string }
	| { kind: "demo"; key: string; url: string };

/** Dock column width bounds (drag its left edge to resize). */
const DOCK_DEFAULT = 440;
const DOCK_MIN = 280;
const DOCK_MAX = 720;
const clampDockW = (w: number): number => Math.min(DOCK_MAX, Math.max(DOCK_MIN, w));

function textOf(content: WireMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("");
}

/** Convert a stored transcript to render items. */
function toLog(messages: WireMessage[]): LogItem[] {
	const out: LogItem[] = [];
	// Tool names + args live on the ASSISTANT message's toolCall block, not on
	// the toolResult — remember them so history rows carry the right name/args.
	const namesById = new Map<string, string>();
	const callsById = new Map<string, { name: string; input: unknown }>();
	for (const m of messages) {
		if (m.role === "user") out.push({ kind: "user", text: textOf(m.content) });
		else if (m.role === "assistant") {
			const t = textOf(m.content);
			if (t) out.push({ kind: "assistant", text: t, usage: m.usage });
			for (const b of m.content) {
				if (b.type === "toolCall") {
					namesById.set(b.id, b.name);
					callsById.set(b.id, { name: b.name, input: b.input });
				}
			}
		} else if (m.role === "toolResult") {
			for (const b of m.content) {
				const call = callsById.get(b.toolCallId);
				out.push({ kind: "tool", toolCallId: b.toolCallId, toolName: namesById.get(b.toolCallId) ?? "", status: b.isError ? "error" : "ok", text: textOf(b.content), args: call?.input });
			}
		}
	}
	return out;
}

interface ToolGroup { kind: "toolgroup"; tools: ToolItem[] }
interface InteractiveTool { kind: "interactive"; tool: ToolItem }
/** run_agent call: rendered as its OWN card outside the tool groups — it stands
 *  for a whole sub-agent conversation (click drills in), so it must be easy to
 *  spot in the message log. */
interface SubAgentCall { kind: "subagent"; tool: ToolItem }
/** workflow call: same idea — one card stands for a whole deterministic run
 *  (anchor agent + sub-agents), with live progress streamed into it. */
interface WorkflowCall { kind: "workflow"; tool: ToolItem }
type RenderUnit = UserItem | AssistantItem | ToolGroup | InteractiveTool | SubAgentCall | WorkflowCall;

/** One spawned sub-agent's live stream (drill-in view target). */
interface SubStream {
	agentId: string;
	/** From the agent_spawned frame (the delegated node's description). */
	label: string;
	/** "wfRoot" = a workflow run's anchor agent (folded into the tree's main row). */
	kind: "dagRoot" | "dagSub" | "wfRoot";
	parentAgentId?: string;
	/** run_agent only: the tool call that spawned this sub — lets the tool row drill into the stream. */
	toolCallId?: string;
	/** run_agent only: the sub's agent TYPE (e.g. "coder") — shown in the drill head. */
	name?: string;
	/** In-flight assistant text. */
	streaming: string;
	/** Finished assistant text + tool items, same shape as the main log. */
	log: LogItem[];
	ended: boolean;
	/** Worker-side token ledger seeded via agent_spawned (mid-run join / re-spawn). */
	usageSeed?: { inputTokens: number; outputTokens: number };
}

/** Registry entry for every agent that has spawned in this session. */
interface AgentInfo {
	agentId: string;
	label: string;
	kind: "main" | "dagRoot" | "dagSub" | "wfRoot";
	/** Persona / agent type (run_agent + workflow subs) — shown on drill rows. */
	name?: string;
	parentAgentId?: string;
	ended: boolean;
	/** The tool call that spawned this agent (run_agent / delegate / workflow).
	 *  LIVE TREE DEDUP: while this agent runs, its tool's own row is suppressed
	 *  — the agent row IS the tool (one activity, one node). */
	toolCallId?: string;
	/** Live per-agent token totals (seeded by agent_spawned, grown per message_end). */
	usage?: { inputTokens: number; outputTokens: number };
}

/** Coalesce consecutive non-interactive tool items into one collapsed group row.
 *  Interactive tools (need user feedback) break out and stay inline & expanded. */
function groupLog(items: LogItem[]): RenderUnit[] {
	const out: RenderUnit[] = [];
	let buf: ToolItem[] = [];
	const flush = (): void => {
		if (buf.length) {
			out.push({ kind: "toolgroup", tools: buf });
			buf = [];
		}
	};
	for (const it of items) {
		if (it.kind === "tool") {
			// run_agent stands for a sub-agent conversation, not a mere call —
			// break it out of the collapsed tool groups (own card, distinct style).
			if (it.toolName === "run_agent") {
				flush();
				out.push({ kind: "subagent", tool: it });
			} else if (it.toolName === "workflow") {
				// A workflow is a whole orchestrated run, not a mere call — same
				// treatment as run_agent: its own card, live progress inside.
				flush();
				out.push({ kind: "workflow", tool: it });
			} else if (it.interactive) {
				flush();
				out.push({ kind: "interactive", tool: it });
			} else {
				buf.push(it);
			}
		} else {
			flush();
			out.push(it);
		}
	}
	flush();
	return out;
}

/** Compact token count: 950 → 950, 1200 → 1.2k, 3.4M. */
function fmtTokens(n?: number): string {
	if (!n) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Streaming output estimate: word count × 0.8 (slightly under, so the real
 *  usage at message_end corrects UPWARD — the counter never jumps backwards). */
function estTokens(text: string): number {
	if (!text) return 0;
	const words = text.split(/\s+|(?<=[一-鿿])/).filter(Boolean).length;
	return Math.floor(words * 0.8);
}

/** Per-tool the argument key whose value makes the best one-line summary. */
const KEY_ARG: Record<string, string> = {
	read: "path",
	write: "path",
	edit: "path",
	ls: "path",
	bash: "command",
	grep: "pattern",
	find: "pattern",
	glob: "pattern",
	delegate: "node_id",
	run_agent: "task",
	plan: "",
	skill: "name",
};

/** meta.name out of a workflow tool's script argument (first `name: '…'` in the
 *  meta header) — the run's short identity, shown on cards and tree rows. */
function wfName(args: unknown): string {
	const script = (args as { script?: unknown } | undefined)?.script;
	if (typeof script !== "string") return "";
	const m = script.match(/name\s*:\s*['"`]([^'"`]+)['"`]/);
	return m ? m[1] : "";
}

/** One tool call's key-argument text: `path`/`command`/`pattern` style values,
 *  never raw JSON. Multi-line commands collapse to one line; falls back to the
 *  first short string arg. Length capping is CSS (ellipsis) — this stays raw. */
function argSummary(tool: ToolItem): string {
	const args = tool.args;
	if (!args || typeof args !== "object") return "";
	if (tool.toolName === "workflow") return wfName(args); // never the raw script
	const a = args as Record<string, unknown>;
	const pick = (key: string): string | undefined => {
		const v = a[key];
		if (typeof v !== "string" || !v) return undefined;
		const one = v.replace(/\s+/g, " ").trim(); // one line, CSS ellipses the rest
		return one || undefined;
	};
	const primary = KEY_ARG[tool.toolName];
	if (primary) {
		const v = pick(primary) ?? (tool.toolName === "ls" && a.all === true ? "(含隐藏)" : undefined);
		if (v) return v;
	}
	// Generic fallback: first short string argument.
	for (const [k, v] of Object.entries(a)) {
		if (typeof v === "string" && v && v.length <= 80 && k !== "context") return v.replace(/\s+/g, " ").trim();
	}
	return "";
}

interface Command {
	name: string;
	description: string;
	/**
	 * "command" runs locally; "skill" and "prompt" both send `/name [args]` as a
	 * prompt for the worker to expand — a skill from its SKILL.md, a prompt from a
	 * `commands/*.md` template.
	 */
	kind: "command" | "skill" | "prompt";
}
/** Plan step status → the shared status icon. */
const PLAN_STATUS: Record<TodoItem["status"], IconStatus> = {
	pending: "pending",
	running: "running",
	done: "ok",
	failed: "error",
	stopped: "cancelled",
};

/** The session plan: the model's steps plus the runtime's delegation ledger. */
function PlanPanel({ items, open, onToggle }: { items: TodoItem[]; open: boolean; onToggle: () => void }): preact.JSX.Element {
	const done = items.filter((i) => i.status === "done").length;
	const broken = items.some((i) => i.status === "failed");
	return (
		<div class="plan">
			<button type="button" class="plan-head" onClick={onToggle}>
				<span class={`plan-badge${broken ? " error" : ""}`}>计划</span>
				<span class="plan-progress">
					{done}/{items.length}
				</span>
				<span class="plan-current muted">
					{items.find((i) => i.status === "running")?.task ?? (done === items.length ? "全部完成" : "")}
				</span>
				<span class="plan-toggle">{open ? "收起" : "展开"}</span>
			</button>
			{open && (
				<ul class="plan-list">
					{items.map((i) => (
						<li key={i.id} class={`plan-item ${i.status}`}>
							<span class="plan-mark"><StatusIcon status={PLAN_STATUS[i.status]} /></span>
							<span class="plan-task">{i.task}</span>
							{i.agent && <span class="plan-meta">{i.agent}</span>}
							{i.cwd && (
								<span class="plan-meta" title={i.cwd}>
									{i.cwd.split("/").pop()}
								</span>
							)}
							{i.note && <span class="plan-note muted">{i.note}</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Built-in slash commands, shown when the input starts with `/`. */
const COMMANDS: Command[] = [
	{ name: "/plan", description: "Switch to Plan mode (read-only: investigate and propose a plan)", kind: "command" },
	{ name: "/auto", description: "Switch to Auto mode (tools run fully automatically)", kind: "command" },
	{ name: "/ask", description: "Switch to Ask mode (write tools need your approval)", kind: "command" },
	{ name: "/compact", description: "Fold older messages into a summary (shrink context)", kind: "command" },
];

export function ChatPage({
	projectId,
	sessionId,
	active = true,
}: {
	projectId: string;
	sessionId: string;
	/** Is this session's tab the active one? Gates the body.has-dock claim —
	 *  an inactive tab must not reserve the dock column for the active session. */
	active?: boolean;
}): preact.JSX.Element {
	const [log, setLog] = useState<LogItem[]>([]);
	const [streaming, setStreaming] = useState("");
	const [busy, setBusy] = useState(false);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string>();
	const [input, setInput] = useState("");
	const [compacting, setCompacting] = useState(false);
	const [notice, setNotice] = useState<string>();
	const [cmdIndex, setCmdIndex] = useState(0);
	// Right dock: every expanded preview (tool detail / HTML demo) parks here as
	// a stacked card — no close buttons; the arrow on each card's left edge
	// points at the row that opened it and follows chat scrolling. Only ids are
	// stored; live items are re-resolved on every render.
	const [dockItems, setDockItems] = useState<DockItem[]>([]);
	// Dock column width (drag its left edge; persisted, like the sidebar).
	const [dockW, setDockW] = useState<number>(() => {
		const saved = Number(localStorage.getItem("dock-w"));
		return Number.isFinite(saved) && saved >= DOCK_MIN && saved <= DOCK_MAX ? saved : DOCK_DEFAULT;
	});
	const dockResizing = useRef(false);
	const [mode, setMode] = useState<"plan" | "auto" | "ask">("auto");
	// Mid-run submission mode: "steer" (default) injects into the running loop,
	// "followup" queues until the run ends and starts a new one. Toolbar toggle.
	const [queueMode, setQueueMode] = useState<"steer" | "followup">("steer");
	// Pending queue depths reported by the worker (toolbar counters).
	const [queueCounts, setQueueCounts] = useState<{ steer: number; followup: number }>({ steer: 0, followup: 0 });
	const [skillCmds, setSkillCmds] = useState<Command[]>([]);
	/** Slash commands from `commands/*.md` (project, global, plugin). */
	const [fileCmds, setFileCmds] = useState<Command[]>([]);
	// The session plan. Seeded from REST (the worker is spawned lazily, so there
	// may be no live connection yet) and then kept current by `todos` frames.
	const [todos, setTodos] = useState<TodoItem[]>([]);
	const [planOpen, setPlanOpen] = useState(false);
	const [cpOpen, setCpOpen] = useState(false);
	const [cps, setCps] = useState<CheckpointInfo[]>([]);
	const [cpBusy, setCpBusy] = useState(false);
	const [sumOpen, setSumOpen] = useState(false);
	const [summary, setSummary] = useState<CompactSummaryInfo | null>(null);
	const [focused, setFocused] = useState(false);
	const [page, setPage] = useState<{ oldestIndex: number; hasMore: boolean } | undefined>();
	const [loadingMore, setLoadingMore] = useState(false);
	// Execution-plan DAG: side-panel tree (polled) + spawned sub-agent streams.
	const [subs, setSubs] = useState<Record<string, SubStream>>({});
	const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
	const [dag, setDag] = useState<DagStateWire | null>(null);
	// Drill stack for NESTED agents: [] = the main conversation, [id, id, …] =
	// the drilled-in chain (main → sub → sub-sub …). focusAgent = stack top.
	const [drillPath, setDrillPath] = useState<string[]>([]);
	const focusAgent = drillPath[drillPath.length - 1];
	// The deck: PARALLEL chat-main columns (main + one per drilled level) in a
	// clip. Navigation slides the strip with a CSS TRANSFORM transition —
	// compositor-only (no layout/paint per frame), percent-based (resize-proof,
	// no pixel retargeting), steerable mid-flight (a fast drill chain just
	// retargets the transition from wherever it is).
	//
	// Columns actually MOUNTED are `mountedPath`, which lags drillPath on the
	// way OUT: the levels just backed out of must stay mounted through the
	// slide or the strip collapses mid-animation (the old scrollLeft design
	// clamped instantly — the back slide never fired). Pruned on a short
	// debounce once navigation settles, so idle DOM stays bounded to the
	// visible column. Off-screen columns keep streaming regardless — the subs
	// record is the data source, not the DOM.
	const [mountedPath, setMountedPath] = useState<string[]>([]);
	useEffect(() => {
		// Growing (or equal): follow immediately. Shrinking: keep the longer
		// chain so the outgoing columns can slide away visibly.
		setMountedPath((prev) => (drillPath.length >= prev.length ? drillPath : prev));
		const t = setTimeout(() => setMountedPath(drillPath), 240);
		return () => clearTimeout(t);
	}, [drillPath]);
	/** Drill navigation: into a sub (push), already on the stack (truncate onto
	 *  it — a jump to an ancestor), undefined (back to the main conversation). */
	const drillTo = useCallback((agentId: string | undefined): void => {
		setDrillPath((prev) => {
			if (agentId === undefined) return [];
			const at = prev.indexOf(agentId);
			return at >= 0 ? prev.slice(0, at + 1) : [...prev, agentId];
		});
	}, []);
	/** Up one level (sub → its parent agent → … → main). */
	const drillBack = useCallback((): void => {
		setDrillPath((prev) => prev.slice(0, -1));
	}, []);
	// Session-wide activity monitor (floating panel over the chat column's
	// top-right): live agents + running tools, tree-assembled. Fed by frames —
	// tool_start/update/end and agent_spawned/ended (mid-run joins replay the
	// same frames via snapshot).
	const [liveTools, setLiveTools] = useState<Record<string, { toolCallId: string; toolName: string; argText: string; agentId?: string; startedAt: number; pid?: number }>>({});
	// Three-stage HUD: "open" (title + tree, default) / "title" (title bar
	// only) / "dot" (a breathing dot in the corner). Separate levers: the
	// caret on the title's right toggles the tree (open ↔ title), the – on
	// its left minimizes to the dot, the dot click-restores the full panel.
	const [livePanel, setLivePanel] = useState<"open" | "title" | "dot">("open");
	const toggleTreePanel = useCallback((): void => {
		setLivePanel((p) => (p === "open" ? "title" : "open"));
	}, []);
	const minimizePanel = useCallback((): void => setLivePanel("dot"), []);
	const restorePanel = useCallback((): void => setLivePanel("open"), []);
	const bottomRef = useRef<HTMLDivElement>(null);
	const messagesRef = useRef<HTMLDivElement>(null);
	const clientRef = useRef<ChatClient | null>(null);
	/** Texts submitted while busy (steer/followup). pi replays each drained
	 *  message as a user message_end — the row enters the log only THEN, not
	 *  optimistically at submit (the drain can be minutes away and a reload
	 *  would otherwise duplicate it via history). */
	const pendingQueuedRef = useRef<string[]>([]);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	/** The composer band (toolbar + textarea) — its height drives the messages
	 *  viewport through flex; observed 1:1 so the list follows focus growth. */
	const composerWrapRef = useRef<HTMLDivElement>(null);
	/** Empty session opened → focus the composer as soon as it's enabled. The
	 *  textarea is disabled until the WS is ready, so the focus itself waits for
	 *  `ready` (whichever of REST-load / ready-frame comes last). */
	const [focusOnReady, setFocusOnReady] = useState(false);

	/** Extract the /api/.../demos/<id> URL from a draw_demo result text. */
	const demoUrlFromText = (text: string): string | undefined => /\/api\/projects\/[^/\s]+\/sessions\/[^/\s]+\/demos\/[A-Za-z0-9_-]+/.exec(text)?.[0];
	/** Dock a preview card — SINGLE slot: a new preview replaces the current one. */
	const openDock = useCallback((item: DockItem): void => {
		setDockItems([item]);
	}, []);
	/** Open a demo in the dock. */
	const openDemo = useCallback((url: string): void => openDock({ kind: "demo", key: url, url }), [openDock]);
	/** Open a tool detail card in the dock. */
	const openTool = useCallback((toolCallId: string): void => openDock({ kind: "tool", key: toolCallId, toolCallId }), [openDock]);
	/** run_agent is not a plain tool row — it STANDS FOR a whole sub-agent
	 * conversation. Clicking drills into it (the sub's stream replaces the chat
	 * column, back button on top): live via the spawn frame's toolCallId link,
	 * historical via the persisted transcript's delegation prompt (matched
	 * against the call's task/context args). Falls back to the plain tool card
	 * when no sub exists (failed spawn / unknown type). */
	const drillRunAgent = useCallback(
		(t: ToolItem): void => {
			// Live sub spawned from this very call (seen in this tab, or a mid-run
			// join whose snapshot replayed the link).
			const live = Object.values(subs).find((s) => s.toolCallId === t.toolCallId);
			if (live) {
				drillTo(live.agentId);
				return;
			}
			// Ended sub, possibly after a reload. The worker persists each sub's
			// transcript with the delegation prompt as its first user message —
			// run_agent builds it from task/context PLUS an auto-appended parent
			// digest (run-agent-tool joins them with "\n\n"), so match the
			// task-part as an exact-or-prefix, not full equality.
			const a = (t.args ?? {}) as { type?: unknown; task?: unknown; context?: unknown };
			const type = typeof a.type === "string" ? a.type : undefined;
			const task = typeof a.task === "string" ? a.task : "";
			const context = typeof a.context === "string" && a.context.trim() ? a.context : undefined;
			const prompt = context ? `${task}\n\nContext:\n${context}` : task;
			if (!prompt) {
				openTool(t.toolCallId);
				return;
			}
			void (async (): Promise<void> => {
				try {
					const hit = (await api.listSubAgents(projectId, sessionId)).find((s) => s.prompt === prompt || s.prompt.startsWith(prompt + "\n\n"));
					if (!hit) {
						openTool(t.toolCallId);
						return;
					}
					const { messages } = await api.getSubAgent(projectId, sessionId, hit.agentId);
					setSubs((prev) => ({
						...prev,
						[hit.agentId]: { agentId: hit.agentId, label: task.slice(0, 60), kind: "dagSub", toolCallId: t.toolCallId, ...(type ? { name: type } : {}), streaming: "", log: toLog(messages), ended: true },
					}));
					drillTo(hit.agentId);
				} catch {
					openTool(t.toolCallId);
				}
			})();
		},
		[subs, projectId, sessionId, openTool, drillTo],
	);
	/** workflow is not a plain tool row either — it stands for a whole
	 *  orchestrated run (steps + sub-agents). Clicking drills into the run's
	 *  anchor agent (wfRoot, linked via the spawn frame's toolCallId), which
	 *  renders the WorkflowView. No live stream (reloaded tab / ended run) →
	 *  rebuild from the anchor transcript's durable run record via REST; runs
	 *  older than the record format fall back to the tool dock. */
	const drillWorkflow = useCallback(
		(t: ToolItem): void => {
			const live = Object.values(subs).find((s) => s.toolCallId === t.toolCallId && s.kind === "wfRoot");
			if (live) {
				drillTo(live.agentId);
				return;
			}
			const name = wfName(t.args);
			void (async (): Promise<void> => {
				try {
					// The anchor's first user message is the brief `Workflow "<name>": …`.
					// Same-name reruns share the prefix, so pick the anchor whose run
					// record's toolCallId matches THIS call.
					const anchors = (await api.listSubAgents(projectId, sessionId)).filter((s) => name && s.prompt.startsWith(`Workflow "${name}"`));
					let anchor: { agentId: string } | undefined;
					let rec: { toolCallId: string; progress?: WorkflowProgressWire; subs?: Array<{ id: string; label: string; name?: string }> } | undefined;
					for (const a of anchors) {
						const { messages } = await api.getSubAgent(projectId, sessionId, a.agentId);
						const raw = [...messages]
							.reverse()
							.map((m) => textOf(m.content))
							.find((txt) => txt.startsWith("[clownfish:workflow-run] "));
						if (!raw) continue;
						const parsed = JSON.parse(raw.slice("[clownfish:workflow-run] ".length)) as { toolCallId: string; progress?: WorkflowProgressWire; subs?: Array<{ id: string; label: string; name?: string }> };
						if (parsed.toolCallId === t.toolCallId) {
							anchor = a;
							rec = parsed;
							break;
						}
					}
					if (!anchor || !rec) {
						openTool(t.toolCallId);
						return;
					}
					// Load every sub's transcript (small fan-outs; sequential REST is fine).
					const streams: Record<string, SubStream> = {};
					const reg: Record<string, AgentInfo> = {};
					for (const s of rec.subs ?? []) {
						try {
							const { messages: sm } = await api.getSubAgent(projectId, sessionId, s.id);
							streams[s.id] = { agentId: s.id, label: s.label, kind: "dagSub", parentAgentId: anchor.agentId, toolCallId: t.toolCallId, ...(s.name ? { name: s.name } : {}), streaming: "", log: toLog(sm), ended: true };
							reg[s.id] = { agentId: s.id, label: s.label, kind: "dagSub", parentAgentId: anchor.agentId, ended: true, ...(s.name ? { name: s.name } : {}) };
						} catch {
							// transcript gone (retention) — the row simply doesn't come back
						}
					}
					streams[anchor.agentId] = { agentId: anchor.agentId, label: name || "workflow", kind: "wfRoot", toolCallId: t.toolCallId, streaming: "", log: [], ended: true };
					reg[anchor.agentId] = { agentId: anchor.agentId, label: name || "workflow", kind: "wfRoot", parentAgentId: sessionId, ended: true };
					setSubs((prev) => ({ ...prev, ...streams }));
					setAgents((prev) => ({ ...prev, ...reg }));
					// Surface the recovered steps on the tool item — drives the view.
					if (rec.progress) setLog((l) => l.map((it) => (it.kind === "tool" && it.toolCallId === t.toolCallId ? { ...it, progress: rec.progress } : it)));
					drillTo(anchor.agentId);
				} catch {
					openTool(t.toolCallId);
				}
			})();
		},
		[subs, projectId, sessionId, drillTo, openTool],
	);

	useEffect(() => {
		let cancelled = false;
		setReady(false);
		setBusy(false);
		setStreaming("");
		setError(undefined);
		setPage(undefined);
		setSubs({});
		setAgents({});
		setDag(null);
		setDrillPath([]);
		setDockItems([]);
		setLiveTools({});
		setLivePanel("open");
		setFocusOnReady(false);

		// Load the most recent transcript page first (paginated; older pages load
		// on scroll-up via loadMore).
		void (async (): Promise<void> => {
			try {
				const session = await api.getSession(projectId, sessionId);
				if (cancelled) return;
				setLog(toLog(session.messages));
				setPage({ oldestIndex: session.oldestIndex, hasMore: session.hasMore });
				// An EMPTY session opens with the composer focused — the next
				// action is always "type your prompt"; a session with history
				// competes with scroll-back reading instead.
				if (!session.messages.length) setFocusOnReady(true);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			}
		})();

		// Frame routing: the main agent's frames drive the primary log exactly as
		// before; a spawned sub-agent's frames (agentId set) go to its own live
		// stream, surfaced via the plan side panel → drill-in. One socket, everything
		// arrives (interest undefined) so switching views is instant and lossless.
		const isMain = (agentId?: string): boolean => !agentId || agentId === sessionId;
		const patchSub = (agentId: string, fn: (s: SubStream) => SubStream): void => {
			setSubs((prev) => {
				const cur: SubStream = prev[agentId] ?? { agentId, label: "sub-agent", kind: "dagSub", streaming: "", log: [], ended: false };
				return { ...prev, [agentId]: fn(cur) };
			});
		};
		const refreshDag = (): void => {
			void api
				.getDag(projectId, sessionId)
				.then((d) => {
					if (!cancelled) setDag(d);
				})
				.catch(() => undefined);
		};

		const client = new ChatClient(projectId, sessionId, {
			onReady: () => {
				setReady(true);
				// Sync the AUTHORITATIVE mode/busy from the server — the UI's local
				// state defaults to auto and would otherwise show the wrong mode for
				// every session that was switched earlier (or in another tab).
				void api
					.agentStatus(projectId, sessionId)
					.then((s) => {
						if (cancelled) return;
						if (s.mode === "plan" || s.mode === "auto" || s.mode === "ask") setMode(s.mode);
						setBusy(Boolean(s.busy));
						// Seed the tab's breathing light with the AUTHORITATIVE busy
						// state (a reconnect mid-turn must not lose the live dot).
						window.dispatchEvent(new CustomEvent("clownfish:tab-busy", { detail: { sessionId, busy: Boolean(s.busy) } }));
					})
					.catch(() => undefined);
			},
			onTodos: (items) => setTodos(items),
			onAgentStart: (agentId) => {
				if (isMain(agentId)) {
					setBusy(true);
					// Tab breathing light: tell the App shell this session is LIVE
					// (the tab strip lives in app.tsx, a different component tree).
					window.dispatchEvent(new CustomEvent("clownfish:tab-busy", { detail: { sessionId, busy: true } }));
					setError(undefined);
					// Register the main agent in the activity tree (it never emits
					// agent_spawned — this is its first frame each turn).
					setAgents((prev) =>
						prev[sessionId]
							? prev
							: { ...prev, [sessionId]: { agentId: sessionId, label: "main", kind: "main", parentAgentId: undefined, ended: false } },
					);
				} else {
					patchSub(agentId!, (s) => ({ ...s, ended: false }));
				}
			},
			onMessageStart: (_m, agentId) => {
				if (isMain(agentId)) setStreaming("");
				else patchSub(agentId!, (s) => ({ ...s, streaming: "" }));
			},
			onTextDelta: (delta, agentId) => {
				if (isMain(agentId)) setStreaming((prev) => prev + delta);
				else patchSub(agentId!, (s) => ({ ...s, streaming: s.streaming + delta }));
			},
			onMessageEnd: (m, agentId) => {
				if (isMain(agentId)) {
					// User-role end = pi drained a steer/followup message into the
					// loop. Match it against the pending queued sends (first text
					// match) and append the row only then — normal sends already
					// appended optimistically and must not duplicate.
					if (m?.role === "user") {
						const text = typeof m.content === "string" ? m.content : m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
						const idx = text ? pendingQueuedRef.current.indexOf(text) : -1;
						if (idx >= 0) {
							pendingQueuedRef.current = pendingQueuedRef.current.filter((_, i) => i !== idx);
							setLog((l) => [...l, { kind: "user", text }]);
						}
						return;
					}
					setStreaming((prev) => {
						if (prev) setLog((l) => [...l, { kind: "assistant", text: prev, usage: m && m.role === "assistant" ? m.usage : undefined }]);
						return "";
					});
				} else {
					patchSub(agentId!, (s) => {
						if (!s.streaming) return s;
						return { ...s, log: [...s.log, { kind: "assistant", text: s.streaming, usage: m && m.role === "assistant" ? m.usage : undefined }], streaming: "" };
					});
					// Per-agent token ledger for the activity tree (the sub's own
					// log rows already carry per-message usage — this is the sum).
					const u = m && m.role === "assistant" ? m.usage : undefined;
					if (u) {
						setAgents((prev) => {
							const a = prev[agentId!];
							if (!a) return prev;
							return { ...prev, [agentId!]: { ...a, usage: {
								inputTokens: (a.usage?.inputTokens ?? 0) + (u.inputTokens ?? 0),
								outputTokens: (a.usage?.outputTokens ?? 0) + (u.outputTokens ?? 0),
							} } };
						});
					}
				}
			},
			onToolStart: (e) => {
				// Session activity monitor: every running tool, whichever agent.
				const argText = argSummary({ kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, status: "running", text: "", args: e.args });
				setLiveTools((prev) => ({ ...prev, [e.toolCallId]: { toolCallId: e.toolCallId, toolName: e.toolName, argText, agentId: e.agentId, startedAt: Date.now() } }));
				if (isMain(e.agentId)) {
					setLog((l) => {
						// Ask mode: an approval card for this call already exists → run in place.
						const idx = l.findIndex((it) => it.kind === "tool" && it.toolCallId === e.toolCallId);
						if (idx >= 0 && l[idx].kind === "tool") {
							const prev = l[idx];
							const copy = [...l];
							copy[idx] = { ...prev, toolName: e.toolName || prev.toolName, status: "running", args: e.args };
							return copy;
						}
						return [...l, { kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, status: "running", text: "", args: e.args, interactive: e.interactive }];
					});
				} else {
					patchSub(e.agentId!, (s) => ({ ...s, log: [...s.log, { kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, status: "running", text: "", args: e.args }] }));
					// A sub-agent's ask-mode approval card lives in the MAIN log
					// (that's where the user answered it) — run it in place there
					// too, or the card stays "运行中…" forever after approval.
					setLog((l) => {
						const idx = l.findIndex((it) => it.kind === "tool" && it.toolCallId === e.toolCallId && it.interactive);
						if (idx < 0) return l;
						const prev = l[idx] as ToolItem;
						const copy = [...l];
						copy[idx] = { ...prev, toolName: e.toolName || prev.toolName, status: "running", args: e.args };
						return copy;
					});
				}
			},
			onToolUpdate: (e) => {
				// bash's child pid arrives after spawn — latch it onto the running entry.
				if (e.pid !== undefined) {
					setLiveTools((prev) => (prev[e.toolCallId] ? { ...prev, [e.toolCallId]: { ...prev[e.toolCallId], pid: e.pid } } : prev));
				}
				// workflow streams its progress as a full snapshot per update —
				// replace the tool item's text (the card renders it live) and its
				// structured twin (steps + agents, drives the drill-in view).
				if (e.text !== undefined || e.progress !== undefined) {
					setLog((l) => {
						const idx = l.findIndex((it) => it.kind === "tool" && it.toolCallId === e.toolCallId);
						if (idx < 0 || l[idx].kind !== "tool") return l;
						const copy = [...l];
						copy[idx] = { ...l[idx], ...(e.text !== undefined ? { text: e.text } : {}), ...(e.progress !== undefined ? { progress: e.progress } : {}) };
						return copy;
					});
				}
			},
			onToolEnd: (e) => {
				setLiveTools((prev) => {
					if (!(e.toolCallId in prev)) return prev;
					const { [e.toolCallId]: _gone, ...rest } = prev;
					return rest;
				});
				const apply = (it: ToolItem): ToolItem =>
					it.toolCallId === e.toolCallId
						? it.status === "denied"
							? it // a denied call keeps its verdict
							: { ...it, status: e.isError ? "error" : "ok", text: e.text, toolName: it.toolName || e.toolName }
						: it;
				if (isMain(e.agentId)) setLog((l) => l.map((it) => (it.kind === "tool" ? apply(it) : it)));
				else {
					patchSub(e.agentId!, (s) => ({ ...s, log: s.log.map((it) => (it.kind === "tool" ? apply(it) : it)) }));
					// Close the sub-agent's approval card in the main log (see onToolStart).
					setLog((l) => {
						const idx = l.findIndex((it) => it.kind === "tool" && it.toolCallId === e.toolCallId && it.interactive);
						if (idx < 0) return l;
						const prev = l[idx] as ToolItem;
						if (prev.status === "denied") return l; // keeps its verdict
						const copy = [...l];
						copy[idx] = { ...prev, status: e.isError ? "error" : "ok", text: e.text, toolName: prev.toolName || e.toolName };
						return copy;
					});
				}
				// A published demo arrives → open it in the right viewer (newest
				// wins; historical demos reopen via their link / tool row).
				if (e.toolName === "draw_demo" && !e.isError) {
					const url = demoUrlFromText(e.text);
					if (url) openDemo(url);
				}
			},
			// Ask mode: a write-capable tool is waiting for the user's decision — always
			// surfaces in the MAIN conversation (the user must act, whichever agent asked).
			onToolApproval: (e) => {
				setLog((l) => [...l, { kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, status: "pending", text: "", args: e.args, interactive: true }]);
				// The user must take over — this is the strongest notify signal there
				// is (the whole session is parked on their decision).
				window.dispatchEvent(new CustomEvent("clownfish:notify", {
					detail: { kind: "approval", projectId, sessionId, title: `等待确认:${e.toolName}`, body: `会话 ${sessionId.slice(0, 8)} 的工具 ${e.toolName} 请求批准`, source: "ws" },
				}));
			},
			onAgentEnd: (agentId) => {
				// Normalize: main's frames may carry agentId = sessionId or omit it.
				const key = isMain(agentId) ? sessionId : agentId!;
				if (isMain(agentId)) {
					setBusy(false);
					window.dispatchEvent(new CustomEvent("clownfish:tab-busy", { detail: { sessionId, busy: false } }));
					// Main agent finished its turn — the user can take over. Grab the
					// final text as the notification body (streaming state is cleared
					// in onMessageEnd, so read the log's last assistant entry).
					setLog((l) => {
						const last = [...l].reverse().find((it) => it.kind === "assistant" && it.text.trim());
						window.dispatchEvent(new CustomEvent("clownfish:notify", {
							detail: {
								kind: "turn_end",
								projectId,
								sessionId,
								title: "回合完成,可以接管",
								body: last && last.kind === "assistant" ? last.text.trim().slice(0, 120) : `会话 ${sessionId.slice(0, 8)} 完成了一轮工作`,
							source: "ws",
							},
						}));
						return l; // state read-only inside the updater — return unchanged
					});
					// Main never emits agent_spawned, so pair its agent_start registration
					// here: drop it from the activity tree (pill back to 0 when idle).
					setAgents((prev) => {
						if (!(key in prev)) return prev;
						const { [key]: _gone, ...rest } = prev;
						return rest;
					});
				} else {
					patchSub(agentId!, (s) => ({ ...s, ended: true, streaming: "" }));
					setAgents((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ended: true } } : prev));
				}
				// The agent is done — its tools can't still be running; drop strays
				// (main's tools carry agentId = sessionId, so match on the normalized key).
				setLiveTools((prev) => {
					const rest = Object.fromEntries(Object.entries(prev).filter(([, v]) => (v.agentId ?? sessionId) !== key));
					return Object.keys(rest).length === Object.keys(prev).length ? prev : rest;
				});
			},
			// A sub-agent came into being: register it, refresh the plans.
			onAgentSpawned: (e) => {
				// `usage` (mid-run join snapshot) seeds the token counter so the
				// ledger doesn't restart at zero for frames this tab missed.
				const seed = e.usage ? { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens } : undefined;
				setAgents((prev) => ({ ...prev, [e.agentId]: { agentId: e.agentId, label: e.label ?? "sub-agent", kind: e.kind, ...(e.name ? { name: e.name } : {}), parentAgentId: e.parentAgentId, ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}), ended: false, ...(seed ? { usage: seed } : {}) } }));
				patchSub(e.agentId!, (s) => ({ ...s, label: e.label ?? s.label, kind: e.kind === "main" ? "dagSub" : e.kind, parentAgentId: e.parentAgentId, toolCallId: e.toolCallId ?? s.toolCallId, name: e.name ?? s.name, ended: false, ...(seed ? { usageSeed: seed } : {}) }));
				refreshDag();
			},
			onAgentEnded: (e) => {
				setAgents((prev) => (prev[e.agentId] ? { ...prev, [e.agentId]: { ...prev[e.agentId], ended: true } } : prev));
				patchSub(e.agentId!, (s) => ({ ...s, ended: true }));
				refreshDag();
			},
			// Queue counters from the worker — drives the toolbar badges.
			onQueueState: (steer, followup) => setQueueCounts({ steer, followup }),
			// Side-channel title update (auto-generated by the worker on the first
			// prompt). Re-broadcast as a window event so the ProjectTree — a sibling
			// that owns the session list — can refresh just this session's label.
			onSessionMeta: (title) => {
				if (title) {
					window.dispatchEvent(new CustomEvent("clownfish:session-title", { detail: { projectId, sessionId, title } }));
				}
			},
			onError: (msg) => {
				setError(msg);
				setBusy(false);
			},
			// Mode changed elsewhere (another tab) — follow it.
			onModeChanged: (m) => setMode(m),
		});
		clientRef.current = client;
		client.connect();

		return () => {
			cancelled = true;
			client.close();
			clientRef.current = null;
		};
	}, [projectId, sessionId]);

	// Empty-session focus: fires on whichever lands LAST (REST empty-load, WS
	// ready) — the textarea is disabled until ready, so an earlier focus() is a no-op.
	useEffect(() => {
		if (ready && focusOnReady) {
			setFocusOnReady(false);
			inputRef.current?.focus();
		}
	}, [ready, focusOnReady]);

	// Project skills surface as `/skill-name` menu entries. Submitting them sends
	// the text as a normal prompt; the worker injects the skill body (no extra
	// LLM call for the model-driven skill tool).
	useEffect(() => {
		void api
			.listSkills(projectId)
			.then((list) => setSkillCmds(list.map((s) => ({ name: `/${s.name}`, description: s.description, kind: "skill" as const }))))
			.catch(() => undefined);
	}, [projectId]);

	// Slash commands from `commands/*.md` (project, global, plugin) join the same
	// menu. Like skills they submit as plain text; the worker expands the template.
	useEffect(() => {
		void api
			.listCommands(projectId)
			.then((list) =>
				setFileCmds(
					list.map((c) => ({
						name: `/${c.name}`,
						description: c.argumentHint ? `${c.description} — ${c.argumentHint}` : c.description,
						kind: "prompt" as const,
					})),
				),
			)
			.catch(() => undefined);
	}, [projectId]);

	// The plan is served over REST as well as the socket: a tab that opens a
	// session whose worker has not been spawned still renders it.
	useEffect(() => {
		void api
			.listTodos(projectId, sessionId)
			.then((items) => setTodos((current) => (current.length === 0 ? items : current)))
			.catch(() => undefined);
	}, [projectId, sessionId]);

	// Plan tree: fetch on mount and after each run; poll while a run is active
	// (DAG mutations — plan/delegate/update_node — land in the session's dag.json).
	// Plan tree: fetch on mount and after each run; poll while ANY agent is
	// driving (DAG mutations — plan/delegate/update_node — land in the session's
	// dag.json). An async workflow keeps mutating while the main agent is idle,
	// so the condition is main-busy OR any live sub-agent — otherwise a
	// background-only run would show a stale tree between spawn/end frames.
	const subsLive = Object.values(agents).some((a) => a.agentId !== sessionId && !a.ended);
	useEffect(() => {
		let stop = false;
		const tick = (): void => {
			void api
				.getDag(projectId, sessionId)
				.then((d) => {
					if (!stop) setDag(d);
				})
				.catch(() => undefined);
		};
		tick();
		if (!busy && !subsLive) return () => { stop = true; };
		const iv = setInterval(tick, 1500);
		return () => {
			stop = true;
			clearInterval(iv);
		};
	}, [projectId, sessionId, busy, subsLive]);

	// Load the next older transcript page and prepend it, preserving scroll position.
	const loadMore = useCallback(async (): Promise<void> => {
		if (!page || !page.hasMore || loadingMore) return;
		setLoadingMore(true);
		try {
			const prev = await api.getSession(projectId, sessionId, { before: page.oldestIndex });
			const el = messagesRef.current;
			const prevHeight = el?.scrollHeight ?? 0;
			const prevTop = el?.scrollTop ?? 0;
			setLog((l) => [...toLog(prev.messages), ...l]);
			setPage({ oldestIndex: prev.oldestIndex, hasMore: prev.hasMore });
			// Keep the user's viewport steady after the prepend.
			requestAnimationFrame(() => {
				if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoadingMore(false);
		}
	}, [page, loadingMore, projectId, sessionId]);

	// Stick-to-bottom autoscroll for the MAIN column (each drilled sub column
	// owns its own stick logic): follow new output ONLY while the user sits at
	// the bottom. Scrolling up to read history must win over streaming output.
	const stickRef = useRef(true);
	// Previous scrollTop, for direction-aware stickiness (see the onScroll below).
	const lastTopRef = useRef(0);
	useEffect(() => {
		// Instant jump (no smooth animation) — history load and new messages land
		// directly at the latest message; smooth scrolling felt sluggish.
		// scrollTop directly (not scrollIntoView) so the deck's horizontal
		// scroll position is never touched from here.
		if (!stickRef.current) return;
		const box = messagesRef.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [log, streaming]);

	// The composer band grows to half the column on focus (and collapses on
	// blur) — the flex layout resizes the messages viewport by exactly that
	// much. While the view is bottom-stuck, re-anchor to the bottom on every
	// band-height change so the newest messages stay glued to the composer's
	// top edge: on GROWTH that scrolls down by the band's delta (the covered
	// bottom re-enters view); on SHRINK the browser's own scrollTop clamp
	// already follows (scrolling up by the same delta), and this assignment is
	// the same target, never past it. Deliberately NOT a raw scrollTop += delta:
	// on shrink that would double-adjust past the bottom. A reader scrolled up
	// into history is untouched (stickRef false). ResizeObserver fires each
	// frame of the 0.2s height transition, so the anchor holds through the
	// animation, not just at its end.
	useEffect(() => {
		const wrap = composerWrapRef.current;
		if (!wrap || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => {
			if (!stickRef.current) return;
			const box = messagesRef.current;
			if (box) box.scrollTop = box.scrollHeight;
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	}, []);

	const send = (): void => {
		const text = input.trim();
		if (!text || !ready) return;
		if (busy) {
			// Mid-run submission → pi's queues, per the toolbar's mode pick:
			// steer injects into the running loop, followup starts a new loop
			// after it ends. The row appears when the worker DRAINS it (a user
			// message_end matching pendingQueuedRef), not at submit time.
			const ok = clientRef.current?.prompt(text, queueMode) ?? false;
			if (!ok) {
				setError("Not connected — message wasn't sent (your text is kept).");
				return;
			}
			setError(undefined);
			pendingQueuedRef.current = [...pendingQueuedRef.current, text];
			setNotice(queueMode === "steer" ? "已插入当前运行（steer）——消息将在本轮内生效。" : "已排队（followup）——当前运行结束后自动开新回合。");
			setInput("");
			return;
		}
		// Only clear the box once the message is actually on the wire — on failure
		// we keep the text so the user can retry without retyping.
		const ok = clientRef.current?.prompt(text) ?? false;
		if (!ok) {
			setError("Not connected — message wasn't sent (your text is kept).");
			return;
		}
		setError(undefined);
		// Sending always jumps the view to the bottom — the user's message leads
		// it, even if they had scrolled up into history first.
		stickRef.current = true;
		setLog((l) => [...l, { kind: "user", text }]);
		setInput("");
	};

	const abort = (): void => clientRef.current?.abort();

	/** 转后台 for a RUNNING run_agent call (user-triggered, never the model):
	 *  resolve the live sub's agentId via the spawn frame's toolCallId link and
	 *  send the detach command. Undefined → no button (call not running, sub not
	 *  yet spawned, or already background). */
	const detachFor = (t: ToolItem): (() => void) | undefined => {
		if (t.status !== "running") return undefined;
		const sub = Object.values(agents).find((a) => a.toolCallId === t.toolCallId && !a.ended);
		if (!sub) return undefined;
		return () => {
			clientRef.current?.detachAgent(sub.agentId);
			setNotice("已转入后台：任务继续运行，完成后结果会以 [async-agent] 消息送达。");
		};
	};

	// Switch the execution mode (plan/auto). Optimistic; reverts on failure.
	const changeMode = useCallback(
		async (m: "plan" | "auto" | "ask"): Promise<void> => {
			if (m === mode) return;
			const prev = mode;
			setMode(m);
			try {
				await api.setMode(projectId, sessionId, m);
			} catch (e) {
				setMode(prev);
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[mode, projectId, sessionId],
	);

	// Ask mode: send the user's approve/deny for a pending tool call; update the card.
	const decideTool = useCallback((toolCallId: string, approved: boolean): void => {
		clientRef.current?.decideTool(toolCallId, approved);
		setLog((l) =>
			l.map((it) =>
				it.kind === "tool" && it.toolCallId === toolCallId && it.status === "pending"
					? { ...it, status: approved ? "running" : "denied" }
					: it,
			),
		);
	}, []);

	// Checkpoints: list + restore (undo a turn's write/edit file mutations).
	const openCheckpoints = useCallback(async (): Promise<void> => {
		setCpOpen(true);
		try {
			setCps(await api.listCheckpoints(projectId, sessionId));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [projectId, sessionId]);

	const restoreCp = useCallback(
		async (seq: number): Promise<void> => {
			setCpBusy(true);
			try {
				const r = await api.restoreCheckpoint(projectId, sessionId, seq);
				setNotice(`已恢复检查点 #${seq}（${r.restored} 个文件）。`);
				setCps(await api.listCheckpoints(projectId, sessionId));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setCpBusy(false);
			}
		},
		[projectId, sessionId],
	);

	// The compaction record (running summary the model sees). The chat itself
	// always shows the ORIGINAL transcript; this is a separate read-only view.
	const openSummary = useCallback(async (): Promise<void> => {
		setSumOpen(true);
		try {
			setSummary(await api.getCompact(projectId, sessionId));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [projectId, sessionId]);

	// Per-session shortcuts, resolved from the operator's keybinding table. This
	// replaces a hardcoded Shift+Tab handler: the default binding for `cycle-mode`
	// IS Shift+Tab, so the Claude-Code muscle memory survives while the table adds
	// the other actions and lets any of them be rebound.
	const keymap = useKeymap();
	useGlobalKeys(keymap, {
		"cycle-mode": () => void changeMode(mode === "auto" ? "plan" : mode === "plan" ? "ask" : "auto"),
		abort: () => {
			if (busy) clientRef.current?.abort();
		},
		"focus-composer": () => inputRef.current?.focus(),
		"toggle-plan": () => setPlanOpen((v) => !v),
		"open-compact": () => void openSummary(),
		"open-checkpoints": () => void openCheckpoints(),
	});

	// Slash-command autocomplete: active only while the input starts with "/".
	const firstToken = input.trim().split(/\s+/)[0] ?? "";
	const cmdOpen = firstToken.startsWith("/") && input.length > 0;
	// Skills shadow same-named file commands here too, matching the worker's rule.
	const allCmds: Command[] = [...COMMANDS, ...skillCmds, ...fileCmds.filter((c) => !skillCmds.some((sk) => sk.name === c.name))];
	const cmdMatches: Command[] = cmdOpen ? allCmds.filter((c) => c.name.startsWith(firstToken)) : [];

	const runCommand = useCallback(
		async (cmd: Command): Promise<void> => {
			setCmdIndex(0);
			setNotice(undefined);
			// Mode commands reuse the select's switching flow.
			if (cmd.name === "/plan" || cmd.name === "/auto" || cmd.name === "/ask") {
				setInput("");
				await changeMode(cmd.name.slice(1) as "plan" | "auto" | "ask");
				return;
			}
			if (cmd.name === "/compact") {
				if (!ready || busy || compacting) return;
				setInput("");
				setCompacting(true);
				try {
					await api.compactSession(projectId, sessionId);
					setNotice("Context compacted.");
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setCompacting(false);
				}
				return;
			}
			// Skill menu entry (mouse click): behave EXACTLY like the Enter path —
			// an exact "/name" (+ optional task args) sends as a prompt; a partial
			// prefix just completes the name. Never silently drop the typed text.
			if (cmd.kind === "skill") {
				const t = input.trim();
				if (t === cmd.name || t.startsWith(cmd.name + " ")) send();
				else setInput(cmd.name + " ");
				return;
			}
			setInput("");
		},
		[changeMode, ready, busy, compacting, projectId, sessionId, input],
	);

	// Tool rows currently docked (highlight + pin when collapsed).
	const activeToolIds = new Set(dockItems.filter((d) => d.kind === "tool").map((d) => d.toolCallId));
	// Dock drag-resize (left edge handle): width persists like the sidebar's.
	useEffect(() => {
		const move = (ev: MouseEvent): void => {
			if (!dockResizing.current) return;
			setDockW(clampDockW(window.innerWidth - ev.clientX));
		};
		const up = (): void => {
			if (!dockResizing.current) return;
			dockResizing.current = false;
			document.body.classList.remove("resizing-col");
			setDockW((w) => {
				localStorage.setItem("dock-w", String(w));
				return w;
			});
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
		return () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
	}, []);

	// The preview half of the dock exists while something is parked in it.
	const dockOpen = dockItems.length > 0;

	// The dock is viewport-fixed (it must clear the tab bar, which spans the
	// middle column's top) — so the workspace reserves its width via a body
	// class + CSS var. The `active` prop (from the tab shell) gates the claim:
	// an inactive tab's effect holds no reservation, and switching tabs hands
	// it over cleanly.
	useEffect(() => {
		if (!active) return;
		if (!dockOpen) return;
		document.body.classList.add("has-dock");
		document.body.style.setProperty("--dock-w", `${dockW}px`);
		return () => {
			document.body.classList.remove("has-dock");
			document.body.style.removeProperty("--dock-w");
		};
	}, [active, dockOpen, dockW]);

	return (
		<div class="chat">
			<div class="chat-body">
				{/* The deck: the MAIN column plus one sibling chat-main per drilled
				    agent level, side by side in a clipped strip. Navigating the
				    drill stack slides the strip via transform (compositor-only);
				    outgoing columns stay mounted through the slide (mountedPath
				    lags drillPath) so backing up animates instead of collapsing. */}
				<div class="chat-deck">
				<div class="deck-strip" style={{ transform: `translateX(-${drillPath.length * 100}%)` }}>
				<div class="chat-main">
					<div
						class="messages"
						ref={messagesRef}
						onScroll={(e) => {
							const el = e.currentTarget;
							// Direction-aware stickiness: an UPWARD move is the user
							// trying to read history — break stick immediately, however
							// close to the bottom they were. Streaming output otherwise
							// lands faster than one wheel notch (~100px) can escape the
							// 140px "near bottom" window, yanking the view back down on
							// every delta — reported as "the conversation won't scroll".
							const up = el.scrollTop < lastTopRef.current - 2;
							lastTopRef.current = el.scrollTop;
							stickRef.current = !up && el.scrollHeight - el.scrollTop - el.clientHeight < 140;
							if (el.scrollTop < 40) void loadMore();
						}}
						onClick={(e) => {
							// Demo links (draw_demo URLs echoed in replies) open in the right
							// viewer instead of navigating — delegated, history included.
							const a = (e.target as HTMLElement).closest?.("a");
							const href = a?.getAttribute("href") ?? "";
							if (/^\/api\/projects\/[^/]+\/sessions\/[^/]+\/demos\/[A-Za-z0-9_-]+/.test(href)) {
								e.preventDefault();
								openDemo(href);
							}
						}}
					>
						{/* The MAIN conversation — always mounted (keeps streaming while
						    a drilled sub column is on screen). */}
						{loadingMore && <div class="muted small load-more">Loading older messages…</div>}
								{page?.hasMore && !loadingMore && <div class="muted small load-more">Scroll up for older messages</div>}
								{groupLog(log).map((u, i) => {
									if (u.kind === "toolgroup")
										return <ToolGroupRow key={i} tools={u.tools} onOpen={(t) => openTool(t.toolCallId)} activeId={activeToolIds} />;
									if (u.kind === "subagent")
										return <SubAgentCallRow key={i} tool={u.tool} onDrill={drillRunAgent} onDrillAgent={drillTo} onDetach={detachFor(u.tool)} active={activeToolIds.has(u.tool.toolCallId)} />;
									if (u.kind === "workflow")
										return <WorkflowCallRow key={i} tool={u.tool} onDrill={drillWorkflow} active={activeToolIds.has(u.tool.toolCallId)} />;
									if (u.kind === "interactive") return <InlineToolRow key={i} tool={u.tool} onDecision={decideTool} />;
									return <Row key={i} item={u} index={i} />;
								})}
								{streaming && (
									<div class="msg assistant">
										{/* Live markdown too — re-rendering per delta is fine (no memo); the
										    renderer tolerates unclosed fences, so mid-stream text is safe. */}
										<MarkdownBody text={streaming} />
									</div>
								)}
								{log.length === 0 && !streaming && <div class="muted empty">Send a message to start.</div>}
						<div ref={bottomRef} />
					</div>

					{/* Message minimap: one dash per user prompt, dock-magnify on
					    hover, click jumps. Rendered from the first user message. */}
					<MiniMap
						items={groupLog(log)
							.map((u, i) => ({ u, i }))
							.filter(({ u }) => u.kind === "user")
							.map(({ u, i }) => ({ index: i, text: (u as UserItem).text }))}
						onJump={(index) => {
							// Direct scrollTop assignment — NEVER scrollIntoView here:
							// it walks ancestor scrollers (and would fight any future
							// scroll animation); the deck no longer scrolls itself
							// (transform strip), so this targets the only scroller.
							const box = messagesRef.current;
							const el = document.getElementById(`usermsg-${index}`);
							if (!box || !el) return;
							box.scrollTop = el.offsetTop - 8;
							stickRef.current = false;
						}}
					/>

					{error && <div class="error">{error}</div>}

			{/* The session plan sits directly above the composer: it is what the run
			    is working through, so it belongs next to where you steer it. */}
			{todos.length > 0 && <PlanPanel items={todos} open={planOpen} onToggle={() => setPlanOpen((v) => !v)} />}

			<div class="composer-wrap" ref={composerWrapRef}>
				{cmdOpen && cmdMatches.length > 0 && (
					<div class="cmd-menu" role="listbox">
						{cmdMatches.map((c, i) => (
							<div
								key={c.name}
								class={"cmd-item" + (i === cmdIndex ? " active" : "")}
								role="option"
								onMouseEnter={() => setCmdIndex(i)}
								onMouseDown={(e) => {
									e.preventDefault(); // keep focus on the textarea
									void runCommand(c);
								}}
							>
								<span class="cmd-name">{c.name}</span>
								<span class="cmd-desc">{c.description}</span>
							</div>
						))}
					</div>
				)}
				<div
					class={"composer-box" + (focused ? " focused" : "")}
					onMouseDown={(e) => {
						// The toolbar is part of the input area: working its buttons
						// must not collapse the composer. In WebKit a button click
						// doesn't MOVE focus to the button — it blurs the textarea to
						// body — so keep focus where it is instead (buttons still
						// click normally). The mode select is exempt: it needs real
						// focus to open, and the blur handler below keeps the box
						// expanded while the focus stays inside it.
						const t = e.target as HTMLElement;
						if (t.closest(".composer-toolbar") && !t.closest("select")) e.preventDefault();
					}}
				>
					<div class="composer-toolbar">
						<select
							class="mode-select"
							value={mode}
							disabled={!ready || busy}
							// Bare mode names in the list; the explanation rides on
							// this hover tip instead (Shift+Tab still cycles).
							title={
								mode === "plan"
									? "Plan · 只读规划（Shift+Tab 切换）"
									: mode === "auto"
										? "Auto · 自动执行（Shift+Tab 切换）"
										: "Ask · 写操作需审批（Shift+Tab 切换）"
							}
							onChange={(e) => void changeMode((e.target as HTMLSelectElement).value as "plan" | "auto" | "ask")}
						>
							<option value="plan">Plan</option>
							<option value="auto">Auto</option>
							<option value="ask">Ask</option>
						</select>
						{/* Queue mode for mid-run sends: steer (default, lit) injects into
						    the running loop; followup queues for a fresh loop after it.
						    Badges = pending depth reported by the worker. */}
						<div class="qm-toggle" title="运行中发送的行为:steer 插入当前运行的 loop;followup 等本轮结束后再开新 loop。徽标数为排队中的消息数。">
							<button
								type="button"
								class={"qm-btn" + (queueMode === "steer" ? " on" : "")}
								title="steer:插入正在进行的 loop(下一个 assistant 回合前生效)"
								onClick={() => setQueueMode("steer")}
							>
								<IconBolt /> steer
								{queueCounts.steer > 0 && <span class="qm-n">{queueCounts.steer}</span>}
							</button>
							<button
								type="button"
								class={"qm-btn" + (queueMode === "followup" ? " on" : "")}
								title="followup:当前 loop 结束后才发送,开启新回合"
								onClick={() => setQueueMode("followup")}
							>
								⏳ followup
								{queueCounts.followup > 0 && <span class="qm-n">{queueCounts.followup}</span>}
							</button>
						</div>
						<button
							type="button"
							class="cp-btn"
							title="检查点 / 回滚（agent 每轮写改文件的改动前快照）"
							onClick={() => void openCheckpoints()}
						>
							↩ 检查点
						</button>
						<button
							type="button"
							class="cp-btn"
							title="压缩摘要（模型实际看到的上下文摘要；聊天始终显示原始消息）"
							onClick={() => void openSummary()}
						>
							<IconDoc /> 摘要
						</button>
						{(() => {
							const total = log.reduce<{ i: number; o: number }>(
								(acc, it) => (it.kind === "assistant" && it.usage ? { i: acc.i + (it.usage.inputTokens ?? 0), o: acc.o + (it.usage.outputTokens ?? 0) } : acc),
								{ i: 0, o: 0 },
							);
							// While the model streams, its output isn't in the log yet —
							// show a live word-count estimate (×0.8, corrected by real
							// usage at message_end).
							const live = streaming ? estTokens(streaming) : 0;
							return (
								(total.i > 0 || live > 0) && (
									<span class="token-usage" title="本次会话累计 token（↑输入 ↓输出；流式中为估算值）">
										↑{fmtTokens(total.i)} ↓{fmtTokens(total.o + live)}{live > 0 ? "~" : ""}
									</span>
								)
							);
						})()}
					</div>
					<form
						class="composer"
					onSubmit={(e) => {
						e.preventDefault();
						const exact = COMMANDS.find((c) => c.name === input.trim());
						if (exact) void runCommand(exact);
						else send();
					}}
				>
					{notice && <div class="notice">{notice}</div>}
				<textarea
					ref={inputRef}
					class={focused ? "focused" : ""}
					// enterkeyhint="send" labels the mobile keyboard's enter key "Send".
					enterkeyhint="send"
					autoCapitalize="sentences"
					placeholder={compacting ? "Compacting…" : ready ? "Message Clownfish…  (type / for commands)" : "Connecting…"}
					value={input}
					disabled={!ready || compacting}
					onFocus={(e) => {
						setFocused(true);
						// Focused height = HALF OF CHAT-MAIN, measured here: a %
						// height can't resolve through the auto-height chain
						// (wrap→box→composer), so bake it into --focus-h (CSS
						// fallback 50dvh only fires pre-measure).
						const main = (e.target as HTMLTextAreaElement).closest(".chat-main");
						if (main) e.currentTarget.style.setProperty("--focus-h", `${Math.round(main.clientHeight / 2)}px`);
					}}
					onBlur={(e) => {
						// Collapse only when focus leaves the WHOLE composer box:
						// the toolbar (mode select, checkpoints, …) belongs to the
						// input area, so focus landing inside the box is "still
						// typing". Checked after a tick — the click's focus move
						// lands after the blur.
						const box = e.currentTarget.closest(".composer-box");
						requestAnimationFrame(() => {
							const active = document.activeElement;
							if (!(box && active && box.contains(active))) setFocused(false);
						});
					}}
					onInput={(e) => {
						setInput((e.target as HTMLTextAreaElement).value);
						setCmdIndex(0);
						setNotice(undefined);
					}}
					onKeyDown={(e) => {
						// Ignore keys while an IME is composing (e.g. pinyin candidate selection):
						// the Enter that confirms a candidate must not trigger send / command run.
						if (e.isComposing || e.keyCode === 229) return;
						if (cmdOpen && cmdMatches.length > 0) {
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setCmdIndex((i) => (i + 1) % cmdMatches.length);
								return;
							}
							if (e.key === "ArrowUp") {
								e.preventDefault();
								setCmdIndex((i) => (i - 1 + cmdMatches.length) % cmdMatches.length);
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								const sel = cmdMatches[cmdIndex % cmdMatches.length];
								if (sel.kind === "command") {
									void runCommand(sel);
								} else {
									// Skill: exact name or args already typed → send (worker injects);
									// a partial prefix → complete the name so the user can add a task.
									const t = input.trim();
									if (t === sel.name || t.startsWith(sel.name + " ")) send();
									else setInput(sel.name + " ");
								}
								return;
							}
							if (e.key === "Tab" && !e.shiftKey) {
								e.preventDefault();
								setInput(cmdMatches[cmdIndex % cmdMatches.length].name + " ");
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setInput("");
								return;
							}
						}
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
				/>
				{busy && (
					<div class="composer-actions">
						<button type="button" class="danger" onClick={abort}>
							Stop
						</button>
					</div>
				)}
					</form>
				</div>
				</div>
			</div>
				{mountedPath.map((id, di) => {
					const s = subs[id];
					return (
						<div class="chat-main sub-col" key={id}>
							{s ? (
								s.kind === "wfRoot" ? (
									<WorkflowView sub={s} tool={log.find((it): it is ToolItem => it.kind === "tool" && it.toolCallId === s.toolCallId)} agents={agents} depth={di + 1} onBack={drillBack} onDrill={drillTo} />
								) : (
									<SubAgentView sub={s} ledger={agents[id]?.usage} depth={di + 1} onBack={drillBack} onOpen={(t) => openTool(t.toolCallId)} />
								)
							) : (
								<div class="muted small" style="padding: 14px">加载 sub-agent 对话…</div>
							)}
						</div>
					);
				})}
				</div>
				</div>

			{sumOpen && (
				<div class="drawer-overlay">
					<div class="drawer-backdrop" onClick={() => setSumOpen(false)} />
					<aside class="drawer">
						<header class="drawer-head">
							<span class="drawer-title">压缩摘要{summary ? `（前 ${summary.offset} 条消息的折叠）` : ""}</span>
							<button type="button" class="drawer-close" onClick={() => setSumOpen(false)}>
								<IconX />
							</button>
						</header>
						<div class="drawer-body">
							{summary ? (
								<pre class="summary-pre">{summary.summary}</pre>
							) : (
								<div class="muted">尚未压缩。使用 /compact 或等上下文接近上限时自动压缩。</div>
							)}
						</div>
					</aside>
				</div>
			)}

			{cpOpen && (
				<div class="drawer-overlay">
					<div class="drawer-backdrop" onClick={() => setCpOpen(false)} />
					<aside class="drawer">
						<header class="drawer-head">
							<span class="drawer-title">检查点 / 回滚</span>
							<button type="button" class="drawer-close" onClick={() => setCpOpen(false)}>
								<IconX />
							</button>
						</header>
						<div class="drawer-body">
							{cps.length === 0 && <div class="muted">暂无检查点 —— agent 修改文件后按轮自动生成。</div>}
							{cps.map((cp) => (
								<div key={cp.seq} class="cp-item">
									<div class="cp-item-head">
										<span class="cp-seq">#{cp.seq}</span>
										<span class="cp-time">{new Date(cp.ts).toLocaleString()}</span>
										<button type="button" class="cp-restore" disabled={cpBusy} onClick={() => void restoreCp(cp.seq)}>
											恢复
										</button>
									</div>
									<div class="cp-files">
										{cp.entries.map((e) => (
											<div key={e.rel} class="cp-file">
												{e.created ? "＋ " : "↩ "}
												{e.rel}
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					</aside>
				</div>
			)}

			{/* Right dock — the THIRD COLUMN, viewport-fixed so it clears the tab
			    bar (which spans the middle column's top). Devoted entirely to the
			    ONE current preview (tool detail or HTML demo — new previews
			    replace; the activity monitor moved to the floating LivePanel over
			    the chat column). The workspace reserves the dock's width via
			    body.has-dock/--dock-w. */}
			{dockOpen && (
				<aside class="dock" style={{ width: `${dockW}px` }}>
					<button
						type="button"
						class="dock-close"
						title="关闭右侧面板"
						onClick={() => {
							setDockItems([]);
						}}
					>
						<IconX />
					</button>
					<div
						class="dock-resizer"
						title="拖动调宽（双击恢复默认）"
						onDblClick={() => {
							setDockW(DOCK_DEFAULT);
							localStorage.setItem("dock-w", String(DOCK_DEFAULT));
						}}
						onMouseDown={() => {
							dockResizing.current = true;
							document.body.classList.add("resizing-col");
						}}
					/>
					{(() => {
						const d = dockItems[0];
							if (d.kind === "demo")
								return (
									<div class="dock-scroll single">
										<DockDemoCard url={d.url} />
									</div>
								);
							// Re-resolve the live item from whichever log holds it (main or
							// the focused sub-agent) so status/output stay current.
							const source = focusAgent && subs[focusAgent] ? subs[focusAgent].log : log;
							const live = source.find((it) => it.kind === "tool" && it.toolCallId === d.toolCallId);
							return (
								<div class="dock-scroll single">
									{live && live.kind === "tool" ? (
										<DockToolCard tool={live} />
									) : (
										// Item paginated out / session switch: placeholder card.
										<div class="dock-card gone" id={`dock-card-${d.key}`}>
											<div class="dock-card-head">
												<span class="tool-name muted">tool</span>
												<span class="tool-status muted">已不在当前加载的记录里</span>
											</div>
										</div>
									)}
								</div>
							);
						})()}
			</aside>
			)}
			</div>

			{/* Floating activity HUD — anchored to .chat (the FULL row, not the
			    width-capped .chat-main), so it parks in the freed space beside the
			    chat column, outside the 780px cap. */}
			<LivePanel
				agents={agents}
				tools={liveTools}
				sessionId={sessionId}
				dag={dag}
				state={livePanel}
				onToggleTree={toggleTreePanel}
				onMinimize={minimizePanel}
				onRestore={restorePanel}
				onDrill={drillTo}
			/>
		</div>
	);
}

/** Dock card: a draw_demo preview — fills the dock's preview slot. */
function DockDemoCard({ url }: { url: string }): preact.JSX.Element {
	return (
		<div class="dock-card demo-card" id={`dock-card-${url}`} data-anchor={url}>
			<div class="dock-card-head">
				<span class="tool-name"><IconWindow /> HTML Demo</span>
				<span class="dock-card-url" title={url}>{url}</span>
			</div>
			<DemoFrame url={url} />
		</div>
	);
}

/** `index` = the RenderUnit index (groupLog order — tool groups collapse, so
 *  this is NOT the raw log index). Given only in the MAIN column: it anchors
 *  the row for the minimap's scroll jumps (`usermsg-<i>`); sub columns omit it
 *  so duplicate ids never appear across deck columns. */
function Row({ item, index }: { item: UserItem | AssistantItem; index?: number }): preact.JSX.Element {
	if (item.kind === "user") {
		return (
			<div class="msg user" id={index !== undefined ? `usermsg-${index}` : undefined}>
				<div class="bubble">{item.text}</div>
			</div>
		);
	}
	return (
		<div class="msg assistant">
			{/* Agent output is markdown — render the safe subset (see markdown.ts). */}
			<MarkdownBody text={item.text} />
			{item.usage && (item.usage.inputTokens || item.usage.outputTokens) ? (
				<div class="msg-usage">↑{fmtTokens(item.usage.inputTokens)} ↓{fmtTokens(item.usage.outputTokens)}</div>
			) : undefined}
		</div>
	);
}

/** Codex-style message minimap: one 1px dash per USER message, floating at
 *  the LEFT-MIDDLE of the main message list. Each dash lives in a tall
 *  transparent HIT ZONE — the visible bar is just a 1px slit centered in the
 *  zone — and zones tile edge-to-edge, so the trigger area spans the full row
 *  pitch and sliding in from an adjacent node never crosses a dead gap.
 *  Hover runs a CONTINUOUS macOS-Dock magnification: every zone's scale is a
 *  gaussian of the cursor's pixel distance to that zone's vertical center —
 *  max exactly at a center, decaying smoothly as the cursor offsets, with
 *  neighbors swelling symmetrically (normal-curve profile across the rail).
 *  A click jumps the scroll so that message lands at the top of the view.
 *  The rail sits in the list's left padding gutter — it never covers bodies. */
function MiniMap({ items, onJump }: { items: Array<{ index: number; text: string }>; onJump: (index: number) => void }): preact.JSX.Element | null {
	const [hover, setHover] = useState(-1);
	const railRef = useRef<HTMLDivElement>(null);
	const hitEls = useRef<Array<HTMLDivElement | null>>([]);
	const pitchRef = useRef(7);

	// Anchor the rail to the MESSAGES box, not chat-main: the list is the
	// region the dashes map to, and chat-main also spans the composer band
	// (which would shove the rail out of the list's center). Vars land on the
	// rail element; the zone pitch shrinks when dashes outnumber the list
	// height. A ResizeObserver re-anchors on window/list resizes.
	useEffect(() => {
		const rail = railRef.current;
		const list = rail?.parentElement?.querySelector<HTMLElement>(".messages");
		if (!rail || !list) return;
		const measure = (): void => {
			rail.style.setProperty("--mm-top", `${list.offsetTop}px`);
			rail.style.setProperty("--mm-h", `${list.clientHeight}px`);
			const fit = (list.clientHeight - 16) / Math.max(1, items.length);
			pitchRef.current = Math.max(3, Math.min(7, fit));
			rail.style.setProperty("--pitch", `${pitchRef.current}px`);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(list);
		return () => ro.disconnect();
	}, [items.length]);

	// Show from the FIRST user prompt (a single dash is still a visible
	// affordance + tooltip; hiding until 2 made the rail look broken on
	// fresh sessions).
	if (items.length < 1) return null;

	// scale_i = 1 + AMP·exp(−d²/2σ²), d = cursor's pixel distance to zone i's
	// vertical center, σ ≈ one pitch. Written straight to the DOM (--s per
	// zone) at mousemove rate — no re-render churn; the only state tracked is
	// the NEAREST zone, which drives the tooltip (text + --y position).
	const applyScales = (clientY: number): void => {
		const sigma = Math.max(6, pitchRef.current * 0.95);
		let near = -1;
		let nearD = Infinity;
		hitEls.current.forEach((el, i) => {
			if (!el) return;
			const r = el.getBoundingClientRect();
			const d = clientY - (r.top + r.height / 2);
			el.style.setProperty("--s", (1 + 1.2 * Math.exp(-(d * d) / (2 * sigma * sigma))).toFixed(3));
			if (Math.abs(d) < nearD) {
				nearD = Math.abs(d);
				near = i;
			}
		});
		if (near >= 0 && near !== hover) {
			setHover(near);
			const rail = railRef.current;
			const el = hitEls.current[near];
			if (rail && el) rail.style.setProperty("--y", `${el.offsetTop + el.offsetHeight / 2}px`);
		}
	};
	const resetScales = (): void => {
		hitEls.current.forEach((el) => el?.style.setProperty("--s", "1"));
		setHover(-1);
	};

	return (
		<div class="minimap" ref={railRef} onMouseMove={(e) => applyScales(e.clientY)} onMouseLeave={resetScales}>
			{items.map((it, i) => (
				<div
					key={it.index}
					class="mm-hit"
					ref={(el) => {
						hitEls.current[i] = el;
					}}
					onClick={() => onJump(it.index)}
				>
					<div class="mm-dash" />
				</div>
			))}
			{hover >= 0 && items[hover] && (
				<div class="mm-tip">{items[hover].text.replace(/\s+/g, " ").trim().slice(0, 120)}</div>
			)}
		</div>
	);
}

/** One block for consecutive tool calls: every call is its own row — tool name
 *  label first, then the key-argument text (never raw JSON). Click a row → the
 *  detail panel slides out alongside the chat list. */
/** Blocks with more calls than this collapse to the LAST N (newest) + a
 *  "show all" bar on top (older entries unfold upward from beneath it). */
const TOOL_BLOCK_PREVIEW = 5;

function ToolGroupRow({
	tools,
	onOpen,
	activeId,
}: {
	tools: ToolItem[];
	onOpen: (t: ToolItem, anchor: string) => void;
	activeId?: Set<string>;
}): preact.JSX.Element {
	// >5 calls → preview the NEWEST 5, the older ones fold behind a TOP bar
	// ("… 展开 N" / "收起" — clicking unfolds upward: older entries appear
	// above the visible tail). A running or selected call always stays
	// visible (pinned after the tail).
	const [expanded, setExpanded] = useState(false);
	const collapsible = tools.length > TOOL_BLOCK_PREVIEW && !expanded;
	const visible = (() => {
		if (!collapsible) return tools;
		const tail = tools.slice(-TOOL_BLOCK_PREVIEW);
		const tailIds = new Set(tail.map((t) => t.toolCallId));
		const mustShow = tools.filter(
			(t) => !tailIds.has(t.toolCallId) && (t.status === "running" || activeId?.has(t.toolCallId)),
		);
		return [...tail, ...mustShow];
	})();
	const hidden = tools.length - visible.length;
	return (
		<div class="msg tool">
			<div class="tool-block">
				{tools.length > TOOL_BLOCK_PREVIEW && (
					<button type="button" class="tool-row more" onClick={() => setExpanded(!expanded)}>
						<span class="tr-status" />
						<span class="tr-more">{expanded ? "收起" : `… 展开 ${hidden} 个`}</span>
						<span class="tr-count">{tools.length} 次调用</span>
					</button>
				)}
				{visible.map((t) => (
					<div
						key={t.toolCallId}
						id={`tool-row-${t.toolCallId}`}
						class={"tool-row" + (t.status === "error" ? " errored" : "") + (activeId?.has(t.toolCallId) ? " active" : "")}
						onClick={() => onOpen(t, t.toolCallId)}
					>
						<span class={`tr-status ${t.status === "error" ? "err" : t.status}`}>
							<StatusIcon status={t.status === "running" ? "running" : t.status === "error" ? "error" : t.status === "pending" || t.status === "denied" ? "pending" : "ok"} />
						</span>
						<span class="tr-name">{t.toolName || "tool"}</span>
						<span class="tr-arg" title={argSummary(t)}>{argSummary(t)}</span>
					</div>
				))}
			</div>
		</div>
	);
}

/** run_agent call as its own card: distinct from tool rows (left accent bar +
 *  tinted background) so it's easy to find in the message log. Click drills
 *  into the sub-agent conversation. */
function SubAgentCallRow({
	tool,
	onDrill,
	onDrillAgent,
	onDetach,
	active,
}: {
	tool: ToolItem;
	onDrill: (t: ToolItem) => void;
	/** Drill straight into one row's sub-agent (fan-out strand / verify round). */
	onDrillAgent?: (agentId: string) => void;
	onDetach?: () => void;
	active?: boolean;
}): preact.JSX.Element {
	const a = (tool.args ?? {}) as { type?: unknown };
	const type = typeof a.type === "string" ? a.type : "";
	const task = argSummary(tool); // KEY_ARG: run_agent → task (first line)
	// The tool streams either a structured snapshot (fan-out / until rounds) or
	// a single "type · N step(s) · bash: …" line; both arrived before and were
	// dropped on the floor — the card showed nothing until the run finished.
	const rows = tool.progress?.agents ?? [];
	const live = tool.status === "running" ? tool.text : undefined;
	return (
		<div class="msg">
			<div
				id={`tool-row-${tool.toolCallId}`}
				class={"sub-call" + (tool.status === "error" ? " error" : "") + (active ? " active" : "")}
				onClick={() => onDrill(tool)}
				title="点击进入该 sub-agent 的完整对话"
			>
				<span class="sc-kind">
					SubAgent:{type || "?"}
				</span>
				<span class="sc-task">{task || "(无任务描述)"}</span>
				{/* 转后台（仅同步运行中）：不再阻塞本轮对话，任务继续跑，结果之后以 [async-agent] 消息送达 */}
				{onDetach && (
					<button
						type="button"
						class="sc-detach"
						title="转后台：任务继续运行，不再阻塞对话；结果完成后以消息送达"
						onClick={(e) => {
							e.stopPropagation(); // don't drill — the click is a detach
							onDetach();
						}}
					>
						⤓ 转后台
					</button>
				)}
				<span class={`sc-status ${tool.status === "error" ? "err" : tool.status}`} title={tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "已完成"}>
					<StatusIcon status={tool.status === "running" ? "running" : tool.status === "error" ? "error" : "ok"} />
				</span>
				<span class="sc-go">›</span>
			</div>
			{/* Multi-row runs (a `tasks` fan-out, or `until` rounds) get the full
			    block — one row per sub-agent, each a drill link. A plain single
			    delegation gets the one live line it streams. */}
			{rows.length > 1 ? (
				<div class="sc-progress">
					{tool.progress?.currentPhase && <div class="sc-phase">{tool.progress.currentPhase}</div>}
					{rows.map((r, i) => (
						<div
							key={i}
							class={"sc-step" + (r.agentId ? " link" : "")}
							title={r.agentId ? "点击进入该 sub-agent 的完整对话" : undefined}
							onClick={(e) => {
								if (!r.agentId || !onDrillAgent) return;
								e.stopPropagation(); // drill the STRAND, not the whole call
								onDrillAgent(r.agentId);
							}}
						>
							<StatusIcon status={r.status === "running" ? "running" : r.status === "error" ? "error" : "ok"} />
							<span class="sc-step-label">{r.label}</span>
							{r.preview && <span class="sc-step-preview">{r.preview}</span>}
						</div>
					))}
				</div>
			) : (
				live && <div class="sc-progress one">{live}</div>
			)}
		</div>
	);
}

/** workflow call as its own card: ⛓ + meta name + live progress (streamed in
 *  full snapshots via tool_update text — header line "workflow x (1/3 agents,
 *  phase: …)" plus a per-agent status list). Click drills into the run's
 *  WorkflowView (steps + spawned agents); no live stream → tool dock. */
function WorkflowCallRow({ tool, onDrill, active }: { tool: ToolItem; onDrill: (t: ToolItem) => void; active?: boolean }): preact.JSX.Element {
	const name = wfName(tool.args);
	const lines = tool.text ? tool.text.split("\n") : [];
	const header = lines[0] ?? "";
	const detail = lines.slice(1).join("\n");
	return (
		<div class="msg">
			<div
				id={`tool-row-${tool.toolCallId}`}
				class={"wf-call" + (tool.status === "error" ? " error" : "") + (active ? " active" : "")}
				onClick={() => onDrill(tool)}
				title="点击查看执行步骤与拉起的 agent"
			>
				<div class="wf-head">
					<span class="wf-kind"><IconChain /></span>
					<span class="wf-name">{name || "workflow"}</span>
					<span class={`sc-status ${tool.status === "error" ? "err" : tool.status}`} title={tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "已完成"}>
						<StatusIcon status={tool.status === "running" ? "running" : tool.status === "error" ? "error" : "ok"} />
					</span>
					<span class="sc-go">›</span>
				</div>
				{header && <div class="wf-progress">{header}</div>}
				{detail && <pre class="wf-detail">{detail}</pre>}
			</div>
		</div>
	);
}

/** An interactive tool rendered INLINE & expanded — it needs the user's feedback. */
function InlineToolRow({ tool, onDecision }: { tool: ToolItem; onDecision: (toolCallId: string, approved: boolean) => void }): preact.JSX.Element {
	const args = tool.args === undefined ? "" : JSON.stringify(tool.args, null, 2);
	const statusLabel =
		tool.status === "pending"
			? "等待你的反馈…"
			: tool.status === "denied"
				? "已拒绝"
				: tool.status === "running"
					? "运行中…"
					: tool.status === "ok"
						? "完成"
						: "失败";
	return (
		<div class={`msg tool interactive ${tool.status}`}>
			<div class="inline-tool">
				<div class="inline-tool-head">
					<span class="tool-name">{tool.toolName || "tool"}</span>
					<span class="tool-status">{statusLabel}</span>
				</div>
				{args && <pre class="tool-args-full">{args}</pre>}
				{tool.text && (looksLikeCode(tool.text) ? (
					<div class="md-scope">
						<CodeBlock text={tool.text} langHint={toolOutLang(tool.toolName, tool.text)} />
					</div>
				) : (
					<pre class="tool-out-full">{tool.text}</pre>
				))}
				{tool.status === "pending" && (
					<div class="inline-tool-actions">
						<button type="button" class="approve" onClick={() => onDecision(tool.toolCallId, true)}>
							批准
						</button>
						<button type="button" class="deny" onClick={() => onDecision(tool.toolCallId, false)}>
							拒绝
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

/** Stringify a single argument value for the kv grid (arrays/objects get
 *  pretty-printed, everything else rendered as-is — not raw JSON of the whole args). */
function argValueText(v: unknown): string {
	if (typeof v === "string") return v;
	if (v === null || v === undefined) return "";
	if (typeof v === "object") return JSON.stringify(v, null, 2);
	return String(v);
}

/** Does a tool's text output LOOK like code / file content (vs prose or a
 *  compact status line)? Cheap signals, no guessing games: brace/indent
 *  structure, code punctuation density, or a JSON/diff shape. Used to decide
 *  whether the output pane renders as a highlighted CodeBlock. */
function looksLikeCode(text: string): boolean {
	const t = text.trim();
	if (t.length < 24) return false; // short status lines stay plain
	if (/^\[[{}[]/.test(t)) return true; // JSON-ish
	if (/^@@ -\d+,\d+ \+\d+,\d+ @@/m.test(t) || /^diff --git /m.test(t)) return true; // diff
	const lines = t.split("\n");
	if (lines.length < 2) {
		// One long line: only treat as code with heavy code punctuation.
		return /[;{}()=<>]/.test(t) && (t.match(/[;{}()=<>]/g)?.length ?? 0) > t.length / 12;
	}
	// Multi-line: indented lines or code-line endings on most lines → code.
	const codey = lines.filter((l) => /^\s{2,}\S/.test(l) || /[;{}]\s*$/.test(l) || /^\s*(\/\/|#|--)\s/.test(l)).length;
	return codey / lines.length > 0.4;
}

/** Language hint for a tool-output CodeBlock: known tool → fixed lang;
 *  otherwise let the highlighter guess from content. */
function toolOutLang(toolName: string, text: string): string {
	if (toolName === "bash" || toolName === "shell") return /@@|diff --git/.test(text) ? "diff" : "";
	if (["grep", "find", "ls"].includes(toolName)) return "";
	if (/^\s*[{[]/.test(text) && /"[^"]+"\s*:/.test(text)) return "json";
	return "";
}

/** Full tool-call detail rendered inside the side panel: args as a kv grid,
 *  output as scrollable text. */
function ToolDetail({ tool }: { tool: ToolItem }): preact.JSX.Element {
	const entries =
		tool.args && typeof tool.args === "object" && !Array.isArray(tool.args)
			? Object.entries(tool.args as Record<string, unknown>)
			: tool.args === undefined || tool.args === null
				? []
				: [["(参数)", tool.args]];
	return (
		<div class={`tool-detail ${tool.status}`}>
			<div class="tool-section">
				<div class="tool-section-label">参数</div>
				{entries.length === 0 ? (
					<div class="muted small">无参数</div>
				) : (
					<dl class="kv-grid">
						{entries.map(([k, v]) => (
							<div class="kv-row" key={k}>
								<dt>{k}</dt>
								<dd>{argValueText(v)}</dd>
							</div>
						))}
					</dl>
				)}
			</div>
			{tool.text ? (
				<div class="tool-section">
					<div class="tool-section-label">输出</div>
					{/* md-scope: the code-block styles (bg, line numbers, token
					    colors) are scoped to markdown contexts — without it the
					    highlighted CodeBlock renders unstyled here. */}
					{looksLikeCode(tool.text) ? (
						<div class="md-scope">
							<CodeBlock text={tool.text} langHint={toolOutLang(tool.toolName, tool.text)} />
						</div>
					) : (
						<pre class="tool-out-full">{tool.text}</pre>
					)}
				</div>
			) : (
				tool.status !== "running" && <div class="tool-section muted small">无输出</div>
			)}
		</div>
	);
}

/** One drilled sub-agent column: a slim head (triangle back icon + the sub's
 *  name and task) pinned at the column's TRUE top, then the sub's own
 *  scrollable conversation. Lives as a sibling chat-main in the deck, so the
 *  head can never leak content sliding underneath it. */
/** Workflow run drill-in: the script's execution steps (live) + every agent the
 *  run spawned (each drillable into its own conversation) + the final result.
 *  Steps come from the tool item's structured progress (tool_update frames,
 *  replaced wholesale per update); agents come from the session registry keyed
 *  on parentAgentId (Record insertion order = spawn order). */
function WorkflowView({
	sub,
	tool,
	agents,
	depth,
	onBack,
	onDrill,
}: {
	sub: SubStream;
	/** The workflow tool call this run hangs off (progress + status + result text). */
	tool?: ToolItem;
	agents: Record<string, AgentInfo>;
	/** Drill depth (1 = directly under the main conversation) — the back tooltip. */
	depth?: number;
	onBack: () => void;
	/** Drill into one of the run's sub-agents (renders its SubAgentView). */
	onDrill: (agentId: string | undefined) => void;
}): preact.JSX.Element {
	const p = tool?.progress;
	const running = tool?.status === "running";
	const done = p ? p.agents.filter((a) => a.status !== "running").length : 0;
	const wfAgents = Object.values(agents).filter((a) => a.parentAgentId === sub.agentId);
	return (
		<div class="sub-view wf-view">
			<div class="sub-head">
				<button type="button" class="sub-back" onClick={onBack} title={(depth ?? 1) <= 1 ? "返回主对话" : "返回上级"} aria-label={(depth ?? 1) <= 1 ? "返回主对话" : "返回上级"}>
					◀
				</button>
				<span class="sub-label" title={sub.label}>
					<span class="sub-name"><IconChain /> Workflow</span>
					{sub.label ? ` ${sub.label}` : ""}
				</span>
				<span class={"sc-status " + (running ? "running" : tool?.status === "error" ? "err" : "ok")} title={running ? "运行中" : tool?.status === "error" ? "失败" : "已完成"}>
					<StatusIcon status={running ? "running" : tool?.status === "error" ? "error" : "ok"} />
				</span>
			</div>
			<div class="messages sub-messages">
				<div class="wf-sec-label">执行步骤{p ? `（${done}/${p.agents.length}）` : ""}</div>
				{p ? (
					<>
						{p.phases.length > 0 && (
							<div class="wf-phases">
								{p.phases.map((ph) => (
									<span key={ph} class={"wf-phase" + (running && ph === p.currentPhase ? " current" : "")}>
										{running && ph === p.currentPhase ? "▶" : "·"} {ph}
									</span>
								))}
							</div>
						)}
						{p.agents.map((a, i) => (
							<div key={`${a.label}-${i}`} class={"wf-step " + a.status} title={a.preview ?? a.label}>
								<span class="wf-step-ic"><StatusIcon status={a.status === "running" ? "running" : a.status === "done" ? "ok" : "error"} /></span>
								<span class="wf-step-label">{a.label}</span>
								{a.phase && <span class="wf-step-phase">{a.phase}</span>}
								{a.preview && <span class="wf-step-preview">{a.preview}</span>}
							</div>
						))}
						{p.logs.length > 0 && <pre class="wf-logs">{p.logs.slice(-5).join("\n")}</pre>}
					</>
				) : (
					<div class="muted small" style="padding: 6px 2px">
						（无步骤快照 —— 重载后的历史 run 仅保留结果文本）
					</div>
				)}
				<div class="wf-sec-label">拉起的 Agent（{wfAgents.length}）</div>
				{wfAgents.length === 0 && (
					<div class="muted small" style="padding: 6px 2px">
						（无该 run 的 agent 记录 —— 可能是早于 run 档案格式的旧 run）
					</div>
				)}
				{wfAgents.map((a) => (
					<button type="button" key={a.agentId} class="wf-agent" onClick={() => onDrill(a.agentId)} title="点击查看该 agent 的完整对话">
						<span class={"wf-step-ic " + (a.ended ? "ok" : "run")}><StatusIcon status={a.ended ? "ok" : "running"} /></span>
						<span class="wf-agent-name">{a.name && a.name !== "workflow-sub" ? `${a.name} · ` : ""}{a.label}</span>
						<span class="sc-go">›</span>
					</button>
				))}
				{!running && tool?.text && (
					<>
						<div class="wf-sec-label">结果</div>
						<pre class="wf-result">{tool.text}</pre>
					</>
				)}
			</div>
		</div>
	);
}

function SubAgentView({
	sub,
	ledger,
	depth,
	onBack,
	onOpen,
}: {
	sub: SubStream;
	/** Authoritative per-agent ledger (seeded by agent_spawned, grown per
	 *  message_end). Preferred over seed+log: a WS reconnect re-seeds with the
	 *  worker's CUMULATIVE total while `log` still holds pre-disconnect
	 *  messages — summing both would double-count. */
	ledger?: { inputTokens: number; outputTokens: number };
	/** Drill depth (1 = directly under the main conversation) — the back
	 *  tooltip: at depth 1 it returns to the MAIN conversation, deeper it
	 *  climbs one agent level. */
	depth?: number;
	onBack: () => void;
	onOpen: (t: ToolItem, anchor: string) => void;
}): preact.JSX.Element {
	// Stick-to-bottom within this column (mirrors the main column's rule):
	// follow the stream only while the user sits at the bottom.
	const stick = useRef(true);
	// Previous scrollTop — same direction-aware unstick as the main column.
	const lastTop = useRef(0);
	const endRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!stick.current) return;
		// scrollTop DIRECTLY (not scrollIntoView): scrollIntoView also scrolls
		// EVERY scrollable ancestor on the inline axis — it would yank the deck
		// sideways and kill the drill slide animation.
		const box = endRef.current?.parentElement;
		if (box) box.scrollTop = box.scrollHeight;
	}, [sub.log, sub.streaming]);
	return (
		<div class="sub-view">
			<div class="sub-head">
				<button
					type="button"
					class="sub-back"
					onClick={onBack}
					title={(depth ?? 1) <= 1 ? "返回主对话" : "返回上级 agent"}
					aria-label={(depth ?? 1) <= 1 ? "返回主对话" : "返回上级 agent"}
				>
					◀
				</button>
				<span class="sub-label" title={sub.label}>
					{sub.name ? <span class="sub-name">SubAgent:{sub.name}</span> : <span class="sub-name">SubAgent</span>}
					{sub.label ? ` ${sub.label}` : ""}
				</span>
				{(() => {
					// Prefer the registry ledger (reconnect-safe); fall back to
					// seed (mid-run join) + this tab's streamed messages.
					const tot: { i: number; o: number } = ledger
						? { i: ledger.inputTokens, o: ledger.outputTokens }
						: sub.log.reduce<{ i: number; o: number }>(
								(acc, it) => (it.kind === "assistant" && it.usage ? { i: acc.i + (it.usage.inputTokens ?? 0), o: acc.o + (it.usage.outputTokens ?? 0) } : acc),
								{ i: sub.usageSeed?.inputTokens ?? 0, o: sub.usageSeed?.outputTokens ?? 0 },
							);
					return tot.i > 0 ? (
						<span class="sub-usage" title="该 agent 累计 token（↑输入 ↓输出）">
							↑{fmtTokens(tot.i)} ↓{fmtTokens(tot.o)}
						</span>
					) : null;
				})()}
				{/* Same status glyph language as the run_agent row: ✓ ended, ×
				    failed, pulsing · while live. */}
				<span class={"sc-status " + (sub.ended ? "ok" : "running")} title={sub.ended ? "已结束" : "直播中"}>
					<StatusIcon status={sub.ended ? "ok" : "running"} />
				</span>
			</div>
			<div
				class="messages sub-messages"
				onScroll={(e) => {
					const el = e.currentTarget;
					const up = el.scrollTop < lastTop.current - 2;
					lastTop.current = el.scrollTop;
					stick.current = !up && el.scrollHeight - el.scrollTop - el.clientHeight < 140;
				}}
			>
				{groupLog(sub.log).map((u, i) => {
					if (u.kind === "toolgroup") return <ToolGroupRow key={i} tools={u.tools} onOpen={onOpen} />;
					// Degenerate (subs cannot spawn run_agent) — keep the branch type-complete.
					if (u.kind === "subagent") return <SubAgentCallRow key={i} tool={u.tool} onDrill={(t) => onOpen(t, t.toolCallId)} />;
					if (u.kind === "workflow") return <WorkflowCallRow key={i} tool={u.tool} onDrill={(t) => onOpen(t, t.toolCallId)} />;
					if (u.kind === "interactive") return <InlineToolRow key={i} tool={u.tool} onDecision={() => undefined} />;
					return <Row key={i} item={u} />;
				})}
				{sub.streaming && (
					<div class="msg assistant">
						<MarkdownBody text={sub.streaming} />
					</div>
				)}
				{sub.log.length === 0 && !sub.streaming && <div class="muted small">（该 sub-agent 尚未产出内容）</div>}
				<div ref={endRef} />
			</div>
		</div>
	);
}

/** Shared arrow tracker: one scroll/resize listener updates every dock card's
 *  --arrow-top so each arrow keeps pointing at the (possibly scrolled-away)
 *  row that opened it. Card elements carry data-anchor=<toolCallId|url>. */
function useArrowTracker(): void {
	useEffect(() => {
		const update = (): void => {
			for (const card of Array.from(document.querySelectorAll<HTMLElement>(".dock-card[data-anchor]"))) {
				const anchor = document.getElementById(`tool-row-${card.dataset.anchor}`) ?? document.getElementById(card.dataset.anchor ?? "");
				const dock = card.closest(".dock");
				if (!dock || !anchor) continue;
				const a = anchor.getBoundingClientRect();
				const d = dock.getBoundingClientRect();
				// Where the anchor row sits relative to the dock's visible box,
				// clamped inside the card's own height (the arrow rides the card edge).
				const top = Math.max(14, Math.min(a.top + a.height / 2 - d.top, dock.clientHeight - 14));
				card.style.setProperty("--arrow-top", `${top}px`);
			}
		};
		update();
		const raf = (): void => {
			requestAnimationFrame(update);
		};
		window.addEventListener("resize", update);
		window.addEventListener("scroll", raf, true); // capture: chat scroll container included
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", raf, true);
		};
	}, []);
}

/** Dock card: one tool call's detail (args kv-grid + output). Re-resolved live
 *  upstream, so a running tool updates in place. */
function DockToolCard({ tool }: { tool: ToolItem }): preact.JSX.Element {
	useArrowTracker();
	return (
		<div class="dock-card tool-card" id={`dock-card-${tool.toolCallId}`} data-anchor={tool.toolCallId}>
			<div class="dock-card-head">
				<span class="tool-name">{tool.toolName || "tool"}</span>
				<span class={`tool-status ${tool.status}`}>
					{tool.status === "running" ? "运行中…" : tool.status === "ok" ? "成功" : tool.status === "denied" ? "已拒绝" : tool.status === "error" ? "失败" : "等待反馈…"}
				</span>
			</div>
			<div class="tool-panel-body">
				<ToolDetail tool={tool} />
			</div>
		</div>
	);
}

/** True when the activity tree has NOTHING to show — no live agents, no
 *  running tools, no cancelled orphan plans left to resume. The panel hides
 *  its body entirely in that case (no empty-state copy). */
function liveTreeEmpty(
	agents: Record<string, AgentInfo>,
	tools: Record<string, { toolCallId: string; toolName: string; argText: string; agentId?: string; startedAt: number; pid?: number }>,
	dag: DagStateWire | null,
	sessionId: string,
): boolean {
	const liveAgents = Object.values(agents).filter((a) => !a.ended);
	if (liveAgents.length > 0 || Object.keys(tools).length > 0) return false;
	const liveIds = new Set(liveAgents.map((a) => a.agentId));
	return !(dag?.dags ?? []).some(
		(t) => t.ownerAgent && t.ownerAgent !== sessionId && !liveIds.has(t.ownerAgent) && t.nodes[t.rootId]?.status === "cancelled",
	);
}

/** Floating activity HUD over the chat column's top-right corner,
 *  Chrome-process-monitor style. Three stages: "open" (title + tree,
 *  default) / "title" (title bar only) / "dot" (a corner dot that breathes
 *  while anything is live). Separate levers — the caret on the title's
 *  right toggles the tree (open ↔ title), the – on its left minimizes to
 *  the dot, the dot click-restores the full panel. The title carries the
 *  counts moved out of the composer toolbar — x Agents (live) · y Shell
 *  (bash-with-pid). The tree shows the whole session as a TREE — main agent
 *  at the root, spawned agents nested under their parent, each agent's
 *  running tools under it (bash rows carry pid). Quick tools (read/ls/…)
 *  appear in the tree but never the count. Live and mid-run-join (snapshot
 *  replay) feed the same handlers, so the tree self-heals on page open. */
function LivePanel({
	agents,
	tools,
	dag,
	sessionId,
	state,
	onToggleTree,
	onMinimize,
	onRestore,
	onDrill,
}: {
	agents: Record<string, AgentInfo>;
	tools: Record<string, { toolCallId: string; toolName: string; argText: string; agentId?: string; startedAt: number; pid?: number }>;
	dag: DagStateWire | null;
	sessionId: string;
	state: "open" | "title" | "dot";
	onToggleTree: () => void;
	onMinimize: () => void;
	onRestore: () => void;
	onDrill: (agentId: string) => void;
}): preact.JSX.Element {
	// Ticker runs in EVERY state — the dot's breathing depends on fresh
	// counts even when the tree is hidden.
	const [, tick] = useState(0);
	useEffect(() => {
		const iv = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(iv);
	}, []);

	const liveAgents = Object.values(agents).filter((a) => !a.ended);
	// wfRoot anchors are folded into their parent's row — not counted as agents.
	const agentCount = liveAgents.filter((a) => a.kind !== "wfRoot").length;
	const toolEntries = Object.values(tools);
	const shells = toolEntries.filter((t) => t.toolName === "bash");
	const active = liveAgents.length > 0 || toolEntries.length > 0;

	if (state === "dot")
		return (
			<button
				type="button"
				class={"live-panel dot" + (active ? " hot" : "")}
				title="展开任务管理器"
				onClick={onRestore}
			/>
		);

	return (
		<div class={"live-panel" + (state === "title" ? " head-only" : "")}>
			<div class={"live-panel-head" + (active ? " hot" : "")}>
				<button
					type="button"
					class="live-panel-min"
					title="收成小点（有活跃任务时呼吸闪烁）"
					onClick={onMinimize}
				>
					–
				</button>
				<button
					type="button"
					class="live-panel-title"
					title="任务管理器（session 级 agent 树 + 运行中的进程/工具；点击收起/展开树）"
					onClick={onToggleTree}
				>
					<IconBolt /> {agentCount} Agents · {shells.length} Shell
				</button>
				<button
					type="button"
					class="live-panel-caret"
					title={state === "open" ? "收起树" : "展开树"}
					onClick={onToggleTree}
				>
					{state === "open" ? "▾" : "▸"}
				</button>
			</div>
			{state === "open" && !liveTreeEmpty(agents, tools, dag, sessionId) && (
				<div class="live-panel-body">
					<LiveTree
						agents={agents}
						tools={tools}
						dag={dag}
						sessionId={sessionId}
						onDrill={onDrill}
					/>
				</div>
			)}
		</div>
	);
}

/** The activity tree — the floating LivePanel's body. Each agent node carries
 *  its running plans (DAG trees owned by that agent) nested beneath it. */
function LiveTree({
	agents,
	tools,
	dag,
	sessionId,
	onDrill,
}: {
	agents: Record<string, AgentInfo>;
	tools: Record<string, { toolCallId: string; toolName: string; argText: string; agentId?: string; startedAt: number; pid?: number }>;
	dag: DagStateWire | null;
	sessionId: string;
	onDrill: (agentId: string) => void;
}): preact.JSX.Element {
	const [, tick] = useState(0);
	useEffect(() => {
		const iv = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(iv);
	}, []);

	const liveAgents = Object.values(agents).filter((a) => !a.ended);
	const toolEntries = Object.values(tools);
	const fmt = (ms: number): string => {
		const s = Math.max(0, Math.floor(ms / 1000));
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
	};

	// DEDUP: an agent-spawning tool (run_agent / delegate / workflow) is ONE
	// activity, shown ONCE — as the agent row (or ⛓ chip) it brought into
	// being. While that agent is live, the tool's own row is suppressed.
	const spawnedToolIds = new Set(liveAgents.map((a) => a.toolCallId).filter((t): t is string => Boolean(t)));
	const shownTools = toolEntries.filter((t) => !spawnedToolIds.has(t.toolCallId));

	// Tree assembly: agents by parent, tools by owning agent.
	const toolsByAgent = new Map<string, typeof toolEntries>();
	for (const t of shownTools) {
		const key = t.agentId ?? sessionId;
		toolsByAgent.set(key, [...(toolsByAgent.get(key) ?? []), t]);
	}
	const byId = new Map(liveAgents.map((a) => [a.agentId, a] as const));
	/** A workflow root (wfRoot) is folded into its parent's row — its sub-agents
	 *  hang directly off that parent, so expanding the parent expands the run. */
	const displayParent = (a: AgentInfo): string => {
		let p = a.parentAgentId ?? sessionId;
		for (;;) {
			const up = byId.get(p);
			if (!up || up.kind !== "wfRoot") return p;
			p = up.parentAgentId ?? sessionId;
		}
	};
	const childrenOf = new Map<string, AgentInfo[]>();
	for (const a of liveAgents) {
		if (a.kind === "main" || a.kind === "wfRoot") continue;
		const key = displayParent(a);
		childrenOf.set(key, [...(childrenOf.get(key) ?? []), a]);
	}
	// Live workflow runs, keyed by the row they merged into: one ⛓ chip each
	// (meta name + live sub count) rendered under the owning agent's row.
	const workflowsOf = new Map<string, AgentInfo[]>();
	for (const w of liveAgents) {
		if (w.kind !== "wfRoot") continue;
		const key = displayParent(w);
		workflowsOf.set(key, [...(workflowsOf.get(key) ?? []), w]);
	}
	const main = liveAgents.find((a) => a.kind === "main");

	// Plans by owning agent (DagTreeWire.ownerAgent). Main-owned plans key on
	// the session id (main's agentId == sessionId in frames).
	const plansByAgent = new Map<string, DagTreeWire[]>();
	for (const t of dag?.dags ?? []) {
		const key = t.ownerAgent || sessionId;
		plansByAgent.set(key, [...(plansByAgent.get(key) ?? []), t]);
	}

	/** One plan's subtree rendered under its owner agent (drillable nodes). */
	const PlanTree = ({ tree, depth }: { tree: DagTreeWire; depth: number }): preact.JSX.Element => {
		const root = tree.nodes[tree.rootId];
		if (!root) return <></>;
		return (
			<div class="live-plan">
				<div class="live-plan-goal" title={tree.goal ?? root.description}>
					<span class="live-plan-name"><IconTree /> {tree.goal ?? root.description}</span>
				</div>
				<PlanNode node={root} tree={tree} depth={depth} />
			</div>
		);
	};

	const PlanNode = ({ node, tree, depth }: { node: DagNodeWire; tree: DagTreeWire; depth: number }): preact.JSX.Element => {
		const info = agents[node.ownerAgent];
		const live = Boolean(info && !info.ended && info.kind !== "main");
		const icon: IconStatus = node.status === "completed" ? "ok" : node.status === "cancelled" ? "cancelled" : node.status === "in_progress" ? "running" : "pending";
		const children = node.childIds.map((cid) => tree.nodes[cid]).filter(Boolean);
		return (
			<div class="live-node">
				<div
					class={"dag-node" + (live ? " live" : "")}
					style={{ paddingLeft: `${depth * 12 + 6}px` }}
					title={node.result ?? node.description}
					onClick={live ? () => onDrill(node.ownerAgent) : undefined}
				>
					<span class={`dag-ic ${node.status}`}><StatusIcon status={icon} /></span>
					<span class="dag-desc">{node.description}</span>
					{node.mode === "delegate" && <span class="dag-mode">委派</span>}
				</div>
				{children.map((c) => (
					<PlanNode key={c.id} node={c} tree={tree} depth={depth + 1} />
				))}
			</div>
		);
	};

	const AgentNode = ({ a, depth }: { a: AgentInfo; depth: number }): preact.JSX.Element => {
		const myTools = toolsByAgent.get(a.agentId) ?? [];
		const children = childrenOf.get(a.agentId) ?? [];
		const myPlans = plansByAgent.get(a.agentId) ?? [];
		const myWorkflows = workflowsOf.get(a.agentId) ?? [];
		return (
			<div class="live-node">
				<button
					type="button"
					class={"live-agent" + (a.kind !== "main" ? " drill" : "")}
					style={{ paddingLeft: `${depth * 14 + 4}px` }}
					title={a.kind === "main" ? "主 agent" : "点击查看该 agent 的实时流"}
					onClick={a.kind !== "main" ? () => onDrill(a.agentId) : undefined}
				>
					<span class={"live-agent-kind " + a.kind}>{a.kind === "main" ? "主" : a.kind === "dagRoot" ? "根" : "子"}</span>
					<span class="live-agent-label">{a.label}</span>
					{(a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0) > 0 && (
						<span class="live-agent-usage" title="该 agent 累计 token（↑输入 ↓输出）">
							↑{fmtTokens(a.usage?.inputTokens)} ↓{fmtTokens(a.usage?.outputTokens)}
						</span>
					)}
				</button>
				{myWorkflows.map((w) => (
					<div
						key={w.agentId}
						class="live-wf"
						style={{ paddingLeft: `${depth * 14 + 22}px` }}
						title={`workflow ${w.label}（子代理已并入本行之下）`}
					>
						<span class="live-wf-ic"><IconChain /></span>
						<span class="live-wf-name">{w.label}</span>
						<span class="live-wf-count">{liveAgents.filter((x) => x.parentAgentId === w.agentId).length} 子任务</span>
						{w.toolCallId && tools[w.toolCallId] && <span class="live-tool-time">{fmt(Date.now() - tools[w.toolCallId]!.startedAt)}</span>}
					</div>
				))}
				{myTools.map((t) => (
					<div key={t.toolCallId} class="live-tool" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
						<span class="tr-status running"><IconSpinner /></span>
						<span class="tr-name">{t.toolName}</span>
						<span class="live-tool-arg" title={t.argText}>{t.argText}</span>
						{t.pid !== undefined && <span class="live-tool-pid" title="进程 pid">pid {t.pid}</span>}
						<span class="live-tool-time">{fmt(Date.now() - t.startedAt)}</span>
					</div>
				))}
				{myPlans.map((t) => (
					<PlanTree key={t.id} tree={t} depth={depth + 1} />
				))}
				{children.map((c) => (
					<AgentNode key={c.agentId} a={c} depth={depth + 1} />
				))}
			</div>
		);
	};

	return (
		<div class="live-tree">
			<div class="live-sec-label">活动监控</div>
			{main ? (
				<AgentNode a={main} depth={0} />
			) : (
				// No main entry yet (idle session / frames not arrived): render
				// orphan subs / tools under a synthetic root.
				<>
					{[...(childrenOf.get(sessionId) ?? [])].map((c) => (
						<AgentNode key={c.agentId} a={c} depth={0} />
					))}
					{(toolsByAgent.get(sessionId) ?? []).map((t) => (
						<div key={t.toolCallId} class="live-tool">
							<span class="tr-status running"><IconSpinner /></span>
							<span class="tr-name">{t.toolName}</span>
							<span class="live-tool-arg" title={t.argText}>{t.argText}</span>
							{t.pid !== undefined && <span class="live-tool-pid">pid {t.pid}</span>}
							<span class="live-tool-time">{fmt(Date.now() - t.startedAt)}</span>
						</div>
					))}
				</>
			)}
		</div>
	);
}
