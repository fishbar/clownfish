/**
 * MCP (Model Context Protocol) integration — external tool sources.
 *
 * Server config (Claude-Code-compatible shape) is merged low→high from
 *   <dataDir>/mcp.json                       global
 *   <plugin>/.mcp.json | <plugin>/mcp.json   every discovered plugin
 *   <cwd>/.mcp.json                          project — HONORED ONLY after an
 *                                            explicit trust opt-in
 *                                            (CLOWNFISH_MCP_PROJECT=1), because
 *                                            it spawns that file's commands at
 *                                            boot and the project tree is
 *                                            agent-writable.
 * with entries like:
 *   { "mcpServers": {
 *       "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },
 *       "remote": { "url": "https://mcp.example.com/mcp" } } }
 *
 * The worker connects at boot (stdio or streamable-HTTP), lists each server's
 * tools, and wraps them as ToolDefinitions named `mcp__<server>__<tool>` with
 * mode "W" — unknown external capability, so they're excluded in plan mode and
 * gated on approval in ask mode. They flow through the regular tool machinery
 * (system-prompt index, tool cards/drawer, token usage). A failing server is
 * logged and skipped; it never breaks the agent boot.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverPlugins, type PluginBundle } from "./plugins";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./tools/definition";

export interface McpServerConfig {
	/** stdio transport: command to spawn. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** streamable-HTTP transport: server endpoint. */
	url?: string;
}

export interface McpConnections {
	tools: ToolDefinition[];
	clients: Client[];
	notes: string[];
}

async function readConfig(path: string): Promise<Record<string, McpServerConfig>> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
		return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
	} catch {
		return {};
	}
}

/** Merge global + plugin + project MCP server configs (project wins on a name clash). */
export interface McpConfigLoad {
	servers: Record<string, McpServerConfig>;
	/** Human-facing boot notes (trust decisions, skips). */
	notes: string[];
}

/**
 * Load + merge MCP server configs. The **project** file (`<cwd>/.mcp.json`) is
 * only honored after an explicit trust opt-in (`CLOWNFISH_MCP_PROJECT=1`, env
 * or settings.json `env:{}`): it executes arbitrary `command`s on worker boot,
 * and the project cwd is agent-writable — a silent auto-trust would let a
 * poisoned repo escalate just by being opened.
 *
 * Plugin configs sit between global and project and are NOT gated: a plugin is
 * something the operator installed into their own data dir, the same trust tier
 * as the global file, whereas the project file arrives with the repo.
 */
export async function loadMcpConfigs(opts: {
	dataDir: string;
	cwd: string;
	/** Pre-discovered bundles, when the caller already ran {@link discoverPlugins}. */
	plugins?: PluginBundle[];
}): Promise<McpConfigLoad> {
	const notes: string[] = [];
	const servers = await readConfig(join(opts.dataDir, "mcp.json"));
	const plugins = opts.plugins ?? (await discoverPlugins({ dataDir: opts.dataDir, cwd: opts.cwd }));
	for (const plugin of plugins) {
		if (plugin.mcpConfig) Object.assign(servers, await readConfig(plugin.mcpConfig));
	}
	const projectPath = join(opts.cwd, ".mcp.json");
	const project = await readConfig(projectPath);
	if (Object.keys(project).length > 0) {
		if (process.env.CLOWNFISH_MCP_PROJECT === "1") {
			Object.assign(servers, project);
			notes.push(`mcp: project ${projectPath} trusted (CLOWNFISH_MCP_PROJECT=1)`);
		} else {
			notes.push(
				`mcp: ignoring project ${projectPath} — set CLOWNFISH_MCP_PROJECT=1 (env or settings.json env:{}) to trust and run its server commands`,
			);
		}
	}
	return { servers, notes };
}

/**
 * Env handed to stdio MCP children: an ALLOWLIST, never the worker's full
 * process.env — that carries provider credentials (ANTHROPIC_AUTH_TOKEN /
 * *_API_KEY / tokens read from settings.json), which external commands must
 * not inherit. A server needing more can declare explicit `env` entries in
 * its mcp.json; those win over the allowlist.
 */
const MCP_ENV_ALLOWLIST = /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TERM|SHELL|USER|LOGNAME|XDG_[A-Z_]+|NODE_[A-Z_]+)$/;

function mcpChildEnv(cfgEnv?: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string" && MCP_ENV_ALLOWLIST.test(k)) out[k] = v;
	}
	return { ...out, ...(cfgEnv ?? {}) };
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: unknown;
}

function wrapTool(server: string, client: Client, tool: McpToolInfo): ToolDefinition {
	const name = `mcp__${server}__${tool.name}`;
	return defineTool({
		name,
		label: name,
		description: tool.description || `MCP tool "${tool.name}" from server "${server}"`,
		// MCP inputSchema IS JSON Schema — TypeBox-compatible for the common subset.
		parameters: tool.inputSchema as TSchema,
		mode: "W", // unknown external capability: excluded in plan, gated in ask
		prompt: { snippet: tool.description || `External tool from MCP server "${server}"` },
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<undefined>> {
			const result = await client.callTool(
				{ name: tool.name, arguments: params as Record<string, unknown> },
				undefined,
				{ signal: signal ?? undefined },
			);
			const content = (result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>).map((b) =>
				b.type === "image"
					? { type: "image" as const, data: b.data ?? "", mimeType: b.mimeType ?? "image/png" }
					: { type: "text" as const, text: b.text ?? "" },
			);
			return { content: content.length ? content : [{ type: "text", text: "(no output)" }], details: undefined };
		},
	});
}

/** Connect every configured server and wrap its tools. Failures → note, skipped. */
export async function connectMcpServers(configs: Record<string, McpServerConfig>): Promise<McpConnections> {
	const out: McpConnections = { tools: [], clients: [], notes: [] };
	for (const [server, cfg] of Object.entries(configs)) {
		try {
			const transport = cfg.url
				? new StreamableHTTPClientTransport(new URL(cfg.url))
				: cfg.command
					? new StdioClientTransport({
							command: cfg.command,
							args: cfg.args ?? [],
							// Allowlisted base + explicit cfg.env — never inherit the
							// worker's full env (provider tokens live there).
							env: mcpChildEnv(cfg.env),
						})
					: null;
			if (!transport) throw new Error('entry needs either "command" (stdio) or "url" (http)');
			const client = new Client({ name: "clownfish", version: "0.1.0" }, {});
			await client.connect(transport);
			const { tools } = await client.listTools();
			for (const t of tools) out.tools.push(wrapTool(server, client, t));
			out.clients.push(client);
			out.notes.push(`mcp '${server}': ${tools.length} tool(s)`);
		} catch (err) {
			out.notes.push(`mcp '${server}': failed — ${err instanceof Error ? err.message : String(err)} (skipped)`);
		}
	}
	return out;
}

/** Close every MCP connection (also kills stdio child processes). */
export async function closeMcpConnections(conns: McpConnections | undefined): Promise<void> {
	if (!conns) return;
	await Promise.allSettled(conns.clients.map((c) => c.close()));
	conns.clients.length = 0;
}
