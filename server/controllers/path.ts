/**
 * REST: /api/path — filesystem path autocomplete for the project-creation form.
 *
 * `GET /complete?prefix=<p>` returns the directories under the parent of `p`
 * whose final segment starts with what the user has typed (prefix match), so the
 * UI can offer a dropdown instead of forcing the user to type a full path. This
 * is an operator-only, local-filesystem helper (the agent's bash tool already
 * has full FS access), so there is no root restriction — only hidden entries are
 * hidden and the result is capped.
 */
import { Router } from "express";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { expandTilde } from "../../agent/paths";
import type { PathSuggestion } from "../protocol";

const MAX_SUGGESTIONS = 50;

export function createPathRouter(): Router {
	const router = Router();

	router.get("/complete", async (req, res) => {
		const raw = typeof req.query.prefix === "string" ? req.query.prefix : "";
		const trimmed = raw.trim();

		// Empty input → start at $HOME. Non-absolute input resolves against $HOME.
		const expanded = expandTilde(trimmed || "~");
		const abs = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(homedir(), expanded);

		// A trailing slash (or empty / bare "~") means "list everything inside".
		const listAll = trimmed === "" || trimmed === "~" || trimmed.endsWith("/");
		const dir = listAll ? abs : dirname(abs);
		const base = listAll ? "" : basename(abs);

		let names: string[] = [];
		try {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue; // a project path is a directory
				if (entry.name.startsWith(".")) continue; // skip hidden
				if (!entry.name.startsWith(base)) continue;
				names.push(entry.name);
			}
		} catch {
			// Parent missing / not readable → nothing to offer yet; keep typing.
			return res.json({ suggestions: [] as PathSuggestion[] });
		}

		names.sort((a, b) => a.localeCompare(b));
		const suggestions: PathSuggestion[] = names.slice(0, MAX_SUGGESTIONS).map((name) => ({
			// Trailing slash so the next keystroke descends into the chosen dir.
			path: `${join(dir, name)}/`,
			name,
		}));
		res.json({ suggestions });
	});

	return router;
}
