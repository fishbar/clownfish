/** Smoke: idle reaping with subscribers attached (manager, share mode).
 *
 *   A. an idle worker is reaped on TTL even with a subscriber attached (open
 *      tabs are viewers, not keep-alives); the record and subscriber survive.
 *   B. the next start() lazily respawns, and frames fan out to the SURVIVING
 *      subscriber without a refresh (mode_changed used as the deterministic,
 *      provider-free probe frame).
 *   C. a pinned worker is not reaped; unpinning re-arms the countdown.
 *
 * Runs a real AgentManager with spawnMode "share" (in-process runtime on a
 * loopback socket — same lifecycle code paths, no fork/tsx cost). */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AgentManager } from "../agent/manager";
import type { Project } from "../server/protocol";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Provider-free deterministic probe: frames the fake tab receives. */
function fakeTab(): { ws: WebSocket; frames: Array<{ type: string; mode?: string }> } {
	const frames: Array<{ type: string; mode?: string }> = [];
	const ws = {
		readyState: WebSocket.OPEN,
		bufferedAmount: 0,
		send: (data: unknown): void => {
			try {
				frames.push(JSON.parse(String(data)));
			} catch {
				/* not json — ignore */
			}
		},
	} as unknown as WebSocket;
	return { ws, frames };
}

const work = await mkdtemp(join(tmpdir(), "clownfish-reap-"));
const projectDir = await mkdtemp(join(tmpdir(), "clownfish-reap-proj-"));
const project = {
	id: "p1",
	name: "reap",
	path: projectDir,
	createdAt: 0,
	updatedAt: 0,
	config: { provider: "anthropic", model: "glm-5.1", skillsDirs: [] },
} as unknown as Project;

const mgr = new AgentManager({
	dataDir: join(work, "data"),
	sessionsDir: join(work, "sessions"),
	udsPath: join(work, "agent.sock"),
	workerModule: fileURLToPath(new URL("../agent/worker.ts", import.meta.url)),
	idleTtlMs: 600,
	spawnMode: "share",
});

try {
	// --- A: reaped on TTL with a subscriber attached --------------------------------
	await mgr.ensureAgent(project, "s1");
	check("A: worker ready", mgr.status("s1")?.status === "ready");
	const tab1 = fakeTab();
	await mgr.attach("p1", "s1", tab1.ws);
	await sleep(2000); // TTL 600ms + shutdown settle
	const st = mgr.status("s1");
	check("A: reaped on TTL despite subscriber", st?.status === "dead");
	check("A: record survived (not dropped)", st !== undefined);
	check("A: subscriber still attached", st?.subscribers === 1);

	// --- B: respawn delivers frames to the surviving subscriber ---------------------
	tab1.frames.length = 0;
	await mgr.start(project, "s1");
	check("B: respawned on demand", mgr.status("s1")?.status === "ready");
	await mgr.setMode("s1", "ask");
	await sleep(300);
	check("B: mode switch acked", mgr.status("s1")?.mode === "ask");
	check("B: surviving tab received frames after respawn (no refresh)", tab1.frames.some((f) => f.type === "mode_changed" && f.mode === "ask"));

	// --- C: pin opts out of reaping ---------------------------------------------------
	await mgr.ensureAgent(project, "s2");
	mgr.setPinned("s2", true);
	const tab2 = fakeTab();
	await mgr.attach("p1", "s2", tab2.ws);
	await sleep(2000);
	check("C: pinned worker not reaped", mgr.status("s2")?.status === "ready");
	mgr.setPinned("s2", false);
	await sleep(2000);
	check("C: unpin re-arms the countdown", mgr.status("s2")?.status === "dead");
} finally {
	await mgr.shutdownAll();
	await rm(work, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
}

console.log(`smoke-reap: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
