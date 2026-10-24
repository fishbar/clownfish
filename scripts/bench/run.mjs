/**
 * Bench orchestrator — Clownfish vs Claude Code on the same tasks, same model.
 *
 *   node scripts/bench/run.mjs --round 1
 *   node scripts/bench/run.mjs --round 2 --tasks hot-path,semver-range
 *   node scripts/bench/run.mjs --dry            # seed + verify only (harness self-check)
 *
 * Each (round, agent, task) gets a pristine workspace seeded from the task
 * definition, so rounds are independent: an improvement to Clownfish is measured
 * on the same starting state, not on the previous round's leftovers.
 *
 * Results land under `.bench/runs/round<N>/…` as JSON plus a summary table, and
 * nothing outside `.bench/` is touched — the benchmark must never edit the repo
 * it is run from.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { TASKS as PHASE1 } from "./tasks.mjs";
import { TASKS as PHASE2 } from "./tasks2.mjs";
import { TASKS as PHASE3 } from "./tasks3.mjs";
import { TASKS as PHASE4 } from "./tasks4.mjs";
import { TASKS as PHASE5 } from "./tasks5.mjs";
import { loadPolyglotTasks } from "./polyglot.mjs";
import { startClownfish, runClownfishTask } from "./runners/clownfish.mjs";
import { efficiencyChecks } from "./usage.mjs";
import { costOf } from "./pricing.mjs";
import { runClaudeTask } from "./runners/claude.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BENCH_ROOT = join(ROOT, ".bench");

/**
 * Every flag this script understands. An unknown one is a HARD ERROR, not a
 * shrug: `--only heisenbug` was silently ignored for a whole round (the flag is
 * `--tasks`), so the round quietly ran a different task set than intended. A
 * benchmark that accepts a flag it does not implement is a benchmark that lies.
 */
const KNOWN_FLAGS = new Set([
	"round", "dry", "rescore", "force", "agents", "tasks", "timeout", "model",
	"claude-model", "claude-model-id", "concurrency", "suite", "n", "langs",
	"polyglot-root",
]);
for (let i = 2; i < process.argv.length; i++) {
	const token = process.argv[i];
	if (!token.startsWith("--")) continue;
	const name = token.slice(2).split("=")[0];
	if (!KNOWN_FLAGS.has(name)) {
		console.error(`unknown flag: ${token}\nknown flags: ${[...KNOWN_FLAGS].sort().map((f) => `--${f}`).join(" ")}`);
		process.exit(2);
	}
}

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const ROUND = Number(arg("round", "1"));
const DRY = flag("dry");
// Re-verify workspaces that already exist, without spending another agent run.
// Verifier bugs are found by running it, and re-running the agents to fix one
// would make every round incomparable.
const RESCORE = flag("rescore");
const FORCE = flag("force");
const AGENTS = arg("agents", "clownfish,claude").split(",").filter(Boolean);
const ONLY = arg("tasks", "").split(",").filter(Boolean);
const TIMEOUT_MS = Number(arg("timeout", String(15 * 60_000)));
const MODEL = arg("model", "glm-5.2");
// Claude Code picks a model by TIER alias; the tier is mapped to a concrete GLM
// model below. Raising the tier makes the round no longer model-controlled.
const CLAUDE_TIER = arg("claude-model", "sonnet");
const CLAUDE_MODEL_ID = arg("claude-model-id", CLAUDE_TIER === "opus" ? "glm-5.3" : MODEL);
const CONCURRENCY = Number(arg("concurrency", "2"));

// `--suite phase2` swaps in the benchmark-family set; `--suite all` runs both.
const SUITE = arg("suite", "phase1");
// `--suite polyglot` draws from a checkout of Aider's public benchmark instead of
// our own tasks, so the harness is measured against problems we did not write.
const POLYGLOT =
	SUITE === "polyglot"
		? loadPolyglotTasks({
				root: arg("polyglot-root", join(BENCH_ROOT, "polyglot-benchmark")),
				langs: arg("langs", "python,go,rust").split(",").map((l) => l.trim()).filter(Boolean),
				count: Number(arg("n", "12")),
			})
		: [];
