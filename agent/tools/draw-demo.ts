/**
 * draw_demo tool — publish a self-contained HTML demo for the user.
 *
 * The main agent calls `draw_demo({ files, entry? })` when a reply deserves a
 * live, interactive artifact rather than prose: the files (index.html plus any
 * css/js/images) are written under `<sessionsDir>/<sessionId>/demo/<demoId>/`
 * and the tool returns a URL the chat UI renders — links to it open the demo in
 * the right-side viewer, automatically on arrival.
 *
 * Deliberately narrow: relative paths only (no `..`, no absolute, no symlinks
 * out), bounded sizes, no overwrite of an existing demo id. The demo directory
 * lives inside the session directory, so it is deleted with the session.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition, type ToolMeta } from "./definition";
import { generateId } from "../id";

/** Hard bounds — a demo is a UI sketch, not a data drop. */
export const DEMO_MAX_FILES = 50;
export const DEMO_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per file
export const DEMO_MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MiB per demo

const demoSchema = Type.Object({
	files: Type.Array(
		Type.Object({
			path: Type.String({ description: "File path inside the demo, relative (e.g. \"index.html\", \"css/style.css\")." }),
			content: Type.String({ description: "Full file content (text). Images must be inlined or referenced by external URL." }),
		}),
		{ minItems: 1, description: "All files of the demo. Must include the entry HTML file." },
	),
	entry: Type.Optional(Type.String({ description: "Entry file (default \"index.html\")." })),
});

export type DrawDemoToolInput = Static<typeof demoSchema>;

export interface DrawDemoToolDeps {
	/** Project id (URL path segment). */
	projectId: string;
	/** Session id — the demo directory lives inside this session's directory. */
	sessionId: string;
	/** Transcript root (same one SessionTranscript uses). */
	sessionsDir: string;
}

/** A relative demo-internal path is safe when it stays inside the demo dir. */
function safeRel(p: string): string | undefined {
	if (!p || p.includes("\0")) return undefined;
	if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return undefined;
	const parts = p.split(/[/\\]+/).filter(Boolean);
	if (parts.length === 0) return undefined;
	for (const part of parts) {
		if (part === ".." || part === ".") return undefined;
		// Obscure but real escapes / surprises — reject rather than reason about.
		if (part.startsWith(".") && part !== ".well-known") return undefined;
	}
	return parts.join("/");
}

/** The URL the chat UI turns into a right-side viewer (also user-clickable). */
export function demoUrl(projectId: string, sessionId: string, demoId: string): string {
	return `/api/projects/${projectId}/sessions/${sessionId}/demos/${demoId}/`;
}

export const DRAW_DEMO_TOOL_META = {
	name: "draw_demo",
	mode: "W",
	parameters: demoSchema,
	description:
		"Publish a MULTI-FILE HTML demo for the user and get a URL for your reply. Only for demos one ```html fence cannot show (separate css/js/images that can't be inlined); single-file visuals go directly in a ```html fence — no tool.",
	prompt: {
		snippet: "Publish a multi-file HTML demo artifact",
		guidelines: [
			"Default to a ```html fence in your reply (rendered inline, no tool). Call draw_demo only when one file genuinely isn't enough.",
			"Every file's content is passed inline (text only). Reference libraries by external URL, not by local paths outside the demo.",
		],
	},
} satisfies ToolMeta;

export function createDrawDemoTool(deps: DrawDemoToolDeps): ToolDefinition<typeof demoSchema, { url: string; demoId: string; files: string[] }> {
	return defineTool<typeof demoSchema, { url: string; demoId: string; files: string[] }>({
		...DRAW_DEMO_TOOL_META,
		label: "draw_demo",
		parameters: demoSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<{ url: string; demoId: string; files: string[] }>> {
			if (params.files.length > DEMO_MAX_FILES) {
				return err(`Too many files (${params.files.length} > ${DEMO_MAX_FILES}).`);
			}
			const entry = safeRel(params.entry ?? "index.html");
			if (!entry) return err("Invalid entry path — must be a plain relative path.");

			// Validate everything BEFORE writing anything (all-or-nothing publish).
			let total = 0;
			const seen = new Set<string>();
			const plan: Array<{ rel: string; content: string }> = [];
			for (const f of params.files) {
				const rel = safeRel(f.path);
				if (!rel) return err(`Invalid file path '${f.path}' — use plain relative paths inside the demo.`);
				if (seen.has(rel)) return err(`Duplicate file path '${f.path}'.`);
				seen.add(rel);
				const bytes = Buffer.byteLength(f.content, "utf8");
				if (bytes > DEMO_MAX_FILE_BYTES) return err(`File '${f.path}' is ${bytes} bytes (max ${DEMO_MAX_FILE_BYTES}).`);
				total += bytes;
				if (total > DEMO_MAX_TOTAL_BYTES) return err(`Demo exceeds ${DEMO_MAX_TOTAL_BYTES} bytes total.`);
				plan.push({ rel, content: f.content });
			}
			if (!seen.has(entry)) return err(`Entry file '${entry}' is not among the files.`);

			const demoId = generateId();
			const root = join(deps.sessionsDir, deps.sessionId, "demo", demoId);
			await fsMkdir(root, { recursive: true });
			for (const f of plan) {
				const abs = join(root, f.rel);
				await fsMkdir(dirname(abs), { recursive: true });
				await fsWriteFile(abs, f.content, "utf8");
			}

			const url = demoUrl(deps.projectId, deps.sessionId, demoId);
			const files = plan.map((f) => f.rel).sort();
			return {
				content: [{ type: "text", text: `Demo published: ${url}\nFiles: ${files.join(", ")}` }],
				details: { url, demoId, files },
			};
		},
	});
}

function err(message: string): AgentToolResult<{ url: string; demoId: string; files: string[] }> {
	return { content: [{ type: "text", text: `draw_demo: ${message}` }], details: { url: "", demoId: "", files: [] } };
}
