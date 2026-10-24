/**
 * /api/projects/:id/inventory — the admin panel's asset management surface.
 *
 *   GET    /                          → full inventory (agents/skills/tools/plugins)
 *   PATCH  /:kind/:name               { enabled }          toggle via registry.json
 *   GET    /:kind/:name/doc           → { content }        agents/skills only
 *   PUT    /:kind/:name/doc           { content }          versioned write (writable sources)
 *   GET    /:kind/:name/versions      → timestamped backups, newest first
 *   GET    /:kind/:name/versions/:v   → { content }        one backup
 *   POST   /:kind/:name/rollback      { version }          restore a backup
 *   POST   /agents                    { name, content }    create (global dir)
 *   POST   /skills                    { name, content }    create (global dir)
 *   POST   /plugins                   { name }             create bundle skeleton
 *   DELETE /:kind/:name               → delete asset (agents/skills/plugins)
 *   GET    /mcp                       → { content | null } global mcp.json
 *   PUT    /mcp                       { content }          validate + write
 *
 * Every write hot-reloads all live workers (`reload_assets`): idle ones swap
 * their asset set in place, busy ones apply it before their next turn's first
 * LLM request — the next request already carries the new prompt/toolset. No
 * worker restart, no respawn latency.
 */
import { Router, type Request, type Response } from "express";
import type { ServerContext } from "../context";
import type { Project } from "../protocol";
import type { RegistryKind } from "../../agent/registry";
import {
	InventoryError,
	buildInventory,
	createAgentDoc,
	createPlugin,
	createSkillDoc,
	deleteDoc,
	deletePlugin,
	listFileVersions,
	readDoc,
	readFileVersion,
	readMcpConfig,
	rollbackFileVersion,
	toggleAsset,
	writeDoc,
	writeMcpConfig,
	type Inventory,
	type InventoryItem,
} from "../models/inventory";

const KINDS: RegistryKind[] = ["agents", "skills", "tools", "plugins"];
const DOC_KINDS: RegistryKind[] = ["agents", "skills"];

