/**
 * Plugin bundles — one discovery pass shared by skills, agents, commands and MCP.
 *
 * A plugin is a directory carrying any of the Claude-Code bundle assets:
 *
 *   <plugin>/.claude-plugin/plugin.json   manifest (Claude Code's location)
 *   <plugin>/.clownfish-plugin/plugin.json | plugin.json   also accepted
 *   <plugin>/skills/                      SKILL.md skills
 *   <plugin>/agents/                      *.md agent prompts
 *   <plugin>/commands/                    *.md slash commands
 *   <plugin>/.mcp.json | mcp.json         MCP servers
 *   <plugin>/hooks/hooks.json | hooks.json  hooks (recognized, not executed)
 *
 * Search roots, low→high precedence:
 *   <dataDir>/plugins/*        clownfish global
 *   ~/.claude/plugins/**       Claude Code's install root (ecosystem compat)
 *   <cwd>/.clownfish/plugins/* project
 *   <cwd>/.claude/plugins/*    project, Claude Code layout
 *
 * Claude Code installs plugins under a marketplace checkout
 * (`plugins/repos/<marketplace>/<plugin>`), so a directory that carries no
 * manifest and no known asset is descended into rather than reported as an empty
 * plugin — up to {@link MAX_NESTING} levels, which covers that layout without
 * turning discovery into a full filesystem walk.
 *
 * Nothing here reads a plugin's assets — it only says where they are. Each
 * subsystem (skills/agents/commands/mcp) consumes the paths it cares about, so
 * plugin support is added by wiring one more field, not one more scanner.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveToCwd } from "./paths";

/** Where a bundle was found. Only used for logging/labels. */
export type PluginScope = "global" | "project";

export interface PluginBundle {
	/** Manifest `name`, else the directory basename. Used in `plugin:<name>` labels. */
	name: string;
	/** Absolute plugin root. */
	dir: string;
	scope: PluginScope;
	/** Manifest path, when the bundle has one. */
	manifest?: string;
	/** Assets that exist, absolute. Absent when the plugin doesn't ship that kind. */
	skillsDir?: string;
	agentsDir?: string;
	commandsDir?: string;
	mcpConfig?: string;
	/** Recognized but not executed yet — reported so it isn't silently ignored. */
	hooksConfig?: string;
}

/** Manifest locations, most-specific first. `.claude-plugin/` is Claude Code's. */
const MANIFESTS = [".claude-plugin/plugin.json", ".clownfish-plugin/plugin.json", "plugin.json"];
/** MCP server config, Claude Code's dotted name first. */
const MCP_FILES = [".mcp.json", "mcp.json"];
const HOOK_FILES = ["hooks/hooks.json", "hooks.json"];


async function exists(p: string): Promise<boolean> {
	return stat(p).then(
		() => true,
		() => false,
	);
}

/** First of `candidates` (relative to `dir`) that exists, or undefined. */
async function firstExisting(dir: string, candidates: string[]): Promise<string | undefined> {
	for (const rel of candidates) {
		const p = join(dir, rel);
		if (await exists(p)) return p;
	}
	return undefined;
}

/** Immediate subdirectories of `parent` (absolute), or [] when it doesn't exist. */
async function listDirs(parent: string): Promise<string[]> {
	const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
	return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(parent, e.name));
}

/** Read the manifest's `name`, if there is a readable one. */
async function manifestName(manifest: string): Promise<string | undefined> {
	const raw = await readFile(manifest, "utf8").catch(() => null);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { name?: unknown };
		return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
	} catch {
		return undefined; // malformed manifest — fall back to the directory name
	}
}

