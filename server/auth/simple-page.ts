/**
 * The simple-mode login page — one self-contained HTML string.
 *
 * No SPA assets, no build step: it must render before any session exists and
 * before the Vite dev server is even involved (the page IS what requireAuth
 * redirects an unauthenticated browser to). The script does the challenge/
 * response from auth/simple.ts:
 *
 *   1. GET /auth/simple/challenge  → {salt, iterations, nonce}
 *   2. K    = PBKDF2-SHA256(password, salt, iterations)   (WebCrypto)
 *   3. proof = HMAC-SHA256(K, nonce) — hex
 *   4. POST /auth/simple/login {username, nonce, proof}   → session cookie
 *
 * The plaintext password never leaves the page.
 */

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

const bytesToHex = (buf: ArrayBuffer): string =>
	[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The login page's inline script, as a plain string (no template placeholders). */
const PAGE_SCRIPT = `
const form = document.getElementById("form");
const err = document.getElementById("err");
const btn = document.getElementById("btn");
const user = document.getElementById("username");
const pass = document.getElementById("password");
user.focus();

async function deriveProof(password, challenge) {
	const enc = new TextEncoder();
	const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(challenge.salt), iterations: challenge.iterations },
		base, 256);
	const key = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, hexToBytes(challenge.nonce));
	return bytesToHex(sig);
}

function fail(msg) { err.textContent = msg; err.hidden = false; btn.disabled = false; }

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	err.hidden = true;
	btn.disabled = true;
	btn.textContent = "登录中…";
	try {
		const challenge = await fetch("/auth/simple/challenge").then((r) => { if (!r.ok) throw new Error("challenge"); return r.json(); });
		const proof = await deriveProof(pass.value, challenge);
		const res = await fetch("/auth/simple/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: user.value, nonce: challenge.nonce, proof }),
		});
		if (res.ok) { location.href = "/"; return; }
		const body = await res.json().catch(() => ({}));
		fail(body.error || "登录失败");
	} catch {
		fail("登录失败 — 请重试");
	}
	btn.textContent = "登录";
});
`;

/** Render the login page. No parameters — everything it needs is fetched. */
export function simpleLoginPage(): string {
	const script = `${hexToBytes.toString()}\nconst bytesToHex = ${bytesToHex.toString()};\n${PAGE_SCRIPT}`;
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clownfish — 登录</title>
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0; min-height: 100vh; display: grid; place-items: center;
		background: #14161a; color: #e8eaed;
		font: 14px/1.5 -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
	}
	.card { width: min(320px, 90vw); padding: 28px; background: #1c1f24; border: 1px solid #2a2e35; border-radius: 12px; }
	h1 { margin: 0 0 4px; font-size: 17px; }
	p.sub { margin: 0 0 20px; color: #9aa0a6; font-size: 12px; }
	label { display: block; margin: 12px 0 4px; font-size: 12px; color: #9aa0a6; }
	input {
		width: 100%; padding: 8px 10px; background: #14161a; color: #e8eaed;
		border: 1px solid #2a2e35; border-radius: 6px; font-size: 14px; outline: none;
	}
	input:focus { border-color: #5b8def; }
	button {
		width: 100%; margin-top: 18px; padding: 9px 0; background: #2f6fed; color: #fff;
		border: 0; border-radius: 6px; font-size: 14px; cursor: pointer;
	}
	button:disabled { opacity: .6; cursor: default; }
	#err { margin-top: 12px; color: #f28b82; font-size: 12px; }
</style>
</head>
<body>
	<form class="card" id="form" autocomplete="on">
		<h1>Clownfish</h1>
		<p class="sub">请登录以继续</p>
		<label for="username">用户名</label>
		<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
		<label for="password">密码</label>
		<input id="password" name="password" type="password" autocomplete="current-password" required>
		<button id="btn" type="submit">登录</button>
		<p id="err" hidden></p>
	</form>
	<script>
${script}
	</script>
</body>
</html>`;
}
