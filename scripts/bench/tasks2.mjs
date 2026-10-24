/**
 * Phase-2 tasks — modelled on the public benchmark families that matter for a
 * coding agent, rebuilt locally so they run offline and score objectively.
 *
 *   swe-patch    ← SWE-bench style: a bug report + a failing test in existing code
 *   terminal-ops ← Terminal-Bench style: recover a broken environment from the CLI
 *   polyglot     ← Aider polyglot style: the same spec in two languages
 *   security-fix ← SEC-bench style: close real vulnerabilities without regressions
 *
 * Same contract as tasks.mjs, so the runner treats both suites identically.
 * Difficulty target: mid-to-hard — each one has a trap that a plausible-looking
 * patch falls into.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";

const write = (dir, rel, content) => {
	const file = join(dir, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};

function exec(cmd, args, dir, timeoutMs = 120_000) {
	try {
		const stdout = execFileSync(cmd, args, { cwd: dir, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, stdout, stderr: "" };
	} catch (e) {
		return { ok: false, stdout: e.stdout?.toString() ?? "", stderr: (e.stderr?.toString() ?? "") + (e.message ?? "") };
	}
}
const node = (dir, args, t) => exec(process.execPath, args, dir, t);

function sources(dir, exts = /\.(js|mjs)$/) {
	const out = [];
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (exts.test(entry.name)) out.push(p);
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

function runHidden(dir, rel, source) {
	write(dir, rel, source);
	// See the note in tasks.mjs: the reporter must be pinned to TAP.
	const r = node(dir, ["--test", "--test-reporter=tap", rel]);
	const pass = Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
	const fail = Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
	return { pass, fail, ok: r.ok, output: `${r.stdout}\n${r.stderr}`.slice(-4000) };
}

function runSuite(dir, sub = "test") {
	const files = sources(join(dir, sub)).map((f) => relative(dir, f));
	if (files.length === 0) return { ok: false, stdout: "no test files found", stderr: "" };
	return node(dir, ["--test", "--test-reporter=tap", ...files]);
}

// ---------------------------------------------------------------------------
// P1 — SWE-bench shape: an issue report, a failing test, interacting features
// ---------------------------------------------------------------------------

const swePatch = {
	id: "swe-patch",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 60_000, tokens: 60000, cost: 0.25 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "SWE 式补丁：三个特性交互处的状态机缺陷",
	prompt: `ISSUE.md describes a bug reported against src/scheduler.js. test/repro.test.js reproduces it and currently fails.

Fix the library so the reported behaviour is correct. The existing test suite in test/scheduler.test.js must keep passing — the features it covers (retries, priorities, cancellation) interact, and a fix that satisfies the repro by breaking one of them is not a fix.

Do not change the tests. Explain in your final message what the root cause was.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "scheduler", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"ISSUE.md",
			`# Cancelled jobs come back from the dead

When a job is cancelled **while it is waiting to be retried**, it still runs.

Steps:
1. submit a job that always throws, with \`retries: 2\`
2. wait for the first attempt to fail (the job is now scheduled for retry)
3. call \`cancel(id)\`
4. run the scheduler to completion

Expected: the job never attempts again and \`results\` reports it as \`cancelled\`.
Actual: it attempts again (sometimes twice) and reports \`failed\`.

We also noticed that when this happens, a *higher priority* job submitted after
the cancellation can be starved behind the zombie retries.
`,
		);
		write(
			dir,
			"src/scheduler.js",
			`/**
 * A tiny priority scheduler with retries and cancellation.
 * Higher \`priority\` runs first; ties run in submission order.
 */
export class Scheduler {
	constructor() {
		this.queue = [];
		this.cancelled = new Set();
		this.results = new Map();
		this.seq = 0;
	}

	submit(id, fn, { priority = 0, retries = 0 } = {}) {
		this.queue.push({ id, fn, priority, retries, attempts: 0, seq: this.seq++ });
		return id;
	}

	cancel(id) {
		this.cancelled.add(id);
	}

