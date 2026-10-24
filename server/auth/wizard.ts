/**
 * First-run login wizard (interactive, terminal only).
 *
 * Clownfish has filesystem + paid-API access, so login is worth a minute of
 *  setup — but OAuth demands a provider console session, which is overkill
 * for "it's my machine". The wizard is the fast path, and a password is the
 * DEFAULT (just press Enter):
 *
 *   a. 简单模式 — username + password (PBKDF2 verifier → <dataDir>/auth/simple.json,
 *                CLOWNFISH_AUTH=simple → settings.json env)   [default]
 *   b. 配置 OAuth — Google / GitHub / generic OIDC: paste the client id/secret/
 *                redirect/allowlist into settings.json env
 *   c. 跳过 — keep the server open (CLOWNFISH_AUTH=off, remembered)
 *
 * It runs ONLY when: stdin+stdout are TTYs AND CLOWNFISH_AUTH is unset in both
 * the real env and settings.json's env (any explicit choice — including `off` —
 * suppresses it forever). `make dev`, e2e and CI all set the variable or lack a
 * TTY, so nothing interactive ever blocks an automated boot.
 */
import readline from "node:readline";
import { saveSettingsEnv } from "../../agent/settings";
import { applySettings } from "../../agent/settings";
import { createSimpleCredentials, saveSimpleCredentials, simpleCredentialsPath } from "./simple";

