/**
 * run_goal — a goal-seeking loop on top of the execution-plan DAG machinery.
 *
 * The main agent hands over a goal + ACCEPTANCE CRITERIA and returns
 * immediately. A background goalRoot agent then loops:
 *
 *   decompose → execute (DAG, same as any workflow) → EVALUATE →
 *   PASS: stop / FAIL: feed the verdict back and iterate a revised plan
 *
 * until the goal is achieved (verdict PASS), the iteration cap is hit, or the
 * loop stalls (same verdict twice → the executor is not making progress).
 *
 * The evaluator is a FRESH agent each round with an isolated context: it sees
 * only the goal, the acceptance criteria, the executor's summary, and the
 * working tree (read-only tools) — never the execution transcript. It cannot
 * rationalize the executor's reasoning; it judges the artifact. That isolation
 * is the whole point of a separate evaluator (user's design decision).
 *
 * Persistence: goal state lives in `<sessionId>/goals.json` (sidecar, same
 * pattern as dag.json) so an interrupted loop survives a worker exit and
 * resumes from the recorded round. {@link resumeGoals} re-launches unfinished
 * goals at boot.
 *
 * Nesting guard: main agent only — the runtime does not hand this tool to
 * dagRoot/dagSub/evaluator agents.
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "../tools/definition";
import type { ToolDefinition } from "../tools";
import { ClownfishAgent, type ClownfishAgentOptions } from "../clownfish-agent";
import type { ResolvedRuntime } from "../models";
import type { Skill } from "../skills";
import type { AgentPromptVars } from "./types";
import type { WorkflowToolDeps } from "./types";
import { createDagTools } from "../tools/dag";
import { createDelegateTool } from "./delegate";
import { DEFAULT_SYSTEM_PROMPT } from "../system-prompt";
import { SessionTranscript } from "../transcript";
import { generateId } from "../id";
import { lastAssistantText, runOutcome, trimErroredTail } from "./run-outcome";
import type { WorkerFrame } from "../protocol";
import { createWorktree, isGitRepo, type WorktreeInfo } from "../worktree";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_MAX_ITERATIONS = 10;

/** On-disk shape of one goal run (sidecar `<sessionId>/goals.json`). */
export interface GoalRecord {
	id: string;
	goal: string;
	/** Creation time (ms epoch) — stabilizes goals.json ordering across merge-saves. */
	createdAt: number;
	/** Acceptance criteria shown verbatim to every evaluator (its ONLY yardstick). */
	criteria: string;
	/** The goalRoot agent currently driving the loop. */
	ownerAgent: string;
	/** 1-based round counter (round N = attempt N at satisfying the criteria). */
	round: number;
	/** running | achieved | gave_up — the last two are terminal. */
	status: "running" | "achieved" | "gave_up";
	/** Isolation worktree (coding goals), re-attached on resume. */
	worktree?: WorktreeInfo;
	/** Verdict history, oldest first (one per completed round). */
	verdicts: { round: number; pass: boolean; text: string }[];
	maxIterations: number;
}

/** Evaluator output — a strict prefix protocol the executor's brain parses. */
interface Verdict {
	pass: boolean;
	text: string;
}

const GOAL_ROOT_VIEW = [
	`## Goal-seeking loop`,
	``,
	`You drive an ITERATIVE goal loop for the goal below. Each round:`,
	`1. \`plan\` the round's work under your root node (revision N — read the last verdict first if present).`,
	`2. Execute it: 'inline' steps yourself, 'delegate' steps via the delegate tool (parallel calls in one turn run concurrently).`,
	`3. When your round's work is done, STOP and reply with a short factual summary of what changed (the evaluator will judge it).`,
	``,
	`A separate evaluator agent will check the result against the acceptance criteria and hand you its verdict as your next prompt:`,
	`- \`VERDICT: PASS\` → your NEXT prompt will end the loop; wrap up and reply with a final report.`,
	`- \`VERDICT: FAIL <reasons>\` → revise the plan informed by the reasons and run another round. Never argue with the verdict.`,
	``,
	`# Goal`,
];

