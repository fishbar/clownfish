/**
 * Tool catalog — every built-in tool's prompt surface, without building an agent.
 *
 * The settings page needs to list and edit what the model is told about each
 * tool (description / snippet / guidelines) outside any session, so this exposes
 * the same definitions {@link ClownfishAgent} wires up, reduced to their prompt
 * surface. The coding tools and the skill tool are cheap to construct (cwd only
 * affects behaviour, never text); every other built-in tool's factory needs
 * per-session deps, so those are listed from the static `*_TOOL_META` each
 * factory spreads — one source of truth, no fake deps.
 *
 * Order = the order the runtime lists them in the prompt (`agent/runtime.ts`
 * `extraTools`): coding, skill, run_agent, delegate, workflow, run_goal,
 * draw_demo, cron, worktree_decide, sessions×3, dag×4, todo, memory.
 *
 * MCP tools are deliberately absent: their prompts come from the remote server
 * and are only known once a session has connected. An override written for one
 * by name still applies (see `applyToolOverrides`).
 */
import { createCodingToolDefinitions, type ToolDefinition, type ToolMeta } from "./tools";
import { toolMode } from "./tools";
import {
	applyToolOverrides,
	overrideToolPrompt,
	type ToolOverrideMap,
	type ToolPromptSource,
	type ToolScope,
} from "./tools/overrides";
import { createSkillTool } from "./skills";
import { RUN_AGENT_TOOL_META } from "./agents/run-agent-tool";
import { DELEGATE_TOOL_META } from "./agents/delegate";
import { WORKFLOW_TOOL_META } from "./tools/workflow";
import { RUN_GOAL_TOOL_META } from "./agents/goal";
import { DRAW_DEMO_TOOL_META } from "./tools/draw-demo";
import { CRON_TOOL_META } from "./tools/cron";
import { WORKTREE_DECIDE_TOOL_META } from "./tools/worktree-decide";
import { SESSIONS_TOOL_META, SESSION_READ_TOOL_META, SESSION_SEND_TOOL_META } from "./tools/sessions";
import { DECOMPOSE_TOOL_META, GET_STATUS_TOOL_META, PLAN_TOOL_META, UPDATE_NODE_TOOL_META } from "./tools/dag";
import { TODO_TOOL_META } from "./todo";
import { MEMORY_TOOL_META } from "./memory";

/** cwd only affects tool *behaviour*, never the prompt text we list here. */
const CATALOG_CWD = process.cwd();

/** The tools every agent gets: the coding set + the skill tool. */
function sessionToolDefinitions(): ToolDefinition[] {
	return [...createCodingToolDefinitions(CATALOG_CWD), createSkillTool(() => [])];
}

/** Top-level-agent-only tools (sub-agents never see them), in prompt order. */
const MAIN_TOOL_METAS: ToolMeta[] = [
	RUN_AGENT_TOOL_META,
	DELEGATE_TOOL_META,
	WORKFLOW_TOOL_META,
	RUN_GOAL_TOOL_META,
	DRAW_DEMO_TOOL_META,
	CRON_TOOL_META,
	WORKTREE_DECIDE_TOOL_META,
];

/** Assembled only for 我的助理 (`sessionControl`), between worktree_decide and the DAG tools. */
const ASSISTANT_TOOL_METAS: ToolMeta[] = [SESSIONS_TOOL_META, SESSION_SEND_TOOL_META, SESSION_READ_TOOL_META];

/** The rest of the top-level set, after the assistant tools. */
const MAIN_TAIL_TOOL_METAS: ToolMeta[] = [
	PLAN_TOOL_META,
	DECOMPOSE_TOOL_META,
	UPDATE_NODE_TOOL_META,
	GET_STATUS_TOOL_META,
	TODO_TOOL_META,
	MEMORY_TOOL_META,
];

const DAG_TOOL_NAMES = new Set(["plan", "decompose", "update_node", "get_status", "delegate"]);
/** Absorbed by run_agent (`tasks` / `until`); each restored by its own flag. */
const FLAGGED_TOOL_NAMES = new Set(["workflow", "run_goal"]);

function toSource(m: ToolMeta, scope: ToolScope): ToolPromptSource {
	// The DAG set is wired only under CLOWNFISH_DAG_TOOLS=1 (agent/runtime.ts).
	const effective: ToolScope = scope === "main" && (DAG_TOOL_NAMES.has(m.name) || FLAGGED_TOOL_NAMES.has(m.name)) ? "dag" : scope;
	return { name: m.name, description: m.description, prompt: m.prompt, mode: m.mode ?? "RW", scope: effective, parameters: m.parameters };
}

/** Prompt surface of every built-in tool, in the order the prompt lists them. */
export function builtinToolPromptSources(): ToolPromptSource[] {
	return [
		...sessionToolDefinitions().map((d) => toSource({ ...d, mode: toolMode(d) }, "all")),
		...MAIN_TOOL_METAS.map((m) => toSource(m, "main")),
		...ASSISTANT_TOOL_METAS.map((m) => toSource(m, "assistant")),
		...MAIN_TAIL_TOOL_METAS.map((m) => toSource(m, "main")),
	];
}

/** The same catalog with operator overrides applied — i.e. what the model actually sees. */
export function effectiveToolPromptSources(overrides: ToolOverrideMap | undefined): ToolPromptSource[] {
	const base = builtinToolPromptSources();
	if (!overrides || overrides.size === 0) return base;
	return base.map((d) => overrideToolPrompt(d, overrides.get(d.name)));
}

export { applyToolOverrides };
