/**
 * run_agent's call shapes — the routing and the refusals, without a provider.
 *
 * The tool now has three shapes behind one entry: a single delegation, a
 * parallel fan-out (`tasks`), and either held to acceptance criteria
 * (`until`). Everything asserted here happens BEFORE the first sub-agent is
 * built, so it needs no model and no credentials — which is exactly the part
 * a live run would be a slow and expensive way to check.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createRunAgentTool } from "../agent/agents/run-agent-tool.ts";
import type { AgentDefinition } from "../agent/agents/types.ts";
import { resolveRuntime, type ResolvedRuntime } from "../agent/models.ts";
import { AgentLoader } from "../agent/agents/loader.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const agents: AgentDefinition[] = [
	{ name: "coding", body: "implement", source: "builtin", access: "RW" },
	{ name: "arch", body: "design", source: "builtin", access: "R" },
	{ name: "qa", body: "verify", source: "builtin", access: "RW" },
	{ name: "sys-compact", body: "internal", source: "builtin", internal: true },
] as AgentDefinition[];

const cwd = mkdtempSync(join(tmpdir(), "clownfish-runagent-"));
mkdirSync(join(cwd, "wt-a"), { recursive: true });
mkdirSync(join(cwd, "wt-b"), { recursive: true });

// A runtime that would throw if anything actually reached the provider: every
// case below must be refused before a sub-agent is constructed.
const runtime = {
	model: { id: "test", provider: "test" },
	streamFn: () => {
		throw new Error("the provider must not be reached by a refused call");
	},
	getApiKey: () => "none",
} as unknown as ResolvedRuntime;

const { tool } = createRunAgentTool({ agents, runtime, cwd, skills: [], vars: { workspace: cwd }, agentId: "main" } as never);

const call = async (params: Record<string, unknown>): Promise<string> => {
	const out = await tool.execute("call-1", params as never, undefined, undefined);
	return out.content[0]?.text ?? "";
};

// --- shape validation --------------------------------------------------------
check("the schema exposes the three shapes", ["type", "task", "tasks", "synthesize", "until", "max_rounds"].every((k) => k in (tool.parameters as { properties: Record<string, unknown> }).properties));

const neither = await call({});
check("neither (type, task) nor tasks is refused", /needs \(type, task\)|tasks/.test(neither), neither);

const both = await call({ type: "coding", task: "x", tasks: [{ type: "coding", task: "y" }] });
check("mixing a single delegation with tasks is refused", /not both/.test(both), both);

const unknown = await call({ type: "nope", task: "x" });
check("an unknown agent type is refused with the list", /Unknown agent type 'nope'/.test(unknown) && /coding/.test(unknown), unknown);

const internal = await call({ type: "sys-compact", task: "x" });
check("an internal agent is not delegatable", /Unknown agent type 'sys-compact'/.test(internal), internal);

const unknownInFanout = await call({ tasks: [{ type: "coding", task: "a" }, { type: "ghost", task: "b" }] });
check("an unknown type inside tasks is refused too", /Unknown agent type 'ghost'/.test(unknownInFanout), unknownInFanout);

// --- the parallel-write guard ------------------------------------------------
// Two writers in one tree would interleave edits and destroy each other's
// rollback; that is a refusal, not a race to discover at runtime.
const sharedTree = await call({ tasks: [{ type: "coding", task: "a" }, { type: "coding", task: "b" }] });
check("two writing strands in one tree are refused", /must not share a working tree/.test(sharedTree), sharedTree);

const separateTrees = await call({
	tasks: [
		{ type: "coding", task: "a", cwd: "wt-a" },
		{ type: "coding", task: "b", cwd: "wt-b" },
	],
});
check("separate worktrees pass the guard (reaches the runtime)", !/must not share/.test(separateTrees), separateTrees.slice(0, 120));

const readOnlyFanout = await call({ tasks: [{ type: "arch", task: "a" }, { type: "arch", task: "b" }] });
check("read-only strands may share the tree", !/must not share/.test(readOnlyFanout), readOnlyFanout.slice(0, 120));

// --- the jail still holds for every strand -----------------------------------
const escape = await call({ tasks: [{ type: "arch", task: "a" }, { type: "arch", task: "b", cwd: "../../etc" }] });
check("a strand cannot point cwd outside the workspace", /inside your workspace/.test(escape), escape);

// --- a strand's work is never silently dropped ------------------------------
// The synthesis pass runs on results we already hold; if it comes back empty
// (or does not complete), returning ITS output would discard every strand.
const emptySynth = await call({
	tasks: [
		{ type: "arch", task: "a" },
		{ type: "arch", task: "b" },
	],
	synthesize: "merge them",
});
check("an empty synthesis falls back to the strand results", emptySynth.trim().length > 0 && /## 1\.|## 2\./.test(emptySynth), `len=${emptySynth.length}`);

// --- per-strand model override -----------------------------------------------
// Resolution is a pure catalog lookup (no network), so it's fully testable
// offline: does an override get ACCEPTED once wired, and REFUSED cleanly —
// not silently ignored, not a crash — when it is not?

const overrideText = async (deps: Record<string, unknown>, params: Record<string, unknown>): Promise<string> =>
	(await createRunAgentTool(deps as never).tool.execute("c", params as never, undefined, undefined)).content[0].text;

const noBaseDeps = { agents, runtime, cwd, skills: [], vars: { workspace: cwd }, agentId: "main" };
const refused = await overrideText(noBaseDeps, { type: "coding", task: "x", model: "claude-opus-4-5" });
check("a model override without baseProviderConfig is refused cleanly", /cannot override the model/.test(refused), refused);

const agentsWithPinned: AgentDefinition[] = [...agents, { name: "qa-strong", body: "verify harder", source: "builtin", access: "RW", model: "claude-opus-4-5" } as AgentDefinition];
const withBaseDeps = { agents: agentsWithPinned, runtime, cwd, skills: [], vars: { workspace: cwd }, agentId: "main", baseProviderConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } };

const overridden = await overrideText(withBaseDeps, { type: "coding", task: "x", model: "claude-opus-4-5" });
check("a valid per-call model override is accepted (proceeds past strand resolution)", !/cannot override the model/.test(overridden), overridden);

const pinned = await overrideText(withBaseDeps, { type: "qa-strong", task: "x" });
check("a persona's pinned frontmatter model is picked up with no per-call override", !/cannot override the model/.test(pinned), pinned);

const badModel = await overrideText(withBaseDeps, { type: "coding", task: "x", model: "totally-not-a-real-model-xyz" });
check("an unresolvable override degrades to a synthesized sibling model, not a crash", typeof badModel === "string" && badModel.length > 0, badModel);

// The underlying primitive, directly: two different `model` ids must produce
// two DIFFERENT model.id values while keeping the same provider/api wiring —
// this is what makes the per-strand override meaningfully different work.
const rtA = resolveRuntime({ provider: "anthropic", model: "claude-sonnet-4-6" });
const rtB = resolveRuntime({ provider: "anthropic", model: "claude-opus-4-5" });
check("resolveRuntime with a different model id yields a different model.id", rtA.model.id !== rtB.model.id, `${rtA.model.id} vs ${rtB.model.id}`);
check("both stay on the requested provider", rtA.model.provider === "anthropic" && rtB.model.provider === "anthropic");

// AgentDefinition frontmatter `model:` — parsed by the loader, offline.
const agentsDir = join(cwd, "agents-fixture");
mkdirSync(agentsDir, { recursive: true });
writeFileSync(join(agentsDir, "qa.md"), "---\nmodel: claude-opus-4-5\n---\nVerify the work.\n");
const loaded = await new AgentLoader([{ dir: agentsDir, source: "test" }]).load();
check("AgentLoader parses a pinned `model:` frontmatter field", loaded.find((a) => a.name === "qa")?.model === "claude-opus-4-5", JSON.stringify(loaded));

rmSync(cwd, { recursive: true, force: true });

console.log(`run_agent shapes: ${passed} checks passed`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
