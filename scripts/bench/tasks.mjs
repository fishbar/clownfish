/**
 * Benchmark tasks — five problems that separate a competent coding agent from a
 * plausible-looking one.
 *
 * Each task is self-contained and dependency-free (Node's built-in test runner
 * only), so a run needs no network beyond the model itself and no `npm install`
 * inside the scratch workspace.
 *
 * A task is `{ id, title, prompt, seed(dir), verify(dir) }`:
 *   - `seed`   writes the starting workspace,
 *   - `prompt` is the identical instruction given to BOTH agents,
 *   - `verify` runs HIDDEN checks the agent never saw, and returns a score.
 *
 * Hidden verification is the point: an agent that edits the visible tests to make
 * them pass scores zero, exactly as it should.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";

const write = (dir, rel, content) => {
	const file = join(dir, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};

/** Run a node script in the workspace; never throws. */
function run(dir, args, timeoutMs = 120_000) {
	try {
		const stdout = execFileSync(process.execPath, args, {
			cwd: dir,
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NODE_OPTIONS: "" },
		});
		return { ok: true, stdout, stderr: "" };
	} catch (e) {
		return { ok: false, stdout: e.stdout?.toString() ?? "", stderr: (e.stderr?.toString() ?? "") + (e.message ?? "") };
	}
}

/** Every .js/.mjs file under the workspace, excluding node_modules and hidden dirs. */
function sources(dir) {
	const out = [];
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (/\.(js|mjs)$/.test(entry.name)) out.push(p);
		}
	};
	walk(dir);
	return out;
}

/**
 * Test files under `sub/`, as paths relative to the workspace.
 *
 * `node --test <dir>` is NOT portable — on Node 24 a trailing directory is
 * resolved as a module and the run dies with MODULE_NOT_FOUND, which would score
 * a perfectly good solution as a failure. Always pass explicit files.
 */
function testFiles(dir, sub = "test") {
	const base = join(dir, sub);
	if (!existsSync(base)) return [];
	return sources(base).map((f) => relative(dir, f));
}

/** Run the workspace's own test suite. No files = a failure, not a pass. */
function runSuite(dir, sub = "test") {
	const files = testFiles(dir, sub);
	if (files.length === 0) return { ok: false, stdout: "no test files found", stderr: "" };
	return run(dir, ["--test", "--test-reporter=tap", ...files]);
}

/** A hidden test file is written, run, and the pass/fail count extracted. */
function runHidden(dir, rel, source) {
	write(dir, rel, source);
	// `--test-reporter=tap` is mandatory: Node 24 defaults to the "spec" reporter
	// even when piped, whose counts read `ℹ pass N` — parsing TAP against spec
	// output silently reports zero passes and fails every hidden check.
	const r = run(dir, ["--test", "--test-reporter=tap", rel]);
	const pass = Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
	const fail = Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
	return { pass, fail, ok: r.ok, output: `${r.stdout}\n${r.stderr}`.slice(-4000) };
}

// ---------------------------------------------------------------------------
// T1 — a concurrency bug that only shows under load
// ---------------------------------------------------------------------------

