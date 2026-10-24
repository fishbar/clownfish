/**
 * Smoke: data-lifecycle maintenance.
 *
 *   A. a >90d-idle session is tarred into archive/<YYYY-MM>/<sid>.tgz and its
 *      source dir removed; a fresh session and an ACTIVE session stay put.
 *   B. backup writes clownfish-<ts>.tgz containing the five state members;
 *      older backups beyond keep-7 are pruned.
 *   C. a tar failure surfaces as ok:false (never throws).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runArchive, runBackup, ARCHIVE_AFTER_DAYS } from "../server/maintenance.ts";

const run = promisify(execFile);
const ok = (name: string): void => console.log(`  ✓ ${name}`);
const DAY = 24 * 3600 * 1000;

async function main(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "mnt-data-"));
	const sessionsDir = join(dataDir, "sessions");
	// Shape a realistic dataDir: all five backup members exist.
	await mkdir(join(dataDir, "memory", "applied", "global"), { recursive: true });
	await mkdir(join(dataDir, "projects", "p1"), { recursive: true });
	await writeFile(join(dataDir, "projects.json"), "[]", "utf8");
	await writeFile(join(dataDir, "cron-state.json"), "{}", "utf8");
	await writeFile(join(dataDir, "memory", "applied", "global", "rules.md"), "- test\n", "utf8");
	for (const sid of ["old1", "old-active", "fresh"]) {
		await mkdir(join(sessionsDir, sid), { recursive: true });
		await writeFile(join(sessionsDir, sid, "index.jsonl"), '{"x":1}\n', "utf8");
	}
	// old1: idle since 100d ago (mtime). old-active: same age but has a worker.
	// fresh: touched now.
	const ancient = new Date(Date.now() - (ARCHIVE_AFTER_DAYS + 10) * DAY);
	await utimes(join(sessionsDir, "old1", "index.jsonl"), ancient, ancient);
	await utimes(join(sessionsDir, "old-active", "index.jsonl"), ancient, ancient);

	const times = async () =>
		new Map<string, number>([
			["old1", ancient.getTime()],
			["old-active", ancient.getTime()],
			["fresh", Date.now()],
		]);

	// A: archive.
	const a = await runArchive({
		dataDir,
		sessionsDir,
		sessionTimes: times,
		activeSessions: () => new Set(["old-active"]),
	});
	assert.ok(a.ok);
	assert.equal(a.count, 1);
	const month = new Date().toISOString().slice(0, 7);
	const tgz = join(dataDir, "archive", month, "old1.tgz");
	await readFile(tgz); // exists
	const left = (await readdir(sessionsDir)).sort();
	assert.deepEqual(left, ["fresh", "old-active"]);
	// Archive content round-trips.
	const tmpOut = await mkdtemp(join(tmpdir(), "mnt-x-"));
	await run("tar", ["-xzf", tgz, "-C", tmpOut]);
	assert.equal(await readFile(join(tmpOut, "old1", "index.jsonl"), "utf8"), '{"x":1}\n');
	await rm(tmpOut, { recursive: true, force: true });
	ok("A: 90d-idle session tarred + removed; fresh & active untouched; content round-trips");

	// B: backup.
	const b = await runBackup({ dataDir, sessionsDir });
	assert.ok(b.ok);
	const backups = (await readdir(join(dataDir, "backups"))).filter((f) => f.endsWith(".tgz"));
	assert.equal(backups.length, 1);
	const listing = await run("tar", ["-tzf", join(dataDir, "backups", backups[0])]);
	for (const member of ["memory/", "projects.json", "projects/", "sessions/", "cron-state.json"]) {
		assert.ok(listing.stdout.includes(member), `backup missing ${member}`);
	}
	ok("B: backup tgz contains the five state members");

	// B2: keep-7 prune — write 8 more fake backups, run again, expect 7 left.
	for (let i = 0; i < 8; i++) {
		const f = join(dataDir, "backups", `clownfish-2026-08-0${i}T00-00-00-000Z.tgz`);
		await writeFile(f, "x", "utf8");
	}
	await runBackup({ dataDir, sessionsDir });
	const after = (await readdir(join(dataDir, "backups"))).filter((f) => f.endsWith(".tgz"));
	assert.equal(after.length, 7);
	ok("B: keep-7 prune (9 files → 7)");

	// C: tar failure (archive target root is a FILE → mkdir/rename breaks) →
	// ok:false with an error message, never a throw.
	await writeFile(join(dataDir, "archive-blocker"), "x", "utf8");
	const dead = await runBackup({ dataDir: join(dataDir, "archive-blocker"), sessionsDir });
	assert.equal(dead.ok, false);
	assert.ok(dead.error);
	ok("C: failure surfaces as ok:false with an error message");

	await rm(dataDir, { recursive: true, force: true });
	console.log("smoke-maintenance: all checks passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
