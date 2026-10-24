/**
 * Clownfish settings — the single home for provider endpoint + credentials.
 *
 * Modeled on Claude Code's `settings.json`: secrets live in a dedicated file
 * (NOT in code, NOT committed to git) and are surfaced to pi-ai's providers via
 * their conventional environment variables at startup. Keeping the credentials
 * out of source means the repo can be shared/committed freely.
 *
 * File location: `<dataDir>/settings.json` (e.g. `~/.clownfish/settings.json`).
 * The `dataDir` sits outside the repo, so the file is never tracked regardless;
 * `.gitignore` also excludes `settings.json` / `settings.local.json` defensively.
 *
 * Precedence: a value already in the real process environment wins (set-if-
 * missing), so ad-hoc shell overrides like `ANTHROPIC_BASE_URL=… npm start`
 * still work. The file only fills in what's absent.
 *
 * Example (`settings.example.json` mirrors this):
 * ```json
 * {
 *   "provider": "anthropic",
 *   "model": "glm-5.2",
 *   "sessionsDir": "~/.clownfish/sessions",
 *   "baseUrl": "https://open.bigmodel.cn/api/anthropic",
 *   "authToken": "<token>",
 *   "env": { "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_AUTH_TOKEN": "…" }
 * }
 * ```
 *
 * The convenience `baseUrl` / `authToken` / `apiKey` fields are mapped onto the
 * provider's conventional env vars automatically; the `env` block is for power
 * users / non-anthropic providers and is applied verbatim.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ClownfishSettings {
	/** Default provider id for new projects (e.g. "anthropic"). */
	provider?: string;
	/** Default model id for new projects (e.g. "glm-5.2"). */
	model?: string;
	/** Directory for per-session transcript files (default ~/.clownfish/sessions). Overrides config. */
	sessionsDir?: string;
	/** Provider base URL / endpoint. Mapped to the provider's `*_BASE_URL` env. */
	baseUrl?: string;
	/** Bearer auth token. Mapped to the provider's auth-token env (anthropic → `ANTHROPIC_AUTH_TOKEN`). */
	authToken?: string;
	/** API key (x-api-key). Mapped to the provider's api-key env (anthropic → `ANTHROPIC_API_KEY`). */
	apiKey?: string;
	/** Raw env overrides applied verbatim (Claude Code-style). */
	env?: Record<string, string>;
}

/** Conventional env-var names per well-known provider. */
const CONVENTIONAL: Record<string, { baseUrl: string; authToken?: string; apiKey?: string }> = {
	anthropic: { baseUrl: "ANTHROPIC_BASE_URL", authToken: "ANTHROPIC_AUTH_TOKEN", apiKey: "ANTHROPIC_API_KEY" },
	openai: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY" },
	google: { baseUrl: "GOOGLE_BASE_URL", apiKey: "GOOGLE_API_KEY" },
	mistral: { baseUrl: "MISTRAL_BASE_URL", apiKey: "MISTRAL_API_KEY" },
};

function conventionalFor(provider: string): { baseUrl: string; authToken?: string; apiKey?: string } {
	return (
		CONVENTIONAL[provider] ?? {
			baseUrl: `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`,
			apiKey: `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
		}
	);
}

/** Path to the settings file inside a data directory. */
export function settingsPath(dataDir: string): string {
	return join(dataDir, "settings.json");
}

/** Load and parse the settings file. Returns `{}` if absent (settings are optional). */
export function loadSettings(dataDir: string): ClownfishSettings {
	const file = settingsPath(dataDir);
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`Failed to read settings ${file}: ${err instanceof Error ? err.message : err}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file ${file} must be a JSON object`);
	}
	return parsed as ClownfishSettings;
}

function setIfMissing(key: string, value: string | undefined): void {
	if (value !== undefined && value.length > 0 && process.env[key] === undefined) {
		process.env[key] = value;
	}
}

/**
 * Merge entries into the settings file's `env:{}` block (or create the file).
 *
 * The wizard's persistence path: a decision made interactively at boot must
 * survive the next one. Everything else in the file is preserved verbatim, and
 * an existing env value for the same key is OVERWRITTEN — this is a deliberate
 * write, not the set-if-missing read-time behavior of {@link applySettings}
 * (real env still wins at apply time).
 */
export async function saveSettingsEnv(dataDir: string, entries: Record<string, string>): Promise<void> {
	let settings: ClownfishSettings = {};
	try {
		settings = loadSettings(dataDir);
	} catch {
		// A malformed file should not brick the wizard — start over rather than
		// crash. (loadSettings throws on parse errors; reads of a missing file
		// return {}.)
		settings = {};
	}
	settings.env = { ...(settings.env ?? {}), ...entries };
	await writeFile(settingsPath(dataDir), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/**
 * Apply settings to `process.env` (set-if-missing: real env wins).
 *
 * Convenience fields are mapped onto the provider's conventional env vars;
 * then the raw `env` block is applied verbatim (so it can set anything the
 * provider reads, including non-standard vars).
 */
export function applySettings(settings: ClownfishSettings): void {
	const conv = conventionalFor(settings.provider ?? "anthropic");
	setIfMissing(conv.baseUrl, settings.baseUrl);
	if (settings.authToken && conv.authToken) setIfMissing(conv.authToken, settings.authToken);
	if (settings.apiKey && conv.apiKey) setIfMissing(conv.apiKey, settings.apiKey);
	// Convenience fields also fill their CLOWNFISH_* env knobs, so anything
	// resolving config later in the process (loadServerConfig consumers) sees
	// the same provider/model the ProjectManager defaults to.
	setIfMissing("CLOWNFISH_PROVIDER", settings.provider);
	setIfMissing("CLOWNFISH_MODEL", settings.model);
	if (settings.env) {
		// `//`-prefixed keys are the file's comment convention, not env vars.
		for (const [k, v] of Object.entries(settings.env)) {
			if (!k.startsWith("//")) setIfMissing(k, v);
		}
	}
}
