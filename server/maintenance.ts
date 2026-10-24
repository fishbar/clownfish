/**
 * Data-lifecycle maintenance — scheduler-internal recurring tasks.
 *
 *   archive: tar sessions untouched for ARCHIVE_AFTER_DAYS into
 *            `<dataDir>/archive/<YYYY-MM>/<sessionId>.tgz`, then remove the
 *            source dir. The distiller's cursors naturally stop advancing for
 *            archived sessions (no new transcript lines), and the session
 *            indexes (projects/<pid>/sessions.json) keep their entries — a
 *            historical session simply has no on-disk transcript until
 *            restored. Never touches a session the server currently runs.
 *
 *   backup:  tar the irreplaceable state (memory/, projects.json, projects/,
 *            sessions/, cron-state.json) into `<dataDir>/backups/<ts>.tgz`,
 *            keep the newest BACKUP_KEEP.
 *
 * Both are bounded, failure-isolated (each catch logs and returns ok:false —
 * the scheduler treats a thrown task as a failed occurrence) and opt-out-able
 * via env (CLOWNFISH_ARCHIVE=0 / CLOWNFISH_BACKUP=0), like the distiller.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";

const log = logger.child({ module: "maintenance" });
const run = promisify(execFile);

export const ARCHIVE_AFTER_DAYS = 90;
export const BACKUP_KEEP = 7;
const DAY_MS = 24 * 3600 * 1000;

export interface MaintenanceSummary {
	kind: "archive" | "backup";
	/** Sessions archived / backup file written. */
	count: number;
	ok: boolean;
	error?: string;
}

/** A session is "untouched" when BOTH its index.jsonl mtime and the store's
 *  updatedAt are older than the horizon (a cron turn updates the transcript). */
async function lastTouched(sessionsDir: string, sessionId: string, fallback: number): Promise<number> {
	const mtime = await stat(join(sessionsDir, sessionId, "index.jsonl")).then((s) => s.mtimeMs).catch(() => 0);
	return Math.max(mtime, fallback);
}

/** tar+gzip an entire directory (archive root = the dir's basename). */
async function tarTree(src: string, dest: string): Promise<void> {
	await mkdir(join(dest, ".."), { recursive: true });
	await run("tar", ["-czf", dest, "-C", join(src, ".."), src.split("/").pop()!], { timeout: 5 * 60_000 });
}

/** tar+gzip named members (relative to `root`) into dest. */
async function tarMembers(root: string, dest: string, members: string[]): Promise<void> {
	await mkdir(join(dest, ".."), { recursive: true });
	await run("tar", ["-czf", dest, "-C", root, ...members], { timeout: 5 * 60_000 });
}

export async function runArchive(opts: {
	dataDir: string;
	sessionsDir: string;
	/** sessionId → updatedAt (ms) from the session stores; missing = dir-only. */
	sessionTimes: () => Promise<Map<string, number>>;
	/** Session ids with a live worker right now — archived never, whatever age. */
	activeSessions: () => Set<string>;
}): Promise<MaintenanceSummary> {
	const horizon = Date.now() - ARCHIVE_AFTER_DAYS * DAY_MS;
	const month = new Date().toISOString().slice(0, 7); // YYYY-MM
	const destDir = join(opts.dataDir, "archive", month);
	let count = 0;
	try {
		for (const entry of await readdir(opts.sessionsDir, { withFileTypes: true }).catch(() => [])) {
			if (!entry.isDirectory()) continue;
			const sid = entry.name;
			if (opts.activeSessions().has(sid)) continue;
			const times = await opts.sessionTimes();
			const touched = await lastTouched(opts.sessionsDir, sid, times.get(sid) ?? 0);
			if (touched >= horizon) continue;
			const src = join(opts.sessionsDir, sid);
			// Staging name first: a half-written .tgz must never look complete.
			const staging = join(destDir, `.${sid}.partial.tgz`);
			await tarTree(src, staging);
			await rename(staging, join(destDir, `${sid}.tgz`));
			await rm(src, { recursive: true, force: true });
			count++;
			log.info("archived session %s (last touched %s)", sid, new Date(touched).toISOString());
		}
		return { kind: "archive", count, ok: true };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error({ err: error }, "archive run failed");
		return { kind: "archive", count, ok: false, error };
	}
}

export async function runBackup(opts: { dataDir: string; sessionsDir: string }): Promise<MaintenanceSummary> {
	const backupsDir = join(opts.dataDir, "backups");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	try {
		// Staging index file: tar with an explicit member list (no globbing races).
		const staging = join(backupsDir, `.clownfish-${stamp}.partial.tgz`);
		await tarMembers(opts.dataDir, staging, ["memory", "projects.json", "projects", "sessions", "cron-state.json"]);
		await rename(staging, join(backupsDir, `clownfish-${stamp}.tgz`));
		// Prune to the newest BACKUP_KEEP.
		const keep = (await readdir(backupsDir))
			.filter((f) => f.startsWith("clownfish-") && f.endsWith(".tgz"))
			.sort()
			.slice(-BACKUP_KEEP);
		for (const f of await readdir(backupsDir)) {
			if (f.startsWith("clownfish-") && f.endsWith(".tgz") && !keep.includes(f)) {
				await rm(join(backupsDir, f), { force: true });
			}
		}
		log.info("backup written (%d kept)", keep.length);
		return { kind: "backup", count: 1, ok: true };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error({ err: error }, "backup run failed");
		return { kind: "backup", count: 0, ok: false, error };
	}
}

