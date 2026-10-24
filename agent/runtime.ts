/**
 * AgentRuntime — the per-session agent logic, transport-agnostic.
 *
 * Owns everything a session's agent needs: settings, transcript persistence
 * (with compaction bookkeeping), skill/agent/MCP discovery, execution modes
 * (plan/auto/ask incl. the approval gate), turn checkpoints, run-state snapshots,
 * and the auto-compact trigger. It speaks the ManagerFrame/WorkerFrame protocol
 * through a callback — it never touches a socket or the process.
 *
 * Two hosts run it:
 *  - `worker.ts` (spawn mode "process"): one process per session, connected back
 *    over the Unix-domain WebSocket.
 *  - `AgentManager.spawnShared` (spawn mode "share"): in-process instance on an
 *    in-memory loopback socket — saves a process per idle session.
 */
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ClownfishAgent, type ClownfishAgentOptions } from "./clownfish-agent";
import { toolMode, setIsolationRoots, type JailContext } from "./tools";
import { resolveRuntime, initModels, type ResolvedRuntime } from "./models";
import { generateSessionTitle } from "./title";
import { SkillLoader, discoverSkillRoots, type Skill } from "./skills";
import { SessionTranscript } from "./transcript";
import { loadSettings, applySettings } from "./settings";
import { fileURLToPath } from "node:url";
import { AgentLoader, discoverAgentRoots, resolveAgentPrompt, createRunAgentTool, RUN_AGENT_NAME, createDelegateTool, createRunGoalTool, resumeGoals, relaunchGoal, loadCliAgentDefinitions, type AgentPromptVars, type AgentDefinition, type AsyncRunDone } from "./agents";
import { createWorkflowTool } from "./tools/workflow";
import { runCompaction, makeSummaryMessage } from "./compact";
import { CheckpointStore, mutationTarget } from "./checkpoint";
import { TodoStore, createTodoTool } from "./todo";
import { MemoryStore, memoryRoot, createMemoryTool } from "./memory";
import { runReflection, reflectionEnabled } from "./reflect";
import { loadToolOverrides, applyToolOverrides, type ToolOverrideMap } from "./tools/overrides";
import { discoverCommandRoots, loadCommands, renderCommand, type Command as SlashCommand } from "./commands";
import { createCodingToolDefinitions } from "./tools";
import { createSkillTool } from "./skills";
import { lastAssistantText } from "./messages";
import { loadMcpConfigs, connectMcpServers, closeMcpConnections, type McpConnections } from "./mcp";
import { loadRegistry, disabledSet } from "./registry";
import { join } from "node:path";
import { DagStore } from "./dag";
import { createDagTools } from "./tools/dag";
import { createDrawDemoTool } from "./tools/draw-demo";
import { createCronTool } from "./tools/cron";
import { createSessionControlTools } from "./tools/sessions";
import { createWorktreeDecideTool } from "./tools/worktree-decide";
import type { AgentSnapshot, ExecutionMode, ManagerFrame, WorkerFrame, WorkerSnapshot, WorkerSpawnConfig } from "./protocol";

/** Main-agent DAG toolset (plan/decompose/update_node/get_status + delegate). Off by default — see WORKFLOW_DIRECTIVE. */
/** Full workflow SCRIPT engine (pipeline/llm()/custom orchestration). Off by
 * default: `run_agent`'s `tasks` covers parallel fan-out with the same
 * guardrails, and the script form had zero calls in 1.4k measured. */
const WORKFLOW_SCRIPT_ENABLED = /^(1|true|on)$/i.test((process.env.CLOWNFISH_WORKFLOW_SCRIPT ?? "").trim());
/** The persistent, resumable background goal loop. Off by default: `run_agent`'s
 * `until` runs the same execute→evaluate→retry loop inside a turn. Only this one
 * survives a worker restart (goals.json), which is why the code stays. */
const GOAL_TOOL_ENABLED = /^(1|true|on)$/i.test((process.env.CLOWNFISH_GOAL_TOOL ?? "").trim());

const DAG_TOOLS_ENABLED = /^(1|true|on)$/i.test((process.env.CLOWNFISH_DAG_TOOLS ?? "").trim());

export const PLAN_DIRECTIVE =
	"\n\n## Plan mode\nYou are in PLAN MODE: investigate using the read-only tools and produce a clear, step-by-step plan for the task. Do NOT make any changes — you have no write tools. Lay out the plan, the files/areas it touches, open questions, and stop. The user will switch modes to execute.";

/**
 * How to run multi-step work (main agent only — it alone owns the
 * orchestration tools). ONE rule for choosing, stated once here; each tool's
 * own guidelines describe usage, not selection (docs/TOOLS.md, C1–C3).
 * The DAG toolset (plan/decompose/update_node/get_status + delegate) is off
 * by default — it duplicated `todo` + `run_agent` and was never called in
 * 1.4k measured tool calls; `CLOWNFISH_DAG_TOOLS=1` restores it.
 */
export const WORKFLOW_DIRECTIVE = `
## Running multi-step work

- The plan is the \`todo\` list — write it before anything with more than about three steps, keep it current. There is no other plan.
- Delegate substantial sub-work (design, implementation, testing, review) with \`run_agent\`; do the small stuff — questions, lookups, one-line edits — yourself, since a delegation costs a whole extra agent run. Independent sub-tasks go in ONE call as \`tasks\` and run in parallel (\`synthesize\` combines them into one answer); larger fan-out is still just more \`tasks\`.
- Verification has exactly three cases. A delegation that changed the workspace is verified by the framework automatically — arrange nothing, but treat a result marked UNVERIFIED as not done. When "done" is objectively statable (tests green, a probe that flips, a file with the right content), state it as \`until\` acceptance criteria and the framework retries against them. Only when success is a property nobody can write down as a criterion (adversarial, exploratory) delegate to \`qa\` yourself and say what to attack.
${WORKFLOW_SCRIPT_ENABLED ? "- Orchestration that needs a SCRIPT — pipelines, per-item stages, llm() side calls — is `workflow`; plain parallel fan-out stays in `run_agent`.\n" : ""}${GOAL_TOOL_ENABLED ? "- A long-horizon goal that must survive restarts runs as `run_goal` in the background; a goal that fits one turn is `run_agent` with `until`.\n" : ""}
Pick per task; don't ask the user which — they shouldn't manage the process.`;

/** HTML artifact guidance — when to inline a snippet vs publish a demo. */
export const DEMO_DIRECTIVE = `
## HTML output for the user

When a reply deserves a live visual rather than prose, produce HTML — two tiers:

- **Inline (\`\`\`html fence in your reply — NO tool call):** any self-contained snippet. Inline CSS/JS, one file, libraries by external URL are all fine. The chat renders it as a live preview immediately. This is the default.
- **Multi-file (\`draw_demo\` tool):** ONLY when one file genuinely isn't enough (separate css/js/images you can't inline or reference externally). The tool returns a URL — include it as a plain markdown link in your reply; the chat UI opens the demo beside the conversation automatically.

Never call \`draw_demo\` for something a single \`\`\`html fence could show, and never write demo files with the write tool — \`draw_demo\` owns that space.`;

export interface AgentRuntimeOptions {
	/** Emit a frame to the host (manager). Called only while the transport is open. */
	onFrame: (frame: WorkerFrame) => void;
	/** Called once the runtime has shut itself down (host should tear down transport/exit). */
	onTerminated?: () => void;
	/** Where the bundled built-in agents live (defaults to `agent/agents/builtin`). */
	builtinAgentsDir?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Session-default reasoning effort from project config; unknown values fall back to `off`. */
function resolveThinking(configured: string | undefined): ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(configured ?? "") ? (configured as ThinkingLevel) : "off";
}

/**
 * Whether a turn the ORCHESTRATOR handled itself gets an independent `qa` pass.
 * `off` (default) · `auto` (only when the turn mutated the workspace and did not
 * delegate — a delegation is already verified by run_agent) · `always`.
 */
function turnVerifyPolicy(): "off" | "auto" | "always" {
	const raw = process.env.CLOWNFISH_VERIFY_TURN?.trim().toLowerCase();
	return raw === "auto" || raw === "always" ? raw : "off";
}

/** How many times one turn may be handed back after a FAIL verdict. */
const TURN_VERIFY_RETRIES = Number(process.env.CLOWNFISH_VERIFY_TURN_RETRIES ?? "1") || 1;

export class AgentRuntime {
	private readonly tx: SessionTranscript;
	private pendingPersist: Promise<void> | undefined;

	/**
	 * This runtime's (main) agent id — always the session id. Spawned subagents
	 * (dagRoot/dagSub) get their own ids and emit through this runtime as a bus;
	 * their frames carry their own agentId, not this one.
	 */
	get agentId(): string {
		return this.cfg.sessionId;
	}