/** Inventory one directory as a plugin, or null when it carries no bundle asset. */
async function readBundle(dir: string, scope: PluginScope): Promise<PluginBundle | null> {
	const manifest = await firstExisting(dir, MANIFESTS);
	const [skillsDir, agentsDir, commandsDir, mcpConfig, hooksConfig] = await Promise.all([
		firstExisting(dir, ["skills"]),
		firstExisting(dir, ["agents"]),
		firstExisting(dir, ["commands"]),
		firstExisting(dir, MCP_FILES),
		firstExisting(dir, HOOK_FILES),
	]);
	if (!manifest && !skillsDir && !agentsDir && !commandsDir && !mcpConfig && !hooksConfig) return null;
	return {
		name: (manifest ? await manifestName(manifest) : undefined) ?? basename(dir),
		dir,
		scope,
		manifest,
		skillsDir,
		agentsDir,
		commandsDir,
		mcpConfig,
		hooksConfig,
	};
}

/**
 * How deep below a plugins root a bundle may sit. 1 = `plugins/<plugin>`;
 * 3 covers Claude Code's `plugins/repos/<marketplace>/<plugin>`.
 */
const MAX_NESTING = 3;

/**
 * Bundles at or below `parent`. A directory that is itself a plugin ends the
 * descent (its `skills/`, `agents/`, … are assets, not nested plugins); one that
 * is not is descended into, so marketplace checkouts resolve without a special
 * case. Bounded by {@link MAX_NESTING} so this never becomes a deep walk.
 */
async function scanRoot(parent: string, scope: PluginScope, depth = 1): Promise<PluginBundle[]> {
	if (depth > MAX_NESTING) return [];
	const out: PluginBundle[] = [];
	for (const dir of await listDirs(parent)) {
		const bundle = await readBundle(dir, scope);
		if (bundle) out.push(bundle);
		else out.push(...(await scanRoot(dir, scope, depth + 1)));
	}
	return out;
}

export interface DiscoverPluginsOptions {
	/** Plugin names disabled from the admin panel — skipped entirely. */
	disabledPlugins?: string[];
	dataDir: string;
	cwd: string;
}

/**
 * Every plugin bundle visible to this session, in precedence order (low→high).
 * A later bundle with the same name shadows an earlier one asset-by-asset,
 * because each subsystem scans the returned dirs in this same order.
 */
export async function discoverPlugins(opts: DiscoverPluginsOptions): Promise<PluginBundle[]> {
	const { dataDir, cwd } = opts;
	// The admin panel's off-switch belongs HERE rather than in each consumer: one
	// discovery pass feeds skills, agents, commands and MCP, so filtering once is
	// what makes "disabled" mean the same thing for all four.
	const disabled = new Set(opts.disabledPlugins ?? []);
	const roots: Array<[string, PluginScope]> = [
		[join(dataDir, "plugins"), "global"],
		[join(homedir(), ".claude", "plugins"), "global"],
		[resolveToCwd("./.clownfish/plugins", cwd), "project"],
		[resolveToCwd("./.claude/plugins", cwd), "project"],
	];
	const found: PluginBundle[] = [];
	const seen = new Set<string>();
	for (const [dir, scope] of roots) {
		for (const bundle of await scanRoot(dir, scope)) {
			// The same bundle can be reachable from two roots (e.g. dataDir under ~).
			if (seen.has(bundle.dir)) continue;
			seen.add(bundle.dir);
			found.push(bundle);
		}
	}
	return found.filter((p) => !disabled.has(p.name));
}

/** One log line per plugin: what it ships and what is wired vs merely recognized. */
export function pluginNotes(bundles: PluginBundle[]): string[] {
	return bundles.map((b) => {
		const wired = [
			b.skillsDir && "skills",
			b.agentsDir && "agents",
			b.commandsDir && "commands",
			b.mcpConfig && "mcp",
		].filter(Boolean);
		const parts = [wired.length ? wired.join(" + ") : "no wired assets"];
		if (b.hooksConfig) parts.push("hooks (recognized, not yet executed)");
		return `plugin '${b.name}' (${b.scope}): ${parts.join(", ")}`;
	});
}
