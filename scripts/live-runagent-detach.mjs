/**
 * Live detach test: the main agent starts a SYNC run_agent (blocking), then
 * the script plays the user's 转后台 — sends the `detach_agent` frame over the
 * browser WS (exactly what the tool-card button does). Verifies: the main turn
 * RESUMES immediately (ends with a "已转后台" style reply, no sub result yet),
 * the sub keeps streaming under its own agentId, and when it settles the
 * runtime injects the result as an [async-agent] message + wake (second main
 * turn delivers the answer).
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
const mainTexts = [];
let curText = "";
let detached = false;
let done;
const finished = new Promise((r) => (done = r));
const ws = new WebSocket("ws://localhost:4317/chat");
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	frames.push(f);
	const isMain = f.agentId === undefined || f.agentId === sid;
	if (f.type === "agent_spawned" && f.kind === "dagSub" && !detached) {
		// The user presses 转后台 as soon as the sync sub exists.
		detached = true;
		console.log(`[detach] sending detach_agent for ${f.agentId.slice(0, 8)}`);
		ws.send(JSON.stringify({ type: "detach_agent", agentId: f.agentId }));
	} else if (f.type === "agent_end" && isMain) {
		mainTexts.push(curText);
		curText = "";
		console.log(`\n=== main agent_end #${mainTexts.length} === ${mainTexts[mainTexts.length - 1].slice(0, 140).replace(/\n/g, " ")}`);
		if (mainTexts.length >= 2) done();
	} else if (f.type === "message_start" && isMain) curText = "";
	else if (f.type === "message_end" && isMain) curText = (f.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
	else if (f.type === "agent_ended") console.log(`[agent_ended] ${f.agentId.slice(0, 8)}`);
	else if (f.type === "error") console.log(`[error] ${f.message}`);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log("\n[timeout 360s]"); process.exit(2); }, 360_000);

// SYNC (no async) + a task long enough to catch the run in-flight.
ws.on("open", () =>
	setTimeout(
		() =>
			ws.send(
				JSON.stringify({
					type: "prompt",
					text: "请用 run_agent 工具【同步模式，不要带 async 参数】启动一个子代理，task：通读 agent/runtime.ts 和 agent/manager.ts，各自总结核心职责（2-3 句），并在最终回答末尾包含短语 DETACH-OK-7。你就等它完成后再汇报即可。",
				}),
			),
		500,
	),
);
await finished;
await new Promise((r) => setTimeout(r, 2000));

const spawned = frames.filter((f) => f.type === "agent_spawned" && f.kind === "dagSub");
const ended = frames.filter((f) => f.type === "agent_ended").map((f) => f.agentId);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) pass++; else fail++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
ok("detach_agent sent while the sync sub ran", detached);
ok("one dagSub spawned", spawned.length === 1, String(spawned.length));
ok("sub ended (pair intact)", ended.includes(spawned[0]?.agentId ?? ""));
ok("main ran a second turn (the wake)", mainTexts.length >= 2, String(mainTexts.length));
const idx = await readFile(join(sessionsDir, sid, "index.jsonl"), "utf8").catch(() => "");
ok("detach marker persisted as the tool result", idx.includes("was moved to the background"), "");
ok("[async-agent] result message injected", idx.includes("[async-agent] Background sub-agent"), "");
ok("injected result carries the sub's answer", idx.includes("DETACH-OK-7"), "");
{
	const files = await readdir(join(sessionsDir, sid));
	const subTx = files.includes(`${spawned[0].agentId}.jsonl`) ? await readFile(join(sessionsDir, sid, `${spawned[0].agentId}.jsonl`), "utf8") : "";
	ok("sub transcript persisted with its task", subTx.length > 0 && subTx.includes("runtime.ts"), `${subTx.length}B`);
}

console.log(`\nlive-runagent-detach: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
