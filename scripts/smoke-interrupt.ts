/**
 * interrupt-recovery smoke test — a provider error (429/5xx/stall) must never
 * be mistaken for success, and must route to the auto re-drive hook. No real
 * provider: `ClownfishAgent.prototype.prompt` is patched to resolve the way
 * pi's loop does after a provider-killed turn (an EMPTY errored assistant
 * message in history — prompt() RESOLVES, it does not reject).
 *
 * Scenarios:
 *   A. runOutcome: finished vs provider-killed classification.
 *   B. trimErroredTail: empty error tail dropped, content-bearing aborted kept.
 *   C. convertToLlm: errored turns never reach the provider payload.
 *   E. delegate + provider-killed sub-run → node reset to pending, explicit
 *      error text returned to the parent.
 *   F. goal round provider-death → no verdict recorded, round unchanged, status
 *      stays "running", onInterrupted fired.
 *
 * Run: `npx tsx scripts/smoke-interrupt.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ClownfishAgent } from "../agent/clownfish-agent";
import { convertToLlm } from "../agent/convert-to-llm";
import { DagStore } from "../agent/dag";
import { runOutcome, trimErroredTail } from "../agent/agents/run-outcome";
import { createDelegateTool } from "../agent/agents/delegate";
import type { WorkflowToolDeps } from "../agent/agents/types";
import type { ResolvedRuntime } from "../agent/models";
import type { WorkerFrame } from "../agent/protocol";

// --- the seam: scripted prompt() ------------------------------------------------
/** What the patched prompt appends: "ok" = normal text turn, "dead" = provider-killed,
 *  "hang" = streams forever until abort() (the cancel scenario). */
