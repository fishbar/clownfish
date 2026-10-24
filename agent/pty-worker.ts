/**
 * CLI-backed session worker — process entry: a pure byte pump, no {@link AgentRuntime}
 * involved. Spawns an external CLI (Codex, Claude Code, or any command) under a real
 * pty and shuttles its bytes to/from the manager over the same Unix-domain WebSocket
 * transport agent/worker.ts uses, via {@link PtyWorkerSpawnConfig}'s pty_input/
 * pty_resize/pty_data/pty_exit frames instead of ManagerFrame prompts/AgentEvents.
 *
 * Deliberately dumb: clownfish does not intercept this process's tool calls or model
 * config — the CLI is assumed to be configured on its own (e.g. `codex login` already
 * done on the host). The only thing clownfish adds on spawn is an env override (see
 * agent/cli-env.ts) for things like an HTTP(S) proxy.
 *
 * Spawned by {@link AgentManager.spawnCli}.
 */
import { WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { cliChildEnv } from "./cli-env";
import { PTY_WORKER_CONFIG_ENV, type ManagerFrame, type WorkerFrame, type PtyWorkerSpawnConfig } from "./protocol";

function fail(message: string): never {
	console.error(`[pty-worker] ${message}`);
	process.exit(1);
}

const rawCfg = process.env[PTY_WORKER_CONFIG_ENV];
if (!rawCfg) fail(`missing ${PTY_WORKER_CONFIG_ENV} env`);
let cfg: PtyWorkerSpawnConfig;
try {
	cfg = JSON.parse(rawCfg) as PtyWorkerSpawnConfig;
} catch (e) {
	fail(`invalid ${PTY_WORKER_CONFIG_ENV}: ${e instanceof Error ? e.message : e}`);
}

const ws = new WebSocket(`ws+unix:${cfg.udsPath}:/agent`);
let open = false;

function send(frame: WorkerFrame): void {
	if (open && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

let term: IPty;
try {
	term = ptySpawn(cfg.command, cfg.args ?? [], {
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: cfg.cwd,
		env: cliChildEnv(cfg.env),
	});
} catch (e) {
	fail(`failed to spawn "${cfg.command}": ${e instanceof Error ? e.message : e}`);
}

term.onData((data) => send({ type: "pty_data", data }));
term.onExit(({ exitCode }) => {
	send({ type: "pty_exit", code: exitCode });
	// Give the frame a moment to actually leave the socket before tearing it down.
	setTimeout(() => process.exit(0), 100).unref?.();
});

ws.on("message", (data) => {
	let msg: ManagerFrame;
	try {
		msg = JSON.parse(data.toString()) as ManagerFrame;
	} catch {
		return;
	}
	if (msg.type === "pty_input") term.write(msg.data);
	else if (msg.type === "pty_resize") term.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
	else if (msg.type === "shutdown") {
		try {
			term.kill();
		} catch {
			/* already gone */
		}
	}
});

// The manager went away: the pty has no one to talk to any more.
ws.on("close", () => {
	try {
		term.kill();
	} catch {
		/* ignore */
	}
	process.exit(0);
});

process.on("unhandledRejection", (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	console.error("[pty-worker] unhandled rejection:", message);
	send({ type: "log", level: "error", message: `unhandled rejection: ${message}` });
});
process.on("uncaughtException", (err) => {
	console.error("[pty-worker] uncaught exception:", err);
	send({ type: "error", message: `pty-worker crashed: ${err.message}` });
	setTimeout(() => process.exit(1), 100).unref?.();
});
ws.on("error", (err) => console.error("[pty-worker] ws error:", err.message));

ws.once("open", () => {
	open = true;
	send({ type: "register", sessionId: cfg.sessionId });
	send({ type: "ready" });
});
