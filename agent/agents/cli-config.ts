/**
 * External CLI sub-agent configuration — the settings-owned source of truth
 * for every agent `run_agent` can delegate to an external CLI (Codex, Claude
 * Code, anything). Stored at `<dataDir>/cli-agents.json`, edited from the
 * settings page's Agent tab, merged into the discovered agent set at load
 * time (see `loadCliAgentDefinitions`).
 *
 * One entry = the COMPLETE process launch: the executable path and the whole
 * argv. Nothing is secretly prepended — the shipped defaults below ARE the
 * recommended configs, and the settings form shows them as its example.
 * Runtime values arrive through placeholders:
 *   {session-id}   a generated UUID — makes the CLI's session log path
 *                  predictable (claude keys its project dir on cwd + this id)
 *   {workdir}      the delegation's jailed working directory
 *   {model}        the effective model id; when unset, the placeholder AND
 *                  the argv slot immediately before it (its flag) are dropped
 *   {result-file}  a temp file the CLI can write its final message to
 *                  (codex `--output-last-message`); also always fed on stdin
 * The prompt/task itself always goes to the child's STDIN, never argv.
 * One more placeholder: `{permission-mode}` — claude's `--permission-mode`
 * value, from CLOWNFISH_CLI_SUBAGENT_PERMISSIONS (default bypassPermissions).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "./types";

/** Which session-log format to tail for live progress. "none" = no tailing. */
export type CliLogFormat = "claude" | "codex" | "none";

/** One configured external CLI agent. */
export interface CliAgentConfig {
	name: string;
	description?: string;
	/** Session-log format to tail ("none" for a custom tool with no known log). */
	log: CliLogFormat;
	/** Executable: absolute path or a name resolved against PATH. */
	command: string;
	/** Complete argv, with `{placeholder}` substitution (see file header). */
	args: string[];
	/** Extra env layered over the cliChildEnv allowlist (never credentials). */
	env?: Record<string, string>;
	/** Operating instructions handed to the CLI (the `.md` body equivalent). */
	instructions?: string;
	/** Pinned model id, passed as `{model}`. */
	model?: string;
	/** Advisory access: "R" is best-effort (the CLI cannot be forced read-only). */
	access?: "R" | "RW";
}

/** Gating env: model-initiated external CLIs are a bigger blast radius than
 *  operator-driven terminal sessions, so they get their own opt-in. */
export function cliSubagentsEnabled(): boolean {
	return process.env.CLOWNFISH_CLI_SUBAGENTS === "1";
}

/** claude's default `--permission-mode` for headless sub-agents (headless -p
 *  cannot answer interactive prompts). Overridable per deployment. */
export function claudePermissionMode(): string {
	return process.env.CLOWNFISH_CLI_SUBAGENT_PERMISSIONS?.trim() || "bypassPermissions";
}

/** The file backing the store: `<dataDir>/cli-agents.json`. */
export function cliAgentsPath(dataDir: string): string {
	return join(dataDir, "cli-agents.json");
}

/** Agent name validation — same shape the rest of the asset surfaces use. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/**
 * The shipped recommended configs. They are editable defaults, not code: the
 * first save of any entry materializes a `cli-agents.json` that stands on its
 * own, and an operator can delete or shadow them like any other entry.
 */
export const DEFAULT_CLI_AGENTS: CliAgentConfig[] = [
	{
		name: "claude-code",
		description: "外部 Claude Code CLI（headless，自带登录与模型）",
		log: "claude",
		command: "claude",
		args: [
			"-p",
			"--output-format",
			"json",
			"--verbose",
			"--session-id",
			"{session-id}",
			"--permission-mode",
			"{permission-mode}",
			"--model",
			"{model}",
		],
	},
	{
		name: "codex",
		description: "外部 Codex CLI（headless，自带登录与模型）",
		log: "codex",
		command: "codex",
		args: ["exec", "--json", "--output-last-message", "{result-file}", "--skip-git-repo-check", "--model", "{model}"],
	},
];

/** Default operating instructions when an entry carries none of its own. */
export const DEFAULT_CLI_INSTRUCTIONS =
	"You are running as a delegated sub-agent inside another agent's workspace. " +
	"Work only within the current directory. Complete the task independently, then end with " +
	"a concise report of what you did, what you verified, and anything that failed — your final " +
	"message is returned verbatim to the coordinating agent, which cannot answer questions.";

/** Raw file shape: `{ agents: [...] }` with optional tombstones for defaults. */
interface CliAgentsFile {
	agents: Array<Partial<CliAgentConfig> & { name: string; deleted?: boolean }>;
}

/** Parse + validate one entry; returns undefined when it is not usable. */
function normalizeEntry(raw: Partial<CliAgentConfig> & { name: string }): CliAgentConfig | undefined {
	if (!NAME_RE.test(raw.name)) return undefined;
	const log: CliLogFormat = raw.log === "claude" || raw.log === "codex" || raw.log === "none" ? raw.log : "none";
	const command = typeof raw.command === "string" ? raw.command.trim() : "";
	if (!command) return undefined;
	const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
	const env =
		raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
			? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === "string"))
			: undefined;
	return {
		name: raw.name,
		description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined,
		log,
		command,
		args,
		env: env && Object.keys(env).length ? env : undefined,
		instructions: typeof raw.instructions === "string" && raw.instructions.trim() ? raw.instructions : undefined,
		model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
		access: raw.access === "R" ? "R" : "RW",
	};
}

