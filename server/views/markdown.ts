/**
 * Minimal Markdown renderer for assistant messages (Preact `dangerouslySetInnerHTML`).
 *
 * Hand-rolled on purpose (same policy as the auth layer — no new deps): agent
 * output exercises a well-known subset — headings, lists, code fences, quotes,
 * inline code/bold/italic/links. Safety by construction: ALL text is HTML-
 * escaped BEFORE any markup is generated, and link hrefs are protocol-checked
 * (http/https/relative only), so nothing the model echoes can inject HTML.
 *
 * Not handled (renders as plain text): tables, footnotes, HTML passthrough.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** Only http(s) / rooted-relative / "./"-relative hrefs survive; else "#". */
function safeHref(url: string): string {
	const u = url.trim();
	// `\/(?!\/)` — rooted-relative yes, protocol-relative `//evil.com` no
	// (it inherits the page's scheme but the LINK's host → cross-site).
	return /^(https?:\/\/|\/(?!\/)|\.\/)/i.test(u) ? u : "#";
}

/** Inline spans: code, bold, italic, strikethrough, links. Input is already escaped. */
function inline(s: string): string {
	return s
		.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
		.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
		.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

// ---- GFM tables ------------------------------------------------------------
// Header row, then `| --- | :---: | ---: |`, then body rows. Cells split on
// literal `|` (a leading/trailing pipe is cosmetic). Alignment from the
// separator (`:--` left default, `:-:` center, `--:` right).

/** Split one table row into trimmed cells (leading/trailing pipes dropped). */
function splitRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

/** Line i is a header and line i+1 a valid separator row? */
function isTableSeparator(lines: string[], i: number): boolean {
	if (!lines[i].includes("|")) return false;
	const next = lines[i + 1];
	if (!next) return false;
	const cells = splitRow(next);
	return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c)) && splitRow(lines[i]).length === cells.length;
}