const t1 = {
	id: "async-queue",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 60_000, tokens: 60000, cost: 0.2 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "并发队列的竞态：修 bug 并补回归测试",
	prompt: `The task queue in src/queue.js is supposed to run at most \`limit\` tasks concurrently and resolve results in the same order the tasks were pushed. It does neither reliably under load, and test/queue.test.js fails.

Fix src/queue.js so that:
1. no more than \`limit\` tasks are ever in flight at once,
2. \`drain()\` resolves with results in push order,
3. a task that rejects does not stall the queue or lose the other results — \`drain()\` rejects with that error only after in-flight work settles.

Then add a regression test to test/queue.test.js that would have caught the concurrency violation. Run \`node --test\` until everything passes. Do not weaken or delete the existing assertions.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "async-queue", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"src/queue.js",
			`/** A concurrency-limited task queue. */
export class TaskQueue {
	constructor(limit = 4) {
		this.limit = limit;
		this.tasks = [];
		this.active = 0;
		this.results = [];
	}

	push(fn) {
		this.tasks.push(fn);
		return this;
	}

	async drain() {
		const runNext = async () => {
			const fn = this.tasks.shift();
			if (!fn) return;
			this.active++;
			// Slot accounting and result collection are both wrong here.
			this.active--;
			const value = await fn();
			this.results.push(value);
			await runNext();
		};
		const workers = [];
		for (let i = 0; i < this.limit; i++) workers.push(runNext());
		await Promise.all(workers);
		return this.results;
	}
}
`,
		);
		write(
			dir,
			"test/queue.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "../src/queue.js";

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test("results come back in push order", async () => {
	const q = new TaskQueue(3);
	q.push(() => delay(30, "a")).push(() => delay(5, "b")).push(() => delay(15, "c"));
	assert.deepEqual(await q.drain(), ["a", "b", "c"]);
});

test("a rejecting task surfaces its error", async () => {
	const q = new TaskQueue(2);
	q.push(() => delay(5, 1)).push(() => Promise.reject(new Error("boom")));
	await assert.rejects(() => q.drain(), /boom/);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const visible = runSuite(dir);
		checks.push({ name: "visible test suite passes", ok: visible.ok, detail: visible.stdout.slice(-500) });

		// The agent must not have gutted the provided assertions.
		const suite = existsSync(join(dir, "test/queue.test.js")) ? readFileSync(join(dir, "test/queue.test.js"), "utf8") : "";
		checks.push({ name: "the given assertions survive", ok: /push order/.test(suite) && /boom/.test(suite) });
		checks.push({ name: "a regression test was added", ok: suite.split(/\btest\(/).length - 1 >= 3 });

		const hidden = runHidden(
			dir,
			"hidden.concurrency.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskQueue } from "./src/queue.js";
const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test("never exceeds the limit under load", async () => {
	let live = 0, peak = 0;
	const q = new TaskQueue(3);
	for (let i = 0; i < 40; i++) {
		q.push(async () => {
			live++; peak = Math.max(peak, live);
			await delay(Math.floor(Math.random() * 8));
			live--;
			return i;
		});
	}
	const out = await q.drain();
	assert.equal(peak <= 3, true, "peak concurrency " + peak + " > 3");
	assert.deepEqual(out, Array.from({ length: 40 }, (_, i) => i));
});

test("uses the slots it is given", async () => {
	let live = 0, peak = 0;
	const q = new TaskQueue(5);
	for (let i = 0; i < 20; i++) q.push(async () => { live++; peak = Math.max(peak, live); await delay(20); live--; return i; });
	await q.drain();
	assert.equal(peak > 1, true, "queue ran serially (peak " + peak + ")");
});

test("a rejection does not lose the other work", async () => {
	const done = [];
	const q = new TaskQueue(2);
	q.push(async () => { await delay(20); done.push("a"); return "a"; });
	q.push(async () => { await delay(5); throw new Error("boom"); });
	q.push(async () => { await delay(10); done.push("c"); return "c"; });
	await assert.rejects(() => q.drain(), /boom/);
	await delay(60);
	assert.equal(done.includes("a"), true, "in-flight task was abandoned");
});
`,
		);
		checks.push({ name: "hidden: concurrency limit respected", ok: hidden.fail === 0 && hidden.pass >= 3, detail: hidden.output.slice(-800) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// T2 — an algorithmic hot spot, with a hard runtime budget
// ---------------------------------------------------------------------------

const t2 = {
	id: "hot-path",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 110_000, tokens: 130000, cost: 0.4 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 3,
	title: "性能热点：O(n²) 改造，且不能改坏语义",
	prompt: `\`topSessions(events, k)\` in src/analyze.js is correct but far too slow: bench/bench.mjs times it over 200k events and currently takes many seconds.

Make \`node bench/bench.mjs\` report a duration under 400 ms while keeping the function's behaviour EXACTLY the same, including its tie-breaking rule (equal totals order by session id ascending) and its handling of malformed events. \`node --test test/*.test.js\` must stay green.

Do not change the benchmark's parameters, do not cache results across calls, and do not weaken the tests.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "hot-path", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"src/analyze.js",
			`/**
 * Aggregate event durations per session and return the top-k sessions.
 * Ties on total duration are broken by session id, ascending.
 * Events missing a session id, or with a non-finite duration, are ignored.
 */
export function topSessions(events, k) {
	const ids = [];
	for (const e of events) {
		if (!e || typeof e.session !== "string" || !Number.isFinite(e.duration)) continue;
		if (!ids.includes(e.session)) ids.push(e.session);
	}
	const totals = [];
	for (const id of ids) {
		let total = 0;
		for (const e of events) {
			if (!e || typeof e.session !== "string" || !Number.isFinite(e.duration)) continue;
			if (e.session === id) total += e.duration;
		}
		totals.push({ session: id, total });
	}
	totals.sort((a, b) => (b.total - a.total) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
	return totals.slice(0, k);
}
`,
		);
		write(
			dir,
			"bench/bench.mjs",
			`import { topSessions } from "../src/analyze.js";

const N = 200_000;
const SESSIONS = 2_000;
const events = [];
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let i = 0; i < N; i++) {
	events.push({ session: "s" + Math.floor(rnd() * SESSIONS), duration: Math.floor(rnd() * 1000) });
}
events.push({ session: "s1", duration: NaN }, null, { duration: 5 });

const started = performance.now();
const top = topSessions(events, 10);
const ms = performance.now() - started;
console.log("top:", JSON.stringify(top));
console.log("duration_ms:", ms.toFixed(1));
`,
		);
		write(
			dir,
			"test/analyze.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { topSessions } from "../src/analyze.js";

test("aggregates per session", () => {
	const out = topSessions([
		{ session: "a", duration: 5 },
		{ session: "b", duration: 3 },
		{ session: "a", duration: 1 },
	], 2);
	assert.deepEqual(out, [{ session: "a", total: 6 }, { session: "b", total: 3 }]);
});

test("skips malformed events", () => {
	const out = topSessions([null, { duration: 4 }, { session: "a", duration: NaN }, { session: "a", duration: 2 }], 5);
	assert.deepEqual(out, [{ session: "a", total: 2 }]);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const tests = runSuite(dir);
		checks.push({ name: "visible tests stay green", ok: tests.ok, detail: tests.stdout.slice(-400) });

		const bench = run(dir, ["bench/bench.mjs"], 180_000);
		const ms = Number(/duration_ms:\s*([\d.]+)/.exec(bench.stdout)?.[1] ?? Infinity);
		checks.push({ name: `benchmark under 400ms (got ${Number.isFinite(ms) ? ms.toFixed(0) + "ms" : "n/a"})`, ok: bench.ok && ms < 400, detail: bench.stdout.slice(-300) + bench.stderr.slice(-300) });

		const benchSrc = existsSync(join(dir, "bench/bench.mjs")) ? readFileSync(join(dir, "bench/bench.mjs"), "utf8") : "";
		checks.push({ name: "the benchmark itself was not tampered with", ok: /const N = 200_000;/.test(benchSrc) && /SESSIONS = 2_000/.test(benchSrc) });

		const hidden = runHidden(
			dir,
			"hidden.analyze.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { topSessions } from "./src/analyze.js";

test("ties break by session id ascending", () => {
	const out = topSessions([
		{ session: "b", duration: 5 },
		{ session: "a", duration: 5 },
		{ session: "c", duration: 9 },
	], 3);
	assert.deepEqual(out, [{ session: "c", total: 9 }, { session: "a", total: 5 }, { session: "b", total: 5 }]);
});

test("k larger than the population is fine", () => {
	assert.equal(topSessions([{ session: "a", duration: 1 }], 50).length, 1);
});

test("empty input yields an empty list", () => {
	assert.deepEqual(topSessions([], 3), []);
});

test("negative and zero durations still aggregate", () => {
	assert.deepEqual(topSessions([{ session: "a", duration: -5 }, { session: "a", duration: 5 }, { session: "b", duration: 0 }], 2),
		[{ session: "a", total: 0 }, { session: "b", total: 0 }]);
});

test("no cross-call caching", () => {
	const first = topSessions([{ session: "a", duration: 1 }], 1);
	const second = topSessions([{ session: "a", duration: 2 }], 1);
	assert.deepEqual(second, [{ session: "a", total: 2 }]);
	assert.deepEqual(first, [{ session: "a", total: 1 }]);
});
`,
		);
		checks.push({ name: "hidden: semantics preserved", ok: hidden.fail === 0 && hidden.pass >= 5, detail: hidden.output.slice(-800) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// T3 — break up a god module without moving the public API
// ---------------------------------------------------------------------------

const t3 = {
	id: "god-module",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 160_000, tokens: 200000, cost: 0.75 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "重构：拆掉巨型模块，公共 API 一字不变",
	prompt: `src/report.js has grown into a 300-line module mixing parsing, validation, formatting and statistics. Split it into focused modules under src/ (one concern each), keeping src/report.js as the entry point that re-exports the SAME public API with identical behaviour.

Constraints:
- no source file under src/ may exceed 120 lines,
- there must be at least four modules under src/,
- \`node --test test/*.test.js\` stays green,
- the exported names and their behaviour do not change — callers importing from src/report.js must not notice.

Delete what the split makes redundant; do not leave the old implementation behind as dead code.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "god-module", type: "module", private: true }, null, 2) + "\n");
		const body = `/** Everything about turning raw rows into a report. All of it. In one file. */

const FIELDS = ["id", "name", "team", "score", "at"];

export function parseRow(line) {
	if (typeof line !== "string") throw new TypeError("row must be a string");
	const cells = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
			else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") { cells.push(cur); cur = ""; }
		else cur += ch;
	}
	cells.push(cur);
	const row = {};
	FIELDS.forEach((f, i) => { row[f] = cells[i] ?? ""; });
	row.score = Number(row.score);
	return row;
}

export function validateRow(row) {
	const errors = [];
	if (!row.id) errors.push("id is required");
	if (!row.name) errors.push("name is required");
	if (!Number.isFinite(row.score)) errors.push("score must be numeric");
	if (row.score < 0 || row.score > 100) errors.push("score out of range");
	if (row.at && Number.isNaN(Date.parse(row.at))) errors.push("at is not a date");
	return errors;
}

export function parseAll(text) {
	const rows = [];
	const errors = [];
	const lines = String(text).split(/\\r?\\n/).filter((l) => l.trim().length > 0);
	for (const [i, line] of lines.entries()) {
		let row;
		try { row = parseRow(line); } catch (e) { errors.push({ line: i + 1, errors: [e.message] }); continue; }
		const rowErrors = validateRow(row);
		if (rowErrors.length) errors.push({ line: i + 1, errors: rowErrors });
		else rows.push(row);
	}
	return { rows, errors };
}

export function mean(values) {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stddev(values) {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

export function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

export function byTeam(rows) {
	const map = new Map();
	for (const row of rows) {
		const team = row.team || "(none)";
		if (!map.has(team)) map.set(team, []);
		map.get(team).push(row);
	}
	return map;
}

export function teamStats(rows) {
	const out = [];
	for (const [team, members] of byTeam(rows)) {
		const scores = members.map((m) => m.score);
		out.push({
			team,
			count: members.length,
			mean: round(mean(scores), 2),
			median: round(median(scores), 2),
			stddev: round(stddev(scores), 2),
			p90: round(percentile(scores, 90), 2),
		});
	}
	out.sort((a, b) => b.mean - a.mean || (a.team < b.team ? -1 : 1));
	return out;
}

export function round(value, digits) {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

export function padRight(value, width) {
	const s = String(value);
	return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

export function padLeft(value, width) {
	const s = String(value);
	return s.length >= width ? s.slice(0, width) : " ".repeat(width - s.length) + s;
}

export function formatTable(stats) {
	const header = padRight("TEAM", 12) + padLeft("N", 5) + padLeft("MEAN", 9) + padLeft("MEDIAN", 9) + padLeft("STDDEV", 9) + padLeft("P90", 9);
	const rule = "-".repeat(header.length);
	const lines = [header, rule];
	for (const s of stats) {
		lines.push(padRight(s.team, 12) + padLeft(s.count, 5) + padLeft(s.mean.toFixed(2), 9) + padLeft(s.median.toFixed(2), 9) + padLeft(s.stddev.toFixed(2), 9) + padLeft(s.p90.toFixed(2), 9));
	}
	return lines.join("\\n");
}

export function formatErrors(errors) {
	if (errors.length === 0) return "no errors";
	return errors.map((e) => "line " + e.line + ": " + e.errors.join("; ")).join("\\n");
}

export function buildReport(text) {
	const { rows, errors } = parseAll(text);
	const stats = teamStats(rows);
	return {
		rows,
		errors,
		stats,
		text: formatTable(stats) + "\\n\\n" + formatErrors(errors),
	};
}
`;
		write(dir, "src/report.js", body);
		write(
			dir,
			"test/report.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, parseRow, teamStats, formatTable } from "../src/report.js";

const CSV = [
	'1,Ada,core,91,2024-01-01',
	'2,"Grace, R.",core,88,2024-01-02',
	'3,Alan,tools,73,2024-01-03',
	'4,Bad,tools,not-a-number,2024-01-04',
].join("\\n");

test("parses quoted cells", () => {
	assert.equal(parseRow('2,"Grace, R.",core,88,x').name, "Grace, R.");
});

test("builds a report with stats and errors", () => {
	const r = buildReport(CSV);
	assert.equal(r.rows.length, 3);
	assert.equal(r.errors.length, 1);
	assert.equal(r.stats[0].team, "core");
	assert.match(r.text, /TEAM/);
});

test("team stats are sorted by mean desc", () => {
	const stats = teamStats([{ team: "a", score: 10 }, { team: "b", score: 90 }]);
	assert.equal(stats[0].team, "b");
	assert.match(formatTable(stats), /b/);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const tests = runSuite(dir);
		checks.push({ name: "visible tests stay green", ok: tests.ok, detail: tests.stdout.slice(-400) });

		const srcFiles = sources(join(dir, "src"));
		checks.push({ name: `at least four modules under src/ (got ${srcFiles.length})`, ok: srcFiles.length >= 4 });
		const tooLong = srcFiles.filter((f) => readFileSync(f, "utf8").split("\n").length > 120).map((f) => relative(dir, f));
		checks.push({ name: "no src file over 120 lines", ok: tooLong.length === 0, detail: tooLong.join(", ") });

		const hidden = runHidden(
			dir,
			"hidden.api.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "./src/report.js";

const NAMES = ["parseRow","validateRow","parseAll","mean","median","stddev","percentile","byTeam","teamStats","round","padRight","padLeft","formatTable","formatErrors","buildReport"];

test("the whole public API is still exported from the entry point", () => {
	for (const n of NAMES) assert.equal(typeof api[n], "function", "missing export: " + n);
});

test("behaviour is unchanged", () => {
	assert.deepEqual(api.validateRow({ id: "", name: "x", score: 200 }), ["id is required", "score out of range"]);
	assert.equal(api.median([3, 1, 2]), 2);
	assert.equal(api.median([4, 1, 2, 3]), 2.5);
	assert.equal(api.percentile([1,2,3,4,5,6,7,8,9,10], 90), 9);
	assert.equal(api.round(1.005, 2), 1);
	assert.equal(api.padLeft("x", 3), "  x");
	assert.equal(api.padRight("abcdef", 3), "abc");
	assert.equal(api.stddev([2,4,4,4,5,5,7,9]).toFixed(4), "2.1381");
	assert.equal(api.parseRow('1,"a""b",t,5,x').name, 'a"b');
	assert.equal(api.byTeam([{team:"",score:1}]).has("(none)"), true);
});

test("the entry point is a facade, not the implementation", async () => {
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("./src/report.js", import.meta.url), "utf8");
	assert.equal(src.split("\\n").length < 60, true, "src/report.js still holds the implementation");
});
`,
		);
		checks.push({ name: "hidden: public API + behaviour identical", ok: hidden.fail === 0 && hidden.pass >= 3, detail: hidden.output.slice(-900) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// T4 — an ops problem: a repo that simply will not run
// ---------------------------------------------------------------------------

const t4 = {
	id: "broken-repo",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 70_000, tokens: 110000, cost: 0.4 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "运维排障：让这个仓库重新跑起来",
	prompt: `\`npm test\` fails in this repository. Make it pass.

There is more than one thing wrong, and they are not all in the same kind of file — look at how the package is declared, how the modules import each other, and what the scripts actually run.

Rules: do not modify anything under test/, do not delete tests, and do not change what the code is supposed to do. Fixing it means the existing tests pass against working source, not that the tests were made to disappear.`,
	seed(dir) {
		// No "type": "module" while the sources are ESM; the test script points at a
		// directory that does not exist; one import lacks its extension; one file
		// uses CommonJS inside the ESM graph.
		write(
			dir,
			"package.json",
			JSON.stringify({ name: "broken-repo", private: true, scripts: { test: "node --test tests/" } }, null, 2) + "\n",
		);
		write(
			dir,
			"src/index.js",
			`import { slugify } from "./slug";
import { titleCase } from "./title.js";

export function makeHeading(text) {
	return { title: titleCase(text), slug: slugify(text) };
}
`,
		);
		write(
			dir,
			"src/slug.js",
			`export function slugify(text) {
	return String(text)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
`,
		);
		write(
			dir,
			"src/title.js",
			`const SMALL = new Set(["a", "an", "the", "of", "and", "or"]);

function titleCase(text) {
	return String(text)
		.split(/\\s+/)
		.filter(Boolean)
		.map((word, i) => (i > 0 && SMALL.has(word.toLowerCase()) ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
		.join(" ");
}

module.exports = { titleCase };
`,
		);
		write(
			dir,
			"test/heading.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHeading } from "../src/index.js";

test("builds a heading", () => {
	assert.deepEqual(makeHeading("The Rise of the Machines"), {
		title: "The Rise of the Machines",
		slug: "the-rise-of-the-machines",
	});
});

test("small words stay lowercase except the first", () => {
	assert.equal(makeHeading("a tale of two cities").title, "A Tale of Two Cities");
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const npmTest = (() => {
			try {
				const stdout = execFileSync("npm", ["test", "--silent"], { cwd: dir, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
				return { ok: true, out: stdout };
			} catch (e) {
				return { ok: false, out: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "") };
			}
		})();
		checks.push({ name: "`npm test` exits 0", ok: npmTest.ok, detail: npmTest.out.slice(-800) });

		const testFile = existsSync(join(dir, "test/heading.test.js"))
			? readFileSync(join(dir, "test/heading.test.js"), "utf8")
			: existsSync(join(dir, "tests/heading.test.js"))
				? readFileSync(join(dir, "tests/heading.test.js"), "utf8")
				: "";
		checks.push({ name: "the tests were not rewritten", ok: /the-rise-of-the-machines/.test(testFile) && /A Tale of Two Cities/.test(testFile) });

		const hidden = runHidden(
			dir,
			"hidden.heading.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHeading } from "./src/index.js";

test("still behaves as specified", () => {
	assert.deepEqual(makeHeading("  hello   WORLD  "), { title: "Hello World", slug: "hello-world" });
	assert.equal(makeHeading("Tools & Toys").slug, "tools-toys");
	// "of" is in the module's small-word set; "to" deliberately is not — asserting
	// otherwise would demand behaviour the original code never had.
	assert.equal(makeHeading("an ode of joy").title, "An Ode of Joy");
	assert.equal(makeHeading("war and peace").title, "War and Peace");
});
`,
		);
		checks.push({ name: "hidden: behaviour intact", ok: hidden.fail === 0 && hidden.pass >= 1, detail: hidden.output.slice(-600) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// T5 — implement a spec against tests the agent never sees
// ---------------------------------------------------------------------------

const t5 = {
	id: "semver-range",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 430_000, tokens: 360000, cost: 1.9 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "按规格实现：semver 区间匹配（隐藏测试）",
	prompt: `Implement \`satisfies(version, range)\` in src/range.js according to SPEC.md. The stub currently throws.

SPEC.md is the contract; read it carefully — the edge cases in it are the point of the exercise, especially prerelease handling. There is a small visible test suite in test/range.test.js, but it covers only a fraction of the spec: you will be graded by a hidden suite derived from SPEC.md, so test yourself beyond what is given.

Do not add dependencies — this must be plain JavaScript with no imports.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "semver-range", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"SPEC.md",
			`# satisfies(version, range)

\`version\` is a semver string \`MAJOR.MINOR.PATCH\` with an optional \`-prerelease\`
(dot-separated identifiers). Build metadata (\`+build\`) is ignored entirely.
Return \`true\` when the version satisfies the range, \`false\` otherwise. An
unparseable version returns \`false\`; an unparseable range throws \`TypeError\`.

## Range grammar

- Comparator sets are separated by \`||\` (logical OR). A version satisfies the
  range if it satisfies ANY set.
- Within a set, comparators are separated by whitespace and ALL must hold.
- A comparator is \`<op><partial-version>\` where \`op\` is one of
  \`=\`, \`<\`, \`<=\`, \`>\`, \`>=\`, \`^\`, \`~\`, or absent (meaning \`=\`).
- A partial version may omit minor/patch, or use \`x\`/\`X\`/\`*\` as a wildcard:
  \`1.2\` and \`1.2.x\` both mean \`>=1.2.0 <1.3.0\`; \`1\` and \`1.x\` mean \`>=1.0.0 <2.0.0\`;
  \`*\` alone means "any version".
- \`^1.2.3\` allows changes that do not modify the left-most non-zero element:
  \`^1.2.3\` → \`>=1.2.3 <2.0.0\`; \`^0.2.3\` → \`>=0.2.3 <0.3.0\`; \`^0.0.3\` → \`>=0.0.3 <0.0.4\`.
- \`~1.2.3\` → \`>=1.2.3 <1.3.0\`; \`~1.2\` → \`>=1.2.0 <1.3.0\`; \`~1\` → \`>=1.0.0 <2.0.0\`.
- A hyphen range \`1.2.3 - 2.3.4\` means \`>=1.2.3 <=2.3.4\`. If the upper bound is
  partial, it is inclusive of that whole range: \`1.2.3 - 2.3\` means \`>=1.2.3 <2.4.0\`.

## Precedence

Numeric identifiers compare numerically; a version WITH a prerelease is lower
than the same version without one. Prerelease identifiers compare left to right:
numeric identifiers compare numerically and rank below alphanumeric ones, which
compare in ASCII order; a longer prerelease outranks its own prefix
(\`1.0.0-alpha\` < \`1.0.0-alpha.1\`).

## Prerelease rule

A version with a prerelease may only satisfy a comparator set if at least one
comparator in that set mentions a version with a prerelease AND has the same
\`MAJOR.MINOR.PATCH\` tuple. So \`1.2.3-alpha\` satisfies \`>=1.2.3-alpha <2.0.0\` but
NOT \`>=1.0.0\`, and \`1.2.4-alpha\` does not satisfy \`>=1.2.3-alpha\`.
`,
		);
		write(
			dir,
			"src/range.js",
			`/** See SPEC.md. */
export function satisfies(version, range) {
	throw new Error("not implemented");
}
`,
		);
		write(
			dir,
			"test/range.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { satisfies } from "../src/range.js";

test("caret basics", () => {
	assert.equal(satisfies("1.2.4", "^1.2.3"), true);
	assert.equal(satisfies("2.0.0", "^1.2.3"), false);
});

test("or-ranges", () => {
	assert.equal(satisfies("3.0.0", "^1.0.0 || ^3.0.0"), true);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const visible = runSuite(dir);
		checks.push({ name: "visible tests pass", ok: visible.ok, detail: visible.stdout.slice(-300) });
		const src = existsSync(join(dir, "src/range.js")) ? readFileSync(join(dir, "src/range.js"), "utf8") : "";
		checks.push({ name: "no dependencies pulled in", ok: !/from ["']\w/.test(src) && !existsSync(join(dir, "node_modules")) });

		const hidden = runHidden(
			dir,
			"hidden.range.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { satisfies } from "./src/range.js";
const yes = (v, r) => assert.equal(satisfies(v, r), true, v + " should satisfy " + r);
const no = (v, r) => assert.equal(satisfies(v, r), false, v + " should NOT satisfy " + r);

test("comparators", () => {
	yes("1.2.3", "1.2.3"); yes("1.2.3", "=1.2.3"); no("1.2.4", "1.2.3");
	yes("1.2.4", ">1.2.3"); no("1.2.3", ">1.2.3"); yes("1.2.3", ">=1.2.3");
	yes("1.2.2", "<1.2.3"); yes("1.2.3", "<=1.2.3"); no("1.2.4", "<=1.2.3");
	yes("1.2.5", ">1.2.3 <1.3.0"); no("1.3.0", ">1.2.3 <1.3.0");
});

test("wildcards and partials", () => {
	yes("1.2.9", "1.2"); no("1.3.0", "1.2"); yes("1.2.9", "1.2.x"); yes("1.9.9", "1"); no("2.0.0", "1.x");
	yes("9.9.9", "*"); yes("0.0.1", "*");
});

test("caret and tilde", () => {
	yes("1.9.9", "^1.2.3"); no("1.2.2", "^1.2.3");
	yes("0.2.9", "^0.2.3"); no("0.3.0", "^0.2.3");
	yes("0.0.3", "^0.0.3"); no("0.0.4", "^0.0.3");
	yes("1.2.9", "~1.2.3"); no("1.3.0", "~1.2.3");
	yes("1.2.0", "~1.2"); no("1.3.0", "~1.2"); yes("1.9.9", "~1");
});

test("hyphen ranges", () => {
	yes("2.3.4", "1.2.3 - 2.3.4"); no("2.3.5", "1.2.3 - 2.3.4"); yes("1.2.3", "1.2.3 - 2.3.4");
	yes("2.3.9", "1.2.3 - 2.3"); no("2.4.0", "1.2.3 - 2.3");
});

test("precedence", () => {
	yes("1.0.0", ">1.0.0-alpha.1 <2.0.0 || 1.0.0");
	no("1.0.0-alpha", ">=1.0.0");
	yes("1.0.0-alpha.1", ">=1.0.0-alpha <2.0.0");
	no("1.0.0-alpha", ">=1.0.0-alpha.1 <2.0.0");
	no("1.2.4-alpha", ">=1.2.3-alpha");
	yes("1.2.3-beta", ">=1.2.3-alpha <1.2.3");
});

test("build metadata is ignored", () => { yes("1.2.3+build.9", "1.2.3"); });

test("bad input", () => {
	no("not-a-version", "^1.0.0");
	assert.throws(() => satisfies("1.0.0", "^^1"), TypeError);
});
`,
		);
		checks.push({ name: `hidden: spec conformance (${hidden.pass} passed / ${hidden.fail} failed)`, ok: hidden.fail === 0 && hidden.pass >= 7, detail: hidden.output.slice(-1200) });
		// Partial credit is meaningful here — record the ratio for the report.
		checks.push({ name: "hidden: majority of spec groups pass", ok: hidden.pass >= 5, detail: `${hidden.pass}/${hidden.pass + hidden.fail}` });
		return checks;
	},
};

export const TASKS = [t1, t2, t3, t4, t5];
export const TASK_IDS = TASKS.map((t) => t.id);
