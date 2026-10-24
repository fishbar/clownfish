/**
 * Whole-tree snapshots — the single primitive behind both checkpoint rollback of
 * a `bash` command and rollback of a failed delegation.
 *
 * A shell command can touch anything, so undoing one means restoring the tree,
 * not a list of files. Two strategies, in order of preference:
 *
 *   git  — `git stash create` records the full tracked state as one object and
 *          untracked paths are enumerated; O(changed files) and exact.
 *   copy — for a workspace small enough to copy, the tree itself is the snapshot.
 *
 * When neither applies the snapshot is null and the caller must NOT pretend it
 * can undo anything: a partial rollback leaves a tree that never existed, which
 * is worse than no rollback at all.
 *
 * Limits, stated rather than hidden: git mode does not restore ignored files, and
 * `.git` itself is untouched — a sub-agent that commits or switches branches is
 * not undone by this. Copy mode skips the directories in {@link SKIP_DIRS}.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Directories never worth snapshotting — huge, and rebuildable. */
export const SKIP_DIRS = new Set([".git", "node_modules", ".bench", "dist", "build", ".next", "target", "__pycache__", ".venv"]);

/** Workspaces above this size are not copied (bytes). */
const COPY_LIMIT = Number(process.env.CLOWNFISH_CHECKPOINT_COPY_LIMIT ?? 64 * 1024 * 1024);

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	try {
		const { stdout } = await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
		return { ok: true, out: stdout.trim() };
	} catch (err) {
		return { ok: false, out: (err as { stderr?: string }).stderr ?? String(err) };
	}
}

/** How a snapshot can be put back. */
export type SnapshotMode =
	| { mode: "git"; stash: string | null; untracked: string[] }
	| { mode: "copy"; dir: string };

/** A snapshot is how to restore it, plus where. */
export type Snapshot = SnapshotMode & { cwd: string };

/** Total size of the copyable tree, or null once it exceeds `limit`. */
async function treeSize(dir: string, limit: number): Promise<number | null> {
	let total = 0;
	const walk = async (d: string): Promise<boolean> => {
		for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				if (!(await walk(join(d, e.name)))) return false;
			} else if (e.isFile()) {
				total += (await stat(join(d, e.name)).catch(() => null))?.size ?? 0;
				if (total > limit) return false;
			}
		}
		return true;
	};
	return (await walk(dir)) ? total : null;
}

/**
 * Snapshot the workspace. `copyInto` is where a copy-mode snapshot is written;
 * omit it to allow only git mode. Returns null when the tree cannot be captured
 * exactly — the caller must then not offer a rollback.
 */
export async function snapshot(cwd: string, copyInto?: string): Promise<Snapshot | null> {
	const isRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (isRepo.ok && isRepo.out === "true") {
		const stash = await git(cwd, ["stash", "create"]);
		if (stash.ok) {
			const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
			return {
				cwd,
				mode: "git",
				// An empty result means the worktree matched HEAD — nothing to stash.
				stash: stash.out || null,
				untracked: untracked.ok ? untracked.out.split("\n").filter(Boolean) : [],
			};
		}
	}
	if (!copyInto || (await treeSize(cwd, COPY_LIMIT)) === null) return null;
	await mkdir(copyInto, { recursive: true });
	await cp(cwd, copyInto, {
		recursive: true,
		filter: (src) => src === cwd || !SKIP_DIRS.has(src.slice(cwd.length + 1).split("/")[0] ?? ""),
	});
	return { cwd, mode: "copy", dir: copyInto };
}

/** Delete workspace files a copy snapshot does not have. */
async function pruneToSnapshot(cwd: string, snapshotDir: string): Promise<void> {
	const walk = async (rel: string): Promise<void> => {
		for (const e of await readdir(rel ? join(cwd, rel) : cwd, { withFileTypes: true }).catch(() => [])) {
			if (SKIP_DIRS.has(e.name)) continue;
			const childRel = rel ? join(rel, e.name) : e.name;
			const present = await stat(join(snapshotDir, childRel)).then(
				() => true,
				() => false,
			);
			if (!present) {
				await rm(join(cwd, childRel), { force: true, recursive: true }).catch(() => {});
				continue;
			}
			if (e.isDirectory()) await walk(childRel);
		}
	};
	await walk("");
}

/**
 * Put the workspace back the way {@link snapshot} found it: tracked files are
 * checked out from the snapshot (or HEAD when it was clean), and untracked files
 * that appeared since are deleted. Returns false when the restore could not be
 * done cleanly, so the caller can say so instead of assuming.
 */
export async function restore(snap: Snapshot): Promise<boolean> {
	if (snap.mode === "copy") {
		await pruneToSnapshot(snap.cwd, snap.dir);
		await cp(snap.dir, snap.cwd, { recursive: true, force: true });
		return true;
	}
	const source = snap.stash ?? "HEAD";
	const checkout = await git(snap.cwd, ["checkout", source, "--", "."]);
	if (!checkout.ok) return false;
	const now = await git(snap.cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (now.ok) {
		const before = new Set(snap.untracked);
		for (const path of now.out.split("\n").filter(Boolean)) {
			if (!before.has(path)) await rm(join(snap.cwd, path), { force: true, recursive: true }).catch(() => {});
		}
	}
	return true;
}