const EVALUATOR_VIEW = [
	`## Goal evaluation`,
	``,
	`You are an INDEPENDENT evaluator. Your only job: judge whether the work below satisfies the acceptance criteria. You did not do the work, you owe the executor nothing — be strict, neutral, and concrete.`,
	``,
	`Rules:`,
	`- The acceptance criteria are your ONLY yardstick. Do not invent extra requirements; do not lower the bar to be nice.`,
	`- Verify claims yourself with your read-only tools (read files, grep, run read-only checks) — do not trust the executor's summary.`,
	`- Reply with EXACTLY this format (first line, no preamble):`,
	``,
	`  VERDICT: PASS`,
	`  <one short paragraph: what was verified and how>`,
	``,
	`  or`,
	``,
	`  VERDICT: FAIL`,
	`  <numbered list of concrete unmet criteria + how to fix each>`,
	``,
	`# Goal`,
];

/** Parse the evaluator's reply into a Verdict (unknown shape → FAIL). */
export function parseVerdict(reply: string): Verdict {
	const m = reply.match(/^\s*VERDICT:\s*(PASS|FAIL)\b/i);
	return { pass: m?.[1].toUpperCase() === "PASS", text: reply.trim() };
}

function rootSystemPrompt(goal: string, round: number, worktree: WorktreeInfo | undefined, resume: boolean): string {
	return [
		DEFAULT_SYSTEM_PROMPT,
		...GOAL_ROOT_VIEW,
		goal,
		``,
		`# Round ${round} of the loop${resume ? ` (resumed after an interruption — inspect the tree and continue)` : ``}.`,
		...(worktree
			? [
					``,
					`# Worktree isolation`,
					`You are in an isolated git worktree on branch \`${worktree.branch}\` (base ${worktree.baseSha}) — write code freely here; the user's working tree is untouched. Commit your work with a clean message each round. Do NOT merge or delete the branch yourself.`,
				]
			: []),
	].join("\n");
}

function evaluatorSystemPrompt(goal: string, criteria: string, round: number, worktree: WorktreeInfo | undefined): string {
	return [
		DEFAULT_SYSTEM_PROMPT,
		...EVALUATOR_VIEW,
		goal,
		``,
		`# Acceptance criteria (your yardstick)`,
		criteria,
		``,
		`# What the executor claims it did (round ${round})`,
		`(Verify against the working tree — ${worktree ? `worktree ${worktree.path}` : `the project directory`} — not against this text.)`,
	].join("\n");
}

/** One evaluator pass: fresh read-only agent, isolated context, one prompt.
 * Returns null when the evaluator itself was killed by a provider error — the
 * caller must NOT treat that as a FAIL verdict (a quota outage would otherwise
 * burn rounds on phantom verdicts and trip the stall guard). */
async function evaluate(
	deps: WorkflowToolDeps,
	spec: { goal: string; criteria: string; round: number; summary: string; worktree?: WorktreeInfo },
): Promise<Verdict | null> {
	const evalId = generateId();
	const cwd = spec.worktree?.path ?? deps.cwd;
	deps.onFrame({ type: "agent_spawned", agentId: evalId, parentAgentId: deps.agentId, kind: "dagSub", label: `评测 round ${spec.round}` });
	const evalTx = new SessionTranscript(deps.sessionsDir, deps.sessionId, evalId);
	let evaluator: ClownfishAgent | undefined;
	try {
		evaluator = new ClownfishAgent({
			cwd,
			runtime: deps.runtime,
			skills: [], // no skills: evaluation needs no how-to knowledge
			sessionId: `${deps.sessionId}/${evalId}`,
			baseSystemPrompt: evaluatorSystemPrompt(spec.goal, spec.criteria, spec.round, spec.worktree),
			initialMessages: [],
			toolAccess: "R", // read-only: judge the artifact, never fix it
			onEvent: (event: AgentEvent) => deps.onFrame({ type: "event", event, agentId: evalId }),
		});
		await evaluator.prompt(
			[
				`Executor's round-${spec.round} summary:`,
				spec.summary || "(no summary produced)",
				``,
				`Verify the acceptance criteria and reply with the VERDICT format.`,
			].join("\n"),
		);
		const outcome = runOutcome(evaluator.state.messages);
		if (!outcome.ok) return null;
		return parseVerdict(outcome.summary);
	} finally {
		if (evaluator) void evalTx.appendMessages(evaluator.state.messages).catch(() => undefined);
		deps.onFrame({ type: "agent_ended", agentId: evalId });
	}
}

