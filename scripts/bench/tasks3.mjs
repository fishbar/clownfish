/**
 * Phase-3 — long-horizon work, where orchestration is supposed to pay off.
 *
 * The phase-1 and phase-2 suites saturated: both agents solved nearly everything,
 * so the only signal left was wall time. These tasks are deliberately WIDE (a
 * dozen files, hundreds of lines) rather than merely tricky, because that is the
 * regime where a harness that delegates and keeps a plan should separate from one
 * that holds everything in a single context.
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

function runHidden(dir, rel, source) {
	write(dir, rel, source);
	const r = node(dir, ["--test", "--test-reporter=tap", rel]);
	return {
		pass: Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		fail: Number(/^# fail (\d+)$/m.exec(r.stdout)?.[1] ?? 0),
		output: `${r.stdout}\n${r.stderr}`.slice(-4000),
	};
}

// ---------------------------------------------------------------------------
// Q1 — migrate a dozen callback modules to promises without changing semantics
// ---------------------------------------------------------------------------

/** The boring modules are generated: the work is wide, not individually clever. */
function plainModule(name, verb) {
	return `import { validate } from "./validate.js";

/** ${verb} a record. Error-first callback style. */
export function ${name}(input, cb) {
	const problem = validate(input);
	if (problem) return process.nextTick(() => cb(new Error(problem)));
	process.nextTick(() => cb(null, { op: "${name}", id: input.id, ${verb}: true }));
}
`;
}

const PLAIN = [
	["createRecord", "created"],
	["updateRecord", "updated"],
	["deleteRecord", "deleted"],
	["archiveRecord", "archived"],
	["restoreRecord", "restored"],
	["lockRecord", "locked"],
	["unlockRecord", "unlocked"],
	["tagRecord", "tagged"],
	["untagRecord", "untagged"],
];

