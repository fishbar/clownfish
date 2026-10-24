/**
 * Filesystem jail — the session-isolation boundary for agent tools.
 *
 * All sessions run as one OS user, so without a boundary every agent could
 * read/write anything the user can. The filesystem must not be a cross-session
 * channel. Policy for structured tools (read/write/edit/ls/grep/find):
 *
 *   1. Inside the agent's allowed area → allowed. That is the workspace cwd,
 *      widened to an optional `root` containing it (a run_agent sub-agent
 *      gets a narrowed cwd for cheap discovery plus its parent's workspace
 *      as root, so climbing up for missing context needs no consent). A
 *      worktree sub-agent's cwd is its worktree. Symlinks are canonicalized,
 *      so a link inside the area that points outside is treated as an
 *      outside path.
 *   2. Outside the workspace but not session data → allowed only with USER
 *      CONSENT: the tool parks on a tool_approval card showing the resolved
 *      path until the user approves (see runtime's jailApproval).
 *   3. Session-data roots (dataDir/sessionsDir — other sessions'
 *      transcripts, the provider secrets in settings.json, memory) → always
 *      refused, consent or not. That is the cross-session channel itself;
 *      exposing it to a session must not be one click away.
 *
 * The bash tool runs real commands, so it gets a best-effort screen instead:
 * the command text must not reference the session-data roots (absolute, `~`,
 * `$HOME`, `${HOME}` forms) and must not climb out of the workspace via `..`.
 * This is a tripwire for mistakes and casual probing, not a security
 * boundary — a determined command (`$(echo)`, hex literals, …) gets past any
 * text screen; full isolation needs a sandboxed spawn mode.
 *
 * Runtime-internal fs access (transcripts, skills, MCP config, memory,
 * checkpoints, cron specs) does not go through tools — those paths are chosen
 * by code, not by the model, and stays outside this jail.
 */
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { resolveToCwd } from "./path-utils";

/** Refused by a tool because the path resolves outside the workspace jail. */
export class PathJailError extends Error {
	constructor(target: string, jail: string, reason?: string) {
		super(
			`Path refused: '${target}' resolves outside your workspace (${jail}). ` +
				(reason ??
					`Agents may only access paths inside their own workspace with the user's consent — ask the user or work inside your workspace.`),
		);
		this.name = "PathJailError";
	}
}

