/**
 * Recursive workspace walker that skips heavy/ignored directories, honours
 * .gitignore at EVERY level (not just the root), and is used by grep/find.
 *
 * Nested .gitignore files were the difference between a 70ms walk and a 6.5s
 * search in this very repo: `app/mac/.gitignore` excludes `target/` (791MB of
 * Rust build output) and `Clownfish.app` (131MB, two bun binaries), and the
 * root-only reader could not see either — so every search read them.
 */
import ignore, { type Ignore } from "ignore";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_IGNORE = [".git", "node_modules", ".DS_Store", "dist", "build", ".next", ".cache", "coverage", ".turbo", ".parcel-cache", "out", "target"];

export interface WalkOptions {
	maxFiles?: number;
	extraIgnore?: string[];
}

/** One .gitignore, and the directory its rules are relative to. */
interface ScopedIgnore {
	/** Directory the rules apply to, relative to the walk root ("" = root). */
	base: string;
	ig: Ignore;
}

export async function buildIgnore(root: string, extraIgnore?: string[]) {
	const ig = ignore();
	ig.add(DEFAULT_IGNORE);
	if (extraIgnore) ig.add(extraIgnore);
	const gitignore = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
	if (gitignore) ig.add(gitignore);
	return ig;
}

/** Load `<dir>/.gitignore` as a scoped rule set, or undefined when absent. */
async function loadScoped(root: string, dir: string): Promise<ScopedIgnore | undefined> {
	const text = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
	if (!text.trim()) return undefined;
	const ig = ignore();
	ig.add(text);
	return { base: relative(root, dir), ig };
}

/**
 * Is this path ignored? Scopes are consulted INNERMOST FIRST and the first
 * one that makes a decision — ignored OR explicitly un-ignored (`!keep`) —
 * wins, which is git's own precedence: a nested `!important.log` overrides an
 * outer `*.log`. A first-match-ignores loop was measured to drop files git
 * keeps. Each scope tests the path relative to its own directory.
 */
function isIgnored(scopes: ScopedIgnore[], rel: string, isDir: boolean): boolean {
	const probe = isDir ? `${rel}/` : rel;
	for (let i = scopes.length - 1; i >= 0; i--) {
		const s = scopes[i];
		let sub = probe;
		if (s.base) {
			const prefix = `${s.base}/`;
			if (!probe.startsWith(prefix)) continue;
			sub = probe.slice(prefix.length);
		}
		const r = s.ig.test(sub);
		if (r.unignored) return false;
		if (r.ignored) return true;
	}
	return false;
}

export async function walkFiles(root: string, options?: WalkOptions): Promise<string[]> {
	const base = ignore();
	base.add(DEFAULT_IGNORE);
	if (options?.extraIgnore) base.add(options.extraIgnore);
	const rootScopes: ScopedIgnore[] = [{ base: "", ig: base }];
	const rootGitignore = await loadScoped(root, root);
	if (rootGitignore) rootScopes.push(rootGitignore);

	const maxFiles = options?.maxFiles ?? 20000;
	const results: string[] = [];
	let stopped = false;

	async function walk(dir: string, scopes: ScopedIgnore[]): Promise<void> {
		if (stopped) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// A .gitignore in THIS directory applies to everything below it.
		let scoped = scopes;
		if (dir !== root && entries.some((e) => e.isFile() && e.name === ".gitignore")) {
			const own = await loadScoped(root, dir);
			if (own) scoped = [...scopes, own];
		}
		for (const entry of entries) {
			if (stopped) return;
			const abs = join(dir, entry.name);
			const rel = relative(root, abs);
			if (isIgnored(scoped, rel, entry.isDirectory())) continue;
			if (entry.isDirectory()) {
				await walk(abs, scoped);
			} else if (entry.isFile()) {
				results.push(abs);
				if (results.length >= maxFiles) stopped = true;
			}
		}
	}

	await walk(root, rootScopes);
	return results;
}
