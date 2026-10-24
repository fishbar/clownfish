/**
 * Phase-4 — tasks that are hard for a HARNESS, not merely long.
 *
 * Phases 1–3 saturated: both agents scored full marks and only wall time
 * separated them. Re-running a saturated suite buys no information, so these
 * tasks target the behaviours a harness either has or does not, and each one
 * fails an agent that skips the behaviour rather than merely slowing it down:
 *
 *   heisenbug        — the failure is NOT in the test suite. There is a CI log
 *                      and a green `node --test`. An agent that reads code and
 *                      declares victory cannot pass; you have to build a probe
 *                      that reproduces the interleaving.
 *   perf-bisect      — the answer is in git history, not in the working tree,
 *                      and the obvious move (revert the bad commit) destroys a
 *                      feature the hidden tests require.
 *   needle-in-haystack — one defect inside 6k lines of generated code, with a
 *                      hidden check that every OTHER line is untouched. Reading
 *                      the whole file into context and rewriting it fails.
 *
 * Every task is offline (node + git only) and scored by hidden tests.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";

const write = (dir, rel, content) => {
	const file = join(dir, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};

function node(dir, args, timeoutMs = 180_000) {
	try {
		return { ok: true, stdout: execFileSync(process.execPath, args, { cwd: dir, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (e) {
		return { ok: false, stdout: e.stdout?.toString() ?? "", stderr: (e.stderr?.toString() ?? "") + (e.message ?? "") };
	}
}

function git(dir, args) {
	try {
		return { ok: true, out: execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (e) {
		return { ok: false, out: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") };
	}
}

function sources(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name.startsWith(".") || e.name === "node_modules") continue;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

function runSuite(dir, sub = "test") {
	const files = sources(join(dir, sub)).map((f) => relative(dir, f));
	if (files.length === 0) return { ok: false, stdout: "no test files found", stderr: "" };
	return node(dir, ["--test", "--test-reporter=tap", ...files]);
}

/** Write a hidden test into the workspace, run it, and report pass/fail counts. */
function runHidden(dir, rel, source, timeoutMs = 180_000) {
	write(dir, rel, source);
	const r = node(dir, ["--test", "--test-reporter=tap", rel], timeoutMs);
	return {
		pass: Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		fail: Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		output: `${r.stdout}\n${r.stderr}`.slice(-4000),
	};
}

const read = (dir, rel) => {
	try {
		return readFileSync(join(dir, rel), "utf8");
	} catch {
		return "";
	}
};

// ---------------------------------------------------------------------------
// Q1 — heisenbug: the failure is in production, not in the test suite
// ---------------------------------------------------------------------------

/**
 * Three independent defects in one scheduler, none of which the shipped tests
 * catch, because the shipped tests only ever await one tick at a time:
 *
 *   1. check-then-act — `due()` is async, so two ticks started in the same turn
 *      both see `running === false` and both claim the same job. This is the
 *      double-run in the CI log.
 *   2. `nextRun` is computed from the `now` captured at the START of the tick,
 *      so a job that runs longer than its interval is instantly due again.
 *   3. `running` is cleared after the await with no `finally`, so a job that
 *      throws stays claimed forever and never runs again.
 *
 * The traps are in the FIXES, not the bugs: serialising `tick` (an await-in-loop,
 * or one scheduler-wide lock) kills the double-run and fails the concurrency
 * check, and clearing `running` without `finally` fails the throwing-job check.
 * The only shape that passes everything is a synchronous per-job claim released
 * in a `finally`.
 */
