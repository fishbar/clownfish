/**
 * API router: mounts /projects and /projects/:id/sessions, the agent management
 * endpoints (running processes under /agents, prompt definitions under
 * /agent-prompts, tool prompt overrides under /tool-prompts), plus /health.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServerContext } from "../context";
import { createProjectsRouter } from "./projects";
import { createSessionsRouter } from "./sessions";
import { createDemosRouter } from "./demos";
import { createAgentsListRouter, createAgentsSessionRouter } from "./agents";
import { createAgentPromptsRouter } from "./agent-prompts";
import { createCliAgentsRouter } from "./cli-agents";
import { createToolPromptsRouter } from "./tool-prompts";
import { createKeybindingsRouter } from "./keybindings";
import { createMemoryRouter } from "./memory";
import { createPathRouter } from "./path";
import { createCheckpointsRouter } from "./checkpoints";
import { createCronRouter } from "./cron";
import { createInventoryRouter } from "./inventory";

/**
 * Project/session ids are server-generated (12-char alnum; legacy uuids) —
 * anything else-shaped is rejected BEFORE it can reach an fs `join()`. Express
 * decodes %2F AFTER route matching, so `..%2F..%2F` arrives intact inside
 * `req.params` and would otherwise traverse out of dataDir/sessionsDir
 * (transcript reads/deletes, checkpoint restores all join these ids).
 */
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function idGuard(req: Request, res: Response, next: NextFunction): void {
	const { projectId, sessionId } = req.params as Record<string, string | undefined>;
	if (!ID_RE.test(projectId ?? "") || !ID_RE.test(sessionId ?? "")) {
		res.status(404).json({ error: "not found" });
		return;
	}
	next();
}

export function createApiRouter(ctx: ServerContext): Router {
	const router = Router();

	router.get("/health", (_req, res) => res.json({ ok: true, provider: ctx.config.provider, model: ctx.config.model }));
	router.use("/path", createPathRouter());
	router.use("/agents", createAgentsListRouter(ctx));
	router.use("/agent-prompts", createAgentPromptsRouter(ctx));
	router.use("/cli-agents", createCliAgentsRouter(ctx));
	router.use("/tool-prompts", createToolPromptsRouter(ctx));
	router.use("/keybindings", createKeybindingsRouter(ctx));
	router.use("/cron", createCronRouter(ctx));
	router.use("/memory", createMemoryRouter(ctx));
	router.use("/projects", createProjectsRouter(ctx));
	// Admin panel asset management (agents/skills/tools/plugins). Project-scoped
	// because discovery depends on the project cwd; the id is only looked up in
	// the projects store (never joined into an fs path), so no idGuard needed.
	// The same router is mounted bare at /inventory for the panel's 全局 scope —
	// no projectId → discovery runs against dataDir, listing builtin + global
	// assets only.
	router.use("/projects/:projectId/inventory", createInventoryRouter(ctx));
	router.use("/inventory", createInventoryRouter(ctx));
	// Shape-check the path ids once, ahead of every session-scoped mount below
	// (sessions router + demos/agent/checkpoints sub-routers all share them).
	router.use("/projects/:projectId/sessions/:sessionId", idGuard);
	router.use("/projects/:projectId/sessions", createSessionsRouter(ctx));
	router.use("/projects/:projectId/sessions/:sessionId/demos", createDemosRouter(ctx));
	router.use("/projects/:projectId/sessions/:sessionId/agent", createAgentsSessionRouter(ctx));
	router.use("/projects/:projectId/sessions/:sessionId/checkpoints", createCheckpointsRouter(ctx));

	return router;
}
