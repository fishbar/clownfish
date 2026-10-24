/**
 * Asset inventory — what the admin panel shows and mutates.
 *
 * Reads the same discovery pipeline the worker boots with (agent/agents +
 * agent/skills discovery + the MCP config merge) so the panel's list is the
 * session's *effective* asset set, then layers the registry's enable/disable
 * state on top. Plugin disables cascade: an asset shipped by a disabled plugin
 * reads as disabled even if it isn't individually named in registry.json.
 *
 * File-backed CRUD targets the asset's own file (`global`/`project` sources are
 * writable; `builtin` and `plugin:*` are read-only). Agent-prompt and SKILL.md
 * edits are versioned vim-style: before each overwrite the current file is
 * copied to `<file>.YYYYMMDD-HHmmss` and the newest MAX_VERSIONS backups are
 * kept, enabling rollback + diff from the panel.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { discoverAgentRoots } from "../../agent/agents/discovery";
import { AgentLoader } from "../../agent/agents/loader";
import { discoverSkillRoots, listPlugins } from "../../agent/skills/discovery";
import { SkillLoader } from "../../agent/skills/loader";
import { loadMcpConfigs } from "../../agent/mcp";
import { fileURLToPath } from "node:url";
import { disabledSet, loadRegistry, REGISTRY_KINDS, setRegistryEnabled, type RegistryKind } from "../../agent/registry";
import type { Project } from "../protocol";

export interface InventoryItem {
	name: string;
	description?: string;
	/** builtin | global | project | plugin:<name> | builtin-tool | mcp */
	source: string;
	/** Backing file/dir (agents, skills, plugins); absent for virtual tools. */
	path?: string;
	enabled: boolean;
	/** False for builtin/plugin-shipped assets — the panel renders them read-only. */
	writable: boolean;
	/** Agents only: frontmatter `internal: true` (framework, hidden from run_agent). */
	internal?: boolean;
}

export interface Inventory {
	agents: InventoryItem[];
	skills: InventoryItem[];
	tools: InventoryItem[];
	plugins: InventoryItem[];
}

/** Builtin tool names exposed to the main agent (order = panel display order). */
const BUILTIN_TOOLS: Array<{ name: string; description: string }> = [
	{ name: "read", description: "Read a file" },
	{ name: "write", description: "Write a file" },
	{ name: "edit", description: "String-replace edit" },
	{ name: "bash", description: "Run a shell command" },
	{ name: "grep", description: "Search file contents" },
	{ name: "find", description: "Find files by name" },
	{ name: "ls", description: "List a directory" },
	{ name: "skill", description: "Load a discovered skill" },
	{ name: "run_agent", description: "Spawn a one-shot sub-agent" },
	{ name: "delegate", description: "Spawn a DAG-bound sub-agent" },
	{ name: "workflow", description: "Run a deterministic multi-agent workflow script" },
	{ name: "run_goal", description: "Goal-seeking executor/evaluator loop" },
	{ name: "plan", description: "Create an execution-plan DAG" },
	{ name: "decompose", description: "Split a DAG node into subtasks" },
	{ name: "update_node", description: "Update DAG node status/output" },
	{ name: "get_status", description: "Read the live agent tree" },
	{ name: "cron", description: "Self-schedule background jobs" },
	{ name: "draw_demo", description: "Publish an HTML demo" },
	{ name: "worktree_decide", description: "Finish an async coding run" },
];

// --- validation -----------------------------------------------------------

/** Panel-safe asset name: no traversal, no slashes, bounded length. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class InventoryError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function assertName(name: string): void {
	if (!NAME_RE.test(name)) throw new InventoryError(400, `invalid name: ${JSON.stringify(name)}`);
}

// --- versioning (vim-style timestamped backups) ---------------------------

/** Version id: `YYYYMMDD-HHmmss`, plus a `.N` counter only when backups land within the same second. */
const VERSION_RE = /^\d{8}-\d{6}(?:\.\d+)?$/;
export const MAX_VERSIONS = 5;

