/**
 * OpenAI login (ChatGPT Plus/Pro) + HTTPS proxy — offline checks.
 *
 * The actual OAuth browser flow cannot be exercised here (it needs a real
 * browser + a real OpenAI account), so what's proven instead is the part
 * that decides whether the whole feature works at all: does a credential
 * once written to disk actually come back out through pi-ai's own auth
 * resolution (`Models.getAuth`), with NO custom code in `resolveRuntime`
 * beyond wiring the file-backed store in? That is the single load-bearing
 * claim ("log in once, every later request just works") and it needs zero
 * network access to verify.
 */
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createFileCredentialStore, createAuthContext } from "../agent/oauth-credential-store.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { OAuthCredential } from "@earendil-works/pi-ai";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- credential store: round-trip, atomicity, permissions -------------------
const dataDir = mkdtempSync(join(tmpdir(), "codex-auth-"));
const store = createFileCredentialStore(dataDir);
const credPath = join(dataDir, "auth", "oauth-credentials.json");

check("read on an empty store is undefined, not a throw", (await store.read("openai-codex")) === undefined);
check("list on an empty store is empty", (await store.list()).length === 0);

const fakeCred: OAuthCredential = { type: "oauth", access: "fake-access-token", refresh: "fake-refresh-token", expires: Date.now() + 3_600_000 };
const written = await store.modify("openai-codex", async () => fakeCred);
check("modify() returns the written credential", written?.access === "fake-access-token");
check("the file actually exists after a write", existsSync(credPath));
check("the file is 0600 (owner read/write only)", (statSync(credPath).mode & 0o777) === 0o600);

const reread = await store.read("openai-codex");
check("read() sees what modify() wrote", reread?.type === "oauth" && (reread as OAuthCredential).access === "fake-access-token");

const listed = await store.list();
check("list() reports it without exposing the secret", listed.length === 1 && listed[0].providerId === "openai-codex" && listed[0].type === "oauth" && !("access" in listed[0]));

// A fresh store instance pointed at the SAME dataDir (simulates a worker restart).
const store2 = createFileCredentialStore(dataDir);
const reread2 = await store2.read("openai-codex");
check("a NEW store instance at the same dataDir sees the same credential (survives a restart)", (reread2 as OAuthCredential)?.access === "fake-access-token");

await store.modify("api-key-provider", async () => ({ type: "api_key", key: "sk-fake" }));
const stillThere = await store.read("openai-codex");
check("writing a DIFFERENT provider's credential does not disturb this one", (stillThere as OAuthCredential)?.access === "fake-access-token");

await store.delete("openai-codex");
check("delete() removes exactly that provider's credential", (await store.read("openai-codex")) === undefined);
check("a sibling provider's credential survives the delete", (await store.read("api-key-provider"))?.type === "api_key");

// --- the load-bearing claim: a stored credential resolves through pi-ai's OWN auth path ---
await store.modify("openai-codex", async () => fakeCred);
const models = builtinModels({ credentials: store, authContext: createAuthContext() });
const resolved = await models.getAuth("openai-codex");
check(
	"Models.getAuth resolves the STORED access token as apiKey — no custom code needed at request time",
	resolved?.auth.apiKey === "fake-access-token",
	JSON.stringify(resolved),
);

// --- AuthContext: env() reads real process.env, fileExists() expands ~ ------
const ctx = createAuthContext();
process.env.CODEX_CHECK_PROBE_VAR = "probe-value";
check("AuthContext.env reads real process.env", (await ctx.env("CODEX_CHECK_PROBE_VAR")) === "probe-value");
delete process.env.CODEX_CHECK_PROBE_VAR;
check("AuthContext.fileExists finds a real file", await ctx.fileExists(credPath));
check("AuthContext.fileExists is false for a missing file", !(await ctx.fileExists(join(dataDir, "no-such-file"))));

rmSync(dataDir, { recursive: true, force: true });

// --- HTTPS proxy: routes ONLY OpenAI hosts, everything else stays untouched ---
// The real risk this guards against: a naive global-dispatcher install would
// route EVERY fetch in the process through the proxy the moment ANY provider
// happened to be openai/openai-codex — including a different provider's own
// requests, WebFetch, MCP servers. That was this feature's first version,
// caught in review. Proven here with an ACTUAL local server and an ACTUAL
// (dead) proxy target — not just "a dispatcher object changed" — because
// that distinction is exactly what the first version's tests missed.
const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const localServer = createServer((_req, res) => res.end("local-ok"));
await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
const localPort = (localServer.address() as { port: number }).port;

try {
	const { installHttpsProxyIfConfigured, resetHttpsProxyForTests } = await import("../agent/models.ts");
	for (const k of ["OPENAI_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete process.env[k];

	resetHttpsProxyForTests();
	installHttpsProxyIfConfigured();
	check("no proxy env set → fetch is left completely untouched", globalThis.fetch === savedFetch);
	const untouched = await fetch(`http://127.0.0.1:${localPort}/`).then((r) => r.text());
	check("a real request still works with no proxy configured", untouched === "local-ok");

	// A deliberately UNREACHABLE proxy: only used to prove WHERE a request
	// tries to connect, never to actually complete one.
	process.env.HTTPS_PROXY = "http://127.0.0.1:9";
	resetHttpsProxyForTests();
	installHttpsProxyIfConfigured();
	check("a proxy env var → fetch IS wrapped", globalThis.fetch !== savedFetch);

	const localStillWorks = await fetch(`http://127.0.0.1:${localPort}/`).then((r) => r.text());
	check("an UNRELATED host bypasses the proxy entirely — the real bug this replaces", localStillWorks === "local-ok");

	const openaiAttempt = await fetch("https://api.openai.com/v1/models").then(
		() => "unexpected-success",
		(err) => String(err.cause?.message ?? err.message),
	);
	check(
		"api.openai.com is routed to the configured proxy (fails trying to reach IT, not the real host)",
		/127\.0\.0\.1:9|ECONNREFUSED/.test(openaiAttempt),
		openaiAttempt,
	);

	const wrappedOnce = globalThis.fetch;
	installHttpsProxyIfConfigured();
	check("installing twice does not re-wrap (idempotent)", globalThis.fetch === wrappedOnce);

	delete process.env.HTTPS_PROXY;
	process.env.OPENAI_HTTPS_PROXY = "http://127.0.0.1:9";
	resetHttpsProxyForTests();
	installHttpsProxyIfConfigured();
	const overrideAttempt = await fetch("https://api.openai.com/v1/models").then(
		() => "unexpected-success",
		(err) => String(err.cause?.message ?? err.message),
	);
	check("OPENAI_HTTPS_PROXY (the clownfish-specific override) is honored too", /127\.0\.0\.1:9|ECONNREFUSED/.test(overrideAttempt), overrideAttempt);
} finally {
	localServer.close();
	globalThis.fetch = savedFetch;
	for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
	for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
	const { resetHttpsProxyForTests } = await import("../agent/models.ts");
	resetHttpsProxyForTests();
}

console.log(`openai-codex + proxy: ${passed} checks passed`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
