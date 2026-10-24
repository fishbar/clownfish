/**
 * REST: /api/projects/:projectId/sessions
 *
 * Session transcripts live in per-session JSONL files (see SessionTranscript); the
 * GET endpoint serves them **paginated** (most recent page first, older pages via
 * `?before=<lineIndex>`) mapped to {@link WireMessage} for the UI. Metadata
 * (title/timestamps) is owned by the server-side index.
 *
 * `mergeParams` brings `projectId` from the mount path; `sessionId` from nested
 * routes. Both are accessed via the typed helpers below.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServerContext } from "../context";
import { toWireMessages } from "../../agent/messages";
import { ASSISTANT_PROJECT_ID, type CreateSessionBody } from "../protocol";

/** The assistant project's ONE session — same fixed id as its project. */
const ASSISTANT_SESSION_ID = ASSISTANT_PROJECT_ID;

interface SessParams {
	projectId: string;
	sessionId?: string;
}
const params = (req: Request): SessParams => req.params as unknown as SessParams;
const pid = (req: Request): string => params(req).projectId;
const sid = (req: Request): string => params(req).sessionId!;

const DEFAULT_PAGE = 1000;
const MAX_PAGE = 1000;

export function createSessionsRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });

	// Ensure the project exists for every nested request.
	router.use(async (req: Request, res: Response, next: NextFunction) => {
		const project = await ctx.projects.get(pid(req));
		if (!project) return res.status(404).json({ error: "project not found" });
		next();
	});

	// List
	router.get("/", async (req, res) => {
		// The assistant project's single session is ensured on first listing —
		// the tree hides its "New session" button, so nothing else would create it.
		if (pid(req) === ASSISTANT_PROJECT_ID) await ctx.sessions.ensure(pid(req), ASSISTANT_SESSION_ID, "助理");
		res.json(await ctx.sessions.list(pid(req)));
	});

	// Create
	router.post("/", async (req, res) => {
		// The assistant has exactly one session (ensured, fixed id): a create is
		// idempotent rather than a second session. 200, not 201 — nothing new.
		if (pid(req) === ASSISTANT_PROJECT_ID) {
			res.status(200).json(await ctx.sessions.ensure(pid(req), ASSISTANT_SESSION_ID, "助理"));
			return;
		}
		const body = (req.body ?? {}) as CreateSessionBody;
		if (body.backend?.kind === "cli") {
			// CLI-backed sessions spawn an arbitrary external command reachable from
			// the web UI — same "opt in to a capability that spawns processes"
			// posture as CLOWNFISH_MCP_PROJECT (agent/mcp.ts).
			if (process.env.CLOWNFISH_CLI_SESSIONS !== "1") {
				return res.status(403).json({ error: "CLI-backed sessions are disabled — set CLOWNFISH_CLI_SESSIONS=1 (env or settings.json env:{}) to enable" });
			}
			if (!body.backend.command?.trim()) return res.status(400).json({ error: "backend.command is required for a cli session" });
		}
		const meta = await ctx.sessions.create(pid(req), body.title, body.backend);
		res.status(201).json(meta);
	});

	// Get (paginated transcript). `?limit=` caps the page (≤1000); `?before=<lineIndex>`
	// returns the older page ending just before that index.
	router.get("/:sessionId", async (req, res) => {
		const limit = Math.min(Math.max(1, Number(req.query.limit ?? DEFAULT_PAGE) || DEFAULT_PAGE), MAX_PAGE);
		const beforeRaw = req.query.before;
		const before = beforeRaw === undefined ? undefined : Math.max(0, Number(beforeRaw) || 0);
		const page = await ctx.sessions.loadPage(pid(req), sid(req), limit, before);
		if (!page) return res.status(404).json({ error: "session not found" });
		const { messages, total, oldestIndex, hasMore, ...meta } = page;
		void total;
		void oldestIndex;
		void hasMore;
		res.json({ ...meta, messages: toWireMessages(messages), total, oldestIndex, hasMore });
	});

	// Rename
	router.patch("/:sessionId", async (req, res) => {
		const body = (req.body ?? {}) as { title?: string };
		const meta = await ctx.sessions.rename(pid(req), sid(req), body.title);
		if (!meta) return res.status(404).json({ error: "session not found" });
		res.json(meta);
	});

	// The compaction record (running summary the MODEL sees; the UI always shows
	// the original transcript from GET /:sessionId). null when never compacted.
	router.get("/:sessionId/compact", async (req, res) => {
		res.json(await ctx.sessions.compactRecord(pid(req), sid(req)));
	});

	// The session plan: the model's steps plus the delegation ledger the runtime
	// maintains. Served from the file, so a tab can render it before (or without)
	// the lazily-spawned worker; live changes arrive as `todos` frames over /chat.
	router.get("/:sessionId/todos", async (req, res) => {
		res.json(await ctx.sessions.todos(pid(req), sid(req)));
	});

	// The session's shared execution-plan DAG state (all plans), for the side-panel
	// tree. Written by the worker; read here from disk (live enough for UI polling).
	router.get("/:sessionId/dag", async (req, res) => {
		res.json(await ctx.sessions.loadDag(pid(req), sid(req)));
	});

	// Sub-agent transcripts (one `<agentId>.jsonl` per spawned sub). The LIST
	// carries each sub's delegation prompt (first user message) so the UI can
	// link a run_agent tool call to the sub it spawned after a reload; the item
	// endpoint serves the full conversation for the drill-down view.
	router.get("/:sessionId/agents", async (req, res) => {
		res.json(await ctx.sessions.listSubAgents(pid(req), sid(req)));
	});
	router.get("/:sessionId/agents/:agentId", async (req, res) => {
		const agentId = String(req.params.agentId ?? "");
		const messages = /^[A-Za-z0-9_-]{6,64}$/.test(agentId)
			? await ctx.sessions.subAgentMessages(pid(req), sid(req), agentId)
			: undefined;
		if (!messages) return res.status(404).json({ error: "agent transcript not found" });
		res.json({ messages: toWireMessages(messages) });
	});

	// Delete
	router.delete("/:sessionId", async (req, res) => {
		// The assistant's single session is not deletable — the project IS the
		// session; removing it would orphan the pinned sidebar row.
		if (pid(req) === ASSISTANT_PROJECT_ID && sid(req) === ASSISTANT_SESSION_ID) {
			return res.status(403).json({ error: "the assistant session cannot be deleted" });
		}
		const removed = await ctx.sessions.remove(pid(req), sid(req));
		if (!removed) return res.status(404).json({ error: "session not found" });
		res.status(204).end();
	});

	return router;
}
