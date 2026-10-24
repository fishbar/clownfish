/**
 * Turn the raw round artifacts into one reviewable markdown report.
 *
 *   node scripts/bench/report.mjs > docs/bench/REPORT.md
 *
 * Reads every `.bench/runs/round<n>/summary.json` and prints: the scoreboard per round,
 * the per-task detail (which checks failed, for whom), and the deltas between
 * rounds — which is the only number that says whether an "improvement" improved
 * anything.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { formatTokens } from "./usage.mjs";
import { formatCost } from "./pricing.mjs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const RUNS = join(ROOT, ".bench", "runs");

function loadRounds() {
	if (!existsSync(RUNS)) return [];
	return readdirSync(RUNS)
		// Round 0 is the dry baseline (no agent ran) — it belongs in the task
		// self-check, not in the scoreboard.
		.filter((d) => /^round\d+$/.test(d) && d !== "round0")
		.map((d) => join(RUNS, d, "summary.json"))
		.filter(existsSync)
		.map((f) => JSON.parse(readFileSync(f, "utf8")))
		.sort((a, b) => a.round - b.round);
}

const rounds = loadRounds();
if (rounds.length === 0) {
	console.error("no rounds found - run `make bench` first");
	process.exit(1);
}

const agents = [...new Set(rounds.flatMap((r) => r.results.map((x) => x.agent)))];
const tasks = [...new Set(rounds.flatMap((r) => r.results.map((x) => x.task)))];
const cell = (r) => (r ? `${r.score.passed}/${r.score.total}` : "–");
const pct = (list) => {
	const p = list.reduce((s, r) => s + r.score.passed, 0);
	const t = list.reduce((s, r) => s + r.score.total, 0);
	return t ? `${p}/${t} (${Math.round((p / t) * 100)}%)` : "–";
};

const out = [];
out.push("# Clownfish vs Claude Code — 基准对战报告");
out.push("");
out.push(`生成时间：${new Date().toISOString()}`);
out.push("");
out.push("## 方法");
out.push("");
out.push("- **两边跑同一个模型后端**（GLM Anthropic 兼容代理），所以比较的是 *harness*（提示词、工具、委派机制），不是模型能力。");
out.push("- Claude Code 侧：`claude -p --model sonnet --dangerously-skip-permissions`，并用 `--append-system-prompt` 显式鼓励用 Task 子代理（因为 Clownfish 的 orchestrator 提示词本身就在推委派，不补这一句对手方吃亏）。配置目录隔离，避免本机插件/MCP 影响结果。");
out.push("- 每个任务、每一轮都从**全新种子工作区**开始，轮次之间互不继承。");
out.push("- 评分用**智能体从未见过的隐藏测试**：改可见测试来蒙混过关会直接得零分。");
out.push("");
out.push("## 总分");
out.push("");
out.push(`| 轮次 | ${agents.map((a) => `${a}·正确性`).join(" | ")} | ${agents.map((a) => `${a}·效率`).join(" | ")} |`);
out.push(`|---|${agents.map(() => "---").join("|")}|${agents.map(() => "---").join("|")}|`);
const effPct = (list) => {
	const p = list.reduce((s, r) => s + (r.efficiency?.passed ?? 0), 0);
	const t = list.reduce((s, r) => s + (r.efficiency?.total ?? 0), 0);
	return t ? `${p}/${t} (${Math.round((p / t) * 100)}%)` : "–";
};
for (const r of rounds) {
	const correctness = agents.map((a) => pct(r.results.filter((x) => x.agent === a)));
	const efficiency = agents.map((a) => effPct(r.results.filter((x) => x.agent === a)));
	out.push(`| round ${r.round} | ${correctness.join(" | ")} | ${efficiency.join(" | ")} |`);
}
out.push("");
out.push("正确性 = 智能体没见过的隐藏测试；效率 = 用时 / token / 费用三项各自与该题声明的预算（par）比较，**两者分开计分**——又快又便宜但做错了，不算做完。");
out.push("");
out.push(
	"> **效率通过率要打折看。** 每题的预算按「目前观测到的最佳运行 × 2」标定，而每一题的最佳都恰好是 Clownfish，所以它 100% 通过里有一部分是构造出来的。不受这个偏置影响的是**原始比值**——用时、token、费用的倍数——请以下面每轮的用量表为准。",
);
out.push("");

for (const r of rounds) {
	out.push(`## Round ${r.round}`);
	out.push("");
	// A round where the two agents sit on different model tiers is NOT a harness
	// comparison any more, and saying so is the difference between a measurement
	// and a misleading chart.
	// The per-result fields are recorded by the runner at run time; the summary
	// header can be restamped by a later rescore, so the results win.
	const claudeRun = r.results.find((x) => x.agent === "claude-code" && x.tier);
	const tier = claudeRun?.tier ?? r.claudeTier ?? "sonnet";
	const claudeModel = claudeRun?.model ?? r.claudeModel ?? r.model;
	out.push(`模型：clownfish \`${r.model}\` · claude-code \`${tier}\` 档 → \`${claudeModel}\``);
	if (claudeModel !== r.model) {
		out.push("");
		out.push("> ⚠️ 这一轮**不是同模型对比**：Claude Code 跑在更高档位上，所以差异里混入了模型能力，不能只当作 harness 的差异读。");
	}
	out.push("");
	out.push(`| 任务 | ${agents.join(" | ")} | 备注 |`);
	out.push(`|---|${agents.map(() => "---").join("|")}|---|`);
	for (const t of tasks) {
		const cells = agents.map((a) => {
			const res = r.results.find((x) => x.task === t && x.agent === a);
			return res ? `${cell(res)} · ${(res.ms / 1000).toFixed(0)}s${res.outcome !== "done" ? ` · ${res.outcome}` : ""}` : "–";
		});
		const note = r.results.find((x) => x.task === t)?.title ?? "";
		out.push(`| \`${t}\` | ${cells.join(" | ")} | ${note} |`);
	}
	out.push("");
	// Only failures are worth the space; a passing check says nothing new.
	const failures = r.results.flatMap((res) =>
		res.checks.filter((c) => !c.ok).map((c) => ({ agent: res.agent, task: res.task, name: c.name, detail: c.detail })),
	);
	if (failures.length) {
		out.push("<details><summary>失败的检查项</summary>");
		out.push("");
		for (const f of failures) {
			out.push(`- **${f.agent} · \`${f.task}\`** — ${f.name}`);
			if (f.detail) {
				const trimmed = String(f.detail).trim().split("\n").slice(-6).join("\n");
				out.push("");
				out.push("  ```");
				out.push(trimmed.split("\n").map((l) => `  ${l}`).join("\n"));
				out.push("  ```");
			}
		}
		out.push("");
		out.push("</details>");
		out.push("");
	}
	// Wall time is the differentiator once both agents saturate a suite.
	const secs = (a) => Math.round(r.results.filter((x) => x.agent === a).reduce((s, x) => s + x.ms, 0) / 1000);
	if (agents.length > 1) {
		const t = agents.map((a) => `${a} ${secs(a)}s`).join(" · ");
		const [fast, slow] = agents.map(secs).sort((x, y) => x - y);
		out.push(`用时合计：${t}${slow && fast ? `（${(slow / fast).toFixed(1)}×）` : ""}`);
		out.push("");
	}

	// Per-task efficiency: the three dimensions with their actuals, so a miss can
	// be read as "slow" or "expensive" rather than just "failed".
	if (r.results.some((x) => x.efficiency)) {
		out.push(`| 效率（用时 / token / 费用） | ${agents.join(" | ")} |`);
		out.push(`|---|${agents.map(() => "---").join("|")}|`);
		for (const t of tasks) {
			const cells = agents.map((a) => {
				const res = r.results.find((x) => x.task === t && x.agent === a);
				if (!res?.efficiency) return "–";
				return res.efficiency.checks.map((c) => `${c.ok ? "✅" : "❌"}${c.actual}`).join(" · ");
			});
			if (cells.every((c) => c === "–")) continue;
			out.push(`| \`${t}\` | ${cells.join(" | ")} |`);
		}
		out.push("");
	}

	// Token accounting. The interesting number is not the raw total but how much
	// context each harness had to push through the model to reach the same result.
	if (r.results.some((x) => x.usage)) {
		out.push(`| 用量（${r.round} 轮合计） | ${agents.join(" | ")} |`);
		out.push(`|---|${agents.map(() => "---").join("|")}|`);
		const agg = (a, k) => r.results.filter((x) => x.agent === a && x.usage).reduce((s, x) => s + (x.usage[k] ?? 0), 0);
		const row = (label, fn) => out.push(`| ${label} | ${agents.map(fn).join(" | ")} |`);
		row("总 token", (a) => formatTokens(agg(a, "totalTokens")));
		row("提示 token", (a) => formatTokens(agg(a, "promptTokens")));
		row("其中命中缓存", (a) => formatTokens(agg(a, "cacheReadTokens")));
		row("缓存命中率", (a) => {
			const prompt = agg(a, "promptTokens");
			return prompt ? `${((agg(a, "cacheReadTokens") / prompt) * 100).toFixed(1)}%` : "–";
		});
		row("输出 token", (a) => formatTokens(agg(a, "outputTokens")));
		row("费用（GLM 价目表）", (a) => {
			const total = r.results.filter((x) => x.agent === a && x.cost).reduce((s, x) => s + x.cost.amount, 0);
			return total ? formatCost({ amount: total, currency: r.results.find((x) => x.agent === a && x.cost)?.cost.currency ?? "CNY" }) : "–";
		});
		const missing = r.results.filter((x) => !x.usage);
		if (missing.length > 0) {
			out.push("");
			out.push(
				`> ⚠️ 有 ${missing.length} 次运行没有用量数据（${missing.map((x) => `${x.agent}·${x.task}`).join("、")}）——进程在预算内没退出，就没打印用量信封。**该侧的 token 与费用合计因此偏低。**`,
			);
		}
		out.push("");
		out.push("> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。");
		out.push("");
	}

	// Behavioural signals only Clownfish reports (it is instrumented end to end).
	const cf = r.results.filter((x) => x.agent === "clownfish");
	if (cf.length) {
		const sum = (k) => cf.reduce((s, x) => s + (x[k] ?? 0), 0);
		out.push(`Clownfish 行为：工具调用 ${sum("toolCalls")} 次，子代理委派 ${sum("subAgents")} 次，写计划 ${sum("todos")} 次。`);
		if (cf.some((x) => x.planItems !== undefined)) {
			// Plan hygiene: steps that never leave `pending`, or a ledger orphaned by a
			// restatement, mislead the user — this is what the round-4 change targets.
			out.push(
				`计划卫生度：共 ${sum("planItems")} 步，其中委派 ${sum("planDelegated")} 步、收尾 ${sum("planSettled")} 步、遗留 pending ${sum("planPending")} 步。`,
			);
		}
		out.push("");
	}
}

// Same tasks, same harness on one side, different model tier on the other: the
// only honest way to read the opus round is against the sonnet runs of the very
// same tasks.
const tierRounds = { sonnet: [], opus: [] };
for (const r of rounds) {
	const t = r.results.find((x) => x.agent === "claude-code" && x.tier)?.tier ?? r.claudeTier ?? "sonnet";
	tierRounds[t === "opus" ? "opus" : "sonnet"].push(r);
}
if (tierRounds.opus.length > 0 && tierRounds.sonnet.length > 0) {
	out.push("## Claude Code：sonnet 档 vs opus 档");
	out.push("");
	out.push("同样的题、同样的隐藏测试，只换 Claude Code 的模型档位。Clownfish 一列作为不变的参照。");
	out.push("");
	const pick = (list, task) => {
		// The newest run of that task wins, so a re-run supersedes an older one.
		const hits = list.flatMap((r) => r.results.filter((x) => x.task === task && x.agent === "claude-code"));
		return hits[hits.length - 1];
	};
	const cf = (task) => {
		const hits = rounds.flatMap((r) => r.results.filter((x) => x.task === task && x.agent === "clownfish"));
		return hits[hits.length - 1];
	};
	out.push("| 任务 | sonnet 正确性/用时/token/费用 | opus 正确性/用时/token/费用 | clownfish（参照） |");
	out.push("|---|---|---|---|");
	const cell = (r) =>
		r
			? `${r.score.passed}/${r.score.total} · ${(r.ms / 1000).toFixed(0)}s · ${formatTokens(r.usage?.totalTokens ?? 0)} · ${formatCost(r.cost)}`
			: "–";
	for (const t of tasks) {
		const s1 = pick(tierRounds.sonnet, t);
		const o1 = pick(tierRounds.opus, t);
		if (!s1 && !o1) continue;
		out.push(`| \`${t}\` | ${cell(s1)} | ${cell(o1)} | ${cell(cf(t))} |`);
	}
	out.push("");
	const sum = (list, sel) => {
		const rows = tasks.map((t) => pick(list, t)).filter(Boolean);
		return sel(rows);
	};
	const tot = (rows, k) => rows.reduce((s, r) => s + (k === "cost" ? (r.cost?.amount ?? 0) : k === "ms" ? r.ms : (r.usage?.[k] ?? 0)), 0);
	out.push(
		`合计 — sonnet：${(sum(tierRounds.sonnet, (r) => tot(r, "ms")) / 1000).toFixed(0)}s · ${formatTokens(sum(tierRounds.sonnet, (r) => tot(r, "totalTokens")))} · ¥${sum(tierRounds.sonnet, (r) => tot(r, "cost")).toFixed(2)}；` +
			`opus：${(sum(tierRounds.opus, (r) => tot(r, "ms")) / 1000).toFixed(0)}s · ${formatTokens(sum(tierRounds.opus, (r) => tot(r, "totalTokens")))} · ¥${sum(tierRounds.opus, (r) => tot(r, "cost")).toFixed(2)}`,
	);
	out.push("");
}

if (rounds.length > 1) {
	out.push("## 轮次间变化");
	out.push("");
	out.push(`| 任务 | ${rounds.map((r) => `r${r.round}`).join(" | ")} |`);
	out.push(`|---|${rounds.map(() => "---").join("|")}|`);
	for (const a of agents) {
		out.push(`| **${a}** | ${rounds.map(() => "").join(" | ")} |`);
		for (const t of tasks) {
			out.push(`| \`${t}\` | ${rounds.map((r) => cell(r.results.find((x) => x.task === t && x.agent === a))).join(" | ")} |`);
		}
	}
	out.push("");
}

console.log(out.join("\n"));
