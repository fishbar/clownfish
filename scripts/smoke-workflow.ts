/**
 * workflow-tool smoke — the deterministic script engine + its injected LLM
 * boundaries, end to end and LLM-free (provider seam stubbed with
 * AssistantMessageEventStream, same technique as smoke-runagent-cwd):
 *
 *   1. Date.now() script → determinism rejected by the AST validator.
 *   2. Missing meta header → parse error returned as tool text.
 *   3. agent() script → wf root agent (dagRoot frame) + sub-agent (dagSub
 *      frame, parent = wf id), transcripts persisted, sub text returned.
 *   4. llm() → tmpLLM one-shot (stateless by default, context:true
 *      accumulates on the wf agent), never enters the tool loop.
 *   5. parallel() → two sub-agents run, results in input order.
 *   6. pre-aborted signal → "Workflow aborted." result.
 *   7. schema → structured_output captures validated args; `terminate: true`
 *      ends the sub's loop after ONE streamFn call.
 *   8. llm()-only script (no agent()) → the "must call agent()" guard.
 *
 * Run: `npx tsx scripts/smoke-workflow.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { createWorkflowTool } from "../agent/tools/workflow";
import type { ResolvedRuntime } from "../agent/models";
import type { AgentDefinition } from "../agent/agents/types";
import type { WorkerFrame } from "../agent/protocol";

const work = mkdtempSync(join(tmpdir(), "smoke-workflow-"));
const sessionsDir = join(work, "sessions");
const sessionId = "s1";

/** Captured provider requests (one entry per streamFn call). */
const calls: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
/** Scripted replies, consumed in call order; exhausted → plain final text. */
const script: Array<{ text?: string; toolCall?: { name: string; args: unknown } }> = [];
let call = 0;

