/**
 * Phase-5 — one long-horizon task, built so the END invalidates the BEGINNING.
 *
 * Phase 4 is hard but short: each task is one defect, found in one sitting. This
 * one is deliberately sequenced. Six milestones, and the later ones break the
 * obvious implementation of the earlier ones:
 *
 *   M2 (bounded parallelism) breaks a sequential M1 loop.
 *   M4 (retries) breaks an M3 that marks downstream `skipped` the moment a task
 *      throws — a task that succeeds on its second attempt must not have skipped
 *      anything.
 *   M5 (resume from a journal) breaks any design that kept attempt counts and
 *      completion state only in local variables, which is what M1-M4 invite.
 *
 * So an agent that implements the spec top-to-bottom, milestone by milestone,
 * has to go back and rework state it already wrote. That is the behaviour under
 * test: holding a design across a long horizon, not solving six puzzles.
 *
 * Scoring is granular on purpose — eight independent checks — because the phase
 * 1-4 suites saturate at "both agents pass everything" and a saturated benchmark
 * measures nothing.
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

function runHidden(dir, rel, source, timeoutMs = 180_000) {
	write(dir, rel, source);
	const r = node(dir, ["--test", "--test-reporter=tap", rel], timeoutMs);
	return {
		pass: Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		fail: Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		output: `${r.stdout}\n${r.stderr}`.slice(-4000),
	};
}

/** Preamble every hidden test shares: the harness helpers, not the assertions. */
const PRELUDE = `import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

/** A journal that keeps entries in memory, matching the SPEC's shape. */
function memJournal(initial = []) {
	const rows = [...initial];
	return { append: (e) => rows.push(e), entries: () => rows.slice(), rows };
}

/** Records the order tasks start in, and how many ran at once. */
function tracker() {
	const t = { order: [], started: [], peak: 0, live: 0, ran: [] };
	t.task = (id, ms = 0, impl) => ({
		run: async (ctx) => {
			t.order.push(id);
			t.ran.push(id);
			t.live++;
			t.peak = Math.max(t.peak, t.live);
			try {
				if (ms) await defer(ms);
				return impl ? await impl(ctx) : id;
			} finally {
				t.live--;
			}
		},
	});
	return t;
}
`;

