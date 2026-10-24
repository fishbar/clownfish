/**
 * Server configuration (env-driven).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpawnMode } from "../agent/manager";

export interface ServerConfig {
	/** Root data directory (projects registry + session metadata). */
	dataDir: string;
	/** Directory holding one transcript JSONL per session (default ~/.clownfish/sessions). */
	sessionsDir: string;
	/** HTTP/WS listen port. */
	port: number;
	/**
	 * Listen address (default 127.0.0.1 — the tool has filesystem + paid-API
	 * access, so it must not silently expose itself to the LAN). Set
	 * CLOWNFISH_BIND=0.0.0.0 (or a specific interface) to share deliberately.
	 */
	bind: string;
	/** Default provider/model for new projects. */
	provider: string;
	model: string;
	/** Unix-domain socket the agent workers connect over. */
	agentSocketPath: string;
	/** Idle agent worker lifetime in ms before graceful shutdown (0 = never reap). */
	agentIdleTtlMs: number;
	/**
	 * How session agents run: "share" = in-process (saves resources, no crash
	 * isolation), "process" = forked worker per session (default), "sandbox" =
	 * isolated container service (not yet implemented).
	 */
	agentSpawnMode: AgentSpawnMode;
	/** Serve over HTTPS (the browser WS hub auto-becomes wss://). */
	tls: boolean;
	/** Explicit cert path; when tls is on and this is unset, a cert is auto-generated + cached. */
	tlsCert?: string;
	/** Explicit private-key path (paired with tlsCert). */
	tlsKey?: string;
	/** Subject CN / DNS SAN for the auto-generated cert (default: os hostname). */
	tlsHost?: string;
}

/** Interpret a CLOWNFISH_* env toggle (1 / true / yes → on). */
function flag(env: NodeJS.ProcessEnv, key: string): boolean {
	const v = env[key];
	return v === "1" || v === "true" || v === "TRUE" || v === "yes";
}

/** Read the agent spawn mode (default "process"; unknown values fall back with a warning). */
function spawnMode(env: NodeJS.ProcessEnv): AgentSpawnMode {
	const v = env.CLOWNFISH_AGENT_SPAWN_MODE;
	if (v === "share" || v === "process" || v === "sandbox") return v;
	if (v) console.warn(`[clownfish] unknown CLOWNFISH_AGENT_SPAWN_MODE="${v}" — using "process"`);
	return "process";
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const dataDir = env.CLOWNFISH_DATA_DIR ?? join(homedir(), ".clownfish");
	return {
		dataDir,
		sessionsDir: env.CLOWNFISH_SESSIONS_DIR ?? join(dataDir, "sessions"),
		port: Number(env.CLOWNFISH_PORT ?? 4317),
		bind: env.CLOWNFISH_BIND ?? "127.0.0.1",
		provider: env.CLOWNFISH_PROVIDER ?? "anthropic",
		model: env.CLOWNFISH_MODEL ?? "claude-sonnet-4-6",
		agentSocketPath: env.CLOWNFISH_AGENT_SOCKET ?? join(dataDir, "agent.sock"),
		// 10 minutes; operators pin long-running agents via the manager API.
		agentIdleTtlMs: env.CLOWNFISH_AGENT_IDLE_TTL ? Number(env.CLOWNFISH_AGENT_IDLE_TTL) : 10 * 60 * 1000,
		agentSpawnMode: spawnMode(env),
		tls: flag(env, "CLOWNFISH_TLS") || flag(env, "CLOWNFISH_HTTPS"),
		tlsCert: env.CLOWNFISH_TLS_CERT,
		tlsKey: env.CLOWNFISH_TLS_KEY,
		tlsHost: env.CLOWNFISH_TLS_HOST,
	};
}
