/**
 * worktree_decide — the closing half of the worktree lifecycle.
 *
 * run_goal's completion wake asks the user merge/keep/discard for the run's
 * isolation branch; this tool executes their answer. The main agent calls
 * it right after the user decides. It is the ONLY caller of mergeWorktree /
 * removeWorktree — the executor itself never merges (its prompt says so).
 *
 * Locating the worktree: by dag id (precise) or branch name (what the user
 * actually sees in the wake message). Both come from the DagStore's persisted
 * tree records.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolMeta } from "./definition";
import type { DagStore } from "../dag";
import { branchHasCommits, mergeWorktree, removeWorktree, worktreeDirty } from "../worktree";

const worktreeDecideSchema = Type.Object({
	dag: Type.Optional(Type.String({ description: "Dag id of the workflow (from the completion message)." })),
	branch: Type.Optional(Type.String({ description: "Branch name, e.g. clownfish/fix-build-Ab12Cd34 (from the completion message)." })),
	decision: Type.Union(
		[
			Type.Literal("merge"),
			Type.Literal("keep"),
			Type.Literal("discard"),
		],
		{
			description:
				"merge = fast-forward/merge the branch into the current branch, then clean up the worktree. keep = leave branch + worktree as-is (user wants to inspect/continue there). discard = delete the worktree dir AND the branch (unmerged work is lost).",
		},
	),
});

export const WORKTREE_DECIDE_TOOL_META = {
	name: "worktree_decide",
	mode: "W",
	parameters: worktreeDecideSchema,
	description:
		"Execute the user's merge/keep/discard decision for a completed workflow's git worktree branch. Call this immediately after the user answers the merge question raised by a completed background run.",
	prompt: {
		snippet: "Apply the user's worktree decision (merge/keep/discard)",
		guidelines: [
			"Use right after the user answers the worktree question raised by a completed async workflow.",
			"'merge' merges into the current branch and removes the worktree; 'keep' touches nothing; 'discard' deletes branch + worktree (work is lost).",
			"Report the outcome (merge result / kept paths / removed paths) to the user.",
		],
	},
} satisfies ToolMeta;

export function createWorktreeDecideTool(deps: { dags: DagStore; cwd: string }) {
	return defineTool<typeof worktreeDecideSchema, undefined>({
		...WORKTREE_DECIDE_TOOL_META,
		label: "worktree decision",
		parameters: worktreeDecideSchema,
		async execute(_toolCallId, params) {
			const wt = deps.dags.findWorktree(params.dag, params.branch);
			if (!wt) {
				return {
					content: [{ type: "text", text: `No workflow worktree found for ${params.dag ? `dag ${params.dag}` : `branch ${params.branch}`}. It may already be decided/cleaned up.` }],
					details: undefined,
				};
			}
			try {
				if (params.decision === "keep") {
					return {
						content: [{ type: "text", text: `Kept branch ${wt.branch} and worktree ${wt.path} untouched. The user can inspect it there or decide again later.` }],
						details: undefined,
					};
				}
				if (params.decision === "discard") {
					await removeWorktree(deps.cwd, wt.path, wt.branch);
					deps.dags.clearWorktree(wt.dagId);
					return {
						content: [{ type: "text", text: `Discarded: removed worktree ${wt.path} and deleted branch ${wt.branch}.` }],
						details: undefined,
					};
				}
				// merge
				if (!(await branchHasCommits(deps.cwd, wt.branch))) {
					// No commits, but the worktree may still hold UNCOMMITTED work
					// (a dagRoot that wrote files without committing). Force-removing
					// here would silently destroy it — keep and surface instead.
					if (await worktreeDirty(wt.path)) {
						return {
							content: [
								{
									type: "text",
									text: `Branch ${wt.branch} has no commits, but worktree ${wt.path} has UNCOMMITTED changes — nothing was merged or removed so the work is not lost. Ask the user whether to commit it manually or discard for real.`,
								},
							],
							details: undefined,
						};
					}
					await removeWorktree(deps.cwd, wt.path, wt.branch);
					deps.dags.clearWorktree(wt.dagId);
					return {
						content: [{ type: "text", text: `Branch ${wt.branch} had no new commits — nothing to merge; worktree cleaned up.` }],
						details: undefined,
					};
				}
				const result = await mergeWorktree(deps.cwd, wt.branch);
				// Same guard after the merge: committed work is in, but the worktree
				// may hold additional uncommitted edits beyond what was merged.
				if (await worktreeDirty(wt.path)) {
					return {
						content: [
							{
								type: "text",
								text: `Merged ${wt.branch} into the current branch (${result.split("\n")[0]}). Worktree ${wt.path} was KEPT — it has uncommitted changes beyond the merged commits; branch ${wt.branch} also kept. Ask the user what to do with the leftover edits.`,
							},
						],
						details: undefined,
					};
				}
				await removeWorktree(deps.cwd, wt.path, wt.branch);
				deps.dags.clearWorktree(wt.dagId);
				return {
					content: [{ type: "text", text: `Merged ${wt.branch} into the current branch (${result.split("\n")[0]}); worktree ${wt.path} removed and branch deleted.` }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `worktree_decide '${params.decision}' failed: ${err instanceof Error ? err.message : String(err)} — nothing was partially applied beyond what the error says.` }],
					details: undefined,
				};
			}
		},
	});
}
