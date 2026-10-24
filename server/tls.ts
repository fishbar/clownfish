/**
 * HTTPS/TLS resolution for the server.
 *
 * When `config.tls` is on, the server is created with `https.createServer` and
 * the browser WebSocket hub automatically becomes `wss://`. The cert/key pair is
 * either supplied explicitly (via `CLOWNFISH_TLS_CERT` / `_KEY`) or — when neither
 * is given — **auto-generated as a self-signed certificate and cached** under
 * `<dataDir>/certs/` so subsequent boots reuse it instead of regenerating. The
 * generated cert covers localhost, 127.0.0.1, the hostname, and every non-
 * internal LAN IPv4, so it's trusted once across the board on a LAN.
 *
 * The Unix-domain agent socket (`uds.ts`) deliberately stays plain `node:http` —
 * TLS over a UDS would be pointless.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { generate as generateSelfSigned } from "selfsigned";
import type { ServerOptions } from "node:https";
import type { ServerConfig } from "./config";

const CERT_DIR = "certs";
const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";

/** Non-internal IPv4 LAN addresses, for the generated cert's subjectAltName. */
function lanIpv4s(): string[] {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
		}
	}
	return [...new Set(out)];
}

/**
 * Resolve the HTTPS server options, or `undefined` to stay on plain HTTP.
 * Auto-generates + caches a self-signed cert when none is supplied.
 */
export async function resolveTlsOptions(config: ServerConfig): Promise<ServerOptions | undefined> {
	if (!config.tls) return undefined;

	// Explicit cert + key paths take precedence.
	if (config.tlsCert && config.tlsKey) {
		const [cert, key] = await Promise.all([
			readFile(config.tlsCert, "utf8"),
			readFile(config.tlsKey, "utf8"),
		]);
		console.log(`[clownfish] HTTPS: using supplied cert (${config.tlsCert})`);
		return { cert, key };
	}

	const dir = join(config.dataDir, CERT_DIR);
	const certPath = join(dir, CERT_FILE);
	const keyPath = join(dir, KEY_FILE);

	// Reuse the cached pair if present.
	const [cachedCert, cachedKey] = await Promise.all([
		readFile(certPath, "utf8").catch(() => null),
		readFile(keyPath, "utf8").catch(() => null),
	]);
	if (cachedCert && cachedKey) {
		console.log(`[clownfish] HTTPS: reusing cached self-signed cert (${certPath})`);
		return { cert: cachedCert, key: cachedKey };
	}

	// Generate a fresh self-signed cert and cache it.
	const cn = config.tlsHost ?? hostname();
	// selfsigned v5 doesn't export its extension union types; the array is built
	// to match (basicConstraints + keyUsage + extKeyUsage + subjectAltName).
	const altNames: Array<{ type: 2; value: string } | { type: 7; ip: string }> = [
		{ type: 2, value: "localhost" },
		{ type: 7, ip: "127.0.0.1" },
	];
	if (cn && cn !== "localhost") altNames.push({ type: 2, value: cn });
	for (const ip of lanIpv4s()) altNames.push({ type: 7, ip });
	const extensions = [
		{ name: "basicConstraints", cA: false },
		{ name: "keyUsage", digitalSignature: true, keyEncipherment: true },
		{ name: "extKeyUsage", serverAuth: true },
		{ name: "subjectAltName", altNames },
	];
	// selfsigned v5 doesn't export its option/extension union types, so cast the
	// whole options object to the inferred parameter type.
	const pems = await generateSelfSigned([{ name: "commonName", value: cn }], {
		keySize: 2048,
		algorithm: "sha256",
		extensions,
	} as Parameters<typeof generateSelfSigned>[1]);

	await mkdir(dir, { recursive: true });
	await writeFile(certPath, pems.cert, { mode: 0o644 });
	await writeFile(keyPath, pems.private, { mode: 0o600 });
	console.log(
		`[clownfish] HTTPS: generated self-signed cert for ${cn} (SAN: ${altNames
			.map((a) => ("value" in a ? a.value : a.ip))
			.join(", ")}); cached at ${certPath}. Browsers will warn — trust it manually.`,
	);
	return { cert: pems.cert, key: pems.private };
}
