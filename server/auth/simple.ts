/**
 * Simple login mode — username + password, no OAuth.
 *
 * The password never crosses the wire and is never stored. What the server
 * keeps (`<dataDir>/auth/simple.json`, mode 0600) is a DERIVED key:
 *
 *   K = PBKDF2-SHA256(password, salt, iterations, 32 bytes)
 *
 * and login is a challenge/response: the browser fetches a one-time nonce,
 * derives the same K client-side (WebCrypto PBKDF2 — same parameters, which is
 * why they live in the file and ride the challenge response), and proves
 * knowledge with HMAC-SHA256(K, nonce). The server compares against its own
 * HMAC over the stored K (constant-time). So:
 *
 *   - a passive sniffer sees neither the password nor anything replayable
 *     (each nonce is single-use, 3-minute TTL);
 *   - an attacker who steals simple.json holds K — a password-equivalent —
 *     exactly like any stolen password file; that is TLS's job (CLOWNFISH_TLS).
 *
 * This is the "略加保护" tier: real mutual authentication without the weight
 * of SRP, for a tool whose usual posture is loopback + no login at all.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/** PBKDF2 work factor — OWASP 2023 recommendation for PBKDF2-SHA256. */
export const PBKDF2_ITERATIONS = 210_000;
const KEY_BITS = 256;
const NONCE_TTL_MS = 3 * 60 * 1000;
const MAX_PENDING_NONCES = 1000;

export interface SimpleCredentials {
	username: string;
	/** Random 16 bytes, hex. Served to the login page (salts are not secret). */
	salt: string;
	iterations: number;
	/** K = PBKDF2(password, salt, iterations) — base64. Password-equivalent. */
	key: string;
}

const AUTH_DIR = "auth";
const CREDENTIALS_FILE = "simple.json";

/** Derive credentials from a plaintext password (the CLI wizard's path). */
export function createSimpleCredentials(username: string, password: string): SimpleCredentials {
	const salt = randomBytes(16).toString("hex");
	return {
		username,
		salt,
		iterations: PBKDF2_ITERATIONS,
		key: pbkdf2Sync(password, Buffer.from(salt, "hex"), PBKDF2_ITERATIONS, KEY_BITS / 8, "sha256").toString("base64"),
	};
}

export function simpleCredentialsPath(dataDir: string): string {
	return join(dataDir, AUTH_DIR, CREDENTIALS_FILE);
}

export function loadSimpleCredentials(dataDir: string): SimpleCredentials | null {
	try {
		const raw = JSON.parse(readFileSync(simpleCredentialsPath(dataDir), "utf8")) as SimpleCredentials;
		if (typeof raw.username === "string" && typeof raw.salt === "string" && typeof raw.key === "string") {
			return { ...raw, iterations: typeof raw.iterations === "number" ? raw.iterations : PBKDF2_ITERATIONS };
		}
		return null;
	} catch {
		return null;
	}
}

export function saveSimpleCredentials(dataDir: string, creds: SimpleCredentials): void {
	const dir = join(dataDir, AUTH_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(simpleCredentialsPath(dataDir), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// --- challenge nonces -------------------------------------------------------
// Module-level: single-user tool, one process issues and consumes them. Each
// nonce is consumed on FIRST verify attempt (right or wrong) and expires on a
// timer, so a captured nonce is worthless — including one captured from the
// challenge response itself.

const pendingNonces = new Map<string, number>(); // nonce hex → expires-at (ms)

/** Issue a one-time nonce (hex). Old entries are pruned opportunistically. */
export function issueNonce(): string {
	const now = Date.now();
	for (const [n, at] of pendingNonces) if (at < now) pendingNonces.delete(n);
	// Unauthenticated callers can mint these: cap the map (oldest first).
	while (pendingNonces.size >= MAX_PENDING_NONCES) pendingNonces.delete(pendingNonces.keys().next().value as string);
	const nonce = randomBytes(16).toString("hex");
	pendingNonces.set(nonce, now + NONCE_TTL_MS);
	return nonce;
}

/**
 * Verify a login attempt: username + HMAC proof over the (single-use) nonce.
 * Returns false on any mismatch — no detail, so the response can't leak which
 * part was wrong.
 */
export function verifySimpleLogin(
	creds: SimpleCredentials,
	username: string,
	nonce: string,
	proof: string,
): boolean {
	const expires = pendingNonces.get(nonce);
	pendingNonces.delete(nonce); // single-use: consumed even on failure
	if (expires === undefined || expires < Date.now()) return false;
	if (typeof username !== "string" || typeof proof !== "string") return false;

	const userOk = Buffer.from(username).length === Buffer.from(creds.username).length
		&& timingSafeEqual(Buffer.from(username), Buffer.from(creds.username));

	const expected = createHmac("sha256", Buffer.from(creds.key, "base64"))
		.update(Buffer.from(nonce, "hex"))
		.digest("hex");
	const got = Buffer.from(proof);
	const want = Buffer.from(expected);
	const proofOk = got.length === want.length && timingSafeEqual(got, want);

	return userOk && proofOk;
}
