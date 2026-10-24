/**
 * delegate tool — DAG-aware synchronous sub-agent delegation.
 *
 * The agent driving a plan node calls `delegate({ node_id, context? })` to hand
 * that node (a `delegate`-mode child it owns) to a fresh in-process
 * {@link ClownfishAgent} bound to the node. The sub-agent:
 *   - is re-bound as the node's owner (it may re-plan / drive its subtree),
 *   - gets a BRANCH_VIEW (its node + subtree + scope rules — NOT the global DAG,
 *     NOT its siblings → context compression),
 *   - gets scoped DAG tools + its own `delegate` (one level deeper) + coding tools,
 *   - streams its events to the session bus under its own agentId (so the UI can
 *     drill into it) and persists to its own transcript `<sid>/<subId>.jsonl`,
 *   - runs its whole subtree synchronously (nested delegates await in turn),
 *
 * then returns its final summary as the tool result. The caller's tool loop
 * already runs tools in parallel, so multiple `delegate` calls in one turn fan
 * out concurrently and all resolve before the next turn — no internalPrompt, no
 * batched queue; this reuses pi-agent-core's existing tool loop verbatim.
 *
 * Nesting is capped at {@link MAX_DELEGATE_DEPTH}: a sub-agent at the leaf depth
 * is built WITHOUT the delegate tool (it can still decompose / do inline work).
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "../tools/definition";
import type { ToolDefinition } from "../tools";
import { ClownfishAgent, type ClownfishAgentOptions } from "../clownfish-agent";
import type { ResolvedRuntime } from "../models";
import type { Skill } from "../skills";
import type { AgentPromptVars } from "./types";
import type { DagNodeView, DagStore } from "../dag";
import { formatNodeView } from "../dag";
import { createDagTools } from "../tools/dag";
import { DEFAULT_SYSTEM_PROMPT } from "../system-prompt";
import { SessionTranscript } from "../transcript";
import { generateId } from "../id";
import { runOutcome } from "./run-outcome";
import type { WorkerFrame } from "../protocol";

/** Maximum delegation chain depth. main(0) → 1 → 2 → 3 → 4(leaf: inline only). */
export const MAX_DELEGATE_DEPTH = 4;

export interface DelegateToolDeps {
	/** Shared DAG store (the sub-agent operates on its node's subtree). */
	dags: DagStore;
	/** The CALLING agent's id (authority scope + parent for lifecycle). */
	agentId: string;
	runtime: ResolvedRuntime;
	cwd: string;
	skills: Skill[];
	vars: AgentPromptVars;
	/** Parent session id (sub-agents persist under `<sessionId>/<subId>.jsonl`). */
	sessionId: string;
	sessionsDir: string;
	/** This agent's depth in the delegation chain (main = 0). */
	depth: number;
	/** Inherited tool-call hook (ask-mode approval gate + checkpoint capture). */
	beforeToolCall?: ClownfishAgentOptions["beforeToolCall"];
	/** Per-agent hook variant (approval attribution for spawned agents). */
	beforeToolCallFor?: (agentId: string) => ClownfishAgentOptions["beforeToolCall"];
	/** Emit a worker frame to the session bus (runtime.send). */
	onFrame: (frame: WorkerFrame) => void;
}

/** Build the BRANCH_VIEW briefing for a delegated sub-agent (its scope, not the world). */
function branchView(node: DagNodeView, context: string | undefined, subDepth: number, canDelegate: boolean): string {
	const depthNote = canDelegate
		? `You are at delegation depth ${subDepth}; you may delegate 'delegate' children (up to depth ${MAX_DELEGATE_DEPTH}).`
		: `You are at the max delegation depth (${subDepth}); you have NO delegate tool — decompose and do work inline only.`;
	return [
		`## Plan node delegated to you`,
		``,
		`You are driving ONE node of a shared execution plan and everything beneath it.`,
		``,
		`# Your node (${node.id})`,
		node.description,
		``,
		`# Your subtree — you own node ${node.id} and its descendants`,
		formatNodeView([node]),
		``,
		`# Scope rules`,
		`- Operate ONLY on node ${node.id} and its descendants (decompose / update_node / delegate). Never touch upstream or sibling nodes.`,
		`- Use \`decompose\` to break your node into child steps when it warrants it; \`update_node\` to mark progress (in_progress → completed) and attach a short result.`,
		`- For a child you want to hand off, mark it 'delegate' and call \`delegate\` on it — a sub-agent drives that child's subtree.`,
		`- Do 'inline' steps yourself with your coding tools.`,
		`- When your whole subtree is done, mark node ${node.id} \`completed\` with a concise summary, then stop.`,
		``,
		`# Depth`,
		depthNote,
		context ? `` : ``,
		context ? `# Context from the coordinating agent` : ``,
		context ?? ``,
	]
		.filter((s) => s.length > 0)
		.join("\n");
}

const delegateSchema = Type.Object({
	node_id: Type.String({
		description: "The delegate-mode node to hand off (a child you own). A sub-agent will drive its whole subtree.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Optional context/results to seed the sub-agent (it does not share your conversation). Pass anything it needs from siblings or upstream.",
		}),
	),
});

