/**
 * Verify incremental persistence: during an in-flight turn (a bash sleep),
 * index.jsonl must ALREADY contain the user message + the assistant tool_use
 * message — not stay empty until agent_end (the old behavior that made a
 * mid-turn refresh show an empty conversation).
 */
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://localhost:4317/api";
const pid = "BWDvYYTtA2qG"; // scratch project used by earlier live tests
const sessionsDir = join(homedir(), ".clownfish", "sessions");

const createRes = await fetch(`${BASE}/projects/${pid}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const sid = (await createRes.json()).id;
const indexFile = join(sessionsDir, sid, "index.jsonl");
console.log("SID", sid);

const countEnvelopes = async () => {
	try {
		const raw = await readFile(indexFile, "utf8");
		return raw.split("\n").filter((l) => l.trim()).length;
	} catch {
		return -1; // file absent
	}
};

// Poll every second for the first moment the transcript becomes non-empty.
let firstNonEmptyAt = 0;
const poll = setInterval(async () => {
	const n = await countEnvelopes();
	if (n > 0 && !firstNonEmptyAt) firstNonEmptyAt = Date.now();
}, 1000);

let midTurnCount = -1; // envelopes at the moment bash is running (turn in-flight)
let sawAgentEnd = false;
const startedAt = Date.now();
await new Promise((resolveDone) => {
	const ws = new WebSocket("ws://localhost:4317/chat");
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
	ws.on("message", (data) => {
		const f = JSON.parse(data.toString());
		if (f.type === "ready") {
			setTimeout(() => ws.send(JSON.stringify({
				type: "prompt",
				text: "用 bash 执行 `sleep 10 && echo done`，然后把输出原样告诉我。不要做别的。",
			})), 300);
		}
		// bash reported its pid → the tool is executing → the turn is mid-flight.
		if (f.type === "tool_update" && f.pid !== undefined) void countEnvelopes().then((n) => { midTurnCount = n; });
		if (f.type === "agent_ended" && f.agentId === sid) { sawAgentEnd = true; ws.close(); resolveDone(); }
	});
	ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
	setTimeout(() => { console.log("[timeout 120s]", { sawAgentEnd }); process.exit(2); }, 120_000);
});
clearInterval(poll);

const final = await countEnvelopes();
const firstPersistSec = firstNonEmptyAt ? ((firstNonEmptyAt - startedAt) / 1000).toFixed(1) : "never";
console.log(`mid-turn (bash running) envelopes: ${midTurnCount}`);
console.log(`first non-empty transcript at +${firstPersistSec}s (turn still in flight)`);
console.log(`final envelopes after agent_end: ${final}`);

let fail = "";
if (midTurnCount < 2) fail = `FAIL: transcript had ${midTurnCount} envelope(s) while the turn was mid-flight (need ≥2: user + tool_use) — persistence still end-of-turn only`;
if (final < 4) fail = `FAIL: transcript incomplete after turn end (${final})`;
if (fail) { console.log(fail); process.exit(1); }
console.log("PASS: incremental persistence verified — mid-turn refresh would show the conversation-so-far");
process.exit(0);
