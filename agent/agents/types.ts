/** Agent prompt definitions — named, overridable system-prompt templates loaded from disk. */

import type { ClownfishAgentOptions } from "../clownfish-agent";
import type { DagStore } from "../dag";
import type { ResolvedRuntime } from "../models";
import type { Skill } from "../skills";
import type { WorkerFrame } from "../protocol";

/**
 * Variables substituted into an agent prompt template's `{var}` placeholders at
 * injection time, so a prompt can adapt to the live session context.
 */
export interface AgentPromptVars {
	cwd: string;
	project: string;
	sessionId: string;
	date: string;
	os: string;
}

/** A loaded agent: a name + optional description + a prompt body (a template). */
export interface AgentDefinition {
	/**
	 * Stable name = the `.md` filename stem. Used to select the agent for a session
	 * and as the `type` passed to the `run_agent` tool.
	 */
	name: string;
	/** One-line role description (from optional YAML frontmatter). Shown in run_agent's type list. */
	description?: string;
	/**
	 * Internal/framework agent (frontmatter `internal: true`) — not exposed via the
	 * run_agent tool's delegatable list. Used for system roles like `sys-compact`
	 * that the framework invokes directly rather than the orchestrator delegating to.
	 */
	internal?: boolean;
	/**
	 * Tool access policy when this agent runs as a sub-agent: "R" = read-only tools,
	 * "RW" = all (default). From frontmatter `access`. e.g. `arch` → "R".
	 */
	access?: "R" | "RW";
	/**
	 * Pin this persona to a specific model id (frontmatter `model`), same
	 * provider as the session — e.g. `qa` always runs on a stronger model than
	 * the session default. A per-call `model` on run_agent's `type`/`tasks[]`
	 * overrides this. Omit to inherit the session's model (the default).
	 */
	model?: string;
	/**
	 * When set, this "agent" is an EXTERNAL CLI run headless as a sub-agent
	 * instead of an in-process ClownfishAgent (Codex / Claude Code / any
	 * command). The delegation contract is unchanged (prompt in → final text
	 * out, budgets, transcript, progress, drill-in) — only the executor
	 * differs. Defined in `<dataDir>/cli-agents.json` (the settings page's
	 * Agent tab), not `.md` files. See `agent/agents/cli-config.ts`.
	 */
	cli?: CliAgentSpec;
	/** Prompt template body (markdown), with `{var}` placeholders substituted at injection. */
	body: string;
	/** Absolute path to the source `.md` file. */
	path: string;
	/** Origin label: "builtin", "global", "project", or "plugin:<name>". For logging only. */
	source?: string;
	/**
	 * True when this prompt was large enough that its human-facing formatting was
	 * stripped before the model saw it (see `prompt-compact.ts`). The file on disk
	 * is untouched; the settings editor still shows what was written.
	 */
	compacted?: boolean;
}

/**
 * An external-CLI sub-agent's launch spec — the COMPLETE process start, as
 * configured in `<dataDir>/cli-agents.json`: the executable (absolute, PATH
 * already resolved at load time) and the whole argv with `{placeholder}`
 * substitution (`{session-id}`, `{workdir}`, `{model}`, `{result-file}`;
 * a `{model}` slot is dropped together with the argv slot before it when no
 * model is in play). `log` picks the session-log adapter used for live
 * progress. See `agent/agents/cli-config.ts` / `agent/agents/cli-sub.ts`.
 */
export interface CliAgentSpec {
	/** Which session-log format to tail: claude / codex / none. */
	log: "claude" | "codex" | "none";
	/** Executable to spawn (absolute path by the time it reaches here). */
	command: string;
	/** Complete argv (placeholder-substituted). */
	args?: string[];
	/** Extra env layered over the cliChildEnv allowlist (never credentials). */
	env?: Record<string, string>;
}

/** An agent search root, scanned low→high precedence (last wins on a name clash). */
export interface AgentRoot {
	/** Directory to scan for `*.md` (before `~`/relative resolution). */
	dir: string;
	/** Origin label, e.g. `"builtin"`, `"global"`, `"project"`, `"plugin:my-plugin"`. */
	source: string;
}

/**
 * Deps shared by the background-run tools (goal loop, delegate) and the boot
 * resume paths — everything a spawned background agent needs from the runtime:
 * shared provider runtime, workspace, skills, the session bus, and the hooks
 * that keep ask-mode approvals and DAG bookkeeping wired.
 */
export interface WorkflowToolDeps {
	dags: DagStore;
	/** The MAIN agent's id (== session id) — authority scope + wake target. */
	agentId: string;
	runtime: ResolvedRuntime;
	/** The user's project cwd (the worktree is created from this repo, if any). */
	cwd: string;
	skills: Skill[];
	vars: AgentPromptVars;
	sessionId: string;
	sessionsDir: string;
	/** Where worktrees live: `<dataDir>/worktrees/<sessionId>/`. */
	worktreeDir: string;
	/** Inherited tool-call hook (ask-mode approval gate + checkpoint capture). */
	beforeToolCall?: ClownfishAgentOptions["beforeToolCall"];
	/** Per-agent variant of the hook: spawned agents get approvals attributed
	 *  to themselves (falls back to `beforeToolCall` when absent). */
	beforeToolCallFor?: (agentId: string) => ClownfishAgentOptions["beforeToolCall"];
	/** Emit a worker frame to the session bus (runtime.send). */
	onFrame: (frame: WorkerFrame) => void;
	/** Wake the main agent with an internal prompt (runtime.wakeMain). */
	wakeMain: (text: string) => Promise<void>;
	/**
	 * Notified when a background run is interrupted by a PROVIDER error (429 /
	 * 5xx / stream stall) rather than a logic failure. The runtime uses it to
	 * schedule an automatic re-drive (backoff); when absent, the interruption
	 * falls back to a user-facing failure notice.
	 */
	onInterrupted?: (kind: "goal", id: string, error: string) => void;
	/** Log line for the UI/operator. */
	log?: (message: string) => void;
}
