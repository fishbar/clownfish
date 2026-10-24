/**
 * Slash commands — user-invoked prompt templates, Claude-Code compatible.
 *
 * A command is a markdown file whose body becomes the prompt when the user types
 * `/<name> [args]`. Unlike a skill (which the *model* may load via the `skill`
 * tool), a command is only ever triggered by the user, so it never enters the
 * system prompt and costs nothing until used.
 *
 * Search roots, low→high precedence (last wins on a name clash):
 *   <dataDir>/commands             clownfish global
 *   ~/.claude/commands             Claude Code user commands
 *   <plugin>/commands              every discovered plugin, in plugin order
 *   <cwd>/.clownfish/commands      project
 *   <cwd>/.claude/commands         project, Claude Code layout
 *
 * Frontmatter is optional; `description` and `argument-hint` are used, other keys
 * (`allowed-tools`, `model`, …) are accepted and ignored rather than rejected, so
 * a bundle written for Claude Code loads unchanged.
 *
 * Argument substitution follows Claude Code: `$ARGUMENTS` is everything the user
 * typed after the command, `$1`…`$9` are whitespace-separated positionals. A
 * template with no placeholder gets the arguments appended, so a bare
 * `/review some/file.ts` still passes the file through.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseMarkdownDocLoose } from "./frontmatter";
import { resolveToCwd } from "./paths";
import { discoverPlugins, type PluginBundle } from "./plugins";

export interface Command {
	/** Invoked as `/<name>`. Nested dirs are flattened with `:` (`git/commit.md` → `git:commit`). */
	name: string;
	/** One-line description for the `/` menu. */
	description: string;
	/** Frontmatter `argument-hint`, e.g. `[file] [--fix]`. Shown in the menu. */
	argumentHint?: string;
	/** Markdown body (the prompt template). */
	body: string;
	/** Absolute path to the source file. */
	path: string;
	/** Origin: "global" | "project" | "plugin:<name>". */
	source: string;
}

export interface CommandRoot {
	dir: string;
	source: string;
}

/** Command search roots for a session, low→high precedence. */
export async function discoverCommandRoots(opts: { dataDir: string; cwd: string; plugins?: PluginBundle[] }): Promise<CommandRoot[]> {
	const { dataDir, cwd } = opts;
	const plugins = opts.plugins ?? (await discoverPlugins({ dataDir, cwd }));
	const roots: CommandRoot[] = [
		{ dir: join(dataDir, "commands"), source: "global" },
		{ dir: join(homedir(), ".claude", "commands"), source: "global" },
	];
	for (const p of plugins) {
		if (p.commandsDir) roots.push({ dir: p.commandsDir, source: `plugin:${p.name}` });
	}
	roots.push({ dir: resolveToCwd("./.clownfish/commands", cwd), source: "project" });
	roots.push({ dir: resolveToCwd("./.claude/commands", cwd), source: "project" });
	return roots;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Every `*.md` under `dir`, recursively, as `[name, absolutePath]`. */
async function walkCommands(dir: string, root: string): Promise<Array<[string, string]>> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const out: Array<[string, string]> = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".")) continue;
			out.push(...(await walkCommands(full, root)));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const name = relative(root, full).slice(0, -3).split(sep).join(":");
			if (name) out.push([name, full]);
		}
	}
	return out;
}

/** Load every command from the roots in order; a later root's same-named command wins. */
export async function loadCommands(roots: CommandRoot[]): Promise<Command[]> {
	const byName = new Map<string, Command>();
	for (const root of roots) {
		for (const [name, path] of await walkCommands(root.dir, root.dir)) {
			const raw = await readFile(path, "utf8").catch(() => null);
			if (raw === null) continue;
			const { frontmatter, body } = parseMarkdownDocLoose(raw);
			if (!body) continue;
			byName.set(name, {
				name,
				description: str(frontmatter.description) ?? `Command from ${root.source}`,
				argumentHint: str(frontmatter["argument-hint"]),
				body,
				path,
				source: root.source,
			});
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Expand a command into the prompt text to send. `$ARGUMENTS` and `$1`…`$9` are
 * substituted; if the template references neither, the raw arguments are appended
 * under a Task heading so they aren't silently dropped.
 */
export function renderCommand(command: Command, args: string): string {
	const trimmed = args.trim();
	const positionals = trimmed ? trimmed.split(/\s+/) : [];
	const usesArguments = /\$ARGUMENTS\b/.test(command.body);
	const usesPositional = /\$[1-9]\b/.test(command.body);
	let body = command.body;
	if (usesArguments) body = body.replace(/\$ARGUMENTS\b/g, trimmed);
	if (usesPositional) body = body.replace(/\$([1-9])\b/g, (_m, d: string) => positionals[Number(d) - 1] ?? "");
	if (!usesArguments && !usesPositional && trimmed) body = `${body}\n\n---\n\n# Task\n${trimmed}`;
	return body;
}
