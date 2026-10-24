/**
 * Env handed to an external CLI process (Codex / Claude Code / any command) run
 * under a pty for a CLI-backed session: an ALLOWLIST, never the worker's full
 * process.env — that carries provider credentials (ANTHROPIC_AUTH_TOKEN /
 * *_API_KEY / tokens read from settings.json), which a third-party binary must
 * not inherit. The session's own `env` entries (the one knob the UI exposes —
 * e.g. HTTPS_PROXY) are layered on top and win. Same shape as agent/mcp.ts's
 * MCP_ENV_ALLOWLIST/mcpChildEnv, plus SSH_AUTH_SOCK/COLORTERM since this is a
 * real interactive terminal rather than a headless stdio server.
 *
 * CLAUDE_CONFIG_DIR / CODEX_HOME pass too: they are the CLI's OWN config
 * location (a path, not a credential), and dropping them made the child write
 * its session log under ~/.claude while the runner tailed $CLAUDE_CONFIG_DIR.
 */
const CLI_ENV_ALLOWLIST = /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TERM|SHELL|USER|LOGNAME|XDG_[A-Z_]+|NODE_[A-Z_]+|SSH_AUTH_SOCK|COLORTERM|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;

export function cliChildEnv(cfgEnv?: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string" && CLI_ENV_ALLOWLIST.test(k)) out[k] = v;
	}
	return { ...out, ...(cfgEnv ?? {}) };
}
