/**
 * `npm run login:openai` — sign in with ChatGPT (Plus/Pro) so a project can
 * use `provider: "openai-codex"` and draw on the account's subscription
 * usage instead of metered API billing.
 *
 * This drives pi-ai's own, already-shipped OAuth flow
 * (`@earendil-works/pi-ai`'s `auth/oauth/openai-codex.ts` — the same
 * `client_id` OpenAI's own Codex CLI uses) through the SAME file-backed
 * credential store the real server reads from (`agent/oauth-credential-store.ts`,
 * `<dataDir>/auth/oauth-credentials.json`) — see `agent/models.ts`'s
 * `resolveRuntime` doc comment for why no other wiring is needed at request
 * time. Nothing here talks to OpenAI directly; this script only supplies the
 * terminal prompts/notifications the library's flow asks for.
 */
import { createInterface } from "node:readline/promises";
import { exec } from "node:child_process";
import { loadServerConfig } from "../server/config";
import { loadSettings, applySettings } from "../agent/settings";
import { initModels, getModels } from "../agent/models";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

const config = loadServerConfig();
applySettings(loadSettings(config.dataDir));
initModels(config.dataDir);
const models = getModels();

const rl = createInterface({ input: process.stdin, output: process.stdout });

/** Best-effort: the browser opening is a convenience, not the login mechanism —
 *  the printed URL always works if this fails (headless box, unknown platform). */
function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	exec(`${cmd} ${JSON.stringify(url)}`, () => undefined);
}

function notify(event: AuthEvent): void {
	switch (event.type) {
		case "info":
			console.log(event.message);
			break;
		case "auth_url":
			console.log(`\n打开浏览器完成登录（若没有自动打开，请手动访问）：\n  ${event.url}\n`);
			if (event.instructions) console.log(event.instructions);
			openBrowser(event.url);
			break;
		case "device_code":
			console.log(`\n前往 ${event.verificationUri} 并输入验证码: ${event.userCode}\n`);
			break;
		case "progress":
			console.log(event.message);
			break;
	}
}

async function prompt(p: AuthPrompt): Promise<string> {
	if (p.type === "select") {
		console.log(p.message);
		p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`));
		const answer = await rl.question("> ", { signal: p.signal });
		const idx = Number(answer.trim()) - 1;
		return p.options[idx]?.id ?? p.options[0].id;
	}
	// text / secret / manual_code: a plain line. `manual_code` races the local
	// OAuth callback server — its OWN signal (not the whole login's) aborts
	// this wait the moment the browser callback wins first.
	return await rl.question(`${p.message}${p.placeholder ? ` [${p.placeholder}]` : ""}\n> `, { signal: p.signal });
}

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

try {
	console.log("登录 OpenAI (ChatGPT Plus/Pro) …\n");
	await models.login("openai-codex", "oauth", { signal: controller.signal, notify, prompt });
	console.log(
		"\n✅ 已登录。凭据已保存在 <dataDir>/auth/oauth-credentials.json（不落进项目配置，也不出现在任何日志里）。\n" +
			'项目设置里把 provider 设为 "openai-codex"、model 设为对应的 gpt-5.x 型号（如 "gpt-5.4"）即可使用 —— 不需要再配 apiKeyEnv。',
	);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`\n❌ 登录未完成：${message}`);
	process.exitCode = 1;
} finally {
	rl.close();
}
