/**
 * edit tool — precise edits via exact text replacement.
 *
 * Adapted from pi's edit tool: one call may carry multiple disjoint edits,
 * each matched against the original file (not incrementally); BOM + CRLF safe;
 * fuzzy matching as a fallback. Accepts the legacy flat {oldText,newText} shape
 * via prepareArguments. Drops TUI rendering.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
	type Edit,
} from "./edit-diff";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveJailedPath, type JailContext } from "./fs-jail";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. Must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative to the workspace cwd or absolute)." }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits; merge nearby changes into one edit.",
		}),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };

export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

export interface EditToolOptions {
	operations?: EditOperations;
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

/** Accept legacy flat {oldText,newText} as a single edit, and JSON-stringified edits some models emit. */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {
			/* leave as-is; validation below will reject */
		}
	}
	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args as EditToolInput;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditTool(cwd: string, options?: EditToolOptions): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	return defineTool<typeof editSchema, EditToolDetails | undefined>({
		name: "edit",
		label: "edit",
		mode: "W",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prompt: {
			snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			guidelines: [
				"Use edit for precise changes (edits[].oldText must match exactly).",
				"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls.",
				"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
				"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
			],
		},
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal): Promise<AgentToolResult<EditToolDetails | undefined>> {
			const { path, edits } = validateEditInput(input);
			const absolutePath = await resolveJailedPath(path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "edit", signal, approval: options.jailApproval } : undefined, options?.root);

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();

				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				const buffer = await ops.readFile(absolutePath);
				throwIfAborted();

				const rawContent = buffer.toString("utf-8");
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
	});
}
