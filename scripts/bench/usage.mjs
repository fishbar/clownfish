/**
 * Token accounting, normalized across the two agents.
 *
 * Both sides report usage, in different shapes and different places:
 *  - Claude Code prints one aggregate envelope (`--output-format json`) with
 *    Anthropic's field names.
 *  - Clownfish records per-assistant-message usage in the session transcript,
 *    including every sub-agent's own transcript — so the sum must walk them all,
 *    or a delegation's tokens vanish from the accounting.
 *
 * `cacheHitRate` is cached prompt tokens over ALL prompt tokens
 * (`cacheRead / (input + cacheRead + cacheWrite)`) — i.e. the share of the
 * context that did not have to be re-processed. Output tokens are excluded
 * because they are never cacheable.
 *
 * COST CAVEAT: Clownfish's per-message `cost` comes from pi-ai's price table for
 * the *configured* model id, while these runs actually went through a GLM proxy.
 * Those dollar figures are therefore not real money and not comparable to Claude
 * Code's `total_cost_usd`; only the TOKEN counts are trustworthy on both sides.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { costOf } from "./pricing.mjs";

const EMPTY = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };

function withRates(u) {
	const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
	return {
		...u,
		promptTokens: prompt,
		totalTokens: prompt + u.outputTokens,
		cacheHitRate: prompt > 0 ? u.cacheReadTokens / prompt : 0,
	};
}

/**
 * Sum a Clownfish session's usage, including the transcripts of every sub-agent
 * it delegated to (`<sid>.sub<n>-<type>.jsonl`).
 */
export function clownfishUsage(sessionsDir, sessionId) {
	if (!existsSync(sessionsDir)) return withRates({ ...EMPTY });
	const files = readdirSync(sessionsDir).filter((f) => f.startsWith(sessionId) && f.endsWith(".jsonl"));
	const acc = { ...EMPTY };
	for (const file of files) {
		let raw;
		try {
			raw = readFileSync(join(sessionsDir, file), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line) continue;
			let usage;
			try {
				usage = JSON.parse(line)?.message?.usage;
			} catch {
				continue;
			}
			if (!usage) continue;
			acc.requests++;
			acc.inputTokens += usage.input ?? 0;
			acc.outputTokens += usage.output ?? 0;
			acc.cacheReadTokens += usage.cacheRead ?? 0;
			acc.cacheWriteTokens += (usage.cacheWrite ?? 0) + (usage.cacheWrite1h ?? 0);
		}
	}
	return withRates(acc);
}

/** Normalize Claude Code's aggregate usage envelope into the same shape. */
export function claudeUsage(raw) {
	if (!raw || typeof raw !== "object") return withRates({ ...EMPTY });
	return withRates({
		inputTokens: raw.input_tokens ?? 0,
		outputTokens: raw.output_tokens ?? 0,
		cacheReadTokens: raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
		requests: 0, // Claude Code reports turns, not request count
	});
}

/**
 * The three efficiency dimensions, each scored against the task's declared par.
 * Kept SEPARATE from the correctness score: an agent that is fast and cheap but
 * wrong has not done the task, and merging the two numbers would hide that.
 */
export function efficiencyChecks(task, run, model) {
	const budget = task.budget;
	if (!budget) return [];
	const usage = run.usage;
	const cost = usage ? costOf(usage, model) : null;
	const checks = [
		{
			name: `用时 ≤ ${Math.round(budget.ms / 1000)}s`,
			ok: typeof run.ms === "number" && run.ms > 0 && run.ms <= budget.ms,
			actual: typeof run.ms === "number" ? `${(run.ms / 1000).toFixed(0)}s` : "–",
		},
		{
			name: `token ≤ ${formatTokens(budget.tokens)}`,
			ok: Boolean(usage?.totalTokens) && usage.totalTokens <= budget.tokens,
			actual: usage?.totalTokens ? formatTokens(usage.totalTokens) : "–",
		},
		{
			name: `费用 ≤ ¥${budget.cost.toFixed(2)}`,
			ok: Boolean(cost) && cost.amount <= budget.cost,
			actual: cost ? `¥${cost.amount.toFixed(3)}` : "–",
		},
	];
	return checks;
}

export function formatTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
