/**
 * Prompt compaction — strip the formatting that exists for human readers.
 *
 * Agent prompts are authored as markdown because people edit them (in the repo,
 * and in the settings page). The model does not need the decoration: emphasis
 * markers, heading hashes, blank-line padding and aligned whitespace all cost
 * tokens on EVERY request of a session, and the system prompt is re-sent each
 * time. On short sessions that fixed prefix dominates the bill.
 *
 * What this does NOT do is rewrite prose. Meaning-preserving means exactly that:
 * the words survive, only the typography goes. Anything smarter — summarizing
 * instructions, dropping "redundant" sentences — is a behaviour change wearing a
 * cost-saving costume, and this codebase has already measured how sensitive the
 * agent is to small wording and placement changes.
 *
 * Fenced code blocks, inline code spans and indented blocks are preserved
 * byte-for-byte: they carry examples, `{placeholders}` and JSON shapes where
 * whitespace is meaning.
 */

/** Split on fenced code blocks, keeping the fences as untouched segments. */
function splitFences(text: string): Array<{ code: boolean; text: string }> {
	const out: Array<{ code: boolean; text: string }> = [];
	const re = /(^|\n)(```|~~~)[\s\S]*?\n\2[ \t]*(?=\n|$)/g;
	let last = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
		out.push({ code: true, text: m[0] });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ code: false, text: text.slice(last) });
	return out;
}

/** Protect inline code spans while a transform runs over the rest of a line. */
function outsideCode(line: string, fn: (s: string) => string): string {
	return line
		.split(/(`[^`]*`)/)
		.map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part : fn(part)))
		.join("");
}

function compactProse(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let blank = false;
	for (const raw of lines) {
		// An indented block (4+ spaces / a tab) is a code sample — leave it alone.
		if (/^(\t| {4,})\S/.test(raw)) {
			out.push(raw.replace(/[ \t]+$/, ""));
			blank = false;
			continue;
		}
		let line = raw.replace(/[ \t]+$/, "");
		if (line.trim() === "") {
			// Collapse runs of blank lines to one: paragraph separation survives,
			// the padding does not.
			if (!blank && out.length > 0) out.push("");
			blank = true;
			continue;
		}
		blank = false;
		line = outsideCode(line, (s) =>
			s
				// Heading hashes: the line break already marks the boundary.
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				// Bold / italic / bold-italic emphasis.
				.replace(/\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*/g, "$1")
				.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, "$1")
				.replace(/(^|[\s(])\*(\S(?:[^*]*?\S)?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
				.replace(/(^|[\s(])_(\S(?:[^_]*?\S)?)_(?=[\s).,;:!?]|$)/g, "$1$2")
				// Markdown links: the label is the content, the URL is for clicking.
				.replace(/\[([^\]]+)\]\((?:[^)\s]+)\)/g, "$1")
				// Runs of spaces used for alignment.
				.replace(/(\S)  +/g, "$1 "),
		);
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Compact a prompt for the model. Returns the input unchanged when compaction
 * would not help, so callers can compare sizes honestly.
 */
export function compactPrompt(text: string): string {
	if (!text) return text;
	const compacted = splitFences(text)
		.map((seg) => (seg.code ? seg.text : compactProse(seg.text)))
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return compacted.length < text.length ? `${compacted}\n` : text;
}

/**
 * Size above which an operator-authored prompt is compacted automatically.
 *
 * Measured on the built-in prompts the saving is 0.76% — they are prose, with
 * almost no decoration to strip, so compacting them buys nothing and only adds a
 * way for the text the model reads to differ from the text a person edited. A
 * long hand-written or pasted document is the opposite case: a markdown-heavy
 * prompt compacts by ~18%, and at that size it is paid for on every request.
 *
 * So the rule is size-triggered rather than global: below the threshold the file
 * reaches the model exactly as written. Configure with
 * `CLOWNFISH_PROMPT_COMPACT_THRESHOLD` (bytes).
 */
export const DEFAULT_COMPACT_THRESHOLD = 16 * 1024;

export function compactThreshold(): number {
	const raw = Number(process.env.CLOWNFISH_PROMPT_COMPACT_THRESHOLD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPACT_THRESHOLD;
}

/**
 * Compact only a prompt large enough to be worth it. Returns the text unchanged
 * below the threshold, and reports whether it acted so the caller can say so.
 */
export function compactIfLarge(text: string, threshold = compactThreshold()): { text: string; compacted: boolean } {
	if (Buffer.byteLength(text, "utf8") <= threshold) return { text, compacted: false };
	const out = compactPrompt(text);
	return { text: out, compacted: out !== text };
}

/**
 * Global compaction, OFF by default: applying it to every prompt saves under 1%
 * on the shipped ones and is not worth making the model's text differ from the
 * operator's. `CLOWNFISH_COMPACT_PROMPTS=1` forces it on everywhere.
 */
export function promptCompactionEnabled(): boolean {
	return process.env.CLOWNFISH_COMPACT_PROMPTS === "1";
}

/** Apply only when globally enabled — the call site stays a one-liner. */
export function maybeCompactPrompt(text: string): string {
	return promptCompactionEnabled() ? compactPrompt(text) : text;
}