const callbackMigration = {
	id: "callback-migration",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 300_000, tokens: 350000, cost: 1.3 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 2,
	title: "长时程迁移：12 个模块从回调改为 Promise，语义一字不变",
	prompt: `This library is written in error-first callback style. Migrate ALL of src/ to promises: every exported function should return a Promise instead of taking a callback.

MIGRATION.md is the contract. The parts that matter:
- \`index.js\` must keep exporting the same names.
- The three modules called out in MIGRATION.md have behaviour that is easy to lose in a mechanical rewrite. Preserve it exactly.
- \`util.promisify\`, \`util.callbackify\` and similar wrappers are not allowed — migrate the implementations.
- \`node --test test/*.test.js\` must pass. The existing tests are already written against the promise API and currently fail.

There are a dozen files. Work through all of them.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "records", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"MIGRATION.md",
			`# Callback → Promise migration

Every exported function takes \`(input, cb)\` today and must take \`(input)\` and
return a Promise. Rejections carry the same \`Error\` the callback received.

## The three that are not mechanical

**src/retry.js** — \`withRetry\` currently guards against a flaky operation calling
its callback more than once (a real bug we hit in production: the second call must
be ignored, not crash and not resolve twice). A promise version must keep that
guarantee: settling twice is a no-op, and the operation is not retried after it has
already succeeded.

**src/walk.js** — \`walkTree\` validates its argument SYNCHRONOUSLY and throws a
\`TypeError\` before doing any work, on purpose: callers rely on the stack trace
pointing at their own call site. After the migration it must still throw
synchronously for a bad argument — not return a rejected promise.

**src/pool.js** — \`mapPool\` preserves input order in its results while running up
to \`limit\` operations concurrently, and it must keep doing both. It also stops
launching new work after the first failure.

## Everything else

The remaining modules are straightforward one-for-one conversions. \`validate.js\`
is already synchronous and does not change.
`,
		);
		write(
			dir,
			"src/validate.js",
			`/** Returns a problem string, or null when the input is fine. */
export function validate(input) {
	if (!input || typeof input !== "object") return "input must be an object";
	if (typeof input.id !== "string" || input.id === "") return "id is required";
	return null;
}
`,
		);
		for (const [name, verb] of PLAIN) write(dir, `src/${name.replace(/Record$/, "")}.js`, plainModule(name, verb));
		write(
			dir,
			"src/retry.js",
			`/** Run \`op(cb)\` up to \`attempts\` times. Guards against an op that calls back twice. */
export function withRetry(op, attempts, cb) {
	let remaining = attempts;
	const run = () => {
		let settled = false;
		op((err, value) => {
			if (settled) return; // a flaky op calling back twice must not double-settle
			settled = true;
			if (!err) return cb(null, value);
			remaining--;
			if (remaining <= 0) return cb(err);
			run();
		});
	};
	run();
}
`,
		);
		write(
			dir,
			"src/walk.js",
			`/** Depth-first walk. Throws SYNCHRONOUSLY on a bad argument, by design. */
export function walkTree(node, cb) {
	if (!node || typeof node !== "object") throw new TypeError("node must be an object");
	const out = [];
	const visit = (n) => {
		out.push(n.name);
		for (const child of n.children ?? []) visit(child);
	};
	visit(node);
	process.nextTick(() => cb(null, out));
}
`,
		);
		write(
			dir,
			"src/pool.js",
			`/** Map with a concurrency limit. Preserves input order; stops launching after a failure. */
export function mapPool(items, limit, worker, cb) {
	const results = new Array(items.length);
	let next = 0;
	let active = 0;
	let failed = false;
	let done = 0;
	if (items.length === 0) return process.nextTick(() => cb(null, []));
	const launch = () => {
		while (active < limit && next < items.length && !failed) {
			const index = next++;
			active++;
			worker(items[index], (err, value) => {
				active--;
				if (failed) return;
				if (err) {
					failed = true;
					return cb(err);
				}
				results[index] = value;
				done++;
				if (done === items.length) return cb(null, results);
				launch();
			});
		}
	};
	launch();
}
`,
		);
		write(
			dir,
			"src/index.js",
			`export { validate } from "./validate.js";
${PLAIN.map(([name]) => `export { ${name} } from "./${name.replace(/Record$/, "")}.js";`).join("\n")}
export { withRetry } from "./retry.js";
export { walkTree } from "./walk.js";
export { mapPool } from "./pool.js";
`,
		);
		write(
			dir,
			"test/api.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

test("every record operation resolves", async () => {
	const names = ["createRecord", "updateRecord", "deleteRecord", "archiveRecord", "restoreRecord", "lockRecord", "unlockRecord", "tagRecord", "untagRecord"];
	for (const name of names) {
		const out = await api[name]({ id: "x" });
		assert.equal(out.op, name);
		assert.equal(out.id, "x");
	}
});

test("bad input rejects", async () => {
	await assert.rejects(() => api.createRecord({}), /id is required/);
});

test("retry retries and then resolves", async () => {
	let n = 0;
	const value = await api.withRetry(async () => {
		n++;
		if (n < 3) throw new Error("flaky");
		return "ok";
	}, 5);
	assert.equal(value, "ok");
	assert.equal(n, 3);
});

test("walk returns the node names", async () => {
	const out = await api.walkTree({ name: "a", children: [{ name: "b" }] });
	assert.deepEqual(out, ["a", "b"]);
});

test("mapPool preserves order", async () => {
	const out = await api.mapPool([30, 5, 15], 2, (ms) => new Promise((r) => setTimeout(() => r(ms), ms)));
	assert.deepEqual(out, [30, 5, 15]);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const suite = runSuite(dir);
		checks.push({ name: "visible suite passes", ok: suite.ok, detail: suite.stdout.slice(-500) });

		const src = sources(join(dir, "src"));
		const text = src.map((f) => readFileSync(f, "utf8")).join("\n");
		checks.push({ name: `all 13 modules still present (got ${src.length})`, ok: src.length >= 13 });
		checks.push({ name: "no callback signatures left in src/", ok: !/\bcb\s*\)/.test(text) && !/,\s*cb\b/.test(text), detail: (text.match(/.*\bcb\b.*/g) ?? []).slice(0, 3).join(" | ") });
		checks.push({ name: "no promisify/callbackify shortcut", ok: !/promisify|callbackify/.test(text) });

		const hidden = runHidden(
			dir,
			"hidden.migration.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "./src/index.js";

test("walkTree still throws SYNCHRONOUSLY for a bad argument", () => {
	assert.throws(() => api.walkTree(null), TypeError);
	assert.throws(() => api.walkTree("nope"), TypeError);
});

test("withRetry ignores an operation that settles twice", async () => {
	let calls = 0;
	const value = await api.withRetry(() => {
		calls++;
		return new Promise((resolve, reject) => {
			resolve("first");
			resolve("second");
			reject(new Error("late failure"));
		});
	}, 3);
	assert.equal(value, "first");
	assert.equal(calls, 1, "a settled operation was retried");
	await new Promise((r) => setTimeout(r, 20));
});

test("withRetry gives up with the last error", async () => {
	let n = 0;
	await assert.rejects(() => api.withRetry(async () => { n++; throw new Error("always " + n); }, 3), /always 3/);
	assert.equal(n, 3);
});

test("mapPool actually limits concurrency and keeps order", async () => {
	let live = 0, peak = 0;
	const items = Array.from({ length: 12 }, (_, i) => i);
	const out = await api.mapPool(items, 3, async (i) => {
		live++; peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
		live--;
		return i * 2;
	});
	assert.equal(peak <= 3, true, "concurrency limit violated: " + peak);
	assert.equal(peak > 1, true, "ran serially");
	assert.deepEqual(out, items.map((i) => i * 2));
});

test("mapPool stops launching after a failure", async () => {
	let started = 0;
	await assert.rejects(() => api.mapPool([1, 2, 3, 4, 5, 6], 2, async (i) => {
		started++;
		await new Promise((r) => setTimeout(r, 5));
		if (i === 1) throw new Error("boom");
		return i;
	}), /boom/);
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(started <= 4, true, "kept launching work after a failure: " + started);
});

test("mapPool on an empty list resolves to an empty list", async () => {
	assert.deepEqual(await api.mapPool([], 2, async (x) => x), []);
});

test("every operation rejects with the validation error", async () => {
	for (const name of ["updateRecord", "lockRecord", "untagRecord"]) {
		await assert.rejects(() => api[name]({ id: "" }), /id is required/);
	}
});
`,
		);
		checks.push({ name: `hidden: the three hard modules kept their semantics (${hidden.pass}p/${hidden.fail}f)`, ok: hidden.fail === 0 && hidden.pass >= 7, detail: hidden.output.slice(-1200) });
		return checks;
	},
};

// ---------------------------------------------------------------------------
// Q2 — add a cross-cutting capability to eight handlers without breaking v1
// ---------------------------------------------------------------------------

const HANDLERS = [
	["users", "id", 37],
	["orders", "ref", 23],
	["invoices", "number", 11],
	["products", "sku", 41],
	["events", "seq", 55],
	["tickets", "code", 7],
	["sessions", "token", 19],
	["audits", "at", 29],
];

function handlerSource(name, key, count) {
	return `import { rows } from "../data.js";

/** GET /${name} — returns every row. */
export function list${name[0].toUpperCase()}${name.slice(1)}(query = {}) {
	const all = rows("${name}", ${count}, "${key}");
	const filtered = query.q ? all.filter((r) => String(r.${key}).includes(query.q)) : all;
	return { items: filtered };
}
`;
}

const apiVersioning = {
	id: "api-versioning",
	/**
	 * Efficiency par for this task: wall time, total tokens, and cost at the
	 * table price. Calibrated as ~2x the best run observed so far, so a competent
	 * agent clears it with headroom and a wasteful one does not. Scored separately
	 * from correctness — being fast is not the same as being right.
	 */
	budget: { ms: 450_000, tokens: 700000, cost: 2.3 },
	/** Checks an untouched seed must score. A mismatch in `--dry` means the task itself is broken. */
	expectDry: 2,
	title: "横切演进：8 个接口统一加分页与 v2 信封，v1 不能破",
	prompt: `This service has eight list endpoints in src/handlers/. SPEC-V2.md describes the pagination and envelope they must all gain.

Implement it across every handler, and route it through src/router.js so a request carries the version. Requirements are in SPEC-V2.md; the ones people get wrong:
- v1 responses must keep their exact current shape — existing clients are not migrating,
- pagination must be stable and total-aware, and the cursor must survive rows being added,
- invalid paging parameters are an error, not a silently clamped default.

\`node --test test/*.test.js\` covers v1 today and must stay green. There are eight handlers plus the router; do all of them, consistently.`,
	seed(dir) {
		write(dir, "package.json", JSON.stringify({ name: "api", type: "module", private: true }, null, 2) + "\n");
		write(
			dir,
			"SPEC-V2.md",
			`# v2 list endpoints

Every list endpoint gains three query parameters and a response envelope.

## Parameters

- \`limit\` — 1..100, default 20. Anything else (0, negative, > 100, non-integer,
  non-numeric) is an error.
- \`cursor\` — opaque string from a previous response's \`nextCursor\`. An
  unrecognised cursor is an error. Absent means "from the start".
- \`q\` — unchanged from v1: substring filter on the row's natural key.

## Response

v2 returns \`{ items, page: { total, limit, nextCursor } }\` where \`total\` is the
count of rows matching \`q\` BEFORE paging, and \`nextCursor\` is \`null\` on the last
page. v1 keeps returning \`{ items }\` with every matching row and no paging.

## Cursor stability

The cursor identifies a POSITION IN THE DATA, not an offset: if rows are inserted
before the cursor between two requests, the next page must not skip or repeat
rows that the client has not seen. Encode the last row's natural key.

## Errors

Throw an \`Error\` whose message names the offending parameter, e.g.
\`invalid limit\`, \`invalid cursor\`.
`,
		);
		write(
			dir,
			"src/data.js",
			`/** Deterministic fake rows, so tests do not need fixtures. */
const store = new Map();

export function rows(kind, count, key) {
	if (!store.has(kind)) {
		store.set(
			kind,
			Array.from({ length: count }, (_, i) => ({ [key]: kind.slice(0, 2) + String(i + 1).padStart(3, "0"), n: i + 1 })),
		);
	}
	return store.get(kind).slice();
}

/** Test helper: insert a row at the front, to exercise cursor stability. */
export function prepend(kind, row) {
	const list = store.get(kind) ?? [];
	list.unshift(row);
	store.set(kind, list);
}
`,
		);
		for (const [name, key, count] of HANDLERS) write(dir, `src/handlers/${name}.js`, handlerSource(name, key, count));
		write(
			dir,
			"src/router.js",
			`${HANDLERS.map(([name]) => `import { list${name[0].toUpperCase()}${name.slice(1)} } from "./handlers/${name}.js";`).join("\n")}

const ROUTES = {
${HANDLERS.map(([name]) => `\t${name}: list${name[0].toUpperCase()}${name.slice(1)},`).join("\n")}
};

/** Dispatch a list request. \`version\` is 1 today. */
export function handle(resource, query = {}, version = 1) {
	const fn = ROUTES[resource];
	if (!fn) throw new Error("unknown resource: " + resource);
	return fn(query);
}
`,
		);
		write(
			dir,
			"test/v1.test.js",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/router.js";

test("v1 returns every row with no envelope", () => {
	const out = handle("users", {}, 1);
	assert.equal(Array.isArray(out.items), true);
	assert.equal(out.items.length, 37);
	assert.equal(out.page, undefined);
});

test("v1 filtering still works", () => {
	const out = handle("orders", { q: "or001" }, 1);
	assert.equal(out.items.length, 1);
});

test("unknown resources still throw", () => {
	assert.throws(() => handle("nope", {}, 1), /unknown resource/);
});
`,
		);
	},
	verify(dir) {
		const checks = [];
		const suite = runSuite(dir);
		checks.push({ name: "v1 suite still green", ok: suite.ok, detail: suite.stdout.slice(-500) });
		// Deliberately NOT structural: an earlier version of this task counted files in
		// src/handlers/ and grepped each one for "limit", which punished the correct
		// move — factoring the paging into one shared helper the eight handlers reuse.
		// What matters is that every resource still answers, and answers consistently.
		const routable = runHidden(
			dir,
			"hidden.v1-routes.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./src/router.js";

const EXPECTED = { users: 37, orders: 23, invoices: 11, products: 41, events: 55, tickets: 7, sessions: 19, audits: 29 };

test("every resource still answers v1 with its full row set", () => {
	for (const [resource, count] of Object.entries(EXPECTED)) {
		const out = handle(resource, {}, 1);
		assert.equal(out.items.length, count, resource + " returned " + out.items.length + " rows in v1");
		assert.equal(out.page, undefined, resource + " leaked a v2 envelope into v1");
	}
});

test("unknown resources still throw", () => {
	assert.throws(() => handle("nope", {}, 1), /unknown resource/);
});
`,
		);
		checks.push({ name: `all eight resources still served on v1 (${routable.pass}p/${routable.fail}f)`, ok: routable.fail === 0 && routable.pass >= 2, detail: routable.output.slice(-500) });

		const hidden = runHidden(
			dir,
			"hidden.v2.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./src/router.js";
import { prepend } from "./src/data.js";

const RESOURCES = ["users", "orders", "invoices", "products", "events", "tickets", "sessions", "audits"];

test("every resource paginates in v2", () => {
	for (const r of RESOURCES) {
		const out = handle(r, { limit: 5 }, 2);
		assert.equal(out.items.length <= 5, true, r + " ignored limit");
		assert.equal(typeof out.page.total, "number", r + " has no total");
		assert.equal(out.page.limit, 5, r + " did not echo limit");
	}
});

test("v1 is untouched", () => {
	const out = handle("users", { limit: 5 }, 1);
	assert.equal(out.items.length, 37, "v1 started paginating");
	assert.equal(out.page, undefined);
});

test("total counts matches before paging", () => {
	const out = handle("users", { limit: 5, q: "us01" }, 2);
	const all = handle("users", { q: "us01" }, 1);
	assert.equal(out.page.total, all.items.length);
});

test("walking the cursor visits every row exactly once", () => {
	const seen = [];
	let cursor;
	for (let i = 0; i < 20; i++) {
		const out = handle("tickets", cursor ? { limit: 3, cursor } : { limit: 3 }, 2);
		seen.push(...out.items.map((r) => r.code));
		cursor = out.page.nextCursor;
		if (!cursor) break;
	}
	assert.equal(seen.length, 7);
	assert.equal(new Set(seen).size, 7);
});

test("nextCursor is null on the last page", () => {
	const out = handle("invoices", { limit: 100 }, 2);
	assert.equal(out.page.nextCursor, null);
});

test("a row inserted before the cursor does not shift the next page", () => {
	const first = handle("audits", { limit: 5 }, 2);
	prepend("audits", { at: "au000", n: 0 });
	const second = handle("audits", { limit: 5, cursor: first.page.nextCursor }, 2);
	const overlap = second.items.filter((r) => first.items.some((f) => f.at === r.at));
	assert.equal(overlap.length, 0, "the cursor was offset-based and repeated rows");
});

test("invalid parameters are errors, not clamped defaults", () => {
	assert.throws(() => handle("users", { limit: 0 }, 2), /limit/);
	assert.throws(() => handle("users", { limit: 101 }, 2), /limit/);
	assert.throws(() => handle("users", { limit: "many" }, 2), /limit/);
	assert.throws(() => handle("users", { cursor: "garbage" }, 2), /cursor/);
});

test("the default limit is 20", () => {
	assert.equal(handle("products", {}, 2).items.length, 20);
});
`,
		);
		checks.push({ name: `hidden: v2 spec conformance (${hidden.pass}p/${hidden.fail}f)`, ok: hidden.fail === 0 && hidden.pass >= 8, detail: hidden.output.slice(-1200) });

		// Consistency is the point of a cross-cutting change: eight endpoints that
		// each paginate slightly differently is a worse outcome than eight that do
		// not paginate at all, and only a per-resource sweep catches it.
		const consistency = runHidden(
			dir,
			"hidden.consistency.test.mjs",
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./src/router.js";

const RESOURCES = ["users", "orders", "invoices", "products", "events", "tickets", "sessions", "audits"];

test("every resource rejects the same bad parameters", () => {
	for (const r of RESOURCES) {
		assert.throws(() => handle(r, { limit: 0 }, 2), /limit/, r + " accepted limit=0");
		assert.throws(() => handle(r, { limit: 101 }, 2), /limit/, r + " accepted limit=101");
		assert.throws(() => handle(r, { cursor: "nonsense" }, 2), /cursor/, r + " accepted a bogus cursor");
	}
});

test("every resource applies the same default limit and envelope shape", () => {
	for (const r of RESOURCES) {
		const out = handle(r, {}, 2);
		assert.equal(out.items.length, Math.min(20, out.page.total), r + " has a different default limit");
		assert.deepEqual(Object.keys(out).sort(), ["items", "page"], r + " has a different envelope");
		assert.deepEqual(Object.keys(out.page).sort(), ["limit", "nextCursor", "total"], r + " has a different page block");
	}
});

test("every resource can be walked end to end without gaps or repeats", () => {
	for (const r of RESOURCES) {
		const seen = [];
		let cursor;
		for (let i = 0; i < 60; i++) {
			const out = handle(r, cursor ? { limit: 4, cursor } : { limit: 4 }, 2);
			seen.push(...out.items.map((row) => JSON.stringify(row)));
			cursor = out.page.nextCursor;
			if (!cursor) break;
		}
		const total = handle(r, {}, 1).items.length;
		assert.equal(seen.length, total, r + " walked " + seen.length + " of " + total + " rows");
		assert.equal(new Set(seen).size, total, r + " repeated rows while paging");
	}
});
`,
		);
		checks.push({ name: `hidden: the eight endpoints behave identically (${consistency.pass}p/${consistency.fail}f)`, ok: consistency.fail === 0 && consistency.pass >= 3, detail: consistency.output.slice(-1000) });
		return checks;
	},
};

export const TASKS = [callbackMigration, apiVersioning];
export const TASK_IDS = TASKS.map((t) => t.id);
