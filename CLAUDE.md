# CLAUDE.md

Guidance for Claude Code (and contributors) working in this repo.

## Quick start

```bash
make install     # npm install (single package, no workspaces)
make dev         # API/agent server + Vite web UI, hot reload, Ctrl-C to stop
```

- **API/agent server** → `http://localhost:4317`  (REST `/api`, WebSocket `/chat`)
- **Web UI**       → `http://localhost:5173`  (Vite proxies `/api` + `/chat` to 4317)

Per-process variants when you want split logs: `make dev-server`, `make dev-web`.

**Prod (`make start`) forks prebuilt workers**: `npm start` bundles
`agent/worker.ts` to `dist/worker.mjs` (esbuild) and sets
`CLOWNFISH_WORKER_MODULE` — plain-node forks skip the ~1.2s tsx/esbuild
bootstrap on every spawn. Measured (`npx tsx scripts/bench-spawn.ts`):
649ms spawn→ready vs 2325ms from source, RSS 104MB vs 136MB, 6-parallel
burst 1.6s vs 6.6s. Dev keeps the tsx source entry (always fresh, no build
step). When pointing `CLOWNFISH_WORKER_MODULE` at the bundle yourself,
rebuild after code changes (`make build-worker`).

## Common tasks

| Command          | What it does                                              |
|------------------|----------------------------------------------------------|
| `make dev`       | server (`tsx watch`) + web (`vite`) together             |
| `make typecheck` | `tsc --noEmit` across `agent/` + `server/`                |
| `make build`     | production-build web UI (Vite → `dist/`)                   |
| `make build-worker` | prebuild the agent worker bundle (`dist/worker.mjs`)   |
| `make clean`     | remove `web/dist`, `server/dist`                         |
| `make help`      | list targets                                             |

## Provider configuration (credentials never live in code)

The server reads provider endpoint + credentials from **either** the environment
**or** `<dataDir>/settings.json` (default `~/.clownfish/settings.json`). Real env
vars always win (set-if-missing); the file only fills gaps. `settings.json` is
gitignored — see `settings.example.json` for the shape.

For the **BigModel Anthropic-compatible proxy** (glm-5.2):

```bash
export CLOWNFISH_MODEL=glm-5.2                 # model id sent to the provider
export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
export ANTHROPIC_AUTH_TOKEN=<your-token>       # never commit this
```

`agent/models.ts` (`resolveRuntime`) bridges `ANTHROPIC_BASE_URL` onto
`model.baseUrl` — pi-ai otherwise ignores the `*_BASE_URL` env and would hit the
real Anthropic endpoint (→ 403 with a proxy token). For real Anthropic, just set
`ANTHROPIC_API_KEY` (and leave the model at the default `claude-sonnet-4-6`).

For **OpenAI**: `provider: "openai"` + `OPENAI_API_KEY` is a plain api-key
provider, works today with no changes. `provider: "openai-codex"` uses the
ChatGPT Plus/Pro subscription's included usage instead — `npm run login:openai`
once, no `apiKeyEnv` needed after; see "OpenAI login" below. Either one behind
a network that needs an HTTP(S) proxy: `HTTPS_PROXY`/`https_proxy` (or the
clownfish-specific `OPENAI_HTTPS_PROXY`) is honored for both.

## OpenAI login (ChatGPT Plus/Pro) + HTTPS proxy

`provider: "openai-codex"` signs in with a ChatGPT account instead of an API
key, drawing on the account's Plus/Pro subscription usage rather than metered
billing — the same mechanism OpenAI's own Codex CLI uses (same OAuth
`client_id`; this isn't a reverse-engineered flow, `@earendil-works/pi-ai`
already ships it as a first-party provider, `auth/oauth/openai-codex.ts`).
`npm run login:openai` (`scripts/login-openai-codex.ts`) drives that flow's
browser/PKCE login interactively (device-code login is also offered, for a
headless box) and needs nothing else from clownfish — it just supplies the
terminal prompts pi-ai's login asks for.

The one piece clownfish adds is making the credential DURABLE:
`agent/oauth-credential-store.ts` is a file-backed `CredentialStore`
(`<dataDir>/auth/oauth-credentials.json`, 0600, one JSON object keyed by
provider id, atomic tmp+rename writes) — without it, pi-ai's own `Models`
falls back to an in-memory store and a login is forgotten the moment the
process exits. `agent/models.ts`'s `initModels(dataDir)` wires it into the
process-wide `Models` singleton once, called from `AgentRuntime`'s
constructor (which already has `dataDir`).

**No other code exists for this on purpose**: `resolveRuntime` needs zero
special-casing for `openai-codex` — `getApiKey` is simply left unset (same as
any ambient-env provider), and pi-ai's own `Models.streamSimple` already
resolves auth for ANY provider (api-key or oauth) through its credential
store before every request, falling back to it whenever no explicit key
wins. The durable file store is the entire integration surface.

