/**
 * AgentManager — owns the lifecycle of per-session agent worker processes.
 *
 * Each session's agent runs in its own child process (soon: sandbox), driven over
 * the Unix-domain WebSocket. The agent is independent of any chat UI: it runs to
 * completion even with zero subscribers, and is reaped only by the idle TTL or an
 * operator stop. Browser sockets subscribe to a session; the manager fans the
 * worker's events out to every subscriber and reconstructs in-flight state for
 * late joiners.
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Project, SessionMeta, SessionBackend } from "../server/protocol";
import { WebSocket } from "ws";
import { deliver, fanOut, mapEventToFrames, snapshotToFrames } from "./proxy";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ManagerFrame, WorkerFrame, WorkerSnapshot, WorkerSpawnConfig, PtyWorkerSpawnConfig, ExecutionMode } from "./protocol";
import { WORKER_CONFIG_ENV, PTY_WORKER_CONFIG_ENV } from "./protocol";
import { AgentRuntime } from "./runtime";
import { createLoopbackPair, type AgentSocket } from "./agent-socket";
import { logger } from "../server/logger";

/** How session agents run. */
export type AgentSpawnMode = "share" | "process" | "sandbox";

export interface AgentManagerOptions {
	dataDir: string;
	sessionsDir: string;
	udsPath: string;
	/** Absolute path to the worker entry module (run under tsx via execArgv). */
	workerModule: string;
	/**
	 * Path to a COMPILED worker binary (bun `--compile`) — the packaged-app
	 * path. When set it wins over `workerModule`, and the child is spawned
	 * directly instead of forked: fork would re-exec `process.execPath`, which
	 * in a compiled server binary is the SERVER. The fork's IPC channel is
	 * never used anyway — the worker speaks over the Unix-domain socket.
	 */
	workerBin?: string;
	/** Absolute path to the pty-worker entry module (agent/pty-worker.ts, or its
	 *  esbuild bundle — see the CLI-backed session path in `spawnCli`). */
	ptyWorkerModule: string;
	/** Compiled pty-worker binary, mirroring `workerBin`'s packaged-app path. */
	ptyWorkerBin?: string;
	/** Idle lifetime before graceful shutdown (0 = never reap). */
	idleTtlMs: number;
	/**
	 * Persist an auto-generated session title. The implementation should refuse to
	 * overwrite a title that's already set (manual rename wins). Returns the new
	 * meta when applied, or undefined when skipped/rejected. Optional: when absent,
	 * worker `set_title` frames are ignored.
	 */
	applySessionTitle?: (projectId: string, sessionId: string, title: string) => Promise<SessionMeta | undefined>;
	/**
	 * Persist that a CLI-backed session's external command has been spawned at
	 * least once — read back on the NEXT attach so a reopened session resumes
	 * instead of starting fresh (see `spawnCli`). Optional: when absent, a CLI
	 * session always launches plain (no resume flags).
	 */
	markCliSessionStarted?: (projectId: string, sessionId: string) => Promise<void>;
	/**
	 * Serve a session-control request from a worker (the assistant's cross-session
	 * tools — see agent/tools/sessions.ts). The implementation lives server-side:
	 * it owns the projects/sessions models and this manager's prompt-delivery
	 * path. `from` identifies the ASKING session; absent = the capability is off
	 * for every session and requests are refused.
	 */
	onSessionControl?: (
		from: { projectId: string; sessionId: string },
		req: { action: "list" | "send" | "read"; projectId?: string; sessionId?: string; text?: string; mode?: "steer" | "followup" },
	) => Promise<unknown>;
	/**
	 * How session agents run: "share" = in-process runtime on a loopback socket
	 * (saves a process per session), "process" = forked worker per session (default,
	 * crash-isolated), "sandbox" = isolated container service (not yet implemented —
	 * spawning fails with a clear error until a provider is wired in).
	 */
	spawnMode?: AgentSpawnMode;
}

type Status = "idle" | "starting" | "ready" | "busy" | "stopping" | "dead";

interface AgentRecord {
	projectId: string;
	sessionId: string;
	/** The session's main agent id (== sessionId). Subagents get their own ids. */
	agentId: string;
	child?: ChildProcess;
	ws?: AgentSocket;
	status: Status;
	pid?: number;
	busy: boolean;
	lastActivity: number;
	pinned: boolean;
	/**
	 * Browser sockets subscribed to this session → their agentId interest
	 * (`undefined` = whole session: main + every subagent + structural frames;
	 * an agentId = drill-in: only that agent's stream + structural frames).
	 */
	subscribers: Map<WebSocket, string | undefined>;
	idleTimer?: NodeJS.Timeout;
	/**
	 * Spawned agents (dagRoot/dagSub) alive right now, tracked from the
	 * agent_spawned/agent_ended lifecycle frames. A session running background
	 * workflows must NOT be idle-reaped even though the MAIN agent finished —
	 * its liveness is `busyAgents > 0`, so the reaper treats that as busy too.
	 */
	busyAgents: number;
	ready: boolean;
	readyPromise: Promise<AgentRecord>;
	readyResolve: (r: AgentRecord) => void;
	readyReject: (err: Error) => void;
	snapshotWaiters: Array<(s: WorkerSnapshot) => void>;
	/** Pending compaction ack (resolved on `compacted`, rejected on error/exit). */
	compactAck?: { resolve: () => void; reject: (e: Error) => void };
	/** Current execution mode (plan/auto/ask). */
	mode: ExecutionMode;
	/** Pending set_mode ack (resolved on `mode_changed`, rejected on error/exit). */
	modeAck?: { resolve: () => void; reject: (e: Error) => void };
	/** Callers awaiting `stop()`; resolved once the agent actually reaches "dead". */
	stopWaiters: Array<() => void>;
	/** How this session's agent runs. Absent = builtin (the default). */
	backend?: SessionBackend;
	/**
	 * CLI-backed (pty) sessions only: a capped ring of recent terminal output,
	 * replayed to a joining tab in place of the structured snapshot builtin
	 * sessions use (a pty has no agent tree/todos to reconstruct).
	 */
	ptyScrollback?: string;
}

