/**
 * Server-side cron Scheduler — the progress-owning half of the cron feature.
 *
 * The worker-side `cron` tool writes job SPECS into each session's own
 * `<sessionsDir>/<sessionId>/cron.json` (session-scoped, deleted with the
 * session). This scheduler is the only writer of PROGRESS state, kept under the
 * server's own `<dataDir>/cron-state.json` — the two files never mix owners, so
 * there is no shared writable store and no cross-process write contention
 * (the same rule the transcript/session-index split follows).
 *
 * Every 30s it:
 *   1. re-scans all projects' session indexes + spec files (cheap JSON reads;
 *      jobs change rarely, but a deleted session's state must fall away),
 *   2. computes next-run per job via the shared expression engine,
 *   3. fires due jobs through AgentManager.run — a full background turn in the
 *      owning session, browser or no browser (subscribers see it live).
 *
 * Missed-fire policy: anything more than MAX_CATCHUP_MS (24h) overdue is
 * skipped (the server was off / the job slept through); anything fresher fires
 * once immediately, then resyncs to the schedule. Busy sessions retry on later
 * ticks (bounded by the same 24h window) rather than queueing up a pile of
 * stale runs.
 *
 * Internal tasks register through the same
 * machinery but with an in-process callback instead of a session prompt.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeNextRun, parseCronExpr, renderCronPrompt, type CronExpr, type CronJobSpec } from "../agent/schedule";
import { loadCronSpecs } from "../agent/tools/cron";
import { logger } from "./logger";
import type { AgentManager } from "../agent/manager";
import type { ProjectManager } from "./models/projects";
import type { SessionStore } from "./models/sessions";

/** How often the scheduler wakes to check for due jobs. */
const TICK_MS = 30_000;
/** A job more overdue than this is skipped (missed while the server was down). */
export const MAX_CATCHUP_MS = 24 * 3600 * 1000;

const log = logger.child({ module: "scheduler" });
/** Persisted progress record per session-job (key: `${sessionId}/${jobId}`). */
interface JobProgress {
	nextRun: number;
	lastRun?: number;
	/** Consecutive failed fire attempts (reset on success). */
	failures: number;
}

interface CronStateFile {
	/** `${sessionId}/${jobId}` → progress. */
	jobs: Record<string, JobProgress>;
}

/** Fire handle for internal tasks (scheduler-owned cron without a session). */
export interface InternalTask {
	id: string;
	expr: string;
	label: string;
	/** Invoked when due. Should resolve on success, reject on failure. */
	run: (firedAt: Date) => Promise<void>;
}

export interface SchedulerOptions {
	dataDir: string;
	sessionsDir: string;
	projects: ProjectManager;
	sessions: SessionStore;
	agents: AgentManager;
	/** Test seam: clock (defaults to Date.now). */
	now?: () => number;
	/** Test seam: tick interval (defaults to 30s). */
	tickMs?: number;
}

/** Serializable listing row for the REST API. */
export interface CronJobInfo {
	key: string;
	sessionId: string;
	projectId: string;
	jobId: string;
	expr: string;
	name?: string;
	prompt: string;
	/** Display only — internal tasks have no session. */
	internal?: boolean;
	nextRun?: number;
	lastRun?: number;
	failures: number;
}

export class Scheduler {
	private state: CronStateFile = { jobs: {} };
	private timer: NodeJS.Timeout | undefined;
	private ticking = false;
	private readonly internalTasks = new Map<string, InternalTask & { parsed: CronExpr }>();
	private readonly now: () => number;

	constructor(private readonly opts: SchedulerOptions) {
		this.now = opts.now ?? Date.now;
	}

	private statePath(): string {
		return join(this.opts.dataDir, "cron-state.json");
	}

	private async loadState(): Promise<void> {
		const raw = await readFile(this.statePath(), "utf8").catch(() => null);
		if (!raw) return;
		try {
			const file = JSON.parse(raw) as Partial<CronStateFile>;
			if (file && typeof file.jobs === "object") this.state = { jobs: file.jobs };
		} catch {
			/* malformed state — start fresh (specs are the source of truth) */
		}
	}

