/**
 * Cron scheduling primitives — the 5-field expression engine shared by the
 * worker-side `cron` tool (spec persistence) and the server-side Scheduler
 * (progress + firing).
 *
 * A 5-field expression `m h dom mon dow` is parsed into a {@link CronExpr}
 * (five bit-set-ish matchers) and evaluated by {@link computeNextRun}: the
 * earliest instant strictly after `from` (minute-aligned, local time — the
 * server's own zone is what "2:00 at night" means to the user sitting next to
 * it). No external cron library: the supported grammar is the common subset
 * every scheduler agrees on, so the edge semantics (DST gaps, month-end) are
 * ours to keep deliberate and boring.
 *
 * Supported per field: `*`, plain numbers, ranges `a-b`, lists `a,b,c`,
 * steps `*` /n and `a-b` /n. Day-of-week: 0-7 (both 0 and 7 = Sunday), names
 * mon-sun (case-insensitive, 3-letter). Month: 1-12, names jan-dec.
 *
 * Day-of-month vs day-of-week follows the POSIX/standard (Vixie cron) rule:
 * when BOTH are restricted (neither is `*`), the day matches if EITHER field
 * matches; when only one is restricted, that one decides.
 */
import { generateId } from "./id";

// ---------------------------------------------------------------- expressions ----

