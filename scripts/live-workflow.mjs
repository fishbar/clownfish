/**
 * Live workflow-tool test: prompt the main agent to run a deterministic
 * workflow script (2-agent parallel fan-out + a synthesis agent) through the
 * REAL provider chain. Verifies: workflow tool call on the main agent →
 * wfRoot frame (the per-run workflow agent) → dagSub frames nested under it
 * (parent = wf id, not the main agent) → sub transcripts on disk → final
 * summary lands in the main reply.
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
let progressUpdates = 0;
let progressFrames = 0;
let done;
const finished = new Promise((r) => (done = r));
const ws = new WebSocket("ws://localhost:4317/chat");
const mainToolCalls = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	frames.push(f);
	if (f.type === "agent_end" && (f.agentId === undefined || f.agentId === sid)) {
		console.log("\n=== main agent_end ===");
		done();
	} else if (f.type === "agent_spawned") console.log(`[agent_spawned] ${f.kind} ${f.agentId.slice(0, 8)} parent=${(f.parentAgentId ?? "").slice(0, 8)} :: ${f.label ?? ""} name=${f.name ?? ""}`);
	else if (f.type === "agent_ended") console.log(`[agent_ended] ${f.agentId.slice(0, 8)}`);
	else if (f.type === "tool_start" && (f.agentId ?? sid) === sid) {
		mainToolCalls.push(f.toolName);
		console.log(`[main tool] ${f.toolName}`);
	} else if (f.type === "tool_update" && (f.agentId ?? sid) === sid) {
		// Streaming workflow progress (full snapshot per update) — surface the header line only.
		if (f.text) {
			progressUpdates += 1;
			const line = f.text.split("\n")[0];
			if (line) console.log(`[progress] ${line}`);
		}
		// Structured twin (drives the drill-in view): steps + per-agent status.
		if (f.progress) {
			progressFrames += 1;
			const last = f.progress.agents[f.progress.agents.length - 1];
			if (last) console.log(`[steps] ${f.progress.agents.filter((a) => a.status !== "running").length}/${f.progress.agents.length} :: ${f.progress.agents.map((a) => `${a.status === "running" ? "…" : a.status === "done" ? "✓" : "✗"}${a.label}`).join(" ")}`);
		}
	} else if (f.type === "error") console.log(`[error] ${f.message}`);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log("\n[timeout 420s]"); process.exit(2); }, 420_000);

// 2-agent fan-out + synthesis: the canonical workflow shape.
ws.on("open", () =>
	setTimeout(
		() =>
			ws.send(
				JSON.stringify({
					type: "prompt",
					text: "请用 workflow 工具执行一个确定性脚本（不要用 plan/delegate）：meta 名为 live_wf_test；用 parallel 并行跑两个 agent（label 分别为 dag 摘要、transcript 摘要），分别总结 agent/dag.ts 和 agent/transcript.ts 的核心职责（各 2-3 句）；再用一个 agent（label 汇总）把两份结果合成一段中文汇总。最终把合成结果告诉我。",
				}),
			),
		500,
	),
);
await finished;
await new Promise((r) => setTimeout(r, 2000));

// ---- verify frames ----
const spawned = frames.filter((f) => f.type === "agent_spawned");
const roots = spawned.filter((f) => f.kind === "wfRoot");
const subs = spawned.filter((f) => f.kind === "dagSub");
const ended = frames.filter((f) => f.type === "agent_ended").map((f) => f.agentId);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) pass++; else fail++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
ok("main agent called the workflow tool", mainToolCalls.includes("workflow"), mainToolCalls.join(","));
ok("progress streamed via tool_update text", progressUpdates >= 3, String(progressUpdates));
{
	// Structured progress frames: every snapshot well-formed, statuses in the
	// trio, and the LAST one shows all agents settled (done/error).
	const pf = frames.filter((f) => f.type === "tool_update" && f.progress);
	const shaped = pf.every((f) => typeof f.progress.name === "string" && Array.isArray(f.progress.agents) && f.progress.agents.every((a) => ["running", "done", "error"].includes(a.status) && typeof a.label === "string"));
	const lastAll = pf.length > 0 && pf[pf.length - 1].progress.agents.length === 3 && pf[pf.length - 1].progress.agents.every((a) => a.status !== "running");
	ok("structured progress frames well-formed + final all-settled", shaped && lastAll, `frames=${pf.length}`);
}
{
	// Durable steps: the persisted main transcript's workflow toolResult text
	// embeds the Steps table (survives reload, REST history carries text only).
	const idx = await readFile(join(sessionsDir, sid, "index.jsonl"), "utf8").catch(() => "");
	ok("persisted result embeds the Steps table", idx.includes("Steps:") && idx.includes("汇总"), `index.jsonl ${idx.length}B`);
}
{
	// History recovery path (what the UI's drillWorkflow fallback does after a
	// reload): /agents lists the anchor (brief prompt = `Workflow "<name>"`),
	// its transcript holds a run record whose toolCallId matches THIS call and
	// whose subs cover every spawned agent id.
	const list = await fetch(`${BASE}/projects/${pid}/sessions/${sid}/agents`).then((r) => r.json());
	const anchor = list.find((s) => s.prompt.startsWith('Workflow "live_wf_test"'));
	ok("REST /agents lists the run anchor", Boolean(anchor), JSON.stringify(list.map((s) => s.prompt.slice(0, 30))));
	if (anchor) {
		const msgs = await fetch(`${BASE}/projects/${pid}/sessions/${sid}/agents/${anchor.agentId}`).then((r) => r.json());
		const texts = (msgs.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? "").join("")));
		const raw = [...texts].reverse().find((t) => t.startsWith("[clownfish:workflow-run] "));
		let rec = null;
		try { rec = JSON.parse(raw.slice("[clownfish:workflow-run] ".length)); } catch {}
		const toolCall = frames.find((f) => f.type === "tool_start" && f.toolName === "workflow");
		ok("anchor transcript holds the run record", Boolean(rec), raw?.slice(0, 80));
		ok("record toolCallId matches the call", rec?.toolCallId === toolCall?.toolCallId, `${rec?.toolCallId} vs ${toolCall?.toolCallId}`);
		ok("record subs cover every spawned agent", rec && subs.length === 3 && subs.every((s) => rec.subs.some((x) => x.id === s.agentId)), JSON.stringify(rec?.subs?.map((s) => s.label)));
	}
}
ok("exactly one wfRoot (the per-run workflow agent)", roots.length === 1, String(roots.length));
ok("wfRoot parent is the main agent", roots[0]?.parentAgentId === sid, roots[0]?.parentAgentId);
ok("three dagSub agents ran", subs.length === 3, String(subs.length));
ok("every dagSub nests under the wf root", subs.every((s) => s.parentAgentId === roots[0]?.agentId), JSON.stringify(subs.map((s) => s.parentAgentId?.slice(0, 8))));
ok("agent_ended covers every spawn", spawned.every((s) => ended.includes(s.agentId)));

// ---- verify on-disk state ----
const dir = join(sessionsDir, sid);
const files = await readdir(dir);
const wfTx = roots[0] && files.includes(`${roots[0].agentId}.jsonl`) ? await readFile(join(dir, `${roots[0].agentId}.jsonl`), "utf8") : "";
ok("wf agent transcript persisted", wfTx.includes("live_wf_test"));
const subTxs = await Promise.all(subs.map((s) => (files.includes(`${s.agentId}.jsonl`) ? readFile(join(dir, `${s.agentId}.jsonl`), "utf8") : "")));
ok("all sub transcripts persisted", subTxs.every((t) => t.length > 0));
ok("sub transcript holds its task", subTxs.some((t) => t.includes("agent/dag.ts")), subTxs.map((t) => t.length).join(","));

// ---- final reply carries the synthesis ----
const mainText = frames.filter((f) => f.type === "message_end" && (f.agentId ?? sid) === sid).map((f) => f.message?.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "").join("\n");
ok("final reply mentions the synthesis", /汇总|总结/.test(mainText) && mainText.length > 100, mainText.slice(0, 120));

console.log(`\nlive-workflow: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
