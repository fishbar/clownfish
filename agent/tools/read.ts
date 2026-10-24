/**
 * read tool — read a file's contents (text or image).
 *
 * Adapted from pi's read tool: offset/limit + head-truncation with actionable
 * continuation notices. Drops pi's TUI rendering, image resizing (the model
 * handles raw images), and pi-specific docs/skill classification.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { resolveJailedPath, type JailContext } from "./fs-jail";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, type TruncationResult } from "./truncate";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative to the workspace cwd or absolute)." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});
export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => string | null;
}

export interface ReadToolOptions {
	operations?: ReadOperations;
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}

const IMAGE_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

function detectImageMimeByExt(absolutePath: string): string | null {
	const lower = basename(absolutePath).toLowerCase();
	for (const [ext, mime] of Object.entries(IMAGE_MIME)) {
		if (lower.endsWith(ext)) return mime;
	}
	return null;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectImageMimeByExt,
};

export function createReadTool(cwd: string, options?: ReadToolOptions): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const ops = options?.operations ?? defaultReadOperations;
	return defineTool<typeof readSchema, ReadToolDetails | undefined>({
		name: "read",
		label: "read",
		mode: "R",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp); images are returned as attachments. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever hits first). Use offset/limit for large files; continue with a larger offset until the file is fully read.`,
		parameters: readSchema,
		prompt: {
			snippet: "Read file contents (with offset/limit windows)",
			guidelines: [
				"This is how you look at a file — never `cat`/`head`/`sed` through bash.",
				"Read a file before editing it — never write an edit against remembered or assumed contents.",
				"After a grep hit, read a WINDOW around it (`offset` near the line, `limit` 40-80) rather than the whole file: everything you read stays in the conversation and is re-sent on every later turn, so a 2,000-line file read to see one function costs that much on every turn after it.",
				"When you genuinely need all of a large file, page through it with `offset` until the end.",
			],
		},
		async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate): Promise<AgentToolResult<ReadToolDetails | undefined>> {
			const absolutePath = await resolveJailedPath(path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "read", signal, approval: options.jailApproval } : undefined, options?.root);
			if (signal?.aborted) throw new Error("Operation aborted");
			await ops.access(absolutePath);
			if (signal?.aborted) throw new Error("Operation aborted");

			const mimeType = ops.detectImageMimeType ? ops.detectImageMimeType(absolutePath) : null;
			if (mimeType) {
				const buffer = await ops.readFile(absolutePath);
				const data = buffer.toString("base64");
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: `Read image file [${mimeType}] (${formatSize(buffer.length)})` },
					{ type: "image", data, mimeType },
				];
				return { content, details: undefined };
			}

			const buffer = await ops.readFile(absolutePath);
			if (signal?.aborted) throw new Error("Operation aborted");
			const allLines = buffer.toString("utf-8").split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit and cannot be shown whole — this is generated/minified content. Use grep with a specific pattern to find what you need inside it.]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	});
}