const streamFn = (_model: unknown, request: { systemPrompt?: string; messages?: unknown[] }) => {
	calls.push({ systemPrompt: request?.systemPrompt, messages: request?.messages ?? [] });
	call += 1;
	const step = script[call - 1] ?? { text: `default-final-${call}` };
	const s = new AssistantMessageEventStream();
	const text = step.text ?? `reply-to-call-${call}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: step.toolCall
			? [{ type: "toolCall", id: "c1", name: step.toolCall.name, arguments: step.toolCall.args }]
			: [{ type: "text", text }],
		api: "pi-messages",
		provider: "stub",
		model: "stub-model",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as Usage,
		stopReason: step.toolCall ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	void (async () => {
		s.push({ type: "start", partial: { ...message, content: [...message.content] } });
		s.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		s.end(message);
	})();
	return s;
};

const runtime = { streamFn, model: { provider: "stub", id: "stub-model" } } as unknown as ResolvedRuntime;
const agents: AgentDefinition[] = [
	{ name: "reviewer", description: "test persona", body: "PERSONA-MARKER {cwd}", path: "/tmp/reviewer.md", source: "builtin", access: "R" },
];
const frames: WorkerFrame[] = [];
const mkTool = () =>
	createWorkflowTool({
		agents,
		runtime,
		cwd: work,
		skills: [],
		vars: { cwd: work, project: "p", sessionId, date: "2026-08-23", os: "linux" },
		sessionId,
		sessionsDir,
		agentId: "parent-1",
		onFrame: (f) => frames.push(f),
	});

const text = async (tool: ReturnType<typeof mkTool>, script_: string, args?: unknown, signal?: AbortSignal) => {
	const res = await tool.execute("tc", { script: script_, ...(args !== undefined ? { args } : {}) } as never, signal);
	return (res.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text ?? "";
};

const META = "export const meta = { name: 'smoke_wf', description: 'smoke workflow' };";
const out: string[] = [];
let failed = 0;
const ok = (name: string, cond: boolean, extra = "") => {
	if (!cond) failed++;
	out.push(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

// ---- 1. determinism guard ------------------------------------------------------
{
	const t = await text(mkTool(), `${META}\nconst t = Date.now();\nreturn t;`);
	ok("1. Date.now() rejected", t.includes("deterministic"), t);
	const t2 = await text(mkTool(), `${META}\nreturn Math.random();`);
	ok("1. Math.random() rejected", t2.includes("deterministic"), t2);
}

// ---- 2. missing meta header ----------------------------------------------------
{
	const t = await text(mkTool(), "return 1;");
	ok("2. missing meta rejected", t.includes("must be the first statement"), t);
}

// ---- 3. agent(): frames, transcript, sub text ----------------------------------
{
	frames.length = 0;
	calls.length = 0;
	script.length = 0;
	call = 0;
	script.push({ text: "SUB-FINAL-TEXT" });
	const t = await text(mkTool(), `${META}\nconst r = await agent('do the thing', { label: 'worker one' });\nreturn { out: r };`);
	ok("3. sub text lands in result", t.includes("SUB-FINAL-TEXT") && t.includes("smoke_wf completed with 1 agent(s)"), t);
	const spawned = frames.filter((f) => f.type === "agent_spawned") as Array<{ type: "agent_spawned"; kind: string; agentId: string; parentAgentId?: string; label?: string }>;
	const roots = spawned.filter((f) => f.kind === "wfRoot");
	const subs = spawned.filter((f) => f.kind === "dagSub");
	ok("3. one wfRoot frame (label = meta.name)", roots.length === 1 && roots[0].label === "smoke_wf" && roots[0].parentAgentId === "parent-1", JSON.stringify(roots));
	ok("3. one dagSub frame (parent = wf id)", subs.length === 1 && subs[0].parentAgentId === roots[0].agentId && subs[0].label === "worker one", JSON.stringify(subs));
	const ended = frames.filter((f) => f.type === "agent_ended") as Array<{ type: "agent_ended"; agentId: string }>;
	ok("3. agent_ended pairs every spawn", ended.length === 2 && new Set(ended.map((e) => e.agentId)).size === 2);
	const wfTx = join(sessionsDir, sessionId, `${roots[0].agentId}.jsonl`);
	const subTx = join(sessionsDir, sessionId, `${subs[0].agentId}.jsonl`);
	ok("3. wf transcript persisted with brief", existsSync(wfTx) && readFileSync(wfTx, "utf8").includes("smoke_wf"), wfTx);
	{
		// Durable run record (post-reload recovery): prefix + toolCallId + settled
		// progress + this sub's id — everything the UI rebuild needs. (The record
		// rides INSIDE a JSONL envelope string — parse before matching.)
		const tx = existsSync(wfTx) ? readFileSync(wfTx, "utf8") : "";
		const content = tx
			.split("\n")
			.filter(Boolean)
			.map((l) => (JSON.parse(l).message ?? {}).content)
			.find((c: unknown) => typeof c === "string" && c.startsWith("[clownfish:workflow-run] "));
		ok("3. run record persisted (toolCallId + sub id + progress)", typeof content === "string" && content.includes('"toolCallId":"tc"') && content.includes(subs[0].agentId) && content.includes('"status":"done"'), String(content).slice(0, 140));
	}
	ok("3. sub transcript persisted with task", existsSync(subTx) && readFileSync(subTx, "utf8").includes("do the thing"), subTx);
	// The sub is a full agent: system prompt carries the default workflow-sub persona.
	ok("3. sub got persona + env system prompt", (calls[0]?.systemPrompt ?? "").includes("workflow sub-agent"), (calls[0]?.systemPrompt ?? "").slice(0, 80));
}

// ---- 4. llm(): tmpLLM side call, context accumulation --------------------------
{
	frames.length = 0;
	calls.length = 0;
	script.length = 0;
	call = 0;
	script.push({ text: "STATELESS-REPLY" }, { text: "CTX1-REPLY" }, { text: "CTX2-REPLY" });
	const t = await text(
		mkTool(),
		`${META}\nconst a = await llm('stateless question');\nconst b = await llm('ctx question one', { context: true });\nconst c = await llm('ctx question two', { context: true });\nawait agent('anchor');\nreturn { a, b, c };`,
	);
	ok("4. llm replies land in result", t.includes("STATELESS-REPLY") && t.includes("CTX2-REPLY"), t);
	// calls 1-3 = the three llm() side calls; call 4 = the anchor sub-agent.
	const stateless = JSON.stringify(calls[0]?.messages ?? []);
	const ctx1 = JSON.stringify(calls[1]?.messages ?? []);
	const ctx2 = JSON.stringify(calls[2]?.messages ?? []);
	ok("4. stateless llm sees only its prompt", stateless.includes("stateless question") && !stateless.includes("Workflow"), stateless.slice(0, 120));
	ok("4. first context llm sees the brief only", ctx1.includes("ctx question one") && !ctx1.includes("stateless question") && !ctx1.includes("CTX1-REPLY"), ctx1.slice(0, 160));
	ok("4. second context llm sees the accumulated exchange", ctx2.includes("ctx question one") && ctx2.includes("CTX1-REPLY") && ctx2.includes("ctx question two"), ctx2.slice(0, 200));
	ok("4. stateless call stays invisible to context mode", !ctx2.includes("stateless question") && !ctx2.includes("STATELESS-REPLY"), ctx2.slice(0, 200));
	ok("4. llm() never runs a tool loop", (calls[0]?.systemPrompt ?? "").includes("anchor") === false);
}

// ---- 5. parallel(): two subs, results in input order ---------------------------
{
	frames.length = 0;
	calls.length = 0;
	script.length = 0;
	call = 0;
	script.push({ text: "alpha-result" }, { text: "beta-result" });
	const t = await text(
		mkTool(),
		`${META}\nconst rs = await parallel([\n  () => agent('task alpha', { label: 'A' }),\n  () => agent('task beta', { label: 'B' }),\n]);\nreturn { rs };`,
	);
	ok("5. parallel returns both in order", t.indexOf("alpha-result") < t.indexOf("beta-result"), t);
	const subs = frames.filter((f) => f.type === "agent_spawned" && (f as { kind?: string }).kind === "dagSub");
	ok("5. two dagSub frames under one root", subs.length === 2, String(subs.length));
	ok("5. completed with 2 agents", t.includes("completed with 2 agent(s)"), t);
}

// ---- 6. abort → "Workflow aborted." --------------------------------------------
{
	frames.length = 0;
	const ac = new AbortController();
	ac.abort();
	const t = await text(mkTool(), `${META}\nconst r = await agent('never runs');\nreturn r;`, undefined, ac.signal);
	ok("6. pre-aborted signal short-circuits", t.startsWith("Workflow aborted."), t);
	// Lazy anchor: the abort fires (engine hook) before agent() reaches the
	// runner → no wfRoot frame, no agent_ended, nothing materialized at all.
	ok("6. lazy anchor: pre-abort emits zero frames", frames.length === 0, JSON.stringify(frames.map((f) => f.type)));
}

// ---- 7. schema: structured_output capture + terminate ---------------------------
{
	frames.length = 0;
	calls.length = 0;
	script.length = 0;
	call = 0;
	script.push({ toolCall: { name: "structured_output", args: { answer: 42, note: "captured" } } });
	const t = await text(mkTool(), `${META}\nconst r = await agent('compute', { label: 'S', schema: { type: 'object', properties: { answer: { type: 'number' }, note: { type: 'string' } }, required: ['answer'] } });\nreturn r;`);
	ok("7. schema value captured and returned", t.includes("42") && t.includes("captured"), t);
	ok("7. terminate ended the loop after one call", calls.length === 1, `streamFn calls: ${calls.length}`);
	ok("7. result is the object (not lastAssistantText)", /"answer": 42/.test(t), t);
}

// ---- 8. agent()-less script → the guard ----------------------------------------
{
	frames.length = 0;
	const t = await text(mkTool(), `${META}\nconst a = await llm('solo');\nreturn a;`);
	ok("8. llm-only script refused", t.includes("must call agent()"), t);
	// llm() IS an LLM boundary — the anchor materializes for it (context mode
	// rides it), frames pair, and the run record persists with zero subs.
	const spawns = frames.filter((f) => f.type === "agent_spawned") as Array<{ kind: string }>;
	const ends = frames.filter((f) => f.type === "agent_ended");
	ok("8. llm() materializes the anchor (wfRoot spawn + ended pair)", spawns.length === 1 && spawns[0].kind === "wfRoot" && ends.length === 1, JSON.stringify(frames.map((f) => f.type)));
}

// ---- 10. zero-boundary script: lazy anchor never spawns -------------------------
{
	frames.length = 0;
	const t = await text(mkTool(), `${META}\nlog('just logging');\nphase('P');\nthrow new Error('boom');`);
	ok("10. script throw before any boundary → failure text", t.includes("Workflow failed") && t.includes("boom"), t);
	ok("10. lazy anchor: no frames, no agent ever existed", frames.length === 0, JSON.stringify(frames.map((f) => f.type)));
}

// ---- persona + args passthrough (bonus coverage, same machinery) ---------------
{
	frames.length = 0;
	calls.length = 0;
	script.length = 0;
	call = 0;
	script.push({ text: "persona-done" });
	const t = await text(
		mkTool(),
		`${META}\nconst r = await agent('review it', { label: 'rev', agentType: 'reviewer' });\nreturn { r, got: args.payload };`,
		{ payload: "PAYLOAD-VALUE" },
	);
	ok("9. agentType persona rendered", (calls[0]?.systemPrompt ?? "").includes("PERSONA-MARKER"), (calls[0]?.systemPrompt ?? "").slice(0, 100));
	ok("9. args global reached the script", t.includes("PAYLOAD-VALUE"), t);
	const subs = frames.filter((f) => f.type === "agent_spawned" && (f as { kind?: string }).kind === "dagSub") as Array<{ name?: string }>;
	ok("9. spawn frame carries persona name", subs[0]?.name === "reviewer", String(subs[0]?.name));
}

console.log(out.join("\n"));
console.log(`smoke-workflow: ${out.length - failed} passed, ${failed} failed`);
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
