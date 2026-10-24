/**
 * Tool prompt overrides — copy-on-write edits of any tool's model-facing text.
 *
 * A tool has three pieces of prompt surface: the `description` the provider sees
 * in the tool schema, the one-line `snippet` in the system prompt's tool index,
 * and the `guidelines` bullets under its heading. All three are authored in code,
 * which makes them hard to iterate on — so they are overridable exactly the way
 * agent prompts are: the edit is written to
 *
 *   <dataDir>/tool_overwrite/<name>.md
 *
 * and applied on top of the code-defined definition at agent construction time.
 * "Reset" is deleting that file; the source `.ts` is never touched.
 *
 * File format (mirrors an agent `.md` — frontmatter + body):
 *
 *   ---
 *   snippet: One-line summary for the tool index
 *   guidelines:
 *     - A bullet appended under "### <tool>"
 *   ---
 *   The description the model sees in the tool schema.
 *
 * A missing key means "keep what the code defines", so an override can retune
 * just the snippet without restating the whole description.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseMarkdownDocLoose } from "../frontmatter";
import type { ToolDefinition, ToolPromptContribution } from "./definition";

export const TOOL_OVERRIDE_DIR = "tool_overwrite";

/**
 * Tool names are `.md` filename stems. MCP tools are `mcp__<server>__<tool>`, so
 * underscores and dots are allowed — but no separators and no traversal.
 */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidToolName(name: string): boolean {
	return VALID_NAME.test(name) && !name.includes("..") && name.length <= 128;
}

/** Directory holding the override `.md` files. */
export function toolOverrideDir(dataDir: string): string {
	return join(dataDir, TOOL_OVERRIDE_DIR);
}

/** Absolute path of one tool's override file. Throws on a name that isn't a plain stem. */
export function toolOverridePath(dataDir: string, name: string): string {
	if (!isValidToolName(name)) throw new Error(`invalid tool name: ${JSON.stringify(name)}`);
	return join(toolOverrideDir(dataDir), `${name}.md`);
}

/** The overridable slice of a tool's prompt surface. Absent keys keep the code default. */
export interface ToolPromptOverride {
	description?: string;
	snippet?: string;
	guidelines?: string[];
}

/** A tool's prompt surface, independent of its schema/executor. */
export interface ToolPromptSource {
	name: string;
	description: string;
	prompt?: ToolPromptContribution;
	/** Capability mode, for display ("R" read-only / "W" mutating / "RW"). */
	mode?: "R" | "W" | "RW";
	/** Which agents receive the tool: every agent, the top-level agent only, or 我的助理 only. */
	scope?: ToolScope;
	/** The parameter schema the provider sees (typebox/JSON Schema), for display + token accounting. */
	parameters?: unknown;
}

/** "all" = every agent incl. sub-agents; "main" = top-level agent only; "assistant" = only 我的助理. */
/** "dag" = main agent, but only with CLOWNFISH_DAG_TOOLS=1 (off by default — docs/TOOLS.md). */
export type ToolScope = "all" | "main" | "assistant" | "dag";

/** Parse an override file: YAML frontmatter (snippet/guidelines) + body (description). */
export function parseToolPrompt(raw: string): ToolPromptOverride {
	const { frontmatter, body } = parseMarkdownDocLoose(raw);
	const snippet = typeof frontmatter.snippet === "string" ? frontmatter.snippet.trim() : undefined;
	const guidelines = Array.isArray(frontmatter.guidelines)
		? frontmatter.guidelines.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean)
		: undefined;
	return { description: body || undefined, snippet: snippet || undefined, guidelines };
}

/** Render a tool's current prompt surface as the editable `.md` the UI round-trips. */
export function serializeToolPrompt(def: ToolPromptSource): string {
	const meta: Record<string, unknown> = {};
	if (def.prompt?.snippet) meta.snippet = def.prompt.snippet;
	if (def.prompt?.guidelines?.length) meta.guidelines = def.prompt.guidelines;
	const front = Object.keys(meta).length > 0 ? `---\n${stringifyYaml(meta).trim()}\n---\n` : "";
	return `${front}${def.description.trim()}\n`;
}

/** Names that currently have an override on disk. */
export async function listToolOverrides(dataDir: string): Promise<string[]> {
	const entries = await readdir(toolOverrideDir(dataDir), { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.slice(0, -3))
		.filter(isValidToolName);
}

/** Raw override file contents, or null when there is none. */
export async function readToolOverride(dataDir: string, name: string): Promise<string | null> {
	return readFile(toolOverridePath(dataDir, name), "utf8").catch(() => null);
}

/** Write (create or replace) a tool's override. Returns the file written. */
export async function writeToolOverride(dataDir: string, name: string, content: string): Promise<string> {
	const file = toolOverridePath(dataDir, name);
	await mkdir(toolOverrideDir(dataDir), { recursive: true });
	await writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	return file;
}

/** Drop a tool's override (the "reset" action). False when there was none. */
export async function removeToolOverride(dataDir: string, name: string): Promise<boolean> {
	const file = toolOverridePath(dataDir, name);
	if ((await readFile(file, "utf8").catch(() => null)) === null) return false;
	await rm(file, { force: true });
	return true;
}

/** Every override on disk, keyed by tool name. Cheap enough to load once per agent boot. */
export async function loadToolOverrides(dataDir: string): Promise<ToolOverrideMap> {
	const map = new Map<string, ToolPromptOverride>();
	for (const name of await listToolOverrides(dataDir)) {
		const raw = await readToolOverride(dataDir, name).catch(() => null);
		if (raw !== null) map.set(name, parseToolPrompt(raw));
	}
	return map;
}

export type ToolOverrideMap = Map<string, ToolPromptOverride>;

/** Apply one override on top of a tool's code-defined prompt surface. */
export function overrideToolPrompt<T extends ToolPromptSource>(def: T, o: ToolPromptOverride | undefined): T {
	if (!o || (!o.description && !o.snippet && !o.guidelines)) return def;
	const snippet = o.snippet ?? def.prompt?.snippet;
	const guidelines = o.guidelines ?? def.prompt?.guidelines;
	return {
		...def,
		description: o.description ?? def.description,
		prompt: snippet ? { snippet, guidelines } : def.prompt,
	};
}

/**
 * Apply the override map to a toolset. Used for both the real definitions (at
 * agent construction) and the settings page's listing, so what the UI shows is
 * exactly what the model gets.
 */
export function applyToolOverrides(defs: ToolDefinition[], overrides: ToolOverrideMap | undefined): ToolDefinition[] {
	if (!overrides || overrides.size === 0) return defs;
	return defs.map((d) => overrideToolPrompt(d, overrides.get(d.name)));
}
