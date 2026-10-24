/**
 * Operator REST: agent prompt management (the settings page's agent editor).
 *
 *   GET    /api/agent-prompts[?projectId=]        → every discovered agent + its body
 *   GET    /api/agent-prompts/:name[?projectId=]  → one agent
 *   PUT    /api/agent-prompts/:name               → {content} write a copy-on-write override
 *   DELETE /api/agent-prompts/:name               → drop the override (reset to source)
 *   GET    /api/agent-prompts/:name/versions      → the override's timestamped backups
 *   GET    /api/agent-prompts/:name/versions/:v   → one backup's content
 *   POST   /api/agent-prompts/:name/rollback      → {version} restore a backup as the override
 *
 * Every save is VERSIONED the same vim-style way the asset editor's are (the
 * previous override is copied to `<name>.md.YYYYMMDD-HHmmss`, newest 5 kept),
 * and a reset leaves those backups in place — so an edit can be recovered even
 * after "恢复默认". Every write hot-reloads live workers (`reloadAssets`, the
 * same push the inventory panel uses): an edited prompt reaches a running
 * session on its next turn, no restart.
 *
 * `content` is the WHOLE `.md` file — YAML frontmatter included. Editing only the
 * prose body would silently drop `description` / `access` / `internal`, which
 * decide what the agent may touch and whether it's delegatable.
 *
 * Distinct from `/api/agents`, which lists running agent *processes*. This is
 * about the prompt *definitions* on disk.
 *
 * Edits never touch the source file. They land in `<dataDir>/agent_overwrite/`,
 * the highest-precedence discovery root, so the built-in / project / plugin file
 * stays pristine and a reset restores it (see `agent/agents/overrides.ts`).
 *
 * `projectId` is optional: without it only the global roots (built-ins, global
 * agents + plugins, overrides) are scanned; with it the project's own
 * `.clownfish/agents` and plugins are included too.
 */
import { Router, type Request } from "express";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	AgentLoader,
	discoverAgentRoots,
	isValidAgentName,
	OVERRIDE_SOURCE,
	overrideDir,
	overridePath,
	removeOverride,
	type AgentDefinition,
	type AgentRoot,
} from "../../agent";
import type { ServerContext } from "../context";
import { InventoryError, listFileVersions, readFileVersion, rollbackFileVersion, writeVersioned } from "../models/inventory";
import type { AgentPromptInfo } from "../protocol";

/** The bundled built-in agents dir, resolved the same way the worker resolves it. */
const BUILTIN_DIR = fileURLToPath(new URL("../../agent/agents/builtin", import.meta.url));

/** Roots for the requested scope, plus the same list minus the override root. */
async function rootsFor(ctx: ServerContext, cwd: string): Promise<{ all: AgentRoot[]; base: AgentRoot[] }> {
	const all = await discoverAgentRoots({ builtinDir: BUILTIN_DIR, dataDir: ctx.config.dataDir, cwd });
	return { all, base: all.filter((r) => r.source !== OVERRIDE_SOURCE) };
}

/**
 * Resolve the scan cwd: a project's workspace when `?projectId=` names one,
 * otherwise the server's own cwd (global-only view). An unknown id is an error
 * rather than a silent fallback — the caller asked for that project's agents.
 */
async function scanCwd(ctx: ServerContext, req: Request): Promise<{ cwd: string } | { error: string }> {
	const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
	if (!projectId) return { cwd: process.cwd() };
	const project = await ctx.projects.get(projectId);
	if (!project) return { error: "project not found" };
	return { cwd: project.path };
}

/** The agent's `.md` file verbatim — what the editor shows and PUTs back. */
async function rawFile(def: AgentDefinition): Promise<string> {
	return (await readFile(def.path, "utf8").catch(() => null)) ?? def.body;
}

async function toInfo(def: AgentDefinition, base: AgentDefinition | undefined): Promise<AgentPromptInfo> {
	const overridden = def.source === OVERRIDE_SOURCE;
	return {
		name: def.name,
		description: def.description,
		internal: def.internal === true,
		access: def.access,
		content: await rawFile(def),
		path: def.path,
		source: def.source ?? "unknown",
		overridden,
		// What a reset would fall back to. Absent when the override *is* the only
		// definition (the user created a brand-new agent from the settings page).
		baseSource: overridden ? base?.source : undefined,
		basePath: overridden ? base?.path : undefined,
		baseContent: overridden && base ? await rawFile(base) : undefined,
	};
}

