/**
 * find tool — find files/directories by name glob across the workspace.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { buildIgnore } from "./fs-walk";
import { matchGlob } from "./glob";
import { resolveJailedPath, type JailContext } from "./fs-jail";

const findSchema = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Name glob to match against file/directory names, e.g. '*.test.ts'. If omitted, lists everything." })),
	path: Type.Optional(Type.String({ description: "Directory to search (defaults to the workspace cwd)." })),
	type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir")], { description: "Restrict to 'file' or 'dir' entries." })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of results. Default 200." })),
});

export interface FindToolOptions {
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}

export function createFindTool(cwd: string, options?: FindToolOptions): ToolDefinition<typeof findSchema, undefined> {
	return defineTool<typeof findSchema, undefined>({
		name: "find",
		label: "find",
		mode: "R",
		description:
			"Find files and directories by name glob across the workspace (or a path). Respects .gitignore. Use pattern to match names, type to restrict to files or directories.",
		parameters: findSchema,
		prompt: {
			snippet: "Find files/directories by name",
			guidelines: [
				"Locate files by name/glob here and search their contents with grep — never shell out to `find`, which walks `node_modules` and returns everything it sees.",
			],
		},
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
			const root = params.path ? await resolveJailedPath(params.path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "find", signal, approval: options.jailApproval } : undefined, options?.root) : cwd;
			const ig = await buildIgnore(root);
			const maxResults = params.maxResults ?? 200;
			const results: string[] = [];
			let stopped = false;

			async function walk(dir: string): Promise<void> {
				if (stopped) return;
				let entries: import("node:fs").Dirent[];
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					if (stopped) return;
					const abs = join(dir, entry.name);
					const rel = relative(root, abs);
					if (ig.ignores(rel) && rel !== ".") continue;

					const isDir = entry.isDirectory();
					const isFile = entry.isFile();
					if (params.type === "file" && !isFile) {
						// still recurse into dirs
					} else if (params.type === "dir" && !isDir) {
						// skip
					} else {
						if (!params.pattern || matchGlob(params.pattern, entry.name)) {
							results.push(relative(cwd, abs));
							if (results.length >= maxResults) {
								stopped = true;
								return;
							}
						}
					}
					if (isDir) await walk(abs);
				}
			}

			await walk(root);
			if (signal?.aborted) throw new Error("Operation aborted");

			let text = results.length === 0 ? `No matches${params.pattern ? ` for '${params.pattern}'` : ""} under ${relative(cwd, root) || "."}` : results.join("\n");
			if (results.length >= maxResults) text += `\n\n[Truncated at ${maxResults} results. Narrow your search or raise maxResults.]`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
