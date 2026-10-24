/**
 * ripgrep as an OPTIONAL backend for the grep tool.
 *
 * The model never learns whether `rg` exists: the tool's contract (pattern /
 * include / context / maxResults / outputMode) is identical either way, and a
 * missing or failing `rg` falls back to the in-process walker. Telling the
 * model "use rg if available" would be the wrong shape — it cannot know what
 * is installed, and a guess costs a wasted turn.
 *
 * Why it is worth having at all, measured on this machine:
 *
 *   249-file repo      rare symbol   built-in   51ms   rg   13ms
 *   17,432-file tree   rare symbol   built-in 4755ms   rg  276ms   (17x)
 *   17,432-file tree   common word   built-in  172ms   rg  355ms   (built-in wins)
 *
 * The built-in wins when matches are plentiful because it stops at
 * `maxResults`; rg wins decisively when a search must scan everything, which
 * is the case that is slow enough for a person to notice. So rg is used
 * whenever it is present.
 *
 * Fallback is not only about absence: rg's regex engine (Rust `regex`) rejects
 * backreferences and lookaround, which JavaScript accepts. A pattern rg cannot
 * compile returns null here and is served by the in-process engine, so no
 * search fails for having used a construct the backend does not share.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { matchGlob } from "./glob";

const execFileAsync = promisify(execFile);

/** Probe result, resolved once per process (an absent binary must not cost a spawn per search). */
let probe: Promise<boolean> | undefined;

/** Is a real `rg` executable callable? Cached. */
export function rgAvailable(): Promise<boolean> {
	if (process.env.CLOWNFISH_RG === "0") return Promise.resolve(false);
	probe ??= execFileAsync("rg", ["--version"], { timeout: 3000 })
		.then(() => true)
		.catch(() => false);
	return probe;
}

/** Reset the cached probe (tests only). */
export function resetRgProbe(): void {
	probe = undefined;
}

/** Hard ceiling for one rg run — a backend must never be able to hang a turn. */
const RG_TIMEOUT_MS = 20_000;

export interface RgSearchOptions {
	root: string;
	pattern: string;
	/** Same glob semantics as the in-process engine (applied here, not by rg). */
	include?: string;
	caseInsensitive?: boolean;
	/** Lines of context around each match (rg -C). */
	context?: number;
	/** Global match cap (rg's own --max-count is per file, so this is enforced here). */
	maxResults: number;
	/** `files_with_matches` mode: return paths only. */
	filesOnly?: boolean;
	signal?: AbortSignal;
}

export interface RgSearchResult {
	/** Output lines, already in the tool's own format. */
	lines: string[];
	/** Distinct files that matched, in first-seen order. */
	files: string[];
	/** True when the cap stopped the search. */
	truncated: boolean;
}

