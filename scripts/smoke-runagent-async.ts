/**
 * run_agent async-mode smoke — the background delegation contract, end to end
 * and LLM-free (provider seam stubbed with AssistantMessageEventStream, same
 * technique as smoke-runagent-cwd):
 *
 *   1. async: true returns IMMEDIATELY with a started marker (the sub's reply
 *      is gate-held, so "faster than the sub" is deterministic, not timed),
 *      agent_spawned already on the bus, no agent_ended yet.
 *   2. after release: sub result → transcript persisted (BEFORE the callback
 *      fires — the wake never reads half-written state) → agent_ended →
 *      onAsyncDone { ok: true, result }.
 *   3. a throwing run surfaces as onAsyncDone { ok: false, error } with the
 *      spawn/ended pair still intact.
 *   4. default (no async) still blocks and returns the sub's text directly;
 *      onAsyncDone never fires.
 *   5. no onAsyncDone dep → the detached run still streams frames + ends
 *      cleanly (the result just goes nowhere).
 *   6. USER DETACH mid-flight: a running SYNC call is converted to background
 *      (onDetachable gate) → early "moved to background" marker, no
 *      agent_ended yet, gate unregistered, then the same background tail as
 *      async: true (result → onAsyncDone, frames pair, transcript durable).
 *
 * Run: `npx tsx scripts/smoke-runagent-async.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { createRunAgentTool, type AsyncRunDone } from "../agent/agents/run-agent-tool";
import type { ResolvedRuntime } from "../agent/models";
import type { AgentDefinition } from "../agent/agents/types";
import type { WorkerFrame } from "../agent/protocol";

const work = mkdtempSync(join(tmpdir(), "smoke-rag-async-"));
const sessionsDir = join(work, "sessions");
const sessionId = "s1";
writeFileSync(join(work, "CLAUDE.md"), "ROOT-CLAUDE-MARKER");

/** Deferred one-shot latch — the smoke's completion signal per async run. */
const deferred = <T = void>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
};

/**
 * Gate-held stub: every reply is emitted only after release(), so the smoke
 * can deterministically assert the tool returned while the sub was still
 * mid-run. (An immediate stub would make "fast return" a timing race.)
 */
const makeGatedRuntime = (finalText: string) => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const streamFn = () => {
		const s = new AssistantMessageEventStream();
		void (async () => {
			await gate;
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: finalText }],
				api: "pi-messages",
				provider: "stub",
				model: "stub-model",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } as Usage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			s.push({ type: "start", partial: { ...message, content: [...message.content] } });
			s.push({ type: "done", reason: "stop", message });
			s.end(message);
		})();
		return s;
	};
	return { runtime: { streamFn } as never as ResolvedRuntime, release };
};

/** Immediate stub (sync-mode regression case). */
const makeEagerRuntime = (finalText: string): ResolvedRuntime => {
	let call = 0;
	const streamFn = () => {
		call += 1;
		const s = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: finalText }],
			api: "pi-messages",
			provider: "stub",
			model: "stub-model",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } as Usage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void (async () => {
			s.push({ type: "start", partial: { ...message, content: [...message.content] } });
			s.push({ type: "done", reason: "stop", message });
			s.end(message);
		})();
		return s;
	};
	return { streamFn } as never as ResolvedRuntime;
};

const agents: AgentDefinition[] = [
	{ name: "coder", description: "test coder", body: "coder persona {cwd}", path: "/tmp/coder.md", source: "builtin" },
];

const frames: WorkerFrame[] = [];
const baseDeps = (runtime: ResolvedRuntime) => ({
	agents,
	runtime,
	cwd: work,
	skills: [],
	vars: { cwd: work, project: "p", sessionId, date: "2026-08-23", os: "linux" },
	sessionId,
	sessionsDir,
	agentId: "parent-1",
	parentMessages: () => [] as never,
	onFrame: (f: WorkerFrame) => frames.push(f),
});

