/**
 * System-prompt assembly.
 *
 * Composes the base Clownfish persona with the collected tool snippets/
 * guidelines and the skills index. This is the only place the prompt is built;
 * {@link ClownfishAgent} hands the result to pi's Agent via initialState.
 */
import { collectToolPromptContributions, type ToolDefinition } from "./tools";
import { maybeCompactPrompt } from "./prompt-compact";
import type { Skill } from "./skills";
import { SkillLoader } from "./skills";

/** Default base system prompt for a fresh ClownfishAgent (Clownfish persona). */
export const DEFAULT_SYSTEM_PROMPT = `You are Clownfish, a software engineering agent. You operate inside a workspace and accomplish tasks by reading, editing, and writing files and running shell commands.

Work in small, verifiable steps. Prefer the narrowest tool for the job: read/grep/find/ls to explore, edit for targeted changes, write only for new files or complete rewrites. After making changes, run the relevant checks (build, typecheck, tests) via bash.

Be concise. Report what you did, what you verified, and anything that still needs attention. When you are blocked or a decision is genuinely the user's, say so rather than guessing. Reply in the same language the user writes in.`;

export interface AssemblePromptOptions {
	base?: string;
	toolDefs: ToolDefinition[];
	skills: Skill[];
	cwd: string;
	/** Allowed-area root containing cwd (a narrowed-cwd sub-agent's parent workspace). */
	root?: string;
	/** Pre-built project-instruction chain (root → cwd, the agent loaded its own at init). */
	instructions?: string;
}

export function assembleSystemPrompt(opts: AssemblePromptOptions): string {
	const parts: string[] = [(opts.base ?? DEFAULT_SYSTEM_PROMPT).trim()];
	if (opts.instructions?.trim()) parts.push("", opts.instructions.trim());

	const toolsBlock = collectToolPromptContributions(opts.toolDefs);
	if (toolsBlock) parts.push("", toolsBlock);

	const skillsBlock = SkillLoader.indexPrompt(opts.skills);
	if (skillsBlock) parts.push("", skillsBlock);

	parts.push(
		"",
		`# Environment`,
		`- Workspace: ${opts.cwd}`,
		...(opts.root && opts.root !== opts.cwd
			? [
					`- Workspace root: ${opts.root} — your cwd is narrowed for this task; if it proves too narrow for what you need, look upward as far as this root (your file tools allow exactly that range), no further.`,
				]
			: []),
		`- Today: ${isoToday()}`,
	);

	const assembled = parts.filter((s) => s.trim().length > 0).join("\n").trim() + "\n";
	// Single choke point: every agent — main and sub — builds its system prompt
	// here, so compaction applies to the agent prompt, the generated tool block
	// and the skills index in one place.
	return maybeCompactPrompt(assembled);
}

function isoToday(): string {
	// Build an ISO date without relying on Date.now()/new Date() at module-eval
	// time (not a constraint here, but keeps it lazy and testable). At call time
	// new Date() is fine — this runs server-side per agent construction.
	return new Date().toISOString().slice(0, 10);
}
