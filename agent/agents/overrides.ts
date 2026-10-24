/**
 * Agent prompt overrides — copy-on-write edits of any discovered agent.
 *
 * Editing an agent's prompt never touches the file it came from (a built-in
 * shipped with the package, a project asset under version control, a plugin).
 * Instead the effective body is COPIED into
 *
 *   <dataDir>/agent_overwrite/<name>.md
 *
 * which is registered as the highest-precedence discovery root, so it shadows
 * every other source. "Reset" is just deleting that file — the underlying
 * definition reappears untouched.
 *
 * The directory is flat and keyed by agent name, so a name must not be able to
 * escape it; {@link overridePath} rejects anything but a plain stem.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OVERRIDE_DIR = "agent_overwrite";
export const OVERRIDE_SOURCE = "override";

/** Agent names are `.md` filename stems: no separators, no dots, no traversal. */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidAgentName(name: string): boolean {
	return VALID_NAME.test(name) && name.length <= 64;
}

/** Directory holding the override `.md` files (highest-precedence agent root). */
export function overrideDir(dataDir: string): string {
	return join(dataDir, OVERRIDE_DIR);
}

/** Absolute path of one agent's override file. Throws on a name that isn't a plain stem. */
export function overridePath(dataDir: string, name: string): string {
	if (!isValidAgentName(name)) throw new Error(`invalid agent name: ${JSON.stringify(name)}`);
	return join(overrideDir(dataDir), `${name}.md`);
}

/** Names that currently have an override on disk. */
export async function listOverrides(dataDir: string): Promise<string[]> {
	const entries = await readdir(overrideDir(dataDir), { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.slice(0, -3))
		.filter(isValidAgentName);
}

/** Raw override file contents (frontmatter + body), or null when there is none. */
export async function readOverride(dataDir: string, name: string): Promise<string | null> {
	return readFile(overridePath(dataDir, name), "utf8").catch(() => null);
}

/** Write (create or replace) an agent's override. Returns the file written. */
export async function writeOverride(dataDir: string, name: string, content: string): Promise<string> {
	const file = overridePath(dataDir, name);
	await mkdir(overrideDir(dataDir), { recursive: true });
	await writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	return file;
}

/** Drop an agent's override (the "reset" action). False when there was none. */
export async function removeOverride(dataDir: string, name: string): Promise<boolean> {
	const file = overridePath(dataDir, name);
	if ((await readFile(file, "utf8").catch(() => null)) === null) return false;
	await rm(file, { force: true });
	return true;
}