// ---------------------------------------------------------------------------
// goals.json sidecar — tiny load/save (same pattern as dag.json).
// ---------------------------------------------------------------------------

interface GoalStoreJson {
	goals: GoalRecord[];
}

async function loadGoals(sessionDir: string): Promise<GoalRecord[]> {
	try {
		const raw = await readFile(join(sessionDir, "goals.json"), "utf8");
		const data = JSON.parse(raw) as GoalStoreJson;
		return Array.isArray(data.goals) ? data.goals : [];
	} catch {
		return [];
	}
}

/**
 * goals.json writes go through ONE serialized chain: a goal loop saving a
 * verdict while another `run_goal` starts (or the boot resume sweeps) must
 * never interleave read-modify-writes — the later writer would resurrect the
 * other's pre-update snapshot (lost verdicts / rewound rounds). The write
 * itself is atomic (tmp + rename) so a crash never leaves torn JSON.
 */
let goalsIOChain: Promise<void> = Promise.resolve();
function enqueueGoalsIO(op: () => Promise<void>): Promise<void> {
	const run = goalsIOChain.then(op, op);
	goalsIOChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function writeGoalsFile(sessionDir: string, goals: GoalRecord[]): Promise<void> {
	// mkdir like SessionTranscript.writeDag — the session dir normally exists
	// (tx.load() → migrate() runs first), but never depend on that ordering.
	await mkdir(sessionDir, { recursive: true });
	const data: GoalStoreJson = { goals };
	const tmp = join(sessionDir, "goals.json.tmp");
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, join(sessionDir, "goals.json"));
}

/** Merge-save one goal's record into goals.json without clobbering other
 *  concurrently-running goals (read-modify-write keyed by goal id, run
 *  atomically inside the serialized goals-IO chain). */
async function saveGoal(sessionDir: string, record: GoalRecord): Promise<void> {
	await enqueueGoalsIO(async () => {
		const goals = await loadGoals(sessionDir);
		const next = goals.filter((g) => g.id !== record.id).concat(record);
		// Goals are ordered by creation; keep that stable across merges.
		next.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
		await writeGoalsFile(sessionDir, next);
	});
}

async function saveGoals(sessionDir: string, goals: GoalRecord[]): Promise<void> {
	await enqueueGoalsIO(() => writeGoalsFile(sessionDir, goals));
}

/**
 * Drive one goal loop to termination (fire-and-forget from the tool). The
 * goalRoot agent executes a round; the runtime evaluates it; the verdict
 * becomes the next round's prompt — or the loop ends and main is woken once.
 */
