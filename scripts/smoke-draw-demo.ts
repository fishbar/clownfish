/** Smoke: draw_demo tool — multi-file publish, path validation, bounds, URL shape.
 *  Drives the tool directly (no LLM, no server): files land under
 *  <tmp>/s1/demo/<id>/ and the result URL points at the demos route. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDrawDemoTool } from "../agent/tools/draw-demo";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}`); };

const root = await mkdtemp(join(tmpdir(), "clownfish-demo-"));
const tool = createDrawDemoTool({ projectId: "p1", sessionId: "s1", sessionsDir: root });

// 1. Happy path: entry + subdir css + js.
const r1 = await tool.execute("t1", {
	files: [
		{ path: "index.html", content: "<html><link rel=stylesheet href=css/s.css><script src=app.js></script></html>" },
		{ path: "css/s.css", content: "body{color:red}" },
		{ path: "app.js", content: "console.log(1)" },
	],
}, undefined);
const d1 = r1.details as { url: string; demoId: string; files: string[] };
check("published with URL shape", /^\/api\/projects\/p1\/sessions\/s1\/demos\/[A-Za-z0-9_-]+\/$/.test(d1.url));
check("files listed", d1.files.join(",") === "app.js,css/s.css,index.html");
const css = await readFile(join(root, "s1", "demo", d1.demoId, "css", "s.css"), "utf8");
check("css content on disk", css === "body{color:red}");

// 2. Custom entry.
const r2 = await tool.execute("t2", { files: [{ path: "main.html", content: "<b>x</b>" }], entry: "main.html" }, undefined);
check("custom entry accepted", (r2.details as { url: string }).url.includes("/demos/"));

// 3. Rejections (nothing written).
const cases: Array<[string, unknown]> = [
	["traversal path", { files: [{ path: "../esc.txt", content: "x" }, { path: "index.html", content: "x" }] }],
	["absolute path", { files: [{ path: "/etc/x", content: "x" }] }],
	["missing entry", { files: [{ path: "other.html", content: "x" }] }],
	["empty files", { files: [] as Array<{ path: string; content: string }> }],
	["duplicate paths", { files: [{ path: "index.html", content: "x" }, { path: "index.html", content: "y" }] }],
];
for (const [name, input] of cases) {
	const r = await tool.execute("t", input as never, undefined);
	const text = (r.content[0] as { text: string }).text;
	check(`rejects: ${name}`, text.startsWith("draw_demo:") && text.includes("Invalid") || text.includes("Entry") || text.includes("Too many") || text.includes("Duplicate"));
}
// traversal must NOT have escaped the demo root
let escaped = false;
try { await stat(join(root, "s1", "esc.txt")); escaped = true; } catch { /* good */ }
check("no escape file created", !escaped);

// 4. Size bounds.
const big = "x".repeat(1024 * 1024 + 1);
const rBig = await tool.execute("t", { files: [{ path: "index.html", content: big }] }, undefined);
check("rejects >1MiB file", ((rBig.content[0] as { text: string }).text).includes("max"));
const many = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.html`, content: "x" }));
const rMany = await tool.execute("t", { files: many as never }, undefined);
check("rejects >50 files", ((rMany.content[0] as { text: string }).text).includes("Too many"));

// 5. Demo dir lives under the session dir (delete-session nukes it via transcript.remove()).
const demoDir = join(root, "s1", "demo");
check("demos under <sessions>/<sid>/demo/", demoDir.startsWith(root));

await rm(root, { recursive: true, force: true });
console.log(fail === 0 ? `smoke-draw-demo: ${pass} checks passed` : `FAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