const heisenbug = {
	id: "heisenbug",
	budget: { ms: 420_000, tokens: 420_000, cost: 1.6 },
	/** Untouched seed: the concurrency check and the shipped suite already pass. */
	expectDry: 2,
	title: "线上偶发 bug：测试全绿，只有一份 CI 日志",
	prompt: `Our job scheduler double-runs jobs in production. \`node --test test/*.test.js\` is GREEN and has been for months — the bug does not show up there.

What we have is CI-FAILURE.md: one captured failure from the staging box, with the log line and what the box was doing at the time.

Please:
1. Reproduce it. Write yourself a probe that makes the failure happen deterministically — do not guess from reading the code. Leave the probe in the repo as \`probe.mjs\` so we can re-run it.
2. Fix the root cause in src/scheduler.js.
3. Make sure the existing suite still passes.

Two things the fix must NOT do, because we depend on them:
- Jobs that are due at the same time must still run CONCURRENTLY. Serialising the scheduler would "fix" the double-run and is not acceptable.
- A job that throws must not wedge the scheduler: it has to be eligible again on the next tick.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "scheduler", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"CI-FAILURE.md",
			`# Staging failure — 2026-08-14T02:17:44Z

The billing job ran twice for the same period. We only noticed because the
downstream ledger rejected the duplicate.

\`\`\`
[02:17:44.118] scheduler: tick
[02:17:44.118] job billing: start
[02:17:44.119] job billing: start          <-- twice, same tick window
[02:17:44.271] job billing: done
[02:17:44.273] job billing: done
AssertionError [ERR_ASSERTION]: ledger rejected duplicate posting for 2026-08
\`\`\`

## What the box was doing

The scheduler is driven by a timer that calls \`tick()\` every 50ms. Nothing
awaits the previous tick before starting the next one — if a tick takes longer
than the interval, the next one starts while it is still in flight. On staging
the database is slow, so that happens constantly. On our laptops (and in CI) a
tick finishes in under a millisecond and the ticks never overlap.

We have not been able to reproduce it locally.
`,
		);
		write(
			dir,
			"src/clock.js",
			`/** Injectable clock so tests do not depend on wall time. */
export function systemClock() {
	return { now: () => Date.now() };
}

export function manualClock(start = 0) {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}
`,
		);
		write(
			dir,
			"src/scheduler.js",
			`/**
 * Interval scheduler. \`tick()\` runs every job whose next run is due; the caller
 * drives it from a timer and does not await between ticks.
 */
export class Scheduler {
	constructor(clock) {
		this.clock = clock;
		this.jobs = new Map();
		this.log = [];
	}

	add(id, intervalMs, run) {
		this.jobs.set(id, { id, intervalMs, run, nextRun: this.clock.now(), running: false, runs: 0, errors: 0 });
	}

	stats(id) {
		const job = this.jobs.get(id);
		return job ? { runs: job.runs, errors: job.errors, running: job.running, nextRun: job.nextRun } : null;
	}

	/** Everything due at \`now\` and not already in flight. */
	async due(now) {
		return [...this.jobs.values()].filter((job) => job.nextRun <= now && !job.running);
	}

	async tick() {
		const now = this.clock.now();
		const due = await this.due(now);
		await Promise.all(
			due.map(async (job) => {
				job.running = true;
				this.log.push(\`job \${job.id}: start\`);
				await job.run();
				this.log.push(\`job \${job.id}: done\`);
				job.runs++;
				job.running = false;
				job.nextRun = now + job.intervalMs;
			}),
		);
	}
}
`,
		);
		write(
			dir,
			"test/scheduler.test.js",
			`import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { manualClock } from "../src/clock.js";

test("runs a due job", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	let runs = 0;
	s.add("a", 100, async () => { runs++; });
	await s.tick();
	assert.equal(runs, 1);
});

test("does not run a job before it is due", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	let runs = 0;
	s.add("a", 100, async () => { runs++; });
	await s.tick();
	await s.tick();
	assert.equal(runs, 1, "second tick is too early");
});

test("runs again once the interval has elapsed", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	let runs = 0;
	s.add("a", 100, async () => { runs++; });
	await s.tick();
	clock.advance(100);
	await s.tick();
	assert.equal(runs, 2);
});

test("independent jobs both run", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	const ran = [];
	s.add("a", 100, async () => { ran.push("a"); });
	s.add("b", 100, async () => { ran.push("b"); });
	await s.tick();
	assert.deepEqual(ran.sort(), ["a", "b"]);
});
`,
		);
	},
	verify(dir) {
		const checks = [];

		const visible = runSuite(dir);
		checks.push({
			name: "the shipped suite still passes",
			ok: visible.ok && /# fail 0/.test(visible.stdout),
			detail: `${visible.stdout}\n${visible.stderr}`.slice(-1200),
		});

		// The CI failure, made deterministic: two ticks in the same turn.
		const overlap = runHidden(
			dir,
			"hidden/overlap.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { manualClock } from "../src/clock.js";

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

test("overlapping ticks run a due job exactly once", async () => {
	const s = new Scheduler(manualClock(1000));
	let runs = 0;
	s.add("billing", 100, async () => { runs++; await defer(20); });
	// The timer does not await the previous tick — this is the staging schedule.
	await Promise.all([s.tick(), s.tick()]);
	assert.equal(runs, 1, "the job ran " + runs + " times for one due window");
});

test("a tick started mid-flight does not re-claim the job", async () => {
	const s = new Scheduler(manualClock(1000));
	let runs = 0;
	s.add("billing", 100, async () => { runs++; await defer(30); });
	const first = s.tick();
	await defer(10);          // first tick is in flight
	await s.tick();
	await first;
	assert.equal(runs, 1, "the job ran " + runs + " times");
});

test("many interleavings, never a double run", async () => {
	for (let i = 0; i < 40; i++) {
		const s = new Scheduler(manualClock(1000));
		let runs = 0;
		s.add("j", 1000, async () => { runs++; await defer(i % 5); });
		const ticks = [s.tick(), s.tick(), s.tick()];
		await defer(i % 3);
		ticks.push(s.tick());
		await Promise.all(ticks);
		assert.equal(runs, 1, "iteration " + i + " ran the job " + runs + " times");
	}
});
`,
		);
		checks.push({
			name: `hidden: overlapping ticks never double-run a job (${overlap.pass}p/${overlap.fail}f)`,
			ok: overlap.fail === 0 && overlap.pass >= 3,
			detail: overlap.output.slice(-1200),
		});

		// The trap: serialising the scheduler also stops the double-run.
		const concurrency = runHidden(
			dir,
			"hidden/concurrency.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { manualClock } from "../src/clock.js";

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

test("jobs due together still run concurrently", async () => {
	const s = new Scheduler(manualClock(1000));
	for (const id of ["a", "b", "c", "d"]) s.add(id, 1000, async () => { await defer(60); });
	const started = Date.now();
	await s.tick();
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 160, "four 60ms jobs took " + elapsed + "ms — the scheduler was serialised");
});

test("a slow job does not block an unrelated one", async () => {
	const s = new Scheduler(manualClock(1000));
	const done = [];
	s.add("slow", 1000, async () => { await defer(80); done.push("slow"); });
	s.add("fast", 1000, async () => { await defer(5); done.push("fast"); });
	await s.tick();
	assert.deepEqual(done, ["fast", "slow"], "the fast job waited for the slow one");
});
`,
		);
		checks.push({
			name: `hidden: the fix did not serialise the scheduler (${concurrency.pass}p/${concurrency.fail}f)`,
			ok: concurrency.fail === 0 && concurrency.pass >= 2,
			detail: concurrency.output.slice(-1200),
		});

		// The other two defects the CI log does not mention.
		const resilience = runHidden(
			dir,
			"hidden/resilience.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { manualClock } from "../src/clock.js";

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

test("a job that throws is released, not wedged", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	let attempts = 0;
	s.add("flaky", 100, async () => {
		attempts++;
		if (attempts === 1) throw new Error("boom");
	});
	await s.tick().catch(() => {});
	clock.advance(100);
	await s.tick().catch(() => {});
	assert.equal(attempts, 2, "the job was claimed forever after it threw");
});

test("a job slower than its interval is not instantly due again", async () => {
	const clock = manualClock(1000);
	const s = new Scheduler(clock);
	let runs = 0;
	// The job takes longer than its own interval; its next run must be scheduled
	// from when it FINISHED, not from when the tick started.
	s.add("slow", 10, async () => { runs++; clock.advance(50); await defer(5); });
	await s.tick();
	assert.equal(runs, 1);
	await s.tick();
	assert.equal(runs, 1, "the job re-fired immediately — nextRun was computed from a stale clock read");
});
`,
		);
		checks.push({
			name: `hidden: throwing and slow jobs are handled (${resilience.pass}p/${resilience.fail}f)`,
			ok: resilience.fail === 0 && resilience.pass >= 2,
			detail: resilience.output.slice(-1200),
		});

		// The task asked for a reproduction, not just a patch.
		const probe = read(dir, "probe.mjs");
		checks.push({
			name: "a reproduction probe was left in the repo",
			ok: probe.trim().length > 0 && /scheduler/i.test(probe),
			detail: probe ? `probe.mjs is ${probe.length} bytes` : "probe.mjs missing",
		});

		return checks;
	},
};

// ---------------------------------------------------------------------------
// Q2 — perf-bisect: the cause is in history, and the obvious fix loses a feature
// ---------------------------------------------------------------------------

/**
 * A document store whose tag index was correct and fast until commit "search:
 * make tag matching case-insensitive" replaced the index lookup with a linear
 * scan that lowercases on every comparison. The feature that commit added is
 * REQUIRED by the hidden tests, so the two moves an agent reaches for first —
 * `git revert` the bad commit, or `git reset --hard` to the commit before it —
 * both score worse than doing nothing. The fix is to keep the feature and put
 * the normalisation back in the index, where it costs nothing per query.
 *
 * Timing is measured RELATIVE to a naive implementation the hidden test carries
 * itself, so the threshold means the same thing on a fast laptop and a loaded
 * CI box.
 */
const perfBisect = {
	id: "perf-bisect",
	budget: { ms: 420_000, tokens: 400_000, cost: 1.5 },
	/** Untouched seed: everything works, it is only slow. */
	expectDry: 4,
	title: "性能回归定位：原因在 git 历史里，而直接 revert 会丢功能",
	prompt: `Search got slow. Nobody knows which change did it — the store used to answer tag queries instantly and now \`node bench.mjs\` takes seconds.

The git history is intact. Find the commit that introduced the regression and make the store fast again.

Constraints, because we shipped on top of that commit:
- Every feature currently in main must keep working. Whatever that commit added, users depend on now.
- Do not rewrite history. Keep the existing commits reachable — we reference them from tickets.
- \`node --test test/*.test.js\` must pass.

\`bench.mjs\` is the workload that matters. Report which commit you identified.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "docstore", type: "module", private: true }, null, 2) + "\n");
		write(dir, ".gitignore", "node_modules/\n");

		const corpus = `/** Deterministic corpus, so the benchmark is comparable between runs. */
export function makeDocs(count) {
	const docs = [];
	let seed = 12345;
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
	for (let i = 0; i < count; i++) {
		const tags = [];
		for (let t = 0; t < 3; t++) {
			const w = words[Math.floor(rand() * words.length)];
			tags.push(rand() > 0.5 ? w.toUpperCase() : w);
		}
		docs.push({ id: "doc-" + i, title: "Document " + i, body: words[Math.floor(rand() * words.length)] + " " + i, tags });
	}
	return docs;
}
`;

		const testFile = `import test from "node:test";
import assert from "node:assert/strict";
import { DocStore } from "../src/store.js";

const seedDocs = [
	{ id: "a", title: "Alpha", body: "one", tags: ["Red", "blue"] },
	{ id: "b", title: "Beta", body: "two", tags: ["red", "GREEN"] },
	{ id: "c", title: "Gamma", body: "three", tags: ["blue"] },
];

function store() {
	const s = new DocStore();
	for (const d of seedDocs) s.add(d);
	return s;
}

test("byTag finds documents", () => {
	assert.deepEqual(store().byTag("blue").map((d) => d.id).sort(), ["a", "c"]);
});

test("byTag is case-insensitive", () => {
	assert.deepEqual(store().byTag("RED").map((d) => d.id).sort(), ["a", "b"]);
	assert.deepEqual(store().byTag("green").map((d) => d.id).sort(), ["b"]);
});

test("get returns a document by id", () => {
	assert.equal(store().get("b").title, "Beta");
});

test("remove drops a document from its tags", () => {
	const s = store();
	s.remove("a");
	assert.deepEqual(s.byTag("red").map((d) => d.id), ["b"]);
	assert.equal(s.get("a"), undefined);
});

test("size reports the document count", () => {
	assert.equal(store().size(), 3);
});
`;

		const bench = `import { DocStore } from "./src/store.js";
import { makeDocs } from "./src/corpus.js";

const docs = makeDocs(4000);
const store = new DocStore();
for (const d of docs) store.add(d);

const queries = ["alpha", "BETA", "Gamma", "delta", "EPSILON", "zeta", "eta", "THETA"];
const started = Date.now();
let hits = 0;
for (let i = 0; i < 3000; i++) hits += store.byTag(queries[i % queries.length]).length;
console.log("byTag: " + (Date.now() - started) + "ms for 3000 queries (" + hits + " hits)");
`;

		// --- history -----------------------------------------------------------
		const gitInit = () => {
			git(dir, ["init", "-q", "-b", "main"]);
			git(dir, ["config", "user.email", "bench@example.com"]);
			git(dir, ["config", "user.name", "Bench"]);
		};
		const commit = (msg) => {
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-q", "-m", msg, "--no-gpg-sign"]);
		};

		gitInit();

		// 1 — the store, indexed and fast, case-SENSITIVE.
		write(dir, "src/corpus.js", corpus);
		write(
			dir,
			"src/store.js",
			`/** In-memory document store with a tag index. */
export class DocStore {
	constructor() {
		this.docs = new Map();
		this.tagIndex = new Map();
	}

	add(doc) {
		this.docs.set(doc.id, doc);
		for (const tag of doc.tags) {
			let bucket = this.tagIndex.get(tag);
			if (!bucket) this.tagIndex.set(tag, (bucket = new Set()));
			bucket.add(doc.id);
		}
	}

	get(id) {
		return this.docs.get(id);
	}

	size() {
		return this.docs.size;
	}

	byTag(tag) {
		const bucket = this.tagIndex.get(tag);
		if (!bucket) return [];
		return [...bucket].map((id) => this.docs.get(id));
	}
}
`,
		);
		commit("store: in-memory document store with a tag index");

		write(dir, "bench.mjs", bench);
		commit("bench: measure byTag throughput");

		write(
			dir,
			"test/store.test.js",
			testFile.replace('test("byTag is case-insensitive", () => {\n\tassert.deepEqual(store().byTag("RED").map((d) => d.id).sort(), ["a", "b"]);\n\tassert.deepEqual(store().byTag("green").map((d) => d.id).sort(), ["b"]);\n});\n\n', ""),
		);
		commit("test: cover the store");

		// 2 — remove(), still fast.
		write(
			dir,
			"src/store.js",
			read(dir, "src/store.js").replace(
				`	byTag(tag) {`,
				`	remove(id) {
		const doc = this.docs.get(id);
		if (!doc) return false;
		this.docs.delete(id);
		for (const tag of doc.tags) this.tagIndex.get(tag)?.delete(id);
		return true;
	}

	byTag(tag) {`,
			),
		);
		commit("store: support removing a document");

		// 3 — a few unrelated commits, so the history is worth bisecting.
		write(dir, "README.md", "# docstore\n\nIn-memory document store with a tag index.\n\n- `node --test test/*.test.js` — tests\n- `node bench.mjs` — benchmark\n");
		commit("docs: readme");

		write(
			dir,
			"src/store.js",
			read(dir, "src/store.js").replace(
				`	byTag(tag) {`,
				`	/** Documents whose title or body contains \`needle\`. */
	search(needle) {
		const out = [];
		for (const doc of this.docs.values()) {
			if (doc.title.includes(needle) || doc.body.includes(needle)) out.push(doc);
		}
		return out;
	}

	byTag(tag) {`,
			),
		);
		commit("store: add a substring search");

		write(dir, "src/corpus.js", read(dir, "src/corpus.js").replace("count) {", "count) {"));
		write(dir, "CHANGELOG.md", "# Changelog\n\n- substring search\n- document removal\n");
		commit("docs: changelog");

		// 4 — THE REGRESSION. Case-insensitive matching, done by scanning.
		write(
			dir,
			"src/store.js",
			read(dir, "src/store.js").replace(
				`	byTag(tag) {
		const bucket = this.tagIndex.get(tag);
		if (!bucket) return [];
		return [...bucket].map((id) => this.docs.get(id));
	}`,
				`	byTag(tag) {
		// Tags are entered by hand and their case is inconsistent, so match
		// case-insensitively. The index is keyed on the raw tag and cannot answer
		// this, so scan the documents instead.
		const out = [];
		for (const doc of this.docs.values()) {
			for (const t of doc.tags) {
				if (t.toLowerCase() === tag.toLowerCase()) {
					out.push(doc);
					break;
				}
			}
		}
		return out;
	}`,
			),
		);
		write(dir, "test/store.test.js", testFile);
		commit("search: make tag matching case-insensitive");

		// 5 — commits shipped ON TOP of the regression, so reverting is not free.
		write(
			dir,
			"src/store.js",
			read(dir, "src/store.js").replace(
				`	/** Documents whose title or body contains \`needle\`. */`,
				`	/** Every tag currently in use, lowercased and de-duplicated. */
	tags() {
		const seen = new Set();
		for (const doc of this.docs.values()) for (const t of doc.tags) seen.add(t.toLowerCase());
		return [...seen].sort();
	}

	/** Documents whose title or body contains \`needle\`. */`,
			),
		);
		commit("store: list the tags in use");

		write(dir, "CHANGELOG.md", "# Changelog\n\n- tag listing\n- case-insensitive tag matching\n- substring search\n- document removal\n");
		commit("docs: changelog for the tag work");
	},
	verify(dir) {
		const checks = [];

		const visible = runSuite(dir);
		checks.push({
			name: "the shipped suite still passes",
			ok: visible.ok && /# fail 0/.test(visible.stdout),
			detail: `${visible.stdout}\n${visible.stderr}`.slice(-1200),
		});

		// The feature the regressing commit added. `git revert` loses this.
		const feature = runHidden(
			dir,
			"hidden/feature.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { DocStore } from "../src/store.js";

function store() {
	const s = new DocStore();
	s.add({ id: "a", title: "Alpha", body: "one", tags: ["Red", "blue"] });
	s.add({ id: "b", title: "Beta", body: "two", tags: ["red", "GREEN"] });
	s.add({ id: "c", title: "Gamma", body: "three", tags: ["BLUE", "red"] });
	return s;
}

test("byTag still matches regardless of case", () => {
	assert.deepEqual(store().byTag("RED").map((d) => d.id).sort(), ["a", "b", "c"]);
	assert.deepEqual(store().byTag("blue").map((d) => d.id).sort(), ["a", "c"]);
	assert.deepEqual(store().byTag("GrEeN").map((d) => d.id).sort(), ["b"]);
});

test("a tag nobody uses returns nothing", () => {
	assert.deepEqual(store().byTag("purple"), []);
});

test("each matching document appears exactly once", () => {
	// "c" carries BLUE and red; querying red must not return it twice.
	const ids = store().byTag("red").map((d) => d.id);
	assert.equal(new Set(ids).size, ids.length, "duplicate documents: " + ids.join(","));
});

test("tags() and search() — shipped on top of the regression — still work", () => {
	assert.deepEqual(store().tags(), ["blue", "green", "red"]);
	assert.deepEqual(store().search("Alpha").map((d) => d.id), ["a"]);
});

test("remove keeps the tag index consistent", () => {
	const s = store();
	s.remove("a");
	assert.deepEqual(s.byTag("RED").map((d) => d.id).sort(), ["b", "c"]);
	assert.deepEqual(s.byTag("blue").map((d) => d.id), ["c"]);
	assert.equal(s.size(), 2);
});
`,
		);
		checks.push({
			name: `hidden: every feature in main still works (${feature.pass}p/${feature.fail}f)`,
			ok: feature.fail === 0 && feature.pass >= 5,
			detail: feature.output.slice(-1200),
		});

		// Speed, measured against a naive implementation this test carries itself,
		// so the bar means the same thing on any machine.
		const perf = runHidden(
			dir,
			"hidden/perf.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { DocStore } from "../src/store.js";
import { makeDocs } from "../src/corpus.js";

const docs = makeDocs(4000);
const queries = ["alpha", "BETA", "Gamma", "delta", "EPSILON", "zeta", "eta", "THETA"];

/** The shape the regression left behind: a full scan, lowercasing per compare. */
function naiveByTag(all, tag) {
	const out = [];
	for (const doc of all) {
		for (const t of doc.tags) {
			if (t.toLowerCase() === tag.toLowerCase()) { out.push(doc); break; }
		}
	}
	return out;
}

function time(fn) {
	const started = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - started) / 1e6;
}

test("byTag is far faster than a full scan", () => {
	const store = new DocStore();
	for (const d of docs) store.add(d);
	// Warm both paths so the comparison is not a JIT artefact.
	for (let i = 0; i < 200; i++) { store.byTag(queries[i % queries.length]); naiveByTag(docs, queries[i % queries.length]); }

	const naive = time(() => { for (let i = 0; i < 1500; i++) naiveByTag(docs, queries[i % queries.length]); });
	const actual = time(() => { for (let i = 0; i < 1500; i++) store.byTag(queries[i % queries.length]); });

	assert.ok(
		actual * 4 < naive,
		"byTag took " + actual.toFixed(1) + "ms where a full scan takes " + naive.toFixed(1) + "ms — still linear in the corpus",
	);
});

test("a miss does not cost more as the corpus grows", () => {
	// A tag nobody uses. An index answers in constant time however big the store
	// gets; a scan reads every document every time. Comparing a MISS keeps the
	// result set out of the measurement — an indexed lookup is still linear in
	// the number of documents it returns, and that is fine.
	const build = (n) => { const s = new DocStore(); for (const d of makeDocs(n)) s.add(d); return s; };
	const small = build(500);
	const large = build(8000);
	for (let i = 0; i < 400; i++) { small.byTag("purple"); large.byTag("purple"); }
	const t = (s) => time(() => { for (let i = 0; i < 2000; i++) s.byTag("purple"); });
	const smallMs = t(small);
	const largeMs = t(large);
	assert.ok(
		largeMs < smallMs * 4 + 15,
		"16x the corpus cost " + (largeMs / Math.max(smallMs, 0.01)).toFixed(1) + "x the time on a miss (" + smallMs.toFixed(1) + "ms → " + largeMs.toFixed(1) + "ms) — byTag still scans",
	);
});
`,
		);
		checks.push({
			name: `hidden: tag lookup is indexed again (${perf.pass}p/${perf.fail}f)`,
			ok: perf.fail === 0 && perf.pass >= 2,
			detail: perf.output.slice(-1200),
		});

		// "Do not rewrite history": the regressing commit must still be reachable.
		const log = git(dir, ["log", "--format=%s", "HEAD"]);
		const subjects = log.ok ? log.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
		checks.push({
			name: "history was not rewritten — the regressing commit is still reachable",
			ok: subjects.includes("search: make tag matching case-insensitive") && subjects.includes("store: list the tags in use"),
			detail: subjects.length ? `HEAD has ${subjects.length} commits: ${subjects.slice(0, 4).join(" | ")}` : log.out.slice(-400),
		});

		// The benchmark is the workload the task named; it must still run.
		const benchRun = node(dir, ["bench.mjs"], 120_000);
		checks.push({
			name: "node bench.mjs still runs",
			ok: benchRun.ok && /byTag/.test(benchRun.stdout),
			detail: `${benchRun.stdout}\n${benchRun.stderr}`.slice(-600),
		});

		return checks;
	},
};

// ---------------------------------------------------------------------------
// Q3 — needle-in-haystack: one defect in 6k generated lines, no rewriting
// ---------------------------------------------------------------------------

/** 300 pricing rules, generated so the file is genuinely too big to hold in head. */
function ruleSource(i, broken) {
	const floor = 100 + i * 7;
	const rate = ((i % 9) + 1) * 3;
	// The spec says the surcharge applies STRICTLY ABOVE the threshold. The
	// broken rule uses >=, so it fires on the boundary itself.
	const cmp = broken ? ">=" : ">";
	return `/**
 * Rule ${i} — surcharge for tier ${i % 12}.
 * Applies ${rate}% above a ${floor} threshold.
 */
export function rule_${i}(order) {
	if (order.tier !== ${i % 12}) return 0;
	if (order.amount ${cmp} ${floor}) {
		return Math.round(order.amount * ${rate}) / 100;
	}
	return 0;
}
`;
}

/**
 * The defect is a single character (`>=` where the spec says `>`) in rule 187 of
 * 300, inside a ~6,000-line generated file. The failing test reports a totalled
 * mismatch and names no rule, so the rule has to be found — by bisecting inputs,
 * by grepping the spec's boundary wording against the source, or by generating a
 * boundary probe per rule. What it cannot be done by is reading the file.
 *
 * The second hidden check is the point of the task: every OTHER rule must still
 * behave exactly as it did. Regenerating or reformatting the file to "clean it
 * up" fails, and so does a fix that normalises all 300 comparisons.
 */
const needleInHaystack = {
	id: "needle-in-haystack",
	budget: { ms: 420_000, tokens: 450_000, cost: 1.7 },
	/** Untouched seed: the untouched-rules check passes; the failing test and the boundary do not. */
	expectDry: 1,
	title: "大文件里的一个字符：6000 行中定位缺陷，且不许重写",
	prompt: `\`src/rules.js\` holds 300 generated pricing rules. One of them disagrees with RULES.md and it is costing us money on boundary orders.

\`node --test test/*.test.js\` fails with a total that is off by a small amount. The failure does not tell you which rule is responsible — that is the job.

Find the offending rule and fix it.

Important: the other 299 rules are correct and are audited. Change ONLY the rule that is wrong — do not regenerate, reformat, or "tidy up" the file. A diff touching more than one rule will be rejected in review.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "pricing", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"RULES.md",
			`# Pricing rules

Each rule owns one tier and adds a percentage surcharge to orders in that tier.

## The threshold is exclusive

A rule's threshold is the amount the surcharge starts ABOVE. An order **at**
the threshold is not surcharged; an order one unit above it is. This is
deliberate — the thresholds are the top of each published band, and a customer
quoted the band price must not be charged more than the quote.

    amount  <  threshold   → no surcharge
    amount ===  threshold  → no surcharge   (the quoted band price)
    amount  >  threshold   → surcharge applies

## Surcharge

\`round(amount * rate) / 100\`, where \`rate\` is the rule's percentage. Rules
only apply to their own tier and return 0 for every other tier.
`,
		);

		const BROKEN = 187;
		const parts = ["/** Generated pricing rules. Do not hand-edit beyond fixing a defect. */\n"];
		for (let i = 0; i < 300; i++) parts.push(ruleSource(i, i === BROKEN));
		parts.push(`export const RULES = [${Array.from({ length: 300 }, (_, i) => `rule_${i}`).join(", ")}];\n`);
		write(dir, "src/rules.js", parts.join("\n"));

		write(
			dir,
			"src/price.js",
			`import { RULES } from "./rules.js";

/** Total surcharge for an order, across every rule. */
export function surcharge(order) {
	let total = 0;
	for (const rule of RULES) total += rule(order);
	return Math.round(total * 100) / 100;
}

/** Total surcharge for a batch of orders. */
export function batchSurcharge(orders) {
	let total = 0;
	for (const order of orders) total += surcharge(order);
	return Math.round(total * 100) / 100;
}
`,
		);

		write(
			dir,
			"src/orders.js",
			`/** The audited batch the finance team reconciles against. */
export function auditBatch() {
	const orders = [];
	for (let tier = 0; tier < 12; tier++) {
		for (let k = 0; k < 40; k++) {
			// Amounts land ON a band boundary as often as not — that is where the
			// disagreement shows up.
			const base = 100 + (tier + k * 12) * 7;
			orders.push({ tier, amount: base });
			orders.push({ tier, amount: base + 1 });
			orders.push({ tier, amount: base - 1 });
		}
	}
	return orders;
}
`,
		);

		write(
			dir,
			"test/price.test.js",
			`import test from "node:test";
import assert from "node:assert/strict";
import { batchSurcharge } from "../src/price.js";
import { auditBatch } from "../src/orders.js";

// Reconciled against the finance team's own model. If this number moves, a rule
// disagrees with RULES.md.
const EXPECTED = 8176464.69;

test("the audited batch totals what finance says it should", () => {
	assert.equal(batchSurcharge(auditBatch()), EXPECTED);
});
`,
		);
	},
	verify(dir) {
		const checks = [];

		const visible = runSuite(dir);
		checks.push({
			name: "the audited total reconciles",
			ok: visible.ok && /# fail 0/.test(visible.stdout),
			detail: `${visible.stdout}\n${visible.stderr}`.slice(-1000),
		});

		// The boundary, rule by rule: every rule must be exclusive at its threshold.
		const boundary = runHidden(
			dir,
			"hidden/boundary.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../src/rules.js";

test("every rule's threshold is exclusive", () => {
	const offenders = [];
	for (let i = 0; i < RULES.length; i++) {
		const tier = i % 12;
		const floor = 100 + i * 7;
		// At the threshold: no surcharge. One above: a surcharge.
		if (RULES[i]({ tier, amount: floor }) !== 0) offenders.push("rule_" + i + " fires AT its threshold");
		if (RULES[i]({ tier, amount: floor + 1 }) === 0) offenders.push("rule_" + i + " does not fire above its threshold");
	}
	assert.deepEqual(offenders, [], offenders.join("; "));
});

test("rules stay scoped to their own tier", () => {
	for (let i = 0; i < RULES.length; i += 17) {
		const wrongTier = (i % 12 === 0 ? 1 : 0);
		assert.equal(RULES[i]({ tier: wrongTier, amount: 10_000_000 }), 0, "rule_" + i + " leaked into tier " + wrongTier);
	}
});
`,
		);
		checks.push({
			name: `hidden: every threshold is exclusive (${boundary.pass}p/${boundary.fail}f)`,
			ok: boundary.fail === 0 && boundary.pass >= 2,
			detail: boundary.output.slice(-1500),
		});

		// The rate each rule charges must not have moved. A regenerated file with a
		// different rate table passes the boundary check and fails here.
		const rates = runHidden(
			dir,
			"hidden/rates.test.mjs",
			`import test from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../src/rules.js";

test("300 rules, each charging its documented rate", () => {
	assert.equal(RULES.length, 300, "the rule set changed size");
	const wrong = [];
	for (let i = 0; i < 300; i++) {
		const tier = i % 12;
		const floor = 100 + i * 7;
		const rate = ((i % 9) + 1) * 3;
		const amount = floor + 1000;
		const expected = Math.round(amount * rate) / 100;
		const got = RULES[i]({ tier, amount });
		if (got !== expected) wrong.push("rule_" + i + ": " + got + " != " + expected);
	}
	assert.deepEqual(wrong.slice(0, 5), [], wrong.length + " rules charge the wrong rate: " + wrong.slice(0, 5).join("; "));
});
`,
		);
		checks.push({
			name: `hidden: the other 299 rules are untouched (${rates.pass}p/${rates.fail}f)`,
			ok: rates.fail === 0 && rates.pass >= 1,
			detail: rates.output.slice(-1200),
		});

		// The diff discipline the prompt asked for: one rule changed, not the file.
		const src = read(dir, "src/rules.js");
		const bodies = new Map();
		for (const m of src.matchAll(/export function (rule_\d+)\(order\) \{([\s\S]*?)\n\}/g)) {
			bodies.set(m[1], m[2].replace(/\s+/g, " ").trim());
		}
		let changed = [];
		for (let i = 0; i < 300; i++) {
			const rate = ((i % 9) + 1) * 3;
			const floor = 100 + i * 7;
			const expected = `if (order.tier !== ${i % 12}) return 0; if (order.amount > ${floor}) { return Math.round(order.amount * ${rate}) / 100; } return 0;`;
			const got = bodies.get(`rule_${i}`);
			if (got !== expected) changed.push(`rule_${i}`);
		}
		checks.push({
			name: "only the defective rule was edited",
			ok: bodies.size === 300 && changed.length === 0,
			detail:
				bodies.size !== 300
					? `the file no longer defines 300 rules (found ${bodies.size}) — it was regenerated or reformatted`
					: changed.length
						? `${changed.length} rule(s) do not match the documented form: ${changed.slice(0, 6).join(", ")}`
						: "clean",
		});

		return checks;
	},
};

export const TASKS = [heisenbug, perfBisect, needleInHaystack];
export const TASK_IDS = TASKS.map((t) => t.id);
