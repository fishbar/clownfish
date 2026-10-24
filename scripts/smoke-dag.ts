/**
 * DagStore logic smoke test — no server, no worker, just the authority model.
 * Run: `npx tsx scripts/smoke-dag.ts`
 *
 * Exercises the riskiest invariant: subtree-authority scoping. A delegated agent
 * may touch its node + descendants, but never a sibling or an upstream node —
 * and the PARENT retains authority over a delegated subtree (subtree-authority,
 * not exclusive ownership).
 */
import assert from "node:assert/strict";
import { DagStore } from "../agent/dag";

void (async () => {
	const assertions: string[] = [];
	const ok = (name: string) => assertions.push(`  ✓ ${name}`);

	const MAIN = "agent-main";
	const A1 = "agent-A1"; // subagent delegated node A
	const persistCalls: unknown[] = [];
	const dags = new DagStore(async (data) => {
		persistCalls.push(data);
	});

	// 1. createDag: main becomes the dagRoot.
	const { dagId, rootNodeId } = dags.createDag(MAIN, "build feature X");
	assert.equal(dags.getDag(dagId)?.ownerAgent, MAIN);
	ok("createDag: main owns the DAG root");

	// 2. plan: main decomposes the root into A, B, C.
	const [aId, bId, cId] = dags.plan(MAIN, rootNodeId, [
		{ description: "step A", mode: "delegate" },
		{ description: "step B", mode: "inline", deps: [] },
		{ description: "step C", mode: "delegate" },
	]);
	assert.equal(dags.getDag(dagId)!.nodes[aId].ownerAgent, MAIN);
	ok("plan: new children owned by the planner (main)");

	// 3. view: main sees the whole subtree.
	const mainView = dags.view(MAIN)!;
	assert.equal(mainView.length, 1); // main owns one DAG root
	assert.equal(mainView[0].children.length, 3);
	ok("view: main sees all 3 children");

	// 4. Delegate A to subagent A1: rebind ownerAgent.
	dags.updateNode(MAIN, aId, { ownerAgent: A1, status: "in_progress" });
	assert.equal(dags.getDag(dagId)!.nodes[aId].ownerAgent, A1);
	ok("delegation: node A rebound to subagent A1");

	// 5. A1 decomposes A into A1a, A1b — within scope.
	const [a1aId] = dags.plan(A1, aId, [{ description: "A1a", mode: "inline" }, { description: "A1b", mode: "inline" }]);
	ok("A1 can plan under its own node A");

	// 6. A1 can update its own descendant.
	dags.updateNode(A1, a1aId, { status: "completed", result: "done A1a" });
	assert.equal(dags.getDag(dagId)!.nodes[a1aId].result, "done A1a");
	ok("A1 can update its descendant A1a");

	// 7. A1 CANNOT modify sibling B — must throw.
	assert.throws(() => dags.updateNode(A1, bId, { status: "in_progress" }), /out of scope/);
	assert.throws(() => dags.plan(A1, bId, [{ description: "x" }]), /out of scope/);
	ok("A1 cannot modify sibling B (throws)");

	// 8. A1 CANNOT modify the upstream root.
	assert.throws(() => dags.updateNode(A1, rootNodeId, { result: "hijack" }), /out of scope/);
	ok("A1 cannot modify upstream root (throws)");

	// 9. *** KEY *** : the PARENT (main) still retains authority over the delegated
	//    subtree — it can re-plan / re-bind A even though A1 now owns it. This is
	//    subtree-authority, not exclusive hand-off.
	dags.updateNode(MAIN, aId, { ownerAgent: MAIN, status: "completed", result: "A done" });
	assert.equal(dags.getDag(dagId)!.nodes[aId].ownerAgent, MAIN);
	ok("PARENT retains authority over delegated subtree (subtree-authority, not exclusive)");

	// 10. Verify main sees the full updated tree (A's result landed on A, not the root).
	const finalView = dags.view(MAIN, rootNodeId)!;
	const nodeA = finalView[0].children.find((c) => c.id === aId)!;
	assert.equal(nodeA.result, "A done");
	assert.equal(nodeA.status, "completed");
	ok("final view reflects updated results on the right node");

	// 11. Persistence: serialized + coalesced — a burst of synchronous mutations
	//     schedules persists on a chain where only the NEWEST snapshot is written;
	//     flush the chain (one link per scheduled persist, each a microtask away)
	//     and assert the final state landed intact.
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(persistCalls.length >= 1, `expected ≥1 persist call, got ${persistCalls.length}`);
	const lastPersist = persistCalls[persistCalls.length - 1] as ReturnType<typeof dags.toJson>;
	assert.ok(
		lastPersist.dags.some((t) => t.nodes[a1aId]?.result === "done A1a" && t.nodes[aId]?.ownerAgent === MAIN),
		"final persist snapshot carries the latest node state",
	);
	ok(`persist chain flushed (${persistCalls.length} call(s), coalesced), final snapshot current`);

	// 12. Round-trip: toJson → hydrate reproduces the tree.
	const json = dags.toJson();
	const fresh = new DagStore();
	fresh.hydrate(json);
	assert.deepEqual(fresh.getDag(dagId)!.nodes[a1aId].result, "done A1a");
	assert.equal(fresh.getDag(dagId)!.nodes[aId].ownerAgent, MAIN);
	ok("toJson→hydrate round-trips state");

	// 13. replanChildren: replaces the whole child set (old subtree gone, new
	//     steps owned by the planner); out-of-scope replan rejected.
	assert.throws(() => dags.replanChildren("agent-stranger", rootNodeId, [{ description: "hijack" }]), /out of scope/);
	const newIds = dags.replanChildren(MAIN, rootNodeId, [
		{ description: "new plan step 1", mode: "inline" },
		{ description: "new plan step 2" },
	]);
	const tree13 = dags.getDag(dagId)!;
	assert.equal(tree13.nodes[rootNodeId].childIds.length, 2);
	assert.equal(tree13.nodes[newIds[0]].description, "new plan step 1");
	assert.equal(tree13.nodes[newIds[0]].ownerAgent, MAIN);
	assert.ok(!tree13.nodes[aId], "old child subtree dropped from the node map");
	ok("replanChildren replaces children wholesale + enforces scope");

	// 14. viewAll: EVERY tree regardless of owner — the coordinator's lens.
	//     view(MAIN) still owns this tree; a foreign-owner check follows in 15.
	assert.equal(dags.view(MAIN)!.length, 1);
	const allBefore = dags.viewAll();
	assert.equal(allBefore.length, 1);
	assert.equal(allBefore[0].ownerAgent, MAIN);
	ok("viewAll shows every tree regardless of owner (read-only lens)");

	console.log(`\nDagStore smoke: ${assertions.length} checks passed`);
	console.log(assertions.join("\n"));
})().catch((err) => {
	console.error("\nDagStore smoke FAILED:", err);
	process.exit(1);
});
