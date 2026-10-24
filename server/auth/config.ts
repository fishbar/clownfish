/**
 * Auth configuration (opt-in: OAuth2/OIDC login with an email/domain allowlist,
 * or simple username+password).
 *
 * Auth is OFF by default. `CLOWNFISH_AUTH=google|github|oidc` (plus that
 * provider's client creds) or `CLOWNFISH_AUTH=simple` (plus
 * `<dataDir>/auth/simple.json`, written by the first-run wizard) turns it on.
 * Credentials never live in code — they come from
 * the environment or `settings.json`'s `env:{}` block (which is applied to
 * `process.env` set-if-missing before this runs), exactly like the provider
 * credentials.
 *
 * The session-signing secret is auto-generated + cached under
 * `<dataDir>/auth/session.key` if `SESSION_SECRET` isn't supplied, mirroring the
 * self-signed-cert cache in `server/tls.ts`. An empty allowlist denies everyone
 * — that's the safe posture for a tool with filesystem + paid-API access, but we
 * warn loudly so it's never a silent lockout.
 *
 * FAIL CLOSED: once auth is *requested* (any value other than an explicit "off"),
 * an incomplete or unrecognized configuration throws `AuthConfigError` and the
 * server refuses to boot. Silently degrading to an open server would turn a typo
 * or a missing secret into a wide-open agent with filesystem access.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadSimpleCredentials, type SimpleCredentials } from "./simple";
import type { IdpName, OAuthClient } from "./oauth";

/** Auth was requested but cannot be honoured — boot must stop, not run open. */
export class AuthConfigError extends Error {}

export interface AuthUser {
	email: string;
	name?: string;
	picture?: string;
}

export interface OAuthAuthConfig extends OAuthClient {
	provider: "oauth";
	/** Lowercased emails allowed to sign in. */
	allowedEmails: Set<string>;
	/** Lowercased email domains (`example.com`) allowed to sign in. */
	allowedDomains: Set<string>;
	sessionSecret: string;
}

/** Simple mode: the PBKDF2 verifier lives in the config once loaded. */
export interface SimpleAuthConfig {
	provider: "simple";
	credentials: SimpleCredentials;
	sessionSecret: string;
}

/**
 * Token mode — for the OS app shells. The shell generates a random one-time
 * token, injects it at spawn, and points the webview at `/autologin?token=…`.
 * There is deliberately no human login page: the ONLY way in is the token,
 * and it works exactly once.
 */
export interface TokenAuthConfig {
	provider: "token";
	/** The one-time token (from CLOWNFISH_AUTH_TOKEN). Consumed on first use. */
	token: string;
	sessionSecret: string;
}

export type AuthConfig = OAuthAuthConfig | SimpleAuthConfig | TokenAuthConfig;

/** Where an unauthenticated browser is sent — provider's login entry page. */
export function loginPath(cfg: AuthConfig): string {
	if (cfg.provider === "oauth") return `/auth/${cfg.idp}`;
	if (cfg.provider === "token") return "/autologin";
	return "/auth/simple";
}

const SESSION_KEY_DIR = "auth";
const SESSION_KEY_FILE = "session.key";

/** Load + cache the session-signing secret (32 random bytes, hex). */
function loadOrCreateSessionSecret(dataDir: string): string {
	const dir = join(dataDir, SESSION_KEY_DIR);
	const file = join(dir, SESSION_KEY_FILE);
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (existing) return existing;
	} catch {
		/* not present yet */
	}
	mkdirSync(dir, { recursive: true });
	const generated = randomBytes(32).toString("hex");
	writeFileSync(file, generated, { mode: 0o600 });
	return generated;
}

const OFF_VALUES = new Set(["", "off", "0", "false", "no", "none", "disabled"]);
const IDPS: readonly IdpName[] = ["google", "github", "oidc"];

/** First non-empty env var among `names`. */
function env(...names: string[]): string | undefined {
	for (const n of names) {
		const v = process.env[n]?.trim();
		if (v) return v;
	}
	return undefined;
}

