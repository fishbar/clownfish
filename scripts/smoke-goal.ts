/**
 * run_goal smoke test — verifies the goal-loop CONTROL LOGIC without a real
 * provider (the LLM-driven loop is verified live via `make dev`).
 *
 * The loop only touches agents through `new ClownfishAgent(...)` + `.prompt()`
 * + `.state.messages`. We monkey-patch `ClownfishAgent.prototype.prompt` so each
 * call appends a scripted assistant reply and resolves — no provider, fully
 * deterministic. The evaluator is told apart from the goalRoot by its prompt
 * text (the evaluator prompt contains "VERDICT format").
 *
 * Scenarios:
 *   A. FAIL→FAIL→PASS → achieved at round 3, one wake, all spawns paired.
 *   B. never passes, cap 2 → gave_up (iteration cap).
 *   C. byte-identical FAIL twice → stall guard gives up before the cap.
 *   D. an identical still-running goal is rejected.
 *   E. boot resume — a "running" goal with a dead owner gets a fresh goalRoot.
 *
 * Run: `npx tsx scripts/smoke-goal.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ClownfishAgent } from "../agent/clownfish-agent";
import { DagStore } from "../agent/dag";
import { createRunGoalTool, resumeGoals, type GoalRecord } from "../agent/agents/goal";
import type { WorkflowToolDeps } from "../agent/agents/types";
import type { ResolvedRuntime } from "../agent/models";
import type { WorkerFrame } from "../agent/protocol";

// --- the seam: scripted prompt() -------------------------------------------------
type Script = (call: number) => string;
let executorScript: Script = () => "";
let evaluatorScript: Script = () => "";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = ClownfishAgent.prototype as any;
const realPrompt = proto.prompt;
proto.prompt = async function (input: string | AgentMessage): Promise<void> {
	void realPrompt;
	const text = typeof input === "string" ? input : "";
	const script = text.includes("VERDICT format") ? evaluatorScript : executorScript;
	script.n = (script.n ?? 0) + 1; // call counter lives on the function object
	const reply = script(script.n);
	const msg = { role: "assistant", content: [{ type: "text", text: reply }] } as unknown as AgentMessage;
	// state.messages has a setter (copies the array) — go through it, and mirror
	// the user message pi would have appended so history stays well-formed.
	this.state.messages = [...this.state.messages, { role: "user", content: [{ type: "text", text }] }, msg];
	this._state.isStreaming = false;
};

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	const MAIN = "agent-main";
	const work = await mkdtemp(join(tmpdir(), "smoke-goal-"));
	await mkdir(join(work, "sess"), { recursive: true });
	const frames: WorkerFrame[] = [];
	const wakes: string[] = [];
	const logs: string[] = [];

	const deps: WorkflowToolDeps = {
		dags: new DagStore(),
		agentId: MAIN,
		// Stub runtime: prompt() is patched below so the stream function must
		// never actually run — it exists only to pass Agent's constructor check.
		runtime: { streamFn: () => { throw new Error("stub streamFn must not be called"); } } as unknown as ResolvedRuntime,
		cwd: work,
		skills: [],
		vars: { cwd: work, project: "p", sessionId: "s", date: "2026-01-01", os: "linux" },
		sessionId: "sess",
		sessionsDir: work,
		worktreeDir: join(work, "wt"),
		onFrame: (f) => frames.push(f),
		wakeMain: async (t) => {
			wakes.push(t);
		},
		log: (m) => logs.push(m),
	};
	const tool = createRunGoalTool({ ...deps, sessionDir: join(work, "sess") });
	const goalsFile = join(work, "sess", "goals.json");
	const readGoals = async (): Promise<GoalRecord[]> => (JSON.parse(await readFile(goalsFile, "utf8")) as { goals: GoalRecord[] }).goals;
	const setScript = (exec: Script, evalr: Script): void => {
		executorScript = Object.assign((n: number) => exec(n), { n: 0 });
		evaluatorScript = Object.assign((n: number) => evalr(n), { n: 0 });
	};

	// ---- A: FAIL, FAIL, PASS → achieved at round 3 ----
	frames.length = 0;
	wakes.length = 0;
	setScript(
		(n) => (n >= 3 ? "final report: all done" : `attempt ${n}: partial work`),
		(n) => (n >= 3 ? "VERDICT: PASS\nall criteria verified" : `VERDICT: FAIL\n${n}. criterion unmet — fix it`), // distinct text per round (stall guard watches for identical verdicts)
	);
	const r1 = await tool.execute("t1", { goal: "make it work", criteria: "it works", worktree: false, max_iterations: 5 });
	assert.match(r1.content[0].text, /background/i);
	await new Promise((r) => setTimeout(r, 600));

	const goalA = (await readGoals()).find((g) => g.goal === "make it work")!;
	assert.equal(goalA.status, "achieved", `status=${goalA.status}`);
	assert.equal(goalA.round, 3);
	assert.deepEqual(goalA.verdicts.map((v) => v.pass), [false, false, true]);
	ok("A: FAIL→FAIL→PASS ends achieved at round 3 with full verdict history");

	assert.equal(wakes.length, 1);
	assert.match(wakes[0], /\[goal achieved\]/);
	ok("A: wakes main exactly once with [goal achieved]");

	const kinds = frames.filter((f) => f.type === "agent_spawned").map((f) => (f as { kind: string }).kind);
	assert.equal(kinds.filter((k) => k === "dagRoot").length, 1, "one goalRoot");
	assert.equal(kinds.filter((k) => k === "dagSub").length, 3, `one evaluator per round (got ${kinds.filter((k) => k === "dagSub").length})`);
	assert.equal(frames.filter((f) => f.type === "agent_ended").length, 4, "every spawn paired with agent_ended");
	ok("A: 1 goalRoot + 3 evaluator spawns, all paired with agent_ended");

	// ---- B: never passes, cap 2 → gave_up ----
	wakes.length = 0;
	setScript(
		(n) => `attempt ${n}: still wrong`,
		(n) => `VERDICT: FAIL\n${n}. reason`,
	);
	await tool.execute("t2", { goal: "never done", criteria: "impossible", worktree: false, max_iterations: 2 });
	await new Promise((r) => setTimeout(r, 600));
	const goalB = (await readGoals()).find((g) => g.goal === "never done")!;
	assert.equal(goalB.status, "gave_up");
	assert.match(wakes[0], /\[goal gave up\]/);
	assert.match(wakes[0], /iteration cap/);
	ok("B: unmet goal gives up at the iteration cap and reports back");

	// ---- C: identical FAIL twice → stall guard ----
	wakes.length = 0;
	setScript(
		(n) => `attempt ${n}`,
		() => "VERDICT: FAIL\n1. same unmet criterion", // byte-identical each round
	);
	await tool.execute("t3", { goal: "stalled goal", criteria: "c", worktree: false, max_iterations: 9 });
	await new Promise((r) => setTimeout(r, 600));
	const goalC = (await readGoals()).find((g) => g.goal === "stalled goal")!;
	assert.equal(goalC.status, "gave_up");
	assert.equal(goalC.round, 2, `stopped at round ${goalC.round}, not the cap`);
	assert.match(wakes[0], /no progress/);
	ok("C: identical consecutive verdicts trip the stall guard (round 2 of 9)");

	// ---- D: duplicate running goal rejected ----
	const goalsD = await readGoals();
	goalsD[0].status = "running";
	await writeFile(goalsFile, JSON.stringify({ goals: goalsD }));
	const r4 = await tool.execute("t4", { goal: goalsD[0].goal, criteria: "c", worktree: false });
	assert.match(r4.content[0].text, /already running/);
	ok("D: an identical running goal is rejected");
	goalsD[0].status = "achieved";
	await writeFile(goalsFile, JSON.stringify({ goals: goalsD }));

	// ---- E: resume — running goal w/ dead owner gets a fresh goalRoot ----
	frames.length = 0;
	const goalsE = await readGoals();
	goalsE.push({ id: "g-resume", goal: "resumable", criteria: "c", ownerAgent: "dead-agent", round: 4, status: "running", verdicts: [{ round: 3, pass: false, text: "VERDICT: FAIL\nnot yet" }], maxIterations: 6 });
	await writeFile(goalsFile, JSON.stringify({ goals: goalsE }));
	setScript(
		() => "final report after resume",
		() => "VERDICT: PASS",
	);
	const resumed = await resumeGoals(deps, join(work, "sess"));
	assert.equal(resumed, 1);
	await new Promise((r) => setTimeout(r, 600));
	assert.ok(frames.some((f) => f.type === "agent_spawned" && (f as { kind: string }).kind === "dagRoot"), "a fresh goalRoot spawned");
	const goalE = (await readGoals()).find((g) => g.id === "g-resume")!;
	assert.notEqual(goalE.ownerAgent, "dead-agent");
	assert.equal(goalE.status, "achieved", "resumed loop ran to PASS");
	ok("E: boot resume re-drives a running goal with a fresh goalRoot (round 4 → PASS)");

	await rm(work, { recursive: true, force: true });
	console.log(`smoke-goal: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-goal FAILED:", err);
	process.exit(1);
});