/** Read the raw file (empty list when missing/malformed — never throws). */
async function readFileEntries(dataDir: string): Promise<CliAgentsFile["agents"]> {
	const raw = await readFile(cliAgentsPath(dataDir), "utf8").catch(() => null);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as Partial<CliAgentsFile>;
		if (!parsed || !Array.isArray(parsed.agents)) return [];
		return parsed.agents.filter((e): e is Partial<CliAgentConfig> & { name: string } => !!e && typeof e.name === "string");
	} catch {
		return []; // malformed store — fall back to defaults rather than failing boot
	}
}

/** Atomic write of the whole store (tmp + rename, same as the oauth store). */
async function writeFileEntries(dataDir: string, entries: CliAgentsFile["agents"]): Promise<void> {
	const tmp = `${cliAgentsPath(dataDir)}.tmp`;
	await writeFile(tmp, `${JSON.stringify({ agents: entries }, null, 2)}\n`, "utf8");
	await rename(tmp, cliAgentsPath(dataDir));
}

/**
 * The effective config list: shipped defaults overlaid by the file (same name
 * = full replacement), minus tombstoned defaults. Pure read — used by the
 * runtime loader and the settings REST surface alike.
 */
export async function listCliAgents(dataDir: string): Promise<CliAgentConfig[]> {
	const fileEntries = await readFileEntries(dataDir);
	const byName = new Map<string, CliAgentConfig | "deleted">();
	for (const def of DEFAULT_CLI_AGENTS) byName.set(def.name, def);
	for (const raw of fileEntries) {
		// A tombstone removes a shipped default by name (everything else must
		// still parse, so a half-edited entry can't silently nuke a default).
		if (raw.deleted === true && !raw.command) {
			byName.set(raw.name, "deleted");
			continue;
		}
		const entry = normalizeEntry(raw);
		if (entry) byName.set(raw.name, entry);
	}
	return [...byName.values()].filter((e): e is CliAgentConfig => e !== "deleted");
}

/** Upsert one entry (validated) into the store. Returns the stored entry. */
export async function saveCliAgent(dataDir: string, raw: Partial<CliAgentConfig> & { name: string }): Promise<CliAgentConfig> {
	const entry = normalizeEntry(raw);
	if (!entry) throw new Error("invalid CLI agent entry: needs a valid name, a non-empty command, and a known log format");
	const entries = await readFileEntries(dataDir);
	const i = entries.findIndex((e) => e.name === entry.name);
	if (i >= 0) entries[i] = entry;
	else entries.push(entry);
	await writeFileEntries(dataDir, entries);
	return entry;
}

/** Remove an entry; a shipped default becomes a tombstone so it stays gone. */
export async function deleteCliAgent(dataDir: string, name: string): Promise<boolean> {
	const entries = await readFileEntries(dataDir);
	const i = entries.findIndex((e) => e.name === name);
	if (i < 0) return false;
	entries.splice(i, 1);
	if (DEFAULT_CLI_AGENTS.some((d) => d.name === name)) entries.push({ name, deleted: true });
	await writeFileEntries(dataDir, entries);
	return true;
}

/** Resolve a command against PATH (sync, load-time only). Null when absent. */
export function lookupCommand(command: string): string | null {
	if (command.includes("/")) {
		try {
			accessSync(command, constants.X_OK);
			return command;
		} catch {
			return null;
		}
	}
	const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of dirs) {
		const p = join(dir, command);
		try {
			accessSync(p, constants.X_OK);
			return p;
		} catch {
			/* keep scanning */
		}
	}
	return null;
}

/**
 * The agent-set contribution: configured CLI agents as {@link AgentDefinition}s,
 * gated and availability-filtered. Unavailable entries are DROPPED (with the
 * reason returned alongside) — a `type` the model can see but never run just
 * produces a confusing refusal.
 */
export async function loadCliAgentDefinitions(
	dataDir: string,
): Promise<{ defs: AgentDefinition[]; notes: string[] }> {
	const notes: string[] = [];
	if (!cliSubagentsEnabled()) return { defs: [], notes: ["cli sub-agents disabled (set CLOWNFISH_CLI_SUBAGENTS=1 to enable)"] };
	const defs: AgentDefinition[] = [];
	for (const cfg of await listCliAgents(dataDir)) {
		const resolved = lookupCommand(cfg.command);
		if (!resolved) {
			notes.push(`cli agent '${cfg.name}' unavailable: command '${cfg.command}' not found on PATH`);
			continue;
		}
		defs.push({
			name: cfg.name,
			description: cfg.description,
			access: cfg.access,
			model: cfg.model,
			body: cfg.instructions?.trim() || DEFAULT_CLI_INSTRUCTIONS,
			path: cliAgentsPath(dataDir),
			source: "cli-config",
			cli: {
				log: cfg.log,
				command: resolved,
				args: cfg.args,
				env: cfg.env,
			},
		});
	}
	return { defs, notes };
}
