/**
 * Turn checkpoints — an ordered ACTION LOG of everything a turn changed, with
 * enough state to undo each entry.
 *
 * On each user prompt the worker seals the previous checkpoint and opens a new
 * one lazily; the beforeToolCall hook records an action before the tool runs:
 *
 *   file  — `write`/`edit`: the target's current content is copied to
 *           `<root>/<seq>/files/…` (a missing file is a tombstone: restore deletes it).
 *   shell — `bash`: the command can touch anything, so the whole workspace state
 *           is captured instead. Inside a git repository that is `git stash create`
 *           plus the untracked list — O(changed files), exact. Outside git, and only
 *           when the workspace is small enough to copy, it is a full tree copy.
 *           When neither is possible the action is recorded as UNDOABLE:false, and a
 *           restore stops there and says so rather than half-undoing the turn.
 *
 * Restore replays the log in REVERSE, so a shell restore that rewinds the whole
 * tree is followed by the earlier file pre-images, landing on the state before the
 * checkpoint began.
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { snapshot as snapshotTree, restore as restoreTree, type Snapshot, type SnapshotMode } from "./workspace-snapshot";
import { buildIgnore } from "./tools/fs-walk";

/** Keep at most this many recent checkpoints per session (older pruned on seal). */
export const MAX_CHECKPOINTS = 5;
/** Files larger than this are recorded as skipped, not copied (disk guard). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface CheckpointEntry {
	/** Path relative to the workspace cwd. */
	rel: string;
	/** Stored pre-image path, relative to the checkpoint dir (absent for tombstones). */
	stored?: string;
	/** True when the file didn't exist before the turn (restore deletes it). */
	created?: boolean;
	/** Set when the file was NOT snapshotted: "gitignored" | "too_large" (+size). */
	skipped?: { reason: "gitignored" | "too_large"; bytes?: number };
}

/**
 * How a shell action can be undone: a whole-tree snapshot (see
 * `workspace-snapshot.ts`), or an explicit "cannot", which a restore refuses to
 * paper over.
 */
export type ShellRestore = SnapshotMode | { mode: "none"; reason: string };

/** One recorded action, in the order it happened. */
export type CheckpointAction =
	| { kind: "file"; tool: string; rel: string; stored?: string; created?: boolean; ts: number }
	| { kind: "shell"; tool: string; command: string; restore: ShellRestore; ts: number };

export interface CheckpointManifest {
	seq: number;
	ts: number;
	/** File pre-images (also present in `actions`); kept for the existing REST/UI shape. */
	entries: CheckpointEntry[];
	/** The ordered log — the source of truth for a restore. */
	actions?: CheckpointAction[];
}

interface ActiveCheckpoint {
	dir: string;
	manifest: CheckpointManifest;
	seen: Set<string>;
}

export class CheckpointStore {
	private active?: ActiveCheckpoint;
	/** Lazily-built gitignore matcher for the workspace (undefined = not loaded yet). */
	private ig?: Promise<ReturnType<typeof buildIgnore> extends Promise<infer T> ? T : never>;

	/**
	 * @param root `<dataDir>/checkpoints/<sessionId>` — manifests live at
	 *             `<root>/<seq>/manifest.json`, pre-images under `<root>/<seq>/files/`.
	 * @param cwd  workspace root; paths are resolved against it and stored relative.
	 */
	constructor(
		private readonly root: string,
		private readonly cwd: string,
	) {}

	/** Seal the current checkpoint (if any) and close it — call when a new turn starts. */
	async beginTurn(): Promise<void> {
		await this.seal();
		this.active = undefined;
	}

	private ignore(): ReturnType<typeof buildIgnore> {
		this.ig ??= buildIgnore(this.cwd);
		return this.ig;
	}

	private async nextSeq(): Promise<number> {
		let max = 0;
		for (const d of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
			const n = Number(d.name);
			if (d.isDirectory() && Number.isInteger(n) && n > max) max = n;
		}
		return max + 1;
	}

	private async ensureActive(): Promise<ActiveCheckpoint> {
		if (!this.active) {
			const seq = await this.nextSeq();
			this.active = {
				dir: join(this.root, String(seq)),
				manifest: { seq, ts: Date.now(), entries: [], actions: [] },
				seen: new Set(),
			};
		}
		return this.active;
	}

