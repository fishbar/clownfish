/**
 * /api/memory — the user-facing memory endpoints.
 *
 *   GET    /api/memory        → every memory, grouped by scope + category
 *   DELETE /api/memory/:id    → forget one entry
 *
 * Memory is written by the AGENT (the `memory` tool and end-of-session
 * reflection), so these endpoints are the human's side of that: read what was
 * written, drop what you disagree with. The store lives under
 * `<dataDir>/memory/` (see agent/memory.ts); this router only goes through it.
 */
import { Router } from "express";
import type { ServerContext } from "../context";
import { MemoryStore, memoryRoot } from "../../agent/memory";

/** `- [id] content (stamp)` → a row. Lines without an id are shown as-is. */
function parseEntries(body: string): Array<{ id: string; content: string; at: string }> {
	const out: Array<{ id: string; content: string; at: string }> = [];
	for (const line of body.split("\n")) {
		const m = /^- \[([^\]]+)\]\s+([\s\S]*?)\s*\(([\d-]{10} [\d:]{8})\)\s*$/.exec(line.trim());
		if (m) out.push({ id: m[1], content: m[2], at: m[3] });
		else if (line.trim().startsWith("- ")) out.push({ id: "", content: line.trim().slice(2), at: "" });
	}
	return out;
}

export function createMemoryRouter(ctx: ServerContext): Router {
	const router = Router();
	const store = new MemoryStore(memoryRoot(ctx.config.dataDir));



	router.get("/", async (_req, res) => {
		const blocks = await store.readAll();
		res.json({
			blocks: blocks.map((b) => ({ ...b, entries: parseEntries(b.body) })),
		});
	});

	router.delete("/:id", async (req, res) => {
		const id = String(req.params.id);
		const gone = await store.forget(id);
		if (!gone) {
			res.status(404).json({ error: `no memory with id ${id}` });
			return;
		}
		await store.appendRunRecord({ ts: Date.now(), id, op: "forget", by: "memory-tool" }).catch(() => undefined);
		res.status(204).end();
	});

	return router;
}
