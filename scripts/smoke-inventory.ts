/** Smoke: the admin panel's asset registry, inventory, CRUD + versioning.
 *
 *   A. registry roundtrip — load empty → all enabled; disable → persisted;
 *      re-enable → gone.
 *   B. buildInventory — agents/skills/tools/plugins with sources, enable flags,
 *      plugin-disable cascade, builtin-tool + MCP server rows.
 *   C. name validation — traversal/slash names rejected.
 *   D. versioned writes — vim-style timestamped backups, prune to 5, read one
 *      back, rollback (which itself backs the replaced content up).
 *   E. skill CRUD — create `<dataDir>/skills/<n>/SKILL.md`, delete removes dir.
 *   F. mcp.json validation — good JSON passes; bad JSON / shapes rejected.
 *   G. runtime wiring — a real (share-mode) worker boot with a registry that
 *      disables a plugin: the boot log announces the enabled plugin and never
 *      the disabled one (registry → discovery → skills is live end-to-end).
 *   H. hot reload — a LIVE worker re-discovers its assets when the manager
 *      broadcasts reload_assets: enabling the disabled skill raises the
 *      live skill count on the spot (no respawn).
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AgentManager } from "../agent/manager";
import { disabledSet, loadRegistry, setRegistryEnabled } from "../agent/registry";
import {
	InventoryError,
	buildInventory,
	createAgentDoc,
	createPlugin,
	createSkillDoc,
	deleteDoc,
	deletePlugin,
	listFileVersions,
	readFileVersion,
	rollbackFileVersion,
	writeDoc,
	writeMcpConfig,
} from "../server/models/inventory";
import type { Project } from "../server/protocol";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}`); };
const expectErr = async (name: string, status: number, fn: () => Promise<unknown>): Promise<void> => {
	try {
		await fn();
		check(name, false);
	} catch (e) {
		check(name, e instanceof InventoryError && e.status === status);
	}
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const work = await mkdtemp(join(tmpdir(), "clownfish-inv-"));
const dataDir = join(work, "data");
const projectDir = await mkdtemp(join(tmpdir(), "clownfish-inv-proj-"));

// Seed the fake asset tree.
await mkdir(join(dataDir, "agents"), { recursive: true });
await writeFile(join(dataDir, "agents", "keeper.md"), "---\ndescription: stays on\n---\nkeeper body");
await writeFile(join(dataDir, "agents", "shadow.md"), "---\ndescription: gets disabled\n---\nshadow body");
await mkdir(join(dataDir, "skills", "good-skill"), { recursive: true });
await writeFile(join(dataDir, "skills", "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: stays on\n---\nbody");
await mkdir(join(dataDir, "skills", "off-skill"), { recursive: true });
await writeFile(join(dataDir, "skills", "off-skill", "SKILL.md"), "---\nname: off-skill\ndescription: gets disabled\n---\nbody");
await mkdir(join(dataDir, "plugins", "on-plugin", "skills", "p1"), { recursive: true });
await writeFile(join(dataDir, "plugins", "on-plugin", "plugin.json"), JSON.stringify({ name: "on-plugin" }));
await writeFile(join(dataDir, "plugins", "on-plugin", "skills", "p1", "SKILL.md"), "---\nname: p1\ndescription: plugin skill\n---\nbody");
await mkdir(join(dataDir, "plugins", "off-plugin", "skills", "p2"), { recursive: true });
await writeFile(join(dataDir, "plugins", "off-plugin", "plugin.json"), JSON.stringify({ name: "off-plugin" }));
await writeFile(join(dataDir, "plugins", "off-plugin", "skills", "p2", "SKILL.md"), "---\nname: p2\ndescription: disabled via plugin\n---\nbody");
await writeFile(join(dataDir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "true" } } }, null, "\t"));

const project = {
	id: "p1",
	name: "inv",
	path: projectDir,
	createdAt: 0,
	updatedAt: 0,
	config: { provider: "anthropic", model: "glm-5.1", skillsDirs: [] },
} as unknown as Project;

// --- A: registry roundtrip ---------------------------------------------------
{
	const fresh = await loadRegistry(dataDir);
	check("A: missing registry file = all enabled", fresh.disabled.agents.length === 0 && fresh.disabled.plugins.length === 0);
	await setRegistryEnabled(dataDir, "agents", "shadow", false);
	await setRegistryEnabled(dataDir, "skills", "off-skill", false);
	await setRegistryEnabled(dataDir, "tools", "read", false);
	await setRegistryEnabled(dataDir, "plugins", "off-plugin", false);
	const raw = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf8")) as { disabled: { agents: string[] } };
	check("A: disable persisted to registry.json", raw.disabled.agents.includes("shadow"));
	await setRegistryEnabled(dataDir, "agents", "shadow", true);
	check("A: re-enable removes the name", !(await loadRegistry(dataDir)).disabled.agents.includes("shadow"));
	await setRegistryEnabled(dataDir, "agents", "shadow", false); // re-disable for B/G
}

// --- B: buildInventory ---------------------------------------------------------
{
	const inv = await buildInventory(dataDir, project);
	const by = (xs: { name: string }[]) => new Map(xs.map((x) => [x.name, x]));
	const agents = by(inv.agents);
	const skills = by(inv.skills);
	const tools = by(inv.tools);
	const plugins = by(inv.plugins);
	check("B: global agent listed + enabled", agents.get("keeper")?.enabled === true && agents.get("keeper")?.writable === true);
	check("B: disabled agent flagged", agents.get("shadow")?.enabled === false);
	check("B: builtin agents present + read-only", [...agents.values()].some((a) => a.source === "builtin" && !a.writable));
	check("B: enabled skill listed", skills.get("good-skill")?.enabled === true);
	check("B: disabled skill flagged", skills.get("off-skill")?.enabled === false);
	check("B: enabled plugin's skill listed", skills.get("p1")?.source === "plugin:on-plugin" && skills.get("p1")?.enabled === true);
	check("B: disabled plugin cascades to its skill", skills.get("p2")?.enabled === false);
	check("B: builtin tool row + disabled tool flagged", tools.get("read")?.enabled === false && tools.get("bash")?.enabled === true);
	check("B: mcp server row", tools.get("demo")?.source === "mcp" && tools.get("demo")?.enabled === true);
	check("B: plugin rows + disabled flagged", plugins.get("on-plugin")?.enabled === true && plugins.get("off-plugin")?.enabled === false);
}

// --- C: name validation --------------------------------------------------------
{
	await expectErr("C: traversal name rejected", 400, () => createAgentDoc(dataDir, "../evil", "x"));
	await expectErr("C: slash name rejected", 400, () => createSkillDoc(dataDir, "a/b", "x"));
	await expectErr("C: empty name rejected", 400, () => createPlugin(dataDir, "", ));
}

// --- D: versioned agent writes -------------------------------------------------
{
	const path = await createAgentDoc(dataDir, "versioned", "v0");
	for (let i = 1; i <= 7; i++) await writeDoc(path, `v${i}`);
	const versions = await listFileVersions(path);
	check("D: pruned to 5 versions", versions.length === 5);
	const sorted = [...versions.map((v) => v.version)].join(",");
	check("D: versions newest-first", sorted === [...versions.map((v) => v.version)].sort().reverse().join(","));
	const oldest = versions[versions.length - 1];
	check("D: oldest kept backup is v2 (v1..v2 pruned)", (await readFileVersion(path, oldest.version)) === "v2");
	const restored = await rollbackFileVersion(path, oldest.version);
	check("D: rollback restores content", restored === "v2" && (await readFile(path, "utf8")) === "v2");
	const postRollback = await Promise.all((await listFileVersions(path)).map((v) => readFileVersion(path, v.version).catch(() => "")));
	check("D: rollback backed the replaced content up", postRollback.some((c) => c === "v7"));
	await expectErr("D: bad version id rejected", 400, () => readFileVersion(path, "../../etc/passwd"));
	await deleteDoc(path, "agents");
	const leftovers = (await readdir(join(dataDir, "agents"))).filter((e) => e.startsWith("versioned.md"));
	check("D: delete removes file + backups", leftovers.length === 0);
}

// --- E: skill CRUD ---------------------------------------------------------------
{
	const path = await createSkillDoc(dataDir, "fresh-skill", "---\nname: fresh-skill\ndescription: new\n---\nbody");
	const inv = await buildInventory(dataDir, project);
	const item = inv.skills.find((s) => s.name === "fresh-skill");
	check("E: created skill discovered + enabled", item?.enabled === true && item?.source === "global");
	await writeDoc(path, "---\nname: fresh-skill\ndescription: edited\n---\nbody2");
	check("E: skill write versioned", (await listFileVersions(path)).length === 1);
	await deleteDoc(path, "skills");
	const gone = (await buildInventory(dataDir, project)).skills.find((s) => s.name === "fresh-skill");
	check("E: skill delete removes the dir (gone from inventory)", gone === undefined);
	const pluginSkill = (await buildInventory(dataDir, project)).skills.find((s) => s.name === "p2");
	check("E: plugin skill read-only in inventory", pluginSkill?.writable === false);
}

// --- F: mcp.json validation -------------------------------------------------------
{
	await writeMcpConfig(dataDir, '{\n  "mcpServers": { "demo": { "command": "true" } }\n}');
	check("F: valid config accepted", JSON.parse(await readFile(join(dataDir, "mcp.json"), "utf8")).mcpServers.demo.command === "true");
	await expectErr("F: invalid JSON rejected", 400, () => writeMcpConfig(dataDir, "not json"));
	await expectErr("F: non-object top level rejected", 400, () => writeMcpConfig(dataDir, "[]"));
	await expectErr("F: array mcpServers rejected", 400, () => writeMcpConfig(dataDir, '{"mcpServers": []}'));
}

// --- G: runtime wiring (share-mode worker boot) -----------------------------------
{
	const mgr = new AgentManager({
		dataDir,
		sessionsDir: join(work, "sessions"),
		udsPath: join(work, "agent.sock"),
		workerModule: fileURLToPath(new URL("../agent/worker.ts", import.meta.url)),
		idleTtlMs: 0,
		spawnMode: "share",
	});
	// Boot `log` frames go to the manager's logger (stdout), not the WS fanout —
	// capture stdout around the respawn to observe discovery decisions.
	const lines: string[] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		lines.push(String(chunk));
		return origWrite(chunk, ...(rest as []));
	}) as typeof process.stdout.write;
	const tab = {
		readyState: WebSocket.OPEN,
		bufferedAmount: 0,
		send: (): void => undefined,
	} as unknown as WebSocket;
	try {
		await mgr.ensureAgent(project, "s1");
		await mgr.stop("s1");
		await mgr.attach("p1", "s1", tab);
		lines.length = 0;
		await mgr.start(project, "s1"); // respawn under stdout capture
		await sleep(1500);
		check("G: enabled plugin announced at boot", lines.some((l) => l.includes("plugin 'on-plugin'")));
		check("G: disabled plugin never announced", !lines.some((l) => l.includes("off-plugin")));
		check("G: worker reached ready", mgr.status("s1")?.status === "ready");

		// --- H: hot reload of the LIVE worker (no respawn) -----------------------
		await setRegistryEnabled(dataDir, "skills", "off-skill", true); // boot had it disabled
		lines.length = 0;
		mgr.reloadAssets(); // panel write → broadcast
		await sleep(1200);
		const reloaded = lines.find((l) => l.includes("assets reloaded:")) ?? "";
		check("H: live worker acked the reload", reloaded !== "");
		check("H: skill count changed on the live worker (2→3)", reloaded.includes("3 skill(s)"));
		check("H: worker stayed ready (no respawn)", mgr.status("s1")?.status === "ready");

		// Mid-turn reload must DEFER: not directly observable without an LLM call,
		// but the broadcast to a busy worker must at least not kill it.
	} finally {
		await mgr.shutdownAll();
		process.stdout.write = origWrite;
	}
}

await rm(work, { recursive: true, force: true });
await rm(projectDir, { recursive: true, force: true });
console.log(`smoke-inventory: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
