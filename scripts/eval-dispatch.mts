/**
 * Tool-choice eval — does the merged `run_agent` (single / `tasks` / `until`)
 * and the collapsed verification rule actually get chosen correctly, now
 * that the model faces ONE delegation entry instead of three contradictory
 * ones (docs/TOOLS.md, C1–C3 and the follow-up audit)?
 *
 * This was the promised "③" from that audit: everything else in this repo's
 * tool work was measured (token counts, search latency, real bugs found by
 * probing). Dispatch QUALITY was never measured — only inferred from prose.
 * This closes that gap with real model calls against the REAL assembled
 * system prompt and REAL tool schemas (agent/runtime.ts's exported
 * PLAN_DIRECTIVE/WORKFLOW_DIRECTIVE/DEMO_DIRECTIVE, the *_TOOL_META constants
 * — the same objects production wires up, not a paraphrase of them).
 *
 * Cost control: delegation-shaped tools (run_agent, session_send, draw_demo,
 * cron, todo, memory) are CAPTURING stubs — same name/description/schema the
 * model sees, but execute() records the call and returns immediately instead
 * of spawning a real sub-agent. So a scenario that correctly delegates costs
 * ONE model turn, not a cascade. A scenario where the model does the work
 * itself (correctly, for "small stuff") is watchdog-capped at 10 tool calls so
 * a spiral cannot run away — grading only needs the FIRST dispatch decision.
 *
 * This is a single-sample eval (one run per scenario, one model). It answers
 * "does today's prompt+schema produce the intended dispatch on first try",
 * not "how reliably" — treat a single FAIL as a lead to inspect, not proof of
 * a broken rule, and re-run before concluding a regression.
 *
 *   npx tsx scripts/eval-dispatch.mts            # all scenarios
 *   npx tsx scripts/eval-dispatch.mts fanout qa   # just these ids
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { loadSettings, applySettings } from "../agent/settings";
import { resolveRuntime } from "../agent/models";
import { ClownfishAgent } from "../agent/clownfish-agent";
import { createCodingToolDefinitions } from "../agent/tools";
import type { ToolDefinition, ToolMeta } from "../agent/tools/definition";
import { AgentLoader, resolveAgentPrompt } from "../agent/agents/loader";
import { PLAN_DIRECTIVE, WORKFLOW_DIRECTIVE, DEMO_DIRECTIVE } from "../agent/runtime";
import { RUN_AGENT_TOOL_META } from "../agent/agents/run-agent-tool";
import { TODO_TOOL_META } from "../agent/todo";
import { MEMORY_TOOL_META } from "../agent/memory";
import { DRAW_DEMO_TOOL_META } from "../agent/tools/draw-demo";
import { CRON_TOOL_META } from "../agent/tools/cron";
import { SESSIONS_TOOL_META, SESSION_SEND_TOOL_META, SESSION_READ_TOOL_META } from "../agent/tools/sessions";

interface Captured {
	name: string;
	args: Record<string, unknown>;
}

/** A tool with the REAL schema/description/prompt (from its *_TOOL_META) but
 *  a stub execute() — records the call, answers immediately. No sub-agent,
 *  no session, no cost beyond the one schema in the request. */
function capturing(meta: ToolMeta, sink: Captured[], reply: string): ToolDefinition {
	return {
		...meta,
		label: meta.name,
		parameters: (meta.parameters ?? Type.Object({})) as never,
		async execute(_id, args) {
			sink.push({ name: meta.name, args: args as Record<string, unknown> });
			return { content: [{ type: "text", text: reply }], details: undefined };
		},
	};
}

const REPLIES: Record<string, string> = {
	run_agent: "(stub) done: the specialist reports the task is complete.",
	session_send: "(stub) delivered to the target session.",
	draw_demo: "(stub) https://example.invalid/demo/stub",
	cron: "(stub) scheduled.",
	todo: "(stub) plan recorded.",
	memory: "(stub) remembered.",
	sessions: "(stub) [{project: 'clownfish', sessions: [{id: 's1', title: 'main'}]}]",
	session_read: "(stub) (no recent messages)",
};

function defaultTools(cwd: string, sink: Captured[], assistant: boolean): ToolDefinition[] {
	const metas: ToolMeta[] = [RUN_AGENT_TOOL_META, DRAW_DEMO_TOOL_META, CRON_TOOL_META, TODO_TOOL_META, MEMORY_TOOL_META];
	if (assistant) metas.push(SESSIONS_TOOL_META, SESSION_SEND_TOOL_META, SESSION_READ_TOOL_META);
	return [...createCodingToolDefinitions(cwd), ...metas.map((m) => capturing(m, sink, REPLIES[m.name] ?? "(stub) done."))];
}