/**
 * Suites by name. A table rather than a ternary chain because the chain had a
 * silent default: an unknown `--suite` fell through to phase1 and ran a
 * different set than asked for, which is the same way `--only` lied.
 */
const SUITES = {
	phase1: () => PHASE1,
	phase2: () => PHASE2,
	phase3: () => PHASE3,
	phase4: () => PHASE4,
	phase5: () => PHASE5,
	polyglot: () => POLYGLOT,
	all: () => [...PHASE1, ...PHASE2, ...PHASE3, ...PHASE4, ...PHASE5],
};
if (!SUITES[SUITE]) {
	console.error(`unknown suite: ${SUITE}\nknown suites: ${Object.keys(SUITES).join(", ")}`);
	process.exit(2);
}
const ALL_TASKS = SUITES[SUITE]();
const tasks = ONLY.length ? ALL_TASKS.filter((t) => ONLY.includes(t.id)) : ALL_TASKS;
if (ONLY.length && tasks.length !== ONLY.length) {
	const missing = ONLY.filter((id) => !tasks.some((t) => t.id === id));
	console.error(`--tasks named ${missing.length} id(s) not in suite '${SUITE}': ${missing.join(", ")}`);
	console.error(`available: ${ALL_TASKS.map((t) => t.id).join(", ")}`);
	process.exit(2);
}
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

/** Provider credentials for BOTH agents, so the comparison is harness-vs-harness. */
function providerEnv() {
	const settingsPath = join(process.env.HOME ?? "", ".clownfish", "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const env = JSON.parse(readFileSync(settingsPath, "utf8")).env ?? {};
		const out = {};
		for (const [k, v] of Object.entries(env)) {
			if (!k.startsWith("//") && typeof v === "string") out[k] = v;
		}
		// Claude Code picks its model through the tier aliases.
		out.ANTHROPIC_DEFAULT_SONNET_MODEL = CLAUDE_TIER === "sonnet" ? CLAUDE_MODEL_ID : MODEL;
		out.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL;
		out.ANTHROPIC_DEFAULT_OPUS_MODEL = CLAUDE_TIER === "opus" ? CLAUDE_MODEL_ID : MODEL;
		return out;
	} catch {
		return {};
	}
}

function score(checks) {
	const passed = checks.filter((c) => c.ok).length;
	return { passed, total: checks.length, ratio: checks.length ? passed / checks.length : 0 };
}