/** Scrollback cap for a CLI-backed session (chars) — trimmed from the front. */
const PTY_SCROLLBACK_CAP = 200_000;

export interface AgentStatusInfo {
	sessionId: string;
	projectId: string;
	status: Status;
	busy: boolean;
	pid?: number;
	lastActivity: number;
	subscribers: number;
	pinned: boolean;
	mode: ExecutionMode;
}

const INACTIVE: WorkerSnapshot = { active: false, agents: [] };

const log = logger.child({ module: "manager" });

/** How long an `abort` frame gets to settle a busy run before SIGKILLing the
 *  worker (a wedged provider stream ignores the frame; killing is the only
 *  lever — the respawn path recovers the session from its transcript). */
const ABORT_KILL_GRACE_MS = 5_000;

export class AgentManager {
	private readonly records = new Map<string, AgentRecord>();
	private readonly browserToSession = new Map<WebSocket, string>();

	constructor(private readonly deps: AgentManagerOptions) {}

	private short(sid: string): string {
		return sid.slice(0, 8);
	}

	private buildSpawnConfig(project: Project, sessionId: string, mode: ExecutionMode): WorkerSpawnConfig {
		return {
			projectId: project.id,
			sessionId,
			// The main agent's cwd is always pinned at spawn: the project's
			// workspace, or <dataDir>/workspace for a project-less (global)
			// spawn — the server boot ensures that dir exists.
			cwd: project.path || join(this.deps.dataDir, "workspace"),
			projectName: project.name,
			projectConfig: { ...project.config },
			dataDir: this.deps.dataDir,
			sessionsDir: this.deps.sessionsDir,
			udsPath: this.deps.udsPath,
			mode,
		};
	}

	private newRecord(projectId: string, sessionId: string, backend?: SessionBackend): AgentRecord {
		let readyResolve!: (r: AgentRecord) => void;
		let readyReject!: (err: Error) => void;
		const readyPromise = new Promise<AgentRecord>((resolve, reject) => {
			readyResolve = resolve;
			readyReject = reject;
		});
		return {
			projectId,
			sessionId,
			agentId: sessionId,
			status: "idle",
			busy: false,
			busyAgents: 0,
			lastActivity: Date.now(),
			pinned: false,
			subscribers: new Map<WebSocket, string | undefined>(),
			ready: false,
			readyPromise,
			readyResolve,
			readyReject,
			snapshotWaiters: [],
			stopWaiters: [],
			mode: "auto",
			backend,
		};
	}

	/**
	 * Subscribe a browser socket. For a builtin session this is lazy init — opening
	 * a session only attaches it; the agent is spawned on the first prompt. A
	 * CLI-backed (pty) session has no "prompt" trigger — a terminal is spawned
	 * eagerly here instead, so the user sees the CLI's own banner/prompt
	 * immediately rather than a blank pane. `project` supplies the cwd for a
	 * fresh CLI spawn (unused once the record already exists). `agentId`
	 * (optional) sets the socket's interest — `undefined` = whole session, an
	 * agentId = drill-in to that agent's stream only (builtin sessions only).
	 */
	async attach(project: Project, sessionId: string, ws: WebSocket, agentId?: string, backend?: SessionBackend): Promise<void> {
		let r = this.records.get(sessionId);
		if (!r) {
			r = this.newRecord(project.id, sessionId, backend);
			this.records.set(sessionId, r);
		}
		// "dead" included: a CLI session's process can exit while a tab is still
		// watching (its record survives with a subscriber), and reopening that
		// tab reattaches to the SAME (dead) record rather than a fresh one — this
		// is the reopen path spawnCli's resume-flag logic is for.
		if (r.backend?.kind === "cli" && (r.status === "idle" || r.status === "dead")) {
			this.spawnCli(r, project, r.backend);
			await r.readyPromise.catch(() => undefined);
		}
		await this.subscribe(r, ws, agentId);
	}