/** Load the effective agents and their pre-override counterparts, keyed by name. */
async function loadAll(ctx: ServerContext, cwd: string): Promise<AgentPromptInfo[]> {
	const { all, base } = await rootsFor(ctx, cwd);
	const [effective, underlying] = await Promise.all([new AgentLoader(all).load(), new AgentLoader(base).load()]);
	const byName = new Map(underlying.map((d) => [d.name, d]));
	return Promise.all(effective.map((d) => toInfo(d, byName.get(d.name))));
}

/**
 * Why a frontmatter block would be dropped, or null when it parses. The loader's
 * parser is total on purpose (one bad operator file must never abort discovery),
 * which also means a broken block fails SILENTLY: `description: a: b` loses
 * every key, `internal: true` included — an internal agent quietly becomes
 * delegatable. Refusing it at save time is the one place a person is there to
 * read the error.
 */
function frontmatterError(content: string): string | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!m) return content.startsWith("---") ? "frontmatter 没有闭合的 ---" : null;
	try {
		const parsed = parseYaml(m[1]) as unknown;
		if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return "frontmatter 必须是 key: value 映射";
		return null;
	} catch (err) {
		// First line only: the yaml library appends a multi-line source excerpt.
		const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
		return `frontmatter 不是合法 YAML（值里含 ": " 时请加引号）：${msg}`;
	}
}

export function createAgentPromptsRouter(ctx: ServerContext): Router {
	const router = Router();

	router.get("/", async (req, res) => {
		const scope = await scanCwd(ctx, req);
		if ("error" in scope) return res.status(404).json({ error: scope.error });
		res.json(await loadAll(ctx, scope.cwd));
	});

	router.get("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		const scope = await scanCwd(ctx, req);
		if ("error" in scope) return res.status(404).json({ error: scope.error });
		const found = (await loadAll(ctx, scope.cwd)).find((a) => a.name === name);
		if (!found) return res.status(404).json({ error: "agent not found" });
		res.json(found);
	});

	/** Live workers pick up a changed prompt on their next turn. */
	const pushReload = (): void => ctx.agents.reloadAssets();

	// Copy-on-write: the body the client edited is written to the override dir.
	// It fully replaces the file (frontmatter included), so the editor round-trips
	// exactly what it was shown. The previous override (if any) is backed up first.
	router.put("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		const body = (req.body ?? {}) as { content?: unknown };
		if (typeof body.content !== "string" || !body.content.trim()) {
			return res.status(400).json({ error: "content required" });
		}
		const fmError = frontmatterError(body.content);
		if (fmError) return res.status(400).json({ error: fmError });
		const path = overridePath(ctx.config.dataDir, name);
		await mkdir(overrideDir(ctx.config.dataDir), { recursive: true });
		await writeVersioned(path, body.content.endsWith("\n") ? body.content : `${body.content}\n`);
		pushReload();
		res.json({ name, path, overridden: true });
	});

	// Reset: delete the override so the underlying definition takes effect again.
	// Its backups stay, so the edit is still recoverable from the history.
	router.delete("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		const removed = await removeOverride(ctx.config.dataDir, name);
		if (!removed) return res.status(404).json({ error: "no override to reset" });
		pushReload();
		res.status(204).end();
	});

	router.get("/:name/versions", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		res.json({ versions: await listFileVersions(overridePath(ctx.config.dataDir, name)) });
	});

	router.get("/:name/versions/:version", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		try {
			res.json({ content: await readFileVersion(overridePath(ctx.config.dataDir, name), req.params.version) });
		} catch (err) {
			res.status(err instanceof InventoryError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	// Restore a backup as the override (the current one is backed up first).
	// Works after a reset too — there is then no current file to back up.
	router.post("/:name/rollback", async (req, res) => {
		const name = req.params.name;
		if (!isValidAgentName(name)) return res.status(400).json({ error: "invalid agent name" });
		const version = (req.body as { version?: unknown } | undefined)?.version;
		if (typeof version !== "string") return res.status(400).json({ error: "version required" });
		try {
			const content = await rollbackFileVersion(overridePath(ctx.config.dataDir, name), version);
			pushReload();
			res.json({ name, content });
		} catch (err) {
			res.status(err instanceof InventoryError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	return router;
}
