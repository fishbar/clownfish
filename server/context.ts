/**
 * Shared server singletons wired once at bootstrap and passed to routes/hub.
 */
import type { ServerConfig } from "./config";
import type { ProjectManager } from "./models/projects";
import type { SessionStore } from "./models/sessions";
import type { AgentManager } from "../agent";
import type { AuthConfig } from "./auth";
import type { Scheduler } from "./scheduler";

export interface ServerContext {
	config: ServerConfig;
	projects: ProjectManager;
	sessions: SessionStore;
	agents: AgentManager;
	/** Null when auth is disabled (open). Used by the WS hub's verifyClient. */
	auth: AuthConfig | null;
	/** Cron scheduler (session jobs + internal nightly tasks). */
	scheduler: Scheduler;
}

export function mkContext(
	config: ServerConfig,
	projects: ProjectManager,
	sessions: SessionStore,
	agents: AgentManager,
	auth: AuthConfig | null,
	scheduler: Scheduler,
): ServerContext {
	return { config, projects, sessions, agents, auth, scheduler };
}
