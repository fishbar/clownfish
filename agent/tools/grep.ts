/**
 * grep tool — search file contents with a regex across the workspace.
 *
 * Pure-JS implementation (no ripgrep dependency): walks files respecting
 * .gitignore, matches line-by-line, supports an include glob and two output
 * modes. For very large/complex searches the model can fall back to bash `rg`.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { open, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { matchGlob } from "./glob";
import { walkFiles } from "./fs-walk";
import { resolveJailedPath, type JailContext } from "./fs-jail";
import { GREP_MAX_LINE_LENGTH, truncateLine } from "./truncate";
import { rgSearch } from "./search-backend";

/**
 * A file this big is generated, minified or binary — never something a person
 * greps for a symbol. Reading it costs far more than the match is worth.
 */
const MAX_SEARCHABLE_BYTES = 2 * 1024 * 1024;
/** Bytes sniffed for a NUL, which is how every grep decides "this is binary". */
const BINARY_SNIFF_BYTES = 8192;

/** Read a file for searching, or null when it is too big or not text. */
async function readSearchable(file: string): Promise<string | null> {
	const st = await stat(file).catch(() => null);
	if (!st || !st.isFile() || st.size > MAX_SEARCHABLE_BYTES) return null;
	if (st.size === 0) return "";
	// Sniff first: a NUL byte in the head means binary, and reading the rest
	// would only produce mojibake matches that pollute the answer.
	const fh = await open(file, "r").catch(() => null);
	if (!fh) return null;
	try {
		const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size));
		await fh.read(buf, 0, buf.length, 0);
		if (buf.includes(0)) return null;
	} finally {
		await fh.close().catch(() => undefined);
	}
	return readFile(file, "utf8").catch(() => null);
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression to search for. Alternation searches several terms at once: 'foo|bar|baz'." }),
	path: Type.Optional(Type.String({ description: "File or directory to search (defaults to the workspace cwd)." })),
	include: Type.Optional(Type.String({ description: "Glob filter for file paths to include, e.g. '*.ts' or 'src/**'." })),
	caseInsensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive matching. Default false." })),
	outputMode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches")], {
			description: "'content' (default) prints matching lines with file:line; 'files_with_matches' lists only file paths.",
		}),
	),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of matches to return. Default 100." })),
	context: Type.Optional(
		Type.Number({
			description: "Lines of surrounding context to show around each match (like grep -C). Default 0. Use 2-3 to read a hit in place instead of opening the file.",
		}),
	),
});

