<img src="assets/logo-256.png" alt="Clownfish" width="128" height="128" align="right" />

# Clownfish

A self-built AI agent built on **only the basic loop** of
[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) —
`ClownfishAgent extends Agent`. Everything else is implemented from scratch:

- **Tool mechanism** — `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`
  (adapted from pi's coding-agent tools, stripped of TUI/macOS coupling).
- **Skills mechanism** — filesystem `SKILL.md` skills with YAML frontmatter,
  surfaced via a model-driven `skill` tool.
- **Sub-agents** — built-in specialists (orchestrator, design, coding, QA) that
  the main agent delegates to with the `run_agent` tool.
- **MCP** — external stdio / streamable-HTTP tool servers, merged from
  `~/.clownfish/mcp.json` and a project's `.mcp.json`.
- **Sessions** — one append-only JSONL transcript per session, written by the
  session's own agent worker. No pi harness dependency.

The UI is a **Preact + TypeScript** single-page app talking to a **Node.js +
Express** backend over HTTP (`/api`, project/session management) and a
WebSocket (`/chat`, real-time streaming). Each session's agent runs in its own
worker process, so long-running work survives a closed tab.

## Layout

```
clownfish/
├── agent/    # reusable agent runtime — loop, tools, skills, sub-agents, MCP,
│             #   plugins, slash commands, worker, manager, UDS transport
│             #   (entry barrel: agent/index.ts)
├── server/   # Express REST + /chat WS + auth, MVC:
│             #   models/ controllers/ views/ (Preact SPA) auth/ protocol.ts
└── scripts/  # e2e.mjs — boots a real server and exercises it end to end
```

`server` imports `agent` via `../agent`; `agent` has no runtime dependency on
`server`.

## Getting started

```bash
make install     # npm install (single package, no workspaces)
make dev         # API/agent server + Vite web UI, hot reload, Ctrl-C to stop
```

- **API/agent server** → `http://localhost:4317` (REST `/api`, WebSocket `/chat`)
- **Web UI** → `http://localhost:5173` (Vite proxies `/api` + `/chat` to 4317)

Other targets: `make typecheck`, `make e2e`, `make build`, `make help`.

## Configuration

Provider endpoint and credentials come from the environment **or**
`<dataDir>/settings.json` (default `~/.clownfish/settings.json`). Real env vars
always win; the file only fills gaps. Copy `settings.example.json` to get
started — it is gitignored, so secrets never land in the repo.

```bash
export CLOWNFISH_MODEL=claude-sonnet-4-6
export ANTHROPIC_API_KEY=<your-key>
```

Per-project config (provider, model, skills dirs, base system prompt) lives in
the project registry under `~/.clownfish/` and is edited from the WebUI.

Skills, agents, slash commands and MCP servers can come from Claude-Code-shaped
plugin bundles (`<plugin>/{skills,agents,commands}/`, `.mcp.json`), discovered
under `~/.clownfish/plugins`, `~/.claude/plugins` and the project's own
`.clownfish/plugins` / `.claude/plugins`. The settings page (⚙) lists every agent
and edits its prompt copy-on-write into `~/.clownfish/agent_overwrite/`, leaving
the original file untouched; Reset deletes the override.

HTTPS (`CLOWNFISH_TLS=1`) is optional and off by default. See
[CLAUDE.md](CLAUDE.md) for the full setup.

## Login

Clownfish can run shell commands and spend your API quota, so put a login in
front of it. **The quickest way is a password:** the first time you start the
server from a terminal it asks (press Enter for the default, 简单模式 —
username + password). Run `npm run login` any time to set or reset it. Local
`make dev` always runs open.

If you skip it, the server still starts, but warns that it is open to anyone who
can reach the port (it only listens on `127.0.0.1` unless you set
`CLOWNFISH_BIND`). Login is chosen with `CLOWNFISH_AUTH`
(env or `settings.json`'s `env:{}`):

| `CLOWNFISH_AUTH` | Sign-in |
|---|---|
| unset / `off` | none (open) |
| `simple` | username + password; the password never leaves the browser (PBKDF2 + HMAC challenge) |
| `google` / `github` / `oidc` | OAuth2 (authorization code + PKCE), allowlist required |

A mode that is switched on but not fully configured **refuses to start** rather
than running open — set `CLOWNFISH_AUTH=off` to run without login.

### Google

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   create an **OAuth client ID** of type *Web application* and add
   `https://your-host/auth/google/callback` (for local use,
   `http://localhost:4317/auth/google/callback`) as an authorized redirect URI.
2. Configure the server:

```bash
export CLOWNFISH_AUTH=google
export GOOGLE_CLIENT_ID=<client-id>
export GOOGLE_CLIENT_SECRET=<client-secret>
export CLOWNFISH_AUTH_REDIRECT=https://your-host/auth/google/callback   # exactly as registered
export CLOWNFISH_AUTH_ALLOWED_EMAILS=you@example.com,teammate@example.com
export CLOWNFISH_AUTH_ALLOWED_DOMAINS=example.com                      # optional: a whole domain
```

Only addresses Google reports as **verified** can sign in, and only if the email
is listed in `CLOWNFISH_AUTH_ALLOWED_EMAILS` or its domain (exact match, no
subdomains) in `CLOWNFISH_AUTH_ALLOWED_DOMAINS`. With both empty, nobody can.
The wizard (`npm run login`, option b) writes the same keys to `settings.json`.

### GitHub and other OpenID providers

- **GitHub** — `CLOWNFISH_AUTH=github`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`;
  register the callback `https://your-host/auth/github/callback` on the OAuth App.
  The primary *verified* email is what the allowlist sees.
- **Any OIDC provider** — `CLOWNFISH_AUTH=oidc`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, and `CLOWNFISH_OIDC_ISSUER=https://idp.example.com`
  (endpoints are discovered from `/.well-known/openid-configuration`), or set
  `CLOWNFISH_OIDC_AUTH_URL` / `_TOKEN_URL` / `_USERINFO_URL` yourself.
  Callback: `https://your-host/auth/oidc/callback`.

Any provider also accepts the generic `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`.
Sessions are signed with `SESSION_SECRET`, or an auto-generated key cached in
`<dataDir>/auth/session.key`.

## License

MIT
