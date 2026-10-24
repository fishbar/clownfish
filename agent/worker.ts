/**
 * Agent worker — process entry (spawn mode "process"): one process per session.
 *
 * Thin shell around the transport-agnostic {@link AgentRuntime}: reads the spawn
 * config from $CLOWNFISH_WORKER_CONFIG, connects back to the manager over the
 * Unix-domain WebSocket, and pipes ManagerFrames ⇄ WorkerFrames. All agent logic
 * (persistence, modes, approvals, checkpoints, MCP, compaction) lives in the
 * runtime; this file only owns the socket and the process lifetime.
 *
 * Spawned by {@link AgentManager}.
 */
import { WebSocket } from "ws";
import { AgentRuntime } from "./runtime";
import { WORKER_CONFIG_ENV, type ManagerFrame, type WorkerFrame, type WorkerSpawnConfig } from "./protocol";

function fail(message: string): never {
	console.error(`[worker] ${message}`);
	process.exit(1);
}

const rawCfg = process.env[WORKER_CONFIG_ENV];
if (!rawCfg) fail(`missing ${WORKER_CONFIG_ENV} env`);
let cfg: WorkerSpawnConfig;
try {
	cfg = JSON.parse(rawCfg) as WorkerSpawnConfig;
} catch (e) {
	fail(`invalid ${WORKER_CONFIG_ENV}: ${e instanceof Error ? e.message : e}`);
}

const ws = new WebSocket(`ws+unix:${cfg.udsPath}:/agent`);
let open = false;

const runtime = new AgentRuntime(cfg, {
	onFrame: (frame: WorkerFrame) => {
		if (open && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	},
	onTerminated: () => {
		void runtime.shutdown().finally(() => {
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			process.exit(0);
		});
	},
});

ws.on("message", (data) => {
	let msg: ManagerFrame;
	try {
		msg = JSON.parse(data.toString()) as ManagerFrame;
	} catch {
		return;
	}
	void runtime.handle(msg);
});

// The manager went away: exit promptly WITHOUT reflecting — the session did not
// end, and an LLM call on a dropped socket would just hang the exit.
ws.on("close", () => void runtime.shutdown().finally(() => process.exit(0)));

// A resident worker must not die from a stray async throw: log it, tell the
// manager, and keep serving. An uncaught exception is reported and then exits so
// the manager can respawn a clean process on the next prompt.
process.on("unhandledRejection", (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	console.error("[worker] unhandled rejection:", message);
	if (open && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "log", level: "error", message: `unhandled rejection: ${message}` } satisfies WorkerFrame));
	}
});
process.on("uncaughtException", (err) => {
	console.error("[worker] uncaught exception:", err);
	if (open && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "error", message: `worker crashed: ${err.message}` } satisfies WorkerFrame));
	}
	setTimeout(() => process.exit(1), 100).unref?.();
});
ws.on("error", (err) => console.error("[worker] ws error:", err.message));

ws.once("open", () => {
	open = true;
	runtime.boot().catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: `boot failed: ${message}` } satisfies WorkerFrame));
		fail(message);
	});
});
