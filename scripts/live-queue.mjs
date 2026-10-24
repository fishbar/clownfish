/**
 * Live steer/followup test: while the main agent is mid-run, submit a second
 * message over the browser WS — exactly what the composer's busy path does.
 *
 * Phase A (steer):  prompt → wait for streaming → send {mode:"steer"} with a
 *   marker the model must echo. Assert: queue_state {steer:1} right after the
 *   enqueue, {steer:0} once drained, the drained message replays as a user
 *   message_end (the proxy passthrough), the marker lands in the SAME run's
 *   answer, and exactly ONE main agent_end fired (steer extends the loop).
 *
 * Phase B (followup): same shape with {mode:"followup"} — pi drains it at the
 *   run's stop boundary, so the run EXTENDS with fresh turns (still one
 *   agent_start/agent_end pair): the first answer (original task) has no
 *   marker, a later answer in the same run carries it.
 *
 * Transcript check: the queued texts land exactly once as user messages.
 */
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://localhost:4317/api";
const pid = "BWDvYYTtA2qG";
const sessionsDir = join(homedir(), ".clownfish", "sessions");

const createRes = await fetch(`${BASE}/projects/${pid}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const sid = (await createRes.json()).id;
console.log("SID", sid);

/** Main-agent frame collector (steer and followup both extend ONE run). */
function makeCollector() {
	const c = { runs: 0, ended: 0, texts: [], userEnds: [], queueStates: [] };
	c.started = new Promise((r) => (c._started = r));
	c.settled = new Promise((r) => (c._settled = r));
	return c;
}

const A = makeCollector();
const B = makeCollector();
let cur = A; // which collector is live

const ws = new WebSocket("ws://localhost:4317/chat");
await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
const send = (o) => ws.send(JSON.stringify(o));
send({ type: "hello", projectId: pid, sessionId: sid });

ws.on("message", (data) => {
	const f = JSON.parse(data.toString());
	const c = cur;
	const isMain = f.agentId === undefined || f.agentId === sid;
	if (!isMain && f.type !== "queue_state") return;
	if (f.type === "agent_start") {
		c.runs++;
		c._started();
	} else if (f.type === "agent_end") {
		c.ended++;
		if (c.ended >= 1 && (c === A || c === B)) c._settled();
	} else if (f.type === "message_end" && f.message?.role === "assistant") {
		c.texts.push((f.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));
	} else if (f.type === "message_end" && f.message?.role === "user") {
		const t = typeof f.message.content === "string" ? f.message.content : (f.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
		c.userEnds.push(t);
	} else if (f.type === "queue_state") {
		c.queueStates.push(`${f.steer}/${f.followup}`);
	} else if (f.type === "error") {
		console.log(`[error] ${f.message}`);
	}
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.log("\n[timeout 480s]"); process.exit(2); }, 480_000);

// ---- Phase A: steer ------------------------------------------------------------------
send({
	type: "prompt",
	text: "请通读 agent/runtime.ts 全文并写一份详细的逐段职责说明(要长一些,确保你会运行一段时间)。先不用总结,等我后续指令。",
});
await A.started;
await new Promise((r) => setTimeout(r, 5000)); // let streaming establish
const steerText = "【插入指令】请在你的最终回答的末尾单独一行写上标记 STEER-OK-42,并简短说明你在运行中收到了这条插入消息。";
send({ type: "prompt", text: steerText, mode: "steer" });
console.log("[A] steer submitted mid-run");
await A.settled;
await new Promise((r) => setTimeout(r, 1500));
cur = B;

// ---- Phase B: followup ---------------------------------------------------------------
send({
	type: "prompt",
	text: "请通读 agent/manager.ts 全文并写一份详细的逐段职责说明(要长一些)。先不用总结,等我后续指令。",
});
await B.started;
await new Promise((r) => setTimeout(r, 5000));
const followText = "【排队指令】请在后续回答的末尾单独一行写上标记 FOLLOWUP-OK-43。";
send({ type: "prompt", text: followText, mode: "followup" });
console.log("[B] followup submitted mid-run");
await B.settled;
await new Promise((r) => setTimeout(r, 1500));

// ---- assertions ----------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) pass++; else fail++;
	console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

const aAll = A.texts.join("\n--\n");
ok("A: queue_state showed steer:1 after enqueue", A.queueStates.some((s) => s.startsWith("1/")), A.queueStates.join(" "));
ok("A: queue_state back to 0/0 after drain", A.queueStates[A.queueStates.length - 1] === "0/0", A.queueStates.join(" "));
ok("A: drained steer replayed as user message_end", A.userEnds.some((t) => t.includes("STEER-OK-42")), JSON.stringify(A.userEnds).slice(0, 140));
ok("A: marker in the same run's answer (injected into the loop)", aAll.includes("STEER-OK-42"));
ok("A: exactly one main run (steer extends, no restart)", A.ended === 1, `runs=${A.runs} ended=${A.ended}`);

const bAll = B.texts.join("\n--\n");
ok("B: queue_state showed followup:1", B.queueStates.some((s) => s.endsWith("/1")), B.queueStates.join(" "));
ok("B: drained followup replayed as user message_end", B.userEnds.some((t) => t.includes("FOLLOWUP-OK-43")), JSON.stringify(B.userEnds).slice(0, 140));
ok("B: marker in a later answer of the SAME run", bAll.includes("FOLLOWUP-OK-43"));
ok("B: first answer (pre-drain task) has no marker", B.texts.length >= 2 && !B.texts[0].includes("FOLLOWUP-OK-43"), `${B.texts.length} answers`);
ok("B: exactly one main run (followup extends, no restart)", B.ended === 1, `runs=${B.runs} ended=${B.ended}`);

const idx = await readFile(join(sessionsDir, sid, "index.jsonl"), "utf8").catch(() => "");
const lines = idx.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const userSteer = lines.filter((e) => e.message?.role === "user" && JSON.stringify(e.message).includes("STEER-OK-42"));
const userFollow = lines.filter((e) => e.message?.role === "user" && JSON.stringify(e.message).includes("FOLLOWUP-OK-43"));
ok("transcript: queued steer persisted exactly once as user message", userSteer.length === 1, String(userSteer.length));
ok("transcript: queued followup persisted exactly once as user message", userFollow.length === 1, String(userFollow.length));

console.log(`\nlive-queue: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
