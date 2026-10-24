/**
 * workflow tool — deterministic script orchestration over clownfish agents.
 *
 * The model writes a small JavaScript workflow script (meta header +
 * `agent()/llm()/parallel()/pipeline()/phase()/log()/budget` globals); the
 * vendored engine in ./workflow-engine.ts runs it in a `node:vm` sandbox. The
 * engine itself NEVER touches an LLM: both script globals that need a model
 * are host-injected through this tool —
 *
 *   - `agent(prompt, {label, schema, agentType})` spawns an in-process
 *     {@link ClownfishAgent} sub-agent exactly the run_agent way: shared
 *     runtime (same credentials), fs-jail rooted at the session workspace,
 *     `agent_spawned`/`agent_ended` frames on the session bus (nested under
 *     the workflow's own agent), transcript persisted per sub-agent, optional
 *     persona (`agentType`) and optional schema-validated structured output
 *     (terminating `structured_output` tool).
 *   - `llm(prompt, {context})` is a one-shot {@link ClownfishAgent.tmpLLM}
 *     side call — no tool loop, no transcript. With `context: true` the call
 *     rides (and extends) the workflow agent's own separate context.
 *
 * Per run, ONE dedicated workflow agent (own context + transcript, empty
 * tools — a pure anchor/identity) is spawned as `kind: "wfRoot"` — the UI's
 * activity tree folds it into the calling agent's row and nests the run's
 * sub-agents directly beneath it. It is created LAZILY, at the first
 * `agent()`/`llm()` call: a script that never reaches an LLM boundary
 * (validation throw, pre-abort, log()/phase()-only) spawns no agent at all.
 * Execution is synchronous: the calling agent's turn blocks until the script
 * returns (progress streams via tool updates); abort propagates through the
 * engine's signal checks into every live sub-agent.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "./definition";
import { runWorkflow, parseWorkflowScript, type WorkflowAgentRunOptions, type WorkflowLlmOptions } from "./workflow-engine";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output";
import { ClownfishAgent, type ClownfishAgentOptions } from "../clownfish-agent";
import { generateId } from "../id";
import { SessionTranscript } from "../transcript";
import { lastAssistantText } from "../agents/run-outcome";
import { renderPrompt } from "../agents/loader";
import type { AgentDefinition, AgentPromptVars } from "../agents/types";
import type { Skill } from "../skills";
import type { ResolvedRuntime } from "../models";
import type { WorkerFrame } from "../protocol";

export interface WorkflowToolDeps {
	/** All discovered agents (an `agentType` option is matched against `name`). */
	agents: AgentDefinition[];
	/** Provider runtime shared with the caller (same model/credentials). */
	runtime: ResolvedRuntime;
	/** The session workspace — jail root for every workflow sub-agent. */
	cwd: string;
	/** Skills shared with sub-agents. */
	skills: Skill[];
	/** Prompt vars for rendering persona templates. */
	vars: AgentPromptVars;
	/** Parent session id (transcripts persist under `<sessionId>/<id>.jsonl`). */
	sessionId?: string;
	/** Sessions dir (transcript root; required when sessionId is set). */
	sessionsDir?: string;
	/** The CALLING agent's id (the workflow root's parent on the bus). */
	agentId: string;
	/** Emit a worker frame to the session bus. */
	onFrame: (frame: WorkerFrame) => void;
	/** Inherited tool-call hook (approval gate). */
	beforeToolCall?: ClownfishAgentOptions["beforeToolCall"];
	/** Per-agent hook variant (approval attribution for spawned agents). */
	beforeToolCallFor?: (agentId: string) => ClownfishAgentOptions["beforeToolCall"];
}

const WORKFLOW_ROOT_PERSONA = [
	"You anchor one deterministic workflow run: a script orchestrates sub-agents and one-shot LLM calls, and this agent's context is the workflow's own separate scratch context.",
	"Context-mode llm() calls in the script see your conversation; everything else (sub-agents, plain llm() calls) is stateless toward you.",
	"You never run a tool loop yourself — you exist to give the run an identity, a context, and a transcript.",
].join("\n");

const WORKFLOW_SUB_PERSONA = [
	"You are a workflow sub-agent executing exactly one well-scoped step of a larger deterministic workflow.",
	"The script author gave you a self-contained prompt; do the step with the coding tools, then report the result concisely.",
	"You do not share any conversation history with the caller — state your findings, not your reasoning process.",
].join("\n");

/** Streaming progress for the UI (and the tool's own final details). */
interface WorkflowProgress {
	name: string;
	phases: string[];
	currentPhase?: string;
	logs: string[];
	agents: Array<{ label: string; phase?: string; status: "running" | "done" | "error"; preview?: string }>;
}