/** Searching "." makes rg print "./a/b"; the tool's own format has no prefix. */
function stripDot(path: string): string {
	return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Field separators rg is told to use instead of `:`/`-`: control bytes that
 * cannot appear in a path. Guessing the separator out of `path:123:text` was
 * measured to mis-parse any path containing `-<digits>-` (issue-42-fix/…),
 * which corrupted the path, flipped match→context, and defeated maxResults.
 */
const MATCH_SEP = "\x1f";
const CONTEXT_SEP = "\x1e";

function splitRgLine(line: string): { path: string; lineNo: number; text: string; isMatch: boolean } | undefined {
	const isMatch = line.includes(MATCH_SEP);
	const sep = isMatch ? MATCH_SEP : CONTEXT_SEP;
	const a = line.indexOf(sep);
	if (a < 0) return undefined;
	const b = line.indexOf(sep, a + 1);
	if (b < 0) return undefined;
	const lineNo = Number(line.slice(a + 1, b));
	if (!Number.isFinite(lineNo)) return undefined;
	return { path: line.slice(0, a), lineNo, text: line.slice(b + 1), isMatch };
}

/**
 * Run rg and return results in the grep tool's own output shape, or null when
 * rg is unusable for this search (absent, failed to start, bad regex, aborted)
 * — the caller then uses the in-process engine.
 */
export async function rgSearch(opts: RgSearchOptions): Promise<RgSearchResult | null> {
	if (!(await rgAvailable())) return null;

	const args = ["--line-number", "--no-heading", "--color=never", "--with-filename"];
	if (opts.caseInsensitive) args.push("--ignore-case");
	if (opts.context && opts.context > 0) args.push("--context", String(opts.context));
	if (opts.filesOnly) args.push("--files-with-matches");
	// `include` is deliberately NOT passed as rg's --glob: rg's glob dialect is
	// not ours, and an engine swap that quietly changes which files are searched
	// is worse than a slower search. The tool's own matcher runs on the results.
	// Long lines are truncated by the tool afterwards; this keeps rg from
	// streaming a minified bundle's single 2MB line through the pipe first.
	args.push("--max-columns", "2000", "--max-columns-preview");
	args.push("--field-match-separator", MATCH_SEP, "--field-context-separator", CONTEXT_SEP);
	// Belt and braces: rg's glob only NARROWS what it reads (perf — a narrow
	// include over a big tree should not scan everything); our own matcher
	// below stays the authority on what is returned.
	if (opts.include) args.push("--glob", opts.include.includes("/") ? opts.include : `**/${opts.include}`);
	// The search path is ALWAYS explicit. A path-less rg treats a non-tty stdin
	// as the thing to search and blocks forever — measured here, and the same
	// trap rtk-ai/rtk#2301 reports.
	args.push("--regexp", opts.pattern, ".");

	return await new Promise<RgSearchResult | null>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("rg", args, { cwd: opts.root, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve(null);
			return;
		}
		const lines: string[] = [];
		const files: string[] = [];
		const seen = new Set<string>();
		let matches = 0;
		let truncated = false;
		let buffer = "";
		let stderr = "";
		let done = false;
		// A pattern with no slash (the advertised '*.ts') means "files named
		// like this ANYWHERE" — match the basename too, or nested files are
		// silently invisible and the model gets a confident "No matches".
		const keep = (path: string): boolean => {
			const inc = opts.include;
			if (!inc) return true;
			return matchGlob(inc, path) || (!inc.includes("/") && matchGlob(inc, path.split("/").pop() ?? path));
		};
		const timer = setTimeout(() => {
			console.warn(`[grep] rg exceeded ${RG_TIMEOUT_MS}ms; using the built-in engine`);
			finish(null);
		}, RG_TIMEOUT_MS);

		const finish = (value: RgSearchResult | null): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			child.kill("SIGKILL");
			resolve(value);
		};
		function onAbort(): void {
			finish(null);
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const takeLine = (raw: string): void => {
			if (raw === "--") {
				// rg's block separator; keep ours only between real blocks.
				if (lines.length > 0) lines.push("--");
				return;
			}
			if (opts.filesOnly) {
				const path = stripDot(raw);
				if (!keep(path)) return;
				if (!seen.has(path)) {
					seen.add(path);
					files.push(path);
					matches++;
				}
				if (matches >= opts.maxResults) {
					truncated = true;
					finish({ lines, files, truncated });
				}
				return;
			}
			const parsed = splitRgLine(raw);
			if (!parsed) return;
			const path = stripDot(parsed.path);
			if (!keep(path)) return;
			if (!seen.has(path)) {
				seen.add(path);
				files.push(path);
			}
			lines.push(`${path}:${parsed.lineNo}${parsed.isMatch ? ":" : "-"} ${parsed.text}`);
			if (parsed.isMatch) {
				matches++;
				if (matches >= opts.maxResults) {
					truncated = true;
					finish({ lines, files, truncated });
				}
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			// After finish() the arrays are already resolved to the caller —
			// a late chunk must not mutate them (measured: a duplicated final
			// row). And the consumed line must leave the buffer BEFORE the done
			// check, or a mid-chunk finish re-parses it on the next event.
			if (done) return;
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				takeLine(line);
				if (done) return;
				nl = buffer.indexOf("\n");
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			if (done) return;
			if (buffer) takeLine(buffer);
			if (done) return;
			// 0 = matches, 1 = no matches, anything else (2 = bad regex/usage) is
			// a case the in-process engine may still handle.
			if (code !== 0 && code !== 1) {
				if (stderr) console.warn(`[grep] rg unusable for this search (${stderr.trim().split("\n")[0]}); using the built-in engine`);
				finish(null);
				return;
			}
			finish({ lines, files, truncated });
		});
	});
}
