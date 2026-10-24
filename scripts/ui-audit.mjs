/**
 * UI audit — drive the running dev UI with Playwright and report what a
 * screenshot alone would not show.
 *
 *   node scripts/ui-audit.mjs                 # against http://localhost:5173
 *   node scripts/ui-audit.mjs --base http://127.0.0.1:5173 --out .ui-audit
 *
 * For every route, at desktop and phone widths:
 *   - a full-page screenshot (so a human can look),
 *   - console errors and failed requests (the page must load clean),
 *   - horizontal overflow (nothing may scroll the body sideways),
 *   - interactive elements smaller than 24px on a side (the WCAG target-size
 *     floor; on a phone anything under ~40px is a mis-tap waiting to happen),
 *   - elements whose text is clipped by their box (ellipsis or overflow-hidden
 *     with more content than fits),
 *   - low-contrast text (foreground vs the nearest painted background),
 *   - squeezed regions: a visible box with real content that layout crushed to
 *     a sliver (a flex sibling took all the height) — the settings → Agent tab
 *     shipped with its asset list squeezed to 12px and no other check noticed.
 *
 * The point is a list to work FROM, not a pass/fail — a UI review that starts
 * from measurements is one that argues about the right things.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://127.0.0.1:5173");
const OUT = arg("out", ".ui-audit");
mkdirSync(OUT, { recursive: true });

const ROUTES = [
	{ name: "home", hash: "#/" },
	{ name: "settings-project", hash: "#/settings/project" },
	{ name: "settings-agents", hash: "#/settings/agents" },
	{ name: "settings-other-agents", hash: "#/settings/other-agents" },
	{ name: "settings-skills", hash: "#/settings/skills" },
	{ name: "settings-plugins", hash: "#/settings/plugins" },
	{ name: "settings-tools", hash: "#/settings/tools" },
	{ name: "settings-mcp", hash: "#/settings/mcp" },
	{ name: "settings-memory", hash: "#/settings/memory" },
	{ name: "settings-keys", hash: "#/settings/keys" },
	{ name: "memory", hash: "#/memory" },
	{ name: "admin", hash: "#/admin" },
];
const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

/** Runs inside the page: the measurements. */
function inspect() {
	const out = { overflow: null, smallTargets: [], clipped: [], lowContrast: [], squeezed: [] };
	const doc = document.documentElement;
	if (doc.scrollWidth > doc.clientWidth + 1) {
		// Which elements poke past the right edge?
		const culprits = [];
		for (const el of document.querySelectorAll("body *")) {
			const r = el.getBoundingClientRect();
			if (r.right > doc.clientWidth + 1 && r.width > 0) {
				culprits.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} right=${Math.round(r.right)}`);
				if (culprits.length >= 5) break;
			}
		}
		out.overflow = { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, culprits };
	}

	const describe = (el) => {
		const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : "";
		const text = (el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "").trim().slice(0, 30);
		return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ""}`;
	};

	for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [onclick]")) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue; // hidden
		const cs = getComputedStyle(el);
		if (cs.visibility === "hidden" || cs.display === "none") continue;
		if (r.width < 24 || r.height < 24) {
			out.smallTargets.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
		}
	}

	for (const el of document.querySelectorAll("body *")) {
		const cs = getComputedStyle(el);
		if (cs.overflow === "hidden" || cs.textOverflow === "ellipsis") {
			if (el.scrollWidth > el.clientWidth + 2 && el.textContent.trim().length > 0 && el.children.length === 0) {
				out.clipped.push({ el: describe(el), visible: el.clientWidth, needed: el.scrollWidth });
			}
		}
	}

	// Squeezed: an element that holds far more content than its box shows and
	// hides the rest (scroller or clip) inside a box under 40px tall — layout
	// starved it. Deliberate one-line ellipsis rows (scrollHeight ≈ height) and
	// collapsed/hidden boxes don't match.
	for (const el of document.querySelectorAll("body *")) {
		const cs = getComputedStyle(el);
		if (!/(auto|scroll|hidden)/.test(cs.overflowY)) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 40 || r.height === 0 || r.height >= 40) continue;
		if (el.scrollHeight > 120 && el.scrollHeight > r.height * 4) {
			out.squeezed.push({ el: describe(el), h: Math.round(r.height), content: el.scrollHeight });
		}
	}

	// Contrast: text nodes' foreground vs the first ancestor with a painted background.
	const parse = (c) => {
		const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
		return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
	};
	const lum = ({ r, g, b }) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const contrast = (a, b) => {
		const l1 = lum(a);
		const l2 = lum(b);
		return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
	};
	const bgOf = (el) => {
		let n = el;
		while (n && n !== document) {
			const c = parse(getComputedStyle(n).backgroundColor);
			if (c && c.a > 0.5) return c;
			n = n.parentElement;
		}
		return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
	};
	const seen = new Set();
	for (const el of document.querySelectorAll("body *")) {
		if (!el.childNodes.length) continue;
		const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
		if (!hasText) continue;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		const cs = getComputedStyle(el);
		const fg = parse(cs.color);
		if (!fg || fg.a < 0.5) continue;
		const bg = bgOf(el);
		const ratio = contrast(fg, bg);
		const size = parseFloat(cs.fontSize);
		const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
		const floor = large ? 3 : 4.5;
		if (ratio < floor) {
			const key = describe(el);
			if (seen.has(key)) continue;
			seen.add(key);
			out.lowContrast.push({ el: key, ratio: +ratio.toFixed(2), floor, fg: cs.color, size: Math.round(size) });
		}
	}
	return out;
}