export const DELEGATE_TOOL_META = {
	name: "delegate",
	mode: "W",
	parameters: delegateSchema,
	description:
		"Hand a delegate-mode node you own to a sub-agent that drives its whole subtree to completion, then returns a summary. Multiple delegate calls in one turn run in parallel. Use for steps worth a focused agent (separate context); do 'inline' steps yourself.",
	prompt: {
		snippet: "Delegate a plan node's subtree to a sub-agent",
		guidelines: [
			"Only delegate nodes you own that are mode 'delegate'. Mark the step 'delegate' when decomposing if you intend to hand it off.",
			"Give the sub-agent enough `context` (it has no memory of your conversation — no siblings, no global state).",
			"A delegated subtree runs to completion and returns a summary; check it, then update_node or continue.",
		],
	},
} satisfies ToolMeta;

export function createDelegateTool(deps: DelegateToolDeps): ToolDefinition {
	return defineTool<typeof delegateSchema, undefined>({
		...DELEGATE_TOOL_META,
		label: "delegate",
		parameters: delegateSchema,
		async execute(_toolCallId, { node_id, context }) {
			// Authority + fetch the node's subtree (what the sub-agent will own).
			const owned = deps.dags.view(deps.agentId, node_id);
			if (!owned || owned.length === 0) {
				return { content: [{ type: "text", text: `delegate: node '${node_id}' is out of your scope (you don't own it).` }], details: undefined };
			}
			const nodeView = owned[0];
			if (nodeView.mode !== "delegate") {
				return { content: [{ type: "text", text: `delegate: node '${node_id}' is mode '${nodeView.mode}' — only 'delegate' nodes can be delegated. Do it inline instead.` }], details: undefined };
			}

			// From here on we emit agent_spawned → must always pair an agent_ended, even
			// if construction or the sub-run throws. Wrap spawn+run so failures become a
			// readable result (the parent can retry/recover) instead of a thrown tool error.
			const subId = generateId();
			let sub: ClownfishAgent | undefined;
			let subTx: SessionTranscript | undefined;
			try {
				const subDepth = deps.depth + 1;
				const canDelegate = subDepth < MAX_DELEGATE_DEPTH;
				// Re-bind the node to the sub-agent (caller retains authority via
				// subtree-authority). CAS: a parallel-batch duplicate delegate for this
				// node (model echo/retry) must not spawn a second driver.
				deps.dags.claimNode(deps.agentId, node_id, subId);
				deps.onFrame({ type: "agent_spawned", agentId: subId, parentAgentId: deps.agentId, kind: "dagSub", label: nodeView.description });

				// Scoped tools: DAG tools (bound to subId) + delegate one level deeper.
				const subExtra: ToolDefinition[] = [...createDagTools({ dags: deps.dags, agentId: subId })];
				if (canDelegate) subExtra.push(createDelegateTool({ ...deps, agentId: subId, depth: subDepth }));

				subTx = new SessionTranscript(deps.sessionsDir, deps.sessionId, subId);
				sub = new ClownfishAgent({
					cwd: deps.cwd,
					runtime: deps.runtime,
					skills: deps.skills,
					sessionId: `${deps.sessionId}/${subId}`,
					baseSystemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n${branchView(nodeView, context, subDepth, canDelegate)}`,
					initialMessages: [],
					toolAccess: "RW",
					beforeToolCall: deps.beforeToolCallFor?.(subId) ?? deps.beforeToolCall,
					onEvent: (event: AgentEvent) => deps.onFrame({ type: "event", event, agentId: subId }),
					extraTools: subExtra,
				});

				await sub.prompt(`Drive your node ${node_id} to completion: ${nodeView.description}`);

				const outcome = runOutcome(sub.state.messages);
				if (!outcome.ok) {
					// Provider-killed sub-run: the node did NOT complete. Reset it to
					// pending (its work state is unknown/partial) so it gets re-driven —
					// a fake 'completed' here would silently lose the step forever.
					deps.dags.updateNode(deps.agentId, node_id, { status: "pending", result: `interrupted by provider error: ${outcome.error}` });
					return {
						content: [
							{
								type: "text",
								text: `delegate '${node_id}' was interrupted by a provider error (${outcome.error}). The node was reset to pending — retry it (delegate again) or continue with other work.`,
							},
						],
						details: undefined,
					};
				}

				const summary = outcome.summary || "(sub-agent produced no summary)";
				// Finalize the node if the sub-agent didn't (caller retains authority).
				const after = deps.dags.view(deps.agentId, node_id)?.[0];
				if (after && after.status !== "completed") {
					deps.dags.updateNode(deps.agentId, node_id, { status: "completed", result: summary });
				}
				return { content: [{ type: "text", text: summary }], details: undefined };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Record the failure on the node (parent retains authority) + report it.
				const after = deps.dags.view(deps.agentId, node_id)?.[0];
				if (after && after.status !== "completed") {
					deps.dags.updateNode(deps.agentId, node_id, { status: "in_progress", result: `delegation failed: ${msg}` });
				}
				return { content: [{ type: "text", text: `delegate '${node_id}' failed: ${msg}` }], details: undefined };
			} finally {
				// Persist the sub-agent's transcript (it started empty → full history).
				if (sub && subTx) void subTx.appendMessages(sub.state.messages).catch(() => undefined);
				deps.onFrame({ type: "agent_ended", agentId: subId });
			}
		},
	});
}
