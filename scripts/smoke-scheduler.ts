/**
 * Scheduler smoke test — the cron FIRE machinery without a real server or
 * provider. A fake clock drives ticks; stub ProjectManager/SessionStore/
 * AgentManager record fires.
 *
 *   A. spec discovery: session cron.json → listing rows (with nextRun).
 *   B. due job fires exactly once per occurrence, through AgentManager.run
 *      with the bracketed cron prompt.
 *   C. busy session (run rejects) → retries on next tick, gives up after 3.
 *   D. stale job (missed > 24h) → skipped, resynced without firing.
 *   E. cancel: spec file rewritten, state entry dropped.
 *   F. internal task fires through its callback.
 *   G. deleted session → its state entries fall away on the next tick.
 *
 * Run: `npx tsx scripts/smoke-scheduler.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../server/scheduler";
import type { ProjectManager } from "../server/models/projects";
import type { SessionStore } from "../server/models/sessions";
import type { AgentManager } from "../agent/manager";
import type { Project } from "../server/protocol";

// ---- stubs ----------------------------------------------------------------------
const fired: Array<{ sessionId: string; text: string; at: number }> = [];
let runBehavior: (sessionId: string, text: string) => void = () => {};

const projects = {
	list: async () => [{ id: "p1", name: "proj", path: "/tmp", createdAt: 0, updatedAt: 0, config: {} } as unknown as Project],
	get: async (id: string) => ({ id, name: "proj", path: "/tmp", createdAt: 0, updatedAt: 0, config: {} } as unknown as Project),
} as unknown as ProjectManager;

const sessions = {
	list: async () => [{ id: "sess1", projectId: "p1", createdAt: 0, updatedAt: 0 }],
} as unknown as SessionStore;

const agents = {
	run: async (_p: unknown, sessionId: string, text: string) => {
		fired.push({ sessionId, text, at: clock.now });
		runBehavior(sessionId, text);
	},
} as unknown as AgentManager;

// ---- fake clock ------------------------------------------------------------------
const clock = { now: Date.parse("2026-08-20T00:00:00") };

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);
	const work = await mkdtemp(join(tmpdir(), "smoke-sched-"));
	await mkdir(join(work, "sessions", "sess1"), { recursive: true });

	const sched = new Scheduler({
		dataDir: join(work, "data"),
		sessionsDir: join(work, "sessions"),
		projects,
		sessions,
		agents,
		now: () => clock.now,
	});

	const writeSpec = async (jobs: Array<Record<string, unknown>>): Promise<void> => {
		await writeFile(join(work, "sessions", "sess1", "cron.json"), JSON.stringify({ jobs }));
	};

	// ---- A: discovery + listing ----
	await writeSpec([{ id: "j1", expr: "0 2 * * *", prompt: "nightly check", name: "nightly", createdAt: 0 }]);
	await sched.tick();
	const jobs = await sched.listJobs();
	const row = jobs.find((j) => j.jobId === "j1")!;
	assert.ok(row, "job listed");
	assert.equal(row.expr, "0 2 * * *");
	assert.ok(row.nextRun && row.nextRun > clock.now, "nextRun computed into the future");
	assert.equal(fired.length, 0, "not due yet — no fire");
	ok("A: discovers session specs and computes nextRun without firing early");

	// ---- B: advance to 02:00 → fires once ----
	clock.now = Date.parse("2026-08-20T02:00:30");
	await sched.tick();
	assert.equal(fired.length, 1);
	assert.equal(fired[0].sessionId, "sess1");
	assert.match(fired[0].text, /\[scheduled task — nightly\]/);
	assert.match(fired[0].text, /nightly check/);
	// same-minute re-tick must NOT double-fire
	await sched.tick();
	assert.equal(fired.length, 1);
	// next occurrence is tomorrow 02:00
	const rowB = (await sched.listJobs()).find((j) => j.jobId === "j1")!;
	assert.equal(rowB.nextRun, Date.parse("2026-08-21T02:00:00"));
	assert.equal(rowB.lastRun, Date.parse("2026-08-20T02:00:00"));
	assert.equal(rowB.failures, 0);
	ok("B: due job fires exactly once with the bracketed prompt; nextRun advances a day");

	// ---- C: busy session → retry, give up after 3 ----
	fired.length = 0;
	runBehavior = () => {
		throw new Error("agent is busy");
	};
	await writeSpec([{ id: "j2", expr: "30 3 * * *", prompt: "morning", createdAt: 0 }]);
	clock.now = Date.parse("2026-08-21T03:29:00");
	await sched.tick(); // j2 nextRun → today 03:30
	clock.now = Date.parse("2026-08-21T03:30:10");
	await sched.tick(); // failure 1
	clock.now += 60_000;
	await sched.tick(); // failure 2
	clock.now += 60_000;
	await sched.tick(); // failure 3 → gives up this occurrence
	assert.equal(fired.length, 3, "three attempts recorded");
	let rowC = (await sched.listJobs()).find((j) => j.jobId === "j2")!;
	assert.equal(rowC.failures, 3);
	assert.equal(rowC.nextRun, Date.parse("2026-08-22T03:30:00"), "moved on to tomorrow's slot");
	clock.now += 60_000;
	await sched.tick();
	assert.equal(fired.length, 3, "no 4th attempt");
	rowC = (await sched.listJobs()).find((j) => j.jobId === "j2")!;
	assert.equal(rowC.failures, 3);
	ok("C: busy agent retries then gives up this occurrence (3 attempts, nextRun moves on)");

	// ---- D: stale (missed > 24h) → skipped ----
	fired.length = 0;
	runBehavior = () => {};
	await writeSpec([{ id: "j3", expr: "0 5 * * *", prompt: "five am", createdAt: 0 }]);
	await sched.tick(); // registers j3's nextRun (today 05:00 — already past, within 24h → fires)
	fired.length = 0; // ignore that immediate catch-up fire
	// Jump 3 days ahead — the 05:00 slots were all missed.
	clock.now = Date.parse("2026-08-25T10:00:00");
	await sched.tick();
	assert.equal(fired.filter((f) => f.text.includes("five am")).length, 0, "stale occurrence skipped");
	const rowD = (await sched.listJobs()).find((j) => j.jobId === "j3")!;
	assert.ok(rowD.nextRun! > clock.now, "resynced into the future");
	ok("D: occurrence missed beyond 24h is skipped and the schedule resyncs");

	// ---- E: cancel ----
	const cancelled = await sched.cancelJob("sess1", "j3");
	assert.ok(cancelled);
	const onDisk = JSON.parse(await readFile(join(work, "sessions", "sess1", "cron.json"), "utf8")) as { jobs: Array<{ id: string }> };
	assert.ok(!onDisk.jobs.some((j) => j.id === "j3"), "spec removed from cron.json");
	assert.equal(await sched.cancelJob("sess1", "nope"), false);
	ok("E: cancel rewrites the spec file and prunes state");

	// ---- F: internal task ----
	const internalRuns: string[] = [];
	sched.registerInternal({ id: "distill", expr: "0 4 * * *", label: "memory distill", run: async () => { internalRuns.push("ran"); } });
	clock.now = Date.parse("2026-08-25T03:59:00");
	await sched.tick(); // registers nextRun = today 04:00
	clock.now = Date.parse("2026-08-25T04:00:30");
	await sched.tick();
	assert.equal(internalRuns.length, 1);
	await sched.tick();
	assert.equal(internalRuns.length, 1, "no double fire");
	const rowF = (await sched.listJobs()).find((j) => j.internal)!;
	assert.equal(rowF.jobId, "distill");
	ok("F: internal task fires through its callback exactly once per slot");

	// ---- G: session deleted → state falls away ----
	(sessions as { list: () => Promise<Array<{ id: string }>> }).list = async () => [];
	await sched.tick();
	const jobsG = await sched.listJobs();
	assert.ok(!jobsG.some((j) => j.sessionId === "sess1"), "session jobs gone");
	assert.ok(jobsG.some((j) => j.internal), "internal task survives");
	ok("G: a deleted session's state entries are pruned on the next tick");

	sched.stop();
	await rm(work, { recursive: true, force: true });
	console.log(`smoke-scheduler: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-scheduler FAILED:", err);
	process.exit(1);
});