const browser = await chromium.launch();
const report = [];
for (const vp of VIEWPORTS) {
	const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
	const page = await context.newPage();
	const consoleErrors = [];
	const failedRequests = [];
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${m.text().slice(0, 200)}`);
	});
	page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
	page.on("response", (r) => {
		if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`);
	});

	for (const route of ROUTES) {
		consoleErrors.length = 0;
		failedRequests.length = 0;
		await page.goto(`${BASE}/${route.hash}`, { waitUntil: "networkidle" });
		await page.waitForTimeout(400); // let async loads settle
		const file = join(OUT, `${route.name}-${vp.name}.png`);
		await page.screenshot({ path: file, fullPage: true });
		const m = await page.evaluate(inspect);
		report.push({ route: route.name, viewport: vp.name, file, consoleErrors: [...consoleErrors], failedRequests: [...failedRequests], ...m });
	}
	await context.close();
}
await browser.close();

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));

// Human summary.
for (const r of report) {
	const flags = [];
	if (r.consoleErrors.length) flags.push(`console:${r.consoleErrors.length}`);
	if (r.failedRequests.length) flags.push(`requests:${r.failedRequests.length}`);
	if (r.overflow) flags.push(`OVERFLOW ${r.overflow.scrollWidth}>${r.overflow.clientWidth}`);
	if (r.smallTargets.length) flags.push(`small-targets:${r.smallTargets.length}`);
	if (r.clipped.length) flags.push(`clipped:${r.clipped.length}`);
	if (r.lowContrast.length) flags.push(`low-contrast:${r.lowContrast.length}`);
	if (r.squeezed.length) flags.push(`SQUEEZED:${r.squeezed.length}`);
	console.log(`${r.route.padEnd(16)} ${r.viewport.padEnd(8)} ${flags.length ? flags.join("  ") : "clean"}`);
	for (const e of r.consoleErrors.slice(0, 3)) console.log(`    ! ${e}`);
	for (const e of r.failedRequests.slice(0, 3)) console.log(`    ! ${e}`);
	if (r.overflow) for (const c of r.overflow.culprits) console.log(`    ↔ ${c}`);
	for (const t of r.smallTargets.slice(0, 6)) console.log(`    ▫ ${t.el} ${t.w}×${t.h}`);
	for (const c of r.clipped.slice(0, 4)) console.log(`    ✂ ${c.el} ${c.visible}/${c.needed}px`);
	for (const q of r.squeezed.slice(0, 4)) console.log(`    ⇕ ${q.el} ${q.h}px tall holding ${q.content}px`);
	for (const c of r.lowContrast.slice(0, 6)) console.log(`    ◐ ${c.el} ${c.ratio}:1 (need ${c.floor}) ${c.size}px ${c.fg}`);
}
console.log(`\nscreenshots + report.json → ${OUT}/`);
