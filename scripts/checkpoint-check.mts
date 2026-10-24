/**
 * Checkpoint rollback checks: the action log must undo file AND shell changes.
 *
 * The interesting case is the mixed one — an edit, then a bash command that
 * rewrites and deletes things, then another edit. Replaying in reverse has to
 * land exactly on the starting state; anything less is a tree that never existed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../agent/checkpoint";

let checks = 0;
const ok = (name: string, cond: boolean, detail?: string): void => {
	assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
	checks++;
};

async function scenario(useGit: boolean): Promise<void> {
	const label = useGit ? "git" : "copy";
	const cwd = mkdtempSync(join(tmpdir(), `ckpt-${label}-`));
	const root = mkdtempSync(join(tmpdir(), `ckpt-root-`));
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src/a.txt"), "original A\n");
	writeFileSync(join(cwd, "src/b.txt"), "original B\n");
	writeFileSync(join(cwd, "keep.txt"), "keep\n");
	if (useGit) {
		const g = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
		g("init", "-q");
		g("config", "user.email", "t@e.st");
		g("config", "user.name", "t");
		g("add", "-A");
		g("commit", "-qm", "base");
	}

	const store = new CheckpointStore(root, cwd);

	// 1. an edit — pre-image captured
	await store.captureFile(join(cwd, "src/a.txt"), "edit");
	writeFileSync(join(cwd, "src/a.txt"), "EDITED A\n");

	// 2. a bash command that rewrites, deletes and creates — only a whole-tree
	//    capture can undo this
	await store.captureShell("sh -c '…'");
	writeFileSync(join(cwd, "src/b.txt"), "SHELL-REWROTE B\n");
	rmSync(join(cwd, "keep.txt"));
	writeFileSync(join(cwd, "src/new-from-shell.txt"), "created by shell\n");

	// 3. a write of a brand-new file — tombstone
	await store.captureFile(join(cwd, "src/c.txt"), "write");
	writeFileSync(join(cwd, "src/c.txt"), "new C\n");

	await store.seal();
	const result = await CheckpointStore.restoreDetailed(root, cwd, 1);
	ok(`${label}: rollback was not blocked`, !result.blocked, result.blocked);
	ok(`${label}: the edited file is back`, readFileSync(join(cwd, "src/a.txt"), "utf8") === "original A\n");
	ok(`${label}: the SHELL-rewritten file is back`, readFileSync(join(cwd, "src/b.txt"), "utf8") === "original B\n", "bash write not undone");
	ok(`${label}: the shell-deleted file is back`, existsSync(join(cwd, "keep.txt")), "bash delete not undone");
	ok(`${label}: the shell-created file is gone`, !existsSync(join(cwd, "src/new-from-shell.txt")), "bash create not undone");
	ok(`${label}: the newly written file is gone`, !existsSync(join(cwd, "src/c.txt")));

	const manifest = JSON.parse(readFileSync(join(root, "1", "manifest.json"), "utf8"));
	ok(`${label}: the action log records order and kinds`, manifest.actions.map((a: { kind: string }) => a.kind).join(",") === "file,shell,file", JSON.stringify(manifest.actions?.map((a: { kind: string }) => a.kind)));
	ok(`${label}: the shell action recorded its command`, manifest.actions[1].command.length > 0);
	ok(`${label}: the shell restore mode is ${useGit ? "git" : "copy"}`, manifest.actions[1].restore.mode === (useGit ? "git" : "copy"), manifest.actions[1].restore.mode);
}

await scenario(true);
await scenario(false);

// An old manifest without an action log must still restore its file entries.
{
	const cwd = mkdtempSync(join(tmpdir(), "ckpt-legacy-"));
	const root = mkdtempSync(join(tmpdir(), "ckpt-legacy-root-"));
	writeFileSync(join(cwd, "x.txt"), "new\n");
	mkdirSync(join(root, "7", "files"), { recursive: true });
	writeFileSync(join(root, "7", "files", "x.txt"), "old\n");
	writeFileSync(
		join(root, "7", "manifest.json"),
		JSON.stringify({ seq: 7, ts: Date.now(), entries: [{ rel: "x.txt", stored: "files/x.txt" }] }),
	);
	await CheckpointStore.restore(root, cwd, 7);
	ok("a pre-action-log manifest still restores", readFileSync(join(cwd, "x.txt"), "utf8") === "old\n");
}

console.log(`checkpoint rollback: ${checks} checks passed`);
