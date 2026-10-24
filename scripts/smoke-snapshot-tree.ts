/** Smoke: WorkerSnapshot now carries an agents[] tree; snapshotToFrames replays
 *  each live agent (spawned→start→text→tools) so a mid-run join self-heals. */
import { snapshotToFrames } from "../agent/proxy.js";
import type { WorkerSnapshot } from "../agent/protocol.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}`); };

const snap: WorkerSnapshot = {
	active: true,
	agents: [
		{ agentId: "s1", label: "main", kind: "main", active: true, agentStartedAt: 1, streamingText: "think", activeTools: [{ toolCallId: "t1", toolName: "bash", args: { command: "ls" }, startedAt: 5, pid: 42 }] },
		{ agentId: "sub-1", label: "实现 step1", kind: "dagSub", parentAgentId: "s1", active: true, agentStartedAt: 2, streamingText: "", activeTools: [] },
	],
};
const frames = snapshotToFrames(snap, "s1");
const types = frames.map((f) => f.type).join(",");
check("main replays start+text+tool without agent_spawned", !frames.some((f) => f.type === "agent_spawned" && f.agentId === "s1") && types.includes("agent_start") && types.includes("text_delta") && types.includes("tool_start"));
check("sub replays agent_spawned with parent+label", frames.some((f) => f.type === "agent_spawned" && f.agentId === "sub-1" && (f as any).parentAgentId === "s1" && (f as any).label === "实现 step1"));
check("sub replays agent_start", frames.some((f) => f.type === "agent_start" && f.agentId === "sub-1"));
check("idle main-only snapshot replays nothing", snapshotToFrames({ active: false, agents: [{ agentId: "s1", label: "main", kind: "main", active: false, agentStartedAt: 1, streamingText: "", activeTools: [] }] }, "s1").length === 0);
console.log(fail === 0 ? `smoke-snapshot-tree: ${pass} checks passed` : `FAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
