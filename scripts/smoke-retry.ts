/**
 * provider-retry smoke test — the withProviderRetry streamFn wrapper (models.ts)
 * WITHOUT a real provider. Scenarios:
 *
 *   A. request-phase 429 (error before any content) then success → retried
 *      transparently; the consumer sees ONLY the second attempt's events.
 *   B. non-retryable quota error (insufficient_quota) → forwarded, no retry.
 *   C. mid-stream error (content already delivered) → forwarded, no retry
 *      (rewinding a half-streamed message is impossible).
 *   D. every attempt 429s → attempts capped at maxRetries+1, final error forward.
 *   E. abort during backoff → normalized aborted result.
 *   F. watchdog stall message → retryable.
 *
 * Run: `npx tsx scripts/smoke-retry.ts`
 */
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { withProviderRetry, type ProviderRetryConfig } from "../agent/models";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const CFG: ProviderRetryConfig = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4 };

function msg(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "error" ? [] : [{ type: "text", text: "ok" }],
		api: "unknown" as never,
		provider: "unknown" as never,
		model: "stub",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

/** A minimal source stream: yields the given events, result() settles per the terminal one. */
function fakeSource(events: AssistantMessageEvent[], result: AssistantMessage): AssistantMessageEventStream {
	const iter = events[Symbol.iterator]();
	return {
		[Symbol.asyncIterator]() {
			return {
				next: async () => iter.next(),
			};
		},
		result: () => Promise.resolve(result),
	} as unknown as AssistantMessageEventStream;
}

const ok = (text: string) => msg("stop", undefined) && ({ ...msg("stop"), content: [{ type: "text", text }] } as AssistantMessage);

async function consume(fn: StreamFn, signal?: AbortSignal) {
	const stream = await (fn as unknown as (m: unknown, c: unknown, o?: { signal?: AbortSignal }) => Promise<AssistantMessageEventStream>)({}, {}, { signal });
	const seen: AssistantMessageEvent[] = [];
	for await (const ev of stream) seen.push(ev);
	return { seen, result: await stream.result() };
}

void (async () => {
	const checks: string[] = [];
	const pass = (n: string) => checks.push(`  ✓ ${n}`);
	let attempts: AssistantMessageEventStream[] = [];
	let n = 0;
	const inner: StreamFn = async () => attempts[n++];

	const run = async (name: string, sources: AssistantMessageEventStream[], expect: { events: number; stopReason: string; attempts: number; text?: string }) => {
		attempts = sources;
		n = 0;
		const wrapped = withProviderRetry(inner as StreamFn, CFG);
		const { seen, result } = await consume(wrapped);
		assert.equal(n, expect.attempts, `${name}: attempt count`);
		assert.equal(seen.length, expect.events, `${name}: consumer event count`);
		assert.equal(result.stopReason, expect.stopReason, `${name}: result stopReason`);
		if (expect.text) {
			const text = (result.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text")?.text;
			assert.equal(text, expect.text, `${name}: result text`);
		}
		pass(name);
	};

	// A. 429 request-phase failure → retry → success.
	const four29 = msg("error", "429 {\"error\":{\"code\":\"1302\"}} rate limit exceeded");
	const success = ok("all good");
	await run(
		"A. 429 then success",
		[
			fakeSource([{ type: "error", reason: "error", error: four29 }], four29),
			fakeSource([{ type: "start", partial: success }, { type: "text_delta" } as AssistantMessageEvent, { type: "done", message: success }], success),
		],
		{ events: 3, stopReason: "stop", attempts: 2, text: "all good" },
	);

	// B. quota exhaustion → non-retryable, forwarded as-is.
	const quota = msg("error", "403 insufficient_quota: billing hard limit reached");
	await run("B. insufficient_quota not retried", [fakeSource([{ type: "error", reason: "error", error: quota }], quota)], { events: 1, stopReason: "error", attempts: 1 });

	// C. mid-stream failure after content → forwarded, no retry (cannot rewind).
	const mid = msg("error", "429 too many requests mid-stream");
	await run(
		"C. mid-stream 429 forwarded",
		[fakeSource([{ type: "start", partial: mid }, { type: "text_delta" } as AssistantMessageEvent, { type: "error", reason: "error", error: mid }], mid)],
		{ events: 3, stopReason: "error", attempts: 1 },
	);

	// D. persistent 429 → capped at maxRetries+1 attempts, final error out.
	await run(
		"D. persistent 429 caps attempts",
		Array.from({ length: 10 }, () => fakeSource([{ type: "error", reason: "error", error: four29 }], four29)),
		{ events: 1, stopReason: "error", attempts: CFG.maxRetries + 1 },
	);

	// E. abort during backoff → aborted result, no further attempts.
	{
		attempts = [
			fakeSource([{ type: "error", reason: "error", error: four29 }], four29),
			fakeSource([{ type: "error", reason: "error", error: four29 }], four29),
		];
		n = 0;
		const controller = new AbortController();
		const wrapped = withProviderRetry(inner as StreamFn, { ...CFG, baseDelayMs: 60_000, maxDelayMs: 60_000 });
		const p = consume(wrapped, controller.signal);
		await new Promise((r) => setTimeout(r, 10)); // let attempt 1 fail and backoff begin
		controller.abort();
		const { result } = await p;
		assert.equal(result.stopReason, "aborted", "E: aborted result");
		assert.equal(n, 1, "E: no retry after abort");
		pass("E. abort during backoff → aborted");
	}

	// F. watchdog stall wording → NOT retried at the stream layer (a stall already
	// burned 5 silent minutes; recovery belongs to the interrupted-run re-driver).
	const stall = msg("error", "provider stream stalled: no events for 300s — aborting to unhang the run");
	await run("F. watchdog stall NOT retried", [fakeSource([{ type: "error", reason: "error", error: stall }], stall)], { events: 1, stopReason: "error", attempts: 1 });

	console.log(`smoke-retry: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
})().catch((err) => {
	console.error("smoke-retry FAILED:", err);
	process.exit(1);
});