	// Run state, maintained from events, for mid-run-join snapshots. One
	// session-wide registry keyed by agentId (main + every spawned sub): agents
	// live/die via agent_spawned/ended frames on the bus tap, tools/streaming
	// via per-agent pi events. `busyAgents` below is derived from the same tap.
	private liveAgents = new Map<string, AgentSnapshot>();
	private active = false;
	/** Worker boot wall-clock — the main agent's `agentStartedAt`. */
	private bootedAt = Date.now();

	/**
	 * Spawned-agent support: `busyAgents` counts in-flight spawned agents
	 * (goalRoot/dagSub/workflow subs) so shutdown waits them out, and
	 * `wakeMain` (below) re-invokes the main agent exactly once per completed
	 * background run. The MAIN agent's own busy state is its `isStreaming`
	 * flag — background agents never block it (per-agent locks).
	 */
	private busyAgents = 0;

	/**
	 * Live SYNC run_agent subs, keyed by subId — each entry converts its
	 * blocking tool call to background (user "转后台" via the `detach_agent`
	 * command; `abort` fires them all so a user stop doesn't drop results).
	 * Entries are unregistered by the tool when the run settles.
	 */
	private detachables = new Map<string, () => void>();
	private readonly registerDetachable = (subId: string, fire: () => void): (() => void) => {
		this.detachables.set(subId, fire);
		return () => {
			if (this.detachables.get(subId) === fire) this.detachables.delete(subId);
		};
	};


	// Whether a session title has been (or will be) auto-generated.
	private titleGenerated = true;
	private providerRuntime: ResolvedRuntime | undefined;

	// Compaction / persistence bookkeeping (see persist()).
	private writtenReal = 0;
	private compactOffset = 0;
	private hasSummary = false;
	private summaryMsg: AgentMessage | undefined;

	// Discovered agents / skills / prompt vars.
	private agents: AgentDefinition[] = [];
	private skills: Skill[] = [];
	/** Tool names disabled via the admin registry (builtins + MCP servers). */
	private disabledToolNames: Set<string> = new Set();
	/** Assets changed mid-turn (reload_assets while streaming) — apply before the next turn's first LLM request. */
	private assetsDirty = false;
	/** Fingerprint of the connected MCP server set — unchanged means no reconnect on reload. */
	private mcpServersJson = "";
	private vars: AgentPromptVars | undefined;

	/**
	 * Cross-session memory block for this session's
	 * project — injected into the system prompt at build time. Re-read on every
	 * rebuild so a just-accepted proposal shows up on the next mode switch /
	 * boot without a worker restart.
	 */
	private memoryBlock = "";
	private reflected = false;

	// Execution mode (plan/auto/ask), default "auto".
	private mode: ExecutionMode = "auto";

	// Turn checkpoints + MCP connections.
	private checkpoints: CheckpointStore | undefined;
	/**
	 * Capability mode per tool NAME, covering the SUB-AGENTS' toolset as well as the
	 * main agent's: the approval gate fires for calls a sub-agent makes too, and
	 * those tools are not in `this.agent.toolDefs`. Rebuilt with the agent.
	 */
	private toolModes = new Map<string, "R" | "W" | "RW">();
	/** The session plan + delegation ledger (model writes the plan, framework the state). */
	private todos: TodoStore | undefined;
	/** Operator edits of the tools' model-facing text, from `<dataDir>/tool_overwrite`. */
	private toolOverrides: ToolOverrideMap = new Map();
	/** User-invoked prompt templates (`/name`), expanded locally rather than by the model. */
	private commands: SlashCommand[] = [];
	/** Independent verification of a turn the orchestrator handled itself. */
	private verifyTurn: ((opts: { task: string; answer: string; signal?: AbortSignal }) => Promise<{ verdict: "pass" | "fail" | "unverified"; text: string }>) | undefined;
	/** Did this turn write anything, and did it delegate? Reset on every prompt. */
	private turnMutated = false;
	private turnDelegated = false;
	private turnVerifyRetries = 0;
	/**
	 * While a turn is being verified its `agent_end` is held back rather than
	 * forwarded: verification is part of the turn, and announcing the turn finished
	 * first lets anything acting on that frame tear the session down mid-check.
	 */
	private heldAgentEnd: AgentEvent | undefined;
	private holdAgentEnd = false;
	private mcp: McpConnections | undefined;

	/**
	 * The session's shared execution-plan DAG state (the single source of truth for
	 * every concurrent DAG). Hydrated from `<sessionId>/dag.json` at boot and
	 * re-persisted on every mutation. Scoped handles to it are handed to every
	 * agent (main + spawned subagents) via {@link createDagTools}.
	 */
	private dags!: DagStore;

	// Ask mode: pending tool approvals.
	private pendingApprovals = new Map<string, (approved: boolean) => void>();

	// Session-control RPC (the assistant's cross-session tools): the worker is
	// the initiator, so it parks the promise here keyed by ref — the same
	// shape as the approval flow, with the server answering instead of the user.
	private sessionOpSeq = 0;
	private readonly sessionOps = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	/** Set in shutdown() — wakeMain and background-run bookkeeping check it. */
	private shuttingDown = false;

