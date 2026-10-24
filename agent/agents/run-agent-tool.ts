/**
 * run_agent tool — process-internal sub-agent delegation.
 *
 * The top-level session agent (typically "system") calls
 * `run_agent({ type, task, context })` to run a specialized sub-agent
 * (arch / coding / qa / …) to completion IN THE SAME PROCESS, then receives its
 * final answer as the tool result, so the parent can decide what to do next.
 *
 * The sub-agent is a fresh in-process {@link ClownfishAgent} (no new worker
 * process is forked) and deliberately does NOT receive run_agent itself, so
 * delegation cannot recurse.
 *
 * The delegation is observable, bounded and interruptible rather than a black box:
 *   - the sub-agent's activity streams back through the tool's `onUpdate` channel
 *     (live progress on the run_agent card in the UI),
 *   - the parent's abort signal is forwarded, so stopping a turn stops the work
 *     it spawned,
 *   - a step budget and a wall-clock deadline stop a runaway child before it
 *     burns the context window (it has no compaction of its own), returning the
 *     partial output so the parent can re-scope instead of losing the work,
 *   - and its whole conversation is written to its own transcript file, so what a
 *     specialist actually did is reviewable afterwards — the parent only ever
 *     sees the final answer.
 *
 * A delegation that CHANGED the workspace is then verified by the framework, not
 * on the model's initiative: across 33 measured runs the orchestrator delegated
 * to `qa` exactly zero times, because the same prompt that asks for verification
 * also tells it that delegation is expensive — and the cost rule won. So the
 * second pass is mechanical: implement → verify → on a FAIL verdict, retry once
 * with the findings. See {@link VerifyPolicy}.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { lastAssistantText } from "../messages";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "../tools/definition";
import type { ToolDefinition, ToolMeta, ToolPromptContribution } from "../tools/definition";
import type { ToolOverrideMap } from "../tools/overrides";
import { ClownfishAgent, type ClownfishAgentOptions } from "../clownfish-agent";
import { resolveRuntime, type ResolvedRuntime, type ProviderConfigLike } from "../models";
import type { Skill } from "../skills";
import type { AgentDefinition, AgentPromptVars } from "./types";
import { renderPrompt, agentsTypeList } from "./loader";
import { runCliSub } from "./cli-sub";
import { SessionTranscript } from "../transcript";
import type { WorkerFrame } from "../protocol";
import type { TodoStore } from "../todo";
import { snapshot as snapshotWorkspace, restore as restoreWorkspace } from "../workspace-snapshot";

import { rm, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { isInsidePath } from "../tools/fs-jail";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

/** Positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Budgets for one delegation. A sub-agent has an empty conversation and no
 * compaction, so an unbounded one grinds until the context window hard-fails;
 * these turn that into a partial result the parent can act on.
 */
export const SUBAGENT_MAX_STEPS = envInt("CLOWNFISH_SUBAGENT_MAX_STEPS", 80);
export const SUBAGENT_TIMEOUT_MS = envInt("CLOWNFISH_SUBAGENT_TIMEOUT_MS", 15 * 60_000);

/** Agent that performs the framework's verification pass. */
const VERIFY_AGENT = "qa";
/** The line the verifier must end on, so a verdict can be read mechanically. */
const VERDICT_RE = /^\s*VERDICT:\s*(PASS|FAIL)\b/im;

/**
 * When the framework runs its own verification pass after a delegation:
 *   "off"    — never (the model may still delegate to qa itself),
 *   "auto"   — after a delegation that actually mutated the workspace (default),
 *   "always" — after every delegation, including read-only ones.
 * Verification roughly doubles a delegation's cost, so "auto" only pays it where
 * something could actually have broken.
 */
export type VerifyPolicy = "off" | "auto" | "always";

export function verifyPolicy(): VerifyPolicy {
	const raw = process.env.CLOWNFISH_VERIFY;
	return raw === "off" || raw === "always" || raw === "auto" ? raw : "auto";
}

/** How many times a failed delegation is retried with the verifier's findings. */
export const VERIFY_RETRIES = envInt("CLOWNFISH_VERIFY_RETRIES", 1);

/**
 * Roll the workspace back before retrying, rather than retrying forward on top of
 * a rejected attempt. Safe now that a snapshot covers shell mutations too (git,
 * or a copy for a small workspace); it is skipped automatically where it cannot
 * be exact, and where another delegation is working in the same tree — a
 * whole-tree restore would destroy that one's work. `CLOWNFISH_VERIFY_ROLLBACK=0`
 * turns it off.
 */
export function rollbackEnabled(): boolean {
	return process.env.CLOWNFISH_VERIFY_ROLLBACK !== "0";
}

/** The tool's own result envelope (text only; run_agent has no structured details). */
type ToolText = { content: [{ type: "text"; text: string }]; details: undefined };

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const RUN_AGENT_NAME = "run_agent";

export const RUN_AGENT_DESCRIPTION =
	"Delegate work to specialist sub-agents. One sub-task (`type` + `task`), or several INDEPENDENT ones in parallel (`tasks`), optionally combined by a `synthesize` pass. Add `until` to hold the result to acceptance criteria: an independent agent verifies against them and the work is rolled back and retried until it passes. Sub-agents start with an empty conversation, share the workspace, and cannot delegate further — so everything they need goes in the task text. Besides clownfish's own specialists, the list may include EXTERNAL CLI agents (e.g. codex, claude-code) — another agent CLI run headless on the same workspace with its own model and login; when the user asks for a specific CLI by name, that is the `type` to pick.";

export const RUN_AGENT_PROMPT: ToolPromptContribution = {
	snippet: "Delegate sub-tasks to specialist sub-agents (single, parallel, or verified-until-done)",
	guidelines: [
		"Everything the specialist needs goes in `task` and `context`: it starts from an empty conversation, shares none of your history, and cannot ask you follow-up questions. Say what it should RETURN, not just what to do — its final message is the tool result.",
		"`tasks` strands run in parallel and come back together; add `synthesize` for one combined answer instead of N labelled ones.",
		"Strands that WRITE must not share a working tree — give each its own git worktree path as `cwd` (keep worktrees inside the project). Read-only fan-out (review, research, inspection) needs no worktree.",
		"Write `until` criteria complete and self-contained — they are the verifier's ENTIRE context; anything not stated will not be checked.",
		"`model` overrides the model for one strand (or a single delegation), same provider as the session — reach for it only when a strand genuinely needs a stronger (or cheaper) model than the session default; omit it otherwise.",
		"Pass the plan step's id as `todo` so the ledger tracks this delegation instead of growing a duplicate step.",
		"Raise `thinking` for a sub-task whose first plausible answer is often wrong — a defect whose cause is not visible in the symptom, a design with interacting constraints. It costs several times the tokens; leave it off for mechanical work.",
		"When it returns, judge the result against the goal rather than relaying it: decide whether another delegation or your own follow-up is needed.",
		"An entry marked as an external CLI agent (codex, claude-code, …) runs that CLI headless with ITS OWN model and login — `model` overrides are passed to the CLI verbatim, not resolved against this session's provider. When the user names a CLI ('let codex do it'), delegate to that type; otherwise prefer the built-in specialists.",
	],
};

