/**
 * requireAuth middleware — gates everything except the auth routes + health.
 *
 * Mounted between `express.json` and `/api`. Order matters: `/auth` and
 * `/api/health` are left open (the login flow + health checks must work without a
 * session). Anything else without a valid session cookie is rejected:
 *   - `/api/*` or non-GET → 401 JSON (the SPA's fetch helper turns this into a
 *     redirect to `/auth/login`).
 *   - a browser GET (page nav, static asset) → 302 to the provider's login page.
 *
 * Disabled when no AuthConfig is supplied (auth off → open, current behavior).
 */
import type { RequestHandler } from "express";
import { loginPath, type AuthConfig } from "./config";
import { readSession } from "./session";

const OPEN_PREFIXES = ["/auth", "/api/health"];

export function requireAuth(cfg: AuthConfig): RequestHandler {
	return (req, res, next) => {
		const path = req.path;
		if (OPEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return next();
		if (readSession(cfg.sessionSecret, req.headers.cookie)) return next();

		// No valid session. API + mutating requests get a 401 the SPA can act on;
		// everything else (browser navigation) redirects to the login entry point.
		if (path.startsWith("/api") || req.method !== "GET") {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		res.redirect(loginPath(cfg));
	};
}
