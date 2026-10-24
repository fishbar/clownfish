/**
 * HMAC-signed cookie sessions (no new deps).
 *
 * The session cookie is `clownfish_session=<base64url(payload)>.<base64url(hmac)>`,
 * where `payload = JSON.stringify({email,name?,picture?,iat})` and the HMAC is
 * SHA-256 over the payload segment using the session secret. Tampering with
 * either segment invalidates the signature (constant-time compared). This is a
 * stateless cookie session — no server-side store — so logout just clears the
 * cookie; a stolen cookie remains valid until its 7-day expiry.
 *
 * Cookie flags: HttpOnly (no JS access), SameSite=Lax (OAuth GET redirect safe),
 * Secure only when served over TLS (so dev over plain HTTP still works).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "clownfish_session";
export const MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
	email: string;
	name?: string;
	picture?: string;
	/** Issued-at, unix seconds (expiry checked on read). */
	iat: number;
	/**
	 * Session lifetime in seconds. Absent = MAX_AGE_SECONDS. `0` = never
	 * expires server-side — used by token autologin, whose session is meant
	 * to last exactly as long as the app shell keeps the server alive.
	 */
	ttl?: number;
}

function b64u(data: string): string {
	return Buffer.from(data, "utf8").toString("base64url");
}

function sign(secret: string, data: string): string {
	return createHmac("sha256", secret).update(data).digest("base64url");
}

function cookieFlags(secure: boolean, maxAge: number): string {
	const flags = ["Path=/", "HttpOnly", "SameSite=Lax"];
	// maxAge 0 omits the attribute → a browser session cookie: it dies with the
	// browser process, which for the app shell means "until the app quits".
	if (maxAge > 0) flags.push(`Max-Age=${maxAge}`);
	if (secure) flags.push("Secure");
	return flags.join("; ");
}

/**
 * Build the full Set-Cookie value for an authenticated session. Pass
 * `maxAgeSeconds: 0` for a browser-session cookie that never expires
 * server-side (token autologin).
 */
export function createSessionCookie(
	secret: string,
	payload: SessionPayload,
	secure: boolean,
	maxAgeSeconds: number = MAX_AGE_SECONDS,
): string {
	const data = b64u(JSON.stringify(payload));
	const sig = sign(secret, data);
	return `${COOKIE_NAME}=${data}.${sig}; ${cookieFlags(secure, maxAgeSeconds)}`;
}

/** Build a Set-Cookie value that expires the session cookie immediately. */
export function clearSessionCookie(secure: boolean): string {
	return `${COOKIE_NAME}=; ${cookieFlags(secure, 0)}`;
}

/** Parse a `Cookie` header into a simple map (cookie values are not URL-decoded beyond this). */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}

/**
 * Read + verify a session from the `Cookie` header. Returns null when absent,
 * tampered, or expired. The signature comparison is constant-time.
 */
export function readSession(secret: string, cookieHeader: string | undefined): SessionPayload | null {
	const value = parseCookies(cookieHeader)[COOKIE_NAME];
	if (!value) return null;
	const dot = value.lastIndexOf(".");
	if (dot <= 0) return null;
	const data = value.slice(0, dot);
	const sig = value.slice(dot + 1);
	const expected = sign(secret, data);
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let payload: SessionPayload;
	try {
		payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as SessionPayload;
	} catch {
		return null;
	}
	if (typeof payload.email !== "string" || typeof payload.iat !== "number") return null;
	const ttl = typeof payload.ttl === "number" ? payload.ttl : MAX_AGE_SECONDS;
	if (ttl > 0 && Date.now() / 1000 - payload.iat > ttl) return null;
	return payload;
}