let nextPromptBehavior: "ok" | "dead" | "hang" = "ok";
let promptCalls = 0;
/** Resolves the hanging "hang" prompt — set by prompt(), consumed by abort(). */
let releaseHanging: (() => void) | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = ClownfishAgent.prototype as any;
proto.prompt = async function (input: string | AgentMessage): Promise<void> {
	promptCalls += 1;
	const text = typeof input === "string" ? input : "";
	const push = (reply: AgentMessage): void => {
		this.state.messages = [...this.state.messages, { role: "user", content: [{ type: "text", text }] }, reply];
		this._state.isStreaming = false;
	};
	if (nextPromptBehavior === "hang") {
		this._state.isStreaming = true;
		await new Promise<void>((resolve) => {
			releaseHanging = resolve;
		});
		// What pi's loop leaves after an abort: a content-bearing aborted turn —
		// runOutcome() classifies this as OK (the trap the cancelled-check guards).
		push({ role: "assistant", content: [{ type: "text", text: "partial work…" }], stopReason: "aborted" } as unknown as AgentMessage);
		return;
	}
	const reply: AgentMessage =
		nextPromptBehavior === "ok"
			? ({ role: "assistant", content: [{ type: "text", text: "step done" }], stopReason: "stop" } as unknown as AgentMessage)
			: ({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "429 {\"error\":{\"code\":\"1302\"}} rate limit exceeded",
				} as unknown as AgentMessage);
	push(reply);
};
// abort() in the seam: settle the hanging run the way the real one does.
proto.abort = function (): void {
	this._state.isStreaming = false;
	releaseHanging?.();
};

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	const MAIN = "agent-main";
	const work = await mkdtemp(join(tmpdir(), "smoke-interrupt-"));
	await mkdir(join(work, "sess"), { recursive: true });
	const frames: WorkerFrame[] = [];
	const wakes: string[] = [];
	const logs: string[] = [];
	const interrupted: Array<{ kind: string; id: string; error: string }> = [];

	const mkDeps = (dags: DagStore): WorkflowToolDeps => ({
		dags,
		agentId: MAIN,
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
		onInterrupted: (kind, id, error) => interrupted.push({ kind, id, error }),
		log: (m) => logs.push(m),
	});

	// ---- A. runOutcome ---------------------------------------------------------
	{
		const finished = [{ role: "user", content: [] }, { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" }] as unknown as AgentMessage[];
		const dead = [...finished, { role: "assistant", content: [], stopReason: "error", errorMessage: "429 nope" }] as unknown as AgentMessage[];
		assert.deepEqual(runOutcome(finished), { ok: true, summary: "hi" });
		const deadOutcome = runOutcome(dead);
		assert.equal(deadOutcome.ok, false);
		assert.equal(deadOutcome.error, "429 nope");
		ok("A. runOutcome classifies finished vs provider-killed");
	}

	// ---- B. trimErroredTail ----------------------------------------------------
	{
		const emptyErr = { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } as unknown as AgentMessage;
		const abortedWithText = { role: "assistant", content: [{ type: "text", text: "partial…" }], stopReason: "aborted" } as unknown as AgentMessage;
		const user = { role: "user", content: [{ type: "text", text: "q" }] } as unknown as AgentMessage;
		assert.deepEqual(trimErroredTail([user, emptyErr]), [user]);
		assert.deepEqual(trimErroredTail([user, abortedWithText]), [user, abortedWithText]);
		assert.deepEqual(trimErroredTail([user]), [user]);
		ok("B. trimErroredTail drops empty error tails only");
	}

	// ---- C. convertToLlm strips errored turns ----------------------------------
	{
		const user = { role: "user", content: [{ type: "text", text: "q" }] } as unknown as AgentMessage;
		const emptyAssistant = { role: "assistant", content: [], stopReason: "error", errorMessage: "429" } as unknown as AgentMessage;
		const good = { role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop" } as unknown as AgentMessage;
		const converted = convertToLlm([user, emptyAssistant, good]);
		assert.equal(converted.length, 2, "errored turn dropped, others kept");
		ok("C. convertToLlm never ships an empty errored assistant message");
	}

	// ---- E. delegate provider-killed sub-run → node reset to pending -----------
	{
		const dags = new DagStore();
		const deps = mkDeps(dags);
		const { rootNodeId } = dags.createDag(MAIN, "sync plan");
		const [node] = dags.plan(MAIN, rootNodeId, [{ description: "delegated step", mode: "delegate" }]);
		const tool = createDelegateTool({ ...deps, depth: 0 });
		nextPromptBehavior = "dead";
		const res = await tool.execute("tc1", { node_id: node }) as { content: Array<{ type: string; text: string }> };
		assert.match(res.content[0].text, /interrupted by a provider error/, "E: parent sees the interruption");
		const view = dags.view(MAIN, node)![0];
		assert.equal(view.status, "pending", "E: node reset to pending (re-drivable)");
		assert.match(view.result ?? "", /interrupted by provider error/);
		ok("E. provider-killed delegate → node pending + explicit error text");
	}

	// ---- F. goal round provider-death → no verdict, round unchanged ------------
	{
		const { createRunGoalTool } = await import("../agent/agents/goal");
		const dags = new DagStore();
		const deps = mkDeps(dags);
		const goalTool = createRunGoalTool({ ...deps, sessionDir: join(work, "sess") });
		nextPromptBehavior = "dead";
		interrupted.length = 0;
		wakes.length = 0;
		await goalTool.execute("tc2", { goal: "g", criteria: "c" });
		await new Promise((r) => setTimeout(r, 100)); // fire-and-forget loop settles

		const raw = await readFile(join(work, "sess", "goals.json"), "utf8");
		const goals = JSON.parse(raw) as { goals: Array<{ id: string; goal: string; round: number; status: string; verdicts: unknown[] }> };
		assert.equal(goals.goals.length, 1);
		const g = goals.goals[0];
		assert.equal(g.status, "running", "F: status stays running (resumable)");
		assert.equal(g.round, 1, "F: round not consumed");
		assert.equal(g.verdicts.length, 0, "F: no phantom verdict from a dead round");
		assert.equal(interrupted.length, 1, "F: onInterrupted fired");
		assert.equal(interrupted[0].kind, "goal");
		assert.equal(wakes.length, 0, "F: no failure wake (re-drive owns recovery)");
		ok("F. provider-killed goal round → status running, no phantom verdict");
	}

	console.log(`smoke-interrupt: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	await rm(work, { recursive: true, force: true });
	process.exit(0);
})().catch((err) => {
	console.error("smoke-interrupt FAILED:", err);
	process.exit(1);
});
