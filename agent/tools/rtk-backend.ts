/**
 * rtk (rtk-ai/rtk) as an OPTIONAL output compactor for the bash tool.
 *
 * rtk cannot compact piped output — it must run the command itself — so the
 * integration is a REWRITE: before executing, `rtk rewrite <command>` asks the
 * installed binary whether a compacted equivalent exists (`git status` →
 * `rtk git status`, compound commands handled by rtk's own shell parsing).
 * The rewritten command produces the same information with the noise filtered
 * at the source: measured here, `git status` went 296 → 52 bytes.
 *
 * Trust boundary — the rewrite is accepted only when every verb rtk inserted
 * itself after is on an allowlist of noisy-but-safe commands (git, test
 * runners, linters, builders). rtk happily rewrites `grep` → `rtk grep` too,
 * which CHANGES SEMANTICS (BSD grep flags, rtk-ai/rtk#2301) — and search
 * belongs to the structured tools anyway. A rewrite that touches anything off
 * the list is discarded and the original command runs untouched.
 *
 * Fallback, in order: no rtk binary → probe caches the miss, zero cost after
 * the first call; `rtk rewrite` non-zero/empty → original command;
 * an accepted rewrite that then exits 127 (rtk vanished between probe and
 * run) → the caller re-runs the original. `CLOWNFISH_RTK=0` disables it all.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let probe: Promise<boolean> | undefined;

/** Is a real `rtk` executable callable? Cached per process. */
export function rtkAvailable(): Promise<boolean> {
	if (process.env.CLOWNFISH_RTK === "0") return Promise.resolve(false);
	probe ??= execFileAsync("rtk", ["--version"], { timeout: 3000 })
		.then(() => true)
		.catch(() => false);
	return probe;
}

/** Reset the cached probe (tests only). */
export function resetRtkProbe(): void {
	probe = undefined;
}

/**
 * Verbs whose rtk wrapper only FILTERS noisy output. Anything else — above
 * all rtk's grep/find/ls/cat/read rewrites, which change flag semantics and
 * poach the structured tools' territory — is refused.
 */
const REWRITE_ALLOW = new Set([
	"git",
	"tsc",
	"eslint",
	"ruff",
	"golangci-lint",
	"jest",
	"vitest",
	"playwright",
	"pytest",
	"cargo",
	"go",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"make",
	"rake",
	"rspec",
	"docker",
	"kubectl",
]);

/** Every verb that follows an `rtk ` token in the rewritten command. */
function rtkWrappedVerbs(rewritten: string): string[] {
	const verbs: string[] = [];
	const re = /(?:^|[\s;&|(])rtk\s+([A-Za-z0-9_./-]+)/g;
	for (let m = re.exec(rewritten); m; m = re.exec(rewritten)) verbs.push(m[1]);
	return verbs;
}

/**
 * Ask rtk for a compacted equivalent of `command`. Returns the command to run
 * instead, or null when there is none / it is not trusted / rtk is absent.
 */
export async function rtkRewrite(command: string): Promise<string | null> {
	if (!(await rtkAvailable())) return null;
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("rtk", ["rewrite", command], { timeout: 3000 }));
	} catch (err) {
		// Observed contract (rtk 0.46): exit 1 + empty stdout = no rewrite;
		// exit 3 + the rewrite on stdout = rewritten. promisify throws on any
		// non-zero exit, so the exit-3 result is recovered from the error.
		stdout = typeof (err as { stdout?: unknown }).stdout === "string" ? (err as { stdout: string }).stdout : "";
		if (!stdout.trim()) return null;
	}
	return acceptRewrite(command, stdout);
}

/** Validate a candidate rewrite; exported for the check script. */
export function acceptRewrite(original: string, candidate: string): string | null {
	const rewritten = candidate.trim();
	if (!rewritten || rewritten === original.trim()) return null;
	const verbs = rtkWrappedVerbs(rewritten);
	if (verbs.length === 0) return null;
	if (!verbs.every((v) => REWRITE_ALLOW.has(v))) return null;
	// Paranoia: the rewrite must be the original with `rtk ` insertions and
	// nothing else changed — strip the tokens and compare. A rewrite that
	// reorders or rewords the command is not an "insertion" we can trust.
	if (rewritten.replace(/(^|[\s;&|(])rtk\s+/g, "$1") !== original.trim()) return null;
	return rewritten;
}
