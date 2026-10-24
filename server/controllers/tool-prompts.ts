/**
 * Operator REST: tool prompt management (the settings page's tool editor).
 *
 *   GET    /api/tool-prompts        → every tool + its effective prompt surface
 *   GET    /api/tool-prompts/:name  → one tool
 *   PUT    /api/tool-prompts/:name  → {content} write a copy-on-write override
 *   DELETE /api/tool-prompts/:name  → drop the override (back to the code default)
 *
 * A tool's prompt is three things: the `description` in the schema the provider
 * sees, the one-line `snippet` in the system prompt's tool index, and the
 * `guidelines` bullets under its heading. They are authored in TypeScript, so the
 * override is a shadow `.md` under `<dataDir>/tool_overwrite/` (frontmatter
 * `snippet`/`guidelines`, body = description) applied on top at agent construction
 * — the same copy-on-write shape as `/api/agent-prompts`, with the source
 * unchanged and reset = deleting the shadow file.
 *
 * Scope is global: unlike agents, tools are code, not per-project assets. MCP
 * tools are not listed (their text comes from a live server connection), but an
 * override written for one by name still applies.
 */
import { Router } from "express";
import {
	builtinToolPromptSources,
	effectiveToolPromptSources,
	isValidToolName,
	loadToolOverrides,
	parseToolPrompt,
	removeToolOverride,
	serializeToolPrompt,
	toolOverridePath,
	writeToolOverride,
	type ToolPromptSource,
} from "../../agent";
import type { ServerContext } from "../context";
import type { ToolPromptInfo } from "../protocol";

/** The provider's own estimate is a request away; ~3.6 chars/token is close enough to compare tools. */
function estimateTokens(text: string): number {
	return Math.round(text.length / 3.6);
}

function toInfo(effective: ToolPromptSource, base: ToolPromptSource, overridden: boolean, dataDir: string): ToolPromptInfo {
	// Exactly the object the provider is sent for this tool.
	const wire = effective.parameters
		? { name: effective.name, description: effective.description, input_schema: effective.parameters }
		: undefined;
	const promptText = [effective.description, effective.prompt?.snippet ?? "", ...(effective.prompt?.guidelines ?? [])].join("\n");
	return {
		name: effective.name,
		mode: effective.mode ?? "RW",
		scope: effective.scope ?? "main",
		description: effective.description,
		snippet: effective.prompt?.snippet,
		guidelines: effective.prompt?.guidelines,
		content: serializeToolPrompt(effective),
		path: overridden ? toolOverridePath(dataDir, effective.name) : undefined,
		source: overridden ? "override" : "builtin",
		overridden,
		baseContent: serializeToolPrompt(base),
		schema: wire ? JSON.stringify(wire, null, 2) : undefined,
		schemaTokens: wire ? estimateTokens(JSON.stringify(wire)) : undefined,
		promptTokens: estimateTokens(promptText),
	};
}

async function loadAll(ctx: ServerContext): Promise<ToolPromptInfo[]> {
	const dataDir = ctx.config.dataDir;
	const overrides = await loadToolOverrides(dataDir);
	const base = builtinToolPromptSources();
	const effective = effectiveToolPromptSources(overrides);
	return effective.map((e, i) => toInfo(e, base[i], overrides.has(e.name), dataDir));
}

export function createToolPromptsRouter(ctx: ServerContext): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		res.json(await loadAll(ctx));
	});

	router.get("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidToolName(name)) return res.status(400).json({ error: "invalid tool name" });
		const found = (await loadAll(ctx)).find((t) => t.name === name);
		if (!found) return res.status(404).json({ error: "tool not found" });
		res.json(found);
	});

	// Copy-on-write: the edited `.md` is stored and merged over the code default.
	// A key the file omits keeps the code's value, so a partial edit is legal.
	router.put("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidToolName(name)) return res.status(400).json({ error: "invalid tool name" });
		if (!builtinToolPromptSources().some((t) => t.name === name)) {
			return res.status(404).json({ error: "tool not found" });
		}
		const body = (req.body ?? {}) as { content?: unknown };
		if (typeof body.content !== "string" || !body.content.trim()) {
			return res.status(400).json({ error: "content required" });
		}
		// A description is what the provider actually receives — refuse to write an
		// override that would blank it (frontmatter only, empty body).
		if (!parseToolPrompt(body.content).description) {
			return res.status(400).json({ error: "the body (the tool description) must not be empty" });
		}
		const path = await writeToolOverride(ctx.config.dataDir, name, body.content);
		res.json({ name, path, overridden: true });
	});

	router.delete("/:name", async (req, res) => {
		const name = req.params.name;
		if (!isValidToolName(name)) return res.status(400).json({ error: "invalid tool name" });
		const removed = await removeToolOverride(ctx.config.dataDir, name);
		if (!removed) return res.status(404).json({ error: "no override to reset" });
		res.status(204).end();
	});

	return router;
}
