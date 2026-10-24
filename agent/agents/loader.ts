/**
 * AgentLoader — discovers `*.md` agent prompt files under one or more roots,
 * parses optional YAML frontmatter (description), and exposes them for prompt
 * assembly and the model-driven `run_agent` tool. Mirrors {@link SkillLoader}.
 *
 * The filename stem is the agent name; on a name clash the later (higher-
 * precedence) root wins, so project/global agents override the built-ins.
 */
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseMarkdownDocLoose } from "../frontmatter";
import type { AgentDefinition, AgentPromptVars, AgentRoot } from "./types";
import { isInsidePath } from "../tools/fs-jail";
import { DEFAULT_SYSTEM_PROMPT } from "../system-prompt";
import { compactIfLarge, compactThreshold } from "../prompt-compact";

/**
 * Substitute `{var}` placeholders with values from `vars`. Only keys present in
 * `vars` are replaced; unknown `{x}` sequences are left untouched, so literal
 * braces in prose/code samples survive.
 */
export function renderPrompt(template: string, vars: AgentPromptVars): string {
	return template.replace(/\{(\w+)\}/g, (m, key: string) =>
		key in vars ? String(vars[key as keyof AgentPromptVars]) : m,
	);
}

export class AgentLoader {
	constructor(private readonly roots: AgentRoot[]) {}

	/** Byte size above which a loaded prompt is compacted (for reporting). */
	static get compactThreshold(): number {
		return compactThreshold();
	}

	/** Load agents from all roots in precedence order (low→high); name clash = last wins. */
	async load(): Promise<AgentDefinition[]> {
		const byName = new Map<string, AgentDefinition>();
		for (const root of this.roots) {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(root.dir, { withFileTypes: true });
			} catch {
				continue; // root doesn't exist — skip
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const name = entry.name.slice(0, -3); // strip ".md"
				if (!name) continue;
				const file = join(root.dir, entry.name);
				const raw = await readFile(file, "utf8").catch(() => null);
				if (raw === null) continue;
				const { frontmatter, body } = parseMarkdownDocLoose(raw);
				const description =
					typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
				const internal = frontmatter.internal === true;
				const access = frontmatter.access === "R" || frontmatter.access === "RW" ? frontmatter.access : undefined;
				const model = typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
				byName.set(name, { name, description, internal, access, model, body, path: file, source: root.source });
			}
		}
		const agents = [...byName.values()];
		agents.sort((a, b) => a.name.localeCompare(b.name));
		return agents;
	}
}

/**
 * Render the prompt for the named agent. Falls back to "system", then to the
 * hard-coded DEFAULT_SYSTEM_PROMPT if no agents loaded at all.
 */
export function resolveAgentPrompt(agents: AgentDefinition[], name: string, vars: AgentPromptVars): string {
	const agent = agents.find((a) => a.name === name) ?? agents.find((a) => a.name === "system");
	if (!agent) return DEFAULT_SYSTEM_PROMPT;
	return renderPrompt(agent.body, vars);
}

/** A compact `name: description` listing for the run_agent tool's `type` parameter. Excludes internal agents. */
export function agentsTypeList(agents: AgentDefinition[]): string {
	const visible = agents.filter((a) => !a.internal);
	if (visible.length === 0) return "(none)";
	return visible.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`).join("\n");
}

/** Project-instruction filenames tried in order — first one with content wins.
 *  CLAUDE.md (the Claude Code convention) keeps precedence; AGENT.md and the
 *  lowercase variants follow so either convention works on a case-sensitive FS. */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENT.md", "claude.md", "agent.md"] as const;

/** Loaded project instructions: the winning file + its (capped) body. */
export interface ProjectInstructions {
	/** Directory the file was found in (a link in the cwd→root chain). */
	dir: string;
	/** Filename the body came from (surfaced in the prompt header). */
	file: string;
	/** Instruction body, capped at 20k chars so a runaway file can't eat the context budget. */
	body: string;
}

/** Project instructions for a cwd: `<cwd>/CLAUDE.md` (the Claude Code
 *  convention) or `AGENT.md` etc. — first file with content wins, null when
 *  none exist. Sync read — only called at agent build (infrequent). */
export function loadProjectClaude(cwd: string): ProjectInstructions | null {
	for (const file of INSTRUCTION_FILES) {
		try {
			const body = readFileSync(join(cwd, file), "utf8").trim();
			if (!body) continue;
			return { dir: cwd, file, body: body.length > 20000 ? `${body.slice(0, 20000)}\n\n…(${file} truncated at 20000 chars)` : body };
		} catch {
			// missing / unreadable — try the next name
		}
	}
	return null;
}

/** Format one loaded instruction file as a system-prompt block ("" when none). */
export function claudeMdBlock(found: ProjectInstructions | null): string {
	return found ? `# Project instructions (${found.file} at ${found.dir})\n\n${found.body}` : "";
}

/**
 * The instruction chain for a cwd under a root: every directory from the root
 * DOWN TO the cwd (inclusive), each contributing its CLAUDE.md/AGENT.md when
 * present. Root first — broader instructions earlier, the cwd's own LAST, so
 * the narrowest file overrides (later text wins). A cwd outside the root
 * degrades to just itself. Each agent loads its own chain at init; nothing is
 * passed between agents.
 */
export function instructionChain(cwd: string, root: string): ProjectInstructions[] {
	const dirs: string[] = [];
	if (isInsidePath(cwd, root)) {
		dirs.push(root);
		const rel = relative(root, cwd);
		if (rel) {
			let acc = root;
			for (const seg of rel.split(sep)) {
				acc = join(acc, seg);
				dirs.push(acc);
			}
		}
	} else {
		dirs.push(cwd);
	}
	const chain: ProjectInstructions[] = [];
	for (const dir of dirs) {
		const found = loadProjectClaude(dir);
		if (found) chain.push(found);
	}
	return chain;
}

/** The chain formatted for a system prompt ("" when no dir has a file). */
export function instructionChainBlock(cwd: string, root: string): string {
	return instructionChain(cwd, root)
		.map((f) => claudeMdBlock(f))
		.join("\n\n");
}