const workflowEngine = {
	id: "workflow-engine",
	/**
	 * Long-horizon budget: this is a build, not a fix. Calibrated well above the
	 * phase-4 tasks (which sit at ~2 min) because six sequenced milestones with a
	 * rework in the middle is genuinely more work, not artificially more.
	 */
	budget: { ms: 900_000, tokens: 900_000, cost: 3.5 },
	/** An untouched stub throws on every call: nothing passes. */
	expectDry: 0,
	title: "长程构建：六个里程碑的任务图引擎，后面的里程碑会推翻前面的实现",
	prompt: `Build the workflow engine described in SPEC.md. \`src/engine.js\` is a stub.

The spec has six milestones (M1-M6). They are ordered, and they are not independent — later milestones constrain how the earlier ones must be implemented, so read the whole spec before you start writing.

\`node --test test/*.test.js\` covers M1 only. The rest of the spec is not covered by any test you can see; it is still part of the task, and it is what you will be judged on.

Work through all six. When you are done, \`node --test test/*.test.js\` must still pass.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "workflow-engine", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"SPEC.md",
			`# Workflow engine

A task graph runner. Tasks declare dependencies; the engine decides what runs
when, survives failures, retries what is retryable, and can resume a run that was
interrupted.

## API

\`\`\`js
import { createEngine } from "./src/engine.js";

const engine = createEngine({ concurrency: 2 });
const report = await engine.run(tasks, { journal });
\`\`\`

\`tasks\` is a plain object keyed by task id:

\`\`\`js
{
  build:  { deps: [],                run: async (ctx) => "artifact" },
  test:   { deps: ["build"],         run: async (ctx) => ctx.results.build.length, retries: 2 },
  deploy: { deps: ["test", "build"], run: async (ctx) => "ok" },
}
\`\`\`

- \`deps\` — ids this task waits for. Missing key means no dependencies.
- \`run(ctx)\` — async. \`ctx.results\` holds the values of this task's dependencies
  (only its own deps, keyed by id).
- \`retries\` — additional attempts after the first. Absent or 0 means one attempt.

\`report\` is:

\`\`\`js
{
  status:   "ok" | "failed",     // "failed" if any task ended in state "failed"
  results:  { [id]: value },     // only tasks that reached "done"
  states:   { [id]: "done" | "failed" | "skipped" },
  attempts: { [id]: number },    // attempts actually made; 0 for a skipped task
}
\`\`\`

## M1 — dependency order

A task runs only after every id in its \`deps\` has reached \`done\`. When several
tasks become ready at the same moment, start them in **ascending id order**
(plain string comparison), so a run is reproducible.

## M2 — bounded parallelism

At most \`concurrency\` tasks may be in flight at once (default 1). Independent
tasks MUST actually overlap when concurrency allows it — running everything
sequentially is not an acceptable implementation of this engine.

## M3 — failure isolation

If a task's \`run\` throws, that task's state is \`failed\`. Every task that depends
on it, directly or transitively, is \`skipped\` — **not** \`failed\`, and its \`run\`
is never called. Tasks that are not downstream of the failure still run to
completion; one broken branch does not abort the others. The report's \`status\`
is \`failed\`.

## M4 — retries

\`retries: n\` allows up to \`n\` further attempts after a failed one. \`attempts\`
records how many were actually made.

A task that fails and then SUCCEEDS on a later attempt is \`done\`, and nothing
downstream of it is skipped — the earlier failure is not visible in the report
beyond the \`attempts\` count. Only a task whose attempts are exhausted is
\`failed\`.

## M5 — resume

\`run\` accepts an optional \`journal\`:

\`\`\`js
{ append(entry) {}, entries() { return [...] } }
\`\`\`

The engine appends one entry per task as it settles:

\`\`\`js
{ id, status: "done",   value, attempts }
{ id, status: "failed", error, attempts }   // error is the Error's message
\`\`\`

When \`run\` starts, it reads \`entries()\` first. A task with a \`done\` entry is
already satisfied: its \`run\` is **not** called again, its recorded \`value\` is
used for dependents, and its \`attempts\` carries into the new report. A task with
a \`failed\` entry is retried from scratch — a resume is how you retry a run that
broke.

This is what makes an interrupted run cheap to restart, so it has to work
together with everything above: a resumed run still honours concurrency,
still skips downstream of a task that fails again, and still counts attempts
across the resume.

## M6 — cycles

If the graph contains a cycle, \`run\` rejects with an \`Error\` whose message names
every id in the cycle. Nothing runs.
`,
		);
		write(
			dir,
			"src/engine.js",
			`/**
 * Workflow engine — see SPEC.md.
 *
 * Stub. Implement M1 through M6.
 */
export function createEngine(options = {}) {
	const concurrency = options.concurrency ?? 1;
	return {
		concurrency,
		async run(_tasks, _opts = {}) {
			throw new Error("not implemented");
		},
	};
}
`,
		);
		write(
			dir,
			"test/engine.test.js",
			`import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";

// These cover M1 only. The rest of SPEC.md is not tested here.

test("runs a task with no dependencies", async () => {
	const engine = createEngine({ concurrency: 1 });
	const report = await engine.run({ a: { run: async () => 1 } });
	assert.equal(report.status, "ok");
	assert.equal(report.results.a, 1);
	assert.equal(report.states.a, "done");
});

test("runs dependencies before dependents", async () => {
	const order = [];
	const engine = createEngine({ concurrency: 1 });
	const report = await engine.run({
		b: { deps: ["a"], run: async () => { order.push("b"); return "B"; } },
		a: { deps: [], run: async () => { order.push("a"); return "A"; } },
	});
	assert.deepEqual(order, ["a", "b"]);
	assert.equal(report.results.b, "B");
});

test("a dependency's value reaches its dependent", async () => {
	const engine = createEngine({ concurrency: 1 });
	const report = await engine.run({
		a: { run: async () => 21 },
		b: { deps: ["a"], run: async (ctx) => ctx.results.a * 2 },
	});
	assert.equal(report.results.b, 42);
});

test("ready tasks start in ascending id order", async () => {
	const order = [];
	const engine = createEngine({ concurrency: 1 });
	await engine.run({
		c: { run: async () => order.push("c") },
		a: { run: async () => order.push("a") },
		b: { run: async () => order.push("b") },
	});
	assert.deepEqual(order, ["a", "b", "c"]);
});
`,
		);
	},
	verify(dir) {
		const checks = [];

		const visible = runSuite(dir);
		checks.push({
			name: "M1: the shipped suite still passes",
			ok: visible.ok && /# fail 0/.test(visible.stdout),
			detail: `${visible.stdout}\n${visible.stderr}`.slice(-1200),
		});

		const m1 = runHidden(
			dir,
			"hidden/m1.test.mjs",
			`${PRELUDE}
test("a diamond runs in a valid topological order", async () => {
	const t = tracker();
	const report = await createEngine({ concurrency: 1 }).run({
		a: t.task("a"),
		b: { deps: ["a"], ...t.task("b") },
		c: { deps: ["a"], ...t.task("c") },
		d: { deps: ["b", "c"], ...t.task("d") },
	});
	assert.equal(report.status, "ok");
	assert.ok(t.order.indexOf("a") < t.order.indexOf("b"), "b ran before a");
	assert.ok(t.order.indexOf("c") < t.order.indexOf("d"), "d ran before c");
	assert.deepEqual(report.states, { a: "done", b: "done", c: "done", d: "done" });
});

test("ctx.results carries only the task's own dependencies", async () => {
	const seen = {};
	await createEngine({ concurrency: 1 }).run({
		a: { run: async () => "A" },
		b: { run: async () => "B" },
		c: { deps: ["a"], run: async (ctx) => { seen.c = Object.keys(ctx.results).sort(); return "C"; } },
	});
	assert.deepEqual(seen.c, ["a"], "c saw " + JSON.stringify(seen.c));
});

test("attempts is 1 for a task that succeeds first time", async () => {
	const report = await createEngine({}).run({ a: { run: async () => 1 } });
	assert.equal(report.attempts.a, 1);
});
`,
		);
		checks.push({ name: `M1 hidden: dependency order and ctx (${m1.pass}p/${m1.fail}f)`, ok: m1.fail === 0 && m1.pass >= 3, detail: m1.output.slice(-1200) });

		const m2 = runHidden(
			dir,
			"hidden/m2.test.mjs",
			`${PRELUDE}
test("independent tasks actually overlap", async () => {
	const t = tracker();
	const started = Date.now();
	await createEngine({ concurrency: 4 }).run({
		a: t.task("a", 80), b: t.task("b", 80), c: t.task("c", 80), d: t.task("d", 80),
	});
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 200, "four 80ms tasks took " + elapsed + "ms — they ran sequentially");
	assert.ok(t.peak >= 2, "peak concurrency was " + t.peak);
});

test("concurrency is an upper bound, not a suggestion", async () => {
	const t = tracker();
	await createEngine({ concurrency: 2 }).run({
		a: t.task("a", 40), b: t.task("b", 40), c: t.task("c", 40), d: t.task("d", 40), e: t.task("e", 40),
	});
	assert.ok(t.peak <= 2, "peak concurrency was " + t.peak + ", limit was 2");
});

test("concurrency defaults to 1", async () => {
	const t = tracker();
	await createEngine({}).run({ a: t.task("a", 20), b: t.task("b", 20) });
	assert.equal(t.peak, 1, "peak concurrency was " + t.peak + " with no limit configured");
});

test("the dependency barrier still holds under concurrency", async () => {
	const t = tracker();
	await createEngine({ concurrency: 4 }).run({
		a: t.task("a", 40),
		b: { deps: ["a"], ...t.task("b", 10) },
		c: { deps: ["a"], ...t.task("c", 10) },
	});
	assert.equal(t.order[0], "a");
});
`,
		);
		checks.push({ name: `M2 hidden: bounded parallelism (${m2.pass}p/${m2.fail}f)`, ok: m2.fail === 0 && m2.pass >= 4, detail: m2.output.slice(-1200) });

		const m3 = runHidden(
			dir,
			"hidden/m3.test.mjs",
			`${PRELUDE}
test("downstream of a failure is skipped, not failed", async () => {
	const t = tracker();
	const report = await createEngine({ concurrency: 1 }).run({
		a: { run: async () => { throw new Error("boom"); } },
		b: { deps: ["a"], ...t.task("b") },
		c: { deps: ["b"], ...t.task("c") },
	});
	assert.equal(report.states.a, "failed");
	assert.equal(report.states.b, "skipped", "b was " + report.states.b);
	assert.equal(report.states.c, "skipped", "transitive dependent c was " + report.states.c);
	assert.deepEqual(t.ran, [], "a skipped task's run was called: " + t.ran.join(","));
	assert.equal(report.status, "failed");
});

test("an unrelated branch still completes", async () => {
	const report = await createEngine({ concurrency: 2 }).run({
		bad: { run: async () => { throw new Error("boom"); } },
		worse: { deps: ["bad"], run: async () => "never" },
		ok1: { run: async () => "one" },
		ok2: { deps: ["ok1"], run: async (ctx) => ctx.results.ok1 + "-two" },
	});
	assert.equal(report.states.ok1, "done");
	assert.equal(report.states.ok2, "done", "an independent branch was abandoned");
	assert.equal(report.results.ok2, "one-two");
	assert.equal(report.status, "failed");
});

test("a skipped task has no result and zero attempts", async () => {
	const report = await createEngine({}).run({
		a: { run: async () => { throw new Error("boom"); } },
		b: { deps: ["a"], run: async () => "never" },
	});
	assert.equal(report.attempts.b, 0, "skipped task recorded " + report.attempts.b + " attempts");
	assert.ok(!("b" in report.results), "a skipped task produced a result");
});
`,
		);
		checks.push({ name: `M3 hidden: failure isolation (${m3.pass}p/${m3.fail}f)`, ok: m3.fail === 0 && m3.pass >= 3, detail: m3.output.slice(-1200) });

		const m4 = runHidden(
			dir,
			"hidden/m4.test.mjs",
			`${PRELUDE}
test("a task that succeeds on retry does not skip anything", async () => {
	let n = 0;
	const report = await createEngine({ concurrency: 1 }).run({
		flaky: { retries: 2, run: async () => { n++; if (n < 3) throw new Error("nope"); return "ok"; } },
		after: { deps: ["flaky"], run: async (ctx) => ctx.results.flaky + "!" },
	});
	assert.equal(report.states.flaky, "done", "flaky ended " + report.states.flaky);
	assert.equal(report.attempts.flaky, 3);
	assert.equal(report.states.after, "done", "downstream was skipped despite an eventual success");
	assert.equal(report.results.after, "ok!");
	assert.equal(report.status, "ok", "status was " + report.status + " though every task ended done");
});

test("exhausted retries fail, and only then is downstream skipped", async () => {
	let n = 0;
	const report = await createEngine({}).run({
		doomed: { retries: 1, run: async () => { n++; throw new Error("always"); } },
		after: { deps: ["doomed"], run: async () => "never" },
	});
	assert.equal(n, 2, "run was called " + n + " times for retries:1");
	assert.equal(report.attempts.doomed, 2);
	assert.equal(report.states.doomed, "failed");
	assert.equal(report.states.after, "skipped");
});

test("retries default to none", async () => {
	let n = 0;
	const report = await createEngine({}).run({ a: { run: async () => { n++; throw new Error("x"); } } });
	assert.equal(n, 1, "run was called " + n + " times with no retries configured");
	assert.equal(report.attempts.a, 1);
});
`,
		);
		checks.push({ name: `M4 hidden: retries (${m4.pass}p/${m4.fail}f)`, ok: m4.fail === 0 && m4.pass >= 3, detail: m4.output.slice(-1200) });

		const m5 = runHidden(
			dir,
			"hidden/m5.test.mjs",
			`${PRELUDE}
test("the engine journals each task as it settles", async () => {
	const j = memJournal();
	await createEngine({ concurrency: 1 }).run({ a: { run: async () => "A" } }, { journal: j });
	const rows = j.entries();
	assert.equal(rows.length, 1, "journalled " + rows.length + " entries");
	assert.equal(rows[0].id, "a");
	assert.equal(rows[0].status, "done");
	assert.equal(rows[0].value, "A");
	assert.equal(rows[0].attempts, 1);
});

test("a failure is journalled with its message", async () => {
	const j = memJournal();
	await createEngine({}).run({ a: { run: async () => { throw new Error("kaboom"); } } }, { journal: j });
	const row = j.entries().find((r) => r.id === "a");
	assert.equal(row.status, "failed");
	assert.equal(row.error, "kaboom", "journalled error was " + JSON.stringify(row.error));
});

test("a resumed run does not re-run completed tasks", async () => {
	const t = tracker();
	const j = memJournal([{ id: "a", status: "done", value: "A", attempts: 1 }]);
	const report = await createEngine({ concurrency: 1 }).run({
		a: t.task("a"),
		b: { deps: ["a"], run: async (ctx) => ctx.results.a + "B" },
	}, { journal: j });
	assert.deepEqual(t.ran, [], "the completed task was re-run");
	assert.equal(report.results.b, "AB", "the journalled value did not reach the dependent");
	assert.equal(report.states.a, "done");
	assert.equal(report.attempts.a, 1, "journalled attempts did not carry over (got " + report.attempts.a + ")");
});

test("a journalled failure is retried from scratch on resume", async () => {
	let n = 0;
	const j = memJournal([{ id: "a", status: "failed", error: "old", attempts: 1 }]);
	const report = await createEngine({}).run({ a: { run: async () => { n++; return "now ok"; } } }, { journal: j });
	assert.equal(n, 1, "a previously failed task was not retried");
	assert.equal(report.states.a, "done");
	assert.equal(report.results.a, "now ok");
});
`,
		);
		checks.push({ name: `M5 hidden: journal and resume (${m5.pass}p/${m5.fail}f)`, ok: m5.fail === 0 && m5.pass >= 4, detail: m5.output.slice(-1200) });

		const m6 = runHidden(
			dir,
			"hidden/m6.test.mjs",
			`${PRELUDE}
test("a cycle rejects and names its members", async () => {
	const t = tracker();
	await assert.rejects(
		() => createEngine({}).run({
			a: { deps: ["c"], ...t.task("a") },
			b: { deps: ["a"], ...t.task("b") },
			c: { deps: ["b"], ...t.task("c") },
		}),
		(err) => {
			assert.ok(err instanceof Error, "rejected with a non-Error");
			for (const id of ["a", "b", "c"]) {
				assert.ok(err.message.includes(id), "cycle error does not name " + id + ": " + err.message);
			}
			return true;
		},
	);
	assert.deepEqual(t.ran, [], "tasks ran despite a cycle");
});

test("a self-dependency is a cycle", async () => {
	await assert.rejects(() => createEngine({}).run({ a: { deps: ["a"], run: async () => 1 } }));
});

test("a diamond is not a cycle", async () => {
	const report = await createEngine({ concurrency: 2 }).run({
		a: { run: async () => 1 },
		b: { deps: ["a"], run: async () => 2 },
		c: { deps: ["a"], run: async () => 3 },
		d: { deps: ["b", "c"], run: async () => 4 },
	});
	assert.equal(report.status, "ok");
});
`,
		);
		checks.push({ name: `M6 hidden: cycle detection (${m6.pass}p/${m6.fail}f)`, ok: m6.fail === 0 && m6.pass >= 3, detail: m6.output.slice(-1200) });

		// The milestone that catches an implementation built one milestone at a time:
		// retries + resume + concurrency + skipping, all in one graph.
		const integration = runHidden(
			dir,
			"hidden/integration.test.mjs",
			`${PRELUDE}
test("resume, retry, concurrency and skipping all hold at once", async () => {
	// First run: 'b' exhausts its retries, so 'd' is skipped; 'a' and 'c' finish.
	const j = memJournal();
	let bCalls = 0;
	const graph = (bImpl) => ({
		a: { run: async () => "A" },
		b: { deps: ["a"], retries: 1, run: bImpl },
		c: { deps: ["a"], run: async () => "C" },
		d: { deps: ["b"], run: async (ctx) => "D:" + ctx.results.b },
	});
	const first = await createEngine({ concurrency: 2 }).run(
		graph(async () => { bCalls++; throw new Error("flaky"); }),
		{ journal: j },
	);
	assert.equal(bCalls, 2, "retries not honoured on the first run (" + bCalls + " calls)");
	assert.equal(first.states.b, "failed");
	assert.equal(first.states.d, "skipped");
	assert.equal(first.states.c, "done");
	assert.equal(first.status, "failed");

	// Resume with the same journal: a and c are done and must not re-run; b is
	// retried from scratch and now succeeds, so d must run this time.
	const t = tracker();
	let bCalls2 = 0;
	const second = await createEngine({ concurrency: 2 }).run({
		a: t.task("a", 0, async () => "A"),
		b: { deps: ["a"], retries: 1, run: async () => { bCalls2++; return "B"; } },
		c: { deps: ["a"], ...t.task("c") },
		d: { deps: ["b"], run: async (ctx) => "D:" + ctx.results.b },
	}, { journal: j });

	assert.deepEqual(t.ran.sort(), [], "a completed task was re-run on resume: " + t.ran.join(","));
	assert.equal(bCalls2, 1, "b ran " + bCalls2 + " times on resume");
	assert.equal(second.states.d, "done", "d was " + second.states.d + " though b succeeded on resume");
	assert.equal(second.results.d, "D:B");
	assert.equal(second.results.a, "A", "the journalled value for a was lost");
	assert.equal(second.status, "ok", "status was " + second.status);
});

test("a resumed run still respects the concurrency limit", async () => {
	const j = memJournal([{ id: "a", status: "done", value: "A", attempts: 1 }]);
	const t = tracker();
	await createEngine({ concurrency: 2 }).run({
		a: t.task("a"),
		b: { deps: ["a"], ...t.task("b", 40) },
		c: { deps: ["a"], ...t.task("c", 40) },
		d: { deps: ["a"], ...t.task("d", 40) },
	}, { journal: j });
	assert.ok(t.peak <= 2, "peak concurrency was " + t.peak + " on a resumed run");
	assert.ok(t.peak >= 2, "a resumed run lost its parallelism (peak " + t.peak + ")");
});
`,
		);
		checks.push({
			name: `integration: retry + resume + concurrency + skip together (${integration.pass}p/${integration.fail}f)`,
			ok: integration.fail === 0 && integration.pass >= 2,
			detail: integration.output.slice(-1600),
		});

		return checks;
	},
};

export const TASKS = [workflowEngine];
export const TASK_IDS = TASKS.map((t) => t.id);