	/** Return a live record for the session, spawning (or respawning) if needed. */
	async ensureAgent(project: Project, sessionId: string): Promise<AgentRecord> {
		for (;;) {
			const existing = this.records.get(sessionId);
			if (existing && (existing.status === "ready" || existing.status === "busy")) return existing;
			if (existing && existing.status === "starting") {
				// Another caller's spawn is in flight. The record may cycle through
				// several spawn attempts (failure → dead → retry) while we wait, so
				// loop on the CURRENT readyPromise until it settles into a state we
				// can act on — a single re-check could spawn over a live attempt.
				await existing.readyPromise.catch(() => undefined);
				continue;
			}
			if (existing && existing.status === "stopping") {
				// Let the outgoing worker finish dying first. Respawning onto a
				// record whose old child's "exit" handler is still pending would
				// let that handler clobber the new spawn's child/ready promise.
				// Bounded by the same deadline as stop()'s SIGKILL escalation.
				await new Promise<void>((resolve) => {
					existing.stopWaiters.push(resolve);
					setTimeout(resolve, 7000).unref?.();
				});
				continue;
			}
			const r = existing ?? this.newRecord(project.id, sessionId);
			if (!existing) this.records.set(sessionId, r);
			this.spawn(r, project);
			await r.readyPromise;
			return r;
		}
	}

