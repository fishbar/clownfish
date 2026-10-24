/**
 * Live sync-DAG test: prompt the main agent to plan + delegate a fan-out.
 * Verifies the whole chain with a REAL provider: plan tool → DAG persisted →
 * agent_spawned frames (dagSub) → delegated transcripts on disk → final reply.
 */
import { WebSocket } from "ws";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://localhost:4317/api";
const pid = "BWDvYYTtA2qG";
const sessionsDir = join(homedir(), ".clownfish", "sessions");

const createRes = await fetch(`${BASE}/projects/${pid}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const sid = (await createRes.json()).id;
console.log("SID", sid);

const frames = [];
let done;
const finished = new Promise((r) => (done = r));
const ws = new WebSocket("ws://localhost:4317/chat");
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	frames.push(f);
	if (f.type === "agent_end" && (f.agentId === undefined || f.agentId === sid)) {
		console.log("\n=== main agent_end ===");
		done();
	} else if (f.type === "agent_spawned") console.log(`[agent_spawned] ${f.kind} ${f.agentId.slice(0, 8)} parent=${(f.parentAgentId ?? "").slice(0, 8)} :: ${f.label}`);
	else if (f.type === "agent_ended") console.log(`[agent_ended] ${f.agentId.slice(0, 8)}`);
	else if (f.type === "tool_start" && (f.agentId ?? sid) === sid) console.log(`[main tool] ${f.toolName}`);
	else if (f.type === "error") console.log(`[error] ${f.message}`);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log("\n[timeout 420s]"); process.exit(2); }, 420_000);

// A fan-out worth delegating: three independent research-ish steps.
ws.on("open", () =>
	setTimeout(() => ws.send(JSON.stringify({ type: "prompt", text: "请用 plan 工具把这个任务建成计划，然后把其中值得委派的步骤用 delegate 并行委派出去：分别总结 agent/dag.ts、agent/agents/delegate.ts、agent/worktree.ts 三个文件的核心职责（每个一段话），最后汇总给我。" })), 500),
);
await finished;
await new Promise((r) => setTimeout(r, 1500));

// ---- verify on-disk state ----
const dir = join(sessionsDir, sid);
const dag = JSON.parse(await readFile(join(dir, "dag.json"), "utf8"));
const idx = await readFile(join(dir, "index.jsonl"), "utf8");
const files = readdir;
let subs = [];
try { subs = (await files(dir)).filter((f) => f.endsWith(".jsonl") && f !== "index.jsonl"); } catch {}

console.log("\n---- verify ----");
console.log("dags:", dag.dags.length);
for (const t of dag.dags) {
	const root = t.nodes[t.rootId];
	console.log(`tree ${t.id.slice(0, 8)} goal="${t.goal}" root=${root.status}`);
	for (const cid of root.childIds) {
		const n = t.nodes[cid];
		console.log(`  - [${n.status}] (${n.mode}) ${n.description.slice(0, 50)} → ${(n.result ?? "").slice(0, 60)}`);
	}
}
console.log("main transcript lines:", idx.trim().split("\n").length);
console.log("subagent transcripts:", subs.length, subs.map((s) => s.slice(0, 8)));
const spawnedFrames = frames.filter((f) => f.type === "agent_spawned");
console.log("agent_spawned frames:", spawnedFrames.length, "(kind:", spawnedFrames.map((f) => f.kind).join(","), ")");
const subEventAgents = new Set(frames.filter((f) => f.type === "tool_start" && f.agentId && f.agentId !== sid).map((f) => f.agentId));
console.log("sub-agent stream frames from:", [...subEventAgents].map((a) => a.slice(0, 8)));
ws.close();
process.exit(0);
