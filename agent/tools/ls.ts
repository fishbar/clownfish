/**
 * ls tool — list the contents of a directory with type and size.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readdir, stat } from "node:fs/promises";
import { relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { resolveJailedPath, type JailContext } from "./fs-jail";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (defaults to the workspace cwd)." })),
	all: Type.Optional(Type.Boolean({ description: "Include hidden (dotfile) entries. Default false." })),
});

export interface LsToolOptions {
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}


function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function createLsTool(cwd: string, options?: LsToolOptions): ToolDefinition<typeof lsSchema, undefined> {
	return defineTool<typeof lsSchema, undefined>({
		name: "ls",
		label: "ls",
		mode: "R",
		description: "List the contents of a directory (default the workspace cwd), showing each entry's type (file/dir) and size.",
		parameters: lsSchema,
		prompt: {
			snippet: "List directory contents",
			guidelines: [
				"A quick directory overview; `find` searches recursively by name. Do not shell out to `ls` — the output would ride in the conversation for the rest of the session.",
			],
		},
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
			const dir = params.path ? await resolveJailedPath(params.path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "ls", signal, approval: options.jailApproval } : undefined, options?.root) : cwd;
			const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
				throw new Error(`Could not list ${params.path ?? cwd}: ${err instanceof Error ? err.message : String(err)}`);
			});

			const visible = entries
				.filter((e) => (params.all ? true : !e.name.startsWith(".")))
				.sort((a, b) => {
					if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
					return a.name.localeCompare(b.name);
				});

			const lines: string[] = [];
			for (const entry of visible) {
				const abs = `${dir}/${entry.name}`;
				if (entry.isDirectory()) {
					lines.push(`${entry.name}/`);
				} else if (entry.isSymbolicLink()) {
					lines.push(`${entry.name}@`);
				} else {
					const s = await stat(abs).catch(() => null);
					const size = s && s.size !== undefined ? formatBytes(s.size) : "-";
					lines.push(`${entry.name}\t${size}`);
				}
			}
			const header = relative(cwd, dir) || ".";
			const text = lines.length === 0 ? `${header}/ (empty)` : `${header}/\n${lines.join("\n")}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
