/**
 * run_agent cwd-parameter smoke — the narrowed-sub-agent contract, end to end
 * and LLM-free (provider seam stubbed with AssistantMessageEventStream):
 *
 *   schema → cwd validation → sub construction (cwd/rootDir/{cwd} vars/
 *   CLAUDE.md dedup) → the SUB's real read tool climbing ../ to the parent
 *   workspace root through the widened jail.
 *
 * Companion to smoke-fs-jail.ts (which covers resolveJailedPath in isolation,
 * including the root-widening cases). Run: `npx tsx scripts/smoke-runagent-cwd.ts`
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { mkdtemp, tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { createRunAgentTool } from "../agent/agents/run-agent-tool";
import type { ResolvedRuntime } from "../agent/models";
import type { AgentDefinition } from "../agent/agents/types";
import type { WorkerFrame } from "../agent/protocol";

const parent = mkdtempSync(join(tmpdir(), "smoke-rag-cwd-"));
const web = join(parent, "web");
const deep = join(web, "deep");
const agentMd = join(parent, "agentmd");
mkdirSync(deep, { recursive: true });
mkdirSync(agentMd);
writeFileSync(join(web, "a.txt"), "inside sub");
writeFileSync(join(parent, "root.txt"), "at root");
writeFileSync(join(parent, "CLAUDE.md"), "ROOT-CLAUDE-MARKER");
writeFileSync(join(web, "CLAUDE.md"), "WEB-CLAUDE-MARKER");
writeFileSync(join(deep, "CLAUDE.md"), "DEEP-CLAUDE-MARKER");
writeFileSync(join(agentMd, "AGENT.md"), "AGENTMD-MARKER");

/** Captured provider requests (system prompt + messages per streamFn call). */
const captured: { systemPrompt?: string; messages?: unknown[] }[] = [];

/**
 * Scripted streamFn: call 1 = a `read ../root.txt` toolCall (proving the
 * sub's OWN jail lets it climb), call 2 = final text. Requests are captured
 * for system-prompt assertions.
 */
const makeRuntime = (finalText: string): ResolvedRuntime => {
	let call = 0;
	const wrapped = (_model: unknown, request: { systemPrompt?: string; messages?: unknown[] }) => {
		captured.push({ systemPrompt: request?.systemPrompt, messages: request?.messages });
		call += 1;
		const s = new AssistantMessageEventStream();
		const isFinal = call > 1;
		void (async () => {
			const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
			const message: AssistantMessage = {
				role: "assistant",
				content: isFinal
					? [{ type: "text", text: finalText }]
					: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "../root.txt" } }],
				api: "pi-messages",
				provider: "stub",
				model: "stub-model",
				usage,
				stopReason: isFinal ? "stop" : "toolUse",
				timestamp: Date.now(),
			};
			const partial: AssistantMessage = { ...message, content: [...message.content] };
			s.push({ type: "start", partial });
			s.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			s.end(message);
		})();
		return s;
	};
	return { streamFn: wrapped as never } as unknown as ResolvedRuntime;
};

const agents: AgentDefinition[] = [
	{ name: "coder", description: "test coder", body: "CWD={cwd} coder.", path: "/tmp/coder.md", source: "builtin" },
];

const frames: WorkerFrame[] = [];
const mkDeps = (runtime: ResolvedRuntime) => ({
	agents,
	runtime,
	cwd: parent,
	skills: [],
	vars: { cwd: parent, project: "p", sessionId: "s", date: "2026-08-23", os: "linux" },
	agentId: "parent-1",
	parentMessages: () =>
		[
			{ role: "user", content: "original user request for the whole job" },
			{ role: "assistant", content: "Parent concluded the build must land under web/ and tests stay green." },
			{ role: "user", content: "latest follow-up: make the login page blue and keep the copy unchanged" },
		] as never,
	onFrame: (f: WorkerFrame) => frames.push(f),
});