function launchGoalRoot(deps: WorkflowToolDeps, record: GoalRecord, sessionDir: string, resume: boolean): void {
	const runCwd = record.worktree?.path ?? deps.cwd;
	const rootExtra: ToolDefinition[] = [
		...createDagTools({ dags: deps.dags, agentId: record.ownerAgent }),
		createDelegateTool({
			dags: deps.dags,
			agentId: record.ownerAgent,
			runtime: deps.runtime,
			cwd: runCwd,
			skills: deps.skills,
			vars: deps.vars,
			sessionId: deps.sessionId,
			sessionsDir: deps.sessionsDir,
			depth: 0,
			beforeToolCall: deps.beforeToolCallFor?.(record.ownerAgent) ?? deps.beforeToolCall,
			beforeToolCallFor: deps.beforeToolCallFor,
			onFrame: deps.onFrame,
		}),
	];
	deps.onFrame({ type: "agent_spawned", agentId: record.ownerAgent, parentAgentId: deps.agentId, kind: "dagRoot", label: `🎯 ${record.goal}` });
	deps.log?.(`goal loop started: "${record.goal}" (round ${record.round}/${record.maxIterations})`);

	void (async () => {
		let root: ClownfishAgent | undefined;
		const rootTx = new SessionTranscript(deps.sessionsDir, deps.sessionId, record.ownerAgent);
		// Incremental transcript flush (see launchDagRoot): keep the conversation
		// so far even if the worker dies mid-loop.
		let flushed = 0;
		const flush = (): void => {
			const msgs = root?.state.messages;
			if (!msgs || msgs.length <= flushed) return;
			const batch = msgs.slice(flushed);
			flushed = msgs.length;
			void rootTx.appendMessages(batch).catch(() => undefined);
		};
		/**
		 * A provider error killed the executor round (or the evaluator). The goal
		 * did NOT fail — stay "running" (resumable), record nothing bogus (no
		 * phantom verdict, no round consumed), and hand the interruption to the
		 * runtime's auto re-drive (or, without one, tell the user).
		 */
		const interrupt = async (error: string): Promise<void> => {
			record.status = "running";
			await saveGoal(sessionDir, record).catch(() => undefined);
			deps.log?.(`goal "${record.goal}" interrupted at round ${record.round} (provider error): ${error}`);
			if (deps.onInterrupted) {
				deps.onInterrupted("goal", record.id, error);
			} else {
				await deps
					.wakeMain(
						`[goal interrupted] "${record.goal}" (goal ${record.id}) was interrupted by a provider error at round ${record.round} and did NOT finish: ${error}\n\nIts rounds so far are kept in goals.json; it resumes automatically on the next worker boot.`,
					)
					.catch(() => undefined);
			}
		};
		try {
			// A fresh ClownfishAgent per round would give each round a clean context;
			// we instead KEEP one agent across rounds so its plan/DAG history and
			// prior verdicts stay visible — the loop's memory of what was tried.
			root = new ClownfishAgent({
				cwd: runCwd,
				runtime: deps.runtime,
				skills: deps.skills,
				sessionId: `${deps.sessionId}/${record.ownerAgent}`,
				baseSystemPrompt: rootSystemPrompt(record.goal, record.round, record.worktree, resume),
				initialMessages: [],
				toolAccess: "RW",
				beforeToolCall: deps.beforeToolCallFor?.(record.ownerAgent) ?? deps.beforeToolCall,
				onEvent: (event: AgentEvent) => {
					deps.onFrame({ type: "event", event, agentId: record.ownerAgent });
					if (event.type === "message_end") flush();
				},
				extraTools: rootExtra,
			});

			const lastVerdict = record.verdicts.at(-1);
			let kick = resume
				? `This goal loop was interrupted and is resuming at round ${record.round}. Inspect the current tree state (get_status) and continue the round's work. Goal: ${record.goal}`
				: `Begin round ${record.round}: plan and execute work toward the goal. Goal: ${record.goal}`;
			if (lastVerdict && !lastVerdict.pass) {
				kick += `\n\nLast round's verdict (FAIL):\n${lastVerdict.text}`;
			}

			let giveUpReason = "";
			while (true) {
				// A provider-killed round leaves an empty errored assistant message in
				// history; trim it so the re-prompt (round resume) sends a clean payload.
				root.loadHistory(trimErroredTail(root.state.messages));
				await root.prompt(kick);
				const outcome = runOutcome(root.state.messages);
				if (!outcome.ok) {
					await interrupt(outcome.error ?? "provider error");
					return;
				}
				const summary = outcome.summary || "(round produced no summary)";

				// Round finished → evaluate with a FRESH isolated agent.
				const verdict = await evaluate(deps, { goal: record.goal, criteria: record.criteria, round: record.round, summary, worktree: record.worktree });
				if (!verdict) {
					await interrupt("the evaluator was killed by a provider error");
					return;
				}
				record.verdicts.push({ round: record.round, pass: verdict.pass, text: verdict.text });
				deps.log?.(`goal round ${record.round}: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.text.split("\n")[0].slice(0, 100)}`);
				await saveGoal(sessionDir, record);

				if (verdict.pass) {
					record.status = "achieved";
					break;
				}
				if (record.round >= record.maxIterations) {
					giveUpReason = `iteration cap reached (${record.maxIterations})`;
					record.status = "gave_up";
					break;
				}
				// Stall guard: identical FAIL text twice in a row means the executor
				// is not making progress — bail out and hand the problem to the user.
				const prev = record.verdicts.at(-2);
				if (prev && !prev.pass && prev.text.trim() === verdict.text.trim()) {
					giveUpReason = "the evaluator's verdict did not change between rounds (no progress)";
					record.status = "gave_up";
					break;
				}
				record.round += 1;
				kick = `VERDICT: FAIL\n${verdict.text}\n\nRevise your plan informed by these reasons and run round ${record.round}. Goal: ${record.goal}`;
			}
			await saveGoal(sessionDir, record);

			const merge = record.worktree
				? `\n\nIts work is on git branch \`${record.worktree.branch}\` (worktree ${record.worktree.path}). Ask the user whether to merge it into the current branch, keep it, or discard it — do not merge by yourself.`
				: "";
			// The goal HAS settled by this point — a failed wake (e.g. the main
			// agent busy) must not fall into the catch below and be re-reported
			// as "[goal failed]" for a goal that actually succeeded.
			const settledWake = (text: string): Promise<void> =>
				deps.wakeMain(text).catch((err) => {
					deps.log?.(`wakeMain after goal settled failed (goal ${record.id}): ${err instanceof Error ? err.message : String(err)}`);
				});
			if (record.status === "achieved") {
				const finalReport = lastAssistantText(root.state.messages) || "(no final report)";
				await settledWake(
					`[goal achieved] "${record.goal}" passed evaluation on round ${record.round} (goal ${record.id}).\n\nFinal report:\n${finalReport}${merge}\n\nSynthesize this into a reply for the user (and relay the merge question if present).`,
				);
			} else {
				const lastFail = record.verdicts.at(-1)?.text ?? "(no verdict)";
				await settledWake(
					`[goal gave up] "${record.goal}" (goal ${record.id}) stopped after ${record.round} round(s): ${giveUpReason}.\n\nLast verdict:\n${lastFail}${merge}\n\nExplain to the user what was tried and what remains unmet; suggest how to proceed (relax the criteria, raise the iteration cap, or intervene manually).`,
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.log?.(`goal loop failed: ${msg}`);
			await saveGoal(sessionDir, record).catch(() => undefined);
			await deps.wakeMain(`[goal failed] "${record.goal}" (goal ${record.id}) errored: ${msg}\n\nInform the user; the goal's rounds so far are in goals.json.`).catch(() => undefined);
		} finally {
			flush();
			deps.onFrame({ type: "agent_ended", agentId: record.ownerAgent });
		}
	})();
}

/**
 * Resume interrupted goal loops (boot path): every goal with status "running"
 * gets a fresh goalRoot agent continuing at the recorded round. Returns how
 * many goals were resumed.
 */
/**
 * Hand one "running" goal to a FRESH goalRoot agent (resume mode) at its
 * recorded round. Shared by the boot resume sweep and the live-worker auto
 * re-drive after a provider-killed round. Returns false when the goal is not
 * resumable (missing / not running).
 */
export async function relaunchGoal(deps: WorkflowToolDeps, sessionDir: string, goalId: string): Promise<boolean> {
	const goals = await loadGoals(sessionDir);
	const record = goals.find((g) => g.id === goalId);
	if (!record || record.status !== "running") return false;
	record.ownerAgent = generateId();
	// Re-attach the worktree if it still exists; otherwise degrade to the
	// main workspace (never block a resume on a missing dir).
	if (record.worktree) {
		const { stat } = await import("node:fs/promises");
		try {
			await stat(record.worktree.path);
		} catch {
			deps.log?.(`goal worktree ${record.worktree.path} is gone — resuming in the main workspace`);
			record.worktree = undefined;
		}
	}
	await saveGoal(sessionDir, record); // merge-save keyed by id — safe vs concurrent goals
	deps.log?.(`resuming interrupted goal "${record.goal}" (round ${record.round})`);
	launchGoalRoot(deps, record, sessionDir, true);
	return true;
}

export async function resumeGoals(deps: WorkflowToolDeps, sessionDir: string): Promise<number> {
	const goals = await loadGoals(sessionDir);
	let resumed = 0;
	for (const record of goals) {
		if (record.status !== "running") continue;
		if (await relaunchGoal(deps, sessionDir, record.id)) resumed += 1;
	}
	return resumed;
}

const runGoalSchema = Type.Object({
	goal: Type.String({ description: "The end-state to reach, one line (what 'done' means)." }),
	criteria: Type.String({
		description: "Acceptance criteria the evaluator will hold the work to. Concrete, checkable, complete — the evaluator sees NOTHING else, so this must carry the full definition of done.",
	}),
	worktree: Type.Optional(
		Type.Boolean({ description: "Run in an isolated git worktree + branch (default true for code-writing goals in a git repo). The user decides about merging at the end." }),
	),
	max_iterations: Type.Optional(Type.Number({ description: `Round cap (default ${DEFAULT_MAX_ITERATIONS}). The loop gives up and reports back when exceeded.` })),
});

export const RUN_GOAL_TOOL_META = {
	name: "run_goal",
	mode: "W",
	parameters: runGoalSchema,
	description:
		"Start a background goal-seeking loop: an executor agent iterates plan→execute, an independent evaluator judges each round against the criteria, and the loop runs until PASS (or the round cap). Use when the user states a goal with a checkable definition of done ('make X work', 'until tests pass') — not for open-ended chat.",
	prompt: {
		snippet: "Run a goal loop: execute → evaluate → revise until PASS",
		guidelines: [
			"The criteria are the evaluator's ENTIRE context — write them complete and checkable; anything not in them will not be judged.",
			"Best fit: goals with an objective definition of done (tests pass, file exists, output matches). Avoid it for subjective tasks.",
			"You are free to continue; you'll be woken once with the final verdict history (and the merge question for worktree runs).",
		],
	},
} satisfies ToolMeta;

export function createRunGoalTool(deps: WorkflowToolDeps & { sessionDir: string }): ToolDefinition {
	return defineTool<typeof runGoalSchema, undefined>({
		...RUN_GOAL_TOOL_META,
		label: "run_goal",
		parameters: runGoalSchema,
		async execute(_toolCallId, params) {
			const goals = await loadGoals(deps.sessionDir);
			if (goals.some((g) => g.goal.trim() === params.goal.trim() && g.status === "running")) {
				return { content: [{ type: "text", text: `run_goal: an identical goal is already running — wait for its wake-up.` }], details: undefined };
			}
			let worktree: WorktreeInfo | undefined;
			if (params.worktree !== false) {
				if (await isGitRepo(deps.cwd)) {
					try {
						worktree = await createWorktree(deps.cwd, deps.worktreeDir, params.goal);
						deps.log?.(`goal worktree: ${worktree.branch} at ${worktree.path}`);
					} catch (err) {
						deps.log?.(`goal worktree unavailable (${err instanceof Error ? err.message : String(err)}) — running in the main workspace`);
					}
				}
			}
			const record: GoalRecord = {
				id: generateId(),
				goal: params.goal,
				createdAt: Date.now(),
				criteria: params.criteria,
				ownerAgent: generateId(),
				round: 1,
				status: "running",
				worktree,
				verdicts: [],
				maxIterations: Math.max(1, Math.floor(params.max_iterations ?? DEFAULT_MAX_ITERATIONS)),
			};
			// Merge-save (not whole-file): a concurrently-running goal loop may
			// have saved a verdict while we awaited worktree creation above.
			await saveGoal(deps.sessionDir, record);
			// Surface the worktree to worktree_decide via the DAG store — the
			// goal has no plan tree of its own, so register a stand-alone record
			// (otherwise the end-of-goal merge question has no sanctioned path).
			if (worktree) {
				deps.dags.recordStandaloneWorktree(record.ownerAgent, params.goal, {
					path: worktree.path,
					branch: worktree.branch,
					baseSha: worktree.baseSha,
				});
			}
			launchGoalRoot(deps, record, deps.sessionDir, false);
			return {
				content: [
					{
						type: "text",
						text:
							`Goal loop started in the background (goal ${record.id}, max ${record.maxIterations} rounds).` +
							(worktree ? ` Running isolated on branch ${worktree.branch} (${worktree.path}); the user's working tree is untouched.` : "") +
							` Each round an independent evaluator checks the acceptance criteria; you'll be woken with the final result. The user can watch rounds in the plan panel.`,
					},
				],
				details: undefined,
			};
		},
	});
}
