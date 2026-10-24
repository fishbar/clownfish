/**
 * /api/cli-agents — the settings page's external-CLI-agent surface, backed by
 * `<dataDir>/cli-agents.json` (agent/agents/cli-config.ts). Every write
 * hot-reloads live workers, so a saved config is picked up by the next
 * run_agent call without a worker restart.
 *
 *   GET    /                     → { agents, defaults, enabled }  (defaults =
 *                                  the shipped recommended configs, shown in
 *                                  the form as its example)
 *   PUT    /:name                → upsert one entry (validated in cli-config)
 *   DELETE /:name                → remove it (a shipped default is tombstoned)
 */
import { Router, type Request, type Response } from "express";
import type { ServerContext } from "../context";
import {
	DEFAULT_CLI_AGENTS,
	deleteCliAgent,
	listCliAgents,
	lookupCommand,
	saveCliAgent,
	cliSubagentsEnabled,
	type CliAgentConfig,
} from "../../agent/agents/cli-config";

export function createCliAgentsRouter(ctx: ServerContext): Router {
	const router = Router({ mergeParams: true });

	const pushReload = (): void => ctx.agents.reloadAssets();

	/** One response entry: the config plus whether its binary resolves now. */
	const withAvailability = (cfg: CliAgentConfig) => ({ ...cfg, available: lookupCommand(cfg.command) !== null });

	router.get("/", async (_req, res) => {
		const agents = (await listCliAgents(ctx.config.dataDir)).map(withAvailability);
		res.json({ agents, defaults: DEFAULT_CLI_AGENTS, enabled: cliSubagentsEnabled() });
	});

	router.put("/:name", async (req, res) => {
		const name = (Array.isArray(req.params.name) ? req.params.name[0] : req.params.name) ?? "";
		const body = req.body as Partial<CliAgentConfig>;
		try {
			const saved = await saveCliAgent(ctx.config.dataDir, { ...body, name });
			pushReload();
			res.json({ ok: true, agent: withAvailability(saved) });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	router.delete("/:name", async (req, res) => {
		const name = (Array.isArray(req.params.name) ? req.params.name[0] : req.params.name) ?? "";
		const removed = await deleteCliAgent(ctx.config.dataDir, name);
		if (!removed) return void res.status(404).json({ error: `no CLI agent named '${name}'` });
		pushReload();
		res.json({ ok: true });
	});

	return router;
}
