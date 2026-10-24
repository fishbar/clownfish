/**
 * Markdown body with live HTML previews.
 *
 * Markdown body with live HTML previews: the text is split into markdown runs
 * and ```html fences (same fence semantics as the renderer's hoist). Fences
 * render as managed {@link HtmlPreviewCard} components — a sandboxed iframe
 * (allow-scripts, NO allow-same-origin: the snippet cannot touch our
 * cookies/storage/DOM) with a height probe and a source toggle. The card's
 * iframe element survives streaming deltas (only its srcdoc updates, and
 * throttled), so a growing preview doesn't flash/reload per keystroke.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { renderMarkdown, highlight } from "./markdown";

/** Height probe injected before </body> (or appended): posts scrollHeight to
 *  the parent on load + on every DOM mutation (streaming content grows).
 *  Wrapped in try/catch — a broken snippet must not break the chat page. */
const PROBE = `<script>(function(){
	function post(){try{parent.postMessage({__clownfishProbe:1,h:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)},'*')}catch(e){}}
	new MutationObserver(post).observe(document.documentElement,{subtree:true,childList:true,attributes:true});
	addEventListener('load',post);setTimeout(post,50);setTimeout(post,300);
})()<\/script>`;

const PROBE_FALLBACK_H = 200;

/** Split message text into markdown runs and ```html fences. Same fence
 *  semantics as renderMarkdown's hoist (first-match-wins, half-open fences
 *  tolerated mid-stream) — non-html fences stay in the markdown runs. */
function splitFences(text: string): Array<{ md: string } | { html: string }> {
	const out: Array<{ md: string } | { html: string }> = [];
	const re = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[1].toLowerCase() !== "html") continue; // consumed, kept in the md run
		if (m.index > last) out.push({ md: text.slice(last, m.index) });
		out.push({ html: m[2] });
		last = m.index + m[0].length;
	}
	if (last === 0 && out.length === 0) out.push({ md: text });
	else if (last < text.length) out.push({ md: text.slice(last) });
	return out;
}

/** Copy one code block, with the "啪" success feedback on its button: a
 *  snap-in scale pop on the button itself plus a green burst ring that
 *  expands and fades — snappy, unmistakable. Shared by the copy button
 *  (click) and double-click-anywhere-on-the-block. */
function copyCodeBlock(block: Element | null): void {
	if (!block) return;
	const btn = block.querySelector<HTMLButtonElement>(".md-copy");
	const code = block.querySelector("code")?.textContent ?? "";
	void navigator.clipboard?.writeText(code).then(() => {
		if (!btn) return;
		// Restart the animation even for a rapid second copy: clone-swap the
		// burst node (an existing one mid-animation would just keep running).
		btn.querySelector(".md-copy-burst")?.remove();
		btn.classList.add("copied");
		btn.textContent = "✓";
		const burst = document.createElement("span");
		burst.className = "md-copy-burst";
		btn.appendChild(burst);
		window.setTimeout(() => burst.remove(), 500);
		window.setTimeout(() => {
			btn.classList.remove("copied");
			btn.textContent = "⧉";
		}, 1200);
	});
}

/** A standalone highlighted code block for TOOL OUTPUT (file contents, code,
 *  logs): the same chrome as markdown fences — language badge, line numbers,
 *  hover copy button, double-click copy. `langHint` lets the caller tag the
 *  content (e.g. "json"); an empty hint lets the highlighter guess. */
export function CodeBlock({ text, langHint = "" }: { text: string; langHint?: string }): preact.JSX.Element {
	const { html, lang } = highlight(text, langHint);
	return (
		<div
			class="md-code-block"
			onClick={(e) => {
				const btn = (e.target as HTMLElement).closest?.(".md-copy");
				if (!btn) return;
				copyCodeBlock(btn.closest(".md-code-block"));
			}}
			onDblClick={(e) => {
				e.preventDefault();
				copyCodeBlock((e.currentTarget as HTMLElement).closest(".md-code-block"));
			}}
		>
			<div class="md-tools">
				<button type="button" class="md-copy" title="复制代码">
					⧉
				</button>
				<span class="md-lang">{lang}</span>
			</div>
			<pre class="md-pre">
				<code dangerouslySetInnerHTML={{ __html: html }} />
			</pre>
		</div>
	);
}

