/**
 * External CLI sub-agents — LIVE check (costs one real `claude` turn).
 *
 * Everything offline is pinned by cli-subagent-check.mts; what only a live run
 * can prove is the seam to the REAL binaries: that `claude -p --session-id
 * <uuid> --output-format json` actually writes its session JSONL where our
 * discovery looks, that the adapted events and mirrored transcript carry real
 * content, and that the parsed `.result` is the CLI's own final message.
 * `codex` is skipped with a line when not installed (it is doc-level until a
 * machine has it).
 *
 *   npx tsx scripts/live-cli-subagent.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunAgentTool } from "../agent/agents/run-agent-tool.ts";
import { loadCliAgentDefinitions, lookupCommand } from "../agent/agents/cli-config.ts";

process.env.CLOWNFISH_CLI_SUBAGENTS = "1";

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail.slice(0, 400)}`}`);
	if (!ok) failed++;
};

const dataDir = mkdtempSync(join(tmpdir(), "live-cli-sub-"));
try {
	const workdir = join(dataDir, "ws");
	mkdirSync(workdir, { recursive: true });
	const sessionsDir = join(dataDir, "sessions");
	const { defs } = await loadCliAgentDefinitions(dataDir);

	const claudeDef = defs.find((d) => d.name === "claude-code");
	if (!claudeDef) {
		console.log(`! claude-code unavailable (${lookupCommand("claude") ? "config" : "no claude binary on PATH"}) — nothing to run`);
		process.exit(failed ? 1 : 0);
	}
	// The runner's env is an ALLOWLIST (never provider credentials — see
	// agent/cli-env.ts), so a claude that authenticates through env vars gets a
	// 403 unless the entry carries them itself. That per-entry env is the
	// designed escape hatch; mirror what an operator would put in the form.
	// CLAUDE_CONFIG_DIR goes the same way (hermetic log root): the runner
	// resolves the log root from the CHILD's env, so setting it in the entry
	// alone moves both the log and the tail, regardless of ~/.claude.
	const authEnv: Record<string, string> = { CLAUDE_CONFIG_DIR: join(dataDir, "claude-home") };
	for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
		const v = process.env[k];
		if (v) authEnv[k] = v;
	}
	claudeDef.cli = { ...claudeDef.cli!, env: { ...claudeDef.cli!.env, ...authEnv } };
	if (!defs.some((d) => d.name === "codex")) console.log("! codex not installed — skipped (doc-level until a machine has it)");

	const { tool } = createRunAgentTool({
		agents: [claudeDef],
		runtime: { model: { id: "live" } } as never, // no {model} override: the {model} slot must drop
		cwd: workdir,
		skills: [],
		vars: { cwd: workdir, project: "live", sessionId: "live1", date: new Date().toISOString().slice(0, 10), os: process.platform },
		sessionId: "live1",
		sessionsDir,
		verify: "off",
		maxSteps: 40,
		timeoutMs: 300_000,
		log: (m) => console.log("  [runner]", m),
	});
	const result = await tool.execute("live1", { type: "claude-code", task: "Create a file named hello.txt in the current directory containing exactly the text: live-cli-subagent ok" } as never, new AbortController().signal);
	const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? "";

	check("the real claude delegation returned a result", text.trim().length > 0, text);
	check("the task's file was actually created", existsSync(join(workdir, "hello.txt")), JSON.stringify(text.slice(0, 200)));
	const mirroredPath = join(sessionsDir, "live1", "sub1-claude-code.jsonl");
	check("the conversation was mirrored into the standard transcript", existsSync(mirroredPath));
	if (existsSync(mirroredPath)) {
		const mirrored = readFileSync(mirroredPath, "utf8");
		check("the mirror uses the {id,ts,message} envelope with real content", mirrored.includes('"message"') && mirrored.length > 200);
	}
} finally {
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\nlive-cli-subagent: FAILED (${failed})` : "\nlive-cli-subagent: all checks passed");
process.exit(failed ? 1 : 0);
