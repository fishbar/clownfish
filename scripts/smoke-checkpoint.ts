/**
 * Smoke: checkpoint retention + capture exemptions.
 *
 *   A. 7 sealed checkpoints → only the newest 5 dirs survive on disk.
 *   B. a gitignored file is NOT snapshotted (manifest records skipped:gitignored).
 *   C. an 11MB file is recorded as skipped:too_large, not copied.
 *   D. a normal file round-trips: capture → mutate → restore puts content back.
 *   E. restore reports skipped files in its error instead of silently passing.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, MAX_CHECKPOINTS, MAX_FILE_BYTES } from "../agent/checkpoint.ts";

const ok = (name: string): void => console.log(`  ✓ ${name}`);

async function main(): Promise<void> {
	// Workspace with a .gitignore covering "build/".
	const cwd = await mkdtemp(join(tmpdir(), "ck-ws-"));
	await writeFile(join(cwd, ".gitignore"), "build/\n", "utf8");
	await mkdir(join(cwd, "build"), { recursive: true });
	await writeFile(join(cwd, "build", "out.js"), "old", "utf8");
	await writeFile(join(cwd, "normal.txt"), "before", "utf8");
	const ckRoot = await mkdtemp(join(tmpdir(), "ck-store-"));
	const store = new CheckpointStore(ckRoot, cwd);

	// B/C: capture gitignored + oversize + normal in the first checkpoint.
	const bigPath = join(cwd, "big.bin");
	await writeFile(bigPath, Buffer.alloc(MAX_FILE_BYTES + 1024, 1));
	await store.captureFile("build/out.js");
	await store.captureFile("big.bin");
	await store.captureFile("normal.txt");
	const first = (await CheckpointStore.list(ckRoot))[0];
	const byRel = new Map(first.entries.map((e) => [e.rel, e]));
	assert.equal(byRel.get("build/out.js")?.skipped?.reason, "gitignored");
	assert.equal(byRel.get("big.bin")?.skipped?.reason, "too_large");
	assert.equal(byRel.get("normal.txt")?.stored, "files/normal.txt");
	ok("B/C: gitignored & >10MB entries recorded as skipped, normal file snapshotted");
	await store.beginTurn(); // close checkpoint seq 1 before opening more

	// No pre-image was written for the exempt files.
	const filesDir = join(ckRoot, String(first.seq), "files");
	const stored = await readdir(filesDir, { recursive: true });
	assert.ok(!stored.some((f) => f.includes("out.js") || f.includes("big.bin")));
	ok("B/C: no disk copies made for exempt entries");

	// E: restoring a checkpoint with skipped entries reports them.
	await assert.rejects(
		() => CheckpointStore.restore(ckRoot, cwd, first.seq),
		/not restored .*build\/out\.js, big\.bin/,
	);
	ok("E: restore names skipped entries instead of silently passing");

	// A: seal 6 more checkpoints (seq 2..7) → only newest 5 remain.
	for (let i = 0; i < 6; i++) {
		const p = join(cwd, `f${i}.txt`);
		await writeFile(p, String(i), "utf8");
		await store.captureFile(p);
		await store.beginTurn();
	}
	const dirs = (await readdir(ckRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => Number(d.name)).sort((a, b) => a - b);
	assert.equal(dirs.length, MAX_CHECKPOINTS);
	assert.deepEqual(dirs, [3, 4, 5, 6, 7]); // seq 1..2 pruned, 3..7 kept
	ok(`A: 8 sealed checkpoints → newest ${MAX_CHECKPOINTS} kept (3..7)`);

	// D: restore round-trip on the surviving normal checkpoint (seq 7 = f5.txt's).
	await writeFile(join(cwd, "f5.txt"), "mutated", "utf8");
	await CheckpointStore.restore(ckRoot, cwd, 7);
	assert.equal(await readFile(join(cwd, "f5.txt"), "utf8"), "5");
	ok("D: capture → mutate → restore round-trips content");

	// touch newer mtime so tmp cleanup order doesn't matter
	await utimes(join(cwd, "normal.txt"), new Date(), new Date());
	await rm(cwd, { recursive: true, force: true });
	await rm(ckRoot, { recursive: true, force: true });
	console.log("smoke-checkpoint: all checks passed");
	void stat;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
