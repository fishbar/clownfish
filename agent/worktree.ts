/**
 * Git worktree helpers — file isolation for async coding DAGs.
 *
 * An async dagRoot whose task touches code should not write the user's working
 * tree: {@link createWorktree} checks out a new branch in a linked worktree
 * under `<dataDir>/worktrees/<sessionId>/<branch>/`, so the main workspace stays
 * untouched while the DAG runs. {@link mergeWorktree} fast-forward/merges the
 * branch back when the user accepts; {@link removeWorktree} prunes either way.
 *
 * Plain git CLI over execFile — no dependency. Every path is best-effort with
 * readable errors: a worktree failure degrades the workflow to a normal run
 * rather than killing it.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateId } from "./id";

const exec = promisify(execFile);

function git(cwd: string, ...args: string[]): Promise<string> {
	return exec("git", args, { cwd, encoding: "utf8" }).then((r) => r.stdout.trim());
}

/** Is `dir` inside a git work tree (and is git available)? */
export async function isGitRepo(dir: string): Promise<boolean> {
	try {
		const out = await git(dir, "rev-parse", "--is-inside-work-tree");
		return out === "true";
	} catch {
		return false;
	}
}

export interface WorktreeInfo {
	/** Absolute path of the created worktree (the dagRoot's cwd). */
	path: string;
	/** Branch checked out in the worktree. */
	branch: string;
	/** Short commit sha the branch started from. */
	baseSha: string;
	/** True if the branch carries new commits (merge does something). */
	dirty: boolean;
}

/**
 * Create a linked worktree on a new branch. `slug` (from the goal) only names
 * the branch; uniqueness comes from the short random suffix (a session may run
 * several concurrent workflows, each with its own branch).
 */
export async function createWorktree(repoDir: string, parentDir: string, slug: string): Promise<WorktreeInfo> {
	const safe = slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24) || "task";
	const branch = `clownfish/${safe}-${generateId().slice(0, 8)}`;
	await mkdir(parentDir, { recursive: true });
	const path = join(parentDir, branch.replace(/\//g, "-"));
	const baseSha = await git(repoDir, "rev-parse", "--short", "HEAD");
	// `git worktree add` creates the branch at HEAD in one step.
	await git(repoDir, "worktree", "add", "-b", branch, path, "HEAD");
	return { path, branch, baseSha, dirty: false };
}

/** Does `branch` have commits HEAD doesn't (i.e. is there anything to merge)? */
export async function branchHasCommits(repoDir: string, branch: string): Promise<boolean> {
	try {
		const out = await git(repoDir, "rev-list", "--count", `HEAD..${branch}`);
		return Number(out) > 0;
	} catch {
		return false;
	}
}

/** Merge the worktree branch back into the current branch. */
export async function mergeWorktree(repoDir: string, branch: string): Promise<string> {
	try {
		return await git(repoDir, "merge", "--no-edit", branch);
	} catch (err) {
		// A failed merge (conflicts) leaves the MAIN repo mid-merge — index full
		// of conflict stages, MERGE_HEAD present. Every later git op would run
		// inside a half-open merge; abort back to the pre-merge state, then let
		// the caller's error handling report it (worktree + branch are kept).
		await git(repoDir, "merge", "--abort").catch(() => undefined);
		throw err;
	}
}

/** Does the worktree hold uncommitted changes? (Gone dir → false; removal no-ops.) */
export async function worktreeDirty(path: string): Promise<boolean> {
	try {
		const out = await git(path, "status", "--porcelain");
		return out.length > 0;
	} catch {
		return false;
	}
}

/** Remove the worktree dir + its branch (safe whether or not it was merged). */
export async function removeWorktree(repoDir: string, path: string, branch: string): Promise<void> {
	await git(repoDir, "worktree", "remove", "--force", path).catch(() => undefined);
	await git(repoDir, "branch", "-D", branch).catch(() => undefined);
	await git(repoDir, "worktree", "prune").catch(() => undefined);
}
