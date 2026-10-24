/**
 * Skill discovery — assembles the ordered list of skill search roots.
 *
 * Layout (precedence low→high; on a name clash the later, more-specific root
 * wins, so project assets override global ones):
 *   <dataDir>/skills           global skills          ("global")
 *   <plugin>/skills            plugin skills           ("plugin:<name>")
 *   ...projectSkillsDirs       project skills          ("project")
 *
 * Plugin bundles themselves are found by {@link discoverPlugins}, which is shared
 * with agent, command and MCP discovery — see `agent/plugins.ts` for the layout
 * and for how Claude-Code bundles are recognized.
 */
import { join } from "node:path";
import type { SkillRoot } from "./types";
import { discoverPlugins, pluginNotes, type PluginBundle } from "../plugins";

export interface DiscoverOptions {
	dataDir: string;
	cwd: string;
	/** Per-project skill dirs (default `["./.clownfish/skills"]`). */
	projectSkillsDirs: string[];
	/** Pre-discovered bundles, when the caller already ran {@link discoverPlugins}. */
	plugins?: PluginBundle[];
	/** Disabled plugin names (admin panel) — skipped entirely. */
	disabledPlugins?: string[];
}

export interface DiscoveryResult {
	/** Ordered skill search roots (low→high precedence). */
	roots: SkillRoot[];
	/** Human-readable discovery notes (one line per plugin found). */
	notes: string[];
}

export async function discoverSkillRoots(opts: DiscoverOptions): Promise<DiscoveryResult> {
	const { dataDir, cwd, projectSkillsDirs } = opts;
	const plugins = opts.plugins ?? (await discoverPlugins({ dataDir, cwd, disabledPlugins: opts.disabledPlugins }));
	const roots: SkillRoot[] = [{ dir: join(dataDir, "skills"), source: "global" }];

	// Plugin skills sit between global and project so a project can still override.
	for (const plugin of plugins) {
		if (plugin.skillsDir) roots.push({ dir: plugin.skillsDir, source: `plugin:${plugin.name}` });
	}

	for (const dir of projectSkillsDirs) roots.push({ dir, source: "project" });

	return { roots, notes: pluginNotes(plugins) };
}

/**
 * Plugin bundles as the admin inventory wants them. A thin projection of the ONE
 * discovery pass (agent/plugins.ts) rather than a second scanner: what the admin
 * panel can disable must be exactly what discovery would have loaded.
 */
export interface PluginInfo {
	name: string;
	/** The plugin's directory (bundle root, not the skills subdir). */
	dir: string;
	scope: "global" | "project";
	skillsDir: string;
	/** Recognized bundle assets that clownfish doesn't execute yet. */
	recognized: string[];
}

export async function listPlugins(dataDir: string, cwd: string): Promise<PluginInfo[]> {
	const bundles = await discoverPlugins({ dataDir, cwd });
	return bundles.map((b) => ({
		name: b.name,
		dir: b.dir,
		scope: b.scope === "project" ? "project" : "global",
		skillsDir: b.skillsDir ?? "",
		recognized: [
			b.agentsDir ? "agents" : "",
			b.commandsDir ? "commands" : "",
			b.mcpConfig ? "mcp" : "",
			b.hooksConfig ? "hooks" : "",
		].filter(Boolean),
	}));
}