const csv = (v: string | undefined): string[] =>
	(v ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

/**
 * Resolve the auth config from the environment. Returns `null` ONLY when auth
 * is off (unset or an explicit off value); throws `AuthConfigError` when auth
 * was requested but cannot be set up.
 */
export function loadAuthConfig(dataDir: string): AuthConfig | null {
	// `make dev` sets an explicit `off` so a settings.json that enables auth
	// can't silently gate local dev.
	const raw = (process.env.CLOWNFISH_AUTH ?? "").trim().toLowerCase();
	if (OFF_VALUES.has(raw)) return null;

	// "1"/"true" predate multi-provider support and meant Google.
	const mode = raw === "1" || raw === "true" ? "google" : raw;

	// Token mode: the app shell passes the token over the spawn environment —
	// never written anywhere on disk.
	if (mode === "token") {
		const token = process.env.CLOWNFISH_AUTH_TOKEN?.trim() ?? "";
		if (!token) throw new AuthConfigError("CLOWNFISH_AUTH=token but CLOWNFISH_AUTH_TOKEN is not set.");
		const sessionSecret = process.env.SESSION_SECRET?.trim() || loadOrCreateSessionSecret(dataDir);
		console.log("[clownfish] auth: one-time token autologin enabled (for the app shell).");
		return { provider: "token", token, sessionSecret };
	}

	// Simple mode: no OAuth creds to check — the wizard (or a hand-written file)
	// put the PBKDF2 verifier under <dataDir>/auth/simple.json.
	if (mode === "simple") {
		const credentials = loadSimpleCredentials(dataDir);
		if (!credentials) {
			throw new AuthConfigError(
				"CLOWNFISH_AUTH=simple but no credentials found at <dataDir>/auth/simple.json — run the server once in a terminal to use the setup wizard, or `npm run login`.",
			);
		}
		const sessionSecret = process.env.SESSION_SECRET?.trim() || loadOrCreateSessionSecret(dataDir);
		console.log(`[clownfish] auth: simple login enabled (user: ${credentials.username}).`);
		return { provider: "simple", credentials, sessionSecret };
	}

	if (!(IDPS as readonly string[]).includes(mode)) {
		throw new AuthConfigError(
			`CLOWNFISH_AUTH="${raw}" is not recognized (expected simple | google | github | oidc | token, or "off" to disable).`,
		);
	}
	const idp = mode as IdpName;
	const PREFIX = idp.toUpperCase();
	const clientId = env(`${PREFIX}_CLIENT_ID`, "OAUTH_CLIENT_ID");
	const clientSecret = env(`${PREFIX}_CLIENT_SECRET`, "OAUTH_CLIENT_SECRET");
	const redirectUri = env("CLOWNFISH_AUTH_REDIRECT");
	const missing = [
		!clientId && `${PREFIX}_CLIENT_ID`,
		!clientSecret && `${PREFIX}_CLIENT_SECRET`,
		!redirectUri && "CLOWNFISH_AUTH_REDIRECT",
	].filter(Boolean);
	if (missing.length) {
		throw new AuthConfigError(`CLOWNFISH_AUTH=${idp} but ${missing.join(" / ")} ${missing.length > 1 ? "are" : "is"} not set.`);
	}

	let issuer: string | undefined;
	let endpoints: OAuthClient["endpoints"];
	let scope = idp === "github" ? "read:user user:email" : "openid email profile";
	if (idp === "oidc") {
		issuer = env("CLOWNFISH_OIDC_ISSUER");
		endpoints = {
			authUrl: env("CLOWNFISH_OIDC_AUTH_URL"),
			tokenUrl: env("CLOWNFISH_OIDC_TOKEN_URL"),
			userinfoUrl: env("CLOWNFISH_OIDC_USERINFO_URL"),
		};
		if (!issuer && !(endpoints.authUrl && endpoints.tokenUrl && endpoints.userinfoUrl)) {
			throw new AuthConfigError(
				"CLOWNFISH_AUTH=oidc needs CLOWNFISH_OIDC_ISSUER, or all of CLOWNFISH_OIDC_AUTH_URL / _TOKEN_URL / _USERINFO_URL.",
			);
		}
		scope = env("CLOWNFISH_OIDC_SCOPE") ?? scope;
	}

	const allowedEmails = new Set(csv(process.env.CLOWNFISH_AUTH_ALLOWED_EMAILS));
	const allowedDomains = new Set(csv(process.env.CLOWNFISH_AUTH_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "")));
	if (allowedEmails.size === 0 && allowedDomains.size === 0) {
		console.warn(
			"[clownfish] auth: enabled with an EMPTY allowlist (CLOWNFISH_AUTH_ALLOWED_EMAILS / CLOWNFISH_AUTH_ALLOWED_DOMAINS) — NOBODY will be able to log in.",
		);
	}

	const sessionSecret = process.env.SESSION_SECRET?.trim() || loadOrCreateSessionSecret(dataDir);

	console.log(
		`[clownfish] auth: ${idp} OAuth enabled (redirect=${redirectUri}, allowlist=${allowedEmails.size} email(s) + ${allowedDomains.size} domain(s)).`,
	);
	return {
		provider: "oauth",
		idp,
		clientId: clientId!,
		clientSecret: clientSecret!,
		redirectUri: redirectUri!,
		scope,
		issuer,
		endpoints,
		allowedEmails,
		allowedDomains,
		sessionSecret,
	};
}

/** Lowercase + check the address, then its domain, against the allowlists. */
export function isAllowed(cfg: OAuthAuthConfig, email: string): boolean {
	const e = email.toLowerCase();
	if (cfg.allowedEmails.has(e)) return true;
	const at = e.lastIndexOf("@");
	return at > 0 && cfg.allowedDomains.has(e.slice(at + 1));
}
