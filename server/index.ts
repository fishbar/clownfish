/**
 * Clownfish server bootstrap: Express REST + WebSocket realtime + agent manager.
 *
 *  - REST under /api (projects, sessions, agent management, health).
 *  - Browser WebSocket at /chat (proxied to the session's agent worker).
 *  - Agent workers (one process per active session) over a Unix-domain WebSocket;
 *    the AgentManager owns their lifecycle.
 *  - Serves the built WebUI from ../dist when present (prod); in dev the
 *    Vite dev server proxies /api and /chat here.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import express from "express";
import { loadServerConfig } from "./config";
import { loadSettings, applySettings } from "../agent/settings";
import { ProjectManager } from "./models/projects";
import { createSessionStore } from "./models/sessions";
import { mkContext } from "./context";
import { createApiRouter } from "./controllers/router";
import { RealtimeHub } from "./controllers/realtime";
import { AgentManager } from "../agent";
import { startUds, type UdsServer } from "../agent";
import { toWireMessages } from "../agent/messages";
import { Scheduler } from "./scheduler";
import { runArchive, runBackup } from "./maintenance";
import { resolveTlsOptions } from "./tls";
import {
	loadAuthConfig,
	AuthConfigError,
	createAuthRouter,
	createAutologinRouter,
	requireAuth,
	authMeDisabled,
	type AuthConfig,
} from "./auth";
import { authAlreadyDecided, runAuthWizard } from "./auth/wizard";
import { logger } from "./logger";

const log = logger.child({ module: "server" });

// Process-level safety nets — installed only AFTER server.listen succeeds.
// A stray throw/rejection during normal operation (an Express handler that
// escapes, a WS event, a scheduler fire) must NOT take the whole server down —
// every session worker dies with it. Log loudly and keep going; the supervisor
// (systemd) is the restart layer, and these handlers are the "don't die from a
// bug" layer. Real errors still surface in the log stream.
//
// Boot failures are deliberately OUTSIDE this net: before listen() succeeds an
// uncaught error (EADDRINUSE from a stale process, missing dirs, bad config)
// must exit fatally — otherwise tsx-watch restarts linger as zombies that hold
// no port while the stale old build keeps serving requests.
function installSafetyNets(): void {
	process.on("uncaughtException", (err) => {
		log.error({ err }, "uncaughtException (suppressed — server continues)");
	});
	process.on("unhandledRejection", (reason) => {
		log.error({ err: reason instanceof Error ? reason : String(reason) }, "unhandledRejection (suppressed — server continues)");
	});
}

async function main(): Promise<void> {
	// Settings.json is the single home for provider endpoint + credentials.
	// Apply it to process.env (set-if-missing) before resolving any runtime, so
	// pi-ai's providers read the proxy base URL / auth token. Real env still wins.
	const config = loadServerConfig();
	const settings = loadSettings(config.dataDir);
	applySettings(settings);
	// Settings-level provider/model override the env-derived defaults on the
	// config object itself (health readout, anything reading ctx.config) — the
	// same precedence ProjectManager applies below for new projects.
	if (settings.provider) config.provider = settings.provider;
	if (settings.model) config.model = settings.model;

	// Transcript dir is configurable (settings.json > env > default ~/.clownfish/sessions).
	const sessionsDir = settings.sessionsDir ?? config.sessionsDir;

	// Ensure the data + transcript dirs exist before any store writes to them
	// (a missing parent surfaces as EACCES on Unix socket bind too).
	await mkdir(config.dataDir, { recursive: true });
	await mkdir(sessionsDir, { recursive: true });
	// Global skill/plugin homes (project-local ones live under each project path).
	// Created eagerly so users see where to drop ~/.clownfish/skills & plugins.
	await mkdir(join(config.dataDir, "skills"), { recursive: true });
	await mkdir(join(config.dataDir, "plugins"), { recursive: true });
	// Default cwd for project-less (global) agent spawns — pinned here so the
	// fallback in AgentManager.buildSpawnConfig always points somewhere real.
	await mkdir(join(config.dataDir, "workspace"), { recursive: true });

	const projects = new ProjectManager(config.dataDir, {
		provider: settings.provider ?? config.provider,
		model: settings.model ?? config.model,
	});
	const sessions = createSessionStore(config.dataDir, sessionsDir);

	// Worker entry: an explicit override (CLOWNFISH_WORKER_MODULE — what
	// `npm start` sets to the prebuilt dist/worker.mjs, ~1.8s faster to spawn
	// than the tsx source path; see scripts/bench-spawn.ts) wins; otherwise the
	// tsx source (dev — always fresh, no build step).
	const workerModule = process.env.CLOWNFISH_WORKER_MODULE
		? resolve(process.env.CLOWNFISH_WORKER_MODULE)
		: fileURLToPath(new URL("../agent/worker.ts", import.meta.url));
	if (process.env.CLOWNFISH_WORKER_MODULE) log.info(`worker entry (prebuilt): ${workerModule}`);
	// The packaged app runs a bun-compiled worker binary instead of a module.
	const workerBin = process.env.CLOWNFISH_WORKER_BIN?.trim() || undefined;
	if (workerBin) log.info(`worker entry (compiled): ${workerBin}`);
	// Same split as the builtin worker, for CLI-backed (pty) sessions: an
	// esbuild bundle in prod (`make build:pty-worker` → dist/pty-worker.mjs,
	// set via CLOWNFISH_PTY_WORKER_MODULE), the tsx source otherwise.
	const ptyWorkerModule = process.env.CLOWNFISH_PTY_WORKER_MODULE
		? resolve(process.env.CLOWNFISH_PTY_WORKER_MODULE)
		: fileURLToPath(new URL("../agent/pty-worker.ts", import.meta.url));
	const ptyWorkerBin = process.env.CLOWNFISH_PTY_WORKER_BIN?.trim() || undefined;
	const agents = new AgentManager({
		dataDir: config.dataDir,
		sessionsDir,
		udsPath: config.agentSocketPath,
		workerModule,
		workerBin,
		ptyWorkerModule,
		ptyWorkerBin,
		idleTtlMs: config.agentIdleTtlMs,
		spawnMode: config.agentSpawnMode,
		// Side-channel title persistence: only set a title when the session doesn't
		// already have one, so a manual rename is never clobbered by the worker's
		// first-prompt title suggestion.
		applySessionTitle: (pid, sid, title) =>
			sessions.meta(pid, sid).then((m) => (m && !m.title ? sessions.rename(pid, sid, title) : undefined)),
		markCliSessionStarted: (pid, sid) => sessions.markCliStarted(pid, sid).then(() => undefined),
		// The assistant's cross-session tools (agent/tools/sessions.ts). The
		// worker asks; here the server owns the models and the delivery path.
		// (Explicit param/return types: the closure references `agents`, whose
		// initializer would otherwise be circular for the type checker.)
		onSessionControl: async (
			from: { projectId: string; sessionId: string },
			req: { action: "list" | "send" | "read"; projectId?: string; sessionId?: string; text?: string; mode?: "steer" | "followup" },
		): Promise<unknown> => {
			// Only sessions the server spawned WITH the capability may ask — the
			// flag lives on the project config, so re-resolve the asking project.
			const asker = await projects.get(from.projectId);
			if (!asker?.config.sessionControl) throw new Error("this session does not have session control");
			if (req.action === "list") {
				const live = new Map(agents.list().map((a) => [a.sessionId, a] as const));
				const out: unknown[] = [];
				for (const p of await projects.list()) {
					out.push({
						projectId: p.id,
						name: p.name,
						path: p.path,
						sessions: (await sessions.list(p.id)).map((s) => {
							const a = live.get(s.id);
							return { id: s.id, title: s.title, updatedAt: s.updatedAt, ...(a ? { running: a.busy } : {}) };
						}),
					});
				}
				return out;
			}
			if (req.action === "read") {
				if (!req.projectId || !req.sessionId) throw new Error("read requires project_id and session_id");
				const page = await sessions.loadPage(req.projectId, req.sessionId, 12);
				if (!page) throw new Error("session not found");
				// User text is a string; assistant text is a text-block list —
				// take both through the shared wire mapping, tool calls dropped.
				const out: Array<{ role: string; text: string }> = [];
				for (const m of toWireMessages(page.messages)) {
					if (m.role === "user" && typeof m.content === "string") out.push({ role: "user", text: m.content.slice(0, 2000) });
					else if (m.role === "assistant" && Array.isArray(m.content)) {
						const text = m.content
							.filter((b) => b.type === "text")
							.map((b) => (b as { text: string }).text)
							.join("\n");
						if (text) out.push({ role: "assistant", text: text.slice(0, 2000) });
					}
				}
				return { messages: out };
			}
			// send — deliver exactly as the chat UI would. The assistant itself is
			// not a valid target: its own worker is busy asking, so the message
			// would only queue behind the very turn that sent it.
			if (req.projectId === from.projectId && req.sessionId === from.sessionId) {
				throw new Error("cannot send to the assistant session itself");
			}
			if (!req.projectId || !req.sessionId || !req.text?.trim()) throw new Error("send requires project_id, session_id and text");
			const project = await projects.get(req.projectId);
			if (!project) throw new Error(`project not found: ${req.projectId}`);
			if (!(await sessions.meta(req.projectId, req.sessionId))) throw new Error(`session not found: ${req.sessionId}`);
			await agents.prompt(project, req.sessionId, req.text, req.mode ?? "followup");
			return { delivered: true, note: req.mode ?? "followup" };
		},
	});

	// Bring up the Unix-domain WebSocket the workers connect over.
	const uds: UdsServer = await startUds(config.agentSocketPath, agents);

	// First-run login wizard (简单模式 / OAuth / 跳过): asks only when the
	// terminal is interactive AND nothing has decided auth yet (env or
	// settings.json). `make dev`, e2e and CI never see it.
	await runAuthWizard(config.dataDir);

	// Auth (opt-in: OAuth2/OIDC or simple login). Resolved after settings are
	// applied so creds in settings.json's env:{} are visible. Null = auth off.
	// A requested-but-unusable config stops the boot: never fall back to open.
	let authConfig: AuthConfig | null;
	try {
		authConfig = loadAuthConfig(config.dataDir);
	} catch (err) {
		if (!(err instanceof AuthConfigError)) throw err;
		log.error("auth misconfigured — refusing to start: %s (set CLOWNFISH_AUTH=off to run without login)", err.message);
		process.exit(1);
	}
	if (!authConfig && !authAlreadyDecided()) {
		log.warn("no login is set up — the agent is open to anyone who can reach this port. Run `npm run login` to set a username/password in under a minute.");
	}

	// Cron scheduler: fires session jobs (specs written by the agents' `cron`
	// tool) and internal nightly tasks. Started before the HTTP server accepts
	// traffic; stopped in the graceful-shutdown path.
	const scheduler = new Scheduler({ dataDir: config.dataDir, sessionsDir, projects, sessions, agents });
	await scheduler.start();

	// Data lifecycle: nightly archive (90d-idle sessions → tgz) + backup (state
	// → backups/, keep 7). Off by env: CLOWNFISH_ARCHIVE=0 / CLOWNFISH_BACKUP=0.
	if (process.env.CLOWNFISH_ARCHIVE !== "0") {
		scheduler.registerInternal({
			id: "archive",
			expr: process.env.CLOWNFISH_ARCHIVE_EXPR ?? "30 3 * * *",
			label: "session archive",
			run: async () => {
				const times = new Map<string, number>();
				for (const p of await projects.list()) for (const s of await sessions.list(p.id)) times.set(s.id, s.updatedAt);
				const summary = await runArchive({
					dataDir: config.dataDir,
					sessionsDir,
					sessionTimes: async () => times,
					activeSessions: () => new Set(agents.list().map((a) => a.sessionId)),
				});
				log.info("archive: %d session(s) archived%s", summary.count, summary.ok ? "" : ` — FAILED: ${summary.error}`);
				if (!summary.ok) throw new Error(summary.error);
			},
		});
	}
	if (process.env.CLOWNFISH_BACKUP !== "0") {
		scheduler.registerInternal({
			id: "backup",
			expr: process.env.CLOWNFISH_BACKUP_EXPR ?? "0 4 * * *",
			label: "data backup",
			run: async () => {
				const summary = await runBackup({ dataDir: config.dataDir, sessionsDir });
				log.info("backup: %d file(s) written%s", summary.count, summary.ok ? "" : ` — FAILED: ${summary.error}`);
				if (!summary.ok) throw new Error(summary.error);
			},
		});
	}

	const ctx = mkContext(config, projects, sessions, agents, authConfig, scheduler);

	const app = express();
	app.use(express.json({ limit: "16mb" }));

	// Auth routes are always open (login flow + status probe must work pre-session).
	// `/auth/me` always answers; the full Google flow is mounted only when enabled.
	if (authConfig) app.use("/auth", createAuthRouter(authConfig));
	else app.get("/auth/me", authMeDisabled);
	// Token autologin sits at the ROOT (the shell opens `/autologin?token=…`),
	// mounted BEFORE requireAuth like the /auth routes above.
	if (authConfig?.provider === "token") app.use("/autologin", createAutologinRouter(authConfig));
	// Gate everything else when auth is on (skips /auth + /api/health internally).
	if (authConfig) app.use(requireAuth(authConfig));

	// REST API.
	app.use("/api", createApiRouter(ctx));

	// Static WebUI build (production). In dev, Vite serves the frontend.
	// CLOWNFISH_WEB_DIST points a bun-compiled binary (whose module paths are
	// virtual $bunfs paths) at the real on-disk build — the app shell sets it.
	const webDist = process.env.CLOWNFISH_WEB_DIST?.trim()
		? resolve(process.env.CLOWNFISH_WEB_DIST.trim())
		: resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
	const indexHtml = join(webDist, "index.html");
	if (existsSync(indexHtml)) {
		app.use(express.static(webDist));
		app.use((req, res, next) => {
			if (req.method !== "GET" || req.path.startsWith("/api") || !req.accepts("html")) return next();
			return res.sendFile(indexHtml);
		});
	}

	// Error handler.
	app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
		log.error({ err, method: req.method, path: req.path }, "request error");
		const message = err instanceof Error ? err.message : "internal error";
		res.status(500).json({ error: message });
	});

	// HTTPS (opt-in via CLOWNFISH_TLS). The cert is supplied or auto-generated +
	// cached; the browser WS hub auto-becomes wss:// on an https.Server. Both
	// http/https Servers are net.Server subclasses — cast keeps attach() typed.
	const tlsOpts = await resolveTlsOptions(config);
	const useTls = Boolean(tlsOpts);
	const server: HttpServer = tlsOpts ? (createHttpsServer(tlsOpts, app) as unknown as HttpServer) : createHttpServer(app);
	const hub = new RealtimeHub(ctx);
	hub.attach(server);

	// Graceful shutdown: stop agents, close the UDS + HTTP servers, unlink the socket.
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("%s received; shutting down…", signal);
		scheduler.stop();
		await agents.shutdownAll();
		await uds.close();
		server.close(() => process.exit(0));
		// Force exit if something hangs.
		setTimeout(() => process.exit(1), 5000).unref();
	};
	// A resident server must not be killed by one stray async throw in a request
	// handler or an agent callback: every such path is already wrapped, so what
	// reaches here is a bug to log — not a reason to drop every live session.
	process.on("unhandledRejection", (reason) => {
		console.error("[clownfish] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
	});
	process.on("uncaughtException", (err) => {
		console.error("[clownfish] uncaught exception:", err);
		// Startup faults (port taken, socket path unusable) are not survivable —
		// fail loudly instead of idling in a half-started state.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE" || code === "EACCES") process.exit(1);
	});

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	// Boot-phase listen errors (EADDRINUSE from a stale process, EACCES, …) are
	// fatal by design — see installSafetyNets().
	server.on("error", (err) => {
		log.error({ err }, `fatal: cannot listen on port ${config.port} (is another clownfish instance running?)`);
		process.exit(1);
	});
	server.listen(config.port, config.bind, () => {
		installSafetyNets();
		const provider = settings.provider ?? config.provider;
		const model = settings.model ?? config.model;
		const scheme = useTls ? "https" : "http";
		const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.bind);
		if (!loopback) {
			// The tool has filesystem + paid-API access; say it loudly whenever it
			// is reachable beyond this machine, and louder without login gating.
			log.warn("listening on %s:%d — reachable from other machines (auth %s)", config.bind, config.port, authConfig ? "ON" : "OFF");
			if (!authConfig) {
				log.warn("no login is configured (CLOWNFISH_AUTH) — anyone on the network can drive the agent. Set CLOWNFISH_BIND=127.0.0.1 to go back to loopback-only.");
			}
		}
		log.info(
			"clownfish server → %s://%s:%d (provider=%s/%s, data=%s, sessions=%s, uds=%s)",
			scheme, config.bind, config.port, provider, model, config.dataDir, sessionsDir, config.agentSocketPath,
		);
	});
}

main().catch((err) => {
	log.error({ err }, "fatal bootstrap error");
	process.exit(1);
});
