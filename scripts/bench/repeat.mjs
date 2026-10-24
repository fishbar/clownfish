/**
 * Repeat ONE task N times with one agent, and report the pass rate.
 *
 *   node scripts/bench/repeat.mjs --task flaky-ci --n 5 --label baseline
 *
 * A single benchmark run cannot tell a harness improvement from a lucky sample:
 * the same task, same harness, produced both a correct fix and a flaky one on
 * different days. Anything claimed as an improvement has to move a RATE, so this
 * exists to measure one.
 *
 * Artifacts land in `.bench/repeat/<label>/<task>/run<i>/`, separate from the
 * numbered rounds so an experiment never disturbs the scoreboard.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS as PHASE1 } from "./tasks.mjs";
import { TASKS as PHASE2 } from "./tasks2.mjs";
import { TASKS as PHASE3 } from "./tasks3.mjs";
import { TASKS as PHASE4 } from "./tasks4.mjs";
import { TASKS as PHASE5 } from "./tasks5.mjs";
import { startClownfish, runClownfishTask } from "./runners/clownfish.mjs";
import { runClaudeTask } from "./runners/claude.mjs";
import { costOf } from "./pricing.mjs";
import { formatTokens } from "./usage.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const TASK_ID = arg("task", "flaky-ci");
const N = Number(arg("n", "5"));
const LABEL = arg("label", "run");
const AGENT = arg("agent", "clownfish");
const MODEL = arg("model", "glm-5.2");
const TIMEOUT_MS = Number(arg("timeout", String(15 * 60_000)));
const CONCURRENCY = Number(arg("concurrency", "3"));

const task = [...PHASE1, ...PHASE2, ...PHASE3, ...PHASE4, ...PHASE5].find((t) => t.id === TASK_ID);
if (!task) {
	console.error(`unknown task: ${TASK_ID}`);
	process.exit(2);
}

function providerEnv() {
	const settingsPath = join(process.env.HOME ?? "", ".clownfish", "settings.json");
	if (!existsSync(settingsPath)) return {};
	const env = JSON.parse(readFileSync(settingsPath, "utf8")).env ?? {};
	const out = {};
	for (const [k, v] of Object.entries(env)) if (!k.startsWith("//") && typeof v === "string") out[k] = v;
	out.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL;
	out.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL;
	return out;
}

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function pool(items, size, worker) {
	const out = [];
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			for (;;) {
				const idx = i++;
				if (idx >= items.length) return;
				out[idx] = await worker(items[idx], idx);
			}
		}),
	);
	return out;
}

const base = join(ROOT, ".bench", "repeat", LABEL, TASK_ID);
mkdirSync(base, { recursive: true });
const env = providerEnv();
const server = AGENT === "clownfish" ? await startClownfish({ dataDir: join(base, "data"), model: MODEL, env, log }) : undefined;

const results = await pool(
	Array.from({ length: N }, (_, i) => i),
	CONCURRENCY,
	async (i) => {
		const workspace = join(base, `run${i + 1}`, "workspace");
		rmSync(workspace, { recursive: true, force: true });
		mkdirSync(workspace, { recursive: true });
		task.seed(workspace);
		let run;
		try {
			run =
				AGENT === "clownfish"
					? await runClownfishTask({ server, workspace, name: `${LABEL}-${TASK_ID}-${i + 1}`, prompt: task.prompt, timeoutMs: TIMEOUT_MS, log })
					: await runClaudeTask({ workspace, configDir: join(base, `run${i + 1}`, "cfg"), prompt: task.prompt, timeoutMs: TIMEOUT_MS, env, log });
		} catch (err) {
			run = { agent: AGENT, outcome: "runner-error", ms: 0, errors: [String(err).slice(0, 300)] };
		}
		const checks = task.verify(workspace);
		const passed = checks.filter((c) => c.ok).length;
		const cost = run.usage ? costOf(run.usage, run.model ?? MODEL) : null;
		log(`  run ${i + 1}: ${passed}/${checks.length} · ${(run.ms / 1000).toFixed(0)}s`);
		// `outcome` and `usage` must survive into the record: a run that TIMED OUT
		// reports no usage, and a summary that silently reads missing usage as zero
		// makes a timed-out run look like the cheapest one in the sample. It
		// happened — a 900s Claude timeout landed in a median as "0 tokens, ¥0".
		return {
			i: i + 1,
			passed,
			total: checks.length,
			ms: run.ms,
			outcome: run.outcome ?? "unknown",
			usage: run.usage,
			usageMissing: !run.usage,
			cost,
			failed: checks.filter((c) => !c.ok).map((c) => c.name),
		};
	},
);

await server?.stop();
writeFileSync(join(base, "results.json"), JSON.stringify({ label: LABEL, task: TASK_ID, agent: AGENT, results }, null, 2));

const full = results.filter((r) => r.passed === r.total).length;
// Token/cost aggregates come ONLY from runs that reported usage; a run without
// it is counted separately rather than as a free one.
const measured = results.filter((r) => !r.usageMissing);
const unmeasured = results.length - measured.length;
const tokens = measured.reduce((s, r) => s + (r.usage?.totalTokens ?? 0), 0);
const money = results.reduce((s, r) => s + (r.cost?.amount ?? 0), 0);
console.log(`\n${LABEL} · ${TASK_ID} · ${AGENT}`);
console.log(`满分率 ${full}/${N}  ·  平均 ${(results.reduce((s, r) => s + r.ms, 0) / N / 1000).toFixed(0)}s  ·  ${formatTokens(tokens)} tok  ·  ¥${money.toFixed(2)}`);
for (const r of results)
	console.log(
		`  run${r.i}: ${r.passed}/${r.total} · ${(r.ms / 1000).toFixed(0)}s · ${r.outcome}${r.usageMissing ? " · usage NOT recorded (excluded from token/cost stats)" : ""}${r.failed.length ? ` — 失败: ${r.failed.join("; ")}` : ""}`,
	);
if (unmeasured > 0)
	console.log(`  ⚠ ${unmeasured}/${results.length} run(s) reported no usage — token and cost figures cover the other ${measured.length}.`);
