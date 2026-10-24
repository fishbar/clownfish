/**
 * write tool — create or overwrite a file.
 *
 * Adapted from pi's write tool: creates parent dirs, serializes per-file writes
 * via the mutation queue, and checks abort between awaits. Drops TUI rendering.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveJailedPath, type JailContext } from "./fs-jail";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative to the workspace cwd or absolute)." }),
	content: Type.String({ description: "Full content to write to the file." }),
});

export interface WriteOperations {
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

export interface WriteToolOptions {
	operations?: WriteOperations;
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export function createWriteTool(cwd: string, options?: WriteToolOptions): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return defineTool<typeof writeSchema, undefined>({
		name: "write",
		label: "write",
		mode: "W",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Use only for new files or complete rewrites — for targeted changes use edit.",
		parameters: writeSchema,
		prompt: {
			snippet: "Create or overwrite files",
			guidelines: ["Use write only for new files or complete rewrites.", "For targeted changes to an existing file, prefer edit."],
		},
		async execute(_toolCallId, { path, content }, signal): Promise<AgentToolResult<undefined>> {
			const absolutePath = await resolveJailedPath(path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "write", signal, approval: options.jailApproval } : undefined, options?.root);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				await ops.mkdir(dir);
				throwIfAborted();
				await ops.writeFile(absolutePath, content);
				throwIfAborted();
				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: undefined,
				};
			});
		},
	});
}