	#next() {
		if (this.queue.length === 0) return undefined;
		let best = 0;
		for (let i = 1; i < this.queue.length; i++) {
			const a = this.queue[i];
			const b = this.queue[best];
			if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
		}
		return this.queue.splice(best, 1)[0];
	}

	async run() {
		while (this.queue.length > 0) {
			const job = this.#next();
			if (this.cancelled.has(job.id) && job.attempts === 0) {
				this.results.set(job.id, { status: "cancelled", attempts: job.attempts });
				continue;
			}
			job.attempts++;
			try {
				const value = await job.fn(job.attempts);
				this.results.set(job.id, { status: "ok", value, attempts: job.attempts });
			} catch (err) {
				if (job.attempts <= job.retries) {
					// Re-queue for another attempt.
					this.queue.push({ ...job, seq: this.seq++ });
				} else {
					this.results.set(job.id, { status: "failed", error: String(err.message), attempts: job.attempts });
				}
			}
		}
		return this.results;
	}
}
`,
		);
		write(
			dir,
			"test/scheduler.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";

test("higher priority runs first", async () => {
	const order = [];
	const s = new Scheduler();
	s.submit("low", async () => order.push("low"), { priority: 1 });
	s.submit("high", async () => order.push("high"), { priority: 9 });
	await s.run();
	assert.deepEqual(order, ["high", "low"]);
});

test("retries until success", async () => {
	const s = new Scheduler();
	s.submit("flaky", async (attempt) => {
		if (attempt < 3) throw new Error("nope");
		return "ok-" + attempt;
	}, { retries: 5 });
	const r = await s.run();
	assert.deepEqual(r.get("flaky"), { status: "ok", value: "ok-3", attempts: 3 });
});

test("gives up after the retry budget", async () => {
	const s = new Scheduler();
	s.submit("doomed", async () => { throw new Error("always"); }, { retries: 1 });
	const r = await s.run();
	assert.equal(r.get("doomed").status, "failed");
	assert.equal(r.get("doomed").attempts, 2);
});

test("cancelling before the first attempt skips it", async () => {
	const s = new Scheduler();
	let ran = false;
	s.submit("x", async () => { ran = true; });
	s.cancel("x");
	const r = await s.run();
	assert.equal(ran, false);
	assert.equal(r.get("x").status, "cancelled");
});
`,
		);
		write(
			dir,
			"test/repro.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";

test("cancelling during the retry backlog stops the job", async () => {
	const s = new Scheduler();
	let attempts = 0;
	s.submit("zombie", async () => {
		attempts++;
		if (attempts === 1) s.cancel("zombie");
		throw new Error("boom");
	}, { retries: 2 });
	const r = await s.run();
	assert.equal(attempts, 1, "job attempted again after cancellation");
	assert.equal(r.get("zombie").status, "cancelled");
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const suite = runSuite(dir);
		checks.push({ name: "repro + existing suite both pass", ok: suite.ok, detail: suite.stdout.slice(-600) });
		const testsUntouched = ["test/scheduler.test.js", "test/repro.test.js"].every(
			(f) => existsSync(join(dir, f)) && /assert/.test(readFileSync(join(dir, f), "utf8")),
		);
		checks.push({ name: "tests were not rewritten", ok: testsUntouched });
		const hidden = runHidden(
			dir,
			"hidden.scheduler.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "./src/scheduler.js";

test("a cancelled job never starves a later high-priority one", async () => {
	const order = [];
	const s = new Scheduler();
	s.submit("z", async () => { s.cancel("z"); order.push("z"); throw new Error("x"); }, { retries: 3, priority: 5 });
	s.submit("urgent", async () => { order.push("urgent"); }, { priority: 9 });
	const r = await s.run();
	assert.deepEqual(order, ["urgent", "z"]);
	assert.equal(r.get("z").status, "cancelled");
	assert.equal(r.get("urgent").status, "ok");
});

test("cancellation records the attempts actually made", async () => {
	const s = new Scheduler();
	let n = 0;
	s.submit("j", async () => { n++; if (n === 2) s.cancel("j"); throw new Error("e"); }, { retries: 5 });
	const r = await s.run();
	assert.equal(n, 2);
	assert.equal(r.get("j").status, "cancelled");
	assert.equal(r.get("j").attempts, 2);
});

test("retry order still respects priority and submission order", async () => {
	const order = [];
	const s = new Scheduler();
	s.submit("a", async (att) => { order.push("a" + att); if (att < 2) throw new Error("r"); }, { retries: 2, priority: 1 });
	s.submit("b", async () => { order.push("b"); }, { priority: 1 });
	await s.run();
	assert.deepEqual(order, ["a1", "b", "a2"]);
});

test("an uncancelled failure is unaffected", async () => {
	const s = new Scheduler();
	s.submit("f", async () => { throw new Error("always"); }, { retries: 2 });
	const r = await s.run();
	assert.equal(r.get("f").status, "failed");
	assert.equal(r.get("f").attempts, 3);
});
`,
		);
		checks.push({ name: `hidden: interactions intact (${hidden.pass}p/${hidden.fail}f)`, ok: hidden.fail === 0 && hidden.pass >= 4, detail: hidden.output.slice(-1000) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// P2 — Terminal-Bench shape: a wrecked working environment, recovered from the CLI
// ---------------------------------------------------------------------------

const terminalOps = {
	id: "terminal-ops",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 75_000, tokens: 60000, cost: 0.25 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 0,
	title: "终端运维：从 reflog 里救回丢失的提交并修好构建",
	prompt: `This repository is in a mess and \`./run.sh\` does not work.

Two things need to be true when you are done:
1. \`./run.sh\` prints the report and exits 0.
2. The file \`src/pricing.js\` contains the "discount tiers" implementation that was committed and then lost — someone reset the branch and the work is no longer in the working tree. Recover the real committed content; do not rewrite it from scratch.

You have the whole toolbox: git, the shell, the file system. Leave the repository on a branch with the recovered work in its history.`,
	seed(dir) {
		const git = (...args) => exec("git", args, dir);
		write(dir, "package.json", JSON.stringify({ name: "pricing", type: "module", private: true }, null, 2) + "\n");
		write(dir, "src/pricing.js", "export function priceFor() {\n\tthrow new Error('not implemented');\n}\n");
		write(dir, "src/report.js", `import { priceFor } from "./pricing.js";

const CART = [
	{ sku: "a", qty: 1, unit: 100 },
	{ sku: "b", qty: 12, unit: 25 },
	{ sku: "c", qty: 120, unit: 5 },
];

export function report() {
	const lines = CART.map((i) => i.sku + " x" + i.qty + " = " + priceFor(i.qty, i.unit));
	const total = CART.reduce((s, i) => s + priceFor(i.qty, i.unit), 0);
	return lines.join("\\n") + "\\ntotal = " + total;
}
`);
		write(dir, "run.sh", "#!/bin/sh\nnode -e \"import('./src/report.js').then(m=>console.log(m.report()))\"\n");
		git("init", "-q");
		git("config", "user.email", "bench@example.com");
		git("config", "user.name", "bench");
		git("add", "-A");
		git("commit", "-qm", "initial");
		// The real work, committed…
		write(
			dir,
			"src/pricing.js",
			`/** Discount tiers: 10+ units 5% off, 100+ units 12% off. Prices are integers (cents). */
const TIERS = [
	{ min: 100, discount: 0.12 },
	{ min: 10, discount: 0.05 },
];

export function discountFor(qty) {
	for (const tier of TIERS) if (qty >= tier.min) return tier.discount;
	return 0;
}

export function priceFor(qty, unit) {
	const gross = qty * unit;
	return Math.round(gross * (1 - discountFor(qty)));
}
`,
		);
		exec("git", ["add", "-A"], dir);
		exec("git", ["commit", "-qm", "feat: discount tiers"], dir);
		// …and then thrown away by a hard reset, surviving only in the reflog.
		exec("git", ["reset", "--hard", "HEAD~1", "-q"], dir);
		// run.sh is not executable, and the shebang points at a shell that exists —
		// the permission bit is the trap.
		exec("chmod", ["644", "run.sh"], dir);
	},
	verify(dir) {
		const checks = [];
		const run = exec("./run.sh", [], dir);
		checks.push({ name: "`./run.sh` exits 0", ok: run.ok, detail: (run.stdout + run.stderr).slice(-400) });
		checks.push({ name: "it prints a total", ok: /total = \d+/.test(run.stdout), detail: run.stdout.slice(-200) });

		const src = existsSync(join(dir, "src/pricing.js")) ? readFileSync(join(dir, "src/pricing.js"), "utf8") : "";
		checks.push({ name: "the recovered file is the committed one, not a rewrite", ok: /TIERS/.test(src) && /discountFor/.test(src) && /0\.12/.test(src) });

		const hidden = runHidden(
			dir,
			"hidden.pricing.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFor, discountFor } from "./src/pricing.js";

test("tiers behave exactly as committed", () => {
	assert.equal(discountFor(1), 0);
	assert.equal(discountFor(10), 0.05);
	assert.equal(discountFor(99), 0.05);
	assert.equal(discountFor(100), 0.12);
	assert.equal(priceFor(1, 100), 100);
	assert.equal(priceFor(12, 25), 285);
	assert.equal(priceFor(120, 5), 528);
});
`,
		);
		checks.push({ name: "hidden: recovered logic is byte-for-byte correct", ok: hidden.fail === 0 && hidden.pass >= 1, detail: hidden.output.slice(-600) });

		const log = exec("git", ["log", "--oneline", "--all"], dir);
		checks.push({ name: "the recovery is in git history, not just the worktree", ok: /discount tiers/.test(log.stdout), detail: log.stdout.slice(-300) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// P3 — Aider-polyglot shape: one spec, two languages, hidden tests in each
// ---------------------------------------------------------------------------

const polyglot = {
	id: "polyglot",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 200_000, tokens: 160000, cost: 0.85 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 0,
	title: "跨语言一致性：同一规格的 JS 与 Python 实现",
	prompt: `Implement the SAME specification twice: once in JavaScript (js/interval.js) and once in Python (py/interval.py). SPEC.md is the contract.

Both implementations must expose \`merge(intervals)\` and \`subtract(a, b)\` with identical semantics, including the edge cases in the spec. Idiomatic code in each language, not a transliteration of the other.

Run what you write — \`node --test js/*.test.js\` and \`python3 -m unittest discover py\` are available, and there are starter tests in both directories that cover only the basics.`,
	seed(dir) {
		write(
			dir,
			"SPEC.md",
			`# Interval algebra

An interval is a pair \`[start, end)\` — start inclusive, end exclusive, integers,
\`start < end\`. A *set* is a list of intervals.

## merge(intervals)

Return the minimal, sorted list of disjoint intervals covering the same points.
Overlapping AND touching intervals coalesce: \`[1,3)\` and \`[3,5)\` become \`[1,5)\`.
Empty or invalid intervals (\`end <= start\`) are dropped. \`merge([])\` is \`[]\`.
The input must not be mutated.

## subtract(a, b)

Return \`merge(a)\` minus every point covered by \`b\` (b need not be merged or
sorted). The result is minimal and sorted. Subtracting a hole from the middle of
an interval splits it in two. Subtracting nothing returns \`merge(a)\`.

## Errors

A non-integer bound, or a non-pair element, raises \`TypeError\` in Python and
throws \`TypeError\` in JavaScript.
`,
		);
		write(dir, "package.json", JSON.stringify({ name: "polyglot", type: "module", private: true }, null, 2) + "\n");
		write(dir, "js/interval.js", "export function merge(intervals) {\n\tthrow new Error('not implemented');\n}\n\nexport function subtract(a, b) {\n\tthrow new Error('not implemented');\n}\n");
		write(
			dir,
			"js/interval.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, subtract } from "./interval.js";

test("merges overlapping", () => {
	assert.deepEqual(merge([[1, 3], [2, 5]]), [[1, 5]]);
});

test("subtracts a hole", () => {
	assert.deepEqual(subtract([[1, 10]], [[4, 6]]), [[1, 4], [6, 10]]);
});
`,
		);
		write(dir, "py/interval.py", "def merge(intervals):\n    raise NotImplementedError\n\n\ndef subtract(a, b):\n    raise NotImplementedError\n");
		write(
			dir,
			"py/test_interval.py",
			`import unittest
from interval import merge, subtract


class Basics(unittest.TestCase):
    def test_merge(self):
        self.assertEqual(merge([[1, 3], [2, 5]]), [[1, 5]])

    def test_subtract(self):
        self.assertEqual(subtract([[1, 10]], [[4, 6]]), [[1, 4], [6, 10]])


if __name__ == "__main__":
    unittest.main()
`,
		);
	},
	verify(dir) {
		const checks = [];
		const js = runHidden(
			dir,
			"hidden.interval.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, subtract } from "./js/interval.js";

test("merge coalesces touching intervals and sorts", () => {
	assert.deepEqual(merge([[5, 7], [1, 3], [3, 5]]), [[1, 7]]);
	assert.deepEqual(merge([[1, 2], [4, 5]]), [[1, 2], [4, 5]]);
	assert.deepEqual(merge([]), []);
	assert.deepEqual(merge([[3, 3], [1, 2]]), [[1, 2]]);
});

test("merge does not mutate its input", () => {
	const input = [[3, 5], [1, 2]];
	merge(input);
	assert.deepEqual(input, [[3, 5], [1, 2]]);
});

test("subtract splits, trims and removes", () => {
	assert.deepEqual(subtract([[1, 10]], [[0, 20]]), []);
	assert.deepEqual(subtract([[1, 10]], []), [[1, 10]]);
	assert.deepEqual(subtract([[1, 5], [7, 9]], [[4, 8]]), [[1, 4], [8, 9]]);
	assert.deepEqual(subtract([[1, 10]], [[6, 7], [2, 3]]), [[1, 2], [3, 6], [7, 10]]);
	assert.deepEqual(subtract([[1, 3], [2, 6]], [[4, 5]]), [[1, 4], [5, 6]]);
});

test("bad input throws TypeError", () => {
	assert.throws(() => merge([[1, "x"]]), TypeError);
	assert.throws(() => merge([[1]]), TypeError);
});
`,
		);
		checks.push({ name: `JS: hidden spec conformance (${js.pass}p/${js.fail}f)`, ok: js.fail === 0 && js.pass >= 4, detail: js.output.slice(-800) });

		write(
			dir,
			"py/hidden_test_interval.py",
			`import unittest
from interval import merge, subtract


class Hidden(unittest.TestCase):
    def test_merge(self):
        self.assertEqual(merge([[5, 7], [1, 3], [3, 5]]), [[1, 7]])
        self.assertEqual(merge([[1, 2], [4, 5]]), [[1, 2], [4, 5]])
        self.assertEqual(merge([]), [])
        self.assertEqual(merge([[3, 3], [1, 2]]), [[1, 2]])

    def test_no_mutation(self):
        data = [[3, 5], [1, 2]]
        merge(data)
        self.assertEqual(data, [[3, 5], [1, 2]])

    def test_subtract(self):
        self.assertEqual(subtract([[1, 10]], [[0, 20]]), [])
        self.assertEqual(subtract([[1, 10]], []), [[1, 10]])
        self.assertEqual(subtract([[1, 5], [7, 9]], [[4, 8]]), [[1, 4], [8, 9]])
        self.assertEqual(subtract([[1, 10]], [[6, 7], [2, 3]]), [[1, 2], [3, 6], [7, 10]])

    def test_type_errors(self):
        with self.assertRaises(TypeError):
            merge([[1, "x"]])
        with self.assertRaises(TypeError):
            merge([[1]])


if __name__ == "__main__":
    unittest.main()
`,
		);
		const py = exec("python3", ["-m", "unittest", "hidden_test_interval", "-v"], join(dir, "py"));
		const pyOut = py.stdout + py.stderr;
		const pyFail = /FAILED|Error/.test(pyOut) || !py.ok;
		checks.push({ name: "Python: hidden spec conformance", ok: !pyFail, detail: pyOut.slice(-800) });

		// The point of the exercise is two real implementations, not a shim.
		const pySrc = existsSync(join(dir, "py/interval.py")) ? readFileSync(join(dir, "py/interval.py"), "utf8") : "";
		const jsSrc = existsSync(join(dir, "js/interval.js")) ? readFileSync(join(dir, "js/interval.js"), "utf8") : "";
		checks.push({
			name: "both languages actually implemented (no shelling out to the other)",
			ok: pySrc.length > 200 && jsSrc.length > 200 && !/subprocess|child_process/.test(pySrc + jsSrc),
		});
		return checks;
	},
};

// ---------------------------------------------------------------------------
// P4 — SEC-bench shape: close the holes, keep the behaviour
// ---------------------------------------------------------------------------

const securityFix = {
	id: "security-fix",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 100_000, tokens: 90000, cost: 0.5 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "安全修复：目录穿越 + 原型污染，且不能改坏功能",
	prompt: `src/store.js backs a small file-backed key/value service. It has security problems: a caller can reach files outside the data directory, and can corrupt the runtime by injecting into object prototypes through user-supplied keys or documents.

Close the holes without changing the legitimate API behaviour that test/store.test.js pins down. Keys that are genuinely valid must keep working, including nested paths inside the data directory and documents with ordinary user data.

Anything you reject must be rejected with a thrown \`Error\` — do not silently fall back to a default path or drop data.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "store", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"src/store.js",
			`import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** A tiny JSON document store, one file per key, under \`root\`. */
export class Store {
	constructor(root) {
		this.root = root;
		mkdirSync(root, { recursive: true });
		this.index = {};
	}

	#file(key) {
		return join(this.root, key + ".json");
	}

	put(key, doc) {
		const file = this.#file(key);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(doc));
		this.index[key] = { size: JSON.stringify(doc).length };
		return key;
	}

	get(key) {
		const file = this.#file(key);
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8"));
	}

	/** Merge a patch into an existing document. */
	patch(key, updates) {
		const current = this.get(key) ?? {};
		for (const [k, v] of Object.entries(updates)) {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				current[k] = { ...(current[k] ?? {}), ...v };
			} else {
				current[k] = v;
			}
		}
		return this.put(key, current);
	}
}
`,
		);
		write(
			dir,
			"test/store.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const fresh = () => new Store(mkdtempSync(join(tmpdir(), "store-")));

test("round-trips a document", () => {
	const s = fresh();
	s.put("users/ada", { name: "Ada", tags: ["x"] });
	assert.deepEqual(s.get("users/ada"), { name: "Ada", tags: ["x"] });
});

test("nested keys are allowed", () => {
	const s = fresh();
	s.put("a/b/c", { ok: true });
	assert.deepEqual(s.get("a/b/c"), { ok: true });
});

test("patch merges one level deep", () => {
	const s = fresh();
	s.put("k", { a: { x: 1 }, b: 1 });
	s.patch("k", { a: { y: 2 }, b: 2 });
	assert.deepEqual(s.get("k"), { a: { x: 1, y: 2 }, b: 2 });
});

test("missing keys read as undefined", () => {
	assert.equal(fresh().get("nope"), undefined);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const suite = runSuite(dir);
		checks.push({ name: "legitimate behaviour preserved", ok: suite.ok, detail: suite.stdout.slice(-600) });

		const hidden = runHidden(
			dir,
			"hidden.security.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./src/store.js";

const fresh = () => { const root = mkdtempSync(join(tmpdir(), "store-")); return { s: new Store(root), root }; };

test("cannot escape the data directory", () => {
	const { s, root } = fresh();
	const outside = join(root, "..", "escaped-" + Date.now());
	assert.throws(() => s.put("../escaped-" + Date.now(), { pwned: true }), Error);
	assert.throws(() => s.put("a/../../escaped2", { pwned: true }), Error);
	assert.throws(() => s.put("/etc/passwd-ish", { pwned: true }), Error);
	assert.equal(existsSync(outside + ".json"), false);
});

test("reads cannot escape either", () => {
	const { s } = fresh();
	assert.throws(() => s.get("../../etc/hosts"), Error);
});

test("a __proto__ key cannot corrupt anything", () => {
	// Rejecting is one valid remedy; containing it (null-prototype index, defineProperty)
	// is another. Assert the SECURITY PROPERTY, not one chosen implementation.
	const { s } = fresh();
	try { s.put("__proto__", { polluted: true }); } catch { /* rejecting is fine */ }
	assert.equal({}.polluted, undefined, "Object.prototype was polluted");
	assert.equal(Object.prototype.polluted, undefined);
	try { s.put("constructor", { prototype: { polluted3: true } }); } catch { /* fine */ }
	assert.equal({}.polluted3, undefined);
	// and the store itself must still work afterwards
	s.put("after", { ok: 1 });
	assert.deepEqual(s.get("after"), { ok: 1 });
});

test("prototype pollution via patch payloads is rejected or contained", () => {
	const { s } = fresh();
	s.put("k", { a: 1 });
	try { s.patch("k", JSON.parse('{"__proto__":{"polluted":true}}')); } catch { /* rejecting is fine */ }
	assert.equal({}.polluted, undefined, "Object.prototype was polluted");
	try { s.patch("k", JSON.parse('{"constructor":{"prototype":{"polluted2":true}}}')); } catch { /* fine */ }
	assert.equal({}.polluted2, undefined, "prototype polluted via constructor");
});

test("ordinary data with awkward names still works", () => {
	const { s } = fresh();
	s.put("normal", { proto: 1, constructorName: "x", "a.b": 2 });
	assert.deepEqual(s.get("normal"), { proto: 1, constructorName: "x", "a.b": 2 });
	s.put("deep/nest/ok", { v: [1, 2, { z: 3 }] });
	assert.deepEqual(s.get("deep/nest/ok"), { v: [1, 2, { z: 3 }] });
});
`,
		);
		checks.push({ name: `hidden: exploits blocked (${hidden.pass}p/${hidden.fail}f)`, ok: hidden.fail === 0 && hidden.pass >= 5, detail: hidden.output.slice(-1000) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// P5 — a nondeterministic failure: fix the cause, not the symptom
// ---------------------------------------------------------------------------

const flakyCi = {
	id: "flaky-ci",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 75_000, tokens: 65000, cost: 0.3 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 1,
	title: "根因排查：让测试真正稳定，而不是把失败掩盖过去",
	prompt: `\`npm test\` in this repository fails, and there is more than one defect behind it: one makes the failure depend on which tests ran before, and one is a boundary that depends on how coarse the system clock happens to be.

Find the real causes and fix the SOURCE so the suite passes on every run, not just some. The tests themselves describe correct, intended behaviour and must not be weakened.

Explicitly forbidden, because they hide the bug instead of fixing it: adding sleeps or timeouts to the tests, retrying failed tests, skipping or deleting a test, seeding or stubbing the clock inside the test files, and reordering tests to avoid the interaction. Fix src/.

In your final message, state the root cause in one sentence.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "flaky", type: "module", private: true, scripts: { test: "node --test test/cache.test.js test/rate.test.js" } }, null, 2) + "\n");
		// Two real defects that only bite under interleaving:
		//  1. module-level mutable state shared across instances,
		//  2. a TTL comparison that is off by one against a coarse clock.
		write(
			dir,
			"src/cache.js",
			`/** An LRU-ish cache with per-entry TTL. */
const store = new Map(); // shared across every instance — that is the bug

export class Cache {
	constructor({ ttlMs = 50, max = 3 } = {}) {
		this.ttlMs = ttlMs;
		this.max = max;
	}

	set(key, value) {
		store.set(key, { value, at: Date.now() });
		if (store.size > this.max) {
			const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			store.delete(oldest[0]);
		}
		return value;
	}

	get(key) {
		const hit = store.get(key);
		if (!hit) return undefined;
		// Coarse clocks make this boundary flaky: an entry written and read inside
		// the same millisecond can be judged expired when ttlMs is small.
		if (Date.now() - hit.at > this.ttlMs) {
			store.delete(key);
			return undefined;
		}
		return hit.value;
	}

	get size() {
		return store.size;
	}

	clear() {
		store.clear();
	}
}
`,
		);
		write(
			dir,
			"src/rate.js",
			`import { Cache } from "./cache.js";

/** Allows \`limit\` calls per key per window. */
export class RateLimiter {
	constructor({ limit = 2, windowMs = 1000 } = {}) {
		this.limit = limit;
		this.cache = new Cache({ ttlMs: windowMs, max: 1000 });
	}

	allow(key) {
		const used = this.cache.get(key) ?? 0;
		if (used >= this.limit) return false;
		this.cache.set(key, used + 1);
		return true;
	}
}
`,
		);
		write(
			dir,
			"test/cache.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { Cache } from "../src/cache.js";

test("stores and reads back within the ttl", () => {
	const c = new Cache({ ttlMs: 1000 });
	c.set("k", 1);
	assert.equal(c.get("k"), 1);
});

test("two caches do not see each other's entries", () => {
	const a = new Cache({ ttlMs: 1000 });
	const b = new Cache({ ttlMs: 1000 });
	a.set("shared", "from-a");
	assert.equal(b.get("shared"), undefined);
});

test("evicts beyond max", () => {
	const c = new Cache({ ttlMs: 1000, max: 2 });
	c.set("a", 1); c.set("b", 2); c.set("c", 3);
	assert.equal(c.size, 2);
});
`,
		);
		write(
			dir,
			"test/rate.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate.js";

test("allows up to the limit then blocks", () => {
	const r = new RateLimiter({ limit: 2, windowMs: 1000 });
	assert.equal(r.allow("ip1"), true);
	assert.equal(r.allow("ip1"), true);
	assert.equal(r.allow("ip1"), false);
});

test("limits are per key", () => {
	const r = new RateLimiter({ limit: 1, windowMs: 1000 });
	assert.equal(r.allow("a"), true);
	assert.equal(r.allow("b"), true);
});

test("a fresh limiter starts clean", () => {
	const r = new RateLimiter({ limit: 1, windowMs: 1000 });
	assert.equal(r.allow("ip1"), true);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		// Determinism is the whole point: one green run proves nothing.
		let green = 0;
		let lastOut = "";
		for (let i = 0; i < 8; i++) {
			const r = runSuite(dir);
			if (r.ok) green++;
			else lastOut = r.stdout.slice(-500) + r.stderr.slice(-300);
		}
		checks.push({ name: `suite green in 8 consecutive runs (got ${green}/8)`, ok: green === 8, detail: lastOut });

		const testSrc = ["test/cache.test.js", "test/rate.test.js"]
			.map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : ""))
			.join("\n");
		checks.push({
			name: "tests were not weakened (no sleeps, skips, retries or clock stubs)",
			ok:
				/two caches do not see/.test(testSrc) &&
				/allows up to the limit/.test(testSrc) &&
				!/setTimeout|sleep|skip|todo:|Date\.now\s*=|mock\.timers|retry/i.test(testSrc),
			detail: testSrc.length ? "" : "test files missing",
		});

		const cacheSrc = existsSync(join(dir, "src/cache.js")) ? readFileSync(join(dir, "src/cache.js"), "utf8") : "";
		checks.push({
			name: "the shared module-level store is gone (state is per instance)",
			ok: cacheSrc.length > 0 && !/^const store = new Map\(\);/m.test(cacheSrc),
			detail: cacheSrc.slice(0, 200),
		});

		const hiddenSource = `import { test } from "node:test";
import assert from "node:assert/strict";
import { Cache } from "./src/cache.js";
import { RateLimiter } from "./src/rate.js";

test("instances are isolated even under interleaving", () => {
	// max must exceed the number of writes, or eviction — correct behaviour —
	// would be indistinguishable from the leak this test is looking for.
	const a = new Cache({ ttlMs: 1000, max: 100 });
	const b = new Cache({ ttlMs: 1000, max: 100 });
	for (let i = 0; i < 20; i++) { a.set("k" + i, "a"); b.set("k" + i, "b"); }
	for (let i = 0; i < 20; i++) {
		assert.equal(a.get("k" + i), "a");
		assert.equal(b.get("k" + i), "b");
	}
});

test("an entry is readable immediately regardless of clock granularity", () => {
	// The probe is probabilistic by nature: a Date.now()-based cache only misjudges
	// when the millisecond ticks between the set and the get. At 500 iterations that
	// was a coin flip and the VERDICT was flaky; 50k makes it near-certain, so a
	// coarse-clock fix fails reliably and a monotonic one passes reliably.
	for (let i = 0; i < 50_000; i++) {
		const c = new Cache({ ttlMs: 1 });
		c.set("k", i);
		assert.equal(c.get("k"), i, "entry expired within its own ttl");
	}
});

test("eviction still respects max per instance", () => {
	const c = new Cache({ ttlMs: 1000, max: 2 });
	c.set("a", 1); c.set("b", 2); c.set("c", 3);
	assert.equal(c.size, 2);
});

test("rate limiters do not leak across instances", () => {
	const first = new RateLimiter({ limit: 1, windowMs: 1000 });
	assert.equal(first.allow("ip"), true);
	assert.equal(first.allow("ip"), false);
	const second = new RateLimiter({ limit: 1, windowMs: 1000 });
	assert.equal(second.allow("ip"), true, "a new limiter inherited another's counters");
});

test("expiry still happens after the ttl", async () => {
	const c = new Cache({ ttlMs: 10 });
	c.set("k", 1);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(c.get("k"), undefined);
});
`;
		const hidden = runHidden(dir, "hidden.flaky.test.mjs", hiddenSource);
		// A determinism task cannot be judged by a single run of the hidden suite:
		// the same workspace passed once and failed once here, which would have made
		// the VERDICT flaky too. Require it green three times in a row.
		let hiddenGreen = hidden.fail === 0 && hidden.pass >= 5 ? 1 : 0;
		let lastHidden = hidden;
		for (let i = 0; i < 2 && hiddenGreen === i + 1; i++) {
			lastHidden = runHidden(dir, "hidden.flaky.test.mjs", hiddenSource);
			if (lastHidden.fail === 0 && lastHidden.pass >= 5) hiddenGreen++;
		}
		checks.push({
			name: `hidden: root cause actually fixed, 3 次连续全绿（得 ${hiddenGreen}/3）`,
			ok: hiddenGreen === 3,
			detail: lastHidden.output.slice(-900),
		});
		return checks;
	},
};

export const TASKS = [swePatch, terminalOps, polyglot, securityFix, flakyCi];
export const TASK_IDS = TASKS.map((t) => t.id);
