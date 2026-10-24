/**
 * Live async run_agent test: the main agent launches a BACKGROUND sub-agent
 * (`run_agent` with `async: true`) through the real provider chain. Verifies
 * the full loop: tool returns a started marker at once → turn 1 ends without
 * the sub's answer → sub streams + persists under its own agentId → on
 * completion the runtime injects the result as an [async-agent] user message
 * and wakes the main agent (turn 2 synthesizes the answer for the user).
 */
import { WebSocket } from "ws";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://localhost:4317/api";
const pid = "5267443f-94cf-4058-8ced-ffb545ff327b";
const sessionsDir = join(homedir(), ".clownfish", "sessions");

const createRes = await fetch(`${BASE}/projects/${pid}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const sid = (await createRes.json()).id;
console.log("SID", sid);

const frames = [];
const mainEnds = []; // client-side receive time per main agent_end
const mainTexts = []; // final texts per main turn, in order
let curText = "";
let done;
const finished = new Promise((r) => (done = r));
const ws = new WebSocket("ws://localhost:4317/chat");
const mainToolCalls = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	frames.push(f);
	const isMain = f.agentId === undefined || f.agentId === sid;
	if (f.type === "agent_end" && isMain) {
		mainEnds.push(Date.now());
		mainTexts.push(curText);
		curText = "";
		console.log(`\n=== main agent_end #${mainEnds.length} === ${mainTexts[mainTexts.length - 1].slice(0, 120).replace(/\n/g, " ")}`);
		if (mainEnds.length >= 2) done();
	} else if (f.type === "message_start" && isMain) curText = "";
	else if (f.type === "message_end" && isMain) curText = (f.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
	else if (f.type === "agent_spawned") console.log(`[agent_spawned] ${f.kind} ${f.agentId.slice(0, 8)} parent=${(f.parentAgentId ?? "").slice(0, 8)} :: ${f.label ?? ""} name=${f.name ?? ""}`);
	else if (f.type === "agent_ended") console.log(`[agent_ended] ${f.agentId.slice(0, 8)}`);
	else if (f.type === "tool_start" && isMain) {
		mainToolCalls.push(f.toolName);
		console.log(`[main tool] ${f.toolName}`);
	} else if (f.type === "error") console.log(`[error] ${f.message}`);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log("\n[timeout 360s]"); process.exit(2); }, 360_000);

ws.on("open", () =>
	setTimeout(
		() =>
			ws.send(
				JSON.stringify({
					type: "prompt",
					text: "请用 run_agent 工具启动一个后台子代理：这次调用必须带参数 async: true（后台模式）。子代理 task：统计 agent/ 目录下有多少个 .ts 文件，并要求它在最终回答末尾包含短语 BG-DONE-42。后台模式下调用会立刻返回，你不要等待也不要轮询，先简短回复我“已启动”。任务完成后结果会以 [async-agent] 消息自动送达给你，届时再告诉我统计结果。",
				}),
			),
		500,
	),
);
await finished;
await new Promise((r) => setTimeout(r, 2000));

// ---- verify frames ----
const spawned = frames.filter((f) => f.type === "agent_spawned");
const subs = spawned.filter((f) => f.kind === "dagSub");
const ended = frames.filter((f) => f.type === "agent_ended").map((f) => f.agentId);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) pass++; else fail++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
ok("main called run_agent", mainToolCalls.includes("run_agent"), mainToolCalls.join(","));
ok("one dagSub spawned", subs.length === 1, String(subs.length));
ok("sub ended (spawn/ended pair)", subs.length === 1 && ended.includes(subs[0].agentId));
ok("main ran a second turn (the wake)", mainEnds.length >= 2, String(mainEnds.length));

// ---- verify persisted state ----
const idx = await readFile(join(sessionsDir, sid, "index.jsonl"), "utf8").catch(() => "");
ok("marker tool result persisted", idx.includes("Background sub-agent") && idx.includes("do not wait or poll"), idx.length + "B");
ok("[async-agent] result message injected into main history", idx.includes("[async-agent] Background sub-agent"), "");
ok("injected result carries the sub's answer (magic phrase)", idx.includes("BG-DONE-42"), "");
ok("wake turn answered for the user", (mainTexts[mainTexts.length - 1] ?? "").length > 30, (mainTexts[mainTexts.length - 1] ?? "").slice(0, 80));
{
	const files = await readdir(join(sessionsDir, sid));
	const subTx = files.includes(`${subs[0].agentId}.jsonl`) ? await readFile(join(sessionsDir, sid, `${subs[0].agentId}.jsonl`), "utf8") : "";
	ok("sub transcript persisted with its task", subTx.length > 0 && /统计|\.ts/.test(subTx), subTx.length + "B");
}

console.log(`\nlive-runagent-async: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
