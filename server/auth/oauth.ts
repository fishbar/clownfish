/**
 * OAuth 2.0 / OIDC client (hand-rolled `fetch`, no SDK dep) — one authorization-
 * code + PKCE flow, three identity providers:
 *
 *   google  fixed endpoints, OIDC userinfo
 *   github  fixed endpoints, `/user` + `/user/emails` (OAuth2, not OIDC: the
 *           primary VERIFIED address is picked from the emails list)
 *   oidc    any OpenID provider — endpoints from `CLOWNFISH_OIDC_ISSUER`'s
 *           discovery document, or set explicitly (`..._AUTH_URL` etc.)
 *
 * Flow: redirect to the consent URL (random `state` + a PKCE S256 challenge) →
 * exchange the returned `code` (+ verifier) for an access token → ask the
 * provider who the user is. Only the access token is used; no ID-token parsing,
 * so there is no JWT/JWKS surface. Access control (email / domain allowlist) is
 * enforced in the callback handler, not here.
 */
import { createHash, randomBytes } from "node:crypto";

export type IdpName = "google" | "github" | "oidc";

export interface OAuthEndpoints {
	authUrl: string;
	tokenUrl: string;
	userinfoUrl: string;
}

export const IDP_PRESETS: Record<"google" | "github", { endpoints: OAuthEndpoints; scope: string }> = {
	google: {
		endpoints: {
			authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
		},
		scope: "openid email profile",
	},
	github: {
		endpoints: {
			authUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
			userinfoUrl: "https://api.github.com/user",
		},
		scope: "read:user user:email",
	},
};

/** The slice of the auth config this module needs (kept structural to avoid an import cycle). */
export interface OAuthClient {
	idp: IdpName;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	scope: string;
	/** oidc only: issuer for discovery, and/or explicit endpoint overrides. */
	issuer?: string;
	endpoints?: Partial<OAuthEndpoints>;
}

export interface Identity {
	email: string;
	verified: boolean;
	name?: string;
	picture?: string;
}

const discovered = new Map<string, Promise<OAuthEndpoints>>();

/** Resolve the endpoints for a client; OIDC discovery is fetched once and cached. */
export async function resolveEndpoints(c: OAuthClient): Promise<OAuthEndpoints> {
	if (c.idp !== "oidc") return IDP_PRESETS[c.idp].endpoints;
	const e = c.endpoints ?? {};
	if (e.authUrl && e.tokenUrl && e.userinfoUrl) return e as OAuthEndpoints;
	if (!c.issuer) throw new Error("oidc: no issuer and no explicit endpoints");
	let p = discovered.get(c.issuer);
	if (!p) {
		p = (async () => {
			const url = `${c.issuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`oidc discovery failed (${res.status}) at ${url}`);
			const d = (await res.json()) as Record<string, string | undefined>;
			const out = {
				authUrl: e.authUrl ?? d.authorization_endpoint,
				tokenUrl: e.tokenUrl ?? d.token_endpoint,
				userinfoUrl: e.userinfoUrl ?? d.userinfo_endpoint,
			};
			if (!out.authUrl || !out.tokenUrl || !out.userinfoUrl) {
				throw new Error("oidc discovery document is missing authorization/token/userinfo endpoints");
			}
			return out as OAuthEndpoints;
		})();
		// A failed discovery must not be cached forever.
		p.catch(() => discovered.delete(c.issuer!));
		discovered.set(c.issuer, p);
	}
	return p;
}

/** PKCE (RFC 7636) S256 verifier + challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function getAuthorizationUrl(c: OAuthClient, ep: OAuthEndpoints, state: string, challenge: string): string {
	const params = new URLSearchParams({
		client_id: c.clientId,
		redirect_uri: c.redirectUri,
		response_type: "code",
		scope: c.scope,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	if (c.idp === "google") {
		params.set("access_type", "online");
		params.set("prompt", "select_account");
	}
	return `${ep.authUrl}${ep.authUrl.includes("?") ? "&" : "?"}${params.toString()}`;
}

/** Exchange an authorization code for an access token. Throws on any error response. */
export async function exchangeCode(c: OAuthClient, ep: OAuthEndpoints, code: string, verifier: string): Promise<string> {
	const res = await fetch(ep.tokenUrl, {
		method: "POST",
		// GitHub answers form-encoded unless asked for JSON.
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams({
			code,
			client_id: c.clientId,
			client_secret: c.clientSecret,
			redirect_uri: c.redirectUri,
			grant_type: "authorization_code",
			code_verifier: verifier,
		}),
	});
	if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await safeText(res)}`);
	const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
	if (data.error) throw new Error(`token exchange error: ${data.error} ${data.error_description ?? ""}`);
	if (!data.access_token) throw new Error("token exchange returned no access_token");
	return data.access_token;
}

/** Ask the provider who the token belongs to. */
export async function fetchIdentity(c: OAuthClient, ep: OAuthEndpoints, accessToken: string): Promise<Identity> {
	const headers = {
		authorization: `Bearer ${accessToken}`,
		accept: "application/json",
		"user-agent": "clownfish",
	};
	if (c.idp === "github") {
		const userRes = await fetch(ep.userinfoUrl, { headers });
		if (!userRes.ok) throw new Error(`github /user failed (${userRes.status}): ${await safeText(userRes)}`);
		const user = (await userRes.json()) as { name?: string; login?: string; avatar_url?: string };
		const emailsRes = await fetch(new URL("/user/emails", ep.userinfoUrl).toString(), { headers });
		if (!emailsRes.ok) throw new Error(`github /user/emails failed (${emailsRes.status}): ${await safeText(emailsRes)}`);
		const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
		const primary = emails.find((e) => e.primary) ?? emails[0];
		return {
			email: primary?.email ?? "",
			verified: Boolean(primary?.verified),
			name: user.name ?? user.login,
			picture: user.avatar_url,
		};
	}
	const res = await fetch(ep.userinfoUrl, { headers });
	if (!res.ok) throw new Error(`userinfo failed (${res.status}): ${await safeText(res)}`);
	const u = (await res.json()) as { email?: string; email_verified?: boolean | string; name?: string; picture?: string };
	return {
		email: u.email ?? "",
		// Some OIDC providers send the boolean as the string "true".
		verified: u.email_verified === true || u.email_verified === "true",
		name: u.name,
		picture: u.picture,
	};
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 200);
	} catch {
		return res.statusText;
	}
}