async function pool(items, size, worker) {
	const results = [];
	let cursor = 0;
	const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

async function main() {
	const roundDir = join(BENCH_ROOT, "runs", `round${ROUND}`);
	// A dry run re-seeds every workspace and rewrites the results. Pointed at a
	// round that holds real agent work, it destroys it — which happened once, to
	// round 1. Refuse instead of trusting the caller to pass the right number.
	if (DRY) {
		const existing = join(roundDir, "summary.json");
		if (existsSync(existing)) {
			const prior = JSON.parse(readFileSync(existing, "utf8"));
			const real = (prior.results ?? []).filter((r) => r.outcome && r.outcome !== "skipped");
			if (real.length > 0 && !FORCE) {
				console.error(
					`round ${ROUND} holds ${real.length} real agent run(s) — a dry run would overwrite them. Use --round 0 for baselines, or --force to insist.`,
				);
				process.exit(4);
			}
		}
	}
	mkdirSync(roundDir, { recursive: true });
	const env = providerEnv();
	if (!DRY && !RESCORE && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
		console.error("No provider credentials found in ~/.clownfish/settings.json — run with --dry or configure one.");
		process.exit(2);
	}

	let server;
	if (!DRY && !RESCORE && AGENTS.includes("clownfish")) {
		server = await startClownfish({ dataDir: join(roundDir, "clownfish-data"), model: MODEL, env, log });
	}

	const jobs = [];
	for (const task of tasks) for (const agent of AGENTS) jobs.push({ task, agent });

	const results = (await pool(jobs, DRY || RESCORE ? 4 : CONCURRENCY, async ({ task, agent }) => {
		const workspace = join(roundDir, agent, task.id, "workspace");
		const resultPath = join(roundDir, agent, task.id, "result.json");
		let run = { agent, outcome: "skipped", ms: 0 };
		if (RESCORE) {
			// Keep the agent's own numbers; only the verdict is recomputed.
			if (!existsSync(workspace)) return null;
			if (existsSync(resultPath)) {
				const prior = JSON.parse(readFileSync(resultPath, "utf8"));
				run = { ...prior, checks: undefined, score: undefined };
				// Claude Code's raw envelope is not the normalized shape the cost and
				// efficiency code expects; prefer the normalized copy when one exists,
				// or a rescore silently zeroes the usage columns.
				if (prior.normalizedUsage?.totalTokens) run.usage = prior.normalizedUsage;
			}
		} else {
			rmSync(workspace, { recursive: true, force: true });
			mkdirSync(workspace, { recursive: true });
			task.seed(workspace);
		}

		if (!DRY && !RESCORE) {
			log(`▶ ${agent} · ${task.id}`);
			try {
				run =
					agent === "clownfish"
						? await runClownfishTask({ server, workspace, name: `bench-${task.id}-r${ROUND}`, prompt: task.prompt, timeoutMs: TIMEOUT_MS, log })
						: await runClaudeTask({
								workspace,
								configDir: join(roundDir, "claude-config", task.id),
								prompt: task.prompt,
								timeoutMs: TIMEOUT_MS,
								model: CLAUDE_TIER,
								env,
								log,
							});
			} catch (err) {
				run = { agent, outcome: "runner-error", ms: 0, errors: [String(err).slice(0, 500)] };
			}
		}

		let checks;
		try {
			checks = task.verify(workspace);
		} catch (err) {
			checks = [{ name: "verifier crashed", ok: false, detail: String(err).slice(0, 500) }];
		}
		// Efficiency is a second, independent verdict: speed, tokens and money,
		// each against the task's declared par.
		const effChecks = efficiencyChecks(task, run, run.model ?? MODEL);
		const result = {
			round: ROUND,
			task: task.id,
			title: task.title,
			...run,
			// Price by the model the run actually used, not the round's default —
			// the two agents may be on different tiers.
			cost: run.usage ? costOf(run.usage, run.model ?? MODEL) : null,
			checks,
			score: score(checks),
			efficiency: { checks: effChecks, ...score(effChecks) },
		};
		mkdirSync(join(roundDir, agent, task.id), { recursive: true });
		writeFileSync(resultPath, JSON.stringify(result, null, 2));
		log(`■ ${agent} · ${task.id} → ${result.score.passed}/${result.score.total} (${run.outcome})`);
		return result;
	})).filter(Boolean);

	await server?.stop();

	// A rescore re-verifies existing work; it must not restamp the round with the
	// CLI defaults of whoever re-ran it — the tier the agents actually used is a
	// property of the run, not of this invocation.
	const priorSummary = existsSync(join(roundDir, "summary.json"))
		? JSON.parse(readFileSync(join(roundDir, "summary.json"), "utf8"))
		: {};
	const summary = {
		round: ROUND,
		model: RESCORE ? (priorSummary.model ?? MODEL) : MODEL,
		claudeTier: RESCORE ? (priorSummary.claudeTier ?? CLAUDE_TIER) : CLAUDE_TIER,
		claudeModel: RESCORE ? (priorSummary.claudeModel ?? CLAUDE_MODEL_ID) : CLAUDE_MODEL_ID,
		when: new Date().toISOString(),
		results,
	};
	writeFileSync(join(roundDir, "summary.json"), JSON.stringify(summary, null, 2));

	console.log(`\n=== round ${ROUND} =================================================`);
	const width = Math.max(...tasks.map((t) => t.id.length)) + 2;
	console.log("task".padEnd(width) + AGENTS.map((a) => a.padEnd(18)).join(""));
	for (const task of tasks) {
		const cells = AGENTS.map((a) => {
			const r = results.find((x) => x?.task === task.id && x.agent.startsWith(a === "claude" ? "claude" : a));
			return r ? `${r.score.passed}/${r.score.total} ${(r.ms / 1000).toFixed(0)}s`.padEnd(18) : "-".padEnd(18);
		});
		console.log(task.id.padEnd(width) + cells.join(""));
	}
	for (const a of AGENTS) {
		const mine = results.filter((r) => r?.agent.startsWith(a === "claude" ? "claude" : a));
		const passed = mine.reduce((s, r) => s + r.score.passed, 0);
		const total = mine.reduce((s, r) => s + r.score.total, 0);
		const eff = mine.reduce((s, r) => s + (r.efficiency?.passed ?? 0), 0);
		const effTotal = mine.reduce((s, r) => s + (r.efficiency?.total ?? 0), 0);
		const tokens = mine.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0);
		const money = mine.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);
		const secs = Math.round(mine.reduce((s, r) => s + r.ms, 0) / 1000);
		console.log(
			`${a}: 正确性 ${passed}/${total} (${((passed / Math.max(1, total)) * 100).toFixed(0)}%) · 效率 ${eff}/${effTotal} · ${secs}s · ${(tokens / 1000).toFixed(0)}k tok · ¥${money.toFixed(2)}`,
		);
	}
	if (DRY) {
		// The seed must score exactly what the task says it should: too low means the
		// starting workspace is broken (the agent would be asked to fix an unstated
		// bug), too high means the task hands out points for work nobody did.
		let bad = 0;
		for (const task of tasks) {
			if (typeof task.expectDry !== "number") continue;
			const got = results.find((r) => r.task === task.id)?.score.passed;
			if (got !== task.expectDry) {
				bad++;
				console.error(`BASELINE MISMATCH  ${task.id}: expected ${task.expectDry} check(s) to pass on an untouched seed, got ${got}`);
			}
		}
		console.log(bad === 0 ? "baseline check: all tasks match their declared dry-run score" : `baseline check: ${bad} task(s) off`);

		// A prompt that names a command which does not RUN here sends the agent
		// debugging our harness instead of the task. Eleven prompts across five
		// suites told the agent to run `node --test test/`, which fails on this
		// machine with a module-resolution error; one phase-5 run spent its entire
		// 900s budget on it. Every shell command quoted in a prompt is now executed
		// against the seeded workspace, and a harness-level failure (the command
		// cannot start) fails the dry run. An assertion failure is fine — plenty of
		// seeds are meant to have a red suite.
		let broken = 0;
		for (const task of tasks) {
			const workspace = join(roundDir, AGENTS[0], task.id, "workspace");
			if (!existsSync(workspace)) continue;
			const quoted = new Set([...String(task.prompt ?? "").matchAll(/`((?:node|npm|make|go|cargo|python3?) [^`\n]{2,80})`/g)].map((m) => m[1]));
			for (const cmd of quoted) {
				const r = spawnSync(cmd, { cwd: workspace, shell: true, encoding: "utf8", timeout: 120_000 });
				const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
				// "cannot start" — not "ran and reported failures".
				if (/Cannot find module|command not found|no such file or directory|MODULE_NOT_FOUND/i.test(out)) {
					broken++;
					console.error(`BROKEN COMMAND  ${task.id}: the prompt tells the agent to run \`${cmd}\`, which does not run here:\n    ${out.trim().split("\n")[0].slice(0, 160)}`);
				}
			}
		}
		if (broken > 0) {
			console.error(`command check: ${broken} prompt command(s) do not run in their own seeded workspace`);
			process.exitCode = 3;
		} else {
			console.log("command check: every command quoted in a prompt runs in its seeded workspace");
		}
		if (bad > 0) process.exitCode = 3;
	}
	console.log(`artifacts → ${roundDir}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