/** True when the process can ask a human (both ends visible). */
export function wizardCapable(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** True when the operator (or a deployment) has already decided — don't re-ask. */
export function authAlreadyDecided(): boolean {
	return Boolean(process.env.CLOWNFISH_AUTH);
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
	return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

/** Like ask(), but the typed text is not echoed (passwords). */
function askHidden(rl: readline.Interface, prompt: string): Promise<string> {
	return new Promise((resolve) => {
		// Interface's `output` is public at runtime but private in the shipped
		// typings — the interface was created with OUR stdout (below), so this
		// cast only reads back what was passed in.
		const stdout = (rl as unknown as { output: NodeJS.WriteStream }).output;
		const write = stdout.write.bind(stdout);
		// Show the prompt through the ORIGINAL writer, then mute the stream for
		// the whole question: readline echoes typed characters (and cursor moves)
		// through output.write, and all of it must vanish.
		write(prompt);
		stdout.write = (() => true) as typeof stdout.write;
		rl.question("", (answer) => {
			stdout.write = write;
			write("\n");
			resolve(answer);
		});
	});
}

/** Run the wizard. No-op unless interactive and undecided; never throws. */
export async function runAuthWizard(dataDir: string, opts: { force?: boolean } = {}): Promise<void> {
	if ((!opts.force && authAlreadyDecided()) || !wizardCapable()) return;
	try {
		await wizard(dataDir);
	} catch (err) {
		console.warn(`[clownfish] auth wizard failed (${err instanceof Error ? err.message : err}) — continuing without login.`);
	}
}

async function wizard(dataDir: string): Promise<void> {
	console.log("\n━━━ 登录设置 ━━━");
	console.log("Clownfish 拥有文件系统与 API 的完整权限，建议启用登录。");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const choice =
			(await ask(rl, "选择登录方式  a. 简单模式（用户名+密码）  b. 配置 OAuth（Google/GitHub/OIDC）  c. 跳过  [A/b/c，回车=a]: ")).toLowerCase() ||
			"a";

		if (choice === "a") {
			await setupSimple(rl, dataDir);
			return;
		}
		if (choice === "b") {
			await setupOAuth(rl, dataDir);
			return;
		}
		// Any other answer (c, …) keeps auth off — recorded so the
		// wizard does not nag on every boot. Re-run `npm run login` to redo it.
		await saveSettingsEnv(dataDir, { CLOWNFISH_AUTH: "off" });
		process.env.CLOWNFISH_AUTH = "off";
		console.log("已选择跳过 — 登录保持关闭（记录于 settings.json；之后可运行 `npm run login` 重新配置）。");
	} finally {
		rl.close();
	}
}

async function setupSimple(rl: readline.Interface, dataDir: string): Promise<void> {
	let username = "";
	while (!username) username = await ask(rl, "用户名: ");

	let password = "";
	let confirm = "";
	// Empty passwords are rejected; confirmation must match (retyping is the
	// only check available when the screen shows nothing).
	while (password.length < 4 || password !== confirm) {
		password = await askHidden(rl, "密码（至少 4 位，输入不回显）: ");
		if (password.length < 4) {
			console.log("密码太短 — 至少 4 位。");
			continue;
		}
		confirm = await askHidden(rl, "再输入一遍: ");
		if (password !== confirm) {
			console.log("两次输入不一致，请重来。");
			password = "";
			confirm = "";
		}
	}

	const creds = createSimpleCredentials(username, password);
	saveSimpleCredentials(dataDir, creds);
	await saveSettingsEnv(dataDir, { CLOWNFISH_AUTH: "simple" });
	// This boot is already past config loading — set the env so loadAuthConfig
	// picks simple mode up without a restart.
	process.env.CLOWNFISH_AUTH = "simple";
	console.log(`已保存（PBKDF2 验证器，密码本身不落盘）→ ${simpleCredentialsPath(dataDir)}`);
	console.log("登录已启用（CLOWNFISH_AUTH=simple）。");
}

async function setupOAuth(rl: readline.Interface, dataDir: string): Promise<void> {
	let idp = "";
	while (!["google", "github", "oidc"].includes(idp)) {
		idp = (await ask(rl, "OAuth 提供方  google / github / oidc [google]: ")).toLowerCase() || "google";
	}
	const P = idp.toUpperCase();
	console.log(
		idp === "google"
			? "需要 Google Cloud Console 的 OAuth 客户端凭据（类型：Web application）。"
			: idp === "github"
				? "需要 GitHub → Settings → Developer settings 里的 OAuth App。"
				: "需要 OIDC 提供方里注册的客户端（授权码流程）。",
	);
	const entries: Record<string, string> = { CLOWNFISH_AUTH: idp };
	if (idp === "oidc") {
		const issuer = await ask(rl, "Issuer URL（CLOWNFISH_OIDC_ISSUER，如 https://idp.example.com）: ");
		if (issuer) entries.CLOWNFISH_OIDC_ISSUER = issuer;
	}
	entries[`${P}_CLIENT_ID`] = await ask(rl, `${P}_CLIENT_ID: `);
	entries[`${P}_CLIENT_SECRET`] = await ask(rl, `${P}_CLIENT_SECRET: `);
	const dflt = `http://localhost:4317/auth/${idp}/callback`;
	entries.CLOWNFISH_AUTH_REDIRECT = (await ask(rl, `回调地址 CLOWNFISH_AUTH_REDIRECT (回车 = ${dflt}): `)) || dflt;
	const emails = await ask(rl, "允许登录的邮箱（逗号分隔，CLOWNFISH_AUTH_ALLOWED_EMAILS，可留空）: ");
	const domains = await ask(rl, "允许登录的邮箱域名（逗号分隔，CLOWNFISH_AUTH_ALLOWED_DOMAINS，可留空）: ");
	if (emails) entries.CLOWNFISH_AUTH_ALLOWED_EMAILS = emails;
	if (domains) entries.CLOWNFISH_AUTH_ALLOWED_DOMAINS = domains;
	if (!emails && !domains) console.log("提示：邮箱和域名白名单都为空 — 没有人能登录，请之后在 settings.json 补上。");
	await saveSettingsEnv(dataDir, entries);
	// Fill process.env for THIS boot (set-if-missing — real env still wins).
	applySettings({ env: entries });
	console.log(`已写入 settings.json（CLOWNFISH_AUTH=${idp}）。`);
}
