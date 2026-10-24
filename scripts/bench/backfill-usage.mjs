/**
 * Back-fill token accounting, cost and the efficiency verdict into rounds that
 * were run before the runner recorded them. Everything is derived from what is
 * already on disk — Clownfish's transcripts and Claude Code's stored usage
 * envelope — so no agent has to run again and no number is invented.
 *
 *   node scripts/bench/backfill-usage.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { clownfishUsage, claudeUsage, efficiencyChecks } from "./usage.mjs";
import { costOf } from "./pricing.mjs";
import { TASKS as PHASE1 } from "./tasks.mjs";
import { TASKS as PHASE2 } from "./tasks2.mjs";
import { TASKS as PHASE3 } from "./tasks3.mjs";

const TASKS = new Map([...PHASE1, ...PHASE2, ...PHASE3].map((t) => [t.id, t]));

const RUNS = join(resolve(new URL("../..", import.meta.url).pathname), ".bench", "runs");

for (const round of readdirSync(RUNS).filter((d) => /^round\d+$/.test(d))) {
	const roundDir = join(RUNS, round);
	const sessionsDir = join(roundDir, "clownfish-data", "sessions");
	const summaryPath = join(roundDir, "summary.json");
	if (!existsSync(summaryPath)) continue;
	const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
	let filled = 0;

	for (const result of summary.results) {
		const resultPath = join(roundDir, result.agent === "clownfish" ? "clownfish" : "claude", result.task, "result.json");
		const stored = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
		let usage;
		if (result.agent === "clownfish") {
			const sid = result.sessionId ?? stored?.sessionId;
			if (!sid) continue;
			usage = clownfishUsage(sessionsDir, sid);
		} else {
			// Three possible shapes on disk: the raw Anthropic envelope, a copy kept
			// under rawUsage, or an already-normalized record from an earlier pass.
			const raw = stored?.usage?.input_tokens !== undefined ? stored.usage : stored?.rawUsage;
			usage = raw ? claudeUsage(raw) : (stored?.normalizedUsage ?? stored?.usage);
			if (usage && usage.totalTokens === undefined) usage = undefined;
		}
		if (!usage || usage.totalTokens === 0) continue;
		const model = summary.model ?? "glm-5.2";
		const task = TASKS.get(result.task);
		result.usage = usage;
		result.cost = costOf(usage, model);
		if (task) {
			const eff = efficiencyChecks(task, { ms: result.ms, usage }, model);
			result.efficiency = { checks: eff, passed: eff.filter((c) => c.ok).length, total: eff.length, ratio: eff.length ? eff.filter((c) => c.ok).length / eff.length : 0 };
		}
		if (stored) {
			stored.usage = result.agent === "clownfish" ? usage : stored.usage;
			stored.normalizedUsage = usage;
			stored.cost = result.cost;
			if (result.efficiency) stored.efficiency = result.efficiency;
			writeFileSync(resultPath, JSON.stringify(stored, null, 2));
		}
		filled++;
	}
	writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
	console.log(`${round}: filled ${filled}/${summary.results.length} results`);
}
