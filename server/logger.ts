/**
 * Minimal pino-style logger — no dependency, one JSON line per event.
 *
 * Shape (pino-compatible enough for any ingester to parse):
 *   {"level":"info","time":1690000000000,"msg":"clownfish server → …","module":"server"}
 *
 * Levels: trace < debug < info < warn < error. Filter via CLOWNFISH_LOG_LEVEL
 * (env or settings.json env:{}); default "info". Output is ALWAYS stdout —
 * rotation/redirect belongs to the process supervisor (systemd/journald),
 * not the app.
 *
 * Usage: `const log = logger.child({ module: "scheduler" }); log.info("fired %s", key)`
 * printf-style (%s/%d/%j) keeps call sites terse like console.log but the
 * rendered string lands in one JSON field.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

function resolveLevel(): LogLevel {
	const raw = (process.env.CLOWNFISH_LOG_LEVEL ?? "info").toLowerCase();
	return raw in LEVELS ? (raw as LogLevel) : "info";
}

let currentLevel = resolveLevel();

/** Format a printf-style template: %s string, %d integer, %j json, %% literal. */
function render(msg: string, args: unknown[]): string {
	if (args.length === 0) return msg;
	let i = 0;
	return msg.replace(/%[sdj%]/g, (m) => {
		if (m === "%%") return "%";
		if (i >= args.length) return m;
		const v = args[i++];
		switch (m) {
			case "%d":
				return String(Number(v));
			case "%j":
				try {
					return JSON.stringify(v);
				} catch {
					return "[unserializable]";
				}
			default:
				return typeof v === "string" ? v : (v instanceof Error ? v.stack ?? String(v) : JSON.stringify(v) ?? String(v));
		}
	});
}

export interface LogFields {
	[key: string]: unknown;
}

/** Either a plain printf call or pino-style fields-first. */
type LogCall = {
	(msg: string, ...args: unknown[]): void;
	(fields: LogFields, msg: string, ...args: unknown[]): void;
};

export interface Logger {
	trace: LogCall;
	debug: LogCall;
	info: LogCall;
	warn: LogCall;
	error: LogCall;
	/** Derive a logger with extra constant fields (module, sessionId …). */
	child(fields: LogFields): Logger;
}

/**
 * Normalize the two accepted call shapes into (fields, msg, args):
 *   log.error("boom %s", x)            → plain printf
 *   log.error({ err }, "boom %s", x)   → pino-style with structured fields
 */
function normalize(first: string | LogFields, rest: unknown[]): { fields: LogFields; msg: string; args: unknown[] } {
	if (typeof first === "string") return { fields: {}, msg: first, args: rest };
	const [msg, ...args] = rest as [string, ...unknown[]];
	return { fields: first, msg: msg ?? "", args };
}

function emit(level: LogLevel, base: LogFields, msg: string, args: unknown[]): void {
	if (LEVELS[level] < LEVELS[currentLevel]) return;
	const rec: Record<string, unknown> = { level, time: Date.now(), msg: render(msg, args) };
	for (const [k, v] of Object.entries(base)) {
		if (v !== undefined) rec[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
	}
	process.stdout.write(`${JSON.stringify(rec)}\n`);
}

function makeLogger(base: LogFields): Logger {
	const method = (level: LogLevel) => (first: string | LogFields, ...rest: unknown[]): void => {
		const { fields, msg, args } = normalize(first, rest);
		emit(level, { ...base, ...fields }, msg, args);
	};
	return {
		trace: method("trace"),
		debug: method("debug"),
		info: method("info"),
		warn: method("warn"),
		error: method("error"),
		child: (fields) => makeLogger({ ...base, ...fields }),
	};
}

/** Root logger. Use `.child({ module: "…" })` per subsystem. */
export const logger: Logger = makeLogger({ service: "clownfish" });

/** Test seam / runtime override. */
export function setLogLevel(level: LogLevel): void {
	if (level in LEVELS) currentLevel = level;
}
