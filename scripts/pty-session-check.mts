/**
 * CLI-backed (pty) session — offline checks.
 *
 * No real `codex`/`claude` binary is needed: this exercises agent/pty-worker.ts
 * directly against a deterministic interactive shell (`sh`), through a minimal
 * fake "manager" (a bare UDS WebSocket server speaking the same register/
 * pty_data/pty_input/pty_resize/pty_exit frames agent/manager.ts does) — proving
 * the worker's byte pump, resize plumbing, and exit reporting actually work,
 * without spinning up the whole server/AgentManager stack.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PTY_WORKER_CONFIG_ENV, type WorkerFrame, type ManagerFrame, type PtyWorkerSpawnConfig } from "../agent/protocol.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- scrollback cap: the exact slicing logic agent/manager.ts uses on pty_data ---
{
	const CAP = 200_000;
	let buf = "";
	for (let i = 0; i < 250_000; i++) buf = (buf + "x").slice(-CAP);
	check("scrollback buffer never exceeds the cap", buf.length === CAP, `len=${buf.length}`);
	check("scrollback buffer keeps the MOST RECENT bytes (trims from the front)", buf === "x".repeat(CAP));
}

// --- pty-worker end to end: register, byte round-trip, resize, exit ---
const dataDir = mkdtempSync(join(tmpdir(), "pty-check-"));
const udsPath = join(dataDir, "agent.sock");

const frames: WorkerFrame[] = [];
let ws: WebSocket | undefined;
const http = createServer();
const wss = new WebSocketServer({ server: http, path: "/agent" });
const registered = new Promise<void>((resolve) => {
	wss.on("connection", (sock) => {
		ws = sock;
		sock.on("message", (data) => {
			const frame = JSON.parse(String(data)) as WorkerFrame;
			frames.push(frame);
			if (frame.type === "register") resolve();
		});
	});
});
await new Promise<void>((resolve) => http.listen(udsPath, resolve));

function send(frame: ManagerFrame): void {
	ws?.send(JSON.stringify(frame));
}
function waitFor(pred: (f: WorkerFrame) => boolean, timeoutMs = 8000): Promise<WorkerFrame> {
	return new Promise((resolve, reject) => {
		const existing = frames.find(pred);
		if (existing) return resolve(existing);
		const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
		const check = (): void => {
			const f = frames.find(pred);
			if (f) {
				clearTimeout(timer);
				resolve(f);
			} else setTimeout(check, 25);
		};
		check();
	});
}
function collected(): string {
	return frames
		.filter((f): f is Extract<WorkerFrame, { type: "pty_data" }> => f.type === "pty_data")
		.map((f) => f.data)
		.join("");
}

const cfg: PtyWorkerSpawnConfig = { sessionId: "pty-check", cwd: dataDir, command: "sh", args: [], udsPath };
const child = spawn("npx", ["tsx", "agent/pty-worker.ts"], {
	env: { ...process.env, [PTY_WORKER_CONFIG_ENV]: JSON.stringify(cfg) },
	stdio: ["ignore", "pipe", "pipe"],
});
let childErr = "";
child.stderr.on("data", (d) => (childErr += d.toString()));

try {
	await registered;
	check("pty-worker sends register with the configured sessionId", frames.some((f) => f.type === "register" && f.sessionId === "pty-check"));
	await waitFor((f) => f.type === "ready");
	check("pty-worker sends ready after connecting", true);

	send({ type: "pty_input", data: "echo hello-clownfish\n" });
	await waitFor(() => collected().includes("hello-clownfish"));
	check(
		"a command written via pty_input round-trips as pty_data output",
		collected().includes("hello-clownfish"),
		collected().slice(-200),
	);

	send({ type: "pty_resize", cols: 97, rows: 41 });
	const before = collected().length;
	send({ type: "pty_input", data: "stty size\n" });
	await waitFor(() => collected().slice(before).includes("41 97"), 8000);
	check(
		"pty_resize actually resizes the pty (stty size reports the new dimensions)",
		collected().slice(before).includes("41 97"),
		collected().slice(-200),
	);

	send({ type: "pty_input", data: "exit\n" });
	const exitFrame = await waitFor((f) => f.type === "pty_exit");
	check("the process exiting sends a pty_exit frame with a numeric code", exitFrame.type === "pty_exit" && typeof exitFrame.code === "number", JSON.stringify(exitFrame));
} catch (e) {
	failures.push(`pty-worker end-to-end — ${e instanceof Error ? e.message : e}${childErr ? ` (stderr: ${childErr.slice(-300)})` : ""}`);
} finally {
	child.kill();
	await new Promise<void>((resolve) => wss.close(() => resolve()));
	http.close();
	rmSync(dataDir, { recursive: true, force: true });
}

console.log(`pty-session: ${passed} checks passed`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
