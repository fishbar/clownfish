/**
 * runCliSub — execute one external-CLI sub-agent delegation (Codex / Claude
 * Code / any configured command), behind the SAME contract as the in-process
 * `runSub`: prompt in → final text out, with budgets, abort, transcript,
 * progress and lifecycle frames. `run_agent` stays the single delegation
 * entry; a CLI agent is just a `type` whose definition carries a {@link
 * CliAgentSpec}.
 *
 * Shape of a run:
 *   - the CLI runs HEADLESS (no pty — that is for interactive whole sessions):
 *     `claude -p` / `codex exec` cannot ask questions mid-run, which is the
 *     documented trade for this pass; the task goes to the child's STDIN and
 *     the operating instructions are prepended to it (universal — no reliance
 *     on a `--append-system-prompt` flag being configured),
 *   - progress and the drill-in view come from TAILING the CLI's own session
 *     JSONL (see cli-log-tail.ts), adapted into ordinary agent events under
 *     the delegation's bus id — zero new wire frames,
 *   - the final answer comes from the CLI's machine-readable result (stdout
 *     JSON / `--output-last-message` file), with the tailed log as fallback,
 *   - `beforeToolCall` cannot gate an external process: a CLI delegation is
 *     ALWAYS treated as a writer (`mutated: true`), so the framework's qa
 *     verification + rollback apply; the gate is the run_agent call itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { cliChildEnv } from "../cli-env";
import { claudePermissionMode } from "./cli-config";
import { SessionTranscript } from "../transcript";
import type { WorkerFrame } from "../protocol";
import type { AgentDefinition } from "./types";
import {
	JsonlTail,
	adaptClaudeLine,
	adaptCodexLine,
	claudeLogPath,
	cliLogRoot,
	codexSessionDir,
	findCodexRollout,
	snapshotDir,
} from "./cli-log-tail";
import type { SubRun } from "./run-agent-tool";

/** Everything runCliSub needs from the delegation context (runSub supplies it). */
export interface CliSubOptions {
	def: AgentDefinition;
	workdir: string;
	/** Rendered operating instructions (the agent body, vars substituted). */
	instructions: string;
	/** The task prompt (task + context + parent digest), as for an in-process sub. */
	prompt: string;
	label: string;
	/** The pre-computed delegation id (`sub<n>-<type>`): bus id + transcript name. */
	subId: string;
	parentAgentId?: string;
	/** Effective model id (`{model}` placeholder); omit to drop the slot. */
	model?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: [{ type: "text"; text: string }]; details: undefined }) => void;
	onSpawned?: (subId: string) => void;
	onFrame?: (frame: WorkerFrame) => void;
	sessionsDir?: string;
	sessionId?: string;
	log?: (message: string) => void;
	maxSteps: number;
	timeoutMs: number;
	/** Test injection: claude/codex config roots (defaults honor the env vars). */
	logConfigDir?: string;
}

/** Substitute placeholders into the configured argv. A `{model}` slot with no
 *  model in play is dropped TOGETHER with the argv slot before it (its flag),
 *  so `--model {model}` disappears cleanly instead of leaving a bare flag. */
export function buildCliArgs(configured: string[], vars: { sessionId: string; workdir: string; model?: string; resultFile: string }): string[] {
	const out: string[] = [];
	for (const arg of configured) {
		if (vars.model === undefined && arg === "{model}" && out.length > 0) {
			out.pop(); // the flag belonging to this slot
			continue;
		}
		out.push(
			arg
				.replaceAll("{session-id}", vars.sessionId)
				.replaceAll("{workdir}", vars.workdir)
				.replaceAll("{result-file}", vars.resultFile)
				.replaceAll("{permission-mode}", claudePermissionMode())
				.replaceAll("{model}", vars.model ?? "{model}"),
		);
	}
	return out;
}

/** Grace period between SIGTERM and SIGKILL for the whole process group. */
const KILL_GRACE_MS = 5_000;