/** One branch of a call: a single delegation, or one strand of a fan-out. */
const taskSpecSchema = Type.Object({
	type: Type.String({ description: "The sub-agent type for this strand." }),
	task: Type.String({ description: "What this strand must accomplish, self-contained." }),
	context: Type.Optional(Type.String({ description: "Supporting context for this strand only." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this strand (a git worktree, when it writes)." })),
	model: Type.Optional(
		Type.String({
			description:
				"Override the model for THIS strand only (same provider as the session) — e.g. a stronger model for the one hard strand, the session default for the rest. Omit to inherit the session's model, or the sub-agent type's own pinned model if it has one.",
		}),
	),
});

const buildRunAgentSchema = (typeDescription: string) =>
	Type.Object({
		type: Type.Optional(
			Type.String({
				description: typeDescription,
			}),
		),
		task: Type.Optional(
			Type.String({
				description: "A self-contained description of the sub-task for the sub-agent to accomplish. Omit when using `tasks`.",
			}),
		),
		context: Type.Optional(
			Type.String({
				description:
					"Optional supporting context to pass to the sub-agent (relevant paths, prior decisions, constraints). Do not assume it shares your conversation history.",
			}),
		),
		tasks: Type.Optional(
			Type.Array(taskSpecSchema, {
				description:
					"Two or more INDEPENDENT sub-tasks to run in PARALLEL instead of (type, task) — a multi-file review, research across areas, a batch transform. Results come back labelled, in order; add `synthesize` to have them combined into a single answer. Strands that WRITE must not share a tree: give each its own `cwd`.",
			}),
		),
		synthesize: Type.Optional(
			Type.String({
				description:
					"After a `tasks` fan-out, run one more sub-agent to combine the strands — this text is its instruction (e.g. \"merge these reviews into one prioritized list\"). It runs as the first strand's agent type and its answer becomes the tool result. Omit to receive the raw labelled results.",
			}),
		),
		until: Type.Optional(
			Type.String({
				description:
					"Acceptance criteria the work must MEET. An independent agent verifies the result against exactly this text and, on FAIL, the workspace is rolled back and the task retried with the findings — up to `max_rounds`. Write them complete and checkable: they are the verifier's ENTIRE yardstick. Omit for a one-shot delegation with the default verification.",
			}),
		),
		max_rounds: Type.Optional(
			Type.Number({ description: "With `until`: how many attempts to allow (default 3, max 10)." }),
		),
		todo: Type.Optional(
			Type.String({
				description:
					"Id of the plan step this delegation fulfils, from the `todo` tool (e.g. `t2`). If the plan already lists this work, you MUST pass its id — otherwise the plan grows a duplicate entry and the original step sits at `pending` forever. Omit only for work that is not in the plan.",
			}),
		),
		thinking: Type.Optional(
			Type.Unsafe<(typeof THINKING_LEVELS)[number]>({
				type: "string",
				enum: [...THINKING_LEVELS],
				description:
					"Reasoning effort for THIS delegation (default: the session's level, normally `off`). Raise it — `medium` is usually enough — when the first plausible answer is often the wrong one: a defect whose cause is not visible in the symptom, a design with interacting constraints. It costs several times the tokens and time, so do not raise it for mechanical work.",
			}),
		),
		async: Type.Optional(
			Type.Boolean({
				description:
					"Run this delegation in the BACKGROUND. The call returns immediately with a started marker and its result arrives later as an `[async-agent]` message — do not wait or poll for it. Use it for work whose answer you do not need in order to continue this turn.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for a single delegation, absolute or relative to the workspace — e.g. a git worktree. Must already exist. Defaults to the workspace root.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Override the model for a SINGLE delegation (same provider as the session). Omit to inherit the session's model, or the sub-agent type's own pinned model if it has one.",
			}),
		),
	});

/** Static prompt surface; the factory spreads it so the catalog and the runtime share one text. */
export const RUN_AGENT_TOOL_META = {
	name: RUN_AGENT_NAME,
	mode: "W",
	// The live agent list is session-specific; the catalog shows a static stand-in.
	parameters: buildRunAgentSchema("The sub-agent type to run (its name; the live list is embedded per session)."),
	description: RUN_AGENT_DESCRIPTION,
	prompt: RUN_AGENT_PROMPT,
} satisfies ToolMeta;

export interface RunAgentToolDeps {
	/** All discovered agents (the sub-agent `type` is matched against `name`). */
	agents: AgentDefinition[];
	/** Provider runtime shared with the parent (same model/credentials). */
	runtime: ResolvedRuntime;
	/**
	 * The session's own provider config, pre-resolution — the seed for a
	 * per-strand `model` override (same provider, a different model id;
	 * credentials/baseUrl/contextWindow carry over unchanged). Omit to refuse
	 * any override cleanly rather than silently ignoring it.
	 */
	baseProviderConfig?: ProviderConfigLike;
	/** Workspace root for the sub-agent's coding tools. */
	cwd: string;
	/** Skills shared with the parent. */
	skills: Skill[];
	/** Prompt vars for rendering the sub-agent's template. */
	vars: AgentPromptVars;
	/** Parent session id (the sub-agent gets a derived id for cache-aware backends). */
	sessionId?: string;
	/** Inherited tool-call hook (ask-mode approval gate + checkpoint capture). */
	beforeToolCall?: ClownfishAgentOptions["beforeToolCall"];
	/** Extra tools the sub-agent should also get (MCP tools) — never run_agent itself. */
	extraTools?: ToolDefinition[];
	/** Operator prompt overrides, applied to the sub-agent's toolset as well. */
	toolOverrides?: ToolOverrideMap;
	/** Reasoning effort, inherited from the parent session. */
	thinkingLevel?: ClownfishAgentOptions["thinkingLevel"];
	/** Framework verification policy (default: {@link verifyPolicy}). */
	verify?: VerifyPolicy;
	/** Retries after a FAIL verdict (default: {@link VERIFY_RETRIES}). */
	verifyRetries?: number;
	/** Where to record each delegation's own transcript. Omit to not record. */
	sessionsDir?: string;
	/** Operator-visible log line (surfaces as a `log` frame in the session). */
	log?: (message: string) => void;
	/** Operator-visible warning — used for actions with blast radius, like a rollback. */
	warn?: (message: string) => void;
	/** Tool-call budget for one delegation (default {@link SUBAGENT_MAX_STEPS}). */
	maxSteps?: number;
	/** Wall-clock budget for one delegation (default {@link SUBAGENT_TIMEOUT_MS}). */
	timeoutMs?: number;
	/**
	 * Session plan. Every delegation is recorded here — which specialist, which
	 * working tree, where its transcript went, how it ended — so execution state
	 * is the framework's to maintain rather than something the model must
	 * remember to write down.
	 */
	todos?: Pick<TodoStore, "begin" | "end">;
	/**
	 * The CALLING agent's id — the parent in the spawned/ended lifecycle frames.
	 * Upstream introduced the session bus's agent identity; keeping it here is what
	 * makes a delegation show up in the activity tree instead of only on the
	 * run_agent card.
	 */
	agentId?: string;
	/** Emit a worker frame to the session bus (the runtime's `send`). */
	onFrame?: (frame: WorkerFrame) => void;
	/**
	 * Per-agent hook variant, so an approval prompt can name WHICH sub-agent is
	 * asking. Falls back to the shared `beforeToolCall`.
	 */
	beforeToolCallFor?: (agentId: string) => ClownfishAgentOptions["beforeToolCall"];
	/**
	 * Parent's live conversation (read lazily at delegation time) — the source of
	 * the auto handoff digest. Optional: without it the sub simply starts blank.
	 */
	parentMessages?: () => AgentMessage[];
	/**
	 * Fired when an `async: true` (or user-detached) run finishes — the runtime
	 * injects the result into the calling agent as a message. Optional: without it
	 * a detached run still streams and persists, the result just goes nowhere.
	 */
	onAsyncDone?: (info: AsyncRunDone) => void;
	/**
	 * Register a running SYNC sub's detach trigger (user-initiated conversion to
	 * background mid-flight). Returns an unregister fn called when the run
	 * settles. Optional — without it there is nothing to detach.
	 */
	onDetachable?: (subId: string, fire: () => void) => () => void;
}


function textBlocks(m: AgentMessage): string {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return c.trim();
	if (!Array.isArray(c)) return "";
	return (c as Array<{ type?: string; text?: string }>)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n")
		.trim();
}

/**
 * A narrowed `cwd` must be a real directory INSIDE the parent workspace.
 * Containment is checked before existence, so a path that is both missing and
 * outside reads as "outside" — the model must not try to mkdir its way out.
 */
function resolveSubCwd(raw: string, parentCwd: string): { cwd?: string; error?: string } {
	const resolved = resolvePath(parentCwd, raw.trim());
	if (!isInsidePath(resolved, parentCwd)) {
		return { error: `cwd '${raw.trim()}' must be a directory inside your workspace (${parentCwd}).` };
	}
	let real: string;
	try {
		if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
		real = realpathSync(resolved);
	} catch {
		return { error: `cwd '${raw.trim()}' does not exist or is not a directory (resolved: ${resolved}).` };
	}
	if (!isInsidePath(real, realpathSync(parentCwd))) {
		return { error: `cwd '${raw.trim()}' must be a directory inside your workspace (${parentCwd}).` };
	}
	return { cwd: real };
}

/**
 * What the parent knows, condensed for a sub-agent that otherwise starts blank:
 * the user's own words (first and latest, never compressed) plus the parent's
 * last couple of conclusions, which the sub should verify rather than trust.
 */
function parentDigest(messages: AgentMessage[]): string {
	const users = messages.filter((m) => m.role === "user");
	const request = users.length ? textBlocks(users[0]).slice(0, 1000) : "";
	const latest = users.length > 1 ? textBlocks(users[users.length - 1]).slice(0, 1000) : "";
	const conclusions: string[] = [];
	for (let i = messages.length - 1; i >= 0 && conclusions.length < 2; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const t = textBlocks(m);
		if (t.length >= 40) conclusions.unshift(t.slice(0, 1200));
	}
	const parts: string[] = [];
	if (request) parts.push(`Original user request (verbatim):\n${request}`);
	if (latest && latest !== request) parts.push(`Latest user message (verbatim):\n${latest}`);
	if (conclusions.length)
		parts.push(
			`Parent agent's conclusions so far (claims to verify or build on; file state may have changed since):\n${conclusions.join("\n\n---\n\n")}`,
		);
	if (!parts.length) return "";
	return `--- Auto handoff digest (from the parent session; apart from this you start blank) ---\n${parts.join("\n\n")}`;
}

/** Outcome of a completed async run_agent — delivered to the calling agent. */
export interface AsyncRunDone {
	/** The run_agent tool call that started the background task. */
	toolCallId: string;
	/** The background sub-agent's id (matches its agent_spawned frame + transcript). */
	agentId: string;
	type: string;
	task: string;
	ok: boolean;
	result?: string;
	error?: string;
}

/** One-line preview of a tool call's most identifying argument, for the progress line. */
function argPreview(args: unknown): string {
	const a = args as Record<string, unknown> | null | undefined;
	if (!a || typeof a !== "object") return "";
	for (const key of ["path", "file", "command", "pattern", "type", "name"]) {
		const v = a[key];
		if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 60);
	}
	return "";
}

/** What one sub-agent run produced, in a shape the orchestration above can branch on. */
export interface SubRun {
	status: "ok" | "aborted" | "exhausted" | "failed";
	text: string;
	steps: number;
	/** True when the run used a tool that can change the workspace. */
	mutated: boolean;
	transcript?: string;
	limit?: string;
	error?: string;
}

/** Tools that can change the workspace — the trigger for the "auto" verify policy. */
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/** The verifier's brief: attack the change, and end on a machine-readable verdict. */
function verifyPrompt(task: string, context: string | undefined, report: string, criteria?: string): string {
	return (
		"An implementer was given the task below and reports it done. Verify that claim independently.\n\n" +
		`--- TASK ---\n${task}\n${context ? `\nContext given to it:\n${context}\n` : ""}--- END TASK ---\n\n` +
		// `until` criteria are the caller's OWN definition of done. They replace
		// the generic yardstick entirely: the caller wrote them for this run,
		// and the verifier must not substitute its own taste for them.
		(criteria
			? `--- ACCEPTANCE CRITERIA (your ONLY yardstick — judge against exactly these) ---\n${criteria}\n--- END CRITERIA ---\n\n`
			: "") +
		`--- ITS REPORT ---\n${report}\n--- END REPORT ---\n\n` +
		"Do not take the report at face value: run the checks yourself, and go after what its own testing could not see " +
		"(a probabilistic failure needs repetition, a boundary needs the parameter that reaches it, a refactor needs the " +
		"behaviour the tests do not pin down). If the task named a specific failure mode, demonstrate with your own probe " +
		"that it is gone.\n\n" +
		"End your reply with exactly one line:\n" +
		"VERDICT: PASS   — the task is genuinely done\n" +
		"VERDICT: FAIL   — it is not, followed by nothing else\n" +
		"Put the evidence above that line: what you ran, what you saw, and for a FAIL what specifically is still wrong."
	);
}

export function createRunAgentTool(deps: RunAgentToolDeps) {
	/** Delegatable = everything the orchestrator may pick (internal agents excluded). */
	const delegatable = (): AgentDefinition[] => deps.agents.filter((a) => !a.internal);
	const maxSteps = deps.maxSteps ?? SUBAGENT_MAX_STEPS;
	const timeoutMs = deps.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
	// Per-delegation counter: two "coding" sub-tasks in one session must not share
	// an id, or they collide in the provider's cache key and in the transcript name.
	let delegations = 0;
	/**
	 * Delegations currently running per working directory. A rollback restores the
	 * WHOLE tree, so doing it while a sibling delegation is working in the same
	 * directory would delete that sibling's work. Parallel fan-out into separate
	 * worktrees is unaffected — that is what the `cwd` parameter is for.
	 */
	const inFlight = new Map<string, number>();
	const enter = (dir: string): void => {
		inFlight.set(dir, (inFlight.get(dir) ?? 0) + 1);
	};
	const leave = (dir: string): void => {
		const n = (inFlight.get(dir) ?? 1) - 1;
		if (n > 0) inFlight.set(dir, n);
		else inFlight.delete(dir);
	};
	const aloneIn = (dir: string): boolean => (inFlight.get(dir) ?? 0) <= 1;

	/**
	 * Run one sub-agent to completion under the step and time budgets, streaming
	 * progress and recording its transcript. Never throws: every outcome — abort,
	 * budget exhaustion, provider failure — comes back as a {@link SubRun} so the
	 * caller can decide, rather than losing the partial work to an exception.
	 */
	async function runSub(opts: {
		def: AgentDefinition;
		workdir: string;
		prompt: string;
		/** Model/credentials for THIS sub-agent (default: the session's own). */
		runtime?: ResolvedRuntime;
		/** For a CLI-backed def: the model id passed through to the CLI verbatim. */
		model?: string;
		thinking?: ClownfishAgentOptions["thinkingLevel"];
		signal?: AbortSignal;
		onUpdate?: (partial: { content: [{ type: "text"; text: string }]; details: undefined }) => void;
		/** The sub-agent's bus id, as soon as it exists (drill link for the UI). */
		onSpawned?: (subId: string) => void;
		label: string;
	}): Promise<SubRun> {
		const { def, workdir, prompt, label } = opts;
		const runId = ++delegations;
		/**
		 * One id serves as the sub-agent's bus identity AND its transcript filename.
		 * Upstream used a random id for the bus; a readable `sub<n>-<type>` is just as
		 * unique within a session, keeps the transcript greppable, and stays distinct
		 * per delegation so two `coding` runs never collide in the provider cache.
		 */
		const subId = `sub${runId}-${def.name}`;
		// An external-CLI agent: same contract (budgets/abort/transcript/frames),
		// different executor — see cli-sub.ts. It emits its own spawn/ended frames.
		if (def.cli) {
			return runCliSub({
				def,
				workdir,
				instructions: renderPrompt(def.body, { ...deps.vars, cwd: workdir }),
				prompt,
				label,
				subId,
				parentAgentId: deps.agentId,
				model: opts.model,
				signal: opts.signal,
				onUpdate: opts.onUpdate,
				onSpawned: opts.onSpawned,
				onFrame: deps.onFrame,
				sessionsDir: deps.sessionsDir,
				sessionId: deps.sessionId,
				log: deps.log,
				maxSteps,
				timeoutMs,
			});
		}
		const subSessionId = deps.sessionId ? `${deps.sessionId}/${subId}` : undefined;
		deps.onFrame?.({ type: "agent_spawned", agentId: subId, parentAgentId: deps.agentId, kind: "dagSub", label: opts.label });
		opts.onSpawned?.(subId);
		const sub = new ClownfishAgent({
			cwd: workdir,
			runtime: opts.runtime ?? deps.runtime,
			skills: deps.skills,
			sessionId: subSessionId,
			// The prompt's `{cwd}` must name the tree the sub-agent actually works in.
			// The parent workspace stays the allowed ROOT even when `cwd` narrows the
			// sub: the jail lets it climb back up when its cwd proves too narrow, and
			// the instruction chain it loads runs root → cwd (narrowest wins).
			root: deps.cwd,
			baseSystemPrompt: renderPrompt(def.body, { ...deps.vars, cwd: workdir }),
			initialMessages: [],
			toolAccess: def.access ?? "RW",
			beforeToolCall: deps.beforeToolCallFor?.(subId) ?? deps.beforeToolCall,
			extraTools: deps.extraTools,
			toolOverrides: deps.toolOverrides,
			thinkingLevel: opts.thinking ?? deps.thinkingLevel,
		});

		const tx = deps.sessionsDir && deps.sessionId ? new SessionTranscript(deps.sessionsDir, deps.sessionId, subId) : undefined;
		let written = 0;
		let recording: Promise<void> = Promise.resolve();
		const record = (): void => {
			if (!tx) return;
			recording = recording
				.then(async () => {
					const pending = sub.state.messages.slice(written);
					if (pending.length === 0) return;
					written += pending.length;
					await tx.appendMessages(pending);
				})
				.catch(() => {
					/* a transcript write must never take down the delegation */
				});
		};

		let steps = 0;
		let mutated = false;
		let last = "starting";
		let exhausted: "steps" | "time" | undefined;
		const report = (): void =>
			opts.onUpdate?.({ content: [{ type: "text", text: `${label} · ${steps} step(s) · ${last}` }], details: undefined });

		sub.subscribe((event) => {
			// Forward every event under the sub-agent's own id: this is what nests it
			// in the activity tree and gives its bash tools their pid badges.
			deps.onFrame?.({ type: "event", event, agentId: subId });
			if (event.type === "tool_execution_start") {
				steps++;
				if (MUTATING_TOOLS.has(event.toolName)) mutated = true;
				const preview = argPreview(event.args);
				last = preview ? `${event.toolName}: ${preview}` : event.toolName;
				report();
				if (steps >= maxSteps) {
					exhausted = "steps";
					sub.abort();
				}
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				last = "thinking";
			} else if (event.type === "turn_end") {
				record();
			}
		});
		report();

		const deadline = setTimeout(() => {
			exhausted = "time";
			sub.abort();
		}, timeoutMs);
		const onAbort = (): void => sub.abort();
		if (opts.signal?.aborted) {
			clearTimeout(deadline);
			deps.onFrame?.({ type: "agent_ended", agentId: subId });
			return { status: "aborted", text: "", steps: 0, mutated: false };
		}
		opts.signal?.addEventListener("abort", onAbort);

		try {
			// Apart from this digest the sub starts blank; the user's own words and
			// the parent's latest conclusions are what it most often needs.
			const digest = parentDigest(deps.parentMessages?.() ?? []);
			await sub.prompt(digest ? `${prompt}\n\n${digest}` : prompt);
			record();
			await recording;
			if (tx) deps.log?.(`sub-agent ${label} (${steps} step(s)) → ${tx.path()}`);
			const text = lastAssistantText(sub.state.messages);
			if (exhausted) {
				const limit = exhausted === "steps" ? `${maxSteps}-step` : `${Math.round(timeoutMs / 60_000)}-minute`;
				return { status: "exhausted", text, steps, mutated, transcript: tx?.path(), limit };
			}
			if (opts.signal?.aborted) return { status: "aborted", text, steps, mutated, transcript: tx?.path() };
			return { status: "ok", text, steps, mutated, transcript: tx?.path() };
		} catch (err) {
			record();
			await recording;
			return {
				status: "failed",
				text: lastAssistantText(sub.state.messages),
				steps,
				mutated,
				transcript: tx?.path(),
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			clearTimeout(deadline);
			opts.signal?.removeEventListener("abort", onAbort);
			// Close the lifecycle on EVERY exit — ok, exhausted, aborted, failed.
			// A missing agent_ended leaves the activity tree showing a sub-agent that
			// is still working, which is worse than showing none at all.
			deps.onFrame?.({ type: "agent_ended", agentId: subId });
		}
	}

	const schema = buildRunAgentSchema(
		`The sub-agent type to run (its name) for a SINGLE delegation; omit when using \`tasks\`. Available agents:\n${agentsTypeList(deps.agents)}`,
	);

	const tool = defineTool<typeof schema, undefined>({
		...RUN_AGENT_TOOL_META,
		label: RUN_AGENT_NAME,
		parameters: schema,
		async execute(toolCallId, params, signal, onUpdate) {
			const { context, tasks, synthesize, until, todo, thinking, async: asyncMode } = params;
			const fail = (text: string): ToolText => ({ content: [{ type: "text", text }], details: undefined });

			// ---- 0. normalize the call into one or more strands ---------------
			// One tool, three shapes: a single delegation, a parallel fan-out
			// (`tasks`), and either of those held to acceptance criteria
			// (`until`). The shapes share every guardrail below — budgets,
			// verification, rollback, the ledger — so which one the model picks
			// changes the fan-out, never the safety net.
			const strandSpecs: Array<{ type: string; task: string; context?: string; cwd?: string; model?: string }> = [];
			if (tasks && tasks.length > 0) {
				if (params.type || params.task) {
					return fail("run_agent: pass either (type, task) for one delegation or `tasks` for a parallel fan-out — not both.");
				}
				strandSpecs.push(...tasks);
			} else if (params.type && params.task) {
				strandSpecs.push({ type: params.type, task: params.task, context, cwd: params.cwd, model: params.model });
			} else {
				return fail("run_agent: needs (type, task) for a single delegation, or `tasks` for a parallel fan-out.");
			}

			// Per-strand model override (same provider): explicit call param wins,
			// then the sub-agent type's own pinned model, else the session's.
			// Re-resolving is a pure in-memory lookup (no network) but is cached
			// per model id so N strands asking for the same override share one.
			const runtimeCache = new Map<string, ResolvedRuntime>();
			const resolveStrandRuntime = (modelId: string | undefined): { runtime: ResolvedRuntime } | { error: string } => {
				if (!modelId || modelId === deps.runtime.model.id) return { runtime: deps.runtime };
				if (!deps.baseProviderConfig) {
					return { error: `run_agent: this session cannot override the model per delegation (not configured) — omit \`model\` or ask the operator to enable it.` };
				}
				const cached = runtimeCache.get(modelId);
				if (cached) return { runtime: cached };
				try {
					const rt = resolveRuntime({ ...deps.baseProviderConfig, model: modelId });
					runtimeCache.set(modelId, rt);
					return { runtime: rt };
				} catch (err) {
					return { error: `run_agent: could not resolve model '${modelId}': ${err instanceof Error ? err.message : String(err)}` };
				}
			};

			// Internal agents (sys-compact and friends) are framework roles, not
			// delegation targets — they are hidden from the type list, so a call for
			// one is a mistake to correct rather than a request to honour.
			const strands: Array<{ def: AgentDefinition; workdir: string; spec: (typeof strandSpecs)[number]; runtime: ResolvedRuntime; model?: string }> = [];
			for (const spec of strandSpecs) {
				const def = delegatable().find((a) => a.name === spec.type);
				if (!def) {
					const available = delegatable().map((a) => a.name).join(", ") || "(none)";
					return fail(`Unknown agent type '${spec.type}'. Available: ${available}`);
				}
				// A narrowed cwd (a worktree) must be a real directory INSIDE the parent
				// workspace. Containment is checked before existence, so a path that is
				// both missing and outside reads as "outside" rather than inviting the
				// model to mkdir its way past the jail.
				let workdir = deps.cwd;
				if (spec.cwd?.trim()) {
					const r = resolveSubCwd(spec.cwd, deps.cwd);
					if (r.error || !r.cwd) return fail(`run_agent: ${r.error}`);
					workdir = r.cwd;
				}
				// A CLI-backed agent resolves no provider runtime at all — its
				// `model` rides through to the CLI verbatim (its own login and
				// catalog apply, not the session's provider).
				if (def.cli) {
					strands.push({ def, workdir, spec, runtime: deps.runtime, model: spec.model?.trim() || def.model });
					continue;
				}
				const rt = resolveStrandRuntime(spec.model?.trim() || def.model);
				if ("error" in rt) return fail(rt.error);
				strands.push({ def, workdir, spec, runtime: rt.runtime });
			}
			// Parallel write strands in ONE tree would interleave their edits and
			// break each other's rollback; say so instead of racing.
			const writers = strands.filter((s) => (s.def.access ?? "RW") !== "R");
			if (writers.length > 1 && new Set(writers.map((s) => s.workdir)).size < writers.length) {
				return fail(
					"run_agent: parallel strands that can write must not share a working tree — give each its own `cwd` (a git worktree under the project), or run them one at a time.",
				);
			}

			const criteria = until?.trim() || undefined;
			const maxRounds = criteria ? Math.min(Math.max(1, Math.floor(params.max_rounds ?? 3)), 10) : undefined;
			const headline = strands.length === 1 ? strands[0].spec.task : `${strands.length} parallel sub-tasks`;
			const ledgerId = deps.todos?.begin({
				id: todo,
				task: headline.length > 120 ? `${headline.slice(0, 117)}…` : headline,
				agent: strands.map((s) => s.spec.type).join("+"),
				cwd: strands[0].workdir === deps.cwd ? undefined : strands[0].workdir,
			});
			let settled = false;
			const settle = (status: "done" | "failed" | "stopped", note?: string): void => {
				if (settled) return;
				settled = true;
				if (ledgerId) deps.todos?.end(ledgerId, status, note);
			};

			// ---- progress -----------------------------------------------------
			// One snapshot for the whole call, one ROW per sub-agent this call
			// runs — strands of a fan-out, and the implement/verify/retry cycle
			// of an `until` run. The shape is the same the workflow engine emits,
			// so the existing progress card and drill-in view render it unchanged.
			// A plain single delegation keeps the bare one-line text it always had.
			const structured = strands.length > 1 || criteria !== undefined;
			const progress = {
				name: criteria
					? `until: ${criteria.split("\n")[0].slice(0, 60)}`
					: strands.length > 1
						? `${strands.length} 并行子任务`
						: strands[0].spec.type,
				phases: criteria
					? Array.from({ length: maxRounds! }, (_, i) => `round ${i + 1}`)
					: strands.length > 1
						? ["fan-out", ...(synthesize?.trim() ? ["synthesis"] : [])]
						: [],
				currentPhase: criteria ? "round 1" : strands.length > 1 ? "fan-out" : undefined,
				logs: [] as string[],
				agents: [] as Array<{ label: string; phase?: string; status: "running" | "done" | "error"; preview?: string; agentId?: string }>,
			};
			const renderProgress = (): string => {
				if (!structured) return progress.agents[0]?.preview ?? "";
				const done = progress.agents.filter((a) => a.status !== "running").length;
				const head = `${progress.name} (${done}/${progress.agents.length}${progress.currentPhase ? `, ${progress.currentPhase}` : ""})`;
				return [head, ...progress.agents.map((a) => `  ${a.status === "running" ? "…" : a.status === "done" ? "✓" : "✗"} ${a.label}${a.preview ? ` — ${a.preview}` : ""}`)].join("\n");
			};
			const emit = (): void =>
				onUpdate?.({
					content: [{ type: "text", text: renderProgress() }],
					details: (structured ? { ...progress, agents: progress.agents.map((a) => ({ ...a })) } : undefined) as undefined,
				});
			/** Register one sub-agent run as a progress row and return its hooks. */
			const track = (
				label: string,
				phase?: string,
			): { onUpdate: (p: { content: [{ type: "text"; text: string }]; details: undefined }) => void; onSpawned: (id: string) => void; done: (ok: boolean) => void } => {
				const i = progress.agents.push({ label, status: "running", ...(phase ? { phase } : {}) }) - 1;
				if (phase) progress.currentPhase = phase;
				emit();
				return {
					// runSub streams "<label> · N step(s) · <last tool>"; the row
					// already carries the label, so keep only what changes.
					onUpdate: (p) => {
						const text = p.content[0]?.text ?? "";
						progress.agents[i].preview = text.startsWith(`${label} · `) ? text.slice(label.length + 3) : text;
						emit();
					},
					onSpawned: (id) => {
						progress.agents[i].agentId = id;
						spawnedIds.push(id);
						emit();
					},
					done: (ok) => {
						progress.agents[i].status = ok ? "done" : "error";
						emit();
					},
				};
			};

			const label = strands.length === 1 ? `sub-${strands[0].spec.type}` : `sub-fanout-${strands.length}`;
			/** Real bus/transcript ids of the sub-agents this call spawned (first = the drill target). */
			const spawnedIds: string[] = [];

			/**
			 * Hand a still-running delegation to the background: settle it, release
			 * the workdir locks, and deliver the answer to the caller as a message.
			 * Shared by `async: true` and by a user-initiated mid-flight detach.
			 */
			const runInBackground = (work: Promise<ToolText>): void => {
				void (async () => {
					try {
						const out = await work;
						deps.onAsyncDone?.({ toolCallId, agentId: spawnedIds[0] ?? label, type: strands[0].spec.type, task: headline, ok: true, result: out.content[0]?.text ?? "" });
					} catch (err) {
						settle("failed", err instanceof Error ? err.message.slice(0, 200) : String(err));
						deps.onAsyncDone?.({ toolCallId, agentId: spawnedIds[0] ?? label, type: strands[0].spec.type, task: headline, ok: false, error: err instanceof Error ? err.message : String(err) });
					} finally {
						for (const s of lockers) leave(s.workdir);
					}
				})();
			};

			// Only WRITING strands hold the tree lock: the lock exists to protect a
			// rollback from destroying a sibling's edits, and read-only strands
			// have none — counting them was measured to silently disable the
			// rollback of an `until` run that fanned out beside a reviewer.
			const lockers = strands.filter((s) => (s.def.access ?? "RW") !== "R");
			for (const s of lockers) enter(s.workdir);
			if (asyncMode) {
				// Background mode: resolve NOW; the delegation keeps running detached
				// from this turn (an abort of the turn deliberately does not touch it).
				// It still gets the full orchestration — budgets, verification, ledger —
				// because nothing about running detached makes those less useful.
				runInBackground(runAll());
				return fail(
					`Background sub-agent(s) started: ${headline.slice(0, 120)}${headline.length > 120 ? "…" : ""}\n` +
						"They keep running after this call returns — do not wait or poll. The result will be delivered to you as an [async-agent] message when it completes.",
				);
			}

			// SYNC mode: block on the run, but stay detachable. Only the USER can
			// convert it (the model is parked awaiting this very result).
			let detachFire: (() => void) | undefined;
			let detached = false;
			const detachGate = new Promise<void>((r) => (detachFire = r));
			const unregister = deps.onDetachable?.(label, () => {
				detached = true;
				detachFire?.();
			});
			try {
				const work = runAll();
				const winner = await Promise.race([
					work.then((out) => ({ detached: false as const, out })),
					detachGate.then(() => ({ detached: true as const, out: undefined })),
				]);
				if (winner.detached) {
					runInBackground(work);
					return fail(
						"The sub-agent(s) were moved to the background by the user — they keep running. The result will arrive as an [async-agent] message when it completes; do not wait or re-run the task.",
					);
				}
				return winner.out!;
			} catch (err) {
				// A throw out of runAll (a snapshot failure once was one) must not
				// leave the plan claiming the delegation still runs.
				settle("failed", err instanceof Error ? err.message.slice(0, 200) : String(err));
				throw err;
			} finally {
				unregister?.();
				// A detached run releases the workdir locks in its own background tail.
				if (!detached) for (const s of lockers) leave(s.workdir);
			}

			/** One strand, or a parallel fan-out plus its optional synthesis pass. */
			async function runAll(): Promise<ToolText> {
				if (strands.length === 1) {
					const out = await delegateOne(strands[0]);
					settle(out.ok ? "done" : out.stopped ? "stopped" : "failed", out.note);
					return { content: [{ type: "text", text: out.text }], details: undefined };
				}
				const outs = await Promise.all(strands.map((s) => delegateOne(s)));
				const combined = outs
					.map((o, i) => `## ${i + 1}. ${strands[i].spec.type} — ${strands[i].spec.task.split("\n")[0].slice(0, 100)}\n\n${o.text}`)
					.join("\n\n---\n\n");
				const failures = outs.filter((o) => !o.ok).length;
				const stoppedAll = failures > 0 && outs.filter((o) => !o.ok).every((o) => o.stopped);
				const banner = failures ? `${outs.length - failures}/${outs.length} strands completed; ${failures} did not.\n\n` : "";
				if (!synthesize?.trim()) {
					settle(failures ? (stoppedAll ? "stopped" : "failed") : "done", failures ? `${failures} strand(s) did not finish` : undefined);
					return { content: [{ type: "text", text: banner + combined }], details: undefined };
				}
				// The synthesis runs as the FIRST strand's persona — the fan-out is
				// normally one kind of work, and asking the model for a separate
				// synthesis type would be one more decision for no gain.
				const synTrack = track("synthesis", "synthesis");
				const syn = await runSub({
					def: strands[0].def,
					workdir: deps.cwd,
					prompt: `${synthesize.trim()}\n\nCombine the results of ${outs.length} parallel sub-tasks below into ONE answer. Work only from what they report.\n\n${combined}`,
					runtime: strands[0].runtime,
					model: strands[0].model,
					thinking,
					signal,
					onUpdate: synTrack.onUpdate,
					onSpawned: synTrack.onSpawned,
					label: "synthesis",
				});
				synTrack.done(syn.status === "ok");
				settle(failures ? (stoppedAll ? "stopped" : "failed") : "done", failures ? `${failures} strand(s) did not finish` : undefined);
				// The strand results are already in hand, so a synthesis that did not
				// complete — or completed with nothing to say — must fall back to
				// them. Returning the synthesizer's empty string instead would throw
				// away every strand's work and hand the caller a blank result.
				if (syn.status !== "ok" || !syn.text.trim()) {
					const why = syn.status !== "ok" ? `did not complete (${syn.status})` : "produced no text";
					return {
						content: [{ type: "text", text: `${banner}The synthesis pass ${why}; the raw strand results follow.\n\n${combined}` }],
						details: undefined,
					};
				}
				return { content: [{ type: "text", text: banner + syn.text }], details: undefined };
			}

			/** implement → verify → (rollback) → retry, for ONE strand. */
			async function delegateOne(strand: {
				def: AgentDefinition;
				workdir: string;
				spec: { type: string; task: string; context?: string };
				runtime: ResolvedRuntime;
				/** CLI-backed strand: the model id passed to the CLI verbatim. */
				model?: string;
			}): Promise<{ text: string; ok: boolean; stopped?: boolean; note?: string }> {
			const { def: agentDef, workdir } = strand;
			const { type, task } = strand.spec;
			const ctx = strand.spec.context;
			const prompt = ctx && ctx.trim() ? `${task}\n\nContext:\n${ctx}` : task;
			const policy = deps.verify ?? verifyPolicy();
			// `until` states what "done" means, so it is verified whatever the
			// policy says, and its retry budget is the caller's round count.
			const retries = criteria ? maxRounds! - 1 : (deps.verifyRetries ?? VERIFY_RETRIES);
			const notes: string[] = [];
			const finish = (text: string, ok: boolean, extra?: { stopped?: boolean; note?: string }): { text: string; ok: boolean; stopped?: boolean; note?: string } => ({
				text: notes.length ? `${text}\n\n---\n${notes.join("\n")}` : text,
				ok,
				...extra,
			});

			// ---- 1. implement -------------------------------------------------
			const implTrack = track(type, criteria ? "round 1" : undefined);
			let run = await runSub({ def: agentDef, workdir, prompt, runtime: strand.runtime, model: strand.model, thinking, signal, onUpdate: implTrack.onUpdate, onSpawned: implTrack.onSpawned, label: type });
			implTrack.done(run.status === "ok");
			if (run.status === "aborted") {
				return finish(`Sub-agent '${type}' was aborted after ${run.steps} step(s).${run.text ? `\n\nPartial output:\n${run.text}` : ""}`, false, { stopped: true, note: `aborted after ${run.steps} step(s)` });
			}
			if (run.status === "exhausted") {
				return finish(
					`Sub-agent '${type}' was stopped after reaching its ${run.limit} budget (${run.steps} step(s) run). It did NOT finish the task.` +
						`${run.text ? `\n\nIts last output:\n${run.text}` : ""}` +
						"\n\nDelegate a narrower follow-up (or take the remaining work yourself) rather than assuming this is done.",
					false,
					{ stopped: true, note: `${run.limit} budget after ${run.steps} step(s)` },
				);
			}
			if (run.status === "failed") {
				return finish(`Sub-agent '${type}' failed: ${run.error}`, false, { note: run.error?.slice(0, 200) });
			}
			if (ledgerId && strands.length === 1) deps.todos?.begin({ id: ledgerId, task: "", agent: type, transcript: run.transcript });

			// ---- 2. verify ----------------------------------------------------
			const verifier = deps.agents.find((a) => a.name === VERIFY_AGENT && !a.internal);
			const shouldVerify =
				verifier !== undefined && type !== VERIFY_AGENT && (criteria !== undefined || policy === "always" || (policy === "auto" && run.mutated));
			if (!shouldVerify || !verifier) {
				return finish(run.text || "(sub-agent produced no text output)", true);
			}

			const verifierDef: AgentDefinition = verifier;
			let implementation = run;
			let lastFailText: string | undefined;
			for (let attempt = 0; attempt <= retries; attempt++) {
				// Snapshot BEFORE the verifier runs, so a retry can be rolled back to
				// the state this attempt produced rather than to some later mixture.
				// Skipped when a sibling delegation shares this tree: restoring the whole
				// workspace would take its work with it.
				const canRollback = rollbackEnabled() && attempt < retries && aloneIn(workdir);
				// The copy-mode snapshot must live OUTSIDE the tree being copied —
				// fs.cp refuses to copy a directory into itself (measured:
				// ERR_FS_CP_EINVAL killed the whole delegation on any non-git
				// workspace). And a snapshot failure means "no rollback", never
				// "no delegation".
				const snap = canRollback
					? await snapshotWorkspace(workdir, join(tmpdir(), `clownfish-rollback-${deps.sessionId?.replace(/[^\w.-]/g, "_") ?? "s"}-${Date.now()}`)).catch(() => null)
					: null;
				const round = criteria ? ` round ${attempt + 1}/${retries + 1}` : "";
				const verifyTrack = track(`${VERIFY_AGENT}(verify)`, criteria ? `round ${attempt + 1}` : undefined);
				const verdict = await runSub({
					def: verifierDef,
					workdir,
					prompt: verifyPrompt(task, ctx, implementation.text, criteria),
					// Same runtime as the implementer: verification for THIS strand
					// stays on whatever model this unit of work was assigned to.
					runtime: strand.runtime,
					// The verifier inherits the delegation's reasoning level: if the work
					// needed deliberation, so does judging it.
					thinking,
					signal,
					onUpdate: verifyTrack.onUpdate,
					onSpawned: verifyTrack.onSpawned,
					label: `${VERIFY_AGENT}(verify)${round}`,
				});
				verifyTrack.done(verdict.status === "ok");
				if (verdict.status !== "ok") {
					// A verifier that could not finish is not a failing verdict — say so
					// and hand back the implementation rather than inventing a result.
					notes.push(`[verify] the verification pass did not complete (${verdict.status}); this result is UNVERIFIED.`);
					break;
				}
				const failed = VERDICT_RE.exec(verdict.text)?.[1]?.toUpperCase() === "FAIL";
				if (!failed) {
					notes.push(
						VERDICT_RE.test(verdict.text)
							? `[verify] independent verification by ${VERIFY_AGENT}${criteria ? " against your acceptance criteria" : ""}: PASS${criteria ? ` (round ${attempt + 1})` : ""}.`
							: `[verify] ${VERIFY_AGENT} returned no explicit verdict; treated as pass. Its report:\n${verdict.text.slice(0, 600)}`,
					);
					break;
				}
				notes.push(`[verify] ${VERIFY_AGENT} found the work incomplete${criteria ? ` (round ${attempt + 1}/${retries + 1})` : ""}:\n${verdict.text.slice(0, 1200)}`);
				// Stall guard (from the goal loop): an unchanged verdict means the
				// retry achieved nothing, so further rounds just burn tokens.
				if (criteria && lastFailText !== undefined && lastFailText.trim() === verdict.text.trim()) {
					return finish(
						`Sub-agent '${type}' stopped making progress: the verifier returned the SAME findings twice, so the remaining rounds were skipped.\n\nIts last report:\n${implementation.text}`,
						false,
						{ note: "stalled (verdict unchanged)" },
					);
				}
				lastFailText = verdict.text;
				if (attempt === retries) {
					return finish(
						criteria
							? `Sub-agent '${type}' did not meet the acceptance criteria within ${retries + 1} round(s).\n\nIts last report:\n${implementation.text}`
							: `Sub-agent '${type}' reported success, but the verification pass FAILED and the retry budget is spent.\n\n` +
									`Its report:\n${implementation.text}`,
						false,
						{ note: "verification failed" },
					);
				}
				if (snap) {
					// A rollback restores the WHOLE tree. Anything else that was writing
					// into it — a parallel delegation, the user's own editor, a watcher
					// mid-write — loses that work, and it is not recoverable from here.
					// The operator is told before and after, not left to infer it.
					const blastRadius =
						`回滚将把整个工作区 ${workdir} 恢复到本次委派之前的状态：` +
						`此刻在同一棵树里的任何并行改动（其它委派、你自己的编辑、正在写入的进程）都会一并丢失。` +
						`并行任务请给每条支线单独的 git worktree，并用 run_agent 的 cwd 参数指过去。`;
					deps.warn?.(`⚠️ ${blastRadius}`);
					const restored = await restoreWorkspace(snap);
					if (snap.mode === "copy") await rm(snap.dir, { recursive: true, force: true }).catch(() => {});
					deps.warn?.(
						restored
							? `⚠️ 已回滚整个工作区 ${workdir}（${snap.mode === "git" ? "git 快照" : "整树副本"}）。`
							: `⚠️ 回滚失败，工作区仍是被否决的那次尝试的状态：${workdir}`,
					);
					notes.push(
						restored
							? `[verify] 整个工作区已回滚到本次委派之前的状态。${blastRadius}`
							: "[verify] 回滚失败；将在当前状态上向前重试。",
					);
				} else if (rollbackEnabled() && attempt < retries) {
					// Say WHY it was skipped: silently retrying forward on top of a
					// rejected attempt looks the same as a rollback that worked.
					const why = aloneIn(workdir)
						? "该工作区无法被精确快照（不是 git 仓库，且体积超过复制上限）"
						: `同一棵树 ${workdir} 里还有其它委派在跑，整树回滚会毁掉它们的成果`;
					deps.warn?.(`⚠️ 跳过回滚（${why}），改为在当前状态上向前重试。`);
					notes.push(`[verify] 跳过了回滚（${why}），这次重试是在被否决的改动之上继续的。`);
				}
				// ---- 3. retry with the findings -------------------------------
				const retryTrack = track(`${type}(retry)`, criteria ? `round ${attempt + 2}` : undefined);
				implementation = await runSub({
					def: agentDef,
					workdir,
					prompt:
						`${prompt}\n\nA previous attempt at this task was rejected by an independent verifier. ` +
						`${snap ? "The workspace has been rolled back to its state before that attempt. " : "Its changes are still in the workspace. "}` +
						`Fix what the verifier found; do not merely re-run the tests it says are insufficient.\n\nVerifier report:\n${verdict.text.slice(0, 2000)}`,
					runtime: strand.runtime,
					model: strand.model,
					thinking,
					signal,
					onUpdate: retryTrack.onUpdate,
					onSpawned: retryTrack.onSpawned,
					label: `${type}(retry${round})`,
				});
				retryTrack.done(implementation.status === "ok");
				if (implementation.status !== "ok") {
					return finish(`The retry after a failed verification did not complete (${implementation.status}).${implementation.text ? `\n\n${implementation.text}` : ""}`, false, { note: `retry ${implementation.status}` });
				}
			}

			return finish(implementation.text || "(sub-agent produced no text output)", true);
			}
		}
	});

	/**
	 * The same independent verification, for work the orchestrator did ITSELF.
	 *
	 * The framework-run `qa` pass above exists because a model that is told
	 * delegation is expensive will not spend a delegation on verifying — measured,
	 * not assumed. But it was only ever wired into the delegation path, so a turn
	 * the orchestrator handled alone went out unverified, which is the far more
	 * common shape: on the phase-4 benchmark the orchestrator solved all three
	 * tasks itself in 12-14 tool calls and never delegated once, so nothing was
	 * checked. This closes that path with the same verifier and the same verdict
	 * contract.
	 */
	async function verifyTurn(opts: {
		task: string;
		answer: string;
		signal?: AbortSignal;
	}): Promise<{ verdict: "pass" | "fail" | "unverified"; text: string }> {
		const verifier = deps.agents.find((a) => a.name === VERIFY_AGENT && !a.internal);
		if (!verifier) return { verdict: "unverified", text: `no '${VERIFY_AGENT}' agent is available` };
		const run = await runSub({
			def: verifier,
			workdir: deps.cwd,
			prompt: verifyPrompt(opts.task, undefined, opts.answer),
			signal: opts.signal,
			label: `${VERIFY_AGENT}(turn)`,
		});
		if (run.status !== "ok") return { verdict: "unverified", text: `the verification pass did not complete (${run.status})` };
		const matched = VERDICT_RE.exec(run.text)?.[1]?.toUpperCase();
		// No explicit verdict is treated as a pass, exactly as in the delegation
		// path: an unparseable reply must not manufacture a failure.
		return { verdict: matched === "FAIL" ? "fail" : "pass", text: run.text };
	}

	return { tool, verifyTurn };
}
