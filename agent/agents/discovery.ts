/**
 * Agent discovery — assembles the ordered list of agent search roots.
 *
 * Precedence low→high (on a name clash the later, more-specific root wins, so
 * project assets override global ones, which override the bundled built-ins):
 *   <builtinDir>                built-in agents   ("builtin")
 *   <dataDir>/agents            global agents      ("global")
 *   <plugin>/agents             plugin agents      ("plugin:<name>")
 *   <cwd>/.clownfish/agents     project agents     ("project")
 *   <dataDir>/agent_overwrite   UI prompt edits    ("override")
 *
 * Plugin bundles are found by {@link discoverPlugins}, shared with skill, command
 * and MCP discovery (see `agent/plugins.ts`).
 *
 * The last root is the copy-on-write store behind the settings UI's agent editor
 * (see `./overrides`): editing any agent's prompt writes a shadow copy there
 * instead of mutating the source file, and "reset" deletes it.
 */
import { join } from "node:path";
import { resolveToCwd } from "../paths";
import type { AgentRoot } from "./types";
import { OVERRIDE_SOURCE, overrideDir } from "./overrides";
import { discoverPlugins, type PluginBundle } from "../plugins";


export interface DiscoverAgentOptions {
	/** Absolute path to the bundled built-in agents dir (lowest priority). */
	builtinDir: string;
	dataDir: string;
	cwd: string;
	/** Pre-discovered bundles, when the caller already ran {@link discoverPlugins}. */
	plugins?: PluginBundle[];
	/** Disabled plugin names (admin panel) — skipped entirely. */
	disabledPlugins?: string[];
}

export async function discoverAgentRoots(opts: DiscoverAgentOptions): Promise<AgentRoot[]> {
	const { builtinDir, dataDir, cwd } = opts;
	const plugins = opts.plugins ?? (await discoverPlugins({ dataDir, cwd, disabledPlugins: opts.disabledPlugins }));
	const roots: AgentRoot[] = [];

	// 1. Built-in agents (shipped with the package) — lowest priority.
	roots.push({ dir: builtinDir, source: "builtin" });

	// 2. Global agents.
	roots.push({ dir: join(dataDir, "agents"), source: "global" });

	// 3. Plugin agents.
	for (const plugin of plugins) {
		if (plugin.agentsDir) roots.push({ dir: plugin.agentsDir, source: `plugin:${plugin.name}` });
	}

	// 4. Project agents.
	roots.push({ dir: resolveToCwd("./.clownfish/agents", cwd), source: "project" });

	// 5. UI prompt overrides — highest priority, shadows every source above.
	roots.push({ dir: overrideDir(dataDir), source: OVERRIDE_SOURCE });

	return roots;
}
