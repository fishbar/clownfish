/**
 * Operator REST: keyboard shortcuts.
 *
 *   GET    /api/keybindings          → every action, its effective + default keys
 *   PUT    /api/keybindings/:action  → {keys} rebind
 *   DELETE /api/keybindings/:action  → reset one action to its default
 *   DELETE /api/keybindings          → reset every rebinding
 *
 * Same copy-on-write idea as agent and tool prompts, one file smaller: only the
 * *deviations* live on disk (`<dataDir>/keybindings.json`), the defaults stay in
 * code (`DEFAULT_KEYBINDINGS` in the shared protocol, so the UI resolves the
 * exact same table the server validates against). Deleting the entry is the reset.
 *
 * Bindings are per install, not per browser: the point is that the operator's
 * muscle memory follows them to whichever machine opens the UI.
 */
import { Router } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerContext } from "../context";
import { DEFAULT_KEYBINDINGS, KEY_ACTIONS, KEY_ACTION_LABELS, type KeyAction, type KeybindingInfo } from "../protocol";

const FILE = "keybindings.json";

/** Modifier segments a binding may carry, in canonical order. */
const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];
/** Named (non-character) keys we accept; anything else must be a single character. */
const NAMED_KEYS = new Set([
	"Enter",
	"Tab",
	"Escape",
	"Backspace",
	"Delete",
	"Space",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

function isKeyAction(v: string): v is KeyAction {
	return (KEY_ACTIONS as readonly string[]).includes(v);
}

/**
 * Validate and canonicalize a binding string. Returns null when it isn't one —
 * a malformed binding would silently disable the action, so it is rejected at
 * the door rather than stored.
 */
export function normalizeBinding(raw: string): string | null {
	const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0 || parts.length > 5) return null;
	const key = parts[parts.length - 1];
	const mods = parts.slice(0, -1);
	const seen = new Set<string>();
	for (const m of mods) {
		const canonical = MODIFIERS.find((x) => x.toLowerCase() === m.toLowerCase());
		if (!canonical || seen.has(canonical)) return null;
		seen.add(canonical);
	}
	const named = [...NAMED_KEYS].find((k) => k.toLowerCase() === key.toLowerCase());
	// Single characters are upper-cased so "mod+k" and "Mod+K" are one binding.
	const canonicalKey = named ?? ([...key].length === 1 ? key.toUpperCase() : null);
	if (!canonicalKey) return null;
	return [...MODIFIERS.filter((m) => seen.has(m)), canonicalKey].join("+");
}

async function readOverrides(dataDir: string): Promise<Partial<Record<KeyAction, string>>> {
	const raw = await readFile(join(dataDir, FILE), "utf8").catch(() => null);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Partial<Record<KeyAction, string>> = {};
		for (const [action, keys] of Object.entries(parsed)) {
			if (!isKeyAction(action) || typeof keys !== "string") continue;
			const normalized = normalizeBinding(keys);
			// Drop a binding that no longer normalizes rather than serving garbage.
			if (normalized) out[action] = normalized;
		}
		return out;
	} catch {
		return {};
	}
}

async function writeOverrides(dataDir: string, overrides: Partial<Record<KeyAction, string>>): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, FILE), `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}

/** The effective table, with conflicts computed so the UI can flag them. */
export function resolveKeybindings(overrides: Partial<Record<KeyAction, string>>): KeybindingInfo[] {
	const effective = KEY_ACTIONS.map((action) => ({
		action,
		keys: overrides[action] ?? DEFAULT_KEYBINDINGS[action],
		defaultKeys: DEFAULT_KEYBINDINGS[action],
		label: KEY_ACTION_LABELS[action],
		overridden: overrides[action] !== undefined && overrides[action] !== DEFAULT_KEYBINDINGS[action],
	}));
	return effective.map((row) => {
		const clashes = effective.filter((o) => o.action !== row.action && o.keys === row.keys).map((o) => o.action);
		// send/newline share Enter by design (one carries Shift) — only exact
		// duplicates land here, so anything listed is genuinely ambiguous.
		return clashes.length > 0 ? { ...row, conflictsWith: clashes } : row;
	});
}

export function createKeybindingsRouter(ctx: ServerContext): Router {
	const router = Router();

	router.get("/", async (_req, res) => {
		res.json(resolveKeybindings(await readOverrides(ctx.config.dataDir)));
	});

	router.put("/:action", async (req, res) => {
		const action = req.params.action;
		if (!isKeyAction(action)) return res.status(404).json({ error: "unknown action" });
		const body = (req.body ?? {}) as { keys?: unknown };
		if (typeof body.keys !== "string") return res.status(400).json({ error: "keys required" });
		const keys = normalizeBinding(body.keys);
		if (!keys) return res.status(400).json({ error: `not a valid binding: ${body.keys}` });
		const overrides = await readOverrides(ctx.config.dataDir);
		overrides[action] = keys;
		await writeOverrides(ctx.config.dataDir, overrides);
		res.json({ action, keys, bindings: resolveKeybindings(overrides) });
	});

	router.delete("/:action", async (req, res) => {
		const action = req.params.action;
		if (!isKeyAction(action)) return res.status(404).json({ error: "unknown action" });
		const overrides = await readOverrides(ctx.config.dataDir);
		if (overrides[action] === undefined) return res.status(404).json({ error: "no override to reset" });
		delete overrides[action];
		await writeOverrides(ctx.config.dataDir, overrides);
		res.json({ action, keys: DEFAULT_KEYBINDINGS[action], bindings: resolveKeybindings(overrides) });
	});

	router.delete("/", async (_req, res) => {
		await writeOverrides(ctx.config.dataDir, {});
		res.json(resolveKeybindings({}));
	});

	return router;
}
