/**
 * Asset registry — the enable/disable state for the admin panel.
 *
 * One JSON file per dataDir (`<dataDir>/registry.json`) holding the names of
 * DISABLED assets, read at worker boot and by the inventory API. File-backed
 * assets (agents/skills) live on disk regardless; disabling only removes them
 * from the session's active set, so re-enabling is lossless. Changes take
 * effect on the next worker boot — the inventory controller stops a project's
 * idle workers after a write so the common case applies immediately.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RegistryKind = "agents" | "skills" | "tools" | "plugins";

export const REGISTRY_KINDS: RegistryKind[] = ["agents", "skills", "tools", "plugins"];

export interface RegistryState {
	disabled: Record<RegistryKind, string[]>;
}

const EMPTY: RegistryState = { disabled: { agents: [], skills: [], tools: [], plugins: [] } };

function registryPath(dataDir: string): string {
	return join(dataDir, "registry.json");
}

/** Load the registry; a missing/corrupt file yields the empty state (all enabled). */
export async function loadRegistry(dataDir: string): Promise<RegistryState> {
	const raw = await readFile(registryPath(dataDir), "utf8").catch(() => null);
	if (!raw) return { disabled: { agents: [], skills: [], tools: [], plugins: [] } };
	try {
		const parsed = JSON.parse(raw) as Partial<RegistryState>;
		const disabled = { ...EMPTY.disabled };
		for (const kind of REGISTRY_KINDS) {
			const list = parsed.disabled?.[kind];
			if (Array.isArray(list)) disabled[kind] = list.filter((x): x is string => typeof x === "string");
		}
		return { disabled };
	} catch {
		return { disabled: { agents: [], skills: [], tools: [], plugins: [] } };
	}
}

export async function saveRegistry(dataDir: string, state: RegistryState): Promise<void> {
	await writeFile(registryPath(dataDir), JSON.stringify(state, null, "\t") + "\n", "utf8");
}

/** Flip one asset's enabled flag; persists and returns the new state. */
export async function setRegistryEnabled(dataDir: string, kind: RegistryKind, name: string, enabled: boolean): Promise<RegistryState> {
	const state = await loadRegistry(dataDir);
	const set = new Set(state.disabled[kind]);
	if (enabled) set.delete(name);
	else set.add(name);
	state.disabled[kind] = [...set].sort();
	await saveRegistry(dataDir, state);
	return state;
}

/** Convenience: the disabled-name set for one kind (for boot-time filtering). */
export function disabledSet(state: RegistryState, kind: RegistryKind): Set<string> {
	return new Set(state.disabled[kind]);
}