function stamp(d = new Date()): string {
	const p = (n: number, l = 2) => String(n).padStart(l, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function versionFiles(base: string, entries: string[]): string[] {
	// Key the VERSION SUFFIX (entries are `<base>.<suffix>` full names — matching
	// the raw entry against the version regex silently keys everything as ["",0]
	// and the "sort" degenerates to readdir order, pruning randomly).
	const key = (entry: string): [string, number] => {
		const m = entry.slice(base.length + 1).match(/^(\d{8}-\d{6})(?:\.(\d+))?$/);
		return m ? [m[1], Number(m[2] ?? 1)] : ["", 0];
	};
	return entries
		.filter((e) => e.startsWith(`${base}.`) && VERSION_RE.test(e.slice(base.length + 1)))
		.sort((a, b) => {
			const [ba, na] = key(a);
			const [bb, nb] = key(b);
			return ba === bb ? na - nb : ba < bb ? -1 : 1;
		});
}

/** Keep only the newest MAX_VERSIONS timestamped siblings of `file`. */
async function pruneVersions(file: string): Promise<void> {
	const dir = dirname(file);
	const base = basename(file);
	const versions = versionFiles(base, await readdir(dir).catch(() => []));
	for (const stale of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) {
		await rm(join(dir, stale), { force: true });
	}
}

/** Copy the current file to `<file>.<stamp>` (if it exists), then prune. Same-second backups get a `.N` counter derived from the highest sibling (NOT "first free name" — prune frees the counterless slot, and reusing it would make every later backup sort oldest and die instantly). */
async function backupFile(file: string): Promise<void> {
	const cur = await readFile(file, "utf8").catch(() => null);
	if (cur === null) return;
	const dir = dirname(file);
	const prefix = `${basename(file)}.${stamp()}`;
	const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(\\d+))?$`);
	let max = 0; // the counterless first-in-second backup counts as 1
	let any = false;
	for (const entry of await readdir(dir).catch(() => [])) {
		const m = entry.match(re);
		if (!m) continue;
		any = true;
		max = Math.max(max, m[1] ? Number(m[1]) : 1);
	}
	const name = any ? `${prefix}.${max + 1}` : prefix;
	await writeFile(join(dir, name), cur, "utf8");
	await pruneVersions(file);
}

export interface FileVersion {
	version: string;
	size: number;
}

/** Timestamped backups of `file`, newest first. */
export async function listFileVersions(file: string): Promise<FileVersion[]> {
	const dir = dirname(file);
	const base = basename(file);
	const entries = versionFiles(base, await readdir(dir).catch(() => []));
	const out: FileVersion[] = [];
	for (const entry of [...entries].reverse()) {
		const stat = await readFile(join(dir, entry)).then((b) => b.length).catch(() => 0);
		out.push({ version: entry.slice(base.length + 1), size: stat });
	}
	return out;
}

/** Read one timestamped backup. `version` is validated — never interpolate a path. */
export async function readFileVersion(file: string, version: string): Promise<string> {
	if (!VERSION_RE.test(version)) throw new InventoryError(400, `invalid version: ${JSON.stringify(version)}`);
	return readFile(`${file}.${version}`, "utf8").catch(() => {
		throw new InventoryError(404, `no such version: ${version}`);
	});
}

/** Rollback = backup the current content, then restore the named version as main. */
export async function rollbackFileVersion(file: string, version: string): Promise<string> {
	const restored = await readFileVersion(file, version);
	await backupFile(file);
	await writeFile(file, restored, "utf8");
	return restored;
}

/** Versioned write: backup current → write new → prune to MAX_VERSIONS. */
export async function writeVersioned(file: string, content: string): Promise<void> {
	await backupFile(file);
	await writeFile(file, content, "utf8");
}

// --- inventory ------------------------------------------------------------

function pluginOff(source: string, off: Set<string>): boolean {
	return source.startsWith("plugin:") ? off.has(source.slice("plugin:".length)) : false;
}

export async function buildInventory(dataDir: string, project: Project): Promise<Inventory> {
	const registry = await loadRegistry(dataDir);
	const offAgents = disabledSet(registry, "agents");
	const offSkills = disabledSet(registry, "skills");
	const offTools = disabledSet(registry, "tools");
	const offPlugins = disabledSet(registry, "plugins");
	const cwd = project.path;
	const builtinDir = fileURLToPath(new URL("../../agent/agents/builtin", import.meta.url));

	const agentRoots = await discoverAgentRoots({ builtinDir, dataDir, cwd });
	const agents = (await new AgentLoader(agentRoots).load()).filter((a) => !a.internal);
	const { roots: skillRoots } = await discoverSkillRoots({ dataDir, cwd, projectSkillsDirs: project.config.skillsDirs ?? ["./.clownfish/skills"] });
	const skills = await new SkillLoader(skillRoots, cwd).load();
	const mcpCfg = await loadMcpConfigs({ dataDir, cwd });
	const plugins = await listPlugins(dataDir, cwd);

	return {
		agents: agents.map((a) => ({
			name: a.name,
			description: a.description,
			source: a.source ?? "global",
			path: a.path,
			enabled: !offAgents.has(a.name) && !pluginOff(a.source ?? "", offPlugins),
			writable: a.source === "global" || a.source === "project",
		})),
		skills: skills.map((s) => ({
			name: s.name,
			description: s.description,
			source: s.source ?? "global",
			path: s.path,
			enabled: !offSkills.has(s.name) && !pluginOff(s.source ?? "", offPlugins),
			writable: s.source === "global" || s.source === "project",
		})),
		tools: [
			...BUILTIN_TOOLS.map((t) => ({
				name: t.name,
				description: t.description,
				source: "builtin-tool",
				enabled: !offTools.has(t.name),
				writable: false,
			})),
			...Object.keys(mcpCfg.servers).map((server) => ({
				name: server,
				description: "MCP server (all its mcp__ tools)",
				source: "mcp",
				enabled: !offTools.has(server),
				writable: true, // entries live in <dataDir>/mcp.json — editable there
			})),
		],
		plugins: plugins.map((p) => ({
			name: p.name,
			description: `${p.scope} plugin bundle${p.recognized.length ? ` (+${p.recognized.join(", ")} recognized)` : ""}`,
			source: p.scope,
			path: p.dir,
			enabled: !offPlugins.has(p.name) && !offPlugins.has(basename(p.dir)),
			writable: p.scope === "global",
		})),
	};
}

// --- toggle ----------------------------------------------------------------

export async function toggleAsset(dataDir: string, kind: RegistryKind, name: string, enabled: boolean): Promise<void> {
	if (!REGISTRY_KINDS.includes(kind)) throw new InventoryError(400, `kind must be one of ${REGISTRY_KINDS.join(", ")}`);
	assertName(name);
	await setRegistryEnabled(dataDir, kind, name, enabled);
}

// --- CRUD: agents & skills (versioned .md files) ---------------------------

/** Read an agent prompt / SKILL.md body. Only writable (global/project) files are readable by path from the panel. */
export async function readDoc(path: string): Promise<string> {
	return readFile(path, "utf8").catch(() => {
		throw new InventoryError(404, `no such file: ${path}`);
	});
}

export async function writeDoc(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeVersioned(path, content);
}

/** Delete an agent .md (+ its timestamped backups) or a skill dir. */
export async function deleteDoc(path: string, kind: "agents" | "skills"): Promise<void> {
	if (kind === "agents") {
		await rm(path, { force: true });
		const base = basename(path);
		for (const entry of versionFiles(base, await readdir(dirname(path)).catch(() => []))) {
			await rm(join(dirname(path), entry), { force: true });
		}
	} else {
		await rm(dirname(path), { recursive: true, force: true }); // skill = <name>/SKILL.md
	}
}

/** Create a new agent prompt in the global dir: `<dataDir>/agents/<name>.md`. Refuses to shadow an existing name. */
export async function createAgentDoc(dataDir: string, name: string, content: string): Promise<string> {
	assertName(name);
	const path = join(dataDir, "agents", `${name}.md`);
	if (await readDoc(path).then(() => true, () => false)) throw new InventoryError(409, `agent already exists: ${name}`);
	await writeDoc(path, content);
	return path;
}

export function agentDocPath(dataDir: string, name: string): string {
	assertName(name);
	return join(dataDir, "agents", `${name}.md`);
}

/** Create a new skill: `<dataDir>/skills/<name>/SKILL.md`. Refuses to shadow an existing name. */
export async function createSkillDoc(dataDir: string, name: string, content: string): Promise<string> {
	assertName(name);
	const path = join(dataDir, "skills", name, "SKILL.md");
	if (await readDoc(path).then(() => true, () => false)) throw new InventoryError(409, `skill already exists: ${name}`);
	await writeDoc(path, content);
	return path;
}

// --- CRUD: plugins ---------------------------------------------------------

/** Create a global plugin bundle skeleton (`plugin.json` + empty `skills/`). */
export async function createPlugin(dataDir: string, name: string): Promise<string> {
	assertName(name);
	const dir = join(dataDir, "plugins", name);
	await mkdir(join(dir, "skills"), { recursive: true });
	await writeFile(join(dir, "plugin.json"), `${JSON.stringify({ name, description: "" }, null, "\t")}\n`, "utf8");
	return dir;
}

export async function deletePlugin(dataDir: string, name: string): Promise<void> {
	assertName(name);
	await rm(join(dataDir, "plugins", name), { recursive: true, force: true });
}

// --- MCP config ------------------------------------------------------------

/** The global MCP config file, raw (JSON-editor payload). Null when absent. */
export async function readMcpConfig(dataDir: string): Promise<string | null> {
	return readFile(join(dataDir, "mcp.json"), "utf8").catch(() => null);
}

/** Validate + persist the global MCP config. Accepts `{ "mcpServers": { ... } }`. */
export async function writeMcpConfig(dataDir: string, raw: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new InventoryError(400, `invalid JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new InventoryError(400, "top level must be an object");
	}
	const servers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
		throw new InventoryError(400, "mcpServers must be an object keyed by server name");
	}
	await writeFile(join(dataDir, "mcp.json"), raw.endsWith("\n") ? raw : raw + "\n", "utf8");
}
