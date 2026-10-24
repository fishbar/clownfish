/**
 * Path resolution shared by everything that reads an operator-configured
 * directory: tools, skill/agent/plugin/command discovery, and the server's path
 * autocomplete.
 *
 * There were five byte-identical copies of `expandTilde` and four of the
 * resolve-against-cwd helper under different names. One home means `~` means the
 * same thing in a tool argument and in a discovery root.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return resolvePath(homedir(), p.slice(2));
	return p;
}

/** Resolve a path against `cwd`, expanding `~` and honoring absolute paths. */
export function resolveToCwd(p: string, cwd: string): string {
	const expanded = expandTilde(p);
	return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(cwd, expanded);
}