	/** Snapshot `path`'s current content before it gets mutated (idempotent per checkpoint). */
	async captureFile(path: string, tool = "edit"): Promise<void> {
		const ck = await this.ensureActive();
		const abs = isAbsolute(path) ? path : resolvePath(this.cwd, path);
		const rel = relative(this.cwd, abs);
		if (!rel || rel.startsWith("..")) return; // outside the workspace — skip
		if (ck.seen.has(rel)) return;
		ck.seen.add(rel);
		const exists = await stat(abs).then(
			() => true,
			() => false,
		);
		if (!exists) {
			ck.manifest.entries.push({ rel, created: true });
			ck.manifest.actions?.push({ kind: "file", tool, rel, created: true, ts: Date.now() });
		} else if ((await this.ignore()).ignores(rel)) {
			// gitignored build output / secrets are the workspace's own business —
			// restoring them is out of scope. Record the skip so restore can say so.
			ck.manifest.entries.push({ rel, skipped: { reason: "gitignored" } });
		} else {
			const size = (await stat(abs)).size;
			if (size > MAX_FILE_BYTES) {
				ck.manifest.entries.push({ rel, skipped: { reason: "too_large", bytes: size } });
			} else {
				const stored = join("files", rel);
				await mkdir(dirname(join(ck.dir, stored)), { recursive: true });
				await copyFile(abs, join(ck.dir, stored));
				ck.manifest.entries.push({ rel, stored });
				ck.manifest.actions?.push({ kind: "file", tool, rel, stored, ts: Date.now() });
			}
		}
		// Keep the manifest on disk after every capture so even a crashed turn is restorable.
		await this.seal();
	}

	/**
	 * Record the workspace state before a shell command, which may change anything.
	 * Git first (exact and cheap), then a full copy for a small workspace, then an
	 * honest "cannot undo this" marker — never a partial capture pretending to be
	 * complete.
	 */
	async captureShell(command: string): Promise<void> {
		const ck = await this.ensureActive();
		const index = ck.manifest.actions?.length ?? 0;
		const snap = await snapshotTree(this.cwd, join(ck.dir, "shell", String(index), "tree"));
		const restore: ShellRestore = snap
			? snap.mode === "git"
				? { mode: "git", stash: snap.stash, untracked: snap.untracked }
				: // Store the path relative to the checkpoint, so the directory can move.
					{ mode: "copy", dir: join("shell", String(index), "tree") }
			: { mode: "none", reason: "not a git repository, and the workspace is too large to copy" };
		ck.manifest.actions?.push({ kind: "shell", tool: "bash", command: command.slice(0, 500), restore, ts: Date.now() });
		await this.seal();
	}

	/** Write the active checkpoint's manifest (no-op when nothing was captured). */
	async seal(): Promise<void> {
		const ck = this.active;
		if (!ck || (ck.manifest.entries.length === 0 && (ck.manifest.actions?.length ?? 0) === 0)) return;
		await mkdir(ck.dir, { recursive: true });
		await writeFile(join(ck.dir, "manifest.json"), JSON.stringify(ck.manifest, null, 2), "utf8");
		await this.prune();
	}

	/** Drop all but the newest MAX_CHECKPOINTS checkpoints (disk guard). */
	private async prune(): Promise<void> {
		const dirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
		const seqs = dirs
			.filter((d) => d.isDirectory() && Number.isInteger(Number(d.name)))
			.map((d) => Number(d.name))
			.sort((a, b) => b - a);
		for (const old of seqs.slice(MAX_CHECKPOINTS)) {
			await rm(join(this.root, String(old)), { recursive: true, force: true });
		}
	}

