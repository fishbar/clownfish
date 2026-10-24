/**
 * Memory-distill smoke test — the digest/cursor/proposal pipeline without an
 * LLM (the `distillJson` seam returns scripted JSON).
 *
 *   A. digest building: user messages kept verbatim, context windowed+trimmed.
 *   B. incremental: second run reads only NEW lines (cursor honored).
 *   C. fingerprint: a rewritten transcript (different firstId) re-distills
 *      from line 0 once.
 *   D. proposals: typed mapping (bad scope/category/unknown-project dropped),
 *      pending store dedup, resolve accept → applied file, reject → dropped.
 *   E. cursor advances only on success (a throwing distiller leaves it).
 *   F. sessions without user messages in the delta are skipped.
 *   G. promptBlock: global + matching-project only, others excluded.
 *   H. runs.jsonl audit trail.
 *
 * Run: `npx tsx scripts/smoke-distill.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Project } from "../server/protocol";
import { MemoryStore, memoryRoot } from "../agent/memory";
import { buildSessionDigest, parseProposals, runMemoryDistill } from "../server/distill";
import type { ProjectManager } from "../server/models/projects";
import type { SessionStore } from "../server/models/sessions";

const mkMsg = (role: string, text: string): AgentMessage => ({ role, content: [{ type: "text", text }] }) as unknown as AgentMessage;

// ---- stub stores: one project, two sessions, transcript-backed ----
const transcripts = new Map<string, AgentMessage[]>(); // sessionId → messages
const firstIds = new Map<string, string>();

const projects = {
	list: async () => [{ id: "p1", name: "clownfish", createdAt: 0, updatedAt: 0 } as unknown as Project],
	get: async (id: string) => ({ id, name: "clownfish" } as unknown as Project),
} as unknown as ProjectManager;

const sessions = {
	list: async () => [
		{ id: "sessA", projectId: "p1", updatedAt: 200 },
		{ id: "sessB", projectId: "p1", updatedAt: 100 },
	],
	loadPage: async (_pid: string, sid: string, _limit: number) => {
		const messages = transcripts.get(sid) ?? [];
		return { id: sid, projectId: "p1", createdAt: 0, updatedAt: 0, messages, total: messages.length, oldestIndex: 0, hasMore: false };
	},
} as unknown as SessionStore;

void (async () => {
	const checks: string[] = [];
	const ok = (n: string) => checks.push(`  ✓ ${n}`);
	const work = await mkdtemp(join(tmpdir(), "smoke-distill-"));
	const sessionsDir = join(work, "sessions");
	const dataDir = join(work, "data");
	const store = new MemoryStore(memoryRoot(dataDir));
	const CFG = { enabled: true, expr: "0 2 * * *", maxSessions: 10, charsPerSession: 12000, totalCharBudget: 80000 };

	const writeTranscript = async (sid: string, messages: AgentMessage[]): Promise<void> => {
		transcripts.set(sid, messages);
		const file = join(sessionsDir, sid, "index.jsonl");
		await mkdir(join(sessionsDir, sid), { recursive: true });
		const id0 = firstIds.get(sid) ?? `first-${sid}`;
		firstIds.set(sid, id0);
		const lines = messages.map((m, i) => JSON.stringify({ id: `e${i}`, ts: i, message: { ...m, id: i === 0 ? id0 : undefined } }));
		await writeFile(file, `${lines.join("\n")}\n`);
	};

	// ---- A: digest shape ----
	const demo = [
		mkMsg("user", "帮我看看这个 bug"),
		mkMsg("assistant", "好，我先读一下相关代码。"),
		mkMsg("toolResult", ""),
		mkMsg("assistant", "找到了，是空指针。"),
		mkMsg("user", "以后回复都用中文"),
	];
	const digest = buildSessionDigest("sessA", "clownfish", demo, 0, 12000);
	assert.match(digest, /## Session sessA \(project: clownfish, transcript lines 0–4\)/);
	assert.match(digest, /\[user\] 帮我看看这个 bug/);
	assert.match(digest, /\[assistant\] 找到了，是空指针。/); // within AFTER window of 2nd user msg
	const budgeted = buildSessionDigest("s", "p", demo, 0, 40);
	assert.match(budgeted, /truncated at 40 chars/);
	ok("A: digest keeps user text with adjacent context and honors the char budget");

	// parseProposals leniency
	assert.deepEqual(parseProposals('```json\n[{"scope":"global","category":"rules","content":"x"}]\n```'), [{ scope: "global", category: "rules", content: "x" }]);
	assert.deepEqual(parseProposals("junk [ ] trailing"), []);
	ok("A: parseProposals strips fences and rejects junk");

	// ---- B: first run distills everything, cursor lands at total ----
	await writeTranscript("sessA", demo);
	await writeTranscript("sessB", [mkMsg("user", "把缩进改成 tab")]);
	let fedDigest = "";
	const out1 = await runMemoryDistill(
		{ dataDir, sessionsDir, projects, sessions, distillJson: async (d) => { fedDigest = d; return JSON.stringify([
			{ scope: "global", category: "style", content: "用户偏好中文回复", evidence: [{ sessionId: "sessA", lineIdx: 4 }] },
			{ scope: "project", projectId: "p1", category: "rules", content: "缩进用 tab", evidence: [{ sessionId: "sessB", lineIdx: 0 }] },
			{ scope: "project", projectId: "ghost", category: "rules", content: "unknown project" },
			{ scope: "galaxy", category: "rules", content: "bad scope" },
			{ scope: "global", category: "vibes", content: "bad category" },
		]); } },
		CFG,
	);
	assert.equal(out1.ok, true);
	assert.equal(out1.sessions, 2);
	assert.equal(out1.proposed, 2, "only well-formed proposals survive");
	assert.match(fedDigest, /sessA/);
	assert.match(fedDigest, /sessB/);
	const cursors1 = await store.cursors();
	assert.equal(cursors1.sessA.lines, 5);
	assert.equal(cursors1.sessB.lines, 1);
	ok("B: first run digests all sessions and advances cursors to the line count");

	// ---- incremental: append new lines → only they are digested ----
	fedDigest = "";
	const more = [...demo, mkMsg("assistant", "(无关的后续)"), mkMsg("user", "部署用 pnpm 不要用 npm")];
	await writeTranscript("sessA", more);
	transcripts.set("sessB", [mkMsg("user", "把缩进改成 tab")]); // unchanged
	await writeTranscript("sessB", [mkMsg("user", "把缩进改成 tab")]);
	const out2 = await runMemoryDistill(
		{ dataDir, sessionsDir, projects, sessions, distillJson: async (d) => { fedDigest = d; return "[]"; } },
		CFG,
	);
	assert.equal(out2.sessions, 1, "only sessA had new lines");
	assert.equal(out2.skipped, 1, "sessB skipped (cursor at total)");
	assert.doesNotMatch(fedDigest, /帮我看看这个 bug/, "old lines not re-digested");
	assert.match(fedDigest, /部署用 pnpm 不要用 npm/);
	ok("B: second run reads only the delta (cursor honored)");

	// ---- C: fingerprint mismatch → re-read from 0 ----
	// Simulate rewriteAll: the file gets a different first envelope id (and
	// fewer lines), while the stored cursor still points at the old fingerprint.
	const rewritten = [mkMsg("user", "帮我看看这个 bug"), mkMsg("assistant", "(重写后的历史)")];
	firstIds.set("sessA", "first-REWRITTEN");
	await writeTranscript("sessA", rewritten);
	fedDigest = "";
	await runMemoryDistill({ dataDir, sessionsDir, projects, sessions, distillJson: async (d) => { fedDigest = d; return "[]"; } }, CFG);
	assert.match(fedDigest, /帮我看看这个 bug/, "re-distilled from line 0 after rewrite");
	const cursorsC = await store.cursors();
	assert.equal(cursorsC.sessA.lines, 2, "cursor reset to the rewritten length");
	ok("C: a rewritten transcript (firstId change) re-distills from the start");

	// ---- D: pending → resolve ----
	const pending1 = await store.pending();
	assert.equal(pending1.length, 2);
	const style = pending1.find((p) => p.category === "style")!;
	const rules = pending1.find((p) => p.category === "rules")!;
	// dedup: same content again is not re-added
	await runMemoryDistill(
		{ dataDir, sessionsDir, projects, sessions, distillJson: async () => JSON.stringify([{ scope: "global", category: "style", content: "用户偏好中文回复", evidence: [] }]) },
		CFG,
	);
	assert.equal((await store.pending()).length, 2, "identical proposal deduped");
	// accept (with edit) → applied/global/style.md
	await store.resolveProposal(style.id, true, "用户偏好中文回复(简体)");
	const styleFile = await readFile(join(dataDir, "memory", "applied", "global", "style.md"), "utf8");
	assert.match(styleFile, /- 用户偏好中文回复\(简体\)/);
	// reject → gone
	await store.resolveProposal(rules.id, false);
	assert.equal((await store.pending()).length, 0);
	const rulesFile = await readFile(join(dataDir, "memory", "applied", "projects", "p1", "rules.md"), "utf8").catch(() => null);
	assert.equal(rulesFile, null, "rejected proposal never applied");
	ok("D: accept applies (edited) content to the right scope file; reject drops it");

	// ---- E: failing distiller leaves cursors alone ----
	// Give sessA a fresh delta first so the distiller is actually invoked, then fail it.
	await writeTranscript("sessA", [...rewritten, mkMsg("user", "再来一条用户消息")]);
	const cursorBefore = (await store.cursors()).sessA.lines;
	const outE = await runMemoryDistill(
		{ dataDir, sessionsDir, projects, sessions, distillJson: async () => { throw new Error("LLM down"); } },
		CFG,
	);
	assert.equal(outE.ok, false);
	assert.equal(outE.error, "LLM down");
	// sessA's cursor stays at its last successful value; the run records the failure
	assert.equal((await store.cursors()).sessA.lines, cursorBefore);
	ok("E: a failed run does not advance cursors (retry next night)");

	// ---- F: delta without user messages is skipped ----
	await writeTranscript("sessB", [mkMsg("user", "把缩进改成 tab"), mkMsg("assistant", "done")]);
	transcripts.set("sessB", [mkMsg("user", "把缩进改成 tab"), mkMsg("assistant", "done"), mkMsg("assistant", "更多工具输出")]);
	await writeTranscript("sessB", [mkMsg("user", "把缩进改成 tab"), mkMsg("assistant", "done"), mkMsg("assistant", "更多工具输出")]);
	const outF = await runMemoryDistill({ dataDir, sessionsDir, projects, sessions, distillJson: async () => "[]" }, CFG);
	assert.equal(outF.skipped >= 1, true, "no-user delta skipped");
	ok("F: a delta with no user messages is skipped");

	// ---- G: promptBlock scoping ----
	await store.append({ kind: "global" }, "facts", "OS 是 arm64 Linux");
	await store.append({ kind: "project", projectId: "p1" }, "facts", "包管理器 pnpm");
	await store.append({ kind: "project", projectId: "other" }, "facts", "别的项目");
	const blockP1 = await store.promptBlock("p1");
	assert.match(blockP1, /## Memory/);
	assert.match(blockP1, /OS 是 arm64 Linux/);
	assert.match(blockP1, /包管理器 pnpm/);
	assert.doesNotMatch(blockP1, /别的项目/, "other project's memory excluded");
	const blockNoProject = await store.promptBlock(undefined);
	assert.doesNotMatch(blockNoProject, /包管理器 pnpm/, "project memory excluded when no project");
	ok("G: promptBlock injects global + own-project memory only");

	// ---- H: runs.jsonl audit ----
	const runs = (await readFile(join(dataDir, "memory", "runs.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { ok: boolean; error?: string });
	assert.ok(runs.length >= 5);
	assert.ok(runs.some((r) => !r.ok && r.error === "LLM down"), "failure recorded");
	ok("H: runs.jsonl appends one audit record per run (incl. failures)");

	await rm(work, { recursive: true, force: true });
	console.log(`smoke-distill: ${checks.length} checks passed`);
	for (const c of checks) console.log(c);
	process.exit(0);
})().catch((err) => {
	console.error("smoke-distill FAILED:", err);
	process.exit(1);
});
