/**
 * Client-side keymap: resolve the operator's bindings once, match keydown events
 * against them, and render them for display.
 *
 * The table itself lives on the server (`/api/keybindings`) so it follows the
 * operator between browsers; this module is the consumer. `Mod` is ⌘ on macOS and
 * Ctrl elsewhere, which is decided here rather than in the stored table.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { DEFAULT_KEYBINDINGS, type KeyAction, type KeybindingInfo } from "../protocol";
import { api } from "./api";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Human rendering of a binding for the UI (⌘⇧K on mac, Ctrl+Shift+K elsewhere). */
export function renderBinding(keys: string): string {
	const parts = keys.split("+");
	const key = parts[parts.length - 1];
	const mods = parts.slice(0, -1).map((m) => {
		if (m === "Mod") return IS_MAC ? "⌘" : "Ctrl";
		if (m === "Shift") return IS_MAC ? "⇧" : "Shift";
		if (m === "Alt") return IS_MAC ? "⌥" : "Alt";
		if (m === "Meta") return IS_MAC ? "⌘" : "Meta";
		return m;
	});
	const pretty = key === "ArrowUp" ? "↑" : key === "ArrowDown" ? "↓" : key === "ArrowLeft" ? "←" : key === "ArrowRight" ? "→" : key;
	return IS_MAC ? [...mods, pretty].join("") : [...mods, pretty].join("+");
}

/** Turn a live keydown into the canonical binding string it represents. */
export function bindingFromEvent(e: KeyboardEvent): string | null {
	const key = e.key;
	if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null; // modifier alone
	const mods: string[] = [];
	// Cmd on mac / Ctrl elsewhere collapses to Mod; the *other* one stays literal,
	// so a Ctrl binding is still expressible on a Mac.
	if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push("Mod");
	if (IS_MAC ? e.ctrlKey : e.metaKey) mods.push(IS_MAC ? "Ctrl" : "Meta");
	if (e.altKey) mods.push("Alt");
	if (e.shiftKey) mods.push("Shift");
	const canonical = key === " " ? "Space" : [...key].length === 1 ? key.toUpperCase() : key;
	const order = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];
	return [...order.filter((m) => mods.includes(m)), canonical].join("+");
}

export type Keymap = Record<KeyAction, string>;

const FALLBACK: Keymap = { ...DEFAULT_KEYBINDINGS };

/**
 * Load the operator's bindings. Falls back to the built-in table when the request
 * fails — the UI must stay usable if the settings file is unreadable.
 */
export function useKeymap(): Keymap {
	const [map, setMap] = useState<Keymap>(FALLBACK);
	useEffect(() => {
		let live = true;
		void api
			.listKeybindings()
			.then((rows: KeybindingInfo[]) => {
				if (!live) return;
				const next = { ...FALLBACK };
				for (const r of rows) next[r.action] = r.keys;
				setMap(next);
			})
			.catch(() => undefined);
		const onChanged = (): void => {
			void api
				.listKeybindings()
				.then((rows: KeybindingInfo[]) => {
					const next = { ...FALLBACK };
					for (const r of rows) next[r.action] = r.keys;
					setMap(next);
				})
				.catch(() => undefined);
		};
		// The settings page fires this after a rebind so open chat tabs pick it up
		// without a reload.
		window.addEventListener("clownfish:keybindings", onChanged);
		return () => {
			live = false;
			window.removeEventListener("clownfish:keybindings", onChanged);
		};
	}, []);
	return map;
}

/**
 * Bind window-level shortcuts. Handlers are looked up through a ref so a changing
 * handler identity doesn't detach and re-attach the listener on every render.
 */
export function useGlobalKeys(map: Keymap, handlers: Partial<Record<KeyAction, () => void>>): void {
	const ref = useRef(handlers);
	ref.current = handlers;
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			const pressed = bindingFromEvent(e);
			if (!pressed) return;
			for (const [action, handler] of Object.entries(ref.current)) {
				if (!handler || map[action as KeyAction] !== pressed) continue;
				e.preventDefault();
				handler();
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [map]);
}