function renderTable(header: string[], body: string[][], aligns: string[]): string {
	const th = header.map((c, i) => `<th${aligns[i]}>${inline(c)}</th>`).join("");
	const trs = body.map((row) => `<tr>${header.map((_h, i) => `<td${aligns[i]}>${inline(row[i] ?? "")}</td>`).join("")}</tr>`).join("");
	return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// ---- Code syntax highlighting ----------------------------------------------
// A tiny token-level highlighter (still no deps — same policy as the rest of
// this module): good-enough keyword/string/comment/number coloring for the
// languages agents actually emit. Input is RAW (unescaped) fence body; output
// is fully escaped HTML with fixed <span class="hl-*"> wraps — the same
// safety-by-construction contract as everything here. Untagged fences get a
// cheap heuristic guess; ```diff renders per-line +/- like GitHub.

const HL_KEYWORDS: Record<string, string> = {
	typescript: "as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield true false null undefined",
	javascript: "as async await break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield true false null undefined",
	python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self",
	go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota",
	rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while",
	java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false null var record",
	csharp: "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await get set value",
	cpp: "alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register return short signed sizeof static static_cast struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while",
	c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
	ruby: "alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield attr_accessor require puts",
	php: "abstract and array as break callable case catch class clone const continue default do echo else elseif enum extends final finally fn for foreach function global goto if implements include instanceof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield true false null int string bool float void self parent",
	sql: "SELECT FROM WHERE INSERT INTO UPDATE DELETE SET VALUES CREATE TABLE ALTER DROP INDEX VIEW JOIN LEFT RIGHT INNER OUTER FULL ON AS AND OR NOT NULL IS LIKE IN BETWEEN EXISTS GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK BEGIN COMMIT ROLLBACK TRANSACTION WITH COUNT SUM AVG MIN MAX COALESCE CAST",
	bash: "if then else elif fi for while until do done case esac in function return exit break continue local export readonly declare unset shift source alias echo cd ls cat grep sed awk find xargs sort uniq head tail wc chmod chown mkdir rm cp mv ln tar curl wget ssh scp git npm npx node python pip docker make sudo set trap",
	shell: "if then else elif fi for while until do done case esac in function return exit break continue local export readonly declare unset shift source alias echo cd ls cat grep sed awk find xargs sort uniq head tail wc chmod chown mkdir rm cp mv ln tar curl wget ssh scp git npm npx node python pip docker make sudo set trap",
	json: "true false null",
	yaml: "true false null yes no on off",
	toml: "true false",
	css: "important media supports keyframes import from to and not only",
	html: "true false",
	jsx: "as async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined",
	tsx: "as async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof interface type enum implements private protected public readonly let new of return static super switch this throw try typeof var void while yield true false null undefined",
	vue: "as async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined",
	swift: "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self throw throws true try await async some any actor",
	kotlin: "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by get set import override suspend data companion lateinit reified crossinline",
	lua: "and break do else elseif end false for function if in local nil not or repeat return then true until while self",
	dockerfile: "FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS",
	ini: "true false yes no on off",
	make: "ifeq ifneq else endif include export all clean install",
	diff: "",
	text: "",
};

/** Alias → canonical language id (checked with the RAW tag too — e.g. `Makefile`). */
const HL_ALIAS: Record<string, string> = {
	ts: "typescript",
	mjs: "javascript",
	cjs: "javascript",
	node: "javascript",
	py: "python",
	python3: "python",
	rb: "ruby",
	golang: "go",
	rs: "rust",
	"c++": "cpp",
	"c#": "csharp",
	cs: "csharp",
	kt: "kotlin",
	sh: "bash",
	zsh: "bash",
	console: "bash",
	powershell: "bash",
	ps1: "bash",
	bat: "bash",
	yml: "yaml",
	htm: "html",
	svg: "html",
	xml: "html",
	docker: "dockerfile",
	Makefile: "make",
};

/** Heuristic guess for an UNTAGGED fence — cheap signals, first hit wins. */
function guessLang(body: string): string {
	const s = body.slice(0, 2000);
	if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(s) || (/^[+-]{3} \//m.test(s) && /^[-+]\S/m.test(s))) return "diff";
	if (/^\s*[{[]/.test(s) && /"[A-Za-z_-]+"\s*:/.test(s)) return "json";
	if (/^\s*(package |func \w+\(|:\s*=|\w+\s*:=)/m.test(s) && !/[;{}]\s*$/m.test(s.replace(/\n/g, ""))) return "go";
	if (/^\s*(SELECT|INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE)\b/im.test(s)) return "sql";
	if (/^\s*(def |class \w+[:(]|from \w+ import|import \w+$)/m.test(s)) return "python";
	if (/#include|std::|int main\s*\(/.test(s)) return "cpp";
	if (/^\s*(export |const |let |function |=>)/m.test(s)) return "typescript";
	if (/^\s*#!\/.*(bash|sh|zsh)\b/.test(s)) return "bash";
	if (/^\s*<!DOCTYPE|^<[a-zA-Z][\w-]*[\s>]/m.test(s)) return "html";
	if (/[.#@][\w-]+\s*\{[^}]*:[^}]+;/.test(s)) return "css";
	if (/^\s*[{[]/.test(s) && /[\w-]+\s*:\s*['"{[]/.test(s)) return "json";
	return "";
}

/**
 * Highlight one fence body → { html, lang }. `lang` is what the badge shows
 * ("text" when nothing recognized). All emitted text is escaped first; only
 * fixed class names are interpolated, never model content. Lines are wrapped
 * in <span class="hl-line"> so CSS can hang line numbers off a counter —
 * no number markup in the HTML itself (copy stays clean).
 * Exported for the tool-result panes: they render file/code-like output
 * through the SAME pipeline (badge + numbers + copy + dbl-click).
 */
export function highlight(body: string, langRaw: string): { html: string; lang: string } {
	const tag = langRaw.trim().toLowerCase();
	let lang = HL_ALIAS[langRaw.trim()] ?? HL_ALIAS[tag] ?? (HL_KEYWORDS[tag] !== undefined ? tag : "");
	if (!lang) lang = guessLang(body);
	if (lang === "html") lang = "html"; // stays html: preview path never reaches here

	if (lang === "diff") return { lang: "diff", html: diffHtml(body) };

	const kwSet = new Set((HL_KEYWORDS[lang] ?? "").split(" ").filter(Boolean));
	// Word chars incl. `$`/`@`/`#` prefixes (bash $VAR, ruby @ivar).
	const WORD = /[A-Za-z_$@#][\w$@#]*/g;

	// Comment style per language family.
	const hashComment = lang === "python" || lang === "bash" || lang === "shell" || lang === "ruby" || lang === "yaml" || lang === "toml" || lang === "make" || lang === "dockerfile" || lang === "ini";
	const dashComment = lang === "sql" || lang === "lua";
	const cLike = lang !== "" && !hashComment && !dashComment && lang !== "css" && lang !== "html" && lang !== "text";

	const lines = body.replace(/\n$/, "").split("\n");
	const out: string[] = [];
	for (const ln of lines) {
		// .hl-line renders as a BLOCK span — the line break comes from the
		// span itself, so lines are joined with NO newline between them (a
		// literal \n would show as a blank line under pre-wrap).
		out.push('<span class="hl-line">');
		const line = ln;
		let i = 0;
		while (i < line.length) {
			const two = line.slice(i, i + 2);
			if ((cLike && two === "//") || (hashComment && line[i] === "#") || (dashComment && two === "--")) {
				out.push(`<span class="hl-comment">${escapeHtml(line.slice(i))}</span>`);
				i = line.length;
				continue;
			}
			const ch = line[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				// Greedy-to-close on the same line; unterminated (mid-stream) takes the rest.
				const close = line.indexOf(ch, i + 1);
				const end = close >= 0 ? close + 1 : line.length;
				out.push(`<span class="hl-string">${escapeHtml(line.slice(i, end))}</span>`);
				i = end;
				continue;
			}
			if (/[0-9]/.test(ch) && (i === 0 || !/[\w$@#]/.test(line[i - 1]))) {
				const m = /^(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)[a-zA-Z]*/.exec(line.slice(i));
				const len = m ? m[0].length : 1;
				out.push(`<span class="hl-number">${escapeHtml(line.slice(i, i + len))}</span>`);
				i += len;
				continue;
			}
			if (/[A-Za-z_$@#]/.test(ch)) {
				WORD.lastIndex = 0;
				const word = WORD.exec(line.slice(i))?.[0] ?? ch;
				const after = line[i + word.length] ?? "";
				if (kwSet.has(word) || kwSet.has(word.replace(/^[$@#]+/, ""))) {
					out.push(`<span class="hl-keyword">${escapeHtml(word)}</span>`);
				} else if ((lang === "json" || lang === "yaml") && after === ":") {
					out.push(`<span class="hl-attr">${escapeHtml(word)}</span>`);
				} else if (lang === "css" && after === ":") {
					out.push(`<span class="hl-attr">${escapeHtml(word)}</span>`);
				} else if (/^[A-Z]/.test(word) && word.length > 1 && lang !== "json" && lang !== "bash" && lang !== "shell" && lang !== "yaml" && lang !== "text") {
					out.push(`<span class="hl-type">${escapeHtml(word)}</span>`);
				} else {
					out.push(escapeHtml(word));
				}
				i += word.length;
				continue;
			}
			out.push(escapeHtml(ch));
			i += 1;
		}
		out.push("</span>");
	}
	return { lang: lang || "text", html: out.join("") };
}

/** Diff fences: per-line +/- markers (GitHub-style red/green/meta). */
function diffHtml(body: string): string {
	return body
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => {
			const cls = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") ? "diff-meta" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx";
			return `<span class="hl-line ${cls}">${escapeHtml(line)}</span>`;
		})
		.join(""); // block spans — no \n between them (it would render blank)
}

export function renderMarkdown(src: string): string {
	const text = src.replace(/\r\n?/g, "\n");

	// 1. Pull fenced code blocks out first so nothing else mangles them.
	const blocks: string[] = [];
	const hoisted = text.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, body: string) => {
		if (lang.toLowerCase() === "html") {
			// ```html fence → preview-card placeholder. The raw HTML is base64'd
			// into a data attribute (attribute-safe, no escaping ambiguity); the
			// chat UI swaps the div for a sandboxed iframe. Half-open fences
			// (mid-stream) preview what arrived — the hoist regex tolerates them.
			// btoa, NOT Buffer — this module also runs in the browser (vite).
			// Chunked (not spread): a spread this wide overflows the call stack
			// on large demos (~100KB+).
			const bytes = new TextEncoder().encode(body);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000) {
				bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			}
			blocks.push(`<div class="md-html-demo" data-html="${btoa(bin)}"></div>`);
		} else {
		const { html, lang: shown } = highlight(body, lang);
		blocks.push(`<div class="md-code-block"><div class="md-tools"><button type="button" class="md-copy" title="复制代码">⧉</button><span class="md-lang">${escapeHtml(shown)}</span></div><pre class="md-pre"><code>${html}</code></pre></div>`);
		}
		return ` ${blocks.length - 1} `;
	});

	// 2. Escape everything else, then build block structure line-group by line-group.
	const lines = escapeHtml(hoisted).split("\n");
	const out: string[] = [];
	let para: string[] = [];
	let list: { kind: "ul" | "ol"; items: string[][] } | null = null; // items = [lines] per item
	let quote: string[] = [];

	const flushPara = (): void => {
		if (para.length) {
			out.push(`<p>${inline(para.join("\n"))}</p>`);
			para = [];
		}
	};
	const flushList = (): void => {
		if (!list) return;
		const tag = list.kind;
		out.push(
			`<${tag}>` +
				list.items
					.map((ls) => `<li>${inline(ls.join("<br>"))}</li>`)
					.join("") +
				`</${tag}>`,
		);
		list = null;
	};
	const flushQuote = (): void => {
		if (quote.length) {
			out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`);
			quote = [];
		}
	};
	const flushAll = (): void => {
		flushPara();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trimEnd();

		// A hoisted code block standing on its own line.
		const fenceOnly = line.match(/^\s* (\d+) \s*$/);
		if (fenceOnly) {
			flushAll();
			out.push(blocks[Number(fenceOnly[1])]);
			continue;
		}

		// Blank line separates blocks.
		if (!line.trim()) {
			flushAll();
			continue;
		}

		// Table: a header row, a `| --- | :--: |` separator, then 0+ body rows.
		// (Input is already escaped; cells are split on literal `|` pipes.)
		if (isTableSeparator(lines, i)) {
			flushAll();
			const header = splitRow(line);
			const sep = splitRow(lines[i + 1]);
			const aligns = header.map((_c, ci) => {
				const s = sep[ci] ?? "";
				if (s.startsWith(":") && s.endsWith(":")) return ' style="text-align:center"';
				if (s.endsWith(":")) return ' style="text-align:right"';
				return "";
			});
			const body: string[][] = [];
			let j = i + 2;
			while (j < lines.length && lines[j].includes("|")) {
				body.push(splitRow(lines[j]));
				j += 1;
			}
			out.push(renderTable(header, body, aligns));
			i = j - 1; // continue after the table (for-loop's i++ follows)
			continue;
		}

		// Heading: `#`–`######` (must be followed by a space or EOL).
		const h = line.match(/^(#{1,6})(?:\s+(.*))?$/);
		if (h) {
			flushAll();
			const level = Math.min(h[1].length + 1, 6); // h1→h2 … keeps agent docs visually sane
			out.push(`<h${level}>${inline((h[2] ?? "").trim())}</h${level}>`);
			continue;
		}

		// Horizontal rule: --- / *** / ___ (3+).
		if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
			flushAll();
			out.push("<hr>");
			continue;
		}

		// Blockquote: `>` lines group together. (`>` was escaped to &gt; above.)
		const q = line.match(/^ {0,3}(?:&gt;|>) ?(.*)$/);
		if (q) {
			flushPara();
			flushList();
			quote.push(q[1]);
			continue;
		}

		// List item: `-`/`*`/`+` or `N.` — consecutive lines of the same kind group.
		const li = line.match(/^(?: {0,3})([-*+]|\d{1,3}[.)])\s+(.*)$/);
		if (li) {
			flushPara();
			flushQuote();
			const kind = /\d/.test(li[1]) ? "ol" : "ul";
			if (!list || list.kind !== kind) {
				flushList();
				list = { kind, items: [] };
			}
			list.items.push([li[2]]);
			continue;
		}
		// Continuation of the current list item (indented text under it).
		if (list && /^ {2,}\S/.test(raw)) {
			list.items[list.items.length - 1].push(line.trim());
			continue;
		}

		// Anything else: paragraph text (inline code-fence placeholders ride along).
		flushList();
		flushQuote();
		para.push(line);
	}
	flushAll();

	// 3. Restore code blocks (also inside paragraphs, e.g. inline ` ``` `-adjacent).
	return out
		.join("\n")
		.replace(/ (\d+) /g, (_m, i: string) => blocks[Number(i)]);
}