/** Single string param (Express 5 types values as string | string[]). */
function param(req: Request, key: string): string {
	const v = req.params[key];
	return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function createInventoryRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });

	/**
	 * The project whose tree the inventory is built against. This router is
	 * mounted twice: under `/projects/:projectId/inventory` (a real project)
	 * and at `/inventory` — the panel's 全局 scope. With no projectId the
	 * synthetic project is rooted at dataDir, so the project-level discovery
	 * roots resolve to non-existent dirs under it and only builtin + global
	 * assets are listed.
	 */
	async function scopeOf(req: Request): Promise<Project> {
		const id = param(req, "projectId");
		if (!id) {
			const config = { provider: "", model: "", skillsDirs: [] };
			return { id: "global", name: "全局", path: ctx.config.dataDir, createdAt: 0, updatedAt: 0, config };
		}
		const project = await ctx.projects.get(id);
		if (!project) throw new InventoryError(404, "no such project");
		return project;
	}

	/** Resolve one item by kind+name from a fresh inventory build. */
	async function findItem(project: Project, kind: RegistryKind, name: string): Promise<InventoryItem> {
		const inv: Inventory = await buildInventory(ctx.config.dataDir, project);
		const item = inv[kind].find((i) => i.name === name);
		if (!item) throw new InventoryError(404, `no such ${kind} asset: ${name}`);
		return item;
	}

	/**
	 * Push the write into every live worker as a hot reload: idle ones swap
	 * their asset set immediately; busy ones defer to their next turn's first
	 * LLM request, so that request already carries the new prompt/toolset.
	 * (Global by design — registry.json and the panel-edited files live in
	 * dataDir, shared across projects.)
	 */
	function pushAssetReload(): void {
		ctx.agents.reloadAssets();
	}

	/** Async handler wrapper: InventoryError carries its HTTP status; everything else is a 500. */
	const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
		void fn(req, res).catch((err: unknown) => {
			if (err instanceof InventoryError) res.status(err.status).json({ error: err.message });
			else res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
		});
	};

	router.get("/", wrap(async (req, res) => {
		res.json(await buildInventory(ctx.config.dataDir, await scopeOf(req)));
	}));

	router.patch("/:kind/:name", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		const { enabled } = req.body as { enabled?: boolean };
		if (!kind || !KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });
		if (typeof enabled !== "boolean") return void res.status(400).json({ error: "enabled (boolean) required" });
		// Toggling a name that isn't in the inventory is usually a stale panel — 404.
		await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		await toggleAsset(ctx.config.dataDir, kind as RegistryKind, param(req, "name"), enabled);
		pushAssetReload();
		res.json({ ok: true, name, enabled });
	}));

	// --- doc read/write (agents/skills) ---------------------------------

	router.get("/:kind/:name/doc", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		if (!kind || !DOC_KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: "doc routes are for agents/skills" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.path) return void res.status(404).json({ error: "asset has no backing file" });
		res.json({ content: await readDoc(item.path), item });
	}));

	router.put("/:kind/:name/doc", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		const { content } = req.body as { content?: string };
		if (!kind || !DOC_KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: "doc routes are for agents/skills" });
		if (typeof content !== "string") return void res.status(400).json({ error: "content (string) required" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.path) return void res.status(404).json({ error: "asset has no backing file" });
		if (!item.writable) return void res.status(403).json({ error: `${item.source} assets are read-only; create an override in the global dir instead` });
		await writeDoc(item.path, content);
		pushAssetReload();
		res.json({ ok: true });
	}));

	// --- versions --------------------------------------------------------

	router.get("/:kind/:name/versions", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		if (!kind || !DOC_KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: "version routes are for agents/skills" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.path) return void res.json({ versions: [] });
		res.json({ versions: await listFileVersions(item.path) });
	}));

	router.get("/:kind/:name/versions/:version", wrap(async (req, res) => {
		const { kind, name, version } = req.params as { kind?: string; name?: string; version?: string };
		if (!kind || !DOC_KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: "version routes are for agents/skills" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.path) return void res.status(404).json({ error: "asset has no backing file" });
		res.json({ content: await readFileVersion(item.path, param(req, "version")) });
	}));

	router.post("/:kind/:name/rollback", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		const { version } = req.body as { version?: string };
		if (!kind || !DOC_KINDS.includes(kind as RegistryKind)) return void res.status(400).json({ error: "version routes are for agents/skills" });
		if (typeof version !== "string") return void res.status(400).json({ error: "version (string) required" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.path) return void res.status(404).json({ error: "asset has no backing file" });
		if (!item.writable) return void res.status(403).json({ error: `${item.source} assets are read-only` });
		const content = await rollbackFileVersion(item.path, version);
		pushAssetReload();
		res.json({ ok: true, content });
	}));

	// --- create ----------------------------------------------------------

	router.post("/agents", wrap(async (req, res) => {
		const { name, content } = req.body as { name?: string; content?: string };
		if (typeof name !== "string" || typeof content !== "string") return void res.status(400).json({ error: "name and content required" });
		const path = await createAgentDoc(ctx.config.dataDir, name, content);
		pushAssetReload();
		res.status(201).json({ ok: true, path });
	}));

	router.post("/skills", wrap(async (req, res) => {
		const { name, content } = req.body as { name?: string; content?: string };
		if (typeof name !== "string" || typeof content !== "string") return void res.status(400).json({ error: "name and content required" });
		const path = await createSkillDoc(ctx.config.dataDir, name, content);
		pushAssetReload();
		res.status(201).json({ ok: true, path });
	}));

	router.post("/plugins", wrap(async (req, res) => {
		const { name } = req.body as { name?: string };
		if (typeof name !== "string") return void res.status(400).json({ error: "name required" });
		const dir = await createPlugin(ctx.config.dataDir, name);
		pushAssetReload();
		res.status(201).json({ ok: true, dir });
	}));

	// --- delete ----------------------------------------------------------

	router.delete("/:kind/:name", wrap(async (req, res) => {
		const { kind, name } = req.params as { kind?: string; name?: string };
		const DELETABLE: RegistryKind[] = ["agents", "skills", "plugins"];
		if (!kind || !DELETABLE.includes(kind as RegistryKind)) return void res.status(400).json({ error: "delete is for agents/skills/plugins" });
		const item = await findItem(await scopeOf(req), kind as RegistryKind, param(req, "name"));
		if (!item.writable) return void res.status(403).json({ error: `${item.source} assets are read-only` });
		if (kind === "plugins" && item.source !== "global") return void res.status(403).json({ error: "only global plugin bundles are deletable" });
		if (kind === "plugins") await deletePlugin(ctx.config.dataDir, item.name);
		else if (item.path) await deleteDoc(item.path, kind as "agents" | "skills");
		else return void res.status(404).json({ error: "asset has no backing file" });
		pushAssetReload();
		res.json({ ok: true });
	}));

	// --- global mcp.json --------------------------------------------------

	router.get("/mcp", wrap(async (_req, res) => {
		res.json({ content: await readMcpConfig(ctx.config.dataDir) });
	}));

	router.put("/mcp", wrap(async (req, res) => {
		const { content } = req.body as { content?: string };
		if (typeof content !== "string") return void res.status(400).json({ error: "content (string) required" });
		await writeMcpConfig(ctx.config.dataDir, content);
		pushAssetReload();
		res.json({ ok: true });
	}));

	return router;
}
