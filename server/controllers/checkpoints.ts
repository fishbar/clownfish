/**
 * REST: /api/projects/:projectId/sessions/:sessionId/checkpoints
 *
 * Turn checkpoints of the agent's write/edit mutations (pre-change file
 * snapshots under <dataDir>/checkpoints/<sessionId>/). Restoring puts a
 * checkpoint's pre-images back — undo that turn's file edits. Refused while the
 * session's agent is mid-run.
 */
import { Router, type Request } from "express";
import { join } from "node:path";
import type { ServerContext } from "../context";
import { CheckpointStore } from "../../agent/checkpoint";

interface SessParams {
	projectId: string;
	sessionId: string;
}
const params = (req: Request): SessParams => req.params as unknown as SessParams;

export function createCheckpointsRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });

	// List (newest first).
	router.get("/", async (req, res) => {
		const root = join(ctx.config.dataDir, "checkpoints", params(req).sessionId);
		res.json(await CheckpointStore.list(root));
	});

	// Restore a checkpoint's pre-images into the project workspace.
	router.post("/:seq/restore", async (req, res) => {
		const sid = params(req).sessionId;
		if (ctx.agents.status(sid)?.busy) {
			return res.status(409).json({ error: "agent is busy; restore after the current turn finishes" });
		}
		const project = await ctx.projects.get(params(req).projectId);
		if (!project) return res.status(404).json({ error: "project not found" });
		const seq = Number(req.params.seq);
		if (!Number.isInteger(seq) || seq <= 0) return res.status(400).json({ error: "bad checkpoint seq" });
		try {
			const restored = await CheckpointStore.restore(join(ctx.config.dataDir, "checkpoints", sid), project.path, seq);
			res.json({ restored });
		} catch (err) {
			res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	return router;
}