const out: string[] = [];
let failed = 0;
const ok = (name: string, cond: boolean, extra = "") => {
	if (!cond) failed++;
	out.push(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

// ---- narrowed cwd happy path --------------------------------------------------
{
	const tool = createRunAgentTool(mkDeps(makeRuntime("sub-ok")) as never);
	const res = await tool.execute("tc1", { type: "coder", task: "do the web thing", context: "", cwd: "web" } as never);
	const sys = captured[0]?.systemPrompt ?? "";
	const sysHas = (s: string) => sys.includes(s);
	ok("returns sub final text", res.content.some((c) => c.type === "text" && c.text === "sub-ok"));
	ok("{cwd} var rendered to sub cwd", sysHas(`CWD=${web} coder.`));
	ok("env section cwd line", sysHas(`- Workspace: ${web}`));
	ok("env section root line", sysHas(`- Workspace root: ${parent}`));
	ok("env climb guidance", sysHas("look upward as far as this root"));
	ok("sub's own CLAUDE.md loaded", sysHas("WEB-CLAUDE-MARKER"));
	ok("root CLAUDE.md in the sub's own chain (diff cwd)", sysHas("ROOT-CLAUDE-MARKER"));
	ok("chain order: root file before sub's (override)", sys.indexOf("ROOT-CLAUDE-MARKER") < sys.indexOf("WEB-CLAUDE-MARKER"));
	const turn2 = JSON.stringify(captured[1]?.messages ?? []);
	ok("sub read tool climbed to root", turn2.includes("at root") && !turn2.includes("Path refused"), turn2.slice(0, 200));
	const turn1 = JSON.stringify(captured[0]?.messages ?? []);
	ok(
		"auto digest reached the sub (original + latest user, verbatim)",
		turn1.includes("Auto handoff digest") &&
			turn1.includes("original user request") &&
			turn1.includes("Latest user message") &&
			turn1.includes("make the login page blue and keep the copy unchanged"),
	);
	const spawn = frames.find((f) => f.type === "agent_spawned") as { label?: string } | undefined;
	ok("spawn frame label shows narrowed cwd", String(spawn?.label).includes("· web"), String(spawn?.label));
}

// ---- validation branches (must not reach the provider) -------------------------
{
	const before = captured.length;
	const tool = createRunAgentTool(mkDeps(makeRuntime("never")) as never);
	const text = async (args: Record<string, unknown>) => {
		const r = await tool.execute("tc", args as never);
		return (r.content.find((c) => c.type === "text") as { text?: string } | undefined)?.text ?? "";
	};
	const b = await text({ type: "coder", task: "t", cwd: "../outside" });
	ok("outside workspace refused", b.includes("inside your workspace"), b);
	const c = await text({ type: "coder", task: "t", cwd: "missing-dir" });
	ok("missing dir refused", c.includes("does not exist"), c);
	const outside = mkdtempSync(join(tmpdir(), "smoke-rag-out-"));
	symlinkSync(outside, join(parent, "escape-link"));
	const e = await text({ type: "coder", task: "t", cwd: "escape-link" });
	ok("symlink escape refused", e.includes("inside your workspace"), e);
	ok("no streamFn calls on invalid cwd", captured.length === before);
}

// ---- no cwd → no root line, CLAUDE.md deduped to exactly one copy --------------
{
	const tool = createRunAgentTool(mkDeps(makeRuntime("sub-ok")) as never);
	await tool.execute("tc2", { type: "coder", task: "plain" } as never);
	const sys = captured[captured.length - 1]?.systemPrompt ?? "";
	ok("no root line on default cwd", !sys.includes("Workspace root:"));
	ok("same-cwd CLAUDE dedup (one copy)", (sys.match(/ROOT-CLAUDE-MARKER/g) ?? []).length === 1);
}

// ---- AGENT.md fallback: no CLAUDE.md present → AGENT.md is the sub's own file ---
{
	const tool = createRunAgentTool(mkDeps(makeRuntime("sub-ok")) as never);
	await tool.execute("tc3", { type: "coder", task: "t", cwd: "agentmd" } as never);
	const sys = captured[captured.length - 1]?.systemPrompt ?? "";
	ok("AGENT.md loaded when no CLAUDE.md", sys.includes("AGENTMD-MARKER") && sys.includes("(AGENT.md at"));
	ok("root still precedes AGENT.md sub", sys.indexOf("ROOT-CLAUDE-MARKER") < sys.indexOf("AGENTMD-MARKER"));
}

// ---- 3-level chain: root → web → web/deep, each level loaded in order -------
{
	const tool = createRunAgentTool(mkDeps(makeRuntime("sub-ok")) as never);
	await tool.execute("tc4", { type: "coder", task: "t", cwd: "web/deep" } as never);
	const sys = captured[captured.length - 1]?.systemPrompt ?? "";
	const iR = sys.indexOf("ROOT-CLAUDE-MARKER");
	const iW = sys.indexOf("WEB-CLAUDE-MARKER");
	const iD = sys.indexOf("DEEP-CLAUDE-MARKER");
	ok("all three chain levels loaded", iR >= 0 && iW >= 0 && iD >= 0);
	ok("chain order root < web < deep (deepest overrides)", iR < iW && iW < iD);
}

console.log(out.join("\n"));
console.log(`smoke-runagent-cwd: ${out.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