	private async saveState(): Promise<void> {
		const file = this.statePath();
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(this.state, null, 2), "utf8");
	}

	/** Register an in-process recurring task (archive, backup). */
	registerInternal(task: InternalTask): void {
		const parsed = parseCronExpr(task.expr); // throws on a bad fixed expr — fail fast at boot
		this.internalTasks.set(task.id, { ...task, parsed });
	}

	async start(): Promise<void> {
		await this.loadState();
		if (this.timer) return;
		const timer = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
		timer.unref?.();
		this.timer = timer;
		void this.tick(); // immediate first pass
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	// ------------------------------------------------------------- discovery ----

	/** All session jobs: every project's sessions × their spec files. */
	private async discoverSessionJobs(): Promise<Array<{ projectId: string; spec: CronJobSpec; sessionId: string }>> {
		const out: Array<{ projectId: string; spec: CronJobSpec; sessionId: string }> = [];
		for (const project of await this.opts.projects.list()) {
			for (const session of await this.opts.sessions.list(project.id)) {
				for (const spec of await loadCronSpecs(this.opts.sessionsDir, session.id)) {
					out.push({ projectId: project.id, sessionId: session.id, spec });
				}
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ tick ----

	/**
	 * Next matching slot after `from`, skipping any that are still ≤ `now`
	 * (a multi-day gap needs more than one hop to catch up). Bounded by the
	 * engine's own search window.
	 */
	private advancePast(expr: CronExpr, from: number, now: number): number {
		let cur = from;
		for (let i = 0; i < 366 * 5; i++) {
			const next = computeNextRun(expr, new Date(cur));
			if (!next) return now + MAX_CATCHUP_MS;
			if (next.getTime() > now) return next.getTime();
			cur = next.getTime();
		}
		return now + MAX_CATCHUP_MS;
	}

	/** One scheduler pass. Serialized (a slow fire must not stack ticks). */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const now = this.now();
			let dirty = false;

			// Internal tasks first (cheap, in-process).
			for (const task of this.internalTasks.values()) {
				const key = `internal/${task.id}`;
				const prog = this.state.jobs[key] ?? (this.state.jobs[key] = { nextRun: 0, failures: 0 });
				if (!prog.nextRun) {
					const next = computeNextRun(task.parsed, new Date(now));
					prog.nextRun = next?.getTime() ?? now + MAX_CATCHUP_MS;
					dirty = true;
				}
				const overdueMs = now - prog.nextRun;
				if (overdueMs < 0) continue;
				if (overdueMs < MAX_CATCHUP_MS) {
					try {
						await task.run(new Date(prog.nextRun));
						prog.failures = 0;
					} catch (err) {
						prog.failures++;
						log.error({ err: err instanceof Error ? err.message : String(err) }, "internal task '%s' failed", task.label);
					}
				} else {
					log.warn("skipped stale internal task '%s' (missed by %dh)", task.label, Math.round(overdueMs / 3600000));
				}
				prog.lastRun = prog.nextRun;
				prog.nextRun = this.advancePast(task.parsed, prog.nextRun, now);
				dirty = true;
			}

			// Session jobs.
			const jobs = await this.discoverSessionJobs();
			const liveKeys = new Set<string>();
			for (const { projectId, sessionId, spec } of jobs) {
				const key = `${sessionId}/${spec.id}`;
				liveKeys.add(key);
				let expr: CronExpr;
				try {
					expr = parseCronExpr(spec.expr);
				} catch {
					continue; // a spec the tool wouldn't write — ignore
				}
				const prog = this.state.jobs[key] ?? (this.state.jobs[key] = { nextRun: 0, failures: 0 });
				if (!prog.nextRun) {
					const next = computeNextRun(expr, new Date(now));
					prog.nextRun = next?.getTime() ?? now + MAX_CATCHUP_MS;
					dirty = true;
				}
				const overdueMs = now - prog.nextRun;
				if (overdueMs < 0) continue; // not due yet
				if (overdueMs >= MAX_CATCHUP_MS) {
					// Slept through (server down) — skip the stale fire, resync.
					prog.lastRun = prog.nextRun;
					prog.nextRun = this.advancePast(expr, prog.nextRun, now);
					dirty = true;
					log.warn("skipped stale job %s (missed by %dh)", key, Math.round(overdueMs / 3600000));
					continue;
				}
				// Due. Fire as a background turn in the owning session.
				try {
					const project = (await this.opts.projects.get(projectId))!;
					await this.opts.agents.run(project, sessionId, renderCronPrompt(spec, new Date(prog.nextRun)));
					prog.lastRun = prog.nextRun;
					prog.failures = 0;
					log.info("fired %s (%s)", key, spec.expr);
				} catch (err) {
					prog.failures++;
					// Busy agent / spawn failure: retry on a later tick within the
					// catch-up window; give up resyncing beyond it.
					log.warn({ err: err instanceof Error ? err.message : String(err) }, "fire failed for %s (attempt %d)", key, prog.failures);
					if (prog.failures >= 3) {
						prog.lastRun = prog.nextRun;
						log.warn("giving up on this occurrence of %s after 3 failures", key);
					} else {
						// Stay due (retry this occurrence on the next tick) — don't advance.
						dirty = true;
						continue;
					}
				}
				// advance from the scheduled slot either way (skip anything still ≤ now)
				prog.nextRun = this.advancePast(expr, prog.nextRun, now);
				dirty = true;
			}

			// Drop state for jobs that no longer exist (session deleted / cancelled).
			for (const key of Object.keys(this.state.jobs)) {
				if (key.startsWith("internal/")) continue;
				if (!liveKeys.has(key)) {
					delete this.state.jobs[key];
					dirty = true;
				}
			}

			if (dirty) await this.saveState();
		} finally {
			this.ticking = false;
		}
	}

	// ------------------------------------------------------------------ api ----

	/** Listing for the REST API (session jobs + internal tasks). */
	async listJobs(): Promise<CronJobInfo[]> {
		const out: CronJobInfo[] = [];
		for (const task of this.internalTasks.values()) {
			const prog = this.state.jobs[`internal/${task.id}`];
			out.push({
				key: `internal/${task.id}`,
				sessionId: "",
				projectId: "",
				jobId: task.id,
				expr: task.expr,
				name: task.label,
				prompt: "(internal)",
				internal: true,
				nextRun: prog?.nextRun,
				lastRun: prog?.lastRun,
				failures: prog?.failures ?? 0,
			});
		}
		for (const { projectId, sessionId, spec } of await this.discoverSessionJobs()) {
			const prog = this.state.jobs[`${sessionId}/${spec.id}`];
			out.push({
				key: `${sessionId}/${spec.id}`,
				sessionId,
				projectId,
				jobId: spec.id,
				expr: spec.expr,
				name: spec.name,
				prompt: spec.prompt,
				nextRun: prog?.nextRun,
				lastRun: prog?.lastRun,
				failures: prog?.failures ?? 0,
			});
		}
		return out;
	}

	/** Cancel by rewriting the session's spec file (server-side handle for the REST API). */
	async cancelJob(sessionId: string, jobId: string): Promise<boolean> {
		const file = join(this.opts.sessionsDir, sessionId, "cron.json");
		const raw = await readFile(file, "utf8").catch(() => null);
		if (!raw) return false;
		let jobs: CronJobSpec[];
		try {
			jobs = (JSON.parse(raw) as { jobs: CronJobSpec[] }).jobs ?? [];
		} catch {
			return false;
		}
		const next = jobs.filter((j) => j.id !== jobId);
		if (next.length === jobs.length) return false;
		await writeFile(file, JSON.stringify({ jobs: next }, null, 2), "utf8");
		delete this.state.jobs[`${sessionId}/${jobId}`];
		await this.saveState();
		return true;
	}
}
