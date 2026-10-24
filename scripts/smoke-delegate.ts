/**
 * delegate tool guard smoke test — verifies the authority/mode rejection paths
 * WITHOUT a provider (the LLM-driven spawn is verified manually via `make dev`).
 * Run: `npx tsx scripts/smoke-delegate.ts`
 *
 * A valid delegate call spawns an agent (needs an LLM); but the guards that
 * short-circuit BEFORE any spawn are pure and must not leak lifecycle frames or
 * mutate the DAG. Those, plus the pre-LLM spawn step (rebind + agent_spawned),
 * are what we assert here.
 */
import assert from "node:assert/strict";
import { DagStore } from "../agent/dag";
import { createDelegateTool } from "../agent/agents/delegate";
import type { ResolvedRuntime } from "../agent/models";
import type { WorkerFrame } from "../agent/protocol";

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	const MAIN = "agent-main";
	const OTHER = "agent-other";
	const dags = new DagStore();
	const { rootNodeId } = dags.createDag(MAIN, "feature");
	// A = delegate (owned by main), B = inline (owned by main).
	const [aId, bId] = dags.plan(MAIN, rootNodeId, [
		{ description: "A", mode: "delegate" },
		{ description: "B", mode: "inline" },
	]);
	// A genuinely out-of-scope node: a SEPARATE DAG owned by OTHER (main can't touch it).
	const { rootNodeId: otherRoot } = dags.createDag(OTHER, "other's feature");
	const cId = otherRoot;

	const frames: WorkerFrame[] = [];
	const tool = createDelegateTool({
		dags,
		agentId: MAIN,
		runtime: {} as unknown as ResolvedRuntime, // unused on rejection paths
		cwd: "/tmp",
		skills: [],
		vars: { cwd: "/tmp", project: "p", sessionId: "s", date: "2026-01-01", os: "linux" },
		sessionId: "sess",
		sessionsDir: "/tmp",
		depth: 0,
		onFrame: (f) => frames.push(f),
	});

	// 1. Out-of-scope node (owned by OTHER): reject, no spawn, no frame, no mutation.
	const r1 = await tool.execute("t1", { node_id: cId });
	assert.match(r1.content[0].text, /out of your scope/);
	assert.equal(frames.length, 0, "no lifecycle frame leaked on out-of-scope reject");
	ok("out-of-scope node rejected without spawning or framing");

	// 2. Non-delegate node (B is inline): reject, no spawn, no frame.
	const r2 = await tool.execute("t2", { node_id: bId });
	assert.match(r2.content[0].text, /only 'delegate' nodes can be delegated/);
	assert.equal(frames.length, 0, "no frame leaked on mode reject");
	ok("inline-mode node rejected (must delegate only 'delegate' nodes)");

	// 3. Unknown node id: reject.
	const r3 = await tool.execute("t3", { node_id: "does-not-exist" });
	assert.match(r3.content[0].text, /out of your scope/);
	assert.equal(frames.length, 0);
	ok("unknown node id rejected");

	// 4. A valid delegate node passes the guards, rebinds the node + emits agent_spawned.
	//    With a stub runtime, sub.prompt() fails → execute catches it, records the failure
	//    on the node, and returns a readable result (not a throw). The pre-LLM side effects
	//    + the robust finally (agent_ended always paired) are what we assert; a full run
	//    needs a real provider via `make dev`.
	const r4 = await tool.execute("t4", { node_id: aId });
	assert.match(r4.content[0].text, /failed/);
	const spawned = frames.filter((f) => f.type === "agent_spawned");
	assert.equal(spawned.length, 1, "exactly one agent_spawned for the delegated node");
	assert.equal(spawned[0].parentAgentId, MAIN, "parentAgentId is the caller");
	assert.equal(spawned[0].kind, "dagSub");
	ok("valid delegate emits one agent_spawned (kind dagSub, caller as parent)");

	const aView = dags.view(MAIN, aId)?.[0];
	assert.ok(aView, "main still sees node A (subtree-authority retained)");
	assert.equal(aView.status, "in_progress", "node marked in_progress");
	assert.notEqual(aView.ownerAgent, MAIN, "node rebound to the spawned sub-agent");
	ok("delegated node rebound to sub-agent + marked in_progress (parent retains authority)");

	// agent_ended is emitted in the finally even though prompt() failed.
	assert.equal(frames.filter((f) => f.type === "agent_ended").length, 1, "exactly one agent_ended");
	ok("agent_ended always paired with agent_spawned — no leaked live agents on failure");

	console.log(`\ndelegate guard smoke: ${checks.length} checks passed`);
	console.log(checks.join("\n"));
})().catch((err) => {
	console.error("\ndelegate guard smoke FAILED:", err);
	process.exit(1);
});
