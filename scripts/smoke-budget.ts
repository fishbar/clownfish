/**
 * Budget guard smoke test — verifies ClownfishAgent's run-budget hook without a
 * real provider: pi's loop has NO built-in exit condition beyond "no more tool
 * calls", so a runaway agent burns tokens forever. The guard hooks
 * shouldStopAfterTurn (called once per LLM turn), counts turns + output tokens
 * per run (reset at agent_start), and force-stops the loop when a cap is hit —
 * appending a [budget stop] notice into the transcript so the model / any
 * coordinating parent sees why the run ended early.
 *
 * Provider seam: streamFn is stubbed with a real AssistantMessageEventStream,
 * emitting one assistant message WITH a `noop` tool call per turn (that's what
 * keeps pi's inner loop alive past turn 1 — without tool calls the loop exits
 * naturally and proves nothing). Each scripted message carries usage.output so
 * the token-cap path is exercised with real accounting.
 *
 * Run: `npx tsx scripts/smoke-budget.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { ClownfishAgent, DEFAULT_MAX_TURNS_PER_RUN } from "../agent/clownfish-agent";
import { defineTool } from "../agent/tools/definition";
import type { ResolvedRuntime } from "../agent/models";

/**
 * Stub streamFn: for each call, emits one assistant message containing a
 * `noop` tool call (turns 1..maxTurns) or plain text (the final one), with
 * `outputPerTurn` usage. The loop keeps calling it as long as tool calls come
 * back — exactly the runaway shape the budget guard exists to stop.
 */
const makeStream = (maxTurns: number, outputPerTurn: number) => {
	let turn = 0;
	return (): AssistantMessageEventStream => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			turn += 1;
			const usage: Usage = { input: 100, output: outputPerTurn, cacheRead: 0, cacheWrite: 0 };
			const isLast = turn > maxTurns;
			const message: AssistantMessage = {
				role: "assistant",
				content: isLast
					? [{ type: "text", text: "done" }]
					: [
							{ type: "text", text: `turn ${turn}` },
							{ type: "toolCall", id: `call-${turn}`, name: "noop", arguments: {} },
						],
				api: "pi-messages",
				provider: "stub",
				model: "stub-model",
				usage,
				stopReason: isLast ? "stop" : "toolUse",
				timestamp: Date.now(),
			};
			const partial: AssistantMessage = { ...message, content: [...message.content] };
			stream.push({ type: "start", partial });
			for (const [i, c] of partial.content.entries()) {
				if (c.type === "text") {
					stream.push({ type: "text_delta", contentIndex: i, delta: c.text, partial });
					stream.push({ type: "text_end", contentIndex: i, content: c.text, partial });
				} else if (c.type === "toolCall") {
					stream.push({ type: "toolcall_end", contentIndex: i, toolCall: c, partial });
				}
			}
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end(message);
		})();
		return stream;
	};
};

const noopTool = defineTool<{ "": string }, undefined>({
	name: "noop",
	label: "noop",
	description: "Does nothing (test stub).",
	parameters: { type: "object", properties: {} } as never,
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
});

/** How many assistant messages the run actually produced. */
const assistantCount = (a: ClownfishAgent): number => a.state.messages.filter((m) => m.role === "assistant").length;

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);
	const work = await mkdtemp(join(tmpdir(), "smoke-budget-"));
	const mkRuntime = (turns: number, output = 50): ResolvedRuntime =>
		({ streamFn: makeStream(turns, output) }) as unknown as ResolvedRuntime;

	// 1. Cap above the natural run length: no interference — all scripted turns run.
	const a1 = new ClownfishAgent({
		cwd: work,
		runtime: mkRuntime(3),
		sessionId: "b1",
		extraTools: [noopTool],
		budget: { maxTurns: 100 },
	});
	await a1.prompt("go");
	assert.equal(assistantCount(a1), 4, `expected 3 tool turns + 1 final, got ${assistantCount(a1)}`);
	ok("natural run: no budget interference (scripted turns all ran)");

	// 2. Turn cap (maxTurns=2, stream would happily do 5): stopped at exactly 2
	// assistant turns + the [budget stop] notice appended.
	const a2 = new ClownfishAgent({
		cwd: work,
		runtime: mkRuntime(5),
		sessionId: "b2",
		extraTools: [noopTool],
		budget: { maxTurns: 2 },
	});
	await a2.prompt("go");
	assert.equal(assistantCount(a2), 2, `expected cap at 2 turns, got ${assistantCount(a2)}`);
	assert.match(JSON.stringify(a2.state.messages.at(-1)?.content), /\[budget stop\] turn budget reached/);
	ok("turn cap: loop force-stopped after 2 turns with a [budget stop] notice");

	// 3. Token cap (maxOutputTokens=120, 50/turn): stops after 3 turns (150 ≥ 120).
	const a3 = new ClownfishAgent({
		cwd: work,
		runtime: mkRuntime(9),
		sessionId: "b3",
		extraTools: [noopTool],
		budget: { maxOutputTokens: 120 },
	});
	await a3.prompt("go");
	assert.equal(assistantCount(a3), 3, `expected token cap at 3 turns, got ${assistantCount(a3)}`);
	assert.match(JSON.stringify(a3.state.messages.at(-1)?.content), /\[budget stop\] output token budget reached/);
	ok("token cap: cumulative output tokens force-stop the run");

	// 4. Counter resets per run: a second prompt() on the same capped agent gets
	// a fresh turn budget (not a cumulative one).
	const before = assistantCount(a2);
	await a2.prompt("go again");
	assert.equal(assistantCount(a2) - before, 2, `second run should reset the counter (got ${assistantCount(a2) - before} new turns)`);
	ok("budget resets at each agent_start (per-run, not per-agent lifetime)");

	// 5. Default: constructing without `budget` gets the standard turn cap.
	const a5 = new ClownfishAgent({ cwd: work, runtime: mkRuntime(3), sessionId: "b5", extraTools: [noopTool] });
	await a5.prompt("go");
	assert.equal(assistantCount(a5), 4);
	assert.ok(DEFAULT_MAX_TURNS_PER_RUN >= 20, "sane default turn cap");
	ok(`default budget applied (${DEFAULT_MAX_TURNS_PER_RUN} turns) without specifying one`);

	console.log(`smoke-budget: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-budget FAILED:", err);
	process.exit(1);
});
