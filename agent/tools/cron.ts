/**
 * cron tool — let a session's agent schedule its own recurring/scheduled work.
 *
 * `schedule { expr, prompt }` validates a 5-field cron expression and appends a
 * {@link CronJobSpec} to the session's own `cron.json` (inside the session
 * directory, so deleting the session deletes its jobs). The SERVER-side
 * Scheduler independently scans those spec files, tracks progress in its own
 * dataDir state, and fires jobs by prompting the session's agent — see
 * `server/scheduler.ts`. Spec and progress are deliberately split across the
 * two owners so neither process writes the other's files.
 *
 * Also `list` and `cancel`. Mode "W" (it mutates durable state).
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition, type ToolMeta } from "./definition";
import { generateId } from "../id";
import {
	MAX_JOBS_PER_SESSION,
	parseCronExpr,
	previewRuns,
	validateCronExpr,
	type CronJobSpec,
	type CronSpecFile,
} from "../schedule";

const cronSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("schedule"), Type.Literal("list"), Type.Literal("cancel")], {
			description: "schedule a new job, list this session's jobs, or cancel one.",
		}),
		expr: Type.Optional(
			Type.String({ description: '5-field cron expression "minute hour day-of-month month day-of-week" (e.g. "*/30 * * * *", "0 2 * * *", "0 9 * * 1-5"). Timezone: the server\'s local time.' }),
		),
		prompt: Type.Optional(
			Type.String({ description: "What to do when the job fires — sent to this session's agent as a background turn. Self-contained: no chat context is implied." }),
		),
		name: Type.Optional(Type.String({ description: "Short human label for listings." })),
		job_id: Type.Optional(Type.String({ description: "Job to cancel (from list)." })),
	},
	{ description: "Manage this session's scheduled (cron) tasks." },
);

export type CronToolInput = Static<typeof cronSchema>;

export interface CronToolDeps {
	/** Session id — the spec file lives inside this session's directory. */
	sessionId: string;
	/** Transcript root (same one SessionTranscript uses). */
	sessionsDir: string;
}

function specPath(deps: CronToolDeps): string {
	return join(deps.sessionsDir, deps.sessionId, "cron.json");
}

/** Read the session's cron spec file (empty on absent/malformed). Exported for the server Scheduler. */
export async function loadCronSpecs(sessionsDir: string, sessionId: string): Promise<CronJobSpec[]> {
	const raw = await readFile(join(sessionsDir, sessionId, "cron.json"), "utf8").catch(() => null);
	if (!raw) return [];
	try {
		const file = JSON.parse(raw) as Partial<CronSpecFile>;
		return Array.isArray(file.jobs) ? file.jobs : [];
	} catch {
		return [];
	}
}

async function saveCronSpecs(sessionsDir: string, sessionId: string, jobs: CronJobSpec[]): Promise<void> {
	const file = join(sessionsDir, sessionId, "cron.json");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ jobs } satisfies CronSpecFile, null, 2), "utf8");
}

export const CRON_TOOL_META = {
	name: "cron",
	mode: "W",
	parameters: cronSchema,
	description:
		"Schedule recurring background tasks for this session (5-field cron). The task runs as a background turn in THIS session even when no browser is attached. Also list (`action:\"list\"`) and cancel (`action:\"cancel\", job_id`).",
	prompt: {
		snippet: "Schedule a recurring background task",
		guidelines: [
			"The prompt must be self-contained — when it fires there is no surrounding conversation context.",
			"Cron has no year field, so a 'one-off' job WILL fire again next year — the prompt text of a one-shot must explicitly tell the fired turn to cancel the job.",
		],
	},
} satisfies ToolMeta;

export function createCronTool(deps: CronToolDeps): ToolDefinition<typeof cronSchema, { jobs: CronJobSpec[] }> {
	return defineTool<typeof cronSchema, { jobs: CronJobSpec[] }>({
		...CRON_TOOL_META,
		label: "cron",
		parameters: cronSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<{ jobs: CronJobSpec[] }>> {
			if (params.action === "list") {
				const jobs = await loadCronSpecs(deps.sessionsDir, deps.sessionId);
				return {
					content: [{
						type: "text",
						text: jobs.length
							? jobs.map((j) => `${j.id}  ${j.expr.padEnd(12)}  ${j.name ?? "(unnamed)"}\n    ${j.prompt.slice(0, 120)}`).join("\n")
							: "(no scheduled tasks)",
					}],
					details: { jobs },
				};
			}
			if (params.action === "cancel") {
				if (!params.job_id) return err("cancel requires job_id");
				const jobs = await loadCronSpecs(deps.sessionsDir, deps.sessionId);
				const next = jobs.filter((j) => j.id !== params.job_id);
				if (next.length === jobs.length) return err(`no job '${params.job_id}'`);
				await saveCronSpecs(deps.sessionsDir, deps.sessionId, next);
				return {
					content: [{ type: "text", text: `cancelled ${params.job_id}` }],
					details: { jobs: next },
				};
			}
			// schedule
			const exprRaw = params.expr?.trim();
			if (!exprRaw) return err("schedule requires expr");
			if (!params.prompt?.trim()) return err("schedule requires prompt");
			const invalid = validateCronExpr(exprRaw);
			if (invalid) return err(`invalid cron expression '${exprRaw}': ${invalid}`);
			const jobs = await loadCronSpecs(deps.sessionsDir, deps.sessionId);
			if (jobs.length >= MAX_JOBS_PER_SESSION) {
				return err(`this session already has ${jobs.length} scheduled tasks (max ${MAX_JOBS_PER_SESSION}); cancel some first`);
			}
			const spec: CronJobSpec = {
				id: generateId(),
				expr: exprRaw.replace(/\s+/g, " "),
				prompt: params.prompt.trim(),
				name: params.name?.trim() || undefined,
				createdAt: Date.now(),
			};
			jobs.push(spec);
			await saveCronSpecs(deps.sessionsDir, deps.sessionId, jobs);
			const next = previewRuns(parseCronExpr(spec.expr), new Date(), 2).map((d) => d.toLocaleString());
			return {
				content: [{
					type: "text",
					text: `scheduled '${spec.expr}' (id ${spec.id}). Next run(s): ${next.join(", ") || "(none within a year!)"}`,
				}],
				details: { jobs },
			};
		},
	});
}

function err(message: string): AgentToolResult<{ jobs: CronJobSpec[] }> {
	return { content: [{ type: "text", text: `cron: ${message}` }], details: { jobs: [] } };
}