	/**
	 * Auto re-drive of provider-interrupted background runs (the 429 case): a
	 * quota outage kills the goalRoot turn; the stream-level retry has already
	 * spent its short budget, so the runtime re-launches the run from its
	 * persisted frontier on a minutes-scale backoff — unbounded until the
	 * worker shuts down, because "no tokens left" can last until the user tops
	 * up, and the resumed run must pick up on its own when they do.
	 */
	private reDriveTimers = new Map<string, NodeJS.Timeout>();
	private reDriveAttempts = new Map<string, number>();
	private static readonly RE_DRIVE_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];

	// Compaction serialization.
	private compactBusy = false;
	private compactDone: Promise<void> = Promise.resolve();

	/**
	 * Cumulative provider usage per agent (main + every spawned), summed from
	 * message_end events. Lives OUTSIDE liveAgents (whose sub entries die at
	 * agent_ended) so a finished sub's token total survives for the report.
	 */
	private usageByAgent = new Map<string, { inputTokens: number; outputTokens: number; messages: number }>();

	private agent: ClownfishAgent | undefined;

	constructor(
		private readonly cfg: WorkerSpawnConfig,
		private readonly opts: AgentRuntimeOptions,
	) {
		this.tx = new SessionTranscript(cfg.sessionsDir, cfg.sessionId);
		// A file-backed credential store so an OAuth login (e.g. `openai-codex`
		// — sign in with ChatGPT) survives past this worker process. See
		// agent/models.ts's resolveRuntime doc comment.
		initModels(cfg.dataDir);
		// Apply provider settings so resolveRuntime sees the proxy base URL / token.
		applySettings(loadSettings(cfg.dataDir));
	}

	private send(frame: WorkerFrame): void {
		this.opts.onFrame(frame);
	}

	/**
	 * One session-control round-trip to the server (assistant sessions only —
	 * see agent/tools/sessions.ts). Bounded: the tools must not hang a turn on
	 * a server that never answers.
	 */
	private sessionControl(action: "list" | "send" | "read", payload: { projectId?: string; sessionId?: string; text?: string; mode?: "steer" | "followup" } = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const ref = ++this.sessionOpSeq;
			const timer = setTimeout(() => {
				this.sessionOps.delete(ref);
				reject(new Error("session control timed out (server did not answer)"));
			}, 30_000);
			this.sessionOps.set(ref, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.send({ type: "session_control", ref, action, ...payload });
		});
	}

	// ------------------------------------------------------------- approval ----

	/**
	 * Emit a `tool_approval` frame and park until the user decides. Resolves false
	 * (denied) on abort or after 10 idle minutes — a run must not hang forever.
	 */
	private requestApproval(toolCallId: string, toolName: string, args: unknown, signal?: AbortSignal, frameAgentId?: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (approved: boolean): void => {
				if (settled) return;
				settled = true;
				this.pendingApprovals.delete(toolCallId);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(approved);
			};
			const onAbort = (): void => settle(false);
			const timer = setTimeout(() => settle(false), 10 * 60_000);
			if (signal) {
				if (signal.aborted) return settle(false);
				signal.addEventListener("abort", onAbort);
			}
			this.pendingApprovals.set(toolCallId, settle);
			// frameAgentId attributes sub-agent approvals to the sub-agent in the
			// UI (the hook closure is inherited by spawned agents; routing is keyed
			// by toolCallId either way).
			this.send({ type: "tool_approval", toolCallId, toolName, args, agentId: frameAgentId ?? this.agentId });
		});
	}

	/**
	 * Consent callback handed to the MAIN agent's structured tools: an
	 * outside-workspace path parks on a tool_approval card (attributed to the
	 * asking agent) until the user decides. Sub-agents run unattended inside
	 * background trees, so they keep the strict default (outside = refused)
	 * rather than stalling a DAG for the 10-minute approval timeout.
	 */
	private makeJailApproval(asAgentId?: string): JailContext["approval"] {
		return ({ toolCallId, tool, path, jail, signal }) =>
			this.requestApproval(
				toolCallId ?? "fs-jail",
				tool ?? "fs-access",
				{ path, workspace: jail, note: "path is outside this agent's workspace" },
				signal,
				asAgentId,
			);
	}

	// ------------------------------------------------------------ compaction ----

	/** Compaction flow shared by the /compact command and auto-compact. Serialized. */
	private runCompactFlow(auto: boolean): Promise<void> {
		if (this.compactBusy) return this.compactDone;
		const a = this.agent;
		const rt = this.providerRuntime;
		const v = this.vars;
		if (!a || a.state.isStreaming || !rt || !v) return Promise.resolve();
		const exec = (async (): Promise<void> => {
			const realMem = this.hasSummary ? a.state.messages.slice(1) : a.state.messages;
			try {
				const result = await runCompaction(
					{ agents: this.agents, runtime: rt, cwd: this.cfg.cwd, skills: this.skills, vars: v, sessionId: this.cfg.sessionId },
					{ realMessages: realMem, offset: this.compactOffset },
				);
				if (!result) {
					if (!auto) {
						this.send({ type: "compacted", offset: this.compactOffset, kept: realMem.length });
						this.send({ type: "log", level: "info", message: "nothing to compact yet" });
					}
					return;
				}
				await this.tx.writeCompact(result.record);
				this.compactOffset = result.record.offset;
				this.summaryMsg = makeSummaryMessage(result.record.summary);
				this.hasSummary = true;
				a.loadHistory([this.summaryMsg, ...result.tail]);
				if (!auto) this.send({ type: "compacted", offset: this.compactOffset, kept: result.tail.length });
				this.send({ type: "log", level: "info", message: `${auto ? "auto-" : ""}compacted → offset=${this.compactOffset}, ${result.tail.length} recent kept` });
			} catch (err) {
				if (!auto) this.send({ type: "error", message: `compact failed: ${err instanceof Error ? err.message : String(err)}` });
				console.error(`[agent:${this.cfg.sessionId.slice(0, 8)}] compact failed:`, err);
			}
		})();
		this.compactBusy = true;
		this.compactDone = exec.finally(() => {
			this.compactBusy = false;
		});
		return this.compactDone;
	}

	/** Auto-compact when the last turn's input tokens reach 75% of the context window. */
	private maybeAutoCompact(): Promise<void> {
		if (!this.providerRuntime || !this.agent) return Promise.resolve();
		const last = [...this.agent.state.messages].reverse().find((m) => m.role === "assistant");
		const used = (last as { usage?: { input?: number } } | undefined)?.usage?.input ?? 0;
		const limit = Number((this.providerRuntime.model as { contextWindow?: number }).contextWindow ?? 0);
		if (!limit || used <= 0 || used < limit * 0.75) return Promise.resolve();
		this.send({ type: "log", level: "info", message: `context ${used}/${limit} tokens (≥75%) → auto-compacting` });
		return this.runCompactFlow(true);
	}

	// ------------------------------------------------------------- run state ----

	private snapshot(): WorkerSnapshot {
		// Registry only holds agents with something to show: the main agent while
		// active, and live spawned agents (ended ones drop out of the map).
		return { active: this.active, agents: [...this.liveAgents.values()], todos: this.todos?.list() };
	}

	/** Seed the main agent's registry entry (worker boot / each main run). */
	private ensureMainEntry(): void {
		if (!this.liveAgents.has(this.agentId)) {
			this.liveAgents.set(this.agentId, {
				agentId: this.agentId,
				label: "main",
				kind: "main",
				active: false,
				agentStartedAt: this.bootedAt,
				streamingText: "",
				activeTools: [],
			});
		}
	}

	/** Fold a MAIN-agent pi event into the session registry. */
	private updateRunState(event: AgentEvent): void {
		this.foldAgentEvent(this.agentId, event);
		switch (event.type) {
			case "agent_start":
				this.active = true;
				return;
			case "agent_end":
				this.active = false;
				return;
			default:
				return;
		}
	}

	/** Fold ONE agent's (main or sub) pi event into its registry entry. */
	private foldAgentEvent(agentId: string, event: AgentEvent): void {
		const entry = this.liveAgents.get(agentId);
		// Main always has an entry; a sub without one yet (frames race events) is
		// created lazily so no tool/stream is lost.
		const e = entry ?? { agentId, label: agentId, kind: "dagSub" as const, active: false, agentStartedAt: Date.now(), streamingText: "", activeTools: [] };
		if (!entry) this.liveAgents.set(agentId, e);
		switch (event.type) {
			case "agent_start":
				e.active = true;
				e.streamingText = "";
				return;
			case "message_update": {
				const ev = event.assistantMessageEvent;
				if (ev.type === "text_delta") e.streamingText += ev.delta;
				return;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					e.streamingText = "";
					// Cumulative provider usage per agent — the token ledger the UI
					// shows next to each agent (lives outside liveAgents too, so a
					// finished sub's totals survive until the next snapshot ask).
					const u = event.message.usage;
					if (u) {
						const agg = this.usageByAgent.get(agentId) ?? { inputTokens: 0, outputTokens: 0, messages: 0 };
						agg.inputTokens += u.input + u.cacheRead + u.cacheWrite;
						agg.outputTokens += u.output;
						agg.messages += 1;
						this.usageByAgent.set(agentId, agg);
						e.usage = { ...agg };
					}
				}
				return;
			case "tool_execution_start":
				e.activeTools = e.activeTools.filter((t) => t.toolCallId !== event.toolCallId);
				e.activeTools.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, startedAt: Date.now() });
				return;
			case "tool_execution_update": {
				// bash reports its child pid via the first update — latch it onto the
				// active tool for the process monitor / future resource stats.
				const pid = (event.partialResult as { details?: { pid?: number } } | undefined)?.details?.pid;
				if (!pid) return;
				const t = e.activeTools.find((x) => x.toolCallId === event.toolCallId);
				if (t) t.pid = pid;
				return;
			}
			case "tool_execution_end":
				e.activeTools = e.activeTools.filter((t) => t.toolCallId !== event.toolCallId);
				return;
			case "agent_end":
				e.active = false;
				e.streamingText = "";
				e.activeTools = [];
				// A finished sub leaves the registry (a finished main stays until the
				// next run, so an idle session snapshots as empty-but-booted).
				if (agentId !== this.agentId) this.liveAgents.delete(agentId);
				return;
			default:
				return;
		}
	}

	/** Fold a bus frame (spawn/ended + sub `event` frames) into the registry. */
	private foldBusFrame(frame: WorkerFrame): void {
		if (frame.type === "agent_spawned" && frame.kind !== "main") {
			this.busyAgents++;
			this.liveAgents.set(frame.agentId, {
				agentId: frame.agentId,
				label: frame.label ?? frame.agentId,
				kind: frame.kind,
				parentAgentId: frame.parentAgentId ?? this.agentId,
				toolCallId: frame.toolCallId,
				name: frame.name,
				active: true,
				agentStartedAt: Date.now(),
				streamingText: "",
				activeTools: [],
				// A re-spawned agent (retry / next DAG step) keeps its ledger.
				...(this.usageByAgent.get(frame.agentId) ? { usage: { ...this.usageByAgent.get(frame.agentId)! } } : {}),
			});
		}
		if (frame.type === "agent_ended") {
			this.busyAgents = Math.max(0, this.busyAgents - 1);
			this.liveAgents.delete(frame.agentId);
		}
		if (frame.type === "event" && frame.agentId) this.foldAgentEvent(frame.agentId, frame.event);
	}

	// ------------------------------------------------------------- commands ----

	/** Handle one manager frame. Never throws — errors surface as error frames. */
	async handle(msg: ManagerFrame): Promise<void> {
		try {
			await this.dispatch(msg);
		} catch (err) {
			this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Re-read the memory block (global + this project). */
	private async refreshMemoryBlock(): Promise<void> {
		try {
			this.memoryBlock = await new MemoryStore(memoryRoot(this.cfg.dataDir)).promptBlock(this.cfg.projectId);
		} catch (err) {
			// Memory is an enhancement, never a blocker — an unreadable store
			// just means no injection this boot.
			console.warn(`[agent:${this.cfg.sessionId.slice(0, 8)}] memory block unavailable:`, err instanceof Error ? err.message : err);
		}
	}

	private async dispatch(msg: ManagerFrame): Promise<void> {
		switch (msg.type) {
			case "prompt": {
				const agent = this.agent;
				if (!agent) return;
				// `/name [args]` → expand locally instead of making the model fetch it.
				// A skill wins over a command of the same name (skills are also visible
				// to the model, so the two must not disagree about what `/name` means).
				// Expanded BEFORE the queue/busy split, so a queued `/name` behaves the
				// same as one typed at an idle prompt.
				const slash = msg.text.match(/^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/);
				const slashArgs = (slash?.[2] ?? "").trim();
				const skill = slash ? this.skills.find((s) => s.name === slash[1]) : undefined;
				const command = skill || !slash ? undefined : this.commands.find((c) => c.name === slash[1]);
				let text = msg.text;
				if (skill) {
					text = `# Skill: ${skill.name}\n\n${skill.body}\n\n---\n\n# Task\n${slashArgs || "(Follow the skill's instructions above.)"}`;
					this.send({ type: "log", level: "info", message: `skill prompt: ${skill.name}` });
				} else if (command) {
					text = renderCommand(command, slashArgs);
					this.send({ type: "log", level: "info", message: `command prompt: ${command.name} (${command.source})` });
				}
				// Mid-run submission: a mode-bearing prompt while the main agent
				// streams goes to pi's queues — "steer" is drained into the CURRENT
				// run (after the in-flight assistant turn, before it would stop);
				// "followup" is drained at the run's stop boundary (a fresh loop).
				// pi's loop only drains queues DURING a run, so an idle agent must
				// take the plain prompt() path (a queued message would strand).
				if (agent.state.isStreaming && (msg.mode === "steer" || msg.mode === "followup")) {
					const queued: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
					if (msg.mode === "steer") agent.steer(queued);
					else agent.followUp(queued);
					this.send({ type: "log", level: "info", message: `${msg.mode} queued: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}` });
					this.emitQueueState();
					return;
				}
				if (agent.state.isStreaming) {
					// The MAIN agent is mid-turn. (Background dagRoot agents stream
					// independently; they must never block the main conversation.)
					this.send({ type: "error", message: "agent is busy; abort or wait for the current turn" });
					return;
				}
				// An auto-compaction may be folding history — wait it out, then prompt.
				if (this.compactBusy) await this.compactDone;
				// Panel edits deferred by a mid-turn reload_assets: apply them NOW,
				// before this turn's first LLM request, so the request already
				// carries the new system prompt / skills / toolset.
				if (this.assetsDirty) {
					this.assetsDirty = false;
					await this.reloadNow();
				}
				// Pick up freshly accepted memory (the user may have confirmed
				// proposals in another tab since boot — two file reads, cheap).
				await this.refreshMemoryBlock();
				// New user turn → seal the previous checkpoint and start fresh.
				await this.checkpoints?.beginTurn();
				this.send({ type: "log", level: "info", message: `prompt: ${msg.text.slice(0, 80)}` });
				// First prompt of a fresh session: side-channel title suggestion in
				// parallel with the real turn — never enters the agent's history.
				if (!this.titleGenerated && this.providerRuntime) {
					this.titleGenerated = true;
					const firstPrompt = msg.text;
					void generateSessionTitle(this.providerRuntime, firstPrompt).then((title) => {
						if (title) this.send({ type: "set_title", title });
					});
				}
				// Drive the run; events flow via onEvent. Don't block the command loop.
				this.turnMutated = false;
				this.turnDelegated = false;
				this.turnVerifyRetries = 0;
				void this.runTurn(text);
				return;
			}
			case "detach_agent":
				this.detachSubAgent(msg.agentId);
				return;
			case "abort":
				// A user stop must not waste in-flight SYNC run_agent subs: convert
				// them to background first so their results still arrive as
				// [async-agent] messages — aborting the main run would otherwise
				// orphan the pending tool call and silently drop the answer.
				for (const fire of this.detachables.values()) fire();
				this.agent?.abort();
				return;
			case "reload_assets": {
				// Panel write landed. Idle → swap immediately; mid-turn → defer to
				// the next prompt's first LLM request (see the prompt case above).
				if (this.agent?.state.isStreaming) {
					this.assetsDirty = true;
					this.send({ type: "log", level: "info", message: "assets changed mid-turn — reload deferred to next turn" });
					return;
				}
				await this.reloadNow();
				return;
			}
			case "snapshot":
				this.send({ type: "snapshot", snapshot: this.snapshot(), agentId: this.agentId });
				// A (re)connecting tab missed earlier queue_state frames —
				// resync its toolbar counters with the run.
				this.emitQueueState();
				return;
			case "compact": {
				const agent = this.agent;
				if (!agent) return;
				if (agent.state.isStreaming) {
					this.send({ type: "error", message: "agent is busy; compact after the current turn finishes" });
					return;
				}
				await this.runCompactFlow(false);
				return;
			}
			case "set_mode": {
				const agent = this.agent;
				if (!agent) return;
				if (agent.state.isStreaming) {
					this.send({ type: "error", message: "agent is busy; switch mode after the current turn finishes" });
					return;
				}
				const prev = this.mode;
				this.mode = msg.mode;
				try {
					this.buildAgent(agent.state.messages);
					this.send({ type: "mode_changed", mode: this.mode });
					this.send({ type: "log", level: "info", message: `mode → ${this.mode}` });
				} catch (err) {
					this.mode = prev;
					this.buildAgent(agent.state.messages);
					this.send({ type: "error", message: `mode switch failed: ${err instanceof Error ? err.message : String(err)}` });
				}
				return;
			}
			case "tool_decision": {
				const settle = this.pendingApprovals.get(msg.toolCallId);
				if (settle) {
					this.pendingApprovals.delete(msg.toolCallId);
					settle(msg.approved);
					this.send({ type: "log", level: "info", message: `tool call ${msg.approved ? "approved" : "denied"}` });
				}
				return;
			}
			case "session_control_result": {
				const pending = this.sessionOps.get(msg.ref);
				if (pending) {
					this.sessionOps.delete(msg.ref);
					if (msg.ok) pending.resolve(msg.data);
					else pending.reject(new Error(msg.error ?? "session control failed"));
				}
				return;
			}
			case "shutdown":
				this.send({ type: "log", level: "info", message: "shutting down" });
				// Only a real end-of-session reflects: an idle reap or an explicit
				// stop. A server-wide Ctrl-C ("server") must not fire one model call
				// per live session on the way out.
				await this.shutdown({ reflect: msg.reason !== "server" });
				this.opts.onTerminated?.();
				return;
		}
	}

	// -------------------------------------------------------------- persist ----

	private async persist(): Promise<void> {
		const agent = this.agent;
		if (!agent) return;
		try {
			const mem = agent.state.messages;
			// Drop the virtual summary prefix so only REAL messages are persisted.
			const realMem = this.hasSummary ? mem.slice(1) : mem;
			const oldRealInMem = this.writtenReal - this.compactOffset;
			if (realMem.length >= oldRealInMem) {
				const newOnes = realMem.slice(oldRealInMem);
				if (newOnes.length > 0) {
					await this.tx.appendMessages(newOnes);
					this.writtenReal += newOnes.length;
				}
			} else {
				// Real history shrank (abort / regenerate): rewrite the file and drop
				// compaction (offsets no longer line up).
				await this.tx.rewriteAll(realMem);
				await this.tx.clearCompact();
				this.writtenReal = realMem.length;
				this.compactOffset = 0;
				this.hasSummary = false;
				this.summaryMsg = undefined;
				agent.loadHistory(realMem);
			}
			this.send({ type: "persisted", count: this.writtenReal });
		} catch (err) {
			console.error(`[agent:${this.cfg.sessionId.slice(0, 8)}] persist failed:`, err);
			this.send({ type: "error", message: `persist failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	/**
	 * Serialize persist() runs. Persistence is incremental (message-level, see
	 * the onEvent hook), so triggers can overlap — e.g. a message_end landing
	 * while the previous flush is still awaiting appendFile. Chaining keeps the
	 * writtenReal bookkeeping strictly ordered so nothing double-appends.
	 */
	private schedulePersist(): Promise<void> {
		const run = (this.pendingPersist ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => this.persist());
		this.pendingPersist = run;
		return run;
	}

	// ---------------------------------------------------------------- agent ----

	/**
	 * Tool-call hook, installed in every mode: ask-mode approval gate (write
	 * tools) + checkpoint capture (write/edit pre-images). pi awaits
	 * beforeToolCall, so in ask mode the run parks until the user decides (or
	 * abort/timeout denies). Extracted so boot (resume) can share it with
	 * buildAgent.
	 */
	private makeBeforeToolCall(asAgentId?: string): ClownfishAgentOptions["beforeToolCall"] {
		return async ({ toolCall, args }, signal) => {
			if (this.mode === "ask") {
				// Fail closed: an unrecognized tool is treated as write-capable rather
				// than waved through, so ask mode can never be bypassed by a tool the
				// gate happens not to know about — including a sub-agent's tools, which
				// are not in the main agent's `toolDefs`.
				const mode = this.toolModes.get(toolCall.name) ?? "W";
				if (mode !== "R") {
					const approved = await this.requestApproval(toolCall.id, toolCall.name, args, signal, asAgentId);
					if (!approved) return { block: true, reason: "User denied this tool call (ask mode)" };
				}
			}
			// What this turn did, for the post-turn verification decision. A delegation
			// already gets run_agent's own verification pass, so a turn that delegated
			// must not be charged for a second one.
			if (toolCall.name === RUN_AGENT_NAME) this.turnDelegated = true;
			else if ((this.toolModes.get(toolCall.name) ?? "W") !== "R") this.turnMutated = true;
			// Checkpoint capture: write/edit record the target's pre-image, bash records
			// the WHOLE workspace state (it can touch anything). Without the second one
			// a rollback would undo the edits and leave every shell-driven change in
			// place — a tree that never existed.
			if (this.checkpoints) {
				const target = mutationTarget(toolCall.name, args);
				if (target) await this.checkpoints.captureFile(target, toolCall.name);
				else if (toolCall.name === "bash") {
					const command = (args as { command?: unknown })?.command;
					await this.checkpoints.captureShell(typeof command === "string" ? command : "");
				}
			}
			return undefined;
		};
	}

	/**
	 * Common deps for the background-run tools (goal / delegate / boot resume).
	 * Callers layer their own extras (depth, beforeToolCall, onFrame) on top.
	 */
	private workflowDeps() {
		return {
			dags: this.dags,
			agentId: this.agentId,
			runtime: this.providerRuntime!,
			cwd: this.cfg.cwd,
			skills: this.skills,
			vars: this.vars!,
			sessionId: this.cfg.sessionId,
			sessionsDir: this.cfg.sessionsDir,
			worktreeDir: join(this.cfg.dataDir, "worktrees", this.cfg.sessionId),
			wakeMain: (text: string) => this.wakeMain(text),
			onInterrupted: (kind: "goal", id: string, error: string) => this.scheduleReDrive(kind, id, error),
			// Per-agent variant of the tool-call hook so spawned agents' ask-mode
			// approvals are attributed to THEM (not the main agent) in the UI.
			beforeToolCallFor: (agentId: string) => this.makeBeforeToolCall(agentId),
			log: (message: string) => this.send({ type: "log", level: "info", message }),
		};
	}

	// -------------------------------------------------------- auto re-drive ----

	/** Schedule (or re-schedule) the backoff re-drive of an interrupted run. */
	private scheduleReDrive(kind: "goal", id: string, error: string): void {
		if (this.shuttingDown) return;
		const key = `${kind}:${id}`;
		const prev = this.reDriveTimers.get(key);
		if (prev) clearTimeout(prev);
		const idx = Math.min(this.reDriveAttempts.get(key) ?? 0, AgentRuntime.RE_DRIVE_BACKOFF_MS.length - 1);
		const delay = AgentRuntime.RE_DRIVE_BACKOFF_MS[idx];
		this.reDriveAttempts.set(key, idx + 1);
		this.send({ type: "log", level: "info", message: `${kind} ${id.slice(0, 8)} interrupted by provider error (${error.slice(0, 120)}) — auto re-drive in ${Math.round(delay / 1000)}s` });
		const timer = setTimeout(() => {
			this.reDriveTimers.delete(key);
			if (this.shuttingDown) return;
			void this.reDrive(kind, id);
		}, delay);
		this.reDriveTimers.set(key, timer);
	}

	/** One re-drive attempt: relaunch from the persisted frontier (no-op if the run finished/was cleaned up meanwhile). */
	private async reDrive(kind: "goal", id: string): Promise<void> {
		try {
			if (kind === "goal") {
				await relaunchGoal(
					{ ...this.workflowDeps(), beforeToolCall: this.makeBeforeToolCall(), onFrame: this.onBusFrameForBoot() },
					join(this.cfg.sessionsDir, this.cfg.sessionId),
					id,
				);
			}
		} catch (err) {
			this.send({ type: "error", message: `re-drive ${kind} ${id.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	/**
	 * Session-bus tap for the boot-resume paths (before buildAgent exists): same
	 * frame forwarding + spawned-agent liveness tracking as buildAgent's onBusFrame.
	 */
	private onBusFrameForBoot(): (frame: WorkerFrame) => void {
		return (frame) => {
			this.foldBusFrame(frame);
			this.send(frame);
		};
	}

	/**
	 * Prompt the main agent with busy-retry. Both prompt paths (dispatch and
	 * wakeMain) have await gaps between their isStreaming check and the actual
	 * `prompt()` call (compaction / memory refresh / checkpoint sealing / the
	 * wake's own wait loop) — the other side can start a run inside that window,
	 * and pi rejects a second prompt outright. A raw throw would DROP a user
	 * message or a workflow wake entirely, so bridge the overlap with retries.
	 */
	private runMainPrompt(text: string): Promise<void> {
		const agent = this.agent;
		if (!agent) return Promise.resolve();
		const attempt = (tries: number): Promise<void> =>
			agent.prompt(text).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (tries > 0 && !this.shuttingDown && /already (processing|streaming)/i.test(msg)) {
					return new Promise((r) => setTimeout(r, 300)).then(() => attempt(tries - 1));
				}
				throw err;
			});
		return attempt(20); // ≤6s of bridging for the check→prompt race window
	}

	/**
	 * Wake the main agent with a light internal prompt (used ONCE per completed
	 * async workflow — the only place we re-invoke the main agent from outside).
	 * The notice is folded in as a bracketed user-role message, so the agent
	 * synthesizes it into a proper reply and it persists like any turn. Waits out
	 * an in-flight main turn / compaction first; a wake during shutdown is dropped.
	 */
	private async wakeMain(text: string): Promise<void> {
		if (this.shuttingDown) return;
		// Wait out a busy main turn — however long it takes. Barging in after a
		// fixed grace (the old 10×300ms) dropped the wake entirely: prompt() on a
		// streaming agent rejects, and the summary never reached the user.
		while ((this.agent?.state.isStreaming || this.compactBusy) && !this.shuttingDown) {
			await new Promise((r) => setTimeout(r, 500));
		}
		const agent = this.agent;
		if (!agent || this.shuttingDown) return;
		if (this.compactBusy) await this.compactDone;
		this.send({ type: "log", level: "info", message: `waking main agent: ${text.slice(0, 60)}…` });
		await this.runMainPrompt(text);
	}

	/**
	 * A background (`async: true`) run_agent task settled: fold the result into
	 * the main agent as an `[async-agent]` user message and wake it. The sub's
	 * transcript is already durable at this point (the tool persists before
	 * firing onAsyncDone), so the wake — and any reload — reads finished state.
	 * Success and failure both surface: the parent agent must know a background
	 * task it started did not silently vanish.
	 */
	private onAsyncAgentDone(info: AsyncRunDone): void {
		const taskLine = `task: ${info.task.slice(0, 300)}`;
		const text = info.ok
			? `[async-agent] Background sub-agent '${info.type}' finished (${taskLine}). Result:\n\n${info.result ?? "(no text output)"}`
			: `[async-agent] Background sub-agent '${info.type}' FAILED (${taskLine}): ${info.error ?? "unknown error"}`;
		this.send({ type: "log", level: "info", message: `async run_agent '${info.type}' ${info.ok ? "finished" : `failed: ${info.error?.slice(0, 120)}`}` });
		void this.wakeMain(text).catch(() => undefined);
	}

	/**
	 * User-initiated "转后台" (the `detach_agent` command): convert a running
	 * SYNC run_agent sub to background. Firing the gate resolves the pending
	 * tool call with a marker (the caller's turn resumes) and routes the sub's
	 * completion through onAsyncAgentDone. No-op for unknown ids — an async
	 * run, an already-settled sync run, or another agent kind (delegate/goal
	 * subs don't register).
	 */
	private detachSubAgent(agentId: string): void {
		const fire = this.detachables.get(agentId);
		if (!fire) {
			this.send({ type: "log", level: "info", message: `detach_agent: ${agentId.slice(0, 8)} is not a detachable (sync run_agent) sub-agent` });
			return;
		}
		this.send({ type: "log", level: "info", message: `detaching sub-agent ${agentId.slice(0, 8)} to background — its result will arrive as an [async-agent] message` });
		fire();
	}

	/**
	 * Pending steer/followup depths for the main agent's toolbar counters.
	 * pi's queues are TS-private with no size accessor (only a boolean
	 * hasQueuedMessages), so read the internal arrays reflectively — the dep is
	 * version-pinned in package.json, and a shape change degrades to 0 (the
	 * counts simply stop updating, nothing breaks).
	 */
	private queueCounts(): { steer: number; followup: number } {
		const a = this.agent as unknown as
			| { steeringQueue?: { messages: unknown[] }; followUpQueue?: { messages: unknown[] } }
			| undefined;
		return { steer: a?.steeringQueue?.messages.length ?? 0, followup: a?.followUpQueue?.messages.length ?? 0 };
	}

	/** Push current queue depths to the server (drives the UI counters). */
	private emitQueueState(): void {
		this.send({ type: "queue_state", ...this.queueCounts() });
	}

	/**
	 * (Re)build the main agent from the current `mode` + discovered agents/skills/
	 * vars, preserving the given history. plan → toolAccess "R" + plan directive.
	 */
	private buildAgent(initialMessages: AgentMessage[]): void {
		if (!this.providerRuntime || !this.vars) return;
		const toolAccess = this.mode === "plan" ? "R" : "RW";
		const mainAgentName = this.cfg.projectConfig.agent ?? "system";
		const base = this.cfg.projectConfig.systemPrompt ?? resolveAgentPrompt(this.agents, mainAgentName, this.vars);
		// Project instructions are NOT composed here anymore: every
		// ClownfishAgent (main included) loads its own CLAUDE.md/AGENT.md chain
		// (root → cwd) at construction — nothing is passed between agents.
		// Plan mode strips the delegation/demo directives along with the tools
		// they describe: "you have no write tools" must not sit beside "delegation
		// is run_agent" (finding 6, docs/TOOLS.md audit).
		const baseSystemPrompt =
			this.mode === "plan" ? base + PLAN_DIRECTIVE + this.memoryBlock : base + WORKFLOW_DIRECTIVE + DEMO_DIRECTIVE + this.memoryBlock;
		const thinkingLevel = resolveThinking(this.cfg.projectConfig.thinking);
		// Tool-call hook, installed in every mode: ask-mode approval gate (write tools)
		// + checkpoint capture (write/edit pre-images). pi awaits beforeToolCall, so in
		// ask mode the run parks until the user decides (or abort/timeout denies).
		const mcpToolsForModes = this.mcp?.tools ?? [];
		this.toolModes = new Map<string, "R" | "W" | "RW">();
		for (const d of [...createCodingToolDefinitions(this.cfg.cwd), createSkillTool(() => this.skills), ...mcpToolsForModes]) {
			this.toolModes.set(d.name, toolMode(d));
		}
		this.toolModes.set(RUN_AGENT_NAME, "W");
		this.toolModes.set("todo", "R");
		this.toolModes.set("memory", "W");
		// Assistant sessions: the cross-session tools. `session_send` is W (ask
		// mode gates it); `sessions`/`session_read` are R and survive plan mode.
		const sessionControlTools = this.cfg.projectConfig.sessionControl
			? createSessionControlTools({
					control: (action, payload) => this.sessionControl(action, payload),
				})
			: [];
		for (const d of sessionControlTools) this.toolModes.set(d.name, toolMode(d));
		const beforeToolCall = this.makeBeforeToolCall();
		// Session-bus tap shared by delegate + workflow + goal + boot-resume:
		// forward every frame, tracking spawned-agent liveness (agent_spawned ↔
		// agent_ended always pair) for the shutdown grace window.
		const onBusFrame = (frame: WorkerFrame): void => {
			this.foldBusFrame(frame);
			this.send(frame);
		};
		// run_agent is mode "W" → dropped under toolAccess "R", so in plan mode the
		// orchestrator can only plan, not delegate. The hook is inherited so
		// sub-agent mutations are gated/checkpointed too. Streams to the bus under
		// the sub-agent's own agentId (activity tree + drill-in), like delegate.
		const { tool: runAgentTool, verifyTurn } = createRunAgentTool({
			agents: this.agents,
			runtime: this.providerRuntime,
			// Seeds a per-delegation `model` override (same provider, credentials/
			// baseUrl/contextWindow carried over) — see run-agent-tool.ts.
			baseProviderConfig: this.cfg.projectConfig,
			cwd: this.cfg.cwd,
			skills: this.skills,
			vars: this.vars,
			sessionId: this.cfg.sessionId,
			sessionsDir: this.cfg.sessionsDir,
			agentId: this.agentId,
			// Lazy: read at delegation time (the conversation keeps growing after
			// this tool is built) → the digest reflects the moment of handoff.
			parentMessages: () => this.agent?.state.messages ?? [],
			onFrame: onBusFrame,
			beforeToolCall,
			// Sub-agents get the MCP toolset too (but never run_agent), so a specialist
			// is not silently less capable than the orchestrator that delegated to it.
			extraTools: this.mcp?.tools ?? [],
			toolOverrides: this.toolOverrides,
			thinkingLevel,
			todos: this.todos,
			log: (message) => this.send({ type: "log", level: "info", message }),
			warn: (message) => {
				this.send({ type: "log", level: "warn", message });
				// A whole-tree rollback is not routine: it also reaches the UI as a
				// `notice` rather than an `error`, which would reject pending acks.
				this.send({ type: "notice", message });
			},
			// async: true runs — inject the settled result back into the main
			// agent as a bracketed user message + wake (same mechanism as goals).
			onAsyncDone: (info) => this.onAsyncAgentDone(info),
			// User "转后台": the detachables registry powers detach_agent.
			onDetachable: this.registerDetachable,
		});
		this.verifyTurn = verifyTurn;
		// The main agent is the sync dagRoot (depth 0) when it drives a plan itself.
		// delegate spawns DAG-bound sub-agents (depth+1) that stream to the bus.
		const delegateTool = !DAG_TOOLS_ENABLED ? undefined : createDelegateTool({
			...this.workflowDeps(),
			depth: 0,
			beforeToolCall,
			onFrame: onBusFrame,
		});
		// Deterministic multi-agent fan-out: the main agent writes a workflow
		// script; the vendored engine runs it while `agent()` spawns run_agent-
		// style sub-agents and `llm()` makes tmpLLM side calls. Synchronous
		// (the turn blocks, progress streams via tool updates). Main only —
		// sub-agents never see it, so workflows don't recurse.
		const workflowTool = !WORKFLOW_SCRIPT_ENABLED ? undefined : createWorkflowTool({
			agents: this.agents,
			runtime: this.providerRuntime,
			cwd: this.cfg.cwd,
			skills: this.skills,
			vars: this.vars,
			sessionId: this.cfg.sessionId,
			sessionsDir: this.cfg.sessionsDir,
			agentId: this.agentId,
			onFrame: onBusFrame,
			beforeToolCall,
			beforeToolCallFor: (agentId) => this.makeBeforeToolCall(agentId),
		});
		// Goal-seeking loop on top of the same machinery: executor rounds + an
		// isolated read-only evaluator, until PASS / round cap / stall. Main only.
		const goalTool = !GOAL_TOOL_ENABLED ? undefined : createRunGoalTool({
			...this.workflowDeps(),
			sessionDir: join(this.cfg.sessionsDir, this.cfg.sessionId),
			beforeToolCall,
			onFrame: onBusFrame,
		});
		// HTML demo publisher — main only (the reply layer is the main agent's).
		const drawDemoTool = createDrawDemoTool({
			projectId: this.cfg.projectId,
			sessionId: this.cfg.sessionId,
			sessionsDir: this.cfg.sessionsDir,
		});
		// Self-scheduling: the agent writes job SPECS into its own session dir
		// (cron.json); the server-side Scheduler picks them up and fires them as
		// background turns. Spec (worker-owned) and progress (server-owned,
		// <dataDir>/cron-state.json) never share a file.
		const cronTool = createCronTool({
			sessionId: this.cfg.sessionId,
			sessionsDir: this.cfg.sessionsDir,
		});
		// Closing half of the worktree lifecycle: executes the user's
		// merge/keep/discard answer for a finished async coding run. Main only.
		const worktreeDecideTool = createWorktreeDecideTool({ dags: this.dags, cwd: this.cfg.cwd });
		const mcpTools = this.mcp?.tools ?? [];
		this.agent = new ClownfishAgent({
			cwd: this.cfg.cwd,
			runtime: this.providerRuntime,
			skills: this.skills,
			sessionId: this.cfg.sessionId,
			// Outside-workspace paths need the user's consent (fs-jail policy).
			jailApproval: this.makeJailApproval(),
			baseSystemPrompt,
			initialMessages,
			toolAccess,
			toolOverrides: this.toolOverrides,
			thinkingLevel,
			// Admin-registry tool disables apply to the main agent (coding tools,
			// skill tool, and every extra below — DAG tools included).
			disableTools: [...this.disabledToolNames],
			extraTools: [
				runAgentTool,
				...(delegateTool ? [delegateTool] : []),
				...(workflowTool ? [workflowTool] : []),
				...(goalTool ? [goalTool] : []),
				drawDemoTool,
				cronTool,
				...(WORKFLOW_SCRIPT_ENABLED || GOAL_TOOL_ENABLED ? [worktreeDecideTool] : []),
				...sessionControlTools,
				...(DAG_TOOLS_ENABLED ? createDagTools({ dags: this.dags, agentId: this.agentId, seeAllTrees: true }) : []),
				// Only the TOP-LEVEL agent gets `todo` and `memory`: several sub-agents
				// rewriting one shared plan would race, and a specialist writing
				// cross-session memory from inside a sub-task is not what memory is for.
				createTodoTool(this.todos!),
				createMemoryTool({
					dataDir: this.cfg.dataDir,
					projectId: this.cfg.projectId,
					sessionId: this.cfg.sessionId,
					onChange: () => {
						// Refresh the injected block so a memory written this turn is in
						// the prompt for the next one, not only after a restart.
						void new MemoryStore(memoryRoot(this.cfg.dataDir))
							.promptBlock(this.cfg.projectId)
							.then((b) => {
								this.memoryBlock = b;
							})
							.catch(() => undefined);
					},
				}),
				...mcpTools,
			],
			beforeToolCall,
			onEvent: (event) => {
				this.updateRunState(event);
				// Held back only for the outbound frame — verification is part of the
				// turn, so `agent_end` waits for the verdict. Internal state,
				// persistence and compaction still settle on time.
				if (event.type === "agent_end" && this.holdAgentEnd) this.heldAgentEnd = event;
				else this.send({ type: "event", event, agentId: this.agentId });
				// Persist INCREMENTALLY: a long turn (e.g. a sync workflow tool
				// that runs for many minutes) must be visible to a mid-run history
				// fetch and survive a worker death — flushing only at agent_end
				// leaves the transcript empty for the turn's whole duration.
				// agent_start flushes the just-added user message; message_end /
				// tool_execution_end are where a complete message lands in
				// state.messages. agent_end additionally auto-compacts (≥75% full).
				if (event.type === "agent_start" || event.type === "message_end" || event.type === "tool_execution_end") {
					void this.schedulePersist();
				}
				// Queue counters: re-emit when a queued message drains into the
				// transcript (user-role message_end) and when the run settles
				// (followup depth may change at the stop boundary).
				if (event.type === "agent_end" || (event.type === "message_end" && event.message?.role === "user")) this.emitQueueState();
				if (event.type === "agent_end") this.pendingPersist = this.schedulePersist().finally(() => void this.maybeAutoCompact());
			},
		});
	}

	// ------------------------------------------------------------ lifecycle ----

	/** Flush persistence, deny pending approvals, close MCP. Never exits the process. */
	/**
	 * Run one turn, then — when the orchestrator did the work ITSELF — hand the
	 * result to the same `qa` verifier a delegation would have gone through.
	 *
	 * `run_agent` has run a framework-owned verification pass since we measured
	 * that the model never spends a delegation on one. But that pass only ever
	 * existed on the delegation path, and the orchestrator handles most work
	 * directly: on the phase-4 benchmark it solved all three tasks alone, in 12-14
	 * tool calls, and delegated zero times — so nothing verified any of it.
	 *
	 * OFF by default (`CLOWNFISH_VERIFY_TURN=auto|always`): it costs one extra model
	 * call per mutating turn, and measured on phase-4 it did not change the score.
	 */
	private async runTurn(text: string): Promise<void> {
		const agent = this.agent;
		if (!agent) return;
		const verifying = turnVerifyPolicy() !== "off" && this.verifyTurn !== undefined;
		// Hold the turn open across verification, and release it on every exit.
		if (verifying) this.holdAgentEnd = true;
		try {
			// Through runMainPrompt, not agent.prompt: it bridges the check→prompt
			// race that would otherwise drop a user message outright.
			await this.runMainPrompt(text);
		} catch (err) {
			this.releaseTurn();
			this.send({ type: "error", message: `run failed: ${err instanceof Error ? err.message : String(err)}` });
			return;
		}
		const policy = turnVerifyPolicy();
		if (policy === "off" || !this.verifyTurn) return this.releaseTurn();
		// A delegating turn was already verified by run_agent; a read-only turn
		// changed nothing to verify.
		if (policy === "auto" && (!this.turnMutated || this.turnDelegated)) return this.releaseTurn();
		if (this.turnVerifyRetries >= TURN_VERIFY_RETRIES) return this.releaseTurn();

		const answer = lastAssistantText(agent.state.messages);
		if (!answer) return this.releaseTurn();
		this.send({ type: "log", level: "info", message: "verifying this turn's work (qa)" });
		let result: { verdict: "pass" | "fail" | "unverified"; text: string };
		try {
			result = await this.verifyTurn({ task: text, answer });
		} catch (err) {
			// Verification is a safety net, never a new way for a turn to fail.
			this.send({ type: "log", level: "warn", message: `turn verification errored: ${err instanceof Error ? err.message : String(err)}` });
			return this.releaseTurn();
		}
		if (result.verdict !== "fail") {
			this.send({ type: "log", level: "info", message: `turn verification: ${result.verdict}` });
			return this.releaseTurn();
		}
		this.turnVerifyRetries++;
		this.send({ type: "notice", message: "验证未通过：qa 复核发现这一轮的工作还不完整，已把它的结论交回给智能体继续处理。" });
		// Feed the findings back as an ordinary turn; bounded by turnVerifyRetries.
		await this.runTurn(
			"An independent verification pass reviewed the work you just reported as done and found it INCOMPLETE.\n\n" +
				`--- ITS FINDINGS ---\n${result.text.slice(0, 4000)}\n--- END FINDINGS ---\n\n` +
				"Address what it found. Verify the fix yourself before reporting back, and say plainly if you disagree with a finding rather than making a change you believe is wrong.",
		);
	}

	/** Forward the `agent_end` held during verification, and stop holding. */
	private releaseTurn(): void {
		this.holdAgentEnd = false;
		const held = this.heldAgentEnd;
		this.heldAgentEnd = undefined;
		if (held) this.send({ type: "event", event: held, agentId: this.agentId });
	}

	/**
	 * Distil this finished session into memory. Runs once, on the way out, and
	 * swallows everything: a failed reflection must never cost a clean shutdown.
	 */
	private async reflect(): Promise<void> {
		if (this.reflected || !reflectionEnabled()) return;
		this.reflected = true;
		if (!this.providerRuntime || !this.agent || !this.vars) return;
		try {
			const written = await runReflection(
				{
					runtime: this.providerRuntime,
					agents: this.agents,
					dataDir: this.cfg.dataDir,
					cwd: this.cfg.cwd,
					vars: this.vars,
					projectId: this.cfg.projectId,
					sessionId: this.cfg.sessionId,
				},
				this.agent.state.messages,
			);
			if (written.length > 0) {
				this.send({ type: "log", level: "info", message: `reflection wrote ${written.length} memor(ies): ${written.join(", ")}` });
			}
		} catch {
			/* never throw into the shutdown path */
		}
	}

	async shutdown(opts?: { reflect?: boolean }): Promise<void> {
		this.shuttingDown = true;
		for (const t of this.reDriveTimers.values()) clearTimeout(t);
		this.reDriveTimers.clear();
		// An in-flight MAIN turn is persisted message-by-message, but the
		// currently-streaming message lands only via its abort path — exiting
		// under it would drop that partial, so abort first and give the
		// (short) abort path a moment to settle before the grace loop.
		if (this.agent?.state.isStreaming) this.agent.abort();
		if (this.pendingPersist) await this.pendingPersist.catch(() => {});
		// A background workflow mid-run owns transcripts + the shared DAG — give it
		// a grace window to settle (it persists on its own finally). Not fatal if it
		// overruns: dag.json + its transcript are already append-persisted.
		for (let i = 0; i < 100 && (this.busyAgents > 0 || this.agent?.state.isStreaming); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		for (const settle of this.pendingApprovals.values()) settle(false);
		this.pendingApprovals.clear();
		// Bounded, and never allowed to wedge the exit.
		if (opts?.reflect) await this.reflect();
		await closeMcpConnections(this.mcp);
	}

	/**
	 * (Re)discover the asset set: registry-filtered skills + agent prompts +
	 * MCP tools. Idempotent and hot-reloadable — boot and the reload_assets
	 * command share it. MCP connections are REUSED when the live server set is
	 * unchanged (a prompt toggle shouldn't respawn every stdio server).
	 */
	private async loadAssets(): Promise<void> {
		// Admin registry: disabled assets (agents/skills/tools/plugins) are
		// filtered out of the active set; re-enabling is lossless.
		const registry = await loadRegistry(this.cfg.dataDir);
		const disabledAgents = disabledSet(registry, "agents");
		const disabledSkills = disabledSet(registry, "skills");
		const disabledPlugins = [...disabledSet(registry, "plugins")];
		this.disabledToolNames = disabledSet(registry, "tools");

		// Skills: global (~/.clownfish/skills + plugins), then project (low→high).
		const { roots: skillRoots, notes: skillNotes } = await discoverSkillRoots({
			dataDir: this.cfg.dataDir,
			cwd: this.cfg.cwd,
			projectSkillsDirs: this.cfg.projectConfig.skillsDirs,
			disabledPlugins,
		});
		for (const note of skillNotes) this.send({ type: "log", level: "info", message: note });
		const loader = new SkillLoader(skillRoots, this.cfg.cwd);
		this.skills = (await loader.load()).filter((skill) => !disabledSkills.has(skill.name));
		this.send({ type: "log", level: "info", message: `loaded ${this.skills.length} skill(s) from ${skillRoots.length} root(s)` });
		this.providerRuntime = resolveRuntime(this.cfg.projectConfig);
		if (this.cfg.projectConfig.contextWindow) {
			const eff = (this.providerRuntime.model as { contextWindow?: number }).contextWindow;
			this.send({ type: "log", level: "info", message: `context window capped at ${eff} tokens (project setting)` });
		}

		// Agent prompts: built-in (lowest) → global → project (name-override wins).
		const builtinAgentsDir = this.opts.builtinAgentsDir ?? fileURLToPath(new URL("./agents/builtin", import.meta.url));
		const agentRoots = await discoverAgentRoots({ builtinDir: builtinAgentsDir, dataDir: this.cfg.dataDir, cwd: this.cfg.cwd, disabledPlugins });
		this.agents = (await new AgentLoader(agentRoots).load()).filter((a) => !disabledAgents.has(a.name));
		// External CLI agents come from the settings-owned config, not `.md`
		// roots: `<dataDir>/cli-agents.json` (see agent/agents/cli-config.ts).
		// Gated by CLOWNFISH_CLI_SUBAGENTS; unavailable binaries are dropped
		// with a note rather than offered as a `type` that can only fail.
		const cliDefs = await loadCliAgentDefinitions(this.cfg.dataDir);
		for (const note of cliDefs.notes) this.send({ type: "log", level: "info", message: note });
		this.agents.push(...cliDefs.defs.filter((d) => !disabledAgents.has(d.name) && !this.agents.some((a) => a.name === d.name)));
		this.send({ type: "log", level: "info", message: `loaded ${this.agents.length} agent(s) from ${agentRoots.length} root(s)` });

		// MCP servers: global <dataDir>/mcp.json + project <cwd>/.mcp.json (trusted
		// only with CLOWNFISH_MCP_PROJECT=1 — it executes that file's commands).
		const mcpCfg = await loadMcpConfigs({ dataDir: this.cfg.dataDir, cwd: this.cfg.cwd });
		for (const note of mcpCfg.notes) this.send({ type: "log", level: "info", message: note });
		// A disabled MCP server is not even connected (its tools map 1:1 to the
		// process it spawns) — the registry keys servers alongside builtin tools.
		const liveServers = Object.fromEntries(Object.entries(mcpCfg.servers).filter(([name]) => !this.disabledToolNames.has(name)));
		const serversJson = JSON.stringify(liveServers);
		if (serversJson !== this.mcpServersJson || !this.mcp) {
			await closeMcpConnections(this.mcp);
			this.mcpServersJson = serversJson;
			this.mcp = await connectMcpServers(liveServers);
			for (const note of this.mcp.notes) this.send({ type: "log", level: "info", message: note });
		}
		this.send({ type: "log", level: "info", message: `mcp: ${this.mcp.tools.length} tool(s) available` });
	}

	/** Swap in a freshly discovered asset set and rebuild the agent around its live history (mode, memory block and DAG state are re-read by buildAgent). */
	private async reloadNow(): Promise<void> {
		await this.loadAssets();
		if (this.vars) this.vars = { ...this.vars, date: new Date().toISOString().slice(0, 10) };
		const agent = this.agent;
		if (agent) this.buildAgent(agent.state.messages);
		this.send({ type: "log", level: "info", message: `assets reloaded: ${this.agents.length} agent(s), ${this.skills.length} skill(s), ${this.mcp?.tools.length ?? 0} mcp tool(s)` });
	}

	/** Discover everything, rebuild context, build the agent, report ready. */
	async boot(): Promise<void> {
		this.send({ type: "register", sessionId: this.cfg.sessionId, agentId: this.agentId });
		this.ensureMainEntry();

		// Session isolation: bash commands must not reference the dataDir /
		// sessionsDir roots (other sessions' transcripts, settings.json secrets,
		// memory). Structured tools are jailed per-agent to their own cwd in
		// fs-jail.ts; the deny roots are process-level, so set them before any
		// agent (main or sub) can run a command.
		setIsolationRoots([this.cfg.dataDir, this.cfg.sessionsDir]);

		await this.loadAssets();

		const real = await this.tx.load();
		this.writtenReal = real.length;
		// Only a session with no prior transcript is eligible for auto-titling.
		this.titleGenerated = real.length > 0;

		this.vars = {
			cwd: this.cfg.cwd,
			project: this.cfg.projectName,
			sessionId: this.cfg.sessionId,
			date: new Date().toISOString().slice(0, 10),
			os: process.platform,
		};

		this.mode = this.cfg.mode ?? "auto";
		this.checkpoints = new CheckpointStore(join(this.cfg.dataDir, "checkpoints", this.cfg.sessionId), this.cfg.cwd);
		// Session plan: persisted per session, restored on boot, broadcast on change.
		this.todos = new TodoStore(this.cfg.sessionsDir, this.cfg.sessionId, (items) => this.send({ type: "todos", items }));
		await this.todos.load();
		// Cross-session memory + operator tool-prompt overrides, both read once per
		// boot: a running worker keeps the prompt it started with.
		this.toolOverrides = await loadToolOverrides(this.cfg.dataDir);
		this.commands = await loadCommands(await discoverCommandRoots({ dataDir: this.cfg.dataDir, cwd: this.cfg.cwd }));
		this.send({ type: "log", level: "info", message: `commands: ${this.commands.length}` });

		// Shared DAG state: hydrate from the sidecar (if a prior run persisted one),
		// then re-persist on every mutation. Constructed before buildAgent so the
		// main agent's scoped DAG tools can reference it.
		this.dags = new DagStore(
			(data) => this.tx.writeDag(data),
			// Replan protection: a child whose owner is a live spawned agent must
			// not be deleted out from under it (see DagStore.replanChildren).
			(agentId) => this.liveAgents.has(agentId),
		);
		const dagData = await this.tx.loadDag();
		if (dagData) {
			this.dags.hydrate(dagData);
			this.send({ type: "log", level: "info", message: `resumed DAG state (${(dagData as { dags?: unknown[] }).dags?.length ?? 0} plan(s))` });
		}

		// Resume interrupted goal loops: every goal still "running" gets a fresh
		// goalRoot continuing at the recorded round (its spawn happens after
		// buildAgent so the resumed briefing sees current skills/vars).
		{
			const resumed = await resumeGoals(
				{ ...this.workflowDeps(), beforeToolCall: this.makeBeforeToolCall(), onFrame: this.onBusFrameForBoot() },
				join(this.cfg.sessionsDir, this.cfg.sessionId),
			);
			if (resumed > 0) this.send({ type: "log", level: "info", message: `resumed ${resumed} interrupted goal loop(s)` });
		}

		// Cross-session memory, written by the agent itself: injected as a `## Memory`
		// block in the system prompt. Read BEFORE buildAgent so the first build
		// already carries it; mode switches re-run buildAgent with the same block.
		await this.refreshMemoryBlock();

		// Compaction: context = summary + real[offset:] (the file keeps everything).
		const compact = await this.tx.loadCompact();
		let initialMessages: AgentMessage[];
		if (compact) {
			this.compactOffset = compact.offset;
			this.summaryMsg = makeSummaryMessage(compact.summary);
			this.hasSummary = true;
			initialMessages = [this.summaryMsg, ...real.slice(this.compactOffset)];
			const recent = Math.max(0, real.length - this.compactOffset);
			this.send({ type: "log", level: "info", message: `resumed compacted context (offset=${this.compactOffset}, ${recent} recent)` });
		} else {
			initialMessages = real;
		}

		this.buildAgent(initialMessages);

		this.send({ type: "ready" });
		this.send({ type: "log", level: "info", message: `ready (${real.length} history messages, mode=${this.mode})` });
	}
}
