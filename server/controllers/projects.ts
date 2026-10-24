/**
 * REST: /api/projects
 */
import { Router } from "express";
import { CONTEXT_WINDOW_CHOICES } from "../protocol";
import type { ServerContext } from "../context";
import { ProjectError } from "../models/projects";
import { discoverSkillRoots, SkillLoader } from "../../agent/skills";
import { discoverCommandRoots, discoverPlugins, loadCommands } from "../../agent";
import { disabledSet, loadRegistry } from "../../agent/registry";

export function createProjectsRouter(ctx: ServerContext): Router {
	const router = Router();

	// List
	router.get("/", async (_req, res) => {
		res.json(await ctx.projects.list());
	});

	// Create
	router.post("/", async (req, res) => {
		try {
			const body = req.body as { name?: string; path?: string; config?: Record<string, unknown> };
			if (!body?.path) return res.status(400).json({ error: "path is required" });
			// Idempotent: a path that already has a project comes back as 200, a
			// fresh one as 201 — callers that only care that it exists can ignore both.
			const before = (await ctx.projects.list()).some((p) => p.path === body.path);
			const project = await ctx.projects.create({ name: body.name, path: body.path, config: body.config });
			res.status(before ? 200 : 201).json(project);
		} catch (err) {
			if (err instanceof ProjectError) return res.status(400).json({ error: err.message, code: err.code });
			throw err;
		}
	});

	// Get
	router.get("/:id", async (req, res) => {
		const project = await ctx.projects.get(req.params.id);
		if (!project) return res.status(404).json({ error: "project not found" });
		res.json(project);
	});

	// Update
	router.patch("/:id", async (req, res) => {
		const body = req.body as { name?: string; config?: Record<string, unknown> };
		// contextWindow: only the published choices (or null/undefined to clear) —
		// the blind config merge below would otherwise persist arbitrary junk.
		const cw = body.config?.contextWindow;
		if (cw !== undefined && cw !== null && !CONTEXT_WINDOW_CHOICES.includes(cw as (typeof CONTEXT_WINDOW_CHOICES)[number])) {
			return res.status(400).json({ error: `contextWindow must be one of ${CONTEXT_WINDOW_CHOICES.join(", ")}` });
		}
		const updated = await ctx.projects.update(req.params.id, body);
		if (!updated) return res.status(404).json({ error: "project not found" });
		res.json(updated);
	});

	// Delete
	router.delete("/:id", async (req, res) => {
		const ok = await ctx.projects.remove(req.params.id);
		if (!ok) return res.status(404).json({ error: "project not found" });
		res.status(204).end();
	});

	// Skills discoverable for this project (drives the WebUI's `/` command menu).
	// Mirrors worker-boot filtering: registry-disabled skills/plugins are dropped
	// so the menu never offers an asset the session's agent can't load.
	router.get("/:id/skills", async (req, res) => {
		const project = await ctx.projects.get(req.params.id);
		if (!project) return res.status(404).json({ error: "project not found" });
		const registry = await loadRegistry(ctx.config.dataDir);
		const offSkills = disabledSet(registry, "skills");
		const { roots } = await discoverSkillRoots({
			dataDir: ctx.config.dataDir,
			cwd: project.path,
			projectSkillsDirs: project.config.skillsDirs,
			disabledPlugins: registry.disabled.plugins,
		});
		const skills = await new SkillLoader(roots, project.path).load();
		res.json(skills.filter((s) => !offSkills.has(s.name)).map((s) => ({ name: s.name, description: s.description })));
	});

	// Slash commands (project, global and plugin `commands/*.md`) — the other half
	// of the `/` menu. Bodies stay server-side; the worker expands them on submit.
	router.get("/:id/commands", async (req, res) => {
		const project = await ctx.projects.get(req.params.id);
		if (!project) return res.status(404).json({ error: "project not found" });
		const commands = await loadCommands(
			await discoverCommandRoots({ dataDir: ctx.config.dataDir, cwd: project.path }),
		);
		res.json(
			commands.map((c) => ({
				name: c.name,
				description: c.description,
				argumentHint: c.argumentHint,
				source: c.source,
			})),
		);
	});

	// Plugin bundles visible to this project, and which assets of each are wired.
	router.get("/:id/plugins", async (req, res) => {
		const project = await ctx.projects.get(req.params.id);
		if (!project) return res.status(404).json({ error: "project not found" });
		const plugins = await discoverPlugins({ dataDir: ctx.config.dataDir, cwd: project.path });
		res.json(
			plugins.map((p) => ({
				name: p.name,
				dir: p.dir,
				scope: p.scope,
				skills: Boolean(p.skillsDir),
				agents: Boolean(p.agentsDir),
				commands: Boolean(p.commandsDir),
				mcp: Boolean(p.mcpConfig),
				hooks: Boolean(p.hooksConfig),
			})),
		);
	});

	return router;
}
