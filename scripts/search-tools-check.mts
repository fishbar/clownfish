/**
 * The search/read tools, and the shell habit they exist to replace.
 *
 * Measured across every local session and bench run: the `grep` TOOL was
 * called 2 times while `grep` the SHELL COMMAND ran 73 times, and
 * `cat`/`head`/`tail` ran 308 times against 114 `read` calls — with
 * guidelines that already said "prefer the dedicated tools". Prompting alone
 * lost to training inertia, so two things changed and are pinned here:
 *
 *   1. the capability gap that made shelling out rational — no context lines
 *      around a hit, so the model reached for `grep -C` and paid for the file;
 *   2. a reminder attached to the RESULT of a read-only shell command, which
 *      the model cannot skim past the way it skimmed the guideline.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "../agent/tools/grep.ts";
import { inspectionNudge } from "../agent/tools/bash.ts";
import { rgAvailable, resetRgProbe } from "../agent/tools/search-backend.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "clownfish-search-"));
try {
	writeFileSync(
		join(dir, "sample.ts"),
		["alpha", "beta", "TARGET one", "gamma", "delta", "epsilon", "zeta", "TARGET two", "eta", "theta"].join("\n"),
	);
	// Two hits three lines apart: with context 2 their windows overlap and must
	// merge into ONE block rather than repeating the shared lines.
	writeFileSync(join(dir, "close.ts"), ["a", "HIT x", "b", "c", "HIT y", "d"].join("\n"));
	writeFileSync(join(dir, "notes.md"), "TARGET in markdown\n");
	// Hits far enough apart that their context windows do NOT touch.
	writeFileSync(join(dir, "far.ts"), ["FAR one", ...Array.from({ length: 12 }, (_, i) => `pad ${i}`), "FAR two"].join("\n"));

	const grep = createGrepTool(dir);
	const run = async (params: Record<string, unknown>): Promise<string> =>
		(await grep.execute("c", params as never, undefined, undefined)).content[0].text;

	// --- the shape that already worked must not change --------------------------
	const plain = await run({ pattern: "TARGET" });
	check("a plain search still returns file:line: text", /sample\.ts:3: TARGET one/.test(plain), plain);
	check("it searches every file type by default", /notes\.md:1/.test(plain), plain);
	check("include narrows by glob", !/notes\.md/.test(await run({ pattern: "TARGET", include: "*.ts" })));

	// --- context windows ---------------------------------------------------------
	const ctx = await run({ pattern: "TARGET", include: "sample.ts", context: 2 });
	check("context shows the lines before a hit", /sample\.ts:1- alpha/.test(ctx), ctx);
	check("context shows the lines after a hit", /sample\.ts:5- delta/.test(ctx), ctx);
	check("matches keep the ':' marker, context gets '-'", /sample\.ts:3: TARGET one/.test(ctx), ctx);
	const far = await run({ pattern: "FAR", include: "far.ts", context: 2 });
	check("distant hits are split by a '--' rule", far.includes("\n--\n"), far);
	check("only the window around each distant hit is shown", !/pad 5/.test(far), far);

	const merged = await run({ pattern: "HIT", include: "close.ts", context: 2 });
	check("overlapping windows merge into one block", !merged.includes("--"), merged);
	// The shared lines (b, c) must appear once, not once per hit.
	check("a shared context line is not repeated", (merged.match(/close\.ts:3- b/g) ?? []).length === 1, merged);

	// --- one call, several terms -------------------------------------------------
	const alt = await run({ pattern: "alpha|zeta", include: "sample.ts" });
	check("alternation searches several terms at once", /alpha/.test(alt) && /zeta/.test(alt), alt);

	// --- maxResults still bounds the output --------------------------------------
	const capped = await run({ pattern: "TARGET", maxResults: 1 });
	check("maxResults caps the result and says so", /Truncated at 1 matches/.test(capped), capped);

	// --- the shell-inspection nudge ----------------------------------------------
	for (const cmd of ["grep -rn foo .", "cat a.ts", "head -40 x.ts", "ls -la", "rg pattern src", "find . -name '*.ts'"]) {
		check(`a read-only shell command is flagged: ${cmd}`, inspectionNudge(cmd) !== undefined);
	}
	// A command that RUNS something, or produces a file, is left alone — the
	// nudge must not fire on legitimate pipelines or redirects.
	check("2>&1 does not suppress the nudge (fd dup, not a file)", inspectionNudge("cat x.log 2>&1") !== undefined);
	check("find -delete is not called a read-only look", inspectionNudge("find . -name '*.tmp' -delete") === undefined);
	check("sed -n is flagged as a read", inspectionNudge("sed -n '5,20p' x.ts") !== undefined);
	check("sed -i is left alone (mutates)", inspectionNudge("sed -i '' 's/a/b/' x.ts") === undefined);
	for (const cmd of ["node --test | grep FAIL", "make test", "git status", "npm run build 2>&1 | tail -20", "cat a.ts > b.ts"]) {
		check(`a real command is not flagged: ${cmd}`, inspectionNudge(cmd) === undefined, String(inspectionNudge(cmd)));
	}
	// --- engine parity ------------------------------------------------------------
	// `rg` is a BACKEND, not a second tool: the same call must produce the same
	// answer whichever engine served it, or an operator who installs ripgrep
	// silently changes what the agent sees.
	const withEngine = async (rg: boolean, params: Record<string, unknown>): Promise<string> => {
		process.env.CLOWNFISH_RG = rg ? "1" : "0";
		resetRgProbe();
		return (await grep.execute("c", params as never, undefined, undefined)).content[0].text;
	};
	const norm = (s: string): string => s.split("\n").filter(Boolean).sort().join("\n");
	process.env.CLOWNFISH_RG = "1";
	resetRgProbe();
	const haveRg = await rgAvailable();
	for (const params of [
		{ pattern: "TARGET" },
		{ pattern: "TARGET", include: "*.ts" },
		{ pattern: "HIT", include: "close.ts", context: 2 },
		{ pattern: "zzz_absent_zzz" },
		{ pattern: "alpha|zeta", include: "sample.ts" },
		{ pattern: "TARGET", outputMode: "files_with_matches" },
	]) {
		const builtin = await withEngine(false, params);
		if (!haveRg) {
			check(`engine parity skipped (no rg): ${JSON.stringify(params)}`, builtin.length > 0);
			continue;
		}
		const viaRg = await withEngine(true, params);
		check(`rg and the built-in agree: ${JSON.stringify(params)}`, norm(builtin) === norm(viaRg), `builtin=${norm(builtin).slice(0, 160)} | rg=${norm(viaRg).slice(0, 160)}`);
	}
	// Bug regressions pinned (code-review findings, all probed before fixing):
	// dash-digit paths broke the rg line parser; '*.ts' missed nested files;
	// a nested !negation was ignored by the walker.
	const dashDir = join(dir, "issue-42-fix");
	writeFileSync(join(dir, "far2.ts"), "x\n"); // keep dir nonempty for builtin walk
	const { mkdirSync: mk } = await import("node:fs");
	mk(dashDir, { recursive: true });
	writeFileSync(join(dashDir, "f5.ts"), "DASHNEEDLE here\n");
	for (const rg of haveRg ? [false, true] : [false]) {
		const out = await withEngine(rg, { pattern: "DASHNEEDLE" });
		check(`a -<digits>- path parses intact (${rg ? "rg" : "builtin"})`, /issue-42-fix\/f5\.ts:1: DASHNEEDLE here/.test(out), out);
		const nested = await withEngine(rg, { pattern: "DASHNEEDLE", include: "*.ts" });
		check(`'*.ts' matches nested files (${rg ? "rg" : "builtin"})`, /issue-42-fix\/f5\.ts/.test(nested), nested);
	}
	{
		const { walkFiles } = await import("../agent/tools/fs-walk.ts");
		const negDir = join(dir, "neg");
		mk(join(negDir, "app"), { recursive: true });
		writeFileSync(join(negDir, ".gitignore"), "*.log\n");
		writeFileSync(join(negDir, "app", ".gitignore"), "!important.log\n");
		writeFileSync(join(negDir, "app", "important.log"), "kept\n");
		writeFileSync(join(negDir, "app", "other.log"), "dropped\n");
		const files = (await walkFiles(negDir, {})).map((f) => f.slice(negDir.length + 1));
		check("a nested !negation un-ignores (git semantics)", files.includes("app/important.log"), files.join(","));
		check("the outer ignore still applies", !files.includes("app/other.log"), files.join(","));
	}

	// A pattern rg's regex engine rejects (lookahead) must still be answered.
	const lookahead = await withEngine(true, { pattern: "TARGET(?= one)", include: "sample.ts" });
	check("a pattern rg cannot compile falls back to the built-in", /sample\.ts:3: TARGET one/.test(lookahead), lookahead);
	process.env.CLOWNFISH_RG = "0";
	resetRgProbe();

	check("the nudge names the tool to use instead", /`grep` tool|`read`|`find`|`ls`/.test(inspectionNudge("grep -rn x .") ?? ""), inspectionNudge("grep -rn x .") ?? "");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`search tools: ${passed} checks passed`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
