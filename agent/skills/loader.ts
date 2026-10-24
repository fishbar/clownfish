/**
 * SkillLoader — discovers SKILL.md files under one or more directories,
 * parses YAML frontmatter, and exposes them for the system-prompt index and
 * the model-driven `skill` tool.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseMarkdownDoc } from "../frontmatter";
import { resolveToCwd } from "../paths";
import type { Skill, SkillFrontmatter, SkillRoot } from "./types";

/** Parse a SKILL.md file into frontmatter + body. Returns null if not a valid skill. */
async function findSkillFiles(dir: string, acc: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			await findSkillFiles(abs, acc);
		} else if (entry.isFile() && entry.name === "SKILL.md") {
			acc.push(abs);
		}
	}
}

export class SkillLoader {
	/** Resolved (absolute) roots to scan, each tagged with its origin label. */
	readonly roots: { dir: string; source: string }[];

	constructor(roots: SkillRoot[], private cwd: string) {
		this.roots = roots.map((r) => ({ dir: resolveToCwd(r.dir, cwd), source: r.source }));
	}

	/** Resolved absolute directories (convenience for logging). */
	get dirs(): string[] {
		return this.roots.map((r) => r.dir);
	}

	async load(): Promise<Skill[]> {
		// Walk roots in precedence order (low→high); a name collision is
		// last-wins, so a later (more specific) root overrides an earlier one.
		const byName = new Map<string, Skill>();
		for (const root of this.roots) {
			const files: string[] = [];
			await findSkillFiles(root.dir, files);
			for (const file of files) {
				const raw = await readFile(file, "utf8").catch(() => null);
				if (raw === null) continue;
				const parsed = parseMarkdownDoc(raw);
				if (!parsed) continue;
				const fm = parsed.frontmatter as Partial<SkillFrontmatter>;
				if (typeof fm.name !== "string" || typeof fm.description !== "string") continue;
				byName.set(fm.name, {
					name: fm.name,
					description: fm.description,
					path: file,
					dir: file.slice(0, Math.max(0, file.length - basename(file).length)),
					body: parsed.body,
					source: root.source,
				});
			}
		}
		const skills = [...byName.values()];
		skills.sort((a, b) => a.name.localeCompare(b.name));
		return skills;
	}

	/** Render the "## Skills" index block for the system prompt. */
	static indexPrompt(skills: Skill[]): string {
		if (skills.length === 0) return "";
		const lines = ["## Skills", "", "The following skills are available. Call the `skill` tool with a skill's name to load its full instructions into context when relevant.", ""];
		for (const s of skills) lines.push(`- **${s.name}** — ${s.description}`);
		lines.push("");
		return lines.join("\n");
	}

	/** Relative-to-cwd path for a skill dir, for compact logging/UI. */
	static rel(skill: Skill, cwd: string): string {
		return relative(cwd, skill.dir) || ".";
	}
}