/** Machine-readable run record appended to the anchor transcript at run end —
 *  the durable twin of the live agent_spawned frames. A reloaded tab rebuilds
 *  the whole WorkflowView (steps + sub-agent links) from it via REST. */
interface WorkflowRunRecord {
	toolCallId: string;
	progress: WorkflowProgress;
	subs: Array<{ id: string; label: string; name?: string }>;
}

const RUN_RECORD_PREFIX = "[clownfish:workflow-run] ";

function renderProgress(p: WorkflowProgress): string {
	const done = p.agents.filter((a) => a.status !== "running").length;
	const lines = [`workflow ${p.name} (${done}/${p.agents.length} agents${p.currentPhase ? `, phase: ${p.currentPhase}` : ""})`];
	for (const a of p.agents) {
		const mark = a.status === "running" ? "…" : a.status === "done" ? "✓" : "✗";
		lines.push(`  ${mark} ${a.label}${a.phase ? ` [${a.phase}]` : ""}${a.preview ? ` — ${a.preview}` : ""}`);
	}
	for (const l of p.logs.slice(-5)) lines.push(`  · ${l}`);
	return lines.join("\n");
}

/** Steps table for the final result text — the durable trace of the run: the
 *  REST history a reloaded session shows carries text only (not the structured
 *  progress frames), so the persisted result must embed its own step list. */
function renderSteps(p: WorkflowProgress): string {
	return p.agents
		.map((a) => `  ${a.status === "running" ? "…" : a.status === "done" ? "✓" : "✗"} ${a.label}${a.phase ? ` [${a.phase}]` : ""}${a.preview ? ` — ${a.preview}` : ""}`)
		.join("\n");
}

function preview(value: unknown): string | undefined {
	if (value == null) return undefined;
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (!text) return undefined;
		return text.length > 80 ? `${text.slice(0, 79)}…` : text;
	} catch {
		return undefined;
	}
}

/** Strip a wrapping ``` fence the model may have added around the script. */
function normalizeWorkflowScript(script: string): string {
	let text = script.trim();
	const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
	if (fence) text = fence[1].trim();
	return text;
}