	/** All checkpoints for a session root, newest first. */
	static async list(root: string): Promise<CheckpointManifest[]> {
		const out: CheckpointManifest[] = [];
		for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
			if (!d.isDirectory()) continue;
			const raw = await readFile(join(root, d.name, "manifest.json"), "utf8").catch(() => null);
			if (!raw) continue;
			try {
				const m = JSON.parse(raw) as CheckpointManifest;
				if (typeof m.seq === "number" && Array.isArray(m.entries)) out.push(m);
			} catch {
				/* malformed manifest — skip */
			}
		}
		out.sort((a, b) => b.seq - a.seq);
		return out;
	}

	/**
	 * Undo a checkpoint by replaying its action log in REVERSE.
	 *
	 * Reverse order matters: a shell action restores the whole tree to the moment
	 * before that command, so the file pre-images recorded EARLIER must be applied
	 * after it to reach the state before the checkpoint began.
	 *
	 * Stops at the first action that cannot be undone and reports it, rather than
	 * continuing and leaving a tree that is half one version and half another.
	 */
	static async restore(root: string, cwd: string, seq: number): Promise<number> {
		const result = await CheckpointStore.restoreDetailed(root, cwd, seq);
		if (result.blocked) {
			throw new Error(
				`checkpoint ${seq} can only be partially undone: ${result.blocked}. ` +
					`${result.restored} later action(s) were reverted; the workspace is NOT back at the start of the turn.`,
			);
		}
		return result.restored;
	}

	/** Like {@link restore}, but reports what happened instead of throwing. */
	static async restoreDetailed(
		root: string,
		cwd: string,
		seq: number,
	): Promise<{ restored: number; blocked?: string }> {
		const dir = join(root, String(seq));
		const raw = await readFile(join(dir, "manifest.json"), "utf8").catch(() => null);
		if (!raw) throw new Error(`checkpoint ${seq} not found`);
		const m = JSON.parse(raw) as CheckpointManifest;

		// Manifests written before the action log existed only carry file entries;
		// treat them as a file-only log so old checkpoints stay restorable.
		const actions: CheckpointAction[] =
			m.actions && m.actions.length > 0
				? m.actions
				: m.entries.map((e) => ({ kind: "file" as const, tool: "edit", rel: e.rel, stored: e.stored, created: e.created, ts: m.ts }));

		// Replay the log in REVERSE: a shell restore rewinds the whole tree, so the
		// earlier file pre-images must land after it to reach the pre-turn state.
		const skipped: string[] = [];
		let restored = 0;
		for (let i = actions.length - 1; i >= 0; i--) {
			const a = actions[i];
			if (a.kind === "file") {
				const abs = resolvePath(cwd, a.rel);
				// A manifest is data on disk: never write outside the workspace because
				// of what it claims.
				if (isAbsolute(a.rel) || relative(cwd, abs).startsWith("..")) {
					skipped.push(a.rel);
					continue;
				}
				if (a.created) await rm(abs, { force: true });
				else if (a.stored) {
					const src = resolvePath(dir, a.stored);
					if (relative(dir, src).startsWith("..")) {
						skipped.push(a.rel);
						continue;
					}
					await mkdir(dirname(abs), { recursive: true });
					await copyFile(src, abs);
				} else {
					// Recorded but not captured (gitignored / oversize) — nothing to put
					// back, and saying so beats silently claiming a full restore.
					skipped.push(a.rel);
					continue;
				}
				restored++;
				continue;
			}
			const r = a.restore;
			if (r.mode === "none") return { restored, blocked: `a shell command could not be captured (${r.reason})` };
			const snap: Snapshot = r.mode === "git" ? { cwd, mode: "git", stash: r.stash, untracked: r.untracked } : { cwd, mode: "copy", dir: join(dir, r.dir) };
			if (!(await restoreTree(snap))) return { restored, blocked: "restoring the pre-command tree failed" };
			restored++;
		}
		if (skipped.length) {
			return { restored, blocked: `${skipped.length} file(s) not restored (gitignored/oversize/unsafe): ${skipped.join(", ")}` };
		}
		return { restored };
	}

}

/**
 * Extract the mutation-target path from a mutating tool call (write/edit expose a
 * top-level `path` arg). Returns null for tools we don't checkpoint.
 */
export function mutationTarget(toolName: string, args: unknown): string | null {
	if (toolName !== "write" && toolName !== "edit") return null;
	const path = (args as { path?: unknown } | null | undefined)?.path;
	return typeof path === "string" && path.trim() ? path : null;
}
