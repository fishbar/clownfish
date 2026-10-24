/**
 * /api/cron — scheduler listing + cancellation.
 *
 * Jobs are CREATED by sessions' agents via the `cron` tool; this side of the
 * API is the operator's view: what's scheduled across all sessions, and a
 * cancel handle for anything stale. Internal tasks (nightly memory distill)
 * appear in the listing but cannot be cancelled here.
 */
import { Router } from "express";
import type { ServerContext } from "../context";

export function createCronRouter(ctx: ServerContext): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		res.json({ jobs: await ctx.scheduler.listJobs() });
	});

	router.post("/:sessionId/:jobId/cancel", async (req, res) => {
		const { sessionId, jobId } = req.params;
		// cancelJob persists into join(sessionsDir, sessionId, "cron.json") — the
		// id must be server-id-shaped or it's a fs traversal (same rule as the
		// /projects/... idGuard, which does not cover this mount).
		if (!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId ?? "") || !/^[A-Za-z0-9_-]{6,64}$/.test(jobId ?? "")) {
			return res.status(404).json({ error: "no such scheduled job" });
		}
		const ok = await ctx.scheduler.cancelJob(sessionId, jobId);
		if (!ok) return res.status(404).json({ error: "no such scheduled job" });
		res.json({ ok: true });
	});

	return router;
}
