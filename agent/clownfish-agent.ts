/**
 * ClownfishAgent — extends pi-agent-core's {@link Agent}.
 *
 * Per the project constraint, we use ONLY pi's basic agent loop. This subclass
 * is responsible for:
 *   - assembling the system prompt (persona + tool guidelines + skill index),
 *   - wiring the coding tools + the model-driven `skill` tool,
 *   - forwarding the multi-provider runtime (model / streamFn / getApiKey),
 *   - exposing `beforeToolCall` / `afterToolCall` hooks (full-auto in v1: no
 *     hook means every call is allowed; a future approval flow plugs in here).
 *
 * Session persistence, realtime forwarding, and history preload are driven by
 * the caller (backend) through the inherited {@link Agent.subscribe},
 * {@link Agent.state}, and {@link Agent.prompt} APIs.
 */
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Skill } from "./skills";
import { createSkillTool } from "./skills";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodingToolDefinitions, toAgentTools, filterByAccess, type JailContext, type ToolDefinition, type ToolAccess } from "./tools";
import { applyToolOverrides, type ToolOverrideMap } from "./tools/overrides";
import type { ResolvedRuntime } from "./models";
import { assembleSystemPrompt } from "./system-prompt";
import { instructionChainBlock } from "./agents/loader";
import { convertToLlm } from "./convert-to-llm";

export interface ClownfishAgentOptions {
	/** Workspace root the coding tools operate in (their cwd). */
	cwd: string;
	/** Resolved provider runtime (model + streamFn + optional getApiKey). */
	runtime: ResolvedRuntime;
	/** Coding tool definitions (default: full 7-tool set bound to cwd). */
	toolDefs?: ToolDefinition[];
	/**
	 * Consent callback for outside-workspace paths: structured tools park on a
	 * user approval before touching any path outside cwd (session-data roots
	 * stay refused regardless — see agent/tools/fs-jail.ts). Omit for the
	 * strict default (all outside paths refused).
	 */
	jailApproval?: JailContext["approval"];
	/**
	 * Workspace root containing cwd (default: cwd itself — the main agent is
	 * its own root). Two roles: it widens the jail (file tools may climb up to
	 * the root without consent — a run_agent sub-agent gets a narrowed cwd
	 * plus the parent's workspace as root, see agent/tools/fs-jail.ts), and it
	 * bounds the project-instruction chain: the agent itself loads the
	 * CLAUDE.md/AGENT.md of every directory from the root down to its cwd at
	 * init (root first, cwd last — the narrowest file overrides). Nothing is
	 * passed between agents.
	 */
	root?: string;
	/** Discovered skills (drive the skill tool + system-prompt index). */
	skills?: Skill[];
	/** Base system prompt (default: Clownfish persona from ./system-prompt). */
	baseSystemPrompt?: string;
	/** Reasoning level for future turns (default: "off"). */
	thinkingLevel?: ThinkingLevel;
	/** Preloaded transcript for session resume. */
	initialMessages?: AgentMessage[];
	/** Stable session id forwarded to providers for cache-aware backends. */
	sessionId?: string;
	/** Hook fired before each tool call; return { block: true } to deny. Omit for full-auto. */
	beforeToolCall?: AgentOptions["beforeToolCall"];
	/** Hook fired after each tool call; may override the result. */
	afterToolCall?: AgentOptions["afterToolCall"];
	/** Optional event sink (in addition to inherited .subscribe). */
	onEvent?: (event: AgentEvent) => void;
	/** Additional tools beyond the coding set + skill tool (e.g. run_agent for the top-level agent). */
	extraTools?: ToolDefinition[];
	/** Tool access policy: "R" = read-only tools only, "RW" = all (default). */
	toolAccess?: ToolAccess;
	/** Tool names to drop entirely (admin registry disables) — coding, skill, extra. */
	disableTools?: string[];
	/**
	 * Operator edits of the tools' model-facing text (description / snippet /
	 * guidelines), from `<dataDir>/tool_overwrite`. Applied to every tool — coding,
	 * skill, run_agent and MCP alike — so the settings page and the model agree.
	 */
	toolOverrides?: ToolOverrideMap;
	/**
	 * Run budget guard (cost ceiling per prompt() run): the loop stops after the
	 * Nth LLM turn or when cumulative output tokens exceed the cap — whichever
	 * comes first. Guards against a runaway agent (endless tool-call chains)
	 * burning tokens. Defaults: {@link DEFAULT_MAX_TURNS_PER_RUN} turns, no
	 * token cap. Reset at every agent_start; NOT carried across runs.
	 */
	budget?: { maxTurns?: number; maxOutputTokens?: number };
}