export function MarkdownBody({ text }: { text: string }): preact.JSX.Element {
	// Fences render as MANAGED components, not innerHTML children: the whole
	// markdown used to be re-set per streaming delta, destroying the upgraded
	// card (its iframe rebuilt — white flash, scroll/state loss, scripts
	// re-run). Now the prose re-renders (cheap text) and each card's iframe
	// element survives; only its srcdoc updates, throttled.
	return (
		<div class="bubble md md-scope">
			{splitFences(text).map((seg, i) =>
				"md" in seg ? (
					<div
						key={i}
						dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.md) }}
						onClick={(e) => {
							// Copy button: the button lives in the innerHTML (any count
							// of blocks works); this delegated handler does the rest.
							const btn = (e.target as HTMLElement).closest?.(".md-copy");
							if (!btn) return;
							copyCodeBlock(btn.closest(".md-code-block"));
						}}
						onDblClick={(e) => {
							// Double-click anywhere in a code block copies it (same
							// feedback animation as the button).
							const block = (e.target as HTMLElement).closest?.(".md-code-block");
							if (!block) return;
							e.preventDefault();
							copyCodeBlock(block);
						}}
					/>
				) : (
					<ThrottledHtmlCard key={i} html={seg.html} />
				),
			)}
		</div>
	);
}

/** A live (still-streaming) fence grows per delta — reloading the iframe per
 *  keystroke strobes. Update the preview at most ~2×/s while it grows; the
 *  final content lands when the fence closes. */
function ThrottledHtmlCard({ html }: { html: string }): preact.JSX.Element {
	const [shown, setShown] = useState(html);
	const pending = useRef(html);
	useEffect(() => {
		if (html === shown) return;
		pending.current = html;
		const t = window.setTimeout(() => setShown(pending.current), 500);
		return () => window.clearTimeout(t);
	}, [html, shown]);
	return <HtmlPreviewCard html={shown} />;
}

/** One ```html fence: live preview (default) ↔ source code, sandboxed iframe. */
export function HtmlPreviewCard({ html }: { html: string }): preact.JSX.Element {
	const frame = useRef<HTMLIFrameElement>(null);
	// Sandbox WITHOUT allow-same-origin → the iframe is opaque-origin: its
	// srcdoc scripts run, but it cannot read our cookies, storage, or DOM.
	// Transparent wrapper chrome: the iframe's own html/body carries no margin,
	// padding, font, or background — the snippet's <style> (often full-bleed
	// dark canvases) paints edge to edge, and the page background shows through
	// when the snippet doesn't set one.
	const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${html}${PROBE}</body></html>`;
	return (
		<div class="html-card">
			<div class="html-card-bar">
				<span class="html-card-title">HTML 预览</span>
				<button
					type="button"
					class="html-card-src"
					onClick={(e) => {
						const card = (e.currentTarget as HTMLElement).closest(".html-card");
						if (!card) return;
						const showingSrc = card.classList.toggle("show-src");
						(e.currentTarget as HTMLElement).textContent = showingSrc ? "预览" : "源码";
					}}
				>
					源码
				</button>
			</div>
			<div class="html-card-view">
				<iframe
					ref={frame}
					class="html-card-frame"
					sandbox="allow-scripts"
					style={{ height: `${PROBE_FALLBACK_H}px` }}
					srcdoc={srcdoc}
					onLoad={() => probeNow(frame.current)}
				/>
			</div>
			<pre class="html-card-source">{html}</pre>
		</div>
	);
}

/** The demo viewer for draw_demo URLs — same sandbox, fixed viewport. */
export function DemoFrame({ url }: { url: string }): preact.JSX.Element {
	return <iframe class="demo-frame" sandbox="allow-scripts allow-forms allow-popups" src={url} />;
}

function probeNow(frame: HTMLIFrameElement | null): void {
	// The probe posts on its own (load + mutations); onLoad here is a chance to
	// start listening. Nothing to do — kept as the hook point for future tweaks.
	void frame;
}

/** Parent-side probe listener: resize the matching card's iframe. Installs once. */
let listenerInstalled = false;
export function installProbeListener(): void {
	if (listenerInstalled || typeof window === "undefined") return;
	listenerInstalled = true;
	window.addEventListener("message", (ev) => {
		const data = ev.data as { __clownfishProbe?: number; h?: number } | null;
		if (!data || data.__clownfishProbe !== 1 || typeof data.h !== "number") return;
		// Find the iframe that sent this: probes only ever come from our cards.
		for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe.html-card-frame"))) {
			try {
				if (f.contentWindow === ev.source) {
					const h = Math.min(Math.max(80, data.h), 2000);
					f.style.height = `${h}px`;
					return;
				}
			} catch {
				/* cross-origin skip */
			}
		}
	});
}
installProbeListener();