/** True when `p` is `root` itself or nested underneath it (no `..` escapes). */
export function isInsidePath(p: string, root: string): boolean {
	const rel = relative(root, p);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Per-call context for {@link resolveJailedPath}: who is asking, and the consent callback. */
export interface JailContext {
	toolCallId?: string;
	tool?: string;
	signal?: AbortSignal;
	/** Ask the user to consent to an outside-workspace path. Resolves true to allow. */
	approval?: (info: { toolCallId?: string; tool?: string; path: string; jail: string; signal?: AbortSignal }) => Promise<boolean>;
}

// Canonical jail roots are stable for the process lifetime — cache the
// realpath lookups (the workspace dir itself may sit behind a symlink).
const jailRealCache = new Map<string, string>();

async function canonicalJail(cwd: string): Promise<string> {
	let real = jailRealCache.get(cwd);
	if (real === undefined) {
		real = await realpath(cwd).catch(() => cwd);
		jailRealCache.set(cwd, real);
	}
	return real;
}

/** Canonicalize `p`: realpath of its deepest existing ancestor + the missing suffix. */
async function canonicalize(p: string): Promise<string> {
	let probe = p;
	const suffix: string[] = [];
	for (;;) {
		const real = await realpath(probe).catch(() => null);
		if (real !== null) return suffix.length ? resolvePath(real, ...suffix) : real;
		const parent = dirname(probe);
		if (parent === probe) return p; // nothing exists on the chain
		suffix.unshift(basename(probe));
		probe = parent;
	}
}

// --- session-data roots (shared by the path hard-deny and the bash screen) ----

/** Roots that are always refused (bash screen: must not be referenced either). */
let isolationRoots: string[] = [];

/**
 * Configure the session-data roots (the server's dataDir + sessionsDir).
 * Called from runtime.boot() — every agent in the process inherits it; the
 * roots are process-level config, identical for all sessions a process hosts.
 */
export function setIsolationRoots(roots: string[]): void {
	isolationRoots = [...new Set(roots.filter(Boolean))].map((r) =>
		r.endsWith(sep) && r !== sep ? r.slice(0, -1) : r,
	);
	// Longest first so nested roots (sessionsDir under dataDir) match their
	// most specific variant when screening.
	isolationRoots.sort((a, b) => b.length - a.length);
}

/** The first isolation root containing `p`, if any. */
function isolationRootFor(p: string): string | undefined {
	return isolationRoots.find((root) => isInsidePath(p, root));
}

/**
 * Resolve a model-supplied path against `cwd` and enforce the jail:
 * inside → canonical path; outside-but-ordinary → user consent via
 * `ctx.approval` (if wired) else refused; session-data roots → always
 * refused. See the module docblock for the full policy.
 *
 * `root` optionally widens the allowed area: when it contains `cwd`, the
 * inside-check runs against the root while relative paths still resolve
 * against the cwd — a narrowed-cwd sub-agent can therefore climb up to its
 * task's workspace root without consent, but no further. A root that does
 * not contain the cwd is ignored (it can only widen, never relocate).
 */
export async function resolveJailedPath(rawPath: string, cwd: string, ctx?: JailContext, root?: string): Promise<string> {
	const jail = root && root !== cwd && isInsidePath(cwd, root) ? root : cwd;
	const abs = resolveToCwd(rawPath, cwd);
	const jailReal = await canonicalJail(jail);

	// Lexically inside: canonicalize and check the symlink didn't tunnel out.
	if (isInsidePath(abs, jail)) {
		const canonical = await canonicalize(abs);
		if (isInsidePath(canonical, jailReal)) return canonical;
		return outsidePolicy(canonical, jail, ctx);
	}
	return outsidePolicy(await canonicalize(abs), jail, ctx);
}

async function outsidePolicy(candidate: string, cwd: string, ctx?: JailContext): Promise<string> {
	const root = isolationRootFor(candidate);
	if (root) {
		throw new PathJailError(
			candidate,
			cwd,
			`'${candidate}' is session data (${root}) — isolated from all agents; the filesystem is not a cross-session channel. This path is never accessible, with or without consent.`,
		);
	}
	if (ctx?.approval) {
		const approved = await ctx.approval({ toolCallId: ctx.toolCallId, tool: ctx.tool, path: candidate, jail: cwd, signal: ctx.signal });
		if (approved) return candidate;
		throw new PathJailError(candidate, cwd, `The user declined access to '${candidate}'. Work inside your workspace (${cwd}) or ask again with a clear reason.`);
	}
	throw new PathJailError(candidate, cwd);
}

// --- bash screen -------------------------------------------------------------

/** Every textual form a denied root can appear in: absolute, `~`, `$HOME`, `${HOME}`. */
function denyVariants(root: string): string[] {
	const variants = new Set<string>([root]);
	const home = homedir();
	if (root.startsWith(home)) {
		const suffix = root.slice(home.length);
		variants.add("~" + suffix);
		variants.add("$HOME" + suffix);
		variants.add("${HOME}" + suffix);
	}
	return [...variants];
}

/**
 * Marker substituted for the agent's own cwd before screening, so a worktree
 * living under a session-data root stays referenceable — and so climbing out
 * of the workspace (`<cwd>/../../…`) is detectable as marker-relative traversal.
 */
const WORKSPACE_MARKER = "/clownfish-workspace";

/**
 * Best-effort screen of a bash command. Returns an Error to refuse with, or
 * null when the command may run. See the module docblock for the limits.
 */
export function screenBashCommand(command: string, cwd: string): Error | null {
	if (isolationRoots.length === 0) return null;

	// Mask the agent's own workspace subtree (lexical + canonical), longest
	// first, so references to it are not misread as deny-root references.
	let text = command;
	const mask = new Set<string>([cwd]);
	const canonical = safeRealpath(cwd);
	if (canonical) mask.add(canonical);
	for (const m of [...mask].sort((a, b) => b.length - a.length)) {
		if (m) text = text.split(m).join(WORKSPACE_MARKER);
	}

	if (/\/clownfish-workspace(?:\/\.\.)+(?:\/|$)/.test(text) || /(^|[\s="'`$(&|;])\.\.(\/|$|[\s"'`)&|;])/.test(text)) {
		return new Error(
			`bash refused: the command climbs out of your workspace via '..' (workspace: ${cwd}). ` +
				`Paths outside your workspace are isolated session data — the filesystem is not a cross-session channel. ` +
				`Reference files via paths inside your workspace (relative to its root, or absolute paths under it) instead of '..'.`,
		);
	}

	for (const root of isolationRoots) {
		for (const variant of denyVariants(root)) {
			if (text.includes(variant)) {
				return new Error(
					`bash refused: the command references '${variant}', which is session data outside your workspace. ` +
						`Session state (transcripts, settings, memory) is isolated — the filesystem is not a cross-session channel. Work inside your workspace instead.`,
				);
			}
		}
	}
	return null;
}

function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}
