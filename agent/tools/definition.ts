/**
 * Clownfish tool mechanism.
 *
 * A thin {@link ToolDefinition} layer over pi-agent-core's {@link AgentTool}.
 * It carries prompt-contribution metadata (snippet/guidelines) that feeds the
 * assembled system prompt, and decouples "what the model is told" from "what
 * runs" — without pi's TUI renderers (renderCall/renderResult).
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "@earendil-works/pi-ai";

export interface ToolPromptContribution {
	/** One-line summary used in the system prompt tool index. */
	snippet: string;
	/** Longer guidelines appended under the tool's heading. */
	guidelines?: string[];
}

/**
 * A tool's model-facing text, separable from its execution binding so the
 * settings-page catalog can list tools whose factories need per-session deps.
 * Factories spread their meta (`...X_TOOL_META`) — one source of truth.
 */
export interface ToolMeta {
	name: string;
	description: string;
	mode?: "R" | "W" | "RW";
	prompt?: ToolPromptContribution;
	/**
	 * The parameter schema the provider sees. The SAME object the factory passes
	 * as `parameters` — carried here so the settings-page catalog can show (and
	 * cost) the full prompt surface without building an agent. A meta whose
	 * factory builds its schema per session (run_agent embeds the live agent
	 * list) carries a static equivalent.
	 */
	parameters?: TSchema;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	prompt?: ToolPromptContribution;
	executionMode?: "sequential" | "parallel";
	/**
	 * Capability mode: "R" = read-only (no side effects), "W" = can mutate
	 * (write files / run commands), "RW" = unrestricted (default). Used to filter
	 * an agent's available tools by access policy (e.g. read-only / plan mode).
	 */
	mode?: "R" | "W" | "RW";
	/** Compatibility shim for raw tool-call arguments before schema validation. */
	prepareArguments?: (args: unknown) => Static<TParams>;
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate?: (partialResult: AgentToolResult<TDetails>) => void,
	) => Promise<AgentToolResult<TDetails>>;
}

export function defineTool<TParams extends TSchema, TDetails>(
	def: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return def;
}

/** Access policy for an agent's toolset: "R" = read-only tools only, "RW" = all. */
export type ToolAccess = "R" | "RW";

/** A tool's effective mode (defaults to "RW" when unset). */
export function toolMode(def: ToolDefinition): "R" | "W" | "RW" {
	return def.mode ?? "RW";
}

/** Filter tool definitions to those allowed by an access policy. */
export function filterByAccess(defs: ToolDefinition[], access: ToolAccess): ToolDefinition[] {
	return access === "R" ? defs.filter((d) => toolMode(d) === "R") : defs;
}

/** Convert a {@link ToolDefinition} into the runtime {@link AgentTool} pi-agent-core expects. */
export function toAgentTool<TParams extends TSchema, TDetails>(
	def: ToolDefinition<TParams, TDetails>,
): AgentTool<TParams, TDetails> {
	return {
		name: def.name,
		label: def.label,
		description: def.description,
		parameters: def.parameters,
		executionMode: def.executionMode,
		prepareArguments: def.prepareArguments,
		execute: def.execute as AgentTool<TParams, TDetails>["execute"],
	};
}

/** Assemble the "## Tools" block for the system prompt from tool definitions. */
export function collectToolPromptContributions(defs: ToolDefinition[]): string {
	const lines: string[] = ["## Tools", ""];
	for (const def of defs) {
		if (!def.prompt) continue;
		lines.push(`- **${def.name}** — ${def.prompt.snippet}`);
	}
	lines.push("");
	for (const def of defs) {
		if (!def.prompt?.guidelines?.length) continue;
		lines.push(`### ${def.name}`);
		for (const g of def.prompt.guidelines) lines.push(`- ${g}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}
