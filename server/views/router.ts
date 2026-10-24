/**
 * Tiny hash router. The app is a single page (left tree + right chat); the hash
 * only encodes the *selection* so it's deep-linkable and the back button works.
 *
 *   #/                                          → nothing selected
 *   #/projects/:pid                             → project selected
 *   #/projects/:pid/sessions/:sid               → session selected (chat shown)
 *   #/settings[/<tab>]                          → settings (project / agents / skills / plugins / tools / mcp / memory / keys)
 *   #/memory                                    → the memory page (global, not per chat)
 *   #/admin                                     → alias of #/settings (the two pages were merged)
 */
export interface Selection {
	projectId?: string;
	sessionId?: string;
	/** True on #/settings — rendered inside the workspace like memory. */
	settings?: boolean;
	/** Which settings tab #/settings/<tab> asked for. */
	settingsTab?: "project" | "agents" | "other-agents" | "skills" | "plugins" | "tools" | "mcp" | "memory" | "keys";
	/** True on #/memory — the app-level memory management page. */
	memory?: boolean;
}

const SETTINGS_TABS = new Set(["project", "agents", "other-agents", "skills", "plugins", "tools", "mcp", "memory", "keys"]);

export function parseHash(): Selection {
	const raw = location.hash.replace(/^#\/?/, "");
	const parts = raw.split("/").filter(Boolean);
	if (parts[0] === "settings" || parts[0] === "admin") {
		// Legacy tab ids from earlier layouts land somewhere sensible rather
		// than 404-ing the whole page.
		const legacy: Record<string, string> = { keys: "keys", global: "keys", assets: "agents", cli: "other-agents" };
		const t = parts[1];
		const tab = SETTINGS_TABS.has(t) ? t : legacy[t];
		return { settings: true, settingsTab: tab as Selection["settingsTab"] };
	}
	if (parts[0] === "memory") return { memory: true };
	if (parts[0] === "projects" && parts[1] && parts[2] === "sessions" && parts[3]) {
		return { projectId: parts[1], sessionId: parts[3] };
	}
	if (parts[0] === "projects" && parts[1]) {
		return { projectId: parts[1] };
	}
	return {};
}

/** Navigate by setting the hash (triggers `hashchange`). */
export function navigate(hash: string): void {
	location.hash = hash;
}