	private spawn(r: AgentRecord, project: Project): void {
		r.status = "starting";
		r.ready = false;
		r.busy = false;
		// A fresh worker has no spawned agents; a stale positive count from the
		// previous incarnation would block idle-reaping forever.
		r.busyAgents = 0;
		r.lastActivity = Date.now();
		r.readyPromise = new Promise<AgentRecord>((resolve, reject) => {
			r.readyResolve = resolve;
			r.readyReject = reject;
		});
		const cfg = this.buildSpawnConfig(project, r.sessionId, r.mode);
		const spawnMode = this.deps.spawnMode ?? "process";
		if (spawnMode === "share") return this.spawnShared(r, cfg);
		if (spawnMode === "sandbox") {
			r.status = "dead";
			r.readyReject(new Error('spawn mode "sandbox" is not implemented yet (E2B-style container isolation)'));
			return;
		}
		let child: ChildProcess;
		try {
			const env = { ...process.env, [WORKER_CONFIG_ENV]: JSON.stringify(cfg) };
			if (this.deps.workerBin) {
				// Compiled worker (bun --compile): spawn the binary itself. No
				// ipc channel — the worker connects back over the Unix socket.
				child = spawn(this.deps.workerBin, [], {
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				// spawn() reports a missing/non-executable binary ASYNCHRONOUSLY
				// (ENOENT fires 'error', never 'exit'); without a listener that
				// is an unhandled 'error' event — it takes the whole server down
				// and leaves ensureAgent awaiting a readyPromise forever.
				child.on("error", (err) => {
					log.error("worker binary failed to spawn: %s", err instanceof Error ? err.message : String(err));
					this.onChildExit(r, child, null, null);
				});
			} else {
				// A prebuilt bundle entry (.js/.mjs) runs under plain node: inheriting
				// the server's tsx loader flags would re-pay the ~1.2s tsx bootstrap
				// the bundle exists to skip (see scripts/bench-spawn.ts). Source
				// entries keep them — they need the loader to parse TypeScript.
				const prebuilt = /\.[cm]?js$/.test(this.deps.workerModule);
				child = fork(this.deps.workerModule, [], {
					execArgv: prebuilt ? [] : process.execArgv,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				});
			}
		} catch (err) {
			r.status = "dead";
			r.readyReject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		r.child = child;
		r.pid = child.pid;
		const tag = `[agent:${this.short(r.sessionId)}]`;
		child.stdout?.on("data", (d: Buffer) => process.stdout.write(`${tag} ${d}`));
		child.stderr?.on("data", (d: Buffer) => process.stderr.write(`${tag} ${d}`));
		child.on("exit", (code, signal) => this.onChildExit(r, child, code, signal));
	}

	/**
	 * CLI-backed session: fork agent/pty-worker.ts instead of the builtin
	 * AgentRuntime worker. That process owns spawning the external command under
	 * a real pty and only pumps its bytes over the same UDS transport — no
	 * AgentEvent/AgentRuntime involved at all.
	 */
	private spawnCli(r: AgentRecord, project: Project, backend: Extract<SessionBackend, { kind: "cli" }>): void {
		r.status = "starting";
		r.ready = false;
		r.busy = false;
		r.busyAgents = 0;
		r.lastActivity = Date.now();
		r.ptyScrollback = "";
		r.readyPromise = new Promise<AgentRecord>((resolve, reject) => {
			r.readyResolve = resolve;
			r.readyReject = reject;
		});
		// First launch ever: plain command, nothing to resume yet. Every launch
		// after that (a reopened tab, an idle-reap respawn, a crash restart) is a
		// REOPEN — append that preset's own resume flags instead of starting a
		// brand new conversation. `preset` is a stable machine marker set at
		// session-creation time, independent of the user-editable `label`.
		const args = backend.started
			? backend.preset === "codex"
				? ["resume", "--last", ...(backend.args ?? [])]
				: backend.preset === "claude"
					? ["--continue", ...(backend.args ?? [])]
					: (backend.args ?? [])
			: (backend.args ?? []);
		if (!backend.started) {
			// Mutate the in-memory record NOW (a respawn on the SAME record, e.g.
			// after the process exited but a subscriber kept it alive, must see
			// this immediately) and persist it so the NEXT attach's fresh record
			// (built from the reloaded session meta) sees it too.
			r.backend = { ...backend, started: true };
			void this.deps.markCliSessionStarted?.(r.projectId, r.sessionId).catch(() => undefined);
		}
		const cfg: PtyWorkerSpawnConfig = {
			sessionId: r.sessionId,
			cwd: project.path || join(this.deps.dataDir, "workspace"),
			command: backend.command,
			args,
			env: backend.env,
			udsPath: this.deps.udsPath,
		};
		let child: ChildProcess;
		try {
			const env = { ...process.env, [PTY_WORKER_CONFIG_ENV]: JSON.stringify(cfg) };
			if (this.deps.ptyWorkerBin) {
				child = spawn(this.deps.ptyWorkerBin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
				child.on("error", (err) => {
					log.error("pty-worker binary failed to spawn: %s", err instanceof Error ? err.message : String(err));
					this.onChildExit(r, child, null, null);
				});
			} else {
				const prebuilt = /\.[cm]?js$/.test(this.deps.ptyWorkerModule);
				child = fork(this.deps.ptyWorkerModule, [], {
					execArgv: prebuilt ? [] : process.execArgv,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				});
			}
		} catch (err) {
			r.status = "dead";
			r.readyReject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		r.child = child;
		r.pid = child.pid;
		const tag = `[cli:${this.short(r.sessionId)}]`;
		child.stdout?.on("data", (d: Buffer) => process.stdout.write(`${tag} ${d}`));
		child.stderr?.on("data", (d: Buffer) => process.stderr.write(`${tag} ${d}`));
		child.on("exit", (code, signal) => this.onChildExit(r, child, code, signal));
	}

	/** Called once a worker (UDS socket or share-mode loopback) sends its `register` frame. */
	attachWorker(sessionId: string, ws: AgentSocket, agentId?: string): void {
		const r = this.records.get(sessionId);
		if (!r || r.status === "dead") {
			ws.close(1008, "no such agent");
			return;
		}
		// A worker is already registered (duplicate register frame, or two workers
		// racing for one session). Keep the live one; the extra connection would
		// otherwise interleave frames from two runtimes on the same record.
		if (r.ws && r.ws.readyState === WebSocket.OPEN) {
			ws.close(1008, "agent already registered");
			return;
		}
		if (agentId) r.agentId = agentId;
		r.ws = ws;
		ws.on("message", (data) => this.onWorkerMessage(r, data));
		const onClose = (): void => this.onWorkerClose(r, ws);
		ws.on("close", onClose);
		ws.on("error", onClose);
	}

	private send(r: AgentRecord, frame: ManagerFrame): void {
		if (r.ws && r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify(frame));
	}

	private onWorkerMessage(r: AgentRecord, data: unknown): void {
		let frame: WorkerFrame;
		try {
			frame = JSON.parse(String(data)) as WorkerFrame;
		} catch {
			return;
		}
		switch (frame.type) {
			case "ready":
				r.status = "ready";
				r.ready = true;
				r.lastActivity = Date.now();
				r.readyResolve(r);
				return;
			case "event":
				this.onEvent(r, frame.event, frame.agentId ?? r.agentId);
				return;
			case "snapshot": {
				const waiters = r.snapshotWaiters;
				r.snapshotWaiters = [];
				for (const w of waiters) w(frame.snapshot);
				return;
			}
			case "persisted":
				r.lastActivity = Date.now();
				return;
			case "log":
				(frame.level === "error" ? log.error : log.info)({ session: this.short(r.sessionId) }, "%s", frame.message);
				return;
			case "error":
				log.error({ session: this.short(r.sessionId) }, "worker error: %s", frame.message);
				// "run failed:" is sent only after the main turn definitively died
				// (runMainPrompt rejected). pi-agent-core emits agent_end on failure
				// paths, but an exception inside an event listener can swallow it —
				// without this reset the session would answer "agent is busy" forever.
				if (frame.message.startsWith("run failed:") && r.busy) {
					r.busy = false;
					r.status = "ready";
					this.armIdle(r);
				}
				r.compactAck?.reject(new Error(frame.message));
				r.compactAck = undefined;
				r.modeAck?.reject(new Error(frame.message));
				r.modeAck = undefined;
				fanOut(r.subscribers, [{ type: "error", message: frame.message }]);
				return;
			case "compacted":
				r.compactAck?.resolve();
				r.compactAck = undefined;
				return;
			case "mode_changed":
				r.modeAck?.resolve();
				r.modeAck = undefined;
				// Fan out so other tabs pick the new mode up (the initiating tab
				// already set it optimistically via the REST response).
				fanOut(r.subscribers, [{ type: "mode_changed", mode: frame.mode }]);
				return;
			case "tool_approval":
				// Ask mode: fan the approval request out to the subscribed UIs.
				fanOut(r.subscribers, [
					{ type: "tool_approval", toolCallId: frame.toolCallId, toolName: frame.toolName, args: frame.args, agentId: frame.agentId ?? r.agentId },
				]);
				return;
			case "agent_spawned":
				// A subagent came into being — forward to UIs so they can subscribe to
				// it, and count it so idle-reaping spares a background-workflow worker.
				if (frame.kind !== "main") r.busyAgents++;
				fanOut(r.subscribers, [
					{ type: "agent_spawned", agentId: frame.agentId, parentAgentId: frame.parentAgentId, kind: frame.kind, label: frame.label, ...(frame.toolCallId ? { toolCallId: frame.toolCallId } : {}), ...(frame.name ? { name: frame.name } : {}) },
				]);
				return;
			case "agent_ended":
				r.busyAgents = Math.max(0, r.busyAgents - 1);
				// The last background agent ending may be what makes the worker
				// idle-reapable (the main turn often finished earlier, while
				// busyAgents still held the reaper off) — arm the timer now.
				if (r.busyAgents === 0 && !r.busy) this.armIdle(r);
				fanOut(r.subscribers, [{ type: "agent_ended", agentId: frame.agentId }]);
				return;
			case "session_control": {
				// Worker-initiated RPC: the assistant's tools asking the server to
				// list / message / read another session. Answer on the same ref.
				const req = { action: frame.action, projectId: frame.projectId, sessionId: frame.sessionId, text: frame.text, mode: frame.mode };
				const reply = (ok: boolean, data?: unknown, error?: string): void => {
					this.send(r, { type: "session_control_result", ref: frame.ref, ok, ...(ok ? { data } : { error }) });
				};
				if (!this.deps.onSessionControl) return reply(false, undefined, "session control is not available on this server");
				this.deps
					.onSessionControl({ projectId: r.projectId, sessionId: r.sessionId }, req)
					.then((data) => reply(true, data), (err) => reply(false, undefined, err instanceof Error ? err.message : String(err)));
				return;
			}
			case "queue_state":
				// Toolbar counters (pending steer / followup depths) → every tab.
				fanOut(r.subscribers, [{ type: "queue_state", steer: frame.steer, followup: frame.followup }]);
				return;
			case "heartbeat":
				return;
			case "todos":
				// The session plan changed — push it to every subscribed tab.
				fanOut(r.subscribers, [{ type: "todos", items: frame.items }]);
				return;
			case "notice":
				console.warn(`[agent:${this.short(r.sessionId)}] ${frame.message}`);
				fanOut(r.subscribers, [{ type: "notice", message: frame.message }]);
				return;
			case "set_title": {
				// Side-channel title from the worker (never part of the chat). Persist
				// it via the injected hook (which guards against clobbering a manual
				// rename) and push the new title to any subscribed UIs.
				const title = frame.title.trim();
				if (title && this.deps.applySessionTitle) {
					void this.deps
						.applySessionTitle(r.projectId, r.sessionId, title)
						.then((meta) => {
							if (meta?.title) fanOut(r.subscribers, [{ type: "session_meta", title: meta.title }]);
						})
						.catch(() => {
							/* best-effort; a failed rename must not disturb the run */
						});
				}
				return;
			}
			case "pty_data":
				r.lastActivity = Date.now();
				this.armIdle(r);
				r.ptyScrollback = ((r.ptyScrollback ?? "") + frame.data).slice(-PTY_SCROLLBACK_CAP);
				fanOut(r.subscribers, [{ type: "pty_data", data: frame.data }]);
				return;
			case "pty_exit":
				fanOut(r.subscribers, [{ type: "pty_exit", code: frame.code }]);
				return;
			default:
				return;
		}
	}

	private onEvent(r: AgentRecord, event: AgentEvent, agentId: string = r.agentId): void {
		// busy/idle tracking is the MAIN agent's lifecycle only; subagent events
		// (agentId !== r.agentId) must not flip the session's busy flag.
		const isMain = agentId === r.agentId;
		if (isMain) {
			if (event.type === "agent_start") r.busy = true;
			if (event.type === "agent_end") {
				r.busy = false;
				r.status = "ready";
				r.lastActivity = Date.now();
			}
		}
		fanOut(r.subscribers, mapEventToFrames(event, agentId));
		if (isMain && event.type === "agent_end") this.armIdle(r);
	}

	/**
	 * Share mode: run the AgentRuntime in-process on an in-memory loopback socket.
	 * The manager side is wired exactly like a UDS worker connection, so frames,
	 * snapshots, approvals and idle reaping all behave identically. Trade-off: no
	 * crash isolation — a runtime failure is contained per-frame, but a hard throw
	 * takes the server down (use "process" for isolation).
	 */
	private spawnShared(r: AgentRecord, cfg: WorkerSpawnConfig): void {
		const { a: serverEnd, b: agentEnd } = createLoopbackPair();
		this.attachWorker(r.sessionId, serverEnd);
		// Mirror the process path's child-exit handling when the runtime terminates.
		serverEnd.on("close", () => this.onSharedExit(r));
		const runtime = new AgentRuntime(cfg, {
			onFrame: (frame) => agentEnd.send(JSON.stringify(frame)),
			onTerminated: () => {
				agentEnd.close();
			},
		});
		agentEnd.on("message", (data) => {
			void runtime.handle(JSON.parse(String(data)) as ManagerFrame);
		});
		agentEnd.on("error", () => undefined);
		runtime.boot().catch((err) => {
			r.readyReject(err instanceof Error ? err : new Error(String(err)));
			agentEnd.close();
		});
	}

	/** Share-mode counterpart of onChildExit (no child process to observe). */
	private onSharedExit(r: AgentRecord): void {
		if (r.status === "dead") return;
		const crashed = r.ready;
		clearTimeout(r.idleTimer);
		r.ws = undefined;
		r.busy = false;
		r.busyAgents = 0;
		r.status = "dead";
		if (!r.ready) {
			r.readyReject(new Error("agent exited before ready"));
		} else if (crashed) {
			r.compactAck?.reject(new Error("agent exited"));
			r.compactAck = undefined;
			r.modeAck?.reject(new Error("agent exited"));
			r.modeAck = undefined;
			fanOut(r.subscribers, [{ type: "error", message: "agent exited" }]);
		}
		this.releaseStopWaiters(r);
		if (r.subscribers.size === 0) this.records.delete(r.sessionId);
	}

	private onWorkerClose(r: AgentRecord, ws: AgentSocket): void {
		// Only clear OUR socket: a superseded connection closing late must not
		// tear down the reference to the worker that replaced it.
		if (r.ws === ws) r.ws = undefined;
		// The child should exit on its own (shutdown) or already have; if it lingers,
		// the idle/stop path will reap it. Nothing else to do here.
	}

	private onChildExit(r: AgentRecord, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		// A respawned session forks a NEW child while the old one may still be
		// exiting (stop → prompt raced). The exit of a superseded child must not
		// mark the fresh worker's record dead.
		if (r.child !== child) return;
		const crashed = r.ready;
		clearTimeout(r.idleTimer);
		r.child = undefined;
		r.ws = undefined;
		r.busy = false;
		r.busyAgents = 0;
		r.status = "dead";
		if (!r.ready) {
			r.readyReject(new Error(`agent exited before ready (code=${code} signal=${signal ?? "none"})`));
		} else if (crashed) {
			r.compactAck?.reject(new Error("agent process exited"));
			r.compactAck = undefined;
			r.modeAck?.reject(new Error("agent process exited"));
			r.modeAck = undefined;
			// A CLI-backed session's process exiting without its own pty_exit frame
			// (killed, crashed) is still a normal end for the terminal, not a chat
			// error — tell the terminal view directly instead of the chat's error frame.
			if (r.backend?.kind === "cli") fanOut(r.subscribers, [{ type: "pty_exit", code }]);
			else fanOut(r.subscribers, [{ type: "error", message: `agent process exited (code=${code} signal=${signal ?? "none"})` }]);
		}
		this.releaseStopWaiters(r);
		if (r.subscribers.size === 0) this.records.delete(r.sessionId);
	}

	// -------------------------------------------------------------- browser ----

	/**
	 * Subscribe a browser socket: add it (with its interest), replay any in-flight
	 * main-agent turn, send ready. A drill-in interest (agentId set) still replays
	 * the main snapshot only — subagents have no separate snapshot (they stream live).
	 */
	async subscribe(r: AgentRecord, ws: WebSocket, interest?: string): Promise<void> {
		r.subscribers.set(ws, interest);
		this.browserToSession.set(ws, r.sessionId);
		// Attaching must not pin the worker either — (re)arm the idle countdown;
		// armIdle refuses while busy/streaming, so a mid-run join changes nothing.
		this.armIdle(r);
		if (r.backend?.kind === "cli") {
			// A pty has no agent tree/todos to reconstruct — replay the scrollback
			// buffer instead of requesting the builtin worker snapshot.
			if (r.ptyScrollback) deliver(ws, { type: "pty_data", data: r.ptyScrollback });
			deliver(ws, { type: "ready" });
			return;
		}
		const snap = await this.requestSnapshot(r);
		for (const frame of snapshotToFrames(snap, r.agentId)) deliver(ws, frame);
		deliver(ws, { type: "ready" });
	}

	/**
	 * Switch an already-subscribed socket's agentId interest without re-attaching
	 * (a UI drilling into a subagent's stream, or back out to the whole session).
	 * `agentId === undefined` restores the whole-session view.
	 */
	setInterest(ws: WebSocket, agentId?: string): void {
		const sid = this.browserToSession.get(ws);
		if (!sid) return;
		const r = this.records.get(sid);
		if (r && r.subscribers.has(ws)) r.subscribers.set(ws, agentId);
	}

	unsubscribe(ws: WebSocket): void {
		const sid = this.browserToSession.get(ws);
		if (!sid) return;
		this.browserToSession.delete(ws);
		const r = this.records.get(sid);
		if (r) {
			r.subscribers.delete(ws);
			// A never-spawned (idle) record with no viewers left is pure bookkeeping — drop it.
			if (r.status === "idle" && r.subscribers.size === 0) this.records.delete(sid);
			else this.armIdle(r);
		}
	}

	private requestSnapshot(r: AgentRecord): Promise<WorkerSnapshot> {
		return new Promise<WorkerSnapshot>((resolve) => {
			if (!r.ws || r.ws.readyState !== WebSocket.OPEN || r.status === "starting") return resolve(INACTIVE);
			let settled = false;
			const done = (s: WorkerSnapshot): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(s);
			};
			r.snapshotWaiters.push(done);
			this.send(r, { type: "snapshot" });
			const timer = setTimeout(() => done(INACTIVE), 2000);
		});
	}

	/** Ensure the agent is live, then send a prompt (rejects if mid-run). */
	async prompt(project: Project, sessionId: string, text: string, mode?: "steer" | "followup"): Promise<void> {
		const r = await this.ensureAgent(project, sessionId);
		// A mode-bearing prompt while busy is a QUEUE submission (steer injects
		// into the running loop, followup waits it out) — the worker decides.
		// Mode-less prompts keep the old contract: busy → hard error.
		if (r.busy && !mode) throw new Error("agent is busy; abort or wait for the current turn to finish");
		r.busy = true;
		this.disarmIdle(r);
		this.send(r, { type: "prompt", text, ...(mode ? { mode } : {}) });
	}

	/** User-initiated "转后台": convert a running SYNC run_agent sub to background
	 *  (its tool call resolves early; the result is injected as a message later).
	 *  No-op when the worker is down or the sub isn't a detachable sync run. */
	detachAgent(sessionId: string, agentId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		if (r.ws && r.ws.readyState === WebSocket.OPEN) this.send(r, { type: "detach_agent", agentId });
	}

	/** Best-effort abort of the in-flight turn (no-op if the agent isn't running). */
	abort(sessionId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		if (r.ws && r.ws.readyState === WebSocket.OPEN) this.send(r, { type: "abort" });
		// The abort frame only helps a RESPONSIVE worker — a run wedged on a
		// dead provider stream (no watchdog save yet) never drains its command
		// queue. Escalate: if the session is still busy after the grace window,
		// SIGKILL the worker. onChildExit marks it dead and the next prompt /
		// subscribe respawns it fresh — transcripts survive on disk.
		if (!r.busy || !r.child?.pid) return;
		const pid = r.child.pid;
		const grace = setTimeout(() => {
			const cur = this.records.get(sessionId);
			if (cur !== r || !r.busy || r.child?.pid !== pid) return;
			log.warn({ session: this.short(sessionId), pid }, "abort escalation: worker still busy after grace — SIGKILL");
			try {
				r.child?.kill("SIGKILL");
			} catch {
				/* onChildExit handles the rest */
			}
		}, ABORT_KILL_GRACE_MS);
		// Don't hold the loop / leak the timer if the run settles in time.
		grace.unref?.();
	}

	// ----------------------------------------------------------- operator ----

	async start(project: Project, sessionId: string): Promise<AgentStatusInfo> {
		const r = await this.ensureAgent(project, sessionId);
		return this.toInfo(r);
	}

	async run(project: Project, sessionId: string, text: string): Promise<AgentStatusInfo> {
		const r = await this.ensureAgent(project, sessionId);
		await this.prompt(project, sessionId, text);
		return this.toInfo(r);
	}

	/**
	 * Graceful stop. Resolves once the agent has actually terminated (status
	 * "dead"), so a caller — the REST endpoint, `shutdownAll` — can trust that the
	 * worker is gone on return rather than merely asked to leave. SIGKILL escalates
	 * after 5s; the wait is bounded by the same deadline so a wedged child can
	 * never hang the request.
	 */
	async stop(sessionId: string, reason: "stop" | "reap" | "server" = "stop"): Promise<boolean> {
		const r = this.records.get(sessionId);
		if (!r || r.status === "dead" || r.status === "idle") return false;
		const done = new Promise<void>((resolve) => r.stopWaiters.push(resolve));
		r.status = "stopping";
		r.pinned = false;
		// An operator stop is not a crash: without this, onChildExit reports
		// "agent process exited" to every subscriber of a graceful shutdown.
		r.ready = false;
		clearTimeout(r.idleTimer);
		this.send(r, { type: "shutdown", reason });
		const child = r.child;
		const timer = setTimeout(() => {
			if (child && r.status === "stopping" && !child.killed) child.kill("SIGKILL");
		}, 5000);
		void timer.unref?.();
		// SIGKILL lands at 5s; give the exit event a moment to propagate after it.
		await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 7000).unref?.())]);
		clearTimeout(timer);
		return true;
	}