/** Default turn cap for one prompt() run (a healthy agent loop rarely exceeds this). */
export const DEFAULT_MAX_TURNS_PER_RUN = 60;

export class ClownfishAgent extends Agent {
	/** Working directory — relative paths resolve here, searches start here. */
	readonly cwd: string;
	/** Allowed-area root containing cwd (=== cwd for a main agent; a sub-agent's cwd may be a subdir of it). */
	readonly root: string;
	/** All tool definitions in use (coding tools + skill tool). */
	readonly toolDefs: ToolDefinition[];
	/** Skills available to the model-driven skill tool. */
	readonly skills: Skill[];
	/** Resolved provider runtime (retained for one-shot {@link tmpLLM} side calls). */
	private readonly rt: ResolvedRuntime;

	constructor(opts: ClownfishAgentOptions) {
		const root = opts.root ?? opts.cwd;
		const toolDefs =
			opts.toolDefs ??
			createCodingToolDefinitions(
				opts.cwd,
				opts.jailApproval || root !== opts.cwd ? { jailApproval: opts.jailApproval, root } : undefined,
			);
		const skills = opts.skills ?? [];
		const skillDef = createSkillTool(() => skills);
		const off = new Set(opts.disableTools ?? []);
		const allDefs: ToolDefinition[] = applyToolOverrides(
			[...toolDefs, skillDef, ...(opts.extraTools ?? [])].filter((d) => !off.has(d.name)),
			opts.toolOverrides,
		);
		// Apply the access policy (read-only / plan mode drops write-capable tools).
		const allowed = filterByAccess(allDefs, opts.toolAccess ?? "RW");

		const systemPrompt = assembleSystemPrompt({
			base: opts.baseSystemPrompt,
			toolDefs: allowed,
			skills,
			cwd: opts.cwd,
			root,
			// The agent loads its own instruction chain (root → cwd) at init.
			instructions: instructionChainBlock(opts.cwd, root),
		});

		// Debug knob: CLOWNFISH_DUMP_PROMPT=<dir> writes exactly what the first
		// request carries — the assembled system prompt and every tool's schema —
		// and logs a size breakdown. Answers "why is my first turn 8k tokens?".
		dumpPrompt(systemPrompt, allowed, opts.sessionId);

		super({
			initialState: {
				systemPrompt,
				model: opts.runtime.model,
				tools: toAgentTools(allowed),
				thinkingLevel: opts.thinkingLevel ?? "off",
				messages: opts.initialMessages ?? [],
			},
			streamFn: opts.runtime.streamFn,
			convertToLlm,
			getApiKey: opts.runtime.getApiKey,
			sessionId: opts.sessionId,
			beforeToolCall: opts.beforeToolCall,
			afterToolCall: opts.afterToolCall,
			toolExecution: "parallel",
		});

		this.cwd = opts.cwd;
		this.root = root;
		this.toolDefs = allowed;
		this.skills = skills;
		this.rt = opts.runtime;

		// Budget guard: pi's loop has NO built-in exit condition beyond
		// "no more tool calls" — a runaway agent streams turns forever. We hook
		// finishTurn (called once per LLM turn) and count turns + output
		// tokens per run (reset on agent_start). Stopping is graceful: the loop
		// emits agent_end normally, and we append a notice the model (and the
		// user) will see, so a coordinating parent can react instead of hang.
		const budget = opts.budget ?? { maxTurns: DEFAULT_MAX_TURNS_PER_RUN };
		let turns = 0;
		let outputTokens = 0;
		let stopReason = "";
		this.subscribe((event) => {
			if (event.type === "agent_start") {
				turns = 0;
				outputTokens = 0;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				turns += 1;
				outputTokens += event.message.usage?.output ?? 0;
			}
		});
		const userStop = opts.onEvent;
		this.finishTurn = async (turn) => {
			if (budget.maxTurns !== undefined && turns >= budget.maxTurns) {
				stopReason = `turn budget reached (${turns} turns)`;
			} else if (budget.maxOutputTokens !== undefined && outputTokens >= budget.maxOutputTokens) {
				stopReason = `output token budget reached (${outputTokens} tokens)`;
			} else {
				return undefined;
			}
			this.state.messages = [
				...turn.context.messages,
				{
					role: "user",
					content: [{ type: "text", text: `[budget stop] ${stopReason} — the run was cut short to cap cost. Wrap up now with what you have.` }],
				} as AgentMessage,
			];
			void userStop;
			return { action: "end" };
		};

		if (opts.onEvent) {
			const onEvent = opts.onEvent;
			this.subscribe((event) => onEvent(event));
		}
	}