const workflowSchema = Type.Object({
	script: Type.String({
		description: [
			"Required raw JavaScript workflow script, no Markdown fences.",
			"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
			"Globals: phase('Name'), agent(prompt, opts), llm(prompt, opts), parallel(thunks), pipeline(items, ...stages), log(message), args, cwd, budget. The workflow must call agent() at least once.",
			"parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
		].join(" "),
	}),
	args: Type.Optional(Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." })),
});

export const WORKFLOW_TOOL_META = {
	name: "workflow",
	mode: "W",
	parameters: workflowSchema,
	description:
		"Execute a deterministic JavaScript workflow that orchestrates multiple sub-agents with agent(), llm(), parallel(), and pipeline(). Use for decomposable fan-out work (codebase audits, multi-perspective review, batch refactors); the script runs to completion and returns its result.",
	prompt: {
		snippet: "Run a deterministic multi-agent workflow script (fan-out / pipeline orchestration)",
		guidelines: [
			"Use workflow for decomposable fan-out: repository inspection, independent research or checks, multi-perspective review, batch transforms with a final synthesis. Do not use it for a single quick read/edit or when ordinary tools are enough.",
			"Pass one raw JavaScript string in `script` (no fences, no prose). It must start with `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }` and must call agent() at least once.",
			"Globals: agent(prompt, opts), llm(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, budget. No imports, no fs, no Date.now()/Math.random()/new Date().",
			"`agent(prompt, opts)` runs a full sub-agent with coding tools — give it a self-contained prompt with all needed context and paths (it shares nothing of your conversation). opts: { label: '2-5 unique words' }, { schema: <plain JSON Schema> } for a validated object return, { agentType: '<persona name>' } to pick a specialist.",
			"`llm(prompt, opts)` is a cheap one-shot LLM call with no tools — for transformations/summaries of data you already hold in the script. opts.context: true lets it ride the workflow's accumulated context; default is stateless.",
			"parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`. Results return in input order. pipeline(items, ...stages) runs each item through the stages while items fan out; each stage gets (prev, original, index).",
			"Failed agent()/llm()/parallel()/pipeline() branches return null and log the failure; check for nulls before synthesizing conclusions.",
			"Include a final synthesis step (an agent or llm call) when combining multiple results; return a compact JSON-serializable value with the verdict plus the important outputs.",
		],
	},
} satisfies ToolMeta;

export function createWorkflowTool(deps: WorkflowToolDeps) {
	return defineTool<typeof workflowSchema, WorkflowProgress | undefined>({
		...WORKFLOW_TOOL_META,
		label: "workflow",
		parameters: workflowSchema,
		prepareArguments: (args) => {
			if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
			const value = args as Record<string, unknown>;
			if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
			return { ...value, script: normalizeWorkflowScript(value.script) } as never;
		},
		async execute(toolCallId, params, signal, onUpdate) {
			const script = normalizeWorkflowScript(params.script);
			let meta;
			try {
				({ meta } = parseWorkflowScript(script));
			} catch (err) {
				return { content: [{ type: "text", text: `workflow: ${err instanceof Error ? err.message : String(err)}` }], details: undefined };
			}

			const progress: WorkflowProgress = { name: meta.name, phases: [], logs: [], agents: [] };
			const emit = () => onUpdate?.({ content: [{ type: "text", text: renderProgress(progress) }], details: { ...progress, agents: progress.agents.map((a) => ({ ...a })) } });

			// ---- per-run workflow agent: identity + separate context + transcript ----
			// LAZY: materialized at the FIRST agent()/llm() call. The anchor costs
			// a bus identity + a transcript — a script that never reaches an LLM
			// boundary (validation throw, pre-abort, only log()/phase()) must not
			// spawn one at all: no wfRoot frame, no agent_ended, no transcript.
			let wf: ClownfishAgent | undefined;
			let wfId: string | undefined;
			let wfTx: SessionTranscript | undefined;
			const ensureAnchor = (): ClownfishAgent => {
				if (wf) return wf;
				wfId = generateId();
				wfTx = deps.sessionId && deps.sessionsDir ? new SessionTranscript(deps.sessionsDir, deps.sessionId, wfId) : undefined;
				const brief = [
					`Workflow "${meta.name}": ${meta.description}`,
					params.args !== undefined ? `args: ${JSON.stringify(params.args)}` : undefined,
				]
					.filter(Boolean)
					.join("\n");
				wf = new ClownfishAgent({
					cwd: deps.cwd,
					root: deps.cwd,
					runtime: deps.runtime,
					toolDefs: [], // pure anchor — the workflow agent never runs a tool loop
					skills: [],
					baseSystemPrompt: WORKFLOW_ROOT_PERSONA,
					initialMessages: [{ role: "user", content: brief, timestamp: Date.now() }],
					sessionId: deps.sessionId ? `${deps.sessionId}/${wfId}` : undefined,
				});
				deps.onFrame({ type: "agent_spawned", agentId: wfId, parentAgentId: deps.agentId, kind: "wfRoot", label: meta.name, toolCallId });
				return wf;
			};

			// ---- `agent()` global: run_agent-style sub-agent under the workflow root ----
			const subLinks: WorkflowRunRecord["subs"] = [];
			const runner = {
				async run(prompt: string, ropts: WorkflowAgentRunOptions): Promise<unknown> {
					const subId = generateId();
					let subTx: SessionTranscript | undefined;
					const def = ropts.agentType ? deps.agents.find((a) => a.name === ropts.agentType) : undefined;
					if (ropts.agentType && !def) {
						throw new Error(`unknown agentType '${ropts.agentType}' (available: ${deps.agents.map((a) => a.name).join(", ") || "none"})`);
					}
					ensureAnchor(); // first agent() materializes the run's anchor
					const capture: StructuredOutputCapture = { called: false, value: undefined };
					deps.onFrame({
						type: "agent_spawned",
						agentId: subId,
						parentAgentId: wfId!,
						kind: "dagSub",
						label: ropts.label,
						toolCallId,
						name: def?.name ?? "workflow-sub",
					});
					subLinks.push(def?.name ? { id: subId, label: ropts.label, name: def.name } : { id: subId, label: ropts.label });
					let sub: ClownfishAgent | undefined;
					let detachAbort: (() => void) | undefined;
					try {
						if (deps.sessionId && deps.sessionsDir) {
							subTx = new SessionTranscript(deps.sessionsDir, deps.sessionId, subId);
						}
						sub = new ClownfishAgent({
							cwd: deps.cwd,
							root: deps.cwd,
							runtime: deps.runtime,
							skills: deps.skills,
							sessionId: deps.sessionId ? `${deps.sessionId}/${subId}` : undefined,
							baseSystemPrompt: def ? renderPrompt(def.body, deps.vars) : WORKFLOW_SUB_PERSONA,
							initialMessages: [],
							toolAccess: def?.access ?? "RW",
							extraTools: ropts.schema ? [createStructuredOutputTool({ schema: ropts.schema, capture })] : [],
							beforeToolCall: deps.beforeToolCallFor?.(subId) ?? deps.beforeToolCall,
							onEvent: (event) => deps.onFrame({ type: "event", event, agentId: subId }),
						});
						if (signal) {
							const onAbort = () => void sub?.abort();
							signal.addEventListener("abort", onAbort, { once: true });
							detachAbort = () => signal?.removeEventListener("abort", onAbort);
						}
						const full = [ropts.instructions, prompt].filter(Boolean).join("\n\n");
						await sub.prompt(full);
						if (ropts.schema) {
							if (!capture.called) throw new Error("sub-agent finished without calling structured_output");
							return capture.value;
						}
						return lastAssistantText(sub.state.messages) || "(sub-agent produced no text output)";
					} finally {
						detachAbort?.();
						// Await the transcript flush: the sub's result is only fully
						// durable once its file has landed.
						if (sub && subTx) await subTx.appendMessages(sub.state.messages).catch(() => undefined);
						deps.onFrame({ type: "agent_ended", agentId: subId });
					}
				},
			};

			// ---- `llm()` global: tmpLLM side call; context mode rides the workflow agent ----
			const llm = async (prompt: string, lopts: WorkflowLlmOptions = {}): Promise<unknown> => {
				try {
					const anchor = ensureAnchor(); // first llm() materializes the anchor too (context mode needs it)
					const text = await anchor.tmpLLM(prompt, { context: lopts.context, signal });
					if (lopts.context) {
						// Extend the workflow's own context: later context-mode calls see this exchange.
						const m = deps.runtime.model;
						anchor.state.messages = [
							...anchor.state.messages,
							{ role: "user", content: prompt, timestamp: Date.now() },
							{
								role: "assistant",
								content: [{ type: "text", text }],
								api: "pi-messages",
								provider: m.provider,
								model: m.id,
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
								stopReason: "stop",
								timestamp: Date.now(),
							},
						];
					}
					return text;
				} catch (err) {
					if (signal?.aborted) throw err;
					progress.logs.push(`llm failed: ${err instanceof Error ? err.message : String(err)}`);
					emit();
					return null;
				}
			};

			try {
				const result = await runWorkflow(script, {
					cwd: deps.cwd,
					args: params.args,
					agent: runner,
					llm,
					signal,
					onLog: (message) => {
						progress.logs.push(message);
						emit();
					},
					onPhase: (title) => {
						progress.currentPhase = title;
						if (!progress.phases.includes(title)) progress.phases.push(title);
						emit();
					},
					onAgentStart: (event) => {
						if (signal?.aborted) throw new Error("workflow aborted");
						progress.agents.push({ label: event.label, phase: event.phase, status: "running" });
						emit();
					},
					onAgentEnd: (event) => {
						const agent = [...progress.agents].reverse().find((a) => a.label === event.label && a.status === "running");
						if (agent) {
							agent.status = event.result === null ? "error" : "done";
							agent.preview = preview(event.result);
						}
						emit();
					},
				});
				if (result.agentCount === 0) {
					return {
						content: [{ type: "text", text: "workflow: scripts must call agent() at least once; this workflow declared phases but did not run any sub-agents." }],
						details: { ...progress, agents: progress.agents.map((a) => ({ ...a })) },
					};
				}
				emit();
				return {
					content: [
						{
							type: "text",
							text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nSteps:\n${renderSteps(progress)}\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
						},
					],
					details: { ...progress, agents: progress.agents.map((a) => ({ ...a })) },
				};
			} catch (err) {
				const aborted = signal?.aborted || /abort/i.test(err instanceof Error ? err.message : String(err));
				if (aborted) {
					for (const a of progress.agents) if (a.status === "running") a.status = "error";
					return { content: [{ type: "text", text: `Workflow aborted.\n\nSteps:\n${renderSteps(progress)}` }], details: { ...progress, agents: progress.agents.map((a) => ({ ...a })) } };
				}
				return {
					content: [{ type: "text", text: `Workflow failed: ${err instanceof Error ? err.message : String(err)}\n\nSteps:\n${renderSteps(progress)}` }],
					details: { ...progress, agents: progress.agents.map((a) => ({ ...a })) },
				};
			} finally {
				if (wf && wfTx) {
					// Durable run record (see WorkflowRunRecord): appended BEFORE the
					// flush so it lands in the same write. Harmless to the anchor's
					// scratch context — it never prompts again.
					const record: WorkflowRunRecord = { toolCallId, progress: { ...progress, agents: progress.agents.map((a) => ({ ...a })) }, subs: subLinks };
					wf.state.messages = [...wf.state.messages, { role: "user", content: `${RUN_RECORD_PREFIX}${JSON.stringify(record)}`, timestamp: Date.now() }];
					await wfTx.appendMessages(wf.state.messages).catch(() => undefined);
				}
				// Pair the spawn frame ONLY when the anchor materialized (lazy init).
				if (wf && wfId) deps.onFrame({ type: "agent_ended", agentId: wfId });
			}
		},
	});
}