	/** Release everyone awaiting `stop()` once the record has reached "dead". */
	private releaseStopWaiters(r: AgentRecord): void {
		const waiters = r.stopWaiters;
		r.stopWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Compact the session's context: fold older messages into a summary via the
	 * sys-compact sub-agent. Rejects if the agent isn't running or is mid-turn;
	 * resolves on the worker's `compacted` ack (including the nothing-to-compact
	 * no-op); rejects on worker error / exit / timeout.
	 */
	async compact(sessionId: string): Promise<void> {
		const r = this.records.get(sessionId);
		if (!r || r.status === "dead" || r.status === "idle") throw new Error("agent not running");
		if (!r.ws || r.ws.readyState !== WebSocket.OPEN) throw new Error("agent not connected");
		if (r.busy) throw new Error("agent is busy; compact after the current turn finishes");
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				r.compactAck = undefined;
				reject(new Error("compaction timed out"));
			}, 180000);
			r.compactAck = {
				resolve: () => {
					clearTimeout(timer);
					r.compactAck = undefined;
					resolve();
				},
				reject: (e: Error) => {
					clearTimeout(timer);
					r.compactAck = undefined;
					reject(e);
				},
			};
			this.send(r, { type: "compact" });
		});
	}

	/**
	 * Switch the session's execution mode (plan/auto/ask). The worker rebuilds the
	 * agent (tool access + persona) and acks via `mode_changed`. Rejects if not
	 * running / mid-turn / error / timeout; reverts the recorded mode on failure.
	 */
	async setMode(sessionId: string, mode: ExecutionMode): Promise<ExecutionMode> {
		const r = this.records.get(sessionId);
		if (!r || r.status === "dead") throw new Error("agent not running");
		if (r.status === "idle") {
			// Not spawned yet — record the mode; it takes effect when the worker boots.
			r.mode = mode;
			return Promise.resolve(mode);
		}
		if (!r.ws || r.ws.readyState !== WebSocket.OPEN) throw new Error("agent not connected");
		if (r.busy) throw new Error("agent is busy; switch mode after the current turn finishes");
		const prev = r.mode;
		r.mode = mode;
		return new Promise<ExecutionMode>((resolve, reject) => {
			const timer = setTimeout(() => {
				r.modeAck = undefined;
				r.mode = prev;
				reject(new Error("mode switch timed out"));
			}, 60000);
			r.modeAck = {
				resolve: () => {
					clearTimeout(timer);
					r.modeAck = undefined;
					resolve(r.mode);
				},
				reject: (e: Error) => {
					clearTimeout(timer);
					r.modeAck = undefined;
					r.mode = prev;
					reject(e);
				},
			};
			this.send(r, { type: "set_mode", mode });
		});
	}

	/**
	 * Hot-reload assets in every CONNECTED worker (admin panel writes — the
	 * registry and panel-edited files live in dataDir, global across projects).
	 * Idle workers swap immediately; busy ones defer to their next turn's first
	 * LLM request. Fire-and-forget — each worker logs its outcome; workers not
	 * yet booted pick the new state up at boot anyway.
	 */
	reloadAssets(): void {
		for (const r of this.records.values()) {
			if (r.ws && r.ws.readyState === WebSocket.OPEN) this.send(r, { type: "reload_assets" });
		}
	}

	/** Forward the user's approve/deny decision for a pending tool approval to the worker. */
	decideTool(sessionId: string, toolCallId: string, approved: boolean): void {
		const r = this.records.get(sessionId);
		if (r && r.ws && r.ws.readyState === WebSocket.OPEN) {
			this.send(r, { type: "tool_decision", toolCallId, approved });
		}
	}

	/** CLI-backed (pty) sessions only: forward keystrokes/paste to the pty's stdin. */
	sendPtyInput(sessionId: string, data: string): void {
		const r = this.records.get(sessionId);
		if (!r || !r.ws || r.ws.readyState !== WebSocket.OPEN) return;
		this.send(r, { type: "pty_input", data });
		// A pty session has no busy/idle turn concept — activity is typing, so
		// each keystroke resets the idle-reap countdown the same way a prompt does.
		r.lastActivity = Date.now();
		this.armIdle(r);
	}

	/** CLI-backed (pty) sessions only: the browser terminal's size changed. */
	sendPtyResize(sessionId: string, cols: number, rows: number): void {
		const r = this.records.get(sessionId);
		if (r && r.ws && r.ws.readyState === WebSocket.OPEN) this.send(r, { type: "pty_resize", cols, rows });
	}

	setPinned(sessionId: string, pinned: boolean): boolean {
		const r = this.records.get(sessionId);
		if (!r) return false;
		r.pinned = pinned;
		if (pinned) this.disarmIdle(r);
		else this.armIdle(r);
		return true;
	}

	status(sessionId: string): AgentStatusInfo | undefined {
		const r = this.records.get(sessionId);
		return r ? this.toInfo(r) : undefined;
	}

	list(): AgentStatusInfo[] {
		return [...this.records.values()].map((r) => this.toInfo(r));
	}

	private toInfo(r: AgentRecord): AgentStatusInfo {
		return {
			sessionId: r.sessionId,
			projectId: r.projectId,
			status: r.status,
			busy: r.busy,
			pid: r.pid,
			lastActivity: r.lastActivity,
			subscribers: r.subscribers.size,
			pinned: r.pinned,
			mode: r.mode,
		};
	}

	private armIdle(r: AgentRecord): void {
		clearTimeout(r.idleTimer);
		// busyAgents > 0 = a background workflow's dagRoot/dagSub agents are still
		// running in this worker — reaping it would kill them mid-flight.
		// Open tabs do NOT pin the worker: subscribers survive a reap on the
		// record, history comes from the REST transcript API, and the next
		// prompt lazily respawns (ensureAgent). Idle memory beats pinned RSS.
		if (r.pinned || this.deps.idleTtlMs <= 0 || r.busy || r.busyAgents > 0) return;
		r.idleTimer = setTimeout(() => {
			void this.stop(r.sessionId, "reap");
		}, this.deps.idleTtlMs);
	}

	private disarmIdle(r: AgentRecord): void {
		clearTimeout(r.idleTimer);
		r.idleTimer = undefined;
	}

	async shutdownAll(): Promise<void> {
		const sessions = [...this.records.keys()];
		await Promise.all(sessions.map((sid) => this.stop(sid, "server")));
	}
}
