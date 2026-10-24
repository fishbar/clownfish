/**
 * External CLI sub-agents — offline checks.
 *
 * No real `codex`/`claude` binary and no provider credentials: the adapters
 * are fed recorded JSONL fixtures, and the runner is exercised end-to-end
 * against a FAKE CLI (a node script that writes a claude-shaped session log
 * into an injected log root and prints the documented result JSON), driven
 * through the real `createRunAgentTool`. What is pinned:
 *   - the claude/codex log adapters' event/message mapping (incl. sidechain
 *     filtering and tool counting),
 *   - argv placeholder substitution (the {model}-pair drop included),
 *   - the run contract: ok result, mirrored transcript, progress rows with
 *     the bus agentId, frames (agent_spawned/event/agent_ended),
 *   - budgets (timeout → exhausted), abort propagation,
 *   - the config store round-trip (defaults, override, tombstone) and gating.
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunAgentTool, type AgentDefinition } from "../agent/agents/run-agent-tool.ts";
import { deleteCliAgent, listCliAgents, saveCliAgent } from "../agent/agents/cli-config.ts";
import { buildCliArgs } from "../agent/agents/cli-sub.ts";
import { adaptClaudeLine, adaptCodexLine, cliLogRoot } from "../agent/agents/cli-log-tail.ts";
import { cliChildEnv } from "../agent/cli-env.ts";
import type { WorkerFrame } from "../agent/protocol.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail.slice(0, 400)}`}`);
}

// ---------------------------------------------------------------------------
// 1. adapters, against recorded log shapes
// ---------------------------------------------------------------------------
{
	const seq = (() => 0)();
	// claude: an assistant turn with a tool_use + its tool_result.
	const assistant = adaptClaudeLine(
		JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "Checking the file." }, { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/tmp/x" } }] },
			uuid: "u1",
			timestamp: "2026-09-26T01:02:03.000Z",
		}),
		() => String(seq),
	);
	check(
		"claude assistant line → message events + tool_execution_start",
		assistant.events.filter((e) => e.type === "message_end").length === 1 && assistant.events.some((e) => e.type === "tool_execution_start" && e.toolName === "Read"),
	);
	check("claude assistant message carries the toolCall block for the transcript", (assistant.messages[0]?.content as Array<{ type: string }>).some((b) => b.type === "toolCall"));

	const toolResult = adaptClaudeLine(
		JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body", is_error: false }] },
			uuid: "u2",
			timestamp: "2026-09-26T01:02:04.000Z",
		}),
		() => String(seq),
	);
	check(
		"claude tool_result line → tool_execution_end keyed by the call id",
		toolResult.events.some((e) => e.type === "tool_execution_end" && e.toolCallId === "tu_1") && toolResult.messages[0]?.role === "toolResult",
	);

	const sidechain = adaptClaudeLine(
		JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "inner" }] }, uuid: "u3", timestamp: "2026-09-26T01:02:05.000Z" }),
		() => String(seq),
	);
	check("claude sidechain (the CLI's OWN sub-agent) is filtered out", sidechain.events.length === 0 && sidechain.messages.length === 0);

	const system = adaptClaudeLine(JSON.stringify({ type: "system", subtype: "local_command", content: "noise", uuid: "u4", timestamp: "2026-09-26T01:02:06.000Z" }), () => String(seq));
	check("claude system lines are ignored", system.events.length === 0);

	// codex: message / function_call / function_call_output payloads.
	const codexMsg = adaptCodexLine(
		JSON.stringify({ timestamp: "2026-09-26T01:02:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
		() => "0",
	);
	check("codex assistant message → message_end", codexMsg.events[0]?.type === "message_end" && (codexMsg.messages[0] as { content: Array<{ text?: string }> }).content[0]?.text === "Done.");

	const codexCall = adaptCodexLine(
		JSON.stringify({ timestamp: "2026-09-26T01:02:04.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}", call_id: "c1" } }),
		() => "0",
	);
	check("codex function_call → tool_execution_start with parsed args", codexCall.events[0]?.type === "tool_execution_start" && (codexCall.events[0] as { args?: { command?: string } }).args?.command === "ls");

	const codexOut = adaptCodexLine(
		JSON.stringify({ timestamp: "2026-09-26T01:02:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a.txt" } }),
		() => "0",
	);
	check("codex function_call_output → tool_execution_end + toolResult message", codexOut.events[0]?.type === "tool_execution_end" && codexOut.messages[0]?.role === "toolResult");

	const codexMeta = adaptCodexLine(JSON.stringify({ timestamp: "2026-09-26T01:02:02.000Z", type: "session_meta", payload: { id: "s", cwd: "/w" } }), () => "0");
	check("codex session_meta is ignored", codexMeta.events.length === 0);
}

// ---------------------------------------------------------------------------
// 2. argv placeholder substitution
// ---------------------------------------------------------------------------
{
	const full = buildCliArgs(["-p", "--session-id", "{session-id}", "--model", "{model}", "--out", "{result-file}", "--cwd", "{workdir}"], {
		sessionId: "UUID",
		workdir: "/w",
		model: "gpt-9",
		resultFile: "/tmp/r.txt",
	});
	check(
		"placeholders substitute; {model} kept when set",
		full.join(" ") === "-p --session-id UUID --model gpt-9 --out /tmp/r.txt --cwd /w",
		full.join(" "),
	);
	const dropped = buildCliArgs(["-p", "--model", "{model}", "--verbose"], { sessionId: "U", workdir: "/w", model: undefined, resultFile: "/r" });
	check("{model} with no model drops itself AND its flag", dropped.join(" ") === "-p --verbose", dropped.join(" "));
	// Log roots resolve from the CHILD's env (allowlist + entry env:{}).
	check("cliLogRoot: CLAUDE_CONFIG_DIR wins", cliLogRoot("claude", { CLAUDE_CONFIG_DIR: "/c", HOME: "/h" }) === "/c");
	check("cliLogRoot: else HOME/.claude", cliLogRoot("claude", { HOME: "/h" }) === join("/h", ".claude"));
	check("cliLogRoot: CODEX_HOME wins, else HOME/.codex", cliLogRoot("codex", { CODEX_HOME: "/x" }) === "/x" && cliLogRoot("codex", { HOME: "/h" }) === join("/h", ".codex"));
	const savedEnv = { c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME, t: process.env.ANTHROPIC_AUTH_TOKEN };
	process.env.CLAUDE_CONFIG_DIR = "/cfg";
	process.env.CODEX_HOME = "/cx";
	process.env.ANTHROPIC_AUTH_TOKEN = "secret";
	const ce = cliChildEnv();
	check("the CLI's own config-dir vars reach the child", ce.CLAUDE_CONFIG_DIR === "/cfg" && ce.CODEX_HOME === "/cx");
	check("provider credentials still do not", ce.ANTHROPIC_AUTH_TOKEN === undefined);
	for (const [k, v] of [["CLAUDE_CONFIG_DIR", savedEnv.c], ["CODEX_HOME", savedEnv.x], ["ANTHROPIC_AUTH_TOKEN", savedEnv.t]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// ---------------------------------------------------------------------------
// 3. config store: defaults, override, tombstone, validation
// ---------------------------------------------------------------------------
{
	const dataDir = mkdtempSync(join(tmpdir(), "cli-agents-cfg-"));
	const defaults = await listCliAgents(dataDir);
	check("shipped defaults list codex + claude-code", defaults.some((a) => a.name === "claude-code" && a.log === "claude") && defaults.some((a) => a.name === "codex" && a.log === "codex"));
	await saveCliAgent(dataDir, { name: "mytool", log: "none", command: "/usr/bin/env", args: ["--flag"] });
	const afterSave = await listCliAgents(dataDir);
	check("a custom entry is added", afterSave.some((a) => a.name === "mytool"));
	await saveCliAgent(dataDir, { name: "claude-code", log: "claude", command: "/opt/homebrew/bin/claude", args: ["-p"] });
	const afterOverride = await listCliAgents(dataDir);
	check("same-name save REPLACES the default", afterOverride.find((a) => a.name === "claude-code")?.command === "/opt/homebrew/bin/claude");
	await deleteCliAgent(dataDir, "claude-code");
	const afterDelete = await listCliAgents(dataDir);
	check("deleting a default tombstones it (stays gone)", !afterDelete.some((a) => a.name === "claude-code") && afterDelete.some((a) => a.name === "codex"));
	let threw = false;
	try {
		await saveCliAgent(dataDir, { name: "bad entry!", log: "none", command: "x" });
	} catch {
		threw = true;
	}
	check("an invalid name is rejected", threw);
	let threwNoCmd = false;
	try {
		await saveCliAgent(dataDir, { name: "ok-name", log: "none", command: "" });
	} catch {
		threwNoCmd = true;
	}
	check("an empty command is rejected", threwNoCmd);
	rmSync(dataDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. end-to-end through createRunAgentTool with a FAKE claude CLI
// ---------------------------------------------------------------------------
{
	const dataDir = mkdtempSync(join(tmpdir(), "cli-sub-e2e-"));
	const workdir = join(dataDir, "ws");
	mkdirSync(workdir, { recursive: true });
	// The log root is set ONLY in the entry's env:{} — the way an operator
	// points one CLI at its own config dir. The worker's own CLAUDE_CONFIG_DIR
	// is a decoy: the tail must follow the CHILD's env, where the fake (like
	// the real claude) actually writes. Tailing the worker's once missed it.
	const logRoot = join(dataDir, "claude-root");
	process.env.CLAUDE_CONFIG_DIR = join(dataDir, "decoy-root");
	// The slug claude keys its project dir on: the RESOLVED cwd with slashes
	// replaced (leading dash kept) — the same formula claudeProjectDir applies.
	const slug = realpathSync(workdir).split("/").join("-");
	const fakeCli = join(dataDir, "fake-claude.mjs");
	// The fake CLI: reads the task from stdin, echoes a claude-shaped session
	// log (one tool call + result + a final assistant message), prints the
	// documented result JSON. The session id arrives as the {session-id} argv
	// slot — the same mechanism the real claude uses.
	writeFileSync(
		fakeCli,
		`import { mkdirSync, appendFileSync } from "node:fs";
const sessionId = process.argv[2];
let task = "";
for await (const chunk of process.stdin) task += chunk;
const dir = process.env.CLAUDE_CONFIG_DIR + "/projects/" + process.env.FAKE_SLUG;
mkdirSync(dir, { recursive: true });
const log = dir + "/" + sessionId + ".jsonl";
const line = (o) => appendFileSync(log, JSON.stringify(o) + "\\n");
line({ type: "user", message: { role: "user", content: task }, uuid: "1", timestamp: new Date().toISOString() });
line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working." }, { type: "tool_use", id: "tu_9", name: "Write", input: { path: "hello.txt" } }] }, uuid: "2", timestamp: new Date().toISOString() });
line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_9", content: "ok", is_error: false }] }, uuid: "3", timestamp: new Date().toISOString() });
line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "hidden inner sub-agent" }] }, uuid: "4", timestamp: new Date().toISOString() });
line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Created hello.txt with the requested content." }] }, uuid: "5", timestamp: new Date().toISOString() });
process.stdout.write(JSON.stringify({ result: "Created hello.txt with the requested content.", subtype: "success" }));
`,
	);
	const sessionsDir = join(dataDir, "sessions");
	const frames: WorkerFrame[] = [];
	const updates: string[] = [];
	const def: AgentDefinition = {
		name: "claude-code",
		description: "fake",
		access: "RW",
		body: "You are a test.",
		path: fakeCli,
		source: "cli-config",
		cli: {
			log: "claude",
			command: process.execPath,
			args: [fakeCli, "{session-id}", "--model", "{model}"],
			env: { CLAUDE_CONFIG_DIR: logRoot, FAKE_SLUG: slug },
		},
	};
	const { tool } = createRunAgentTool({
		agents: [def],
		runtime: { model: { id: "fake" } } as never,
		cwd: workdir,
		skills: [],
		vars: { cwd: workdir, project: "p", sessionId: "s1", date: "2026-09-26", os: "darwin" },
		sessionId: "s1",
		sessionsDir,
		onFrame: (f) => frames.push(f),
		verify: "off",
		agentId: "s1",
		maxSteps: 10,
		timeoutMs: 20_000,
	});
	const result = await tool.execute(
		"tc1",
		{ type: "claude-code", task: "create hello.txt" } as never,
		new AbortController().signal,
		(p) => updates.push(p.content[0]?.text ?? ""),
	);
	const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? "";
	check("fake claude delegation returns the parsed result", text.includes("Created hello.txt"), text);
	check("agent_spawned + agent_ended frames bookended the run", frames.some((f) => f.type === "agent_spawned") && frames.some((f) => f.type === "agent_ended"));
	const eventFrames = frames.filter((f) => f.type === "event");
	check("adapted events were forwarded under the sub's bus id", eventFrames.length > 0 && eventFrames.every((f) => (f as { agentId?: string }).agentId?.startsWith("sub1-claude-code")));
	const toolStarts = eventFrames.filter((f) => (f as { event?: { type?: string } }).event?.type === "tool_execution_start");
	check("the CLI's tool calls counted as steps", toolStarts.length === 1 && updates.some((u) => u.includes("1 step(s)")));
	check("the sidechain line never reached the bus", !eventFrames.some((f) => JSON.stringify(f).includes("hidden inner sub-agent")));
	const transcriptPath = join(sessionsDir, "s1", "sub1-claude-code.jsonl");
	check("the conversation was mirrored into the standard transcript", existsSync(transcriptPath));
	const mirrored = readFileSync(transcriptPath, "utf8");
	check("mirrored transcript uses the {id,ts,message} envelope", mirrored.includes('"message"') && mirrored.includes("Created hello.txt"));
	const fakeLogDir = join(logRoot, "projects", slug);
	check("the fake CLI's log was actually written where discovery looks", existsSync(fakeLogDir));
	check("the log root came from the entry's env, not the worker's", !existsSync(join(dataDir, "decoy-root")) && toolStarts.length === 1);

	// timeout budget → exhausted, process group reaped
	const sleepy = join(dataDir, "sleepy.mjs");
	writeFileSync(sleepy, `process.stdout.write("starting\\n"); setInterval(() => {}, 1000);`);
	const sleepyDef: AgentDefinition = { ...def, name: "sleeper", cli: { log: "none", command: process.execPath, args: [sleepy] } };
	const { tool: tool2 } = createRunAgentTool({
		agents: [sleepyDef],
		runtime: { model: { id: "fake" } } as never,
		cwd: workdir,
		skills: [],
		vars: { cwd: workdir, project: "p", sessionId: "s2", date: "2026-09-26", os: "darwin" },
		sessionId: "s2",
		verify: "off",
		maxSteps: 10,
		timeoutMs: 800,
	});
	const r2 = await tool2.execute("tc2", { type: "sleeper", task: "sleep forever" } as never, new AbortController().signal);
	const t2 = (r2 as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? "";
	check("timeout budget → a clear not-finished report", t2.includes("did NOT finish") || t2.includes("budget"), t2);

	// abort mid-run
	const ac = new AbortController();
	const abortResult = tool2.execute("tc3", { type: "sleeper", task: "sleep" } as never, ac.signal);
	setTimeout(() => ac.abort(), 400);
	const r3 = await abortResult;
	const t3 = (r3 as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? "";
	check("abort propagates to the CLI process", t3.includes("aborted") || t3.includes("stopped"), t3);

	rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\ncli-subagent: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ""}`);
if (failures.length) {
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
