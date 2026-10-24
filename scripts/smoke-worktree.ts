/**
 * worktree helper smoke test — real git operations, no LLM.
 *
 * Creates a scratch repo, verifies create → dirty check → merge → remove, plus
 * the isGitRepo guard for non-git dirs. Run: `npx tsx scripts/smoke-worktree.ts`
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { branchHasCommits, createWorktree, isGitRepo, mergeWorktree, removeWorktree } from "../agent/worktree";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
	exec("git", args, { cwd, encoding: "utf8" }).then((r) => r.stdout.trim());

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);

	const base = await mkdtemp(join(tmpdir(), "clownfish-wt-"));
	try {
		const repo = join(base, "repo");
		await exec("git", ["init", "-q", repo], { encoding: "utf8" });
		await git(repo, "config", "user.email", "t@t");
		await git(repo, "config", "user.name", "t");
		await writeFile(join(repo, "a.txt"), "hello\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-qm", "init");

		// 1. isGitRepo
		assert.equal(await isGitRepo(repo), true);
		assert.equal(await isGitRepo(base), false, "parent dir of a repo is not itself a work tree");
		ok("isGitRepo true in repo, false outside");

		// 2. create: new branch checked out at HEAD, isolated dir
		const wt = await createWorktree(repo, join(base, "wts"), "Do the BIG feature!!");
		assert.match(wt.branch, /^clownfish\/do-the-big-feature-[A-Za-z0-9]{8}$/);
		await stat(join(wt.path, "a.txt"));
		// The main checkout stays on its original branch; the worktree is on the new one.
		assert.notEqual(await git(repo, "symbolic-ref", "--short", "HEAD"), wt.branch);
		assert.equal(await git(wt.path, "symbolic-ref", "--short", "HEAD"), wt.branch);
		ok(`worktree created on '${wt.branch}' without touching the main checkout`);

		// 3. clean worktree branch has nothing to merge
		assert.equal(await branchHasCommits(repo, wt.branch), false);
		ok("branchHasCommits false for a clean branch");

		// 4. commit in the worktree → mergeable
		await writeFile(join(wt.path, "b.txt"), "from the workflow\n");
		await git(wt.path, "add", ".");
		await git(wt.path, "commit", "-qm", "work");
		assert.equal(await branchHasCommits(repo, wt.branch), true);

		// 5. merge back
		await mergeWorktree(repo, wt.branch);
		assert.equal(await branchHasCommits(repo, wt.branch), false, "merged — no commits ahead of HEAD");
		await stat(join(repo, "b.txt"));
		ok("mergeWorktree fast-forwards the branch into the main checkout");

		// 6. remove prunes dir + branch (already merged — clean removal)
		await removeWorktree(repo, wt.path, wt.branch);
		await assert.rejects(stat(wt.path));
		const branches = await git(repo, "branch", "--list", wt.branch);
		assert.equal(branches, "");
		ok("removeWorktree prunes the dir and the branch");
	} finally {
		await rm(base, { recursive: true, force: true });
	}

	console.log(`smoke-worktree: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-worktree FAILED:", err);
	process.exit(1);
});
