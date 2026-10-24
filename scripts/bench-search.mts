/**
 * Head-to-head: the built-in grep tool vs `rg`, on this workspace.
 *
 * The question this answers is narrow and worth re-running after any change to
 * the walker: is an external ripgrep still worth wiring in as a backend? The
 * built-in must be measured on the searches that actually hurt — a rare symbol
 * and a miss, which cannot terminate early — not just on a common word.
 */
import { execFileSync } from "node:child_process";
import { createGrepTool } from "../agent/tools/grep.ts";

const cwd = process.argv[2] ?? process.cwd();
const tool = createGrepTool(cwd);
const CASES: Array<{ name: string; pattern: string; include?: string }> = [
	{ name: "narrow (include)", pattern: "createRunAgentTool", include: "agent/**" },
	{ name: "common word", pattern: "function" },
	{ name: "rare symbol", pattern: "CLOWNFISH_DAG_TOOLS" },
	{ name: "no match", pattern: "zzz_no_such_symbol_zzz" },
];

const hasRg = (): boolean => {
	try {
		execFileSync("rg", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const ms = async (fn: () => Promise<unknown> | unknown): Promise<number> => {
	const t = Date.now();
	await fn();
	return Date.now() - t;
};

const rgAvailable = hasRg();
console.log(`workspace: ${cwd}\nrg: ${rgAvailable ? "available" : "NOT installed — built-in only"}\n`);
console.log("case                 built-in        rg");
for (const c of CASES) {
	const mine = await ms(() => tool.execute("b", { pattern: c.pattern, include: c.include, maxResults: 100 } as never, undefined, undefined));
	let theirs = "-";
	if (rgAvailable) {
		const args = ["-n", "--max-count", "100", c.pattern];
		if (c.include) args.push("-g", c.include);
		theirs = `${await ms(() => {
			try {
				execFileSync("rg", args, { cwd, stdio: "ignore" });
			} catch {
				/* rg exits 1 on no match */
			}
		})}ms`;
	}
	console.log(`${c.name.padEnd(20)} ${`${mine}ms`.padEnd(15)} ${theirs}`);
}
