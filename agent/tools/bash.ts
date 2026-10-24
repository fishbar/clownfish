/**
 * bash tool — execute a shell command, stream output, tail-truncate large output.
 *
 * Adapted from pi's bash tool: pluggable operations, an OutputAccumulator that
 * keeps a bounded tail and spills to a temp file, throttled onUpdate streaming,
 * process-tree kill on abort/timeout, and non-zero-exit reported by throwing.
 * Self-contained (no pi shell utils): spawns `bash -c`, resolves on 'exit' so
 * detached descendants holding stdio can't hang the await.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";
import { screenBashCommand } from "./fs-jail";
import { OutputAccumulator } from "./output-accumulator";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate";
import { rtkRewrite } from "./rtk-backend";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute in the workspace cwd." }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds." })),
});

export interface BashToolDetails {
	truncation?: { truncated: boolean; totalLines: number; outputLines: number };
	fullOutputPath?: string;
	/** Child shell pid — reported via onUpdate for live process monitoring. */
	pid?: number;
}

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			/** Child pid, reported as soon as the process is spawned. */
			onPid?: (pid: number) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Local shell backend: spawns `bash -c`, kills the whole process group on abort/timeout. */
export function createLocalBashOperations(): BashOperations {
	return {
		exec: async (command, cwd, { onData, onPid, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) throw new Error("aborted");
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const detached = process.platform !== "win32";
			const child = spawn("bash", ["-c", command], {
				cwd,
				detached,
				env: env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) onPid?.(child.pid);

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const killTree = () => {
				if (!child.pid) return;
				try {
					detached ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL");
				} catch {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
			};
			const onAbort = () => killTree();

			try {
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMs);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				const exitCode: number | null = await new Promise((resolve) => {
					child.once("exit", (code, signal) => {
						if (signal && code === null) resolve(null);
						else resolve(code);
					});
					child.once("error", () => resolve(1));
				});

				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashToolOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	env?: NodeJS.ProcessEnv;
}

const BASH_UPDATE_THROTTLE_MS = 100;

/**
 * A bash command whose ONLY job is looking at files — the case the dedicated
 * tools exist for. Detected on the leading verb of the whole command (so
 * `node --test | grep FAIL` is left alone: its first word runs something),
 * and only when nothing is redirected into a file.
 *
 * Prompting alone does not stop this: the guidelines already said "prefer the
 * dedicated tools" while the measured split was 73 shell greps to 2 tool
 * calls. So the reminder is delivered where the mistake happens — attached to
 * the result the model is reading — rather than in a rule it skimmed past.
 * The command still runs; nothing is rewritten or refused.
 */
const READ_ONLY_SHELL: Record<string, string> = {
	cat: "read",
	head: "read (offset/limit)",
	tail: "read (offset/limit)",
	less: "read",
	more: "read",
	grep: "grep",
	rg: "grep",
	ag: "grep",
	egrep: "grep",
	fgrep: "grep",
	find: "find",
	fd: "find",
	ls: "ls",
	tree: "find",
	awk: "read/grep",
};

export function inspectionNudge(command: string): string | undefined {
	const trimmed = command.trim();
	// A redirect into a FILE means the command produces one, not just a look.
	// `2>&1` is an fd dup, not a file — it must not suppress the nudge.
	if (/(^|\s)\d?>>?\s*[^>&\s]/.test(trimmed)) return undefined;
	// find with -delete/-exec mutates; the "read-only look" note would be false.
	if (/^find\s/.test(trimmed) && /\s-(delete|exec|execdir)\b/.test(trimmed)) return undefined;
	const first = trimmed.split(/\s+/)[0]?.split("/").pop() ?? "";
	// `sed -n` is a read (print a range); `sed -i` and script-applying forms
	// mutate, and the "never edit through the shell" guideline owns those.
	if (first === "sed") {
		return /^sed\s+-n\b/.test(trimmed) ? "[note] this was a read-only look at files; the `read` tool's offset/limit does it with capped output — its result costs a fraction of this one, on this turn and every later turn that re-sends it." : undefined;
	}
	const better = READ_ONLY_SHELL[first];
	if (!better) return undefined;
	return `[note] this was a read-only look at files; the \`${better}\` tool does it without walking .gitignore'd paths and with capped output — its result costs a fraction of this one, on this turn and every later turn that re-sends it.`;
}

export function createBashTool(cwd: string, options?: BashToolOptions): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const ops = options?.operations ?? createLocalBashOperations();
	const commandPrefix = options?.commandPrefix;
	const env = options?.env;
	return defineTool<typeof bashSchema, BashToolDetails | undefined>({
		name: "bash",
		label: "bash",
		mode: "W",
		description: `Execute a bash command in the workspace cwd. Returns combined stdout and stderr. Output is tail-truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever hits first); when truncated, the full output is saved to a temp file and its path is returned. Non-zero exit codes are reported as errors. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		prompt: {
			snippet: "Execute bash commands (build, test, git, one-off commands)",
			guidelines: [
				"Do NOT use bash to look at files — no `cat`, `head`, `tail`, `grep`, `rg`, `find`, `ls`. Use read/grep/find/ls instead. A tool result stays in the conversation and is re-sent on EVERY later turn, and shell search does not skip `node_modules`/`dist`/`.git`: one `grep -rn` over a repo can match millions of lines, of which you keep a truncated tail of the least useful part. The dedicated tools skip ignored paths, cap their output, and page.",
				"bash is for things that RUN: builds, tests, git, package managers, scripts. When a command is genuinely needed and prints a lot, bound it yourself (`--quiet`, `-q`, `2>&1 | tail -30`).",
				"Never edit files through the shell (`sed -i`, `>`, `>>`, `tee`) — use edit or write so the change is reviewable.",
				"Avoid long-running interactive commands; use the timeout option when a command may hang.",
				"Quote paths that may contain spaces, and never interpolate untrusted text into a command.",
			],
		},
		executionMode: "sequential",
		async execute(_toolCallId, { command, timeout }, signal, onUpdate): Promise<AgentToolResult<BashToolDetails | undefined>> {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			// Session-isolation screen (best-effort): refuse commands whose text
			// references the dataDir/sessionsDir roots or climbs out of the
			// workspace. See agent/tools/fs-jail.ts for the threat model.
			const refusal = screenBashCommand(resolvedCommand, cwd);
			if (refusal) throw refusal;
			// Optional rtk output compaction: run `rtk git status` instead of
			// `git status` when the installed rtk offers a TRUSTED rewrite (see
			// rtk-backend.ts for the allowlist). Applied to the model's command
			// only — the harness prefix is never rewritten. Same output, less
			// noise; if rtk vanished since the probe (exit 127) the original
			// command is re-run below, so the model never sees the seam.
			const rewritten = await rtkRewrite(command);
			let output = new OutputAccumulator({ tempFilePrefix: "clownfish-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			let pid: number | undefined;
			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated
							? { truncated: true, totalLines: snapshot.truncation.totalLines, outputLines: snapshot.truncation.outputLines }
							: undefined,
						fullOutputPath: snapshot.fullOutputPath,
						pid,
					},
				});
			};
			/** pid arrives right after spawn — push it out immediately (no throttle). */
			const handlePid = (p: number): void => {
				pid = p;
				onUpdate?.({ content: [], details: { pid: p } });
			};
			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};
			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) onUpdate({ content: [], details: undefined });

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation: { truncated: true, totalLines: truncation.totalLines, outputLines: truncation.outputLines }, fullOutputPath: snapshot.fullOutputPath, pid };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let effective = rewritten ? (commandPrefix ? `${commandPrefix}\n${rewritten}` : rewritten) : resolvedCommand;
				let attempt = 0;
				try {
					for (;;) {
						attempt++;
						const result = await ops.exec(effective, cwd, { onData: handleData, onPid: handlePid, signal, timeout, env });
						exitCode = result.exitCode;
						// 127 from a rewrite = rtk itself was not runnable; discard
						// that attempt's output entirely and run what the model wrote.
						if (exitCode === 127 && rewritten && attempt === 1) {
							acceptingOutput = false;
							output.finish();
							await output.closeTempFile();
							output = new OutputAccumulator({ tempFilePrefix: "clownfish-bash" });
							acceptingOutput = true;
							effective = resolvedCommand;
							continue;
						}
						break;
					}
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") throw new Error(appendStatus(text, "Command aborted"));
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				const nudge = inspectionNudge(command);
				return { content: [{ type: "text", text: nudge ? `${nudge}\n${outputText}` : outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
	});
}