export interface GrepToolOptions {
	/** Consent callback for outside-workspace paths (see fs-jail.ts). */
	jailApproval?: JailContext["approval"];
	/** Workspace root containing the cwd — widens the allowed area so the agent may climb up to it (see fs-jail.ts). */
	root?: string;
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): ToolDefinition<typeof grepSchema, undefined> {
	return defineTool<typeof grepSchema, undefined>({
		name: "grep",
		label: "grep",
		mode: "R",
		description:
			"Search file contents with a regular expression across the workspace (or a path/file). Respects .gitignore. Use include to limit by glob. Returns matching lines (file:line: text) or, in files_with_matches mode, just the matching file paths. Each match line is truncated to 500 chars.",
		parameters: grepSchema,
		prompt: {
			snippet: "Search file contents by regex (gitignore-aware, capped output)",
			guidelines: [
				"This is the search tool — never shell out to `grep`/`rg`. It skips what `.gitignore` skips (`node_modules`, `dist`, `.git`), stops at `maxResults`, and truncates long lines, so a search costs a few hundred tokens instead of flooding the conversation with matches you will re-send every turn.",
				"Search several terms in ONE call with alternation: `foo|bar|baz`. Narrow with `include` ('*.ts') and a precise pattern before raising `maxResults`.",
				"Set `context` to 2-3 to read each hit in place — overlapping windows are merged into one block, which is usually enough to answer the question without opening the file at all.",
			],
		},
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
			const flags = params.caseInsensitive ? "i" : "";
			let regex: RegExp;
			try {
				regex = new RegExp(params.pattern, flags);
			} catch (err) {
				throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
			}
			const outputMode = params.outputMode ?? "content";
			const maxResults = params.maxResults ?? 100;
			const root = params.path ? await resolveJailedPath(params.path, cwd, options?.jailApproval ? { toolCallId: _toolCallId, tool: "grep", signal, approval: options.jailApproval } : undefined, options?.root) : cwd;

			// ---- optional ripgrep backend --------------------------------------
			// Same contract, same caps, same output shape — it is an engine swap,
			// not a different tool. null means "rg is absent or cannot serve this
			// search" (a pattern its regex engine rejects, an abort), and the
			// in-process walker below answers instead.
			const viaRg = await rgSearch({
				root,
				pattern: params.pattern,
				include: params.include,
				caseInsensitive: params.caseInsensitive,
				context: Math.max(0, Math.floor(params.context ?? 0)),
				maxResults,
				filesOnly: outputMode !== "content",
				signal,
			});
			if (viaRg) {
				const rows = outputMode === "content" ? viaRg.lines.map((l) => truncateLine(l, GREP_MAX_LINE_LENGTH + 80).text) : viaRg.files;
				let out = rows.length === 0 ? `No matches for /${params.pattern}/${flags}` : rows.join("\n");
				if (viaRg.truncated) out += `\n\n[Truncated at ${maxResults} matches. Refine your pattern or raise maxResults.]`;
				return { content: [{ type: "text", text: out }], details: undefined };
			}

			// Determine candidate files: a single file, or a directory walk.
			let files: string[];
			const rootStat = await stat(root).catch(() => null);
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!rootStat) {
				throw new Error(`Path does not exist: ${params.path ?? cwd}`);
			}
			if (rootStat.isFile()) {
				files = [root];
			} else {
				files = await walkFiles(root, { maxFiles: 20000 });
			}
			if (params.include) {
				const inc = params.include;
				// No slash in the pattern = match by basename anywhere (see the
				// same rule in search-backend.ts — both engines must agree).
				files = files.filter((f) => {
					const rel = relative(root, f);
					return matchGlob(inc, rel) || matchGlob(inc, f) || (!inc.includes("/") && matchGlob(inc, rel.split("/").pop() ?? rel));
				});
			}

			// `context` (like grep -C) prints the lines around each hit. Overlapping
			// windows are merged, so a cluster of matches reads as one block instead
			// of repeating the same lines once per match — the reason a model
			// otherwise reaches for `bash grep -C` and pays for the whole file.
			const context = Math.max(0, Math.floor(params.context ?? 0));
			const matchedFiles: string[] = [];
			const lines: string[] = [];
			let count = 0;

			for (const file of files) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (count >= maxResults) break;
				const content = await readSearchable(file);
				if (content === null) continue;
				const fileLines = content.split("\n");
				const rel = relative(cwd, file);
				const hits: number[] = [];
				for (let i = 0; i < fileLines.length && count + hits.length < maxResults; i++) {
					if (regex.test(fileLines[i])) hits.push(i);
				}
				if (hits.length === 0) continue;
				matchedFiles.push(rel);
				count += hits.length;
				if (outputMode !== "content") continue;
				if (context === 0) {
					for (const i of hits) lines.push(`${rel}:${i + 1}: ${truncateLine(fileLines[i], GREP_MAX_LINE_LENGTH).text}`);
					continue;
				}
				const isHit = new Set(hits);
				// Merge the [hit-context, hit+context] windows, then emit each block
				// once with `:` marking matches and `-` marking context, as grep does.
				let blockStart = -1;
				let blockEnd = -1;
				const flush = (): void => {
					if (blockStart < 0) return;
					if (lines.length > 0) lines.push("--");
					for (let i = blockStart; i <= blockEnd; i++) {
						lines.push(`${rel}:${i + 1}${isHit.has(i) ? ":" : "-"} ${truncateLine(fileLines[i], GREP_MAX_LINE_LENGTH).text}`);
					}
				};
				for (const h of hits) {
					const from = Math.max(0, h - context);
					const to = Math.min(fileLines.length - 1, h + context);
					if (blockStart < 0) {
						blockStart = from;
						blockEnd = to;
					} else if (from <= blockEnd + 1) {
						blockEnd = Math.max(blockEnd, to);
					} else {
						flush();
						blockStart = from;
						blockEnd = to;
					}
				}
				flush();
			}

			const out = outputMode === "content" ? lines : matchedFiles;
			let text = out.length === 0 ? `No matches for /${params.pattern}/${flags}` : out.join("\n");
			if (count >= maxResults) text += `\n\n[Truncated at ${maxResults} matches. Refine your pattern or raise maxResults.]`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
