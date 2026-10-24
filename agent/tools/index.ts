/**
 * Tool registry & factories.
 *
 * Tools are authored as {@link ToolDefinition} (carrying prompt metadata) and
 * converted to pi-agent-core {@link AgentTool} instances at the boundary. This
 * keeps the system-prompt assembly (which reads snippets/guidelines) decoupled
 * from the runtime.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JailContext } from "./fs-jail";
import { toAgentTool, toolMode, type ToolDefinition } from "./definition";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";

export * from "./definition";
export {
	PathJailError,
	isInsidePath,
	resolveJailedPath,
	setIsolationRoots,
	screenBashCommand,
	type JailContext,
} from "./fs-jail";
export { createReadTool } from "./read";
export { createWriteTool } from "./write";
export { createEditTool } from "./edit";
export { createBashTool, createLocalBashOperations } from "./bash";
export { createDrawDemoTool, demoUrl } from "./draw-demo";
export { createCronTool, loadCronSpecs } from "./cron";
export { createWorktreeDecideTool } from "./worktree-decide";
export { createGrepTool } from "./grep";
export { createFindTool } from "./find";
export { createLsTool } from "./ls";

export type CodingToolJailOptions = {
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
};

/** The full coding toolset as definitions (with prompt metadata). */
export function createCodingToolDefinitions(cwd: string, jail?: CodingToolJailOptions): ToolDefinition[] {
	const opts = jail ? { jailApproval: jail.jailApproval, root: jail.root } : undefined;
	return [
		createReadTool(cwd, opts),
		createWriteTool(cwd, opts),
		createEditTool(cwd, opts),
		createBashTool(cwd),
		createGrepTool(cwd, opts),
		createFindTool(cwd, opts),
		createLsTool(cwd, opts),
	];
}

/** Read-only subset (explore without mutating) — derived from each tool's `mode`. */
export function createReadOnlyToolDefinitions(cwd: string, root?: string): ToolDefinition[] {
	return createCodingToolDefinitions(cwd, root ? { root } : undefined).filter((d) => toolMode(d) === "R");
}

/** Convert a set of definitions into runtime AgentTools. */
export function toAgentTools(defs: ToolDefinition[]): AgentTool[] {
	return defs.map(toAgentTool);
}
