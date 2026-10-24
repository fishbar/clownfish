/**
 * Offline checks for auth configuration + the OAuth client, run from the e2e
 * entry point.
 *
 * The property that matters: a login that was REQUESTED but cannot be set up
 * must stop the boot (AuthConfigError), never degrade to an open server. The
 * OAuth half runs against a local mock OIDC provider, so PKCE, discovery and
 * the identity lookup are proven with real HTTP rather than assumed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthConfigError, isAllowed, loadAuthConfig, loginPath, type OAuthAuthConfig } from "../server/auth/config";
import { exchangeCode, fetchIdentity, getAuthorizationUrl, pkcePair, resolveEndpoints } from "../server/auth/oauth";

let checks = 0;
const ok = (name: string, cond: boolean, detail?: string): void => {
	assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
	checks++;
};

const dataDir = mkdtempSync(join(tmpdir(), "clownfish-auth-"));
const AUTH_ENV = /^(CLOWNFISH_AUTH|CLOWNFISH_OIDC|GOOGLE_|GITHUB_|OIDC_|OAUTH_|SESSION_SECRET)/;
const withEnv = <T,>(vars: Record<string, string>, fn: () => T): T => {
	for (const k of Object.keys(process.env)) if (AUTH_ENV.test(k)) delete process.env[k];
	Object.assign(process.env, vars);
	try {
		return fn();
	} finally {
		for (const k of Object.keys(vars)) delete process.env[k];
	}
};
const throwsAuth = (vars: Record<string, string>): boolean =>
	withEnv(vars, () => {
		try {
			loadAuthConfig(dataDir);
			return false;
		} catch (e) {
			return e instanceof AuthConfigError;
		}
	});

// --- off by default, off only when explicit ----------------------------------
for (const v of ["", "off", "0", "false", "none"]) {
	ok(`CLOWNFISH_AUTH="${v}" leaves auth off`, withEnv({ CLOWNFISH_AUTH: v }, () => loadAuthConfig(dataDir)) === null);
}
ok("unset leaves auth off", withEnv({}, () => loadAuthConfig(dataDir)) === null);

// --- requested but unusable => refuse to boot --------------------------------
ok("a typo'd mode is refused, not treated as off", throwsAuth({ CLOWNFISH_AUTH: "gogle" }));
ok("google without creds is refused", throwsAuth({ CLOWNFISH_AUTH: "google" }));
ok("google missing only the redirect is refused", throwsAuth({ CLOWNFISH_AUTH: "google", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s" }));
ok("github without creds is refused", throwsAuth({ CLOWNFISH_AUTH: "github" }));
ok("token without CLOWNFISH_AUTH_TOKEN is refused", throwsAuth({ CLOWNFISH_AUTH: "token" }));
ok("simple without simple.json is refused", throwsAuth({ CLOWNFISH_AUTH: "simple" }));
ok(
	"oidc with neither issuer nor endpoints is refused",
	throwsAuth({ CLOWNFISH_AUTH: "oidc", OIDC_CLIENT_ID: "i", OIDC_CLIENT_SECRET: "s", CLOWNFISH_AUTH_REDIRECT: "http://x/auth/oidc/callback" }),
);

// --- configured providers -----------------------------------------------------
const google = withEnv(
	{ CLOWNFISH_AUTH: "google", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec", CLOWNFISH_AUTH_REDIRECT: "http://h/auth/google/callback", CLOWNFISH_AUTH_ALLOWED_EMAILS: "A@x.com, b@x.com" },
	() => loadAuthConfig(dataDir),
) as OAuthAuthConfig;
ok("google config parses", google?.provider === "oauth" && google.idp === "google");
ok("login entry is /auth/google (callback path unchanged)", loginPath(google) === "/auth/google");
ok("emails are lowercased + trimmed", google.allowedEmails.has("a@x.com") && google.allowedEmails.has("b@x.com"));
ok("legacy CLOWNFISH_AUTH=true still means google", (withEnv(
	{ CLOWNFISH_AUTH: "true", GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", CLOWNFISH_AUTH_REDIRECT: "http://h/cb" },
	() => loadAuthConfig(dataDir),
) as OAuthAuthConfig).idp === "google");

const gh = withEnv(
	{ CLOWNFISH_AUTH: "github", OAUTH_CLIENT_ID: "i", OAUTH_CLIENT_SECRET: "s", CLOWNFISH_AUTH_REDIRECT: "http://h/auth/github/callback" },
	() => loadAuthConfig(dataDir),
) as OAuthAuthConfig;
ok("github takes the generic OAUTH_CLIENT_* names", gh.idp === "github" && gh.scope === "read:user user:email");
ok("empty allowlist denies everyone", !isAllowed(gh, "anyone@example.com"));

// --- allowlist: exact email OR domain ------------------------------------------
const dom = withEnv(
	{ CLOWNFISH_AUTH: "github", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", CLOWNFISH_AUTH_REDIRECT: "http://h/cb", CLOWNFISH_AUTH_ALLOWED_DOMAINS: "@Corp.com", CLOWNFISH_AUTH_ALLOWED_EMAILS: "guest@other.org" },
	() => loadAuthConfig(dataDir),
) as OAuthAuthConfig;
ok("domain allowlist admits a member", isAllowed(dom, "Dev@corp.com"));
ok("explicit email outside the domain is admitted", isAllowed(dom, "guest@other.org"));
ok("a lookalike domain is refused", !isAllowed(dom, "dev@evilcorp.com"));
ok("a subdomain is refused (exact match only)", !isAllowed(dom, "dev@mail.corp.com"));
ok("the domain as a local part is refused", !isAllowed(dom, "corp.com@evil.org"));
ok("an address with no @ is refused", !isAllowed(dom, "corp.com"));

// --- PKCE ------------------------------------------------------------------------
const { verifier, challenge } = pkcePair();
ok("PKCE challenge is S256(verifier)", challenge === createHash("sha256").update(verifier).digest("base64url"));
ok("PKCE verifiers are not reused", pkcePair().verifier !== verifier);

// --- OAuth client against a mock OIDC provider ------------------------------------
let tokenBody = new URLSearchParams();
let userinfoAuth = "";
const idp = createServer((req, res) => {
	const host = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
	if (req.url === "/.well-known/openid-configuration") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ authorization_endpoint: `${host}/authorize`, token_endpoint: `${host}/token`, userinfo_endpoint: `${host}/userinfo` }));
	} else if (req.url === "/token") {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			tokenBody = new URLSearchParams(body);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ access_token: "at-123" }));
		});
	} else if (req.url === "/userinfo") {
		userinfoAuth = String(req.headers.authorization);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ email: "Dev@Corp.com", email_verified: "true", name: "Dev" }));
	} else {
		res.statusCode = 404;
		res.end();
	}
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
try {
	const oidc = withEnv(
		{ CLOWNFISH_AUTH: "oidc", CLOWNFISH_OIDC_ISSUER: `${issuer}/`, OIDC_CLIENT_ID: "cid", OIDC_CLIENT_SECRET: "csec", CLOWNFISH_AUTH_REDIRECT: "http://h/auth/oidc/callback", CLOWNFISH_AUTH_ALLOWED_DOMAINS: "corp.com" },
		() => loadAuthConfig(dataDir),
	) as OAuthAuthConfig;
	ok("oidc config parses with an issuer only", oidc.idp === "oidc" && loginPath(oidc) === "/auth/oidc");

	const ep = await resolveEndpoints(oidc);
	ok("endpoints come from the discovery document", ep.tokenUrl === `${issuer}/token` && ep.authUrl === `${issuer}/authorize`);

	const url = new URL(getAuthorizationUrl(oidc, ep, "st", challenge));
	ok("consent URL carries state, S256 challenge and the client id",
		url.searchParams.get("state") === "st" &&
			url.searchParams.get("code_challenge") === challenge &&
			url.searchParams.get("code_challenge_method") === "S256" &&
			url.searchParams.get("client_id") === "cid");

	const token = await exchangeCode(oidc, ep, "the-code", verifier);
	ok("token exchange returns the access token", token === "at-123");
	ok("the PKCE verifier reaches the token endpoint", tokenBody.get("code_verifier") === verifier);
	ok("code and grant_type are sent", tokenBody.get("code") === "the-code" && tokenBody.get("grant_type") === "authorization_code");

	const who = await fetchIdentity(oidc, ep, token);
	ok("identity is looked up with the bearer token", userinfoAuth === "Bearer at-123");
	ok("string email_verified:\"true\" counts as verified", who.verified === true && who.email === "Dev@Corp.com");
	ok("the resolved identity passes the domain allowlist", isAllowed(oidc, who.email));
} finally {
	idp.close();
	rmSync(dataDir, { recursive: true, force: true });
}

console.log(`auth config: ${checks} checks passed`);
