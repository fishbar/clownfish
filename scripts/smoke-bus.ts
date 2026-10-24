/**
 * Event-bus interest-filter smoke test — no server. Exercises fanOut's per-
 * subscriber agentId filtering (the generic-pipe contract).
 * Run: `npx tsx scripts/smoke-bus.ts`
 *
 * - whole-session subscriber (interest undefined) → receives EVERYTHING.
 * - drill-in subscriber (interest = "agent-X") → only X's stream + structural frames.
 */
import assert from "node:assert/strict";
import { fanOut } from "../agent/proxy";
import type { ServerToClient } from "../server/protocol";

interface FakeWs {
	readyState: number;
	bufferedAmount: number;
	received: ServerToClient[];
	send(s: string): void;
}

const mkWs = (): FakeWs => ({ readyState: 1 /* OPEN */, bufferedAmount: 0, received: [], send(s) { this.received.push(JSON.parse(s)); } });

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	const main = mkWs(); // whole-session view
	const drill = mkWs(); // drill-in to agent-X
	// fanOut expects Map<WebSocket, string | undefined>.
	const subs = new Map<FakeWs, string | undefined>([[main, undefined], [drill, "agent-X"]]);

	// 1. agent-scoped frames: main's stream should reach the whole-session sub only.
	fanOut(subs as unknown as Map<WebSocket, string | undefined>, [
		{ type: "agent_start", agentId: "agent-main" },
		{ type: "text_delta", delta: "hello from main", agentId: "agent-main" },
	]);
	assert.equal(main.received.length, 2, "main view gets both main frames");
	assert.equal(drill.received.length, 0, "drill-in to X does NOT get main's stream");
	ok("main's stream frames reach whole-session view only");

	// 2. agent-scoped frames for the drilled-in agent reach BOTH (main view sees all;
	//    drill view sees its own stream).
	drill.received.length = 0;
	main.received.length = 0;
	fanOut(subs as unknown as Map<WebSocket, string | undefined>, [
		{ type: "text_delta", delta: "X working", agentId: "agent-X" },
		{ type: "tool_start", toolCallId: "t1", toolName: "Read", args: {}, agentId: "agent-X" },
		{ type: "agent_end", agentId: "agent-X" },
	]);
	assert.equal(drill.received.length, 3, "drill-in gets all of X's stream");
	assert.deepEqual(drill.received.map((f) => f.type), ["text_delta", "tool_start", "agent_end"]);
	assert.equal(main.received.length, 3, "whole-session view ALSO gets X's stream");
	ok("drilled-in agent's stream reaches both drill and whole-session views");

	// 3. structural frames reach everyone regardless of interest (the drill-in view
	//    must still learn about new agents / errors / approvals to render the tree).
	drill.received.length = 0;
	main.received.length = 0;
	fanOut(subs as unknown as Map<WebSocket, string | undefined>, [
		{ type: "agent_spawned", agentId: "agent-X", kind: "dagSub", parentAgentId: "agent-main" },
		{ type: "error", message: "boom" },
		{ type: "tool_approval", toolCallId: "ap", toolName: "Edit", args: {}, agentId: "agent-X" },
		{ type: "session_meta", title: "new title" },
		{ type: "agent_ended", agentId: "agent-Y" }, // a DIFFERENT agent than the drill interest
	]);
	assert.equal(main.received.length, 5, "whole-session view gets all structural frames");
	assert.equal(drill.received.length, 5, "drill-in ALSO gets all structural frames — incl. agent_ended for a different agent");
	ok("structural frames (spawned/error/approval/meta/ended) reach every subscriber");

	// 4. a frame carrying the drilled-in agent's id but with NO matching interest on a
	//    third whole-session subscriber is still delivered (whole-session = everything).
	const third = mkWs();
	subs.set(third, undefined);
	third.received.length = 0;
	drill.received.length = 0;
	fanOut(subs as unknown as Map<WebSocket, string | undefined>, [{ type: "text_delta", delta: "z", agentId: "agent-Z" }]);
	assert.equal(third.received.length, 1, "whole-session sees agent-Z too");
	assert.equal(drill.received.length, 0, "drill-in to X does NOT see agent-Z");
	ok("whole-session sees every agent; drill-in strictly scoped to its agent");

	console.log(`\nEvent-bus smoke: ${checks.length} checks passed`);
	console.log(checks.join("\n"));
})().catch((err) => {
	console.error("\nEvent-bus smoke FAILED:", err);
	process.exit(1);
});
