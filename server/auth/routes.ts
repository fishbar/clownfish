/**
 * Auth HTTP routes (hand-rolled OAuth2/OIDC + simple username/password).
 *
 *   GET  /auth/login             → 302 to the enabled provider's login page
 *                                    (the SPA + requireAuth both target this,
 *                                    so neither needs to know the provider)
 *   GET  /auth/<idp>             → 302 to the provider's consent screen, where
 *                                    <idp> is google | github | oidc (sets a short-
 *                                    lived state+PKCE cookie to bind the round-trip)
 *   GET  /auth/<idp>/callback    → exchange code, enforce the email/domain
 *                                    allowlist, set the session cookie, redirect `/`
 *   GET  /auth/simple            → the login page (self-contained HTML; the
 *                                    password is never sent — see auth/simple.ts)
 *   GET  /auth/simple/challenge  → `{salt, iterations, nonce}` for the page's
 *                                    client-side PBKDF2 + HMAC proof
 *   POST /auth/simple/login      → `{username, nonce, proof}` → session cookie
 *   GET  /auth/me                → 200 `{enabled, authenticated, user?}` (never
 *                                    401, so the SPA can poll without a loop)
 *   POST /auth/logout            → clear the session cookie
 *
 * Token mode additionally mounts `GET /autologin?token=…` at the ROOT (see
 * `createAutologinRouter` below) — the app shell's one-time entry point.
 *
 * `/auth/me` is exposed even when auth is disabled (returns `enabled:false`),
 * so the SPA's status check is uniform. These routes are mounted OUTSIDE
 * requireAuth; the login flow must work pre-session.
 */
import { Router } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAllowed, loginPath, type AuthConfig, type AuthUser, type TokenAuthConfig } from "./config";
import { exchangeCode, fetchIdentity, getAuthorizationUrl, pkcePair, resolveEndpoints } from "./oauth";
import { issueNonce, verifySimpleLogin } from "./simple";
import { simpleLoginPage } from "./simple-page";
import {
	COOKIE_NAME,
	createSessionCookie,
	clearSessionCookie,
	readSession,
	parseCookies,
} from "./session";

const STATE_COOKIE = "clownfish_oauth_state";
const STATE_MAX_AGE = 600; // 10 min — enough to complete the consent round-trip

/** A request is "secure" when the TLS server fielded it (or it claims https). */
function isSecure(req: { secure?: boolean; protocol?: string }): boolean {
	return Boolean(req.secure) || req.protocol === "https";
}

