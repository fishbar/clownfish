/**
 * Verify the LIVE run_agent → sub link: prompt a scratch session to use
 * run_agent, then assert the agent_spawned frame carries the SAME toolCallId
 * as the run_agent tool_start frame (the UI's live drill link), and that the
 * sub's transcript shows up in GET /agents once the turn ends.
 */
import { WebSocket } from "ws";

const BASE = "http://localhost:4317/api";
const pid = "BWDvYYTtA2qG"; // scratch project used by earlier live tests

const sid = (await (await fetch(`${BASE}/projects/${pid}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).id;
console.log("SID", sid);

const toolCalls = new Map(); // toolCallId → toolName
let spawned = []; // agent_spawned frames
let mainEnded = false;

await new Promise((resolveDone, reject) => {
	const ws = new WebSocket("ws://localhost:4317/chat");
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
	ws.on("message", (data) => {
		const f = JSON.parse(data.toString());
		if (f.type === "ready") {
			setTimeout(() => ws.send(JSON.stringify({
				type: "prompt",
				text: "用 run_agent 工具派一个 sub-agent 去执行这个子任务：「用一句中文说明 1+1 等于几」。不要自己做，必须用 run_agent。",
			})), 300);
		}
		if (f.type === "tool_start") toolCalls.set(f.toolCallId, f.toolName);
		if (f.type === "agent_spawned") spawned.push({ agentId: f.agentId, toolCallId: f.toolCallId, kind: f.kind, label: f.label });
		// Main-turn end is `agent_end` (agentId optional/absent for main);
		// `agent_ended` is the SUB-agent lifecycle frame.
		if (f.type === "agent_end" && (f.agentId ?? sid) === sid) {
			mainEnded = true;
			ws.close();
			resolveDone();
		}
	});
	ws.on("error", (e) => reject(new Error(`ws: ${e.message}`)));
	setTimeout(() => reject(new Error("timeout 360s")), 360_000);
}).catch((e) => {
	console.log(e.message);
	process.exit(2);
});

console.log("tool calls:", [...toolCalls.entries()].map(([id, n]) => `${n}:${id.slice(0, 14)}`).join(" "));
console.log("spawned frames:", JSON.stringify(spawned));

const runAgentIds = [...toolCalls.entries()].filter(([, n]) => n === "run_agent").map(([id]) => id);
if (runAgentIds.length === 0) {
	console.log("FAIL: the model did not call run_agent (or frames were missed)");
	process.exit(1);
}
const linked = spawned.filter((s) => s.toolCallId && runAgentIds.includes(s.toolCallId));
if (linked.length !== runAgentIds.length) {
	console.log("FAIL: agent_spawned frame(s) missing the toolCallId link");
	process.exit(1);
}
console.log("OK: every run_agent call has a linked agent_spawned frame");

// After the turn, the sub transcript must be REST-visible (the historical path).
await new Promise((r) => setTimeout(r, 1000));
const subs = await (await fetch(`${BASE}/projects/${pid}/sessions/${sid}/agents`)).json();
console.log("persisted subs:", subs.map((s) => ({ agentId: s.agentId, prompt: s.prompt.slice(0, 40) })));
const hit = subs.find((s) => s.prompt.includes("1+1"));
if (!hit) {
	console.log("FAIL: sub transcript not listed after turn end");
	process.exit(1);
}
const sub = await (await fetch(`${BASE}/projects/${pid}/sessions/${sid}/agents/${hit.agentId}`)).json();
console.log(`OK: sub ${hit.agentId} transcript readable (${sub.messages.length} messages)`);
console.log("PASS: live run_agent link + persisted drill-down both verified");
process.exit(0);