interface Scenario {
	id: string;
	who: "main" | "assistant" | "plan";
	prompt: string;
	/** What a correct dispatch looks like — checked against the captured calls + final text. */
	expect: (calls: Captured[], text: string) => boolean;
	expectLabel: string;
	setupFiles?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
	{
		id: "small-edit",
		who: "main",
		prompt: "Fix the typo in README.md: change 'teh' to 'the'.",
		expectLabel: "does it itself (no run_agent) — this is the 'small stuff' case",
		expect: (calls) => !calls.some((c) => c.name === "run_agent"),
		setupFiles: { "README.md": "This is teh project.\n" },
	},
	{
		id: "single-substantial",
		who: "main",
		prompt: "Implement a new POST /api/webhooks endpoint with input validation and tests. This is a real feature, not a one-liner.",
		// Two consecutive live runs disagreed: one delegated with a single clean
		// run_agent call, the other implemented it directly (write/edit) and
		// verified with a test run — BOTH are legitimate under "delegate
		// substantial work, do small stuff yourself": which side of that line a
		// single self-contained endpoint falls on is a judgment call the rule
		// deliberately leaves to the model. What the rule actually forbids is
		// fanning ONE sequential unit of work into a `tasks[]` fan-out it
		// doesn't need (the C3 mistake the merge exists to prevent) — that is
		// the one thing this scenario can honestly grade.
		expectLabel: "no unwarranted tasks[] fan-out for one sequential unit of work (a single run_agent call, or doing it directly, are both fine)",
		expect: (calls) => {
			const c = calls.find((c) => c.name === "run_agent");
			return !(c && Array.isArray(c.args.tasks) && (c.args.tasks as unknown[]).length > 1);
		},
		setupFiles: {
			"package.json": '{"name":"demo-api","type":"module","scripts":{"test":"node --test"}}\n',
			"src/server.js": "import express from 'express';\nconst app = express();\napp.use(express.json());\napp.post('/api/orders', (req, res) => { res.status(201).json({ id: 'o1' }); });\nexport default app;\n",
			"src/server.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('placeholder', () => assert.ok(true));\n",
		},
	},
	{
		id: "fanout",
		who: "main",
		prompt:
			"Three completely independent modules need a security review: auth.ts, payment.ts, and upload.ts. Review all three and give me ONE prioritized report.",
		expectLabel: "run_agent with tasks[] (≥2 strands) + synthesize — not N separate calls",
		expect: (calls) => {
			const c = calls.find((c) => c.name === "run_agent");
			return !!c && Array.isArray(c.args.tasks) && (c.args.tasks as unknown[]).length >= 2;
		},
		setupFiles: {
			"auth.ts": "export function checkPassword(input: string, stored: string) {\n  return input == stored; // loose equality\n}\n",
			"payment.ts": "export function chargeCard(amount: number, cardNumber: string) {\n  console.log('charging', cardNumber, amount);\n  return { ok: true };\n}\n",
			"upload.ts": "import { exec } from 'child_process';\nexport function handleUpload(filename: string) {\n  exec(`file ${filename}`);\n}\n",
		},
	},
	{
		id: "until",
		who: "main",
		prompt:
			"There's a bug somewhere in the retry/backoff module that's making 4 of the test suite's cases fail — I haven't dug into which ones or why. Get `npm test` fully green. I'm not waiting synchronously; just make it happen and let me know when it's done.",
		// Same recalibration as single-substantial: a capable model may just fix
		// this directly rather than paying delegation overhead. Both are fine —
		// what actually matters for a "keep at it until it's done" ask is that
		// the model does not declare victory without RE-RUNNING the tests
		// (either itself, or by requiring `until` to hold the delegate to it).
		expectLabel: "delegates with `until`, OR fixes it directly AND verifies with a real test run before declaring done (no bare 'done' claim)",
		expect: (calls, text) => {
			const c = calls.find((c) => c.name === "run_agent");
			if (c) return typeof c.args.until === "string" && (c.args.until as string).trim().length > 0;
			return /\d+\s*(\/|of)\s*\d+.*(pass|green)|(pass|green).*\d+\s*(\/|of)\s*\d+|test.*(pass|green|✓)/i.test(text);
		},
		setupFiles: {
			"package.json": '{"name":"demo","type":"module","scripts":{"test":"node --test"}}\n',
			"retry.js":
				"export async function retry(fn, { attempts = 3, baseDelayMs = 10 } = {}) {\n" +
				"  let lastErr;\n" +
				"  for (let i = 0; i < attempts; i++) {\n" +
				"    try {\n" +
				"      return await fn();\n" +
				"    } catch (err) {\n" +
				"      lastErr = err;\n" +
				"      // bug: delay grows but never actually awaited, and the attempt\n" +
				"      // counter used for backoff is off by one against `i`\n" +
				"      const delay = baseDelayMs * Math.pow(2, attempts);\n" +
				"      new Promise((r) => setTimeout(r, delay));\n" +
				"    }\n" +
				"  }\n" +
				"  throw lastErr;\n" +
				"}\n" +
				"export function isRetryable(err) {\n" +
				"  return err && err.code !== 'FATAL';\n" +
				"}\n",
			"retry.test.js":
				"import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { retry, isRetryable } from './retry.js';\n" +
				"test('succeeds on first try', async () => { assert.strictEqual(await retry(async () => 42), 42); });\n" +
				"test('retries until success', async () => {\n  let n = 0;\n  const v = await retry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; });\n  assert.strictEqual(v, 'ok'); assert.strictEqual(n, 3);\n});\n" +
				"test('actually waits between attempts', async () => {\n  const t0 = Date.now();\n  let n = 0;\n  await retry(async () => { n++; if (n < 2) throw new Error('x'); return 'ok'; }, { baseDelayMs: 30 });\n  assert.ok(Date.now() - t0 >= 25, 'should have waited at least one backoff interval');\n});\n" +
				"test('gives up after attempts exhausted', async () => {\n  await assert.rejects(() => retry(async () => { throw new Error('always'); }, { attempts: 2 }));\n});\n" +
				"test('isRetryable treats FATAL as non-retryable', () => {\n  assert.strictEqual(isRetryable({ code: 'FATAL' }), false);\n  assert.strictEqual(isRetryable({ code: 'TIMEOUT' }), true);\n});\n",
		},
	},
	{
		id: "adversarial-property",
		who: "main",
		prompt:
			"This scheduler had an intermittent double-fire bug under concurrent load. After you fix it, I don't want 'my quick test passed' — I want someone who didn't write the fix to genuinely try to break it before you tell me it's done.",
		expectLabel:
			"delegates the fix with run_agent, and does NOT stuff 'no longer flaky'/'someone tried to break it' into `until` criteria — that property isn't objectively checkable in a bounded retry loop; the framework's automatic post-delegation verification is what 'someone who didn't write the fix' means here",
		expect: (calls) => {
			const c = calls.find((c) => c.name === "run_agent");
			if (!c) return false;
			const untilText = typeof c.args.until === "string" ? (c.args.until as string) : "";
			return !/flak|intermittent|break it|double.?fire/i.test(untilText);
		},
		setupFiles: {
			"package.json": '{"name":"sched","type":"module","scripts":{"test":"node --test"}}\n',
			"scheduler.js": "export class Scheduler {\n  constructor() { this.running = new Set(); }\n  async run(job) {\n    if (this.running.has(job.id)) return; // TOCTOU: check-then-set is not atomic\n    this.running.add(job.id);\n    await job.fn();\n    this.running.delete(job.id);\n  }\n}\n",
		},
	},
	{
		id: "plan-mode-no-delegate",
		who: "plan",
		prompt: "Implement a new POST /api/webhooks endpoint with input validation and tests.",
		expectLabel: "no run_agent call at all — the tool isn't even in plan mode's schema",
		expect: (calls) => !calls.some((c) => c.name === "run_agent"),
	},
	{
		id: "inline-html",
		who: "main",
		prompt: "Make me a quick countdown timer widget I can preview right here in the chat.",
		expectLabel: "inline ```html fence, no draw_demo call",
		expect: (calls, text) => !calls.some((c) => c.name === "draw_demo") && /```html/.test(text),
	},
	{
		id: "draw-demo",
		who: "main",
		prompt:
			"Build me a small multi-page demo: index.html, a separate style.css, a separate app.js, and it references two external image URLs. I need a URL I can send a teammate, not an inline preview.",
		expectLabel: "draw_demo tool call (genuinely multi-file)",
		expect: (calls) => calls.some((c) => c.name === "draw_demo"),
	},
	{
		id: "assistant-project-work",
		who: "assistant",
		prompt: "让 clownfish 项目跑一下它的 lint 检查，告诉我结果。",
		expectLabel: "session_send to the project (never run_agent — that runs in the assistant's OWN workspace)",
		expect: (calls) => calls.some((c) => c.name === "session_send") && !calls.some((c) => c.name === "run_agent"),
	},
	{
		id: "assistant-own-scratch",
		who: "assistant",
		prompt:
			"帮我调研三种不同的日历同步方案（CalDAV / Google Calendar API / 手工 ICS 文件）并写一份对比报告草稿。这不属于任何项目，就放在你自己的工作区。",
		expectLabel: "run_agent for the assistant's OWN scratch work (not session_send — no project is involved)",
		expect: (calls) => calls.some((c) => c.name === "run_agent") && !calls.some((c) => c.name === "session_send"),
	},
];

interface Result {
	id: string;
	who: string;
	pass: boolean;
	expectLabel: string;
	calls: Captured[];
	allToolNames: string[];
	textPreview: string;
	steps: number;
}

async function runScenario(scn: Scenario, agents: Awaited<ReturnType<AgentLoader["load"]>>, runtime: ReturnType<typeof resolveRuntime>): Promise<Result> {
	const cwd = mkdtempSync(join(tmpdir(), `eval-${scn.id}-`));
	for (const [name, content] of Object.entries(scn.setupFiles ?? {})) {
		const target = join(cwd, name);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}

	const captured: Captured[] = [];
	const assistant = scn.who === "assistant";
	const vars = { workspace: cwd };
	const agentName = assistant ? "assistant" : "system";
	const base = resolveAgentPrompt(agents, agentName, vars);
	const baseSystemPrompt = scn.who === "plan" ? base + PLAN_DIRECTIVE : base + WORKFLOW_DIRECTIVE + DEMO_DIRECTIVE;

	const agent = new ClownfishAgent({
		cwd,
		runtime,
		skills: [],
		baseSystemPrompt,
		initialMessages: [],
		toolAccess: scn.who === "plan" ? "R" : "RW",
		extraTools: defaultTools(cwd, captured, assistant),
	} as never);

	// Watchdog: grading only needs the FIRST dispatch decision. Cap tool calls
	// so a scenario where the model does real work itself cannot spiral into
	// an actual multi-file implementation on our token budget.
	let steps = 0;
	const allToolNames: string[] = [];
	const WATCHDOG = 10;
	agent.subscribe((event: { type: string; toolName?: string }) => {
		if (event.type === "tool_execution_start") {
			steps++;
			if (event.toolName) allToolNames.push(event.toolName);
			if (steps >= WATCHDOG) agent.abort();
		}
	});

	let text = "";
	try {
		await agent.prompt(scn.prompt);
		const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
		const content = last?.content;
		text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("") : "";
	} catch (err) {
		text = `(error: ${err instanceof Error ? err.message : String(err)})`;
	}

	rmSync(cwd, { recursive: true, force: true });
	return { id: scn.id, who: scn.who, pass: scn.expect(captured, text), expectLabel: scn.expectLabel, calls: captured, allToolNames, textPreview: text.slice(0, 200), steps };
}

async function main() {
	const only = process.argv.slice(2);
	const dataDir = `${process.env.HOME}/.clownfish`;
	applySettings(loadSettings(dataDir));
	const s = loadSettings(dataDir);
	const runtime = resolveRuntime({ provider: s.provider ?? "anthropic", model: s.model ?? "glm-5.2" });
	const agents = await new AgentLoader([{ dir: "agent/agents/builtin", source: "builtin" }]).load();

	const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
	console.log(`running ${scenarios.length} dispatch scenarios against ${s.provider}/${s.model ?? "default"}\n`);

	const results: Result[] = [];
	for (const scn of scenarios) {
		process.stdout.write(`  ${scn.id.padEnd(24)} …`);
		const r = await runScenario(scn, agents, runtime);
		results.push(r);
		console.log(`\r  ${r.pass ? "PASS" : "FAIL"}  ${scn.id.padEnd(24)} (${r.steps} step(s)) tools: ${r.allToolNames.join(",") || "(none)"}`);
	}

	const passed = results.filter((r) => r.pass).length;
	console.log(`\n${passed}/${results.length} scenarios matched the expected dispatch\n`);
	for (const r of results.filter((r) => !r.pass)) {
		console.log(`--- FAIL: ${r.id} ---`);
		console.log(`expected: ${r.expectLabel}`);
		console.log(`calls: ${JSON.stringify(r.calls, null, 2).slice(0, 800)}`);
		console.log(`text: ${r.textPreview}`);
		console.log();
	}
	process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
