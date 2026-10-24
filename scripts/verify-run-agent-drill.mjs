/**
 * Verify the run_agent drill-down data path end-to-end (no browser on this
 * board): take a HISTORICAL session, find its run_agent tool call in the main
 * transcript, rebuild the delegation prompt from the call's task/context args
 * exactly like the UI's drillRunAgent, match it against GET /agents, and read
 * the sub-agent transcript back. Usage: node scripts/verify-run-agent-drill.mjs <pid> <sid>
 */
const [, , pidArg, sidArg] = process.argv;
const pid = pidArg ?? "xeXgi38mt8wO";
const sid = sidArg ?? "fX0MbJEOszXi";
const base = `http://localhost:4317/api/projects/${pid}/sessions/${sid}`;

// 1. Main transcript: find run_agent toolCalls (name on the toolCall block, args on .input).
const page = await (await fetch(base)).json();
const calls = [];
for (const m of page.messages) {
	if (m.role !== "assistant") continue;
	for (const b of m.content) {
		if (b.type === "toolCall" && b.name === "run_agent") calls.push({ toolCallId: b.id, args: b.input });
	}
}
if (calls.length === 0) {
	console.log("FAIL: no run_agent toolCall in the main transcript");
	process.exit(1);
}

// 2. Sub list + prompt match, mirroring drillRunAgent (prompt built verbatim
//    like agent/agents/run-agent-tool.ts builds the sub's first user message).
const subs = await (await fetch(`${base}/agents`)).json();
for (const c of calls) {
	const a = c.args ?? {};
	const task = typeof a.task === "string" ? a.task : "";
	const context = typeof a.context === "string" && a.context.trim() ? a.context : undefined;
	const prompt = context ? `${task}\n\nContext:\n${context}` : task;
	const hit = subs.find((s) => s.prompt === prompt);
	if (!hit) {
		console.log(`FAIL: no sub transcript matched run_agent call ${c.toolCallId}`);
		process.exit(1);
	}
	// 3. Drill: read the sub conversation back.
	const sub = await (await fetch(`${base}/agents/${hit.agentId}`)).json();
	const roles = sub.messages.map((m) => m.role);
	const texts = sub.messages.filter((m) => m.role === "assistant" && typeof m.content !== "string" && m.content.some((b) => b.type === "text")).length;
	console.log(`OK run_agent ${c.toolCallId} → sub ${hit.agentId}: ${sub.messages.length} messages (${roles.join(",")}), ${texts} assistant text blocks`);
}
console.log("PASS: historical run_agent calls link to their sub-agent transcripts");