export async function runCliSub(opts: CliSubOptions): Promise<SubRun> {
	const { def, workdir, prompt, label, subId, maxSteps, timeoutMs } = opts;
	const spec = def.cli!;

	const report = (last: string, steps: number): void =>
		opts.onUpdate?.({ content: [{ type: "text", text: `${label} · ${steps} step(s) · ${last}` }], details: undefined });

	if (opts.signal?.aborted) {
		opts.onFrame?.({ type: "agent_ended", agentId: subId });
		return { status: "aborted", text: "", steps: 0, mutated: false };
	}
	opts.onFrame?.({ type: "agent_spawned", agentId: subId, parentAgentId: opts.parentAgentId, kind: "dagSub", label });
	opts.onSpawned?.(subId);

	// --- transcript mirroring (same envelope as an in-process sub) ----------
	const tx = opts.sessionsDir && opts.sessionId ? new SessionTranscript(opts.sessionsDir, opts.sessionId, subId) : undefined;
	let recording: Promise<void> = Promise.resolve();
	const record = (messages: AgentMessage[]): void => {
		if (!tx || messages.length === 0) return;
		recording = recording.then(() => tx.appendMessages(messages)).catch(() => {
			/* a transcript write must never take down the delegation */
		});
	};

	// --- adapted conversation state ----------------------------------------
	const conversation: AgentMessage[] = [];
	let steps = 0;
	let last = "starting";
	let exhausted: "steps" | "time" | undefined;
	let aborted = false;
	const seenToolCalls = new Set<string>();
	const previewArg = (args: unknown): string => {
		const a = args as Record<string, unknown> | null | undefined;
		if (!a || typeof a !== "object") return "";
		for (const key of ["path", "file", "command", "pattern", "type", "name"]) {
			const v = a[key];
			if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 60);
		}
		return "";
	};
	/** killGroup is assigned once the child exists (see the spawn block). */
	let killGroup: (sig: NodeJS.Signals) => void = () => {};
	const ingest = (adapt: { events: AgentEvent[]; messages: AgentMessage[] }): void => {
		for (const message of adapt.messages) {
			conversation.push(message);
			record([message]);
		}
		for (const event of adapt.events) {
			if (event.type === "tool_execution_start") {
				// codex replays its own history on resume; count each call once.
				if (seenToolCalls.has(event.toolCallId)) continue;
				seenToolCalls.add(event.toolCallId);
				steps++;
				last = `${event.toolName}: ${previewArg(event.args)}`.slice(0, 80);
				report(last, steps);
				if (steps >= maxSteps) {
					exhausted = "steps";
					killGroup("SIGTERM");
				}
			}
			opts.onFrame?.({ type: "event", event, agentId: subId });
		}
	};

	// --- spawn --------------------------------------------------------------
	// The child gets its own process group (detached) so aborts/timeout kill
	// the CLI AND its own children (bash etc.), not just the front process.
	const cliSessionId = randomUUID();
	const tmpRoot = await mkdtemp(join(tmpdir(), `clownfish-cli-${subId.replace(/[^\w-]/g, "_")}-`)).catch(() => undefined);
	const resultFile = join(tmpRoot ?? tmpdir(), "last-message.txt");
	const argv = buildCliArgs(spec.args ?? [], { sessionId: cliSessionId, workdir, model: opts.model, resultFile });
	const childEnv = cliChildEnv(spec.env);
	let child: ChildProcess;
	try {
		child = spawn(spec.command, argv, {
			cwd: workdir,
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
	} catch (err) {
		opts.onFrame?.({ type: "agent_ended", agentId: subId });
		return { status: "failed", text: "", steps: 0, mutated: false, error: err instanceof Error ? err.message : String(err) };
	}
	const killTimer = { t: undefined as ReturnType<typeof setTimeout> | undefined };
	killGroup = (sig: NodeJS.Signals): void => {
		try {
			if (child.pid) process.kill(-child.pid, sig);
		} catch {
			try {
				child.kill(sig);
			} catch {
				/* already gone */
			}
		}
	};
	const scheduleKill = (): void => {
		if (killTimer.t) return;
		killTimer.t = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		killTimer.t.unref?.();
	};

	let stdout = "";
	let stderr = "";
	let exitCode: number | null = null;
	child.stdout?.on("data", (d) => (stdout += String(d)));
	child.stderr?.on("data", (d) => (stderr += String(d)));
	const exited = new Promise<void>((resolve) => {
		child.on("exit", (code) => {
			exitCode = code;
			resolve();
		});
		child.on("error", (err) => {
			stderr += `\n${err.message}`;
			exitCode = -1;
			resolve();
		});
	});

	// The task (with instructions prepended and the parent digest appended —
	// the same handoff an in-process sub gets) goes to the child's stdin.
	const digestStart = prompt.indexOf("--- Auto handoff digest");
	const digest = digestStart >= 0 ? `\n\n${prompt.slice(digestStart)}` : "";
	const taskBody = digestStart >= 0 ? prompt.slice(0, digestStart).trim() : prompt;
	const stdinPayload = `${opts.instructions}\n\n---\n\nTASK:\n${taskBody}${digest}\n\nEnd with a final report — your last message is returned verbatim to the coordinating agent.`;
	child.stdin?.on("error", () => {
		/* EPIPE when the CLI exits before draining stdin — the exit path handles it */
	});
	child.stdin?.end(stdinPayload);

	// --- log tailing ---------------------------------------------------------
	let tail: JsonlTail | undefined;
	let codexDirs: Array<{ dir: string; before: Set<string> }> | undefined;
	let tailFile: string | undefined;
	if (spec.log === "claude") {
		tailFile = claudeLogPath(workdir, cliSessionId, opts.logConfigDir ?? cliLogRoot("claude", childEnv));
		tail = new JsonlTail(tailFile, (line) => ingest(adaptClaudeLine(line, () => cliSessionId)));
	} else if (spec.log === "codex") {
		const root = opts.logConfigDir ?? cliLogRoot("codex", childEnv);
		const today = codexSessionDir(new Date(), root);
		const yesterday = codexSessionDir(new Date(Date.now() - 24 * 3600_000), root);
		codexDirs = [
			{ dir: today, before: await snapshotDir(today) },
			{ dir: yesterday, before: await snapshotDir(yesterday) },
		];
	}
	const pollTimer = setInterval(() => {
		if (tail) void tail.poll();
		else if (codexDirs) {
			void findCodexRollout(codexDirs, workdir).then((file) => {
				if (!file || tail) return;
				tailFile = file;
				tail = new JsonlTail(file, (line) => ingest(adaptCodexLine(line, () => cliSessionId)));
				tail.start();
			});
		}
	}, 500);
	pollTimer.unref?.();
	tail?.start();

	// --- budgets / abort ------------------------------------------------------
	const deadline = setTimeout(() => {
		exhausted = "time";
		killGroup("SIGTERM");
		scheduleKill();
	}, timeoutMs);
	deadline.unref?.();
	const onAbort = (): void => {
		aborted = true;
		killGroup("SIGTERM");
		scheduleKill();
	};
	opts.signal?.addEventListener("abort", onAbort);

	report("starting", 0);
	try {
		await exited;
		// Give the CLI's own log flush a beat, then drain it once more.
		await new Promise((r) => setTimeout(r, 300));
		await tail?.poll();
		await recording;

		const partial = lastAssistant(conversation);
		const note = (extra: string): string => (tx ? `${extra} (transcript: ${tx.path()}${tailFile ? `, source log: ${tailFile}` : ""})` : extra);
		if (aborted) return { status: "aborted", text: partial, steps, mutated: true, transcript: tx?.path() };
		if (exhausted) {
			const limit = exhausted === "steps" ? `${maxSteps}-step` : `${Math.round(timeoutMs / 60_000)}-minute`;
			opts.log?.(note(`cli sub-agent ${label} exhausted (${limit} budget)`));
			return { status: "exhausted", text: partial, steps, mutated: true, transcript: tx?.path(), limit };
		}
		if (exitCode !== 0) {
			const error = stderr.trim().slice(-2000) || `exit code ${exitCode}`;
			opts.log?.(note(`cli sub-agent ${label} failed (exit ${exitCode})`));
			return { status: "failed", text: partial, steps, mutated: true, transcript: tx?.path(), error };
		}

		const text = await extractResult({ spec, stdout, resultFile, partial });
		opts.log?.(note(`cli sub-agent ${label} (${steps} step(s)) → done`));
		return { status: "ok", text, steps, mutated: true, transcript: tx?.path() };
	} finally {
		clearTimeout(deadline);
		clearTimeout(killTimer.t);
		clearInterval(pollTimer);
		tail?.stop();
		opts.signal?.removeEventListener("abort", onAbort);
		if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
		// Close the lifecycle on EVERY exit path, exactly like runSub.
		opts.onFrame?.({ type: "agent_ended", agentId: subId });
	}
}

/** Last assistant text from the adapted conversation (the fallback result). */
function lastAssistant(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const c = m.content as Array<{ type?: string; text?: string }>;
		const text = (Array.isArray(c) ? c : [])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * The machine-readable result, best-effort per log format:
 *   claude → stdout JSON's `.result` (`.subtype:"error_max_turns"` is an
 *            exhaustion signal); malformed JSON falls back to raw stdout;
 *   codex  → the `--output-last-message` file;
 *   none   → stdout verbatim.
 * Every path's last resort is the last assistant message from the tailed log.
 */
async function extractResult(opts: {
	spec: AgentDefinition["cli"];
	stdout: string;
	resultFile: string;
	partial: string;
}): Promise<string> {
	const { spec, stdout, resultFile, partial } = opts;
	if (spec?.log === "claude") {
		try {
			const parsed = JSON.parse(stdout.trim()) as { result?: string; subtype?: string } | Array<{ result?: string; subtype?: string }>;
			// `--verbose` makes stdout an ARRAY of every event, the result summary
			// last; without it stdout is the result object alone. Measured both.
			const final = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
			if (final?.subtype === "error_max_turns") return partial || "(claude hit its turn limit)";
			if (typeof final?.result === "string" && final.result.trim()) return final.result;
		} catch {
			/* fall through */
		}
		const raw = stdout.trim();
		return raw || partial;
	}
	if (spec?.log === "codex") {
		const file = await readFile(resultFile, "utf8").catch(() => null);
		if (file && file.trim()) return file.trim();
		return partial;
	}
	return stdout.trim() || partial;
}
