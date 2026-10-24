/**
 * Cost accounting for the benchmark.
 *
 * Money is only comparable if BOTH agents' token counts go through the SAME
 * price table — which is why the provider-reported cost is ignored here.
 * Clownfish's transcripts carry a `cost` computed by pi-ai from its price table
 * for the *configured model id*, while these runs actually went through a GLM
 * proxy: that number is not real money. Claude Code's `total_cost_usd` has the
 * same problem in reverse. So: take the token counts from both, apply one table.
 *
 * Prices are per MILLION tokens, in the provider's own billing currency (CNY for
 * BigModel/GLM). Published GLM-5.2 / 5.3 rates as of 2026-08: input ¥8, cached
 * input ¥2, output ¥28; cache storage is free for now, so a cache WRITE is
 * charged at the normal input rate and nothing extra is charged for keeping it.
 *
 * Override with CLOWNFISH_BENCH_PRICES (JSON) when the rates move — a stale
 * table quietly turns the cost column into fiction.
 */

const DEFAULT_PRICES = {
	// BigModel / 智谱, per 1M tokens, CNY
	"glm-5.2": { input: 8, cacheRead: 2, cacheWrite: 8, output: 28, currency: "CNY" },
	"glm-5.3": { input: 8, cacheRead: 2, cacheWrite: 8, output: 28, currency: "CNY" },
	"glm-5.3-flash": { input: 1.05, cacheRead: 0.21, cacheWrite: 1.05, output: 3.5, currency: "CNY" },
	// Reference only — these runs did not use it.
	"claude-sonnet-4-6": { input: 21.3, cacheRead: 2.13, cacheWrite: 26.6, output: 106.5, currency: "CNY" },
};

/** Indicative rate, for readers who think in dollars. Not a billing figure. */
export const CNY_PER_USD = 7.1;

export function priceTable() {
	const raw = process.env.CLOWNFISH_BENCH_PRICES;
	if (!raw) return DEFAULT_PRICES;
	try {
		return { ...DEFAULT_PRICES, ...JSON.parse(raw) };
	} catch {
		console.error("CLOWNFISH_BENCH_PRICES is not valid JSON — using the built-in table");
		return DEFAULT_PRICES;
	}
}

/** Price entry for a model id, falling back to the first table entry. */
export function priceFor(model) {
	const table = priceTable();
	return table[model] ?? table[Object.keys(table)[0]];
}

/**
 * Cost of a normalized usage record, in the table's currency. Returns null when
 * the usage is empty, so an un-instrumented run shows as "unknown" rather than
 * as a suspiciously free one.
 */
export function costOf(usage, model) {
	if (!usage || !usage.totalTokens) return null;
	const p = priceFor(model);
	const cost =
		(usage.inputTokens / 1e6) * p.input +
		(usage.cacheReadTokens / 1e6) * p.cacheRead +
		(usage.cacheWriteTokens / 1e6) * p.cacheWrite +
		(usage.outputTokens / 1e6) * p.output;
	return { amount: Number(cost.toFixed(4)), currency: p.currency, model };
}

export function formatCost(cost) {
	if (!cost) return "–";
	const symbol = cost.currency === "CNY" ? "¥" : cost.currency === "USD" ? "$" : `${cost.currency} `;
	return `${symbol}${cost.amount.toFixed(3)}`;
}
