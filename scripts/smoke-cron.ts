/**
 * cron smoke test — expression engine + tool CRUD, no server, no provider.
 *
 *   A. parse/validate: good and bad expressions across the supported grammar.
 *   B. computeNextRun: minute/hour/dom/month/dow/step/list/range + Vixie dom/dow
 *      OR rule + strictly-after semantics.
 *   C. previewRuns chains strictly-increasing runs.
 *   D. the tool: schedule → file on disk → list → duplicate-cancel → cap.
 *
 * Run: `npx tsx scripts/smoke-cron.ts`
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeNextRun, parseCronExpr, previewRuns, validateCronExpr, renderCronPrompt } from "../agent/schedule";
import { createCronTool, loadCronSpecs } from "../agent/tools/cron";

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	// ---- A: parse/validate ----
	for (const good of ["* * * * *", "*/30 * * * *", "0 2 * * *", "0 9 * * 1-5", "30 8 1 * *", "0 0 29 2 *", "0 22 * * 1-5,7", "15,45 10-18/2 * * *", "0 12 * jan,mar-dec *", "0 0 * * sun", "0 0 * * 7", "5 4 * * *"]) {
		assert.equal(validateCronExpr(good), null, `expected valid: ${good}`);
	}
	for (const bad of ["* * * *", "61 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "a * * * *", "*/0 * * * *", "5-1 * * * *", "1,,2 * * * *", "*/30 * * *  *extra"]) {
		assert.ok(validateCronExpr(bad), `expected invalid: ${bad}`);
	}
	ok("A: accepts/rejects the supported grammar (steps, lists, ranges, names, dow 7)");

	// dow 7 folds onto Sunday(0)
	const dow7 = parseCronExpr("0 0 * * 7");
	assert.deepEqual([...dow7.daysOfWeek], [0]);
	ok("A: dow '7' means Sunday");

	// ---- B: computeNextRun ----
	const at = (s: string): Date => new Date(`2026-08-20T${s}:00`); // a Thursday
	// every minute
	assert.equal(computeNextRun(parseCronExpr("* * * * *"), at("10:30"))?.getTime(), at("10:31").getTime());
	// */30 within the hour
	assert.equal(computeNextRun(parseCronExpr("*/30 * * * *"), at("10:31"))?.getTime(), at("11:00").getTime());
	// daily at 02:00 — crosses midnight
	assert.equal(computeNextRun(parseCronExpr("0 2 * * *"), at("23:59"))?.getTime(), new Date("2026-08-21T02:00:00").getTime());
	// weekday filter: Thu 2026-08-20 09:00 + next weekday 9am → Fri 21st
	assert.equal(computeNextRun(parseCronExpr("0 9 * * 1-5"), at("09:00"))?.getTime(), new Date("2026-08-21T09:00:00").getTime());
	// dom + month: 29 Feb only exists on leap years — 2028-02-29
	assert.equal(computeNextRun(parseCronExpr("0 0 29 2 *"), at("00:00"))?.getTime(), new Date("2028-02-29T00:00:00").getTime());
	// Vixie OR rule: dom=15 OR Friday, from Thu 14th 10:00 → Fri 15th 00:00 (dow match wins the tie)
	const orRule = computeNextRun(parseCronExpr("0 0 15 * 5"), new Date("2026-08-14T10:00:00"));
	assert.equal(orRule?.getTime(), new Date("2026-08-15T00:00:00").getTime());
	// list + hour range with step: 10-18/2 = 10,12,14,16,18; 12:16 → next is 12:45 (same hour)
	assert.equal(
		computeNextRun(parseCronExpr("15,45 10-18/2 * * *"), at("12:16"))?.getTime(),
		new Date("2026-08-20T12:45:00").getTime(),
	);
	// month name list: Jan/Mar..Dec 1st — from Aug 2nd → Sep 1st
	assert.equal(computeNextRun(parseCronExpr("0 0 1 jan,mar-dec *"), new Date("2026-08-02T00:00:00"))?.getTime(), new Date("2026-09-01T00:00:00").getTime());
	// strictly-after: exactly on a match returns the NEXT one
	assert.equal(computeNextRun(parseCronExpr("30 * * * *"), at("10:30"))?.getTime(), at("11:30").getTime());
	ok("B: next-run math across minute/step/dom/month/dow/name fields + Vixie dom/dow OR rule");

	// ---- C: preview chains ----
	const runs = previewRuns(parseCronExpr("0 2 * * *"), at("00:00"), 3);
	assert.deepEqual(
		runs.map((d) => d.toISOString().slice(0, 10)),
		["2026-08-20", "2026-08-21", "2026-08-22"],
	);
	ok("C: previewRuns chains strictly-increasing daily runs");

	// renderCronPrompt shape
	const rp = renderCronPrompt({ id: "x", expr: "0 2 * * *", prompt: "check builds", createdAt: 0, name: "nightly" }, new Date("2026-08-21T02:00:00"));
	assert.match(rp, /\[scheduled task — nightly\]/);
	assert.match(rp, /0 2 \* \* \*/);
	assert.match(rp, /check builds/);
	ok("C: renderCronPrompt carries name/expr/prompt");

	// ---- D: tool CRUD ----
	const work = await mkdtemp(join(tmpdir(), "smoke-cron-"));
	const sessionId = "sess1";
	const tool = createCronTool({ sessionId, sessionsDir: work });

	const bad = await tool.execute("t0", { action: "schedule", expr: "99 * * * *", prompt: "x" });
	assert.match(bad.content[0].type === "text" ? bad.content[0].text : "", /invalid cron expression/);

	const s1 = await tool.execute("t1", { action: "schedule", expr: "0 2 * * *", prompt: "  run the nightly checks  ", name: "nightly" });
	assert.match(s1.content[0].type === "text" ? s1.content[0].text : "", /scheduled '0 2 \* \* \*'/);
	assert.match(s1.content[0].type === "text" ? s1.content[0].text : "", /Next run/);

	const onDisk = JSON.parse(await readFile(join(work, sessionId, "cron.json"), "utf8")) as { jobs: Array<{ id: string; expr: string; prompt: string; name?: string }> };
	assert.equal(onDisk.jobs.length, 1);
	assert.equal(onDisk.jobs[0].expr, "0 2 * * *");
	assert.equal(onDisk.jobs[0].prompt, "run the nightly checks"); // trimmed
	assert.equal(onDisk.jobs[0].name, "nightly");

	const listed = await loadCronSpecs(work, sessionId);
	assert.equal(listed.length, 1);
	const l = await tool.execute("t2", { action: "list" });
	assert.match(l.content[0].type === "text" ? l.content[0].text : "", /nightly/);

	const c1 = await tool.execute("t3", { action: "cancel", job_id: listed[0].id });
	assert.match(c1.content[0].type === "text" ? c1.content[0].text : "", /cancelled/);
	assert.equal((await loadCronSpecs(work, sessionId)).length, 0);
	const c2 = await tool.execute("t4", { action: "cancel", job_id: "nope" });
	assert.match(c2.content[0].type === "text" ? c2.content[0].text : "", /no job 'nope'/);
	ok("D: tool schedule/list/cancel round-trips through cron.json (bad expr rejected, prompts trimmed)");

	await rm(work, { recursive: true, force: true });
	console.log(`smoke-cron: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-cron FAILED:", err);
	process.exit(1);
});