function stateCookie(req: { secure?: boolean; protocol?: string }, value: string, maxAge: number): string {
	const flags = [`Path=/`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
	if (isSecure(req)) flags.push("Secure");
	return `${STATE_COOKIE}=${value}; ${flags.join("; ")}`;
}

export function createAuthRouter(cfg: AuthConfig): Router {
	const router = Router();

	// Provider-agnostic login entry: requireAuth's 302 and the SPA's 401
	// handling both land here, and the provider serves its own page.
	router.get("/login", (_req, res) => {
		res.redirect(loginPath(cfg));
	});

	// Kick off login: stash a random state + PKCE verifier, bounce to the provider.
	if (cfg.provider === "oauth") {
		router.get(`/${cfg.idp}`, async (req, res) => {
			try {
				const ep = await resolveEndpoints(cfg);
				const state = randomBytes(16).toString("hex");
				const { verifier, challenge } = pkcePair();
				res.setHeader("Set-Cookie", stateCookie(req, `${state}.${verifier}`, STATE_MAX_AGE));
				res.redirect(getAuthorizationUrl(cfg, ep, state, challenge));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error("[clownfish] auth: cannot start login:", message);
				res.status(502).send(`Login unavailable: ${message}`);
			}
		});

		// The provider redirects back here with ?code & ?state (or ?error).
		router.get(`/${cfg.idp}/callback`, async (req, res) => {
			const code = typeof req.query.code === "string" ? req.query.code : "";
			const state = typeof req.query.state === "string" ? req.query.state : "";
			const error = typeof req.query.error === "string" ? req.query.error : "";
			if (error) {
				res.setHeader("Set-Cookie", stateCookie(req, "", 0));
				res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
				return;
			}
			const [expectedState, verifier] = (parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "").split(".");
			if (!code || !state || !expectedState || !verifier || state !== expectedState) {
				res.status(400).send("invalid OAuth state — please retry login");
				return;
			}

			try {
				const ep = await resolveEndpoints(cfg);
				const accessToken = await exchangeCode(cfg, ep, code, verifier);
				const info = await fetchIdentity(cfg, ep, accessToken);
				if (!info.email || !info.verified) {
					res.status(400).send(`${cfg.idp} did not return a verified email address`);
					return;
				}
				const email = info.email.toLowerCase();
				// An empty allowlist denies everyone — the safe posture for a tool with
				// filesystem + paid-API access (loadAuthConfig warns loudly about it).
				if (!isAllowed(cfg, email)) {
					console.warn(`[clownfish] auth: denied login for ${email} (not on allowlist)`);
					res.status(403).send(`Access denied: ${email} is not on the allowlist.`);
					return;
				}

				const payload = {
					email,
					name: info.name,
					picture: info.picture,
					iat: Math.floor(Date.now() / 1000),
				};
				res.setHeader("Set-Cookie", [
					createSessionCookie(cfg.sessionSecret, payload, isSecure(req)),
					stateCookie(req, "", 0), // clear the one-shot state cookie
				]);
				console.log(`[clownfish] auth: ${email} logged in via ${cfg.idp}`);
				res.redirect("/");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error("[clownfish] auth: login failed:", message);
				res.status(500).send(`Login failed: ${message}`);
			}
		});
	}

	// Simple mode: login page + the challenge/response pair. The page is fully
	// self-contained (no build step, no SPA assets) — it must render before any
	// session exists, and the SPA never sees it.
	if (cfg.provider === "simple") {
		router.get("/simple", (_req, res) => {
			res.type("html").send(simpleLoginPage());
		});

		// Salt is not secret — it is served to whoever asks, so the page can run
		// the same KDF client-side. Unknown usernames still get a real nonce;
		// verification fails the same way for wrong user and wrong password.
		router.get("/simple/challenge", (_req, res) => {
			res.json({
				salt: cfg.credentials.salt,
				iterations: cfg.credentials.iterations,
				nonce: issueNonce(),
			});
		});

		router.post("/simple/login", (req, res) => {
			const body = (req.body ?? {}) as { username?: string; nonce?: string; proof?: string };
			if (!body.username || !body.nonce || !body.proof) {
				res.status(400).json({ error: "username, nonce and proof are required" });
				return;
			}
			if (!verifySimpleLogin(cfg.credentials, body.username, body.nonce, body.proof)) {
				console.warn(`[clownfish] auth: failed simple login for "${body.username}"`);
				res.status(401).json({ error: "用户名或密码不正确" });
				return;
			}
			const payload = { email: cfg.credentials.username, iat: Math.floor(Date.now() / 1000) };
			res.setHeader("Set-Cookie", createSessionCookie(cfg.sessionSecret, payload, isSecure(req)));
			console.log(`[clownfish] auth: ${cfg.credentials.username} logged in`);
			res.json({ ok: true });
		});
	}

	// Current-user probe (never 401). Returns enabled:true when this router is mounted.
	router.get("/me", (req, res) => {
		const session = readSession(cfg.sessionSecret, req.headers.cookie);
		const user: AuthUser | null = session
			? { email: session.email, name: session.name, picture: session.picture }
			: null;
		res.json({ enabled: true, authenticated: Boolean(user), user });
	});

	router.post("/logout", (req, res) => {
		res.setHeader("Set-Cookie", clearSessionCookie(isSecure(req)));
		res.json({ ok: true });
	});

	return router;
}

/** `/auth/me` handler for the auth-disabled case (always-on, mounted at app level). */
export function authMeDisabled(_req: unknown, res: { json: (b: unknown) => void }): void {
	res.json({ enabled: false, authenticated: true, user: null });
}

// --- one-time token autologin (app shells) ------------------------------------

/** Digest-then-compare, so presentation length leaks nothing either. */
function tokenMatches(expected: string, presented: string): boolean {
	if (!presented) return false;
	const a = createHash("sha256").update(expected).digest();
	const b = createHash("sha256").update(presented).digest();
	return timingSafeEqual(a, b);
}

function autologinDeniedPage(): string {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Clownfish</title>
<style>body{font-family:system-ui,sans-serif;background:#16181d;color:#d7dae0;display:grid;place-items:center;height:100vh;margin:0}
div{max-width:34em;text-align:center;line-height:1.6}h1{font-size:1.1em;font-weight:600}code{background:#22252c;padding:.1em .4em;border-radius:4px}</style></head>
<body><div><h1>无法登录</h1><p>这个服务需要通过 App 打开（或提供有效的一次性 token）。</p>
<p>请从 Clownfish App 重新启动；若直接访问浏览器，请使用 App 启动时给出的 <code>/autologin?token=…</code> 地址。token 只能使用一次。</p></div></body></html>`;
}

/**
 * `GET /autologin?token=…` — the app shell's entry point. The shell injects a
 * random token at spawn and opens its webview here:
 *
 *   - correct token, not yet used → consume it, set a session cookie that
 *     NEVER expires server-side (ttl 0) and is a browser-session cookie
 *     client-side (no Max-Age → dies with the webview, i.e. with the app),
 *     then redirect to `/`. One-time: the token is blanked after first use.
 *   - already holding a valid session → redirect to `/` (the shell's
 *     health-reload re-requests this URL — it must be idempotent).
 *   - anything else → 401 + an explanatory page. Wrong and already-consumed
 *     look identical on purpose.
 *
 * Mounted at the ROOT before requireAuth (`/autologin` is not under `/auth`).
 */
export function createAutologinRouter(cfg: TokenAuthConfig): Router {
	const pending = { token: cfg.token };
	const router = Router();
	router.get("/", (req, res) => {
		// Idempotent for a logged-in webview (the shell reloads this URL once
		// the server answers /api/health — the token may already be consumed).
		if (readSession(cfg.sessionSecret, req.headers.cookie)) {
			res.redirect("/");
			return;
		}
		const presented = typeof req.query.token === "string" ? req.query.token : "";
		if (tokenMatches(pending.token, presented)) {
			pending.token = "";
			const payload = {
				email: "app",
				name: "Clownfish App",
				iat: Math.floor(Date.now() / 1000),
				ttl: 0,
			};
			res.setHeader("Set-Cookie", createSessionCookie(cfg.sessionSecret, payload, isSecure(req), 0));
			console.log("[clownfish] auth: app autologin token accepted (consumed)");
			res.redirect("/");
			return;
		}
		console.warn("[clownfish] auth: autologin rejected (wrong or already-used token)");
		res.status(401).type("html").send(autologinDeniedPage());
	});
	return router;
}