const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
	res.content.find((c) => c.type === "text")?.text ?? "";

const out: string[] = [];
let failed = 0;
const ok = (name: string, cond: boolean, extra = "") => {
	if (!cond) failed++;
	out.push(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

// ---- 1+2. async happy path: fast marker, then settle → callback ----------------
{
	frames.length = 0;
	const { runtime, release } = makeGatedRuntime("ASYNC-SUB-RESULT");
	const dones: AsyncRunDone[] = [];
	const settled = deferred<AsyncRunDone>();
	const tool = createRunAgentTool({
		...baseDeps(runtime),
		onAsyncDone: (info) => {
			dones.push(info);
			settled.resolve(info);
		},
	} as never);

	const res = await tool.execute("tcA", { type: "coder", task: "background job one", async: true } as never, undefined);
	const marker = textOf(res);
	const spawn = frames.find((f) => f.type === "agent_spawned") as { agentId: string; kind?: string; name?: string; label?: string } | undefined;

	ok("1. returns immediately (before the gated sub finishes)", dones.length === 0 && !frames.some((f) => f.type === "agent_ended"));
	ok("1. marker: background started + agent type + task", marker.includes("Background sub-agent 'coder' started") && marker.includes("background job one"), marker);
	ok("1. marker: sub id (matches the spawn frame) + no-poll guidance", Boolean(spawn) && marker.includes(spawn!.agentId.slice(0, 8)) && marker.includes("[async-agent] message"), marker);
	ok("1. spawn frame on the bus at return time", spawn?.kind === "dagSub" && spawn?.name === "coder" && spawn?.label === "background job one", JSON.stringify(spawn));

	release();
	const info = await settled.promise;
	ok("2. onAsyncDone ok:true with the sub's result", info.ok === true && info.result === "ASYNC-SUB-RESULT", JSON.stringify(info).slice(0, 120));
	ok("2. callback carries toolCallId + task + agentId", info.toolCallId === "tcA" && info.task === "background job one" && info.agentId === spawn!.agentId);
	ok("2. agent_ended pairs the spawn", frames.some((f) => f.type === "agent_ended" && (f as { agentId: string }).agentId === spawn!.agentId));
	// Transcript durability is ordered BEFORE the callback by design.
	const txPath = join(sessionsDir, sessionId, `${spawn!.agentId}.jsonl`);
	ok("2. sub transcript durable before onAsyncDone", existsSync(txPath) && readFileSync(txPath, "utf8").includes("background job one"), txPath);
}

// ---- 3. throwing run → ok:false, frames still pair ------------------------------
{
	frames.length = 0;
	const boomer: AgentDefinition = {
		name: "boomer",
		description: "throws at prompt render",
		// Deterministic throw INSIDE buildAndRun (renderPrompt reads .body) —
		// exercises our catch plumbing without depending on pi error semantics.
		get body(): string {
			throw new Error("boom-render");
		},
		path: "/tmp/boomer.md",
		source: "builtin",
	};
	const settled = deferred<AsyncRunDone>();
	const tool = createRunAgentTool({
		...baseDeps(makeEagerRuntime("never")),
		agents: [boomer],
		onAsyncDone: (info) => settled.resolve(info),
	} as never);

	const res = await tool.execute("tcB", { type: "boomer", task: "will explode", async: true } as never, undefined);
	ok("3. async throw is detached — marker still returns", textOf(res).includes("Background sub-agent 'boomer' started"), textOf(res));
	const info = await settled.promise;
	ok("3. failure → ok:false + error text", info.ok === false && (info.error ?? "").includes("boom-render"), JSON.stringify(info).slice(0, 120));
	const spawnedIds = frames.filter((f) => f.type === "agent_spawned").map((f) => (f as { agentId: string }).agentId);
	const endedIds = frames.filter((f) => f.type === "agent_ended").map((f) => (f as { agentId: string }).agentId);
	ok("3. spawn/ended pair intact on failure", spawnedIds.length === 1 && endedIds.length === 1 && spawnedIds[0] === endedIds[0]);
}

// ---- 4. default stays sync: blocks, no callback ----------------------------------
{
	frames.length = 0;
	const dones: AsyncRunDone[] = [];
	const tool = createRunAgentTool({ ...baseDeps(makeEagerRuntime("SYNC-RESULT")), onAsyncDone: (i) => dones.push(i) } as never);
	const res = await tool.execute("tcC", { type: "coder", task: "sync job" } as never, undefined);
	const text = textOf(res);
	ok("4. sync default returns the sub result directly", text === "SYNC-RESULT", text);
	ok("4. sync never fires onAsyncDone", dones.length === 0);
	ok("4. sync pairs spawn/ended", frames.filter((f) => f.type === "agent_spawned").length === 1 && frames.filter((f) => f.type === "agent_ended").length === 1);
}

// ---- 5. missing onAsyncDone dep: run still completes cleanly ----------------------
{
	frames.length = 0;
	const tool = createRunAgentTool(baseDeps(makeEagerRuntime("ORPHAN-RESULT")) as never);
	const res = await tool.execute("tcD", { type: "coder", task: "orphan job", async: true } as never, undefined);
	ok("5. no-dep marker returns", textOf(res).includes("Background sub-agent 'coder' started"));
	// No completion signal exists — poll briefly for the ended frame. A crash
	// in the detached run would surface as a missing frame (or process abort).
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline && !frames.some((f) => f.type === "agent_ended")) await new Promise((r) => setTimeout(r, 25));
	ok("5. detached run ends cleanly without the dep", frames.some((f) => f.type === "agent_ended"), JSON.stringify(frames.map((f) => f.type)));
}

// ---- 6. USER DETACH: sync run converted to background mid-flight ------------------
{
	frames.length = 0;
	const { runtime, release } = makeGatedRuntime("DETACHED-RESULT");
	const gates = new Map<string, () => void>();
	const unregistered: string[] = [];
	const dones: AsyncRunDone[] = [];
	const settled = deferred<AsyncRunDone>();
	const tool = createRunAgentTool({
		...baseDeps(runtime),
		onDetachable: (id, fire) => {
			gates.set(id, fire);
			return () => unregistered.push(id);
		},
		onAsyncDone: (info) => {
			dones.push(info);
			settled.resolve(info);
		},
	} as never);

	const p = tool.execute("tcE", { type: "coder", task: "long sync job" } as never, undefined);
	// execute registers the gate before starting the run — poll for it.
	const regDeadline = Date.now() + 2_000;
	while (Date.now() < regDeadline && gates.size === 0) await new Promise((r) => setTimeout(r, 10));
	ok("6. sync run registered as detachable", gates.size === 1);
	const subId = [...gates.keys()][0] ?? "";
	gates.get(subId)?.(); // the user presses 转后台
	const res = await p;
	const marker = textOf(res);
	ok("6. early marker on detach (id + no-rerun guidance)", marker.includes("was moved to the background") && marker.includes(subId.slice(0, 8)), marker);
	ok("6. no agent_ended at marker time (sub still running)", !frames.some((f) => f.type === "agent_ended"));
	ok("6. gate unregistered on detach", unregistered.includes(subId));
	release();
	const info = await settled.promise;
	ok("6. background tail → onAsyncDone ok:true + result", info.ok === true && info.result === "DETACHED-RESULT" && info.agentId === subId && info.toolCallId === "tcE", JSON.stringify(info).slice(0, 120));
	ok("6. agent_ended pairs after settle", frames.some((f) => f.type === "agent_ended" && (f as { agentId: string }).agentId === subId));
	ok("6. transcript durable before onAsyncDone", existsSync(join(sessionsDir, sessionId, `${subId}.jsonl`)));
}

console.log(out.join("\n"));
console.log(`smoke-runagent-async: ${out.length - failed} passed, ${failed} failed`);
assert.equal(failed, 0);
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