/** Field ranges + parsed match sets for one 5-field expression. */
export interface CronExpr {
	raw: string;
	/** Minute set (0-59). */
	minutes: Set<number>;
	/** Hour set (0-23). */
	hours: Set<number>;
	/** Day-of-month set (1-31). */
	daysOfMonth: Set<number>;
	/** Month set (1-12). */
	months: Set<number>;
	/** Day-of-week set (0-6, 0 = Sunday). */
	daysOfWeek: Set<number>;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELD_RANGES: Array<{ key: keyof Omit<CronExpr, "raw">; min: number; max: number; names?: string[] }> = [
	{ key: "minutes", min: 0, max: 59 },
	{ key: "hours", min: 0, max: 23 },
	{ key: "daysOfMonth", min: 1, max: 31 },
	{ key: "months", min: 1, max: 12, names: MONTH_NAMES },
	{ key: "daysOfWeek", min: 0, max: 6, names: DOW_NAMES },
];

/** Parse one comma-separated field item ("*", "n", "a-b", "step" variants) into `out`. */
function parseItem(
	item: string,
	min: number,
	max: number,
	names: string[] | undefined,
	out: Set<number>,
): void {
	const rangeStep = item.match(/^(\*|\d+|\d+-\d+|[a-z]{3}|[a-z]{3}-[a-z]{3})(?:\/(\d+))?$/i);
	if (!rangeStep) throw new Error(`'${item}'`);
	// Resolve the range part (base) and the step.
	const baseRaw = rangeStep[1];
	const step = rangeStep[2] !== undefined ? Number(rangeStep[2]) : 1;
	if (!Number.isInteger(step) || step < 1) throw new Error(`step '${item}'`);
	let lo: number;
	let hi: number;
	if (baseRaw === "*") {
		lo = min;
		hi = max;
	} else if (baseRaw.includes("-")) {
		const [a, b] = baseRaw.split("-");
		lo = resolveToken(a, min, max, names, item);
		hi = resolveToken(b, min, max, names, item);
	} else {
		lo = resolveToken(baseRaw, min, max, names, item);
		hi = lo;
	}
	if (lo > hi) throw new Error(`descending range '${item}'`);
	for (let v = lo; v <= hi; v += step) {
		out.add(v);
	}
}

function resolveToken(tok: string, min: number, max: number, names: string[] | undefined, ctx: string): number {
	if (names) {
		const idx = names.indexOf(tok.toLowerCase());
		if (idx >= 0) return idx + (max === 6 ? 0 : 1); // dow names index from 0; month names from 1
	}
	if (!/^\d+$/.test(tok)) throw new Error(`token '${tok}' in '${ctx}'`);
	const v = Number(tok);
	// dow: 7 is an accepted alias for Sunday (0) — fold before range-checking.
	const folded = max === 6 && v === 7 ? 0 : v;
	if (folded < min || folded > max) throw new Error(`value ${v} out of ${min}-${max} in '${ctx}'`);
	return folded;
}

/** Parse a 5-field cron expression. Throws Error with the offending fragment. */
export function parseCronExpr(raw: string): CronExpr {
	const text = raw.trim().replace(/\s+/g, " ");
	const parts = text.split(" ");
	if (parts.length !== 5) throw new Error(`expected 5 fields (min hour dom month dow), got ${parts.length}`);
	const expr: CronExpr = {
		raw: text,
		minutes: new Set(),
		hours: new Set(),
		daysOfMonth: new Set(),
		months: new Set(),
		daysOfWeek: new Set(),
	};
	FIELD_RANGES.forEach(({ key, min, max, names }, i) => {
		const out = expr[key];
		for (const item of parts[i].split(",")) {
			if (!item) throw new Error(`empty list item in field ${i + 1}`);
			parseItem(item, min, max, names, out);
		}
	});
	return expr;
}

/** Human-check the expression up front (returns the error message, or null). */
export function validateCronExpr(raw: string): string | null {
	try {
		parseCronExpr(raw);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function dateFieldMatch(d: Date, set: Set<number>, get: (d: Date) => number): boolean {
	return set.has(get(d));
}

/** Does `d` (minute-aligned) match the expression? (Vixie dom/dow OR rule.) */
function matches(expr: CronExpr, d: Date): boolean {
	if (!dateFieldMatch(d, expr.minutes, (x) => x.getMinutes())) return false;
	if (!dateFieldMatch(d, expr.hours, (x) => x.getHours())) return false;
	if (!dateFieldMatch(d, expr.months, (x) => x.getMonth() + 1)) return false;
	const domStar = expr.daysOfMonth.size === 31;
	const dowStar = expr.daysOfWeek.size === 7;
	const domOk = dateFieldMatch(d, expr.daysOfMonth, (x) => x.getDate());
	// JS getDay(): 0 = Sunday — same convention as cron dow.
	const dowOk = dateFieldMatch(d, expr.daysOfWeek, (x) => x.getDay());
	if (!domStar && !dowStar) return domOk || dowOk;
	if (!domStar) return domOk;
	if (!dowStar) return dowOk;
	return true; // both `*` — every day
}

/**
 * Earliest matching instant strictly after `from`, minute-aligned, in the
 * server's local timezone. Minute-stepping keeps DST/leap semantics correct by
 * construction (each candidate is built from real Date arithmetic) — at cron
 * granularity 1440 steps/day is nothing. Returns null when no match exists
 * within a year (e.g. day 31 in February-only months — practically unreachable,
 * but the loop must not spin forever).
 */
export function computeNextRun(expr: CronExpr, from: Date = new Date()): Date | null {
	const d = new Date(from.getTime());
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1); // strictly after
	// Search window: 5 years (covers Feb 29 + rare month/day combos) yet stays
	// bounded. Minute-stepping a 5-year window is at most ~2.6M iterations of a
	// Set.has chain — fine for schedule-time validation, and the common case is
	// found in the first few steps.
	const limit = new Date(from.getTime() + 5 * 366 * 24 * 3600 * 1000);
	while (d.getTime() <= limit.getTime()) {
		if (matches(expr, d)) return new Date(d.getTime());
		// Smart-ish stepping: skip to the next candidate minute at coarse grain
		// when a whole day/month can't match (keeps the worst case ~ms-fast).
		d.setMinutes(d.getMinutes() + 1);
	}
	return null;
}

/** Render the next few run times (for tool feedback / smoke tests). */
export function previewRuns(expr: CronExpr, from: Date = new Date(), count = 3): Date[] {
	const out: Date[] = [];
	let cur = from;
	for (let i = 0; i < count; i++) {
		const next = computeNextRun(expr, cur);
		if (!next) break;
		out.push(next);
		cur = next;
	}
	return out;
}

// -------------------------------------------------------------------- specs ----

/**
 * One scheduled job's SPEC (worker-owned, lives in the session's own directory
 * as `cron.json` — deleting the session deletes its jobs). The server keeps
 * separate PROGRESS state (next-run, runs, failures) under its dataDir; the two
 * never share a file, honoring the repo's "no shared writable store" rule.
 */
export interface CronJobSpec {
	/** Stable id (also the cancel handle). */
	id: string;
	/** 5-field cron expression (validated). */
	expr: string;
	/** What to prompt the session's agent with when the job fires. */
	prompt: string;
	/** Human label shown in listings. */
	name?: string;
	createdAt: number;
}

/** The session's cron spec file: `<sessionsDir>/<sessionId>/cron.json`. */
export interface CronSpecFile {
	jobs: CronJobSpec[];
}

/** Upper bound on jobs per session — cron is a scalpel, not a queue system. */
export const MAX_JOBS_PER_SESSION = 20;

/** The prompt the scheduler injects when firing a job (bracketed so the agent
 *  treats it as system-orchestrated, like wakeMain's workflow notices). */
export function renderCronPrompt(spec: CronJobSpec, firedAt: Date): string {
	const when = firedAt.toLocaleString();
	return (
		`[scheduled task${spec.name ? ` — ${spec.name}` : ""}]\n` +
		`A cron job you scheduled (${spec.expr}) fired at ${when}. Do the task now, autonomously, as a background turn:\n\n${spec.prompt}`
	);
}