Once logged in, a project just sets `config.provider = "openai-codex"` and
`config.model` to a real catalog id (`gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, …) — no `apiKeyEnv`.

**HTTPS proxy**: Node's global `fetch` (undici) does not honor
`HTTPS_PROXY`/`https_proxy` on its own, and pi-ai's providers call it
directly with no per-request dispatcher clownfish can hook — a call chain it
does not control. Routes ONLY requests to OpenAI's own hosts
(`api.openai.com`, `chatgpt.com`) through the proxy, by wrapping
`globalThis.fetch` and attaching the proxy's dispatcher as a PER-CALL option
only when the target host matches; every other request (a different
provider, the bash tool's own `curl`, `WebFetch`, MCP servers) passes
straight through untouched. **The first version of this used undici's
`setGlobalDispatcher`** — process-wide — which would have routed the WHOLE
process's traffic through the proxy the moment this session's provider was
openai/openai-codex, caught before it shipped. Triggered by
`OPENAI_HTTPS_PROXY` (clownfish's own override) or the standard
`HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` (same convention
curl/git use). `undici` is pinned to the EXACT version Node bundles
internally (`process.versions.undici`) — the per-call `dispatcher` option is
handed straight to Node's own global `fetch`, and a version mismatch between
the npm package and Node's internal undici throws the moment a request
actually tries to use it (`invalid onRequestStart method` — measured,
`setGlobalDispatcher` tolerated the mismatch, a per-call `dispatcher` did
not); keep the pin in sync if Node's bundled version changes.

Tested offline (`scripts/openai-codex-check.mts`, 22 checks, in `make e2e`):
the credential store's full read/modify/delete/list round-trip, atomicity,
0600 permissions, survival across a fresh store instance at the same
dataDir (a worker restart), the one load-bearing integration claim — a
credential written to the file resolves through pi-ai's OWN
`Models.getAuth()` as the request's `apiKey`, with no custom code — and the
proxy wrapper's host scoping proven with REAL fetch traffic (a local test
server on an unrelated host stays reachable directly while a request to
`api.openai.com` is the one redirected to the configured — deliberately
dead — proxy), not just an object-identity check, plus its idempotency and
env-var precedence. The actual OAuth browser exchange itself is untestable
offline by nature
(needs a real account) and isn't; that boundary is exactly where this
stops and pi-ai's own, already-shipped implementation takes over.

## Plugins (Claude-Code-compatible bundles)

A plugin is a directory carrying any of the bundle assets below; one discovery
pass (`agent/plugins.ts`) feeds skills, agents, commands and MCP, so wiring a new
asset kind means reading one more field rather than writing another scanner.

```
<plugin>/.claude-plugin/plugin.json   manifest (Claude Code's location)
        /.clownfish-plugin/plugin.json | plugin.json   also accepted
        /skills/        SKILL.md skills          → loaded
        /agents/        *.md agent prompts       → loaded
        /commands/      *.md slash commands      → loaded
        /.mcp.json | mcp.json   MCP servers      → merged + connected
        /hooks/hooks.json | hooks.json           → recognized, not executed
```

Search roots (low→high precedence): `<dataDir>/plugins/*` →
`~/.claude/plugins/**` (Claude Code's install root, so plugins installed there
work unchanged) → `<project>/.clownfish/plugins/*` → `<project>/.claude/plugins/*`.
A directory that is not itself a plugin is descended into up to 3 levels, which
resolves Claude Code's `plugins/repos/<marketplace>/<plugin>` layout. The
manifest's `name` wins over the directory name.

**Slash commands** (`agent/commands.ts`) are user-invoked prompt templates:
`<dataDir>/commands` → `~/.claude/commands` → `<plugin>/commands` →
`<project>/.clownfish/commands` → `<project>/.claude/commands`. Nested dirs
namespace with `:` (`git/commit.md` → `/git:commit`). Frontmatter `description`
and `argument-hint` are used; other Claude-Code keys are accepted and ignored.
`$ARGUMENTS` and `$1`…`$9` are substituted; a template using neither gets the
arguments appended under a `# Task` heading. Unlike skills, commands never enter
the system prompt — they cost nothing until typed. A skill shadows a command of
the same name (both in the `/` menu and in the worker).

REST: `GET /api/projects/:id/plugins`, `GET /api/projects/:id/commands`.

## MCP (external tool sources)

Merge order (project wins on a name clash): `~/.clownfish/mcp.json` (global) →
each plugin's `.mcp.json` → `<project>/.mcp.json`. Claude-Code-compatible shape:

`<project>/.mcp.json`. The **project file is ignored by default** — it spawns the
commands it declares on worker boot, so trusting it requires an explicit opt-in
(`CLOWNFISH_MCP_PROJECT=1`, env or `settings.json`'s `env:{}`); without it the
worker logs a skip note. stdio children get an allowlisted env (PATH/HOME/TMPDIR/
locale/term/XDG/NODE_* + the entry's own `env:{}`) — they never inherit the
worker's provider tokens. Claude-Code-compatible shape:

```json
{ "mcpServers": {
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },
    "remote": { "url": "https://mcp.example.com/mcp" } } }
```

Each session's worker connects at boot (stdio / streamable-HTTP), lists tools, and
wraps them as `mcp__<server>__<tool>` with mode `W` (plan 排除 / ask 需审批).
Failing servers are logged and skipped. Key source: `agent/mcp.ts`.

**Agent spawn mode** (`CLOWNFISH_AGENT_SPAWN_MODE`, default `process`):
`share` = agents run as in-process `AgentRuntime`s on loopback sockets (no process
per session, but no crash isolation); `process` = one forked worker per session
(current default); `sandbox` = E2B-style container isolation (not yet implemented —
spawning fails with a clear error until a provider is wired). Key source:
`agent/runtime.ts` (transport-agnostic agent logic), `agent/worker.ts` (process
entry), `agent/agent-socket.ts` (socket abstraction + loopback), `agent/manager.ts`
(`spawnShared`).

Config knobs (`server/config.ts`, all optional): `CLOWNFISH_DATA_DIR`,
`CLOWNFISH_SESSIONS_DIR`, `CLOWNFISH_PORT`, `CLOWNFISH_AGENT_SOCKET`,
`CLOWNFISH_AGENT_IDLE_TTL` (ms, `0` = never reap), `CLOWNFISH_PROVIDER` /
`CLOWNFISH_MODEL` (defaults for new projects), `CLOWNFISH_SUBAGENT_MAX_STEPS` /
`CLOWNFISH_SUBAGENT_TIMEOUT_MS` (per-delegation budgets).

## Agent prompts + the settings page

Built-in agent prompts are markdown with YAML frontmatter in
`agent/agents/builtin/`: `system` (orchestrator), `arch` (design, `access: R`),
`coding` (implementation), `qa` (verification), and the internal ones
(`assistant`, `sys-compact`, `sys-reflect`). They
resolve low→high: built-in → global (`<dataDir>/agents`) → plugin → project
(`<project>/.clownfish/agents`) → **override**.

The web UI's **settings page** (`#/settings`, the 设置 row at the bottom of the
sidebar — `#/admin` is an alias, the two pages were merged) renders inside the
workspace beside the sidebar, nine singular tabs — one tab per THING managed:
**项目** (per-project config such as the context window), **Agent** (the prompt
editor, below), **Skill** / **Plugin** (per-kind inventory: enable/disable,
create, edit, delete, version history — `AssetsPanel` in
`server/views/pages/admin.tsx` holds one state and slices it per kind), **Tool** (the same tools from two
angles FUSED into one master-detail view — the list row carries the enable
checkbox, selecting it edits the model-facing prompt text beside it), **MCP**
(server enable toggles — a disabled server is never connected — plus the global
`mcp.json` editor), **Memory**, **Keymap** (rebindable shortcuts). **Other Agent**
(`#/settings/other-agents`, `CliAgentsPanel`) is the external CLI agents — the
form editor over `<dataDir>/cli-agents.json`, prefilled with the recommended
claude example; see "External CLI sub-agents". Every asset
tab's 范围 picker has **全局** first: no project selected, discovery runs against
`dataDir` (builtin + global assets only) — the same inventory REST surface
mounted bare at `/api/inventory`. The editors are **copy-on-write**: saving an
agent prompt writes the whole `.md` file (frontmatter included — `access` /
`internal` live there) to `<dataDir>/agent_overwrite/<name>.md`, the
highest-precedence root; a tool prompt goes to `<dataDir>/tool_overwrite/<name>.md`.
The source file is never touched, and *Reset* deletes the shadow copy to
restore it. Key source: `agent/agents/overrides.ts`,
`server/controllers/agent-prompts.ts`, `server/controllers/inventory.ts`,
`server/views/pages/settings.tsx`.

**The Agent prompt editor** (`AgentPromptsPanel`, `server/views/pages/agent-prompts.tsx`)
lists EVERY agent, built-ins included (the prompts people most want to tune
ship with the package), grouped delegatable / internal, each tagged with its
role, source, 已修改 and an enable checkbox (the inventory registry; not on
`system` or internal agents). The editor has two modes over one `.md` text: 表单
(frontmatter `description` / `access` / `model` as fields, unknown keys kept
verbatim, plus the body) and 源文件 (the whole file — forced when the
frontmatter is richer than flat `key: value`). Also: `{cwd}` `{project}`
`{sessionId}` `{date}` `{os}` placeholder chips, a token estimate, diffs (vs
the default, vs saved, vs a backup — unchanged runs folded), ⌘/Ctrl+S, an
unsaved-changes guard, and + 新建 for a brand-new agent (an override with no
base; its reset is 删除).

Every save is **versioned** (`writeVersioned`, the inventory's vim-style
`<file>.YYYYMMDD-HHmmss` backups, newest 5) — backups outlive a reset, so a
reset is recoverable — and **hot-reloads** live workers (`reloadAssets`), so a
running session uses the new prompt from its next turn. A save whose
frontmatter is not valid YAML is **refused (400)**: the loader's parser is
total, so a broken block drops EVERY key silently — `assistant.md` itself
shipped `description: …butler: operates…` (unquoted `: `), lost
`internal: true`, and was delegatable through `run_agent` until this check
found it. The form editor quotes values that need it.

REST: `GET|PUT|DELETE /api/agent-prompts/:name`, `GET .../:name/versions`,
`GET .../:name/versions/:version`, `POST .../:name/rollback {version}`
(`/api/agents` is a different thing — running worker *processes*).

## Sub-agent delegation (`run_agent`) — one entry, three shapes

`run_agent` is THE delegation entry. It used to be one of three
(`run_agent` / `workflow` / `run_goal`), which was not three capabilities but
one operation split across three control structures — and the guidelines that
told the model when to pick which contradicted each other (`docs/TOOLS.md`,
C2/C3). They are now parameters of one tool:

- `{type, task}` — one specialist, its final message comes back;
- `tasks: [{type, task, context?, cwd?}]` (+ `synthesize`) — 2+ INDEPENDENT
  strands in PARALLEL, results labelled and in order, optionally combined by a
  final pass. Strands that can WRITE are refused a shared tree (give each a
  worktree via `cwd`) instead of racing in one;
- `until: <criteria>` (+ `max_rounds`, default 3 / max 10) — the criteria
  become the verifier's ENTIRE yardstick and the existing
  implement → verify → roll back → retry cycle runs until PASS, with a stall
  guard (an unchanged verdict twice = the retry achieved nothing).
- `model` (per single delegation, or per strand in `tasks[]`) — a different
  model for THAT unit of work, same provider as the session; a persona can
  also pin one via `AgentDefinition` frontmatter `model:` (call param wins).
  Verification/retries for a strand stay on its own model. Needs
  `baseProviderConfig` wired (every session gets it from `projectConfig`) —
  without it an override is refused cleanly, never silently ignored. Details
  and the offline test coverage: `docs/TOOLS.md`.

`until` cost almost no new code, which is the tell that the original split was
wrong: run_agent ALREADY contained a one-round goal loop (see the verification
bullets below). The merge also made the guardrails uniform — budgets, the `qa`
pass, rollback, abort propagation and the plan ledger used to cover only the
single-delegation path and now cover every strand and round.

The two absorbed tools keep their code behind flags, for the parts `tasks` /
`until` genuinely do not cover: `CLOWNFISH_WORKFLOW_SCRIPT=1` (the script
engine's `pipeline`/`llm()` expressiveness) and `CLOWNFISH_GOAL_TOOL=1` (the
only loop that survives a worker restart — `goals.json` + boot resume).

Progress is one structured snapshot per call — a row per sub-agent (strand,
verify, retry), reusing the wire shape the workflow engine already emitted, so
the chat card renders fan-out strands and `until` rounds with a drill link
each (`WorkflowProgressWire` in `server/protocol.ts`).

The mechanics below describe one strand, and apply to every strand:

The top-level agent delegates with `run_agent({type, task, context})`
(`agent/agents/run-agent-tool.ts`): a fresh in-process `ClownfishAgent` with an
empty conversation, the same workspace/runtime/skills/MCP tools, the delegate's
`access` policy, and the parent's `beforeToolCall` hook (so ask-mode approval and
checkpoints still apply to what the child does — the gate resolves a tool's mode
from a name→mode table covering the sub-agent toolset too, and treats an unknown
tool as write-capable rather than waving it through). It does **not** get `run_agent`,
so delegation cannot recurse, and `internal` agents are not delegatable.

What keeps it from being a black box:

- **Reasoning effort per delegation** — `run_agent`'s `thinking` parameter raises
  the model's effort for one sub-task (the session default comes from
  `CLOWNFISH_THINKING` / project config `thinking`, normally `off`). Measured: on
  a task where the agent normally skips building a probe, `medium` produced the
  intended behaviour — it wrote its own probe, ran it before and after, and
  delegated to `qa` — at ~7x the tokens and time. Worth raising where the first
  plausible answer is often wrong; not worth it for mechanical work.
- **A verification pass the framework runs, not the model** — across 33 measured
  runs the orchestrator delegated to `qa` exactly zero times, because the same
  prompt that asks for verification also says delegation is expensive, and the
  cost rule won. So after a delegation that MUTATED the workspace, `run_agent`
  now runs `qa` itself against the original task and the implementer's report,
  and reads a `VERDICT: PASS|FAIL` line from it. `CLOWNFISH_VERIFY` =
  `off` | `auto` (default: only when something changed) | `always`.
- **The same pass for work the orchestrator does ITSELF** — the verification
  above was only ever wired into the delegation path, and the orchestrator
  handles most work directly: on the phase-4 benchmark it solved all three tasks
  alone in 12–14 tool calls and delegated zero times, so nothing checked any of
  it and a third defect in one task shipped undetected. Same root cause as the
  bullet above, one level further up. `CLOWNFISH_VERIFY_TURN` = `off` (default)
  | `auto` (the turn mutated the workspace and did not delegate — a delegation is
  already verified) | `always`; a FAIL verdict is handed back to the agent as an
  ordinary turn, bounded by `CLOWNFISH_VERIFY_TURN_RETRIES` (default 1).
  The turn's `agent_end` is HELD until the verdict lands — verification is part
  of the turn, and announcing the turn finished first let the bench runner tear
  the session down after the verifier's first tool call, leaving no verdict at
  all (round 7, before the fix).
  **Measured, and it did not pay:** phase4 with it on (round 8) scored the same
  13/14 as with it off (round 6) while costing 2.3x the tokens and 2.1x the wall
  time — and the verifier returned PASS on the very task that still had an
  undetected defect. So it stays OFF by default. It is kept because the negative
  result is specific to short, self-contained tasks where the agent already runs
  its own tests; it is not evidence about long sessions.
- **Rollback and retry on a FAIL verdict** — the workspace is restored to its
  state before the attempt and the delegation is re-run once with the verifier's
  findings (`CLOWNFISH_VERIFY_RETRIES`, default 1). A rollback restores the WHOLE
  tree, so it is skipped — with a warning saying why — when it cannot be exact, or
  when another delegation is working in the same directory. It is announced to the
  operator through a `notice` frame (not `error`, which also rejects pending acks),
  because losing concurrent work in that tree is a real consequence.
  `CLOWNFISH_VERIFY_ROLLBACK=0` disables it.

- **Progress** — the child's tool calls stream back through the tool's `onUpdate`
  channel → `tool_execution_update` → the `tool_update` wire frame → a live line
  on the run_agent card (`coding · 7 step(s) · bash: make typecheck`).
- **Abort** — the parent's signal is forwarded, so stopping a turn stops the work
  it spawned; the partial output is returned rather than discarded.
- **Budgets** — `CLOWNFISH_SUBAGENT_MAX_STEPS` (default 80 tool calls) and
  `CLOWNFISH_SUBAGENT_TIMEOUT_MS` (default 15 min). A child has no compaction of
  its own, so without these a runaway one grinds until the context window fails.
  On exhaustion the result says plainly that the task is **not** done, so the
  parent re-scopes instead of assuming success.
- **Transcripts** — each delegation appends its whole conversation to
  `<sessionsDir>/<sessionId>.sub<n>-<type>.jsonl` (same envelope as a session,
  flushed per turn). The parent's transcript keeps only the final answer, so this
  is the only record of what a specialist actually did. The same id is the
  provider cache key, so two `coding` delegations never collide.
- **The plan** — each delegation records itself in the session plan (`todo` param
  adopts an existing step, otherwise one is appended), so who ran where, and how
  it ended, is visible without reading the chat.
- **`cwd`** — an optional per-delegation working directory (a git worktree), so
  parallel implementation strands don't edit one tree. Keep worktrees inside the
  project (`.worktrees/<strand>`, gitignored): turn checkpoints skip files outside
  the workspace root. The orchestrator prompt owns the fan-out/merge policy.

The tool result is the child's last assistant message — nothing else of its
conversation reaches the parent.

## External CLI sub-agents (`codex` / `claude-code` / any command via `run_agent`)

A delegation's `type` can also name an **external agent CLI** — the point is
that a user in the main agent's chat can just say "用 codex 跑这个" and the
orchestrator delegates to that CLI. Still ONE entry (`run_agent`); a CLI agent
is just an `AgentDefinition` whose `cli` field carries the launch spec, loaded
from `<dataDir>/cli-agents.json` (settings → Other Agent, form
edited; REST `GET|PUT|DELETE /api/cli-agents`, every write hot-reloads live
workers). Off by default: `CLOWNFISH_CLI_SUBAGENTS=1` (separate from
`CLOWNFISH_CLI_SESSIONS` — model-initiated spawns are a bigger blast radius
than operator-driven terminal sessions). Key sources:
`agent/agents/cli-config.ts` (store + shipped recommended configs),
`agent/agents/cli-sub.ts` (runner), `agent/agents/cli-log-tail.ts` (log
discovery + adapters).

One entry = the COMPLETE process launch (command + whole argv, nothing secretly
prepended; the shipped defaults ARE the recommended example the settings form
shows). Runtime values arrive through argv placeholders: `{session-id}` (a
generated UUID — makes claude's session-log path deterministic),
`{workdir}`, `{result-file}` (a temp file for codex's
`--output-last-message`), `{permission-mode}` (claude's `--permission-mode`,
from `CLOWNFISH_CLI_SUBAGENT_PERMISSIONS`, default `bypassPermissions` —
headless `-p` cannot answer prompts), `{model}` (dropped TOGETHER with the argv
slot before it when no model is in play, so `--model {model}` vanishes
cleanly). The task itself always goes to the child's STDIN, never argv.

The contract is the SAME `SubRun` as an in-process sub (`runSub` branches to
`runCliSub` early), so budgets (`SUBAGENT_TIMEOUT_MS` / `SUBAGENT_MAX_STEPS`,
steps counted from the tailed tool events), abort propagation, the todo
ledger, qa verification, rollback and the drill-in card all work unchanged —
**zero wire/protocol changes**. The child spawns detached (its own POSIX
process group, so SIGTERM→5s→SIGKILL kills the CLI's own children too), with
the `cliChildEnv()` allowlist env (never provider credentials) and the
delegation's jailed cwd.

Progress and the drill-in view come from **tailing the CLI's own structured
session JSONL** — not stdout/VT100 parsing: claude
`$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl` (the UUID is ours, so
the path is deterministic — two MEASURED details: claude slugs the RESOLVED
cwd, so a macOS `/var/folders` workdir lands under `-private-var-…` with the
leading dash kept, and with `--verbose` its stdout is an ARRAY of events whose
LAST element carries the result), codex discovered as a NEW `rollout-*.jsonl`
under `~/.codex/sessions/YYYY/MM/DD/` whose first-line `session_meta.payload.cwd`
matches the workdir (pre-spawn dir snapshot disambiguates concurrent runs).
Each line is adapted into ordinary agent events under the delegation's bus id
(`sub<n>-<type>`) and MIRRORED into the standard
`<sessionsDir>/<sessionId>/<subId>.jsonl` transcript — the drill-in, REST
pagination and late joins are free, and the CLI later deleting its log changes
nothing. claude's own sub-agent lines (`isSidechain`) are filtered out. The
final answer comes from the machine-readable result channel (claude stdout
JSON `.result`; codex `--output-last-message`; `log:"none"` → stdout
verbatim), with the tailed log's last assistant message as fallback —
`error_max_turns` maps to an exhaustion report.

Stated rather than hidden: `beforeToolCall` cannot gate an external process —
a CLI delegation is ALWAYS treated as a writer (`mutated: true`, so qa verify +
rollback apply), the gate is the `run_agent` call itself (tool mode "W"), and
`access: "R"` on a CLI def is advisory at best. Interactive mid-run questions
(PTY + a drill-down input box) are deliberately NOT this pass — headless only.
Verified offline by `scripts/cli-subagent-check.mts` (27 checks, in `make e2e`):
adapter mappings against recorded log shapes, placeholder substitution
including the {model}-pair drop, the config store round-trip (defaults /
override / tombstone / validation), and a fake-CLI end-to-end through the real
`createRunAgentTool` (spawn → log tail → events → mirrored transcript → parsed
result), plus timeout-exhaustion and abort. `scripts/live-cli-subagent.mts`
runs the REAL `claude` once (costs one turn; needs the auth env an operator
would put in the entry's `env:{}` — the allowlist hands the child no
credentials by design) and asserts the file landed, the log was tailed and the
transcript mirrored; codex is skipped with a line where not installed. The
real OAuth/interactive behaviour of the CLIs themselves is exactly where this
stops.

## Session plan / delegation ledger (`agent/todo.ts`)

The orchestrator's task list, with two writers by design:

- **the model** owns the *plan* — the `todo` tool takes the whole list every time
  (rewrite, don't patch), so a decomposition lives somewhere other than one
  assistant message;
- **the framework** owns the *execution state* — `run_agent` marks its step
  running / done / failed / stopped and attaches which specialist took it, which
  working tree it ran in, and where its transcript landed. Models forget to
  update status; the runtime does not.

A rewrite therefore MERGES by id, so the model restating its plan cannot wipe the
ledger fields underneath it. Only the top-level agent gets the `todo` tool —
several sub-agents rewriting one shared plan would just race.

State lives at `<sessionsDir>/<sessionId>.todo.json` (persisted on every change,
restored on boot) and is broadcast as a `todos` frame; the snapshot handshake
replays it, so a tab joining mid-run — or between turns — sees the plan. A tab
that opens a session whose worker has not been spawned reads it over REST:
`GET /api/projects/:pid/sessions/:sid/todos` (ownership-checked like the
transcript). The UI renders it above the composer.

## 我的助理 (the assistant: one agent that drives all the others)

The FIRST project in the tree is not a project. `assistant` (`ASSISTANT_PROJECT_ID`,
`server/protocol.ts`) is injected in memory by `ProjectManager.list()/get()` — never
a record on disk, not deletable, always first regardless of activity. Its workspace
is `<dataDir>/workspace` (the same default cwd as project-less spawns), and it has
exactly ONE session with the same fixed id, ensured by the sessions controller
(idempotent create → 200, delete → 403; the tree hides its New-session/Delete
buttons — `isAssistant` in `server/views/pages/tree.tsx`).

Its config carries `sessionControl: true`, which flows into the worker's spawn
config and gates three tools the runtime assembles ONLY for it
(`agent/tools/sessions.ts`):

- `sessions` (R) — every project, its sessions, live run state;
- `session_send` (W) — deliver a user message to any other session through
  `AgentManager.prompt` (idle → activates, running → steer/followup queue):
  exactly the path the chat UI drives, so the assistant operates other projects
  the way the operator would from a browser;
- `session_read` (R) — a session's transcript tail, to collect the reply.

The tools are thin: each is one `session_control` worker→server RPC frame
(ref + promise parked in `AgentRuntime.sessionOps`, 30 s timeout), answered by the
manager's `onSessionControl` hook (`server/index.ts`) — injected as a dependency
the same way `applySessionTitle` is, keeping `agent/` free of any runtime import
of `server/`. The hook re-resolves the asking project and refuses unless its own
config says `sessionControl`, refuses sends to the assistant itself (its worker is
busy asking — the message would queue behind the very turn that sent it), and maps
transcript messages through `toWireMessages` (user text is a string, assistant
text is text-blocks) so the model sees one clean role+text shape. Its prompt is
`agent/agents/builtin/assistant.md` (`internal: true` — not delegatable), and the
prompt's core rule is spelled out there: **delivery is not completion** — poll
`session_read`, don't report a send as a result.

## Built-in tools: the catalog is the inventory (`docs/TOOLS.md`)

Every built-in tool's model-facing text lives in a `*_TOOL_META` constant
beside its factory (`name`, `description`, `mode`, `prompt`), and the factory
spreads it — one source of truth, so `agent/tool-catalog.ts` can list all 24
without constructing a session (settings → Tool shows each with a scope
badge: 全部 / 主 agent / 仅助理 / DAG·默认关闭). `docs/TOOLS.md` is the audit:
the measured inventory, the three contradictions between tool guidelines
(two plans, two delegations, two fan-outs) and how each was resolved, and the
cuts. The DAG set (`plan`/`decompose`/`update_node`/`get_status` + `delegate`)
is OFF by default — it duplicated `todo` + `run_agent` and had zero calls in
1.4k measured — `CLOWNFISH_DAG_TOOLS=1` restores it. `run_goal`'s executor
builds its own DAG tools and is unaffected. The "how to choose" rule lives in
one place: `WORKFLOW_DIRECTIVE` in `agent/runtime.ts`.

## Bash output compaction: an optional rtk backend

`agent/tools/rtk-backend.ts`: when a real `rtk` binary (rtk-ai/rtk) is on
PATH, the bash tool asks `rtk rewrite <command>` for a compacted equivalent
(`git status` → `rtk git status`, 296→52 bytes measured) and runs THAT. Trust
is narrow: the rewrite must be a pure `rtk `-insertion whose wrapped verbs are
all on an allowlist (git / test runners / linters / builders) — rtk happily
rewrites `grep` too, which changes flag semantics (rtk-ai/rtk#2301) and poaches
the structured tools' territory, so those are refused. Exit 127 from a rewrite
(rtk vanished since the probe) re-runs the original; `CLOWNFISH_RTK=0`
disables. The model never sees the seam.

## Per-project context window (settings → 项目)

`ProjectConfig.contextWindow` (128K/256K/512K/1024K, REST-validated, `null`
clears) is min-clamped onto the model record in `resolveRuntime` — it can only
SHRINK the model's declared window, because granting one the model lacks just
moves the failure to the provider and disarms auto-compaction (which fires at
75% of `model.contextWindow`, `agent/runtime.ts`). Shrinking also shrinks
pi-ai's per-request output budget (`clampMaxTokensToContext`) — intended. The
config is frozen into the worker spawn env, so it takes effect on the next
worker spawn; the boot log names the effective cap.

## Search: one tool, an optional ripgrep backend

`grep`/`find` walk the workspace in-process (`agent/tools/fs-walk.ts`), and
`grep` uses `rg` as an ENGINE when a real one is on PATH — the model never
learns which ran. The contract, the caps, the output format and the fs-jail
are identical; `rgSearch` returns null (absent binary, a regex rg's Rust engine
rejects such as lookahead, a 20s timeout, an abort) and the in-process engine
answers instead. `CLOWNFISH_RG=0` forces the built-in.
`scripts/search-tools-check.mts` pins the parity — the same call must give the
same answer on both engines, or installing ripgrep would silently change what
the agent sees. `scripts/bench-search.mts` re-measures the trade.

Two defects found while measuring this, both worth knowing because they cost
far more than the backend saves:

- **nested `.gitignore` was ignored** — only the root file was read, so
  `app/mac/.gitignore` (791MB of Rust `target/`, a 131MB `.app` with two bun
  binaries) did nothing and every search read them: 3,722 files walked instead
  of 249, a rare-symbol search taking **6.5s**;
- **no binary/size guard** — every file was read as UTF-8 and regex-scanned,
  including those 65MB binaries, so a miss cost seconds and could match
  mojibake.

Fixed (scoped ignore stack + a NUL sniff and a 2MB ceiling), the same search
went 6,537ms → 51ms. Only then is the ripgrep question honest: at this repo's
size the gap is ~40ms and irrelevant, but on a 17k-file tree a rare symbol is
**4,755ms built-in vs 276ms rg** — while a COMMON word is faster built-in
(172ms vs 355ms), because it stops at `maxResults` and rg scans on. rg is used
whenever present since its bad case is fine and its good case is decisive.

Two traps the integration answers: the search path is always explicit, because
a path-less `rg` treats a non-tty stdin as its input and hangs forever
(measured; the same trap rtk-ai/rtk#2301 reports); and `include` globs are
matched by the tool, never handed to rg's `--glob`, so the engine swap cannot
change WHICH files are searched.

## What the first request carries (`CLOWNFISH_DUMP_PROMPT`)

Set `CLOWNFISH_DUMP_PROMPT=<dir>` and every agent build (main and sub) writes
`<dir>/<sessionId>.system.md` + `.tools.json` — exactly the system prompt and
tool schemas the provider sees — and logs a per-tool token estimate. Measured
for 我的助理 saying "hi" (8.5k input tokens): ~4.1k is the system prompt
(assistant.md ~0.6k + the `## Tools` guidelines block ~3.4k — `workflow`,
`run_agent`, `todo`, `memory` are the big ones) and ~6.1k (est.) is the JSON
schema of 24 tools (`run_agent` 760, `update_node` 420, `memory` 400, …). The
conversation itself is a rounding error; the fixed cost is the toolset.

## Prompt compaction (size-triggered, off by default)

Agent prompts are markdown because people edit them; the model does not need the
typography. `agent/prompt-compact.ts` strips it — heading hashes, emphasis
markers, link targets, blank-line padding, alignment spaces — while preserving
fenced blocks, inline code and indented samples byte-for-byte (they carry
`{placeholders}` and JSON shapes where whitespace is meaning). It never rewrites
prose: `make e2e` asserts letters and digits are identical before and after.

**It is applied by SIZE, not globally**, because the measurement says global is
not worth it: on the shipped prompts the first request goes from 5,255 to 5,215
tokens (**-0.76%**) — they are prose with almost no decoration — while a
markdown-heavy document compacts by ~18%. So:

- built-in prompts are never compacted; what you read in `agent/agents/builtin/`
  is exactly what the model gets;
- an operator-authored prompt (global, project, plugin or settings-page override)
  is compacted only once it exceeds **16 KB** — `AgentLoader` does it at load
  time and flags the definition `compacted`. Configure the threshold with
  `CLOWNFISH_PROMPT_COMPACT_THRESHOLD` (bytes);
- `CLOWNFISH_COMPACT_PROMPTS=1` forces compaction of every assembled prompt
  (off by default).

The file on disk is never modified — the settings editor still shows what was
written.

## Checkpoints: an action log, not just file pre-images

`agent/checkpoint.ts` records an ORDERED log of what a turn changed, with enough
state to undo each entry:

- `write` / `edit` — the target's pre-image (a missing file becomes a tombstone);
- `bash` — the command can touch anything, so the WHOLE workspace is captured
  instead, through the one primitive in `agent/workspace-snapshot.ts`:
  `git stash create` plus the untracked list inside a repository (exact, O(changed
  files)), or a full tree copy for a workspace under `CLOWNFISH_CHECKPOINT_COPY_LIMIT`
  (64 MB default, skipping `node_modules`/`dist`/…). When neither is possible the
  action is recorded as un-undoable.

Restore replays the log in **reverse**, so a shell restore that rewinds the tree
is followed by the earlier file pre-images and lands on the state before the turn.
It **stops at the first action it cannot undo** and says so, rather than leaving a
tree that is half one version and half another. Manifests written before the log
existed still restore their file entries.

Known limits, stated rather than hidden: git mode does not restore ignored files,
`.git` itself is untouched (a commit or branch switch is not undone), and copy
mode skips the excluded directories.

## Memory + reflection (self-maintenance)

Compaction keeps ONE conversation inside the window; **memory** is what outlives
it. It lives outside the repo, under `<dataDir>/memory/`:

```
memory/
  applied/global/<category>.md          about the user or this machine
  applied/projects/<pid>/<category>.md   only true of that codebase
  cursors.json                           how far reflection has read each session
  runs.jsonl                             append-only audit of every write/removal
```

Categories are a closed set: `rules` · `style` · `facts` · `preferences` ·
`lessons` (a mistake WITH its root cause — it ages differently from a
preference, so it is filed apart). One entry per line, carrying the id the model
sees and a local timestamp to the second:

```
- [a3f2] 用户偏好中文回复，技术名词保留英文 (2026-08-29 15:04:32)
```

The id is what makes memory correctable: `forget(id)` removes exactly one line,
and because the ids ride in the prompt the model can REVISE an entry instead of
appending a contradiction beside it. Full provenance (which session, which
writer, exact time) stays in `runs.jsonl` keyed by that id, so the prompt budget
pays for a date rather than a paragraph.

**Two writers, both the agent, both immediate.** The model calls the `memory`
tool (`remember` / `forget`) mid-turn when it learns something durable; and
**reflection** — the internal `sys-reflect` agent — reads the finished session
and writes what deserves to persist. There is deliberately NO confirmation
queue. What replaces one: the audit log, the visible ids, and a memory browser
where a human deletes anything they disagree with.

Reflection is conservative on purpose, because a noisy memory store is worse
than an empty one: skipped under 8 messages, at most 3 entries per session, only
the last 60 messages read, 90 s ceiling, never throws into the shutdown path,
`CLOWNFISH_REFLECT=0` disables it. It runs only when a session actually ENDS
(idle reap or explicit stop) — a server-wide Ctrl-C passes `reason: "server"`
and skips it, so quitting the dev loop does not fire one model call per live
session. `cursors.json` makes it idempotent: a session can end MORE THAN ONCE
(reaped → reopened → reaped), and without the cursor the second pass would
re-read what the first already distilled and write the same memories twice.

Injection is a `## Memory` block filtered to **global + the current project** and
capped at 8 KB, placed AFTER the mode directive so a remembered preference can
never displace a plan/ask constraint.

Not to be confused with `CLAUDE.md` / `AGENT.md`, which the loader reads fresh
per agent build along the root→cwd chain: those are written by PEOPLE, live in
the repo, and are shared by everyone who clones it. Memory is written by the
AGENT, lives in `<dataDir>`, and belongs to one operator.

Browsable and deletable from **settings → Memory** and the standalone
`#/memory` page — one `MemoryBrowser` component behind both, since two copies
would drift. Key source: `agent/memory.ts`, `agent/reflect.ts`,
`server/controllers/memory.ts`, `server/views/pages/memory.tsx`.

REST: `GET /api/memory`, `DELETE /api/memory/:id`.

## Keyboard shortcuts (settings → Keys)

14 rebindable actions (`KEY_ACTIONS` in `server/protocol.ts`). Defaults live in
code; only the deviations are stored, in `<dataDir>/keybindings.json`, so bindings
follow the operator between browsers and a reset is deleting the entry. `Mod` is
⌘ on macOS and Ctrl elsewhere — one table, both platforms, resolved client-side
in `server/views/keymap.ts`. The settings panel rebinds by CAPTURE (press the
combination) and flags collisions; chat tabs pick up a change without a reload via
a `clownfish:keybindings` window event. Session-level actions live in `ChatPage`,
workspace-level ones (tab switching, new session) in `App`.

REST: `GET /api/keybindings`, `PUT|DELETE /api/keybindings/:action`, `DELETE /api/keybindings`.

## Benchmark: Clownfish vs Claude Code

`make bench` (`ROUND=n`) runs both agents over the same tasks with the same model
backend, so what is measured is the harness rather than the model. Fifteen tasks in
four suites (`scripts/bench/tasks.mjs`, `tasks2.mjs`, `tasks3.mjs`, `tasks4.mjs`), scored by hidden tests the
agent never sees; artifacts land in `.bench/runs/round<n>/`. `make bench-dry`
seeds and verifies WITHOUT running an agent — the baseline must score near zero,
which is how a new task proves it does not give away points. `make bench-rescore`
re-verifies existing workspaces after a verifier fix, without paying for another
agent run. `node scripts/bench/report.mjs > docs/bench/REPORT.md` renders the
scoreboard; the task designs and the harness traps are in `docs/bench/CASES.md`.

Suites 1–3 SATURATED — both agents scored full marks and only wall time
separated them, so re-running them buys no information. **phase4** is built the
other way round: each task demands a behaviour a harness either has or does not,
and every wrong-but-plausible answer was measured, not assumed. `heisenbug` has
no failing test at all (only a CI log), so it cannot be solved without building a
probe; serialising the scheduler "fixes" it and fails a concurrency check.
`perf-bisect` hides the cause in git history and makes `git revert` lose a
feature the hidden tests require. `needle-in-haystack` puts one wrong character
in 6k generated lines and rejects a diff that touches any other rule, so
regenerating the file scores below the one-character fix. Seed / trap / reference
scores are tabulated in `docs/bench/CASES.md`.

**`make bench-polyglot`** runs a public benchmark instead of ours — Aider's
polyglot set (Exercism exercises, scored by their own upstream tests). Every
task in `tasks*.mjs` was written by the same people as the harness, which is
fine for measuring a change against itself and useless for answering "is this
harness good"; this suite has no such coupling. `scripts/bench/polyglot.mjs`
adapts it: python / go / rust only (java, c++ and javascript would measure
toolchain availability — 100 of the 225 exercises remain), `.meta/example.*`
never reaches the workspace, and every test file is restored from the pristine
checkout before scoring, so editing the tests cannot help. Sampling is a stable
hash of the exercise name, so `--n 12` is the same twelve every round.
`make bench-polyglot-fetch` clones the checkout into `.bench/` (gitignored).
Absolute scores are NOT comparable to the published leaderboard: different
language subset, different model backend.

## Tool prompts (settings → Tools)

A tool's model-facing text is three things: the `description` in the schema the
provider sees, the one-line `snippet` in the system prompt's tool index, and the
`guidelines` bullets under its heading. They are authored in TypeScript, so the
settings page's **Tools** tab makes them editable the same copy-on-write way
agents are — the shadow file is

```
<dataDir>/tool_overwrite/<name>.md     # frontmatter snippet/guidelines, body = description
```

merged over the code-defined definition at agent construction (`applyToolOverrides`
in `agent/tools/overrides.ts`), for the orchestrator and every sub-agent alike. A
key the file omits keeps the code default, so an edit can retune just the snippet.
Reset deletes the file. Overrides are global (tools are code, not per-project
assets) and are read once per session boot — a running worker keeps the prompt it
started with. MCP tools are not listed (their text comes from the remote server),
but an override written for one by name still applies.

`agent/tool-catalog.ts` enumerates the prompt surface without building an agent,
which is what the listing endpoint serves.

REST: `GET|PUT|DELETE /api/tool-prompts/:name`.

`CLOWNFISH_SESSIONS_DIR`, `CLOWNFISH_PORT`, `CLOWNFISH_BIND` (default
`127.0.0.1` — the tool has filesystem + paid-API access, so it binds loopback
unless you explicitly set e.g. `CLOWNFISH_BIND=0.0.0.0`; the server warns at
boot when it is reachable from other machines without login enabled),
`CLOWNFISH_AGENT_SOCKET`, `CLOWNFISH_AGENT_IDLE_TTL` (ms, `0` = never reap),
`CLOWNFISH_PROVIDER` / `CLOWNFISH_MODEL` (defaults for new projects).

## Admin panel (asset management, `#/admin`)

The Web UI ships a panel over every agent prompt / skill / tool / plugin the
session's discovery would load, with enable/disable toggles and CRUD. State
lives in `<dataDir>/registry.json` (`agent/registry.ts`) — a list of DISABLED
names per kind; everything else is on disk and re-enabling is lossless.
Workers read the registry at boot: disabled agents/skills are dropped from the
loaded set, disabled plugins are skipped at discovery (cascades to the assets
they ship), disabled tools are filtered from the main agent's toolset (builtin
names + whole MCP servers, which then aren't even connected). Every panel
write **hot-reloads** all live workers (`reload_assets` frame): an idle worker
re-discovers its assets and rebuilds the agent around its live history
immediately; a busy one defers to its next turn — the reload lands before that
turn's first LLM request, so the request already carries the new
prompt/toolset (no worker restart; MCP connections are reused when the server
set is unchanged). `/api/projects/:id/inventory`
(`server/controllers/inventory.ts`, model `server/models/inventory.ts`); the
`/projects/:id/skills` menu endpoint mirrors the filtering.

Agent `.md` and `SKILL.md` edits are versioned vim-style: each save backs the
current file up as `<file>.YYYYMMDD-HHmmss` (same-second saves get a `.N`
counter), newest **5** kept, with version list / diff / rollback in the panel.
Names are validated (`NAME_RE` — no traversal); `builtin`/`plugin:` assets are
read-only. Verified by `scripts/smoke-inventory.ts`.

## HTTPS + access control (both optional)

**HTTPS** — opt in with `CLOWNFISH_TLS=1` (`make dev-tls` / `make start-tls`). With no
cert supplied, a self-signed one is auto-generated + cached under
`<dataDir>/certs/` (reused on next boot) covering localhost, 127.0.0.1, the
hostname, and LAN IPv4s — trust it manually in the browser. To use a real cert:
`CLOWNFISH_TLS=1 CLOWNFISH_TLS_CERT=… CLOWNFISH_TLS_KEY=…`; `CLOWNFISH_TLS_HOST`
overrides the CN/DNS SAN of the generated cert, and `CLOWNFISH_HTTPS` is an alias
for `CLOWNFISH_TLS`. The browser WS hub auto-becomes `wss://`; the Unix-domain
agent socket stays plain `http:`.

**Login** — fully optional, **off by default** (nothing to configure:
`make dev` / `make start` just run open on loopback), but the first interactive
boot nudges toward a password — the wizard's default answer is 简单模式 — and an
undecided non-interactive boot logs a one-line warning pointing at
`npm run login`. Turn it on with
`CLOWNFISH_AUTH`: `simple` · `google` · `github` · `oidc` · `token`. Unset or an
explicit `off`/`0`/`false`/`none` leaves the server open. **Fail closed:** any
OTHER value — a typo like `gogle`, or a real mode missing its credentials —
throws `AuthConfigError` and the server refuses to boot (exit 1) instead of
silently serving an open agent with filesystem access; set `CLOWNFISH_AUTH=off`
to run without login. **Local dev is always open**: `make dev` runs with an
explicit `CLOWNFISH_AUTH=off`, so a `settings.json` that enables login for a
deployed host can't silently gate the dev loop — use `make dev-auth` to
exercise the login flow locally.

- **简单模式 (`CLOWNFISH_AUTH=simple`)** — username + password, no OAuth. The
  **first-run wizard** (`server/auth/wizard.ts`) asks on any interactive boot
  where nothing has decided auth yet: a. 简单模式 b. 配置 OAuth c. 跳过. It runs
  ONLY when stdin+stdout are TTYs and `CLOWNFISH_AUTH` is unset (env and
  settings.json) — `make dev`, e2e and CI never see it. `npm run login` re-runs
  it at any time (that IS the password-reset path: re-running 简单模式
  overwrites the verifier). The wizard's choice is remembered in
  `settings.json`'s `env:{}`; the credentials are a **PBKDF2 verifier** (the
  password itself never touches disk) in `<dataDir>/auth/simple.json` (0600).
- **OAuth2 / OIDC (`CLOWNFISH_AUTH=google|github|oidc`)** — one hand-rolled
  authorization-code flow **with PKCE (S256)** (`server/auth/oauth.ts`), three
  identity providers. Only the access token is used and the provider is asked
  who it belongs to (no ID-token/JWKS parsing); the address must be
  **verified** (GitHub: the primary verified entry of `/user/emails`).
  Gated by an allowlist (emails OR exact-match domains; both empty denies
  everyone). Setup instructions — env vars, redirect URIs per provider — live
  in the README's "Login" section, not here. `oidc` resolves endpoints lazily
  from the issuer's discovery document (cached, failures not cached);
  `CLOWNFISH_AUTH=1`/`true` still means google. Key source:
  `server/auth/{config,oauth,routes}.ts`.

- **一次性 token (`CLOWNFISH_AUTH=token` + `CLOWNFISH_AUTH_TOKEN`)** — the OS
  app shells' mode, no human login at all. The shell generates a random token
  per launch, injects it via the spawn environment, and opens its webview at
  `/autologin?token=…` (mounted at the ROOT, before requireAuth). The token
  works **exactly once** (consumed on first success; wrong and already-used
  answer the same 401) and buys a session cookie with **no expiry server-side
  (`ttl: 0`) and no Max-Age client-side** — a browser-session cookie, so the
  login dies with the webview, i.e. with the app. A webview that re-requests
  `/autologin` with a valid session just gets `302 /` (the shell's
  health-triggered reload must be idempotent). The token never touches disk.

Simple mode has no login throttle (deliberately not done yet). The in-memory nonce
table is capped (1000) so `/challenge` cannot be used to grow it. Simple mode's login is a **challenge/response**, so the password never crosses
the wire either: the login page (`/auth/simple`, self-contained HTML — no SPA
assets) fetches `{salt, iterations, nonce}`, derives
`K = PBKDF2-SHA256(password, salt, iterations)` client-side (WebCrypto, same
parameters the server stored) and posts `HMAC-SHA256(K, nonce)`. The nonce is
single-use with a 3-minute TTL, so a captured exchange cannot be replayed. A
sniffer learns nothing; an attacker who steals `simple.json` holds a
password-equivalent — that is TLS's job (`CLOWNFISH_TLS`). Key source:
`server/auth/simple.ts` (verifier + nonces), `server/auth/simple-page.ts`.

Hand-rolled (no new deps): `node:crypto` HMAC-signed cookie session + `fetch` to
the provider's endpoints. The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` only over
TLS (so dev over plain HTTP still works). `/auth/login` is the provider-agnostic
entry (302 to the enabled mode's page — requireAuth and the SPA both target it,
so neither knows the provider), `/auth/me` is the always-200 status probe,
`/auth/logout` clears it. When enabled, every `/api/*` call without a session
returns 401, browser GETs 302 to the login page, and the `/chat` WebSocket
upgrade is rejected (`verifyClient` 401). `/api/health` and `/auth/*` stay open.
Config: `server/auth/`.

## macOS app shell (`app/mac`)

A Rust binary (wry + tao + muda, no Tauri — the app is a window around an HTTP
server that already exists) that spawns a **bun-compiled server binary** on a
free port (loopback only) and hosts the web UI in a WKWebView.
`app/mac/build.sh` builds the whole self-contained bundle:
`bun build --compile` turns `server/index.ts` and `agent/worker.ts` into
standalone executables inside `Contents/MacOS/` (no node/npm at runtime — the
compiled worker is SPAWNED, not forked: `CLOWNFISH_WORKER_BIN`, because fork
re-execs `process.execPath`, which in a compiled server is the server itself;
the fork IPC channel was never used, the worker speaks over the UDS), the
Vite build lands in `Contents/Resources/web-dist/` (`CLOWNFISH_WEB_DIST` —
inside a bun binary `import.meta.url` is a virtual `$bunfs` path, so the
static root must come from env).

The shell logs the webview in with a **one-time token** (see the auth section):
random per launch, injected via `CLOWNFISH_AUTH=token`/`CLOWNFISH_AUTH_TOKEN`,
spent by the webview's first `/autologin?token=…` request — no login screen,
and the session lives exactly as long as the app. It also gives the server a
per-launch `CLOWNFISH_AGENT_SOCKET` (a dev server alongside would hold the
default path in the shared dataDir).

`app/README.md` documents every webview pitfall it answers; the load-bearing
ones: a transparent titlebar (NOT `with_decorations(false)` — that's the
Borderless mask and removes the traffic lights), an IPC drag region
(`-webkit-app-region` is Chromium-only), a muda main menu (macOS matches
Cmd+C/V/X/Z/A/W/Q against the MENU, not the key window), and process-group
reaping on every exit path — window close through `LoopDestroyed`, and signals
through a process-wide `signal()` handler + watcher (a sigwait thread loses the
delivery race to macOS's lazily-spawned libdispatch threads — measured).
`CLOWNFISH_APP_URL` switches to attach mode (no child, no token — that server
keeps whatever auth it has). `app/win/` is a placeholder.

## Architecture (multi-process)

```
Browser ──TCP WS /chat──▶  Server (one process: REST + AgentManager + UDS hub)
                            └─ UDS  ◀── ws+unix:<dataDir>/agent.sock:/agent ──
                                          └─▶  Agent worker (own process / session)
```

- The **server is the agent manager** (lifecycle) + REST + the browser's WS proxy.
- Each **session's agent runs in its own worker process**, independent of any chat
  UI (long-running/background jobs survive a closed tab). Workers are lazily
  spawned and reaped by an idle TTL (`POST .../agent/stop` and `pin` also exist).
  Open tabs do NOT pin a worker: a subscriber is a viewer, not a keep-alive —
  the record (and its subscribers) survives the reap, and the next prompt
  lazily respawns with frames fanning out to the surviving tabs. Explicit
  `pin` opts out. Verified by `scripts/smoke-reap.ts`.
- **FS isolation** (`agent/tools/fs-jail.ts`): the filesystem is not a
  cross-session channel. Structured tools (read/write/edit/ls/grep/find) jail
  every model-supplied path to the agent's own cwd (worktree sub-agents get
  their worktree): inside → allowed; outside → user consent via a
  `tool_approval` card (main agent only; unattended sub-agents get the strict
  refusal); session-data roots (dataDir/sessionsDir — other sessions'
  transcripts, `settings.json` secrets, memory) → always refused, consent or
  not. bash gets a best-effort text screen (roots in absolute/`~`/`$HOME`/
  `${HOME}` form + `..` climbs) — a tripwire, not a boundary; real command
  isolation would need a sandboxed spawn mode. Runtime-internal fs access
  (transcripts, skills, MCP config, memory, checkpoints) bypasses the jail —
  those paths are chosen by code, not the model.
- Server ⇄ worker transport is **WebSocket over a Unix domain socket**
  (`ws+unix:`). Each connection registers its `sessionId`; the server proxies
  browser ⇄ worker and fans events out to every subscriber (multi-tab).
- A mid-run join is reconstructed via a **snapshot handshake** (the joining tab
  receives the in-flight turn replayed as ordinary frames).
- **Transcripts**: one directory per session (`<sessionsDir>/<sessionId>/`):
  `index.jsonl` is the main agent's append-only transcript (envelope
  `{id, ts, message}`), each sub-agent writes its own `<agentId>.jsonl`, and
  `dag.json` / `goals.json` sidecars hold shared plan/goal state. All written
  solely by the owning worker; legacy flat `<sessionId>.jsonl` files are
  migrated into `index.jsonl` on boot. The REST API paginates the main
  transcript (most-recent page first, `?before=<lineIndex>` cursor).

Key source: `agent/{manager,uds,proxy,protocol}.ts`, `agent/worker.ts`,
`agent/transcript.ts`. The reusable agent module is `agent/` (entry barrel
`agent/index.ts`); the server imports `AgentManager` / `startUds` from `../agent`.

## Conventions

- **ESM** (`"type": "module"`), run via **tsx** (no build step for dev).
- Single package (no workspaces). Layout: `agent/` (reusable multi-process agent
  runtime — agent loop, tools, skills, worker, manager, UDS; entry barrel
  `agent/index.ts`), `server/` in MVC — `models/` (data), `controllers/` (REST +
  `/chat` WS), `views/` (Preact + Vite UI), `auth/`, plus `server/protocol.ts`
  (the browser↔server wire types, formerly the `shared` package). `server` imports
  `agent` via `../agent`; `agent` has zero runtime dependency on `server` (only
  erased `import type` references to `server/protocol.ts`).
- Secrets stay in `settings.json` or env — never in source. The repo must stay
  commit-safe; `settings.json` / `node_modules` / `dist` / `data/` are gitignored.
- `dataDir` and `sessionsDir` are created on boot if missing (the server must not
  assume they exist — a missing Unix-socket parent dir fails with `EACCES`).

## Verification

Two gates, no unit-test suite yet:

- `make typecheck` — `tsc --noEmit`, the fast correctness check.
- Pure-function checks run as `.mts` subprocesses under the same gate:
  `scripts/prompt-compact-check.mts`, `scripts/checkpoint-check.mts`,
  `scripts/frontmatter-check.mts` (`agent/frontmatter.ts` is the ONE YAML
  frontmatter parser — agents, skills, commands, memory and tool overrides all
  go through it; it never throws, so one malformed operator-authored file can
  never abort a discovery pass).
- `node scripts/ui-audit.mjs` — drives the RUNNING dev UI with Playwright and
  measures what a screenshot cannot: console errors, horizontal overflow,
  interactive targets under 24px, text clipped by its box, and text below the
  4.5:1 contrast floor — every route, desktop and phone, screenshots to
  `.ui-audit/`. It is a list to work from, not a pass/fail. It also verifies the
  stylesheet parses: it found 52 rules (the whole settings page) silently
  dropped because a merge had fused two rules into one unclosed block — the
  source looked fine and no tool complained.
- `make e2e` — `scripts/e2e.mjs` boots a real server on a free port against a
  throwaway `CLOWNFISH_DATA_DIR`, then drives the REST surface (projects,
  sessions, transcript, agent lifecycle, 4xx paths), agent-prompt overrides
  (copy-on-write, source file untouched, reset restores it), plugin + slash
  command discovery against a Claude-Code-layout fixture, the `/chat` WebSocket
  handshake, and a second server booted with `CLOWNFISH_AUTH=google` to assert
  the gate (401 on `/api/*`, open `/api/health` + `/auth/*`, rejected WS
  upgrade), `scripts/auth-config-check.mts` (fail-closed config, domain
  allowlist, PKCE, OIDC discovery against a local mock provider), the tool-prompt override round-trip, and the session-plan endpoint
  (including its cross-project isolation). 257 checks, needs **no** provider credentials and no browser — this
  is the one to wire into CI.
- `make e2e-live` — the same plus one real model turn over `/chat` (asserts a
  tool call and assistant text). Costs money; needs a configured provider.