	/** Replace the transcript (e.g. when reloading a session). */
	loadHistory(messages: AgentMessage[]): void {
		this.state.messages = messages;
	}

	/**
	 * One-shot side-channel LLM call (`tmpLLM`) on this agent's runtime — same
	 * provider, base URL, and credentials as the agent loop, but no tool loop,
	 * no event stream, and NO mutation of `state.messages` (the call is
	 * invisible to the transcript). With `opts.context` the agent's current
	 * conversation is prefixed (converted through the same strip rules the loop
	 * uses); without it the call sees only `prompt`. Throws on provider error
	 * or abort — callers decide whether that is fatal (a workflow's `llm()`
	 * global fails soft to null instead).
	 */
	async tmpLLM(
		prompt: string,
		opts: { context?: boolean; systemPrompt?: string; maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string> {
		const history = opts.context ? convertToLlm(this.state.messages) : [];
		const apiKey = await this.rt.getApiKey?.(this.rt.model.provider);
		const stream = await Promise.resolve(
			this.rt.streamFn(
				this.rt.model,
				normalizeContext({
					systemPrompt: opts.systemPrompt,
					messages: [...history, { role: "user", content: prompt, timestamp: Date.now() }],
				}),
				{ apiKey, maxTokens: opts.maxTokens, signal: opts.signal },
			),
		);
		const final = await stream.result();
		if (final.stopReason === "error" || final.stopReason === "aborted") {
			throw new Error(`tmpLLM failed: ${final.errorMessage ?? final.stopReason}`);
		}
		const text = final.content.find((c) => c.type === "text") as { text?: string } | undefined;
		return text?.text ?? "";
	}
}

/** ~3.6 chars/token for English prose + JSON; Chinese runs closer to 1.5. */
function estTokens(s: string): number {
	return Math.round(s.length / 3.6);
}

function dumpPrompt(systemPrompt: string, tools: ToolDefinition[], sessionId?: string): void {
	const dir = process.env.CLOWNFISH_DUMP_PROMPT?.trim();
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		const tag = (sessionId ?? "agent").replace(/[^\w.-]/g, "_");
		const schemas = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		writeFileSync(join(dir, `${tag}.system.md`), systemPrompt);
		writeFileSync(join(dir, `${tag}.tools.json`), JSON.stringify(schemas, null, 2));
		const lines = [
			`[prompt-dump] ${tag}: system prompt ${systemPrompt.length} chars (~${estTokens(systemPrompt)} tok), ${tools.length} tools ~${estTokens(JSON.stringify(schemas))} tok`,
			...schemas.map((s) => `  ${String(estTokens(JSON.stringify(s))).padStart(5)}  ${s.name}`),
		];
		console.error(lines.join("\n"));
	} catch (err) {
		console.error(`[prompt-dump] failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
