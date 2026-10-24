/**
 * Claude Code runner — the opponent, driven headlessly.
 *
 * Deliberate choices, all disclosed in the report:
 *  - **Same model backend.** Both agents talk to the same endpoint, so what is
 *    compared is the harness (prompts, tools, delegation), not the model.
 *  - **Model tier is a parameter.** `--model <tier>`; the proxy maps the tier
 *    alias to a concrete GLM model through the `ANTHROPIC_DEFAULT_*_MODEL` env
 *    vars the caller sets. Runs on a tier ABOVE Clownfish's model are no longer
 *    model-controlled and must be reported as such.
 *  - **Subagents enabled.** Claude Code does not push delegation by default the
 *    way Clownfish's orchestrator prompt does, so it gets an explicit nudge via
 *    `--append-system-prompt`. Without it the comparison would credit Clownfish
 *    for a capability its opponent simply was not told it had.
 *  - **Isolated config, fresh session.** `CLAUDE_CONFIG_DIR` points at a scratch
 *    dir unique to (round, task), so the operator's own settings, plugins and MCP
 *    servers cannot tilt the result and no run inherits another's state. Every
 *    invocation is its own process with no `--resume` / `--continue`: nothing is
 *    ever appended to an existing session.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { claudeUsage } from "../usage.mjs";

const SUBAGENT_NUDGE =
	"Delegate substantial sub-work (design, implementation, verification) to subagents with the Task tool when it would keep your own context clean; do the small stuff yourself.";

export async function runClaudeTask({ workspace, configDir, prompt, timeoutMs, model = "sonnet", env = {}, log = () => {} }) {
	mkdirSync(configDir, { recursive: true });
	const started = Date.now();
	const args = [
		"-p",
		prompt,
		"--model",
		model,
		"--output-format",
		"json",
		"--dangerously-skip-permissions",
		"--append-system-prompt",
		SUBAGENT_NUDGE,
	];
	const child = spawn("claude", args, {
		cwd: workspace,
		env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d.toString()));
	child.stderr.on("data", (d) => (stderr += d.toString()));

	const outcome = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("timeout");
		}, timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? "done" : `exit-${code}`);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			stderr += err.message;
			resolve("spawn-error");
		});
	});

	// `--output-format json` prints one envelope with usage and cost.
	let meta = {};
	try {
		const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
		meta = {
			turns: parsed.num_turns,
			costUsd: parsed.total_cost_usd,
			rawUsage: parsed.usage,
			// Normalized to the same shape Clownfish reports, so the report can put
			// the two side by side without special-casing either.
			usage: claudeUsage(parsed.usage),
			textChars: typeof parsed.result === "string" ? parsed.result.length : 0,
		};
	} catch {
		/* non-JSON output (a crash, or a permission prompt) — keep the raw tail */
	}
	log(`claude(${model}) ${workspace.split("/").pop()}: ${outcome} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
	return {
		agent: "claude-code",
		tier: model,
		model: env.ANTHROPIC_DEFAULT_OPUS_MODEL && model === "opus" ? env.ANTHROPIC_DEFAULT_OPUS_MODEL : env.ANTHROPIC_DEFAULT_SONNET_MODEL,
		outcome,
		ms: Date.now() - started,
		...meta,
		errors: outcome === "done" ? [] : [stderr.slice(-500) || stdout.slice(-500)],
	};
}
