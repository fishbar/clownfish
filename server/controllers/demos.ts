/**
 * REST: /api/projects/:projectId/sessions/:sessionId/demos/:demoId/<file...>
 *
 * Serves the HTML demos published by the `draw_demo` tool from the session's
 * `demo/<demoId>/` directory. Hand-rolled instead of express.static: the path
 * is fully dynamic (project/session/demo ids from the store layout), and we
 * need explicit traversal rejection + a small ext→Content-Type map. Auth rides
 * the router mount (`/api` sits behind requireAuth when login is enabled) —
 * the fine-grained path-cookie scheme is deliberately deferred.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { ServerContext } from "../context";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
};

/** demoId is server-generated (generateId) — reject anything else-shaped. */
const DEMO_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function createDemosRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });

	// Serve one demo file. Express 5: the wildcard is an ARRAY param (`path`);
	// a trailing-slash URL ("/.../demoId/") matches NO wildcard route at all,
	// so the bare-entry routes below feed the same handler with an empty rel.
	router.get("/:demoId/*path", serveDemo);
	router.get("/:demoId/", serveDemo);
	router.get("/:demoId", serveDemo);

	async function serveDemo(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const { sessionId, demoId } = req.params as Record<string, string>;
			if (!DEMO_ID_RE.test(demoId ?? "")) {
				res.status(404).end();
				return;
			}

			// Normalize + confine: the resolved path must stay inside this demo's dir.
			const wild = (req.params as Record<string, unknown>).path;
			const raw = Array.isArray(wild) ? wild.join("/") : typeof wild === "string" ? wild : "";
			const rel = normalize(decodeURIComponent(raw)).replace(/^(\.\.[/\\])+/, "");
			const demoRoot = join(ctx.config.sessionsDir, sessionId, "demo", demoId);
			const target = join(demoRoot, rel);
			if (target !== demoRoot && !target.startsWith(demoRoot + "/") && !target.startsWith(demoRoot + "\\")) {
				res.status(403).end();
				return;
			}

			// Resolve directories (and the empty wildcard) down to index.html.
			const tryPaths = rel === "" ? ["index.html"] : [rel, join(rel, "index.html")];
			let file = "";
			let size = 0;
			for (const p of tryPaths) {
				const abs = join(demoRoot, p);
				// Second confine check after the index.html join (rel itself could
				// already be a directory segment).
				if (abs !== demoRoot && !abs.startsWith(demoRoot + "/") && !abs.startsWith(demoRoot + "\\")) continue;
				try {
					const st = await stat(abs);
					if (!st.isFile()) continue;
					file = abs;
					size = st.size;
					break;
				} catch {
					/* not there — try next */
				}
			}
			if (!file) {
				res.status(404).end();
				return;
			}

			res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
			res.setHeader("content-length", String(size));
			// Demos are immutable per id (a new publish = a new id) — cache freely.
			res.setHeader("cache-control", "private, max-age=3600");
			// Demo HTML is agent-authored. The in-chat viewer iframe sandboxes it,
			// but the URL is same-origin ordinary HTML: a top-level navigation
			// (middle-click / paste) would run it with the user's session cookie.
			// CSP `sandbox` gives the top-level page the SAME opaque origin the
			// iframe has — scripts run, the app origin does not trust them.
			res.setHeader("content-security-policy", "sandbox allow-scripts allow-forms allow-popups");
			createReadStream(file).on("error", next).pipe(res);
		} catch {
			next(new Error("demo serve failed"));
		}
	}

	return router;
}
