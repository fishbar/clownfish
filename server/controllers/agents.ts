/**
 * Operator REST: agent process management.
 *
 *   GET    /api/agents                                          → list all agents
 *   POST   /api/projects/:projectId/sessions/:sessionId/agent/start   → ensure running
 *   POST   /api/projects/:projectId/sessions/:sessionId/agent/stop    → graceful stop
 *   POST   /api/projects/:projectId/sessions/:sessionId/agent/pin     → {pinned} disable/enable TTL
 *   GET    /api/projects/:projectId/sessions/:sessionId/agent/status  → current status
 *   POST   /api/projects/:projectId/sessions/:sessionId/agent/run     → {text} background run
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServerContext } from "../context";

interface SessParams {
	projectId: string;
	sessionId: string;
}
const params = (req: Request): SessParams => req.params as unknown as SessParams;

/** Resolve + validate project and session, then continue. */
async function resolveSession(ctx: ServerContext, req: Request, res: Response, next: NextFunction): Promise<void> {
	const { projectId, sessionId } = params(req);
	const project = await ctx.projects.get(projectId);
	if (!project) {
		res.status(404).json({ error: "project not found" });
		return;
	}
	const meta = await ctx.sessions.meta(projectId, sessionId);
	if (!meta) {
		res.status(404).json({ error: "session not found" });
		return;
	}
	res.locals.project = project;
	next();
}

export function createAgentsSessionRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });
	router.use((req, res, next) => void resolveSession(ctx, req, res, next));

	router.post("/start", async (req, res) => {
		const info = await ctx.agents.start(res.locals.project, params(req).sessionId);
		res.json(info);
	});

	router.post("/stop", async (req, res) => {
		const stopped = await ctx.agents.stop(params(req).sessionId);
		res.json({ stopped });
	});

	router.post("/pin", async (req, res) => {
		const body = (req.body ?? {}) as { pinned?: boolean };
		const set = await ctx.agents.setPinned(params(req).sessionId, Boolean(body.pinned));
		res.json({ set, status: ctx.agents.status(params(req).sessionId) });
	});

	router.get("/status", (req, res) => {
		const info = ctx.agents.status(params(req).sessionId);
		if (!info) return res.status(404).json({ error: "agent not running" });
		res.json(info);
	});

	router.post("/run", async (req, res) => {
		const body = (req.body ?? {}) as { text?: string };
		if (!body.text || !body.text.trim()) return res.status(400).json({ error: "text required" });
		const info = await ctx.agents.run(res.locals.project, params(req).sessionId, body.text);
		res.json(info);
	});

	// Compact the session's context: fold older messages into a summary (sys-compact
	// sub-agent). 409 when not running / busy / failed.
	router.post("/compact", async (req, res) => {
		try {
			await ctx.agents.compact(params(req).sessionId);
			res.json({ status: ctx.agents.status(params(req).sessionId) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(409).json({ error: message });
		}
	});

	// Switch the session's execution mode (plan/auto/ask). 400 on bad mode, 409 when
	// not running / busy / failed.
	router.post("/mode", async (req, res) => {
		const body = (req.body ?? {}) as { mode?: string };
		if (body.mode !== "plan" && body.mode !== "auto" && body.mode !== "ask") {
			return res.status(400).json({ error: "mode must be one of: plan, auto, ask" });
		}
		try {
			const mode = await ctx.agents.setMode(params(req).sessionId, body.mode);
			res.json({ mode });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(409).json({ error: message });
		}
	});

	return router;
}

export function createAgentsListRouter(ctx: ServerContext): Router {
	const router = Router();
	router.get("/", (_req, res) => res.json(ctx.agents.list()));
	return router;
}
