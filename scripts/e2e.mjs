/**
 * End-to-end smoke test.
 *
 * Boots a real server against a throwaway data dir on a free port, then drives
 * the REST API, the /chat WebSocket, and the auth gate. No browser, no fixtures.
 *
 *   node scripts/e2e.mjs            # server surface only (no credentials needed)
 *   node scripts/e2e.mjs --live     # also run one real model turn (needs creds)
 *
 * The --live turn is opt-in because it costs money and needs a configured
 * provider; everything else runs offline and is the gate worth wiring into CI.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const LIVE = process.argv.includes("--live");

let passed = 0;
const failures = [];

function check(name, ok, detail) {
	if (ok) {
		passed++;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(name, actual, expected) {
	check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Ask the OS for an unused port by binding :0 and reading it back. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Spawn the server and resolve once /api/health answers (or reject on timeout). */
async function startServer(env, port) {
	const child = spawn("npx", ["tsx", "server/index.ts"], {
		env: { ...process.env, ...env, CLOWNFISH_PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const logs = [];
	child.stdout.on("data", (d) => logs.push(d.toString()));
	child.stderr.on("data", (d) => logs.push(d.toString()));

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited early (code ${child.exitCode}):\n${logs.join("")}`);
		}
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (r.ok) return { child, logs };
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	child.kill("SIGKILL");
	throw new Error(`server did not become healthy in 60s:\n${logs.join("")}`);
}

async function stopServer(server) {
	if (!server?.child || server.child.exitCode !== null) return;
	server.child.kill("SIGTERM");
	await new Promise((resolve) => {
		const t = setTimeout(() => {
			server.child.kill("SIGKILL");
			resolve();
		}, 8000);
		server.child.on("exit", () => {
			clearTimeout(t);
			resolve();
		});
	});
}

const jsonHeaders = { "content-type": "application/json" };

function makeApi(port) {
	const base = `http://127.0.0.1:${port}`;
	const call = async (method, path, body) => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: body === undefined ? undefined : jsonHeaders,
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		});
		const text = await res.text();
		let parsed;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = text;
		}
		return { status: res.status, body: parsed };
	};
	return {
		base,
		get: (p) => call("GET", p),
		post: (p, b) => call("POST", p, b ?? {}),
		put: (p, b) => call("PUT", p, b),
		patch: (p, b) => call("PATCH", p, b),
		del: (p) => call("DELETE", p),
	};
}

// ------------------------------------------------------------ suites --------

/**
 * Agent prompt management (settings page): listing, copy-on-write override,
 * reset. The point of the suite is that editing never touches the source file
 * and that a reset restores the original definition exactly.
 */
async function testAgentPrompts(port, dataDir, pid) {
	const api = makeApi(port);
	console.log("\n# agent prompts (copy-on-write overrides)");

	const list = await api.get("/api/agent-prompts");
	eq("GET /api/agent-prompts → 200", list.status, 200);
	const agents = Array.isArray(list.body) ? list.body : [];
	check("built-in agents are listed", agents.length >= 4, `got ${agents.length}`);
	const system = agents.find((a) => a.name === "system");
	check("the system agent is present", Boolean(system));
	eq("it comes from the built-ins", system?.source, "builtin");
	eq("and is not yet overridden", system?.overridden, false);
	check("its content includes the frontmatter", (system?.content ?? "").startsWith("---"));
	const arch = agents.find((a) => a.name === "arch");
	eq("frontmatter access is parsed", arch?.access, "R");
	const compact = agents.find((a) => a.name === "sys-compact");
	eq("framework agents are flagged internal", compact?.internal, true);
	// A broken frontmatter block is dropped WHOLE by the total parser — this one
	// once lost `internal: true` to an unquoted ": " in its description.
	const assistant = agents.find((a) => a.name === "assistant");
	eq("the assistant's frontmatter parses (internal, not delegatable)", assistant?.internal, true);
	check("and carries its description", (assistant?.description ?? "").length > 0);

	const scoped = await api.get(`/api/agent-prompts?projectId=${pid}`);
	eq("project-scoped listing → 200", scoped.status, 200);
	const missingProject = await api.get("/api/agent-prompts?projectId=nope");
	eq("an unknown projectId → 404", missingProject.status, 404);
	eq("an invalid agent name → 400", (await api.get("/api/agent-prompts/..%2Fetc")).status, 400);
	eq("an unknown agent → 404", (await api.get("/api/agent-prompts/no-such-agent")).status, 404);
	eq("resetting a non-override → 404", (await api.del("/api/agent-prompts/system")).status, 404);
	eq("saving empty content → 400", (await api.put("/api/agent-prompts/system", { content: "  " })).status, 400);

	const sourcePath = system.path;
	const sourceBefore = readFileSync(sourcePath, "utf8");
	const edited = `${system.content}\n\nE2E MARKER LINE.\n`;
	const saved = await api.put("/api/agent-prompts/system", { content: edited });
	eq("PUT an override → 200", saved.status, 200);
	check(
		"the override lands in <dataDir>/agent_overwrite",
		saved.body?.path === join(dataDir, "agent_overwrite", "system.md"),
		saved.body?.path,
	);
	eq("the source file is untouched", readFileSync(sourcePath, "utf8"), sourceBefore);

	const after = await api.get("/api/agent-prompts/system");
	eq("the override now wins", after.body?.source, "override");
	eq("it is flagged overridden", after.body?.overridden, true);
	check("the edit round-trips verbatim", after.body?.content === edited, "content differs");
	eq("the base it shadows is reported", after.body?.baseSource, "builtin");
	eq("the base content is the original file", after.body?.baseContent, sourceBefore);

	// Versioning: each save backs up what it replaces.
	const bad = await api.put("/api/agent-prompts/system", { content: "---\ndescription: a: b\n---\nbody\n" });
	eq("frontmatter that is not valid YAML → 400", bad.status, 400);
	check("the error says how to fix it", String(bad.body?.error ?? "").includes("引号"), bad.body?.error);
	eq("an unclosed frontmatter block → 400", (await api.put("/api/agent-prompts/system", { content: "---\ndescription: x\nbody\n" })).status, 400);
	const quoted = await api.put("/api/agent-prompts/system", { content: '---\ndescription: "a: b"\n---\nbody\n' });
	eq("a quoted value with ': ' is accepted", quoted.status, 200);
	eq("and parses as the description", (await api.get("/api/agent-prompts/system")).body?.description, "a: b");
	const second = `${edited}SECOND SAVE.\n`;
	await api.put("/api/agent-prompts/system", { content: second });
	const versions = await api.get("/api/agent-prompts/system/versions");
	eq("GET versions → 200", versions.status, 200);
	const vlist = versions.body?.versions ?? [];
	check("each save backed up the file it replaced", vlist.length >= 2, JSON.stringify(vlist));
	const contents = await Promise.all(vlist.map((v) => api.get(`/api/agent-prompts/system/versions/${encodeURIComponent(v.version)}`)));
	check("a backup holds the earlier edit", contents.some((c) => c.body?.content === edited), JSON.stringify(contents.map((c) => c.status)));
	eq("an unknown version → 404", (await api.get("/api/agent-prompts/system/versions/19990101-000000")).status, 404);
	eq("rollback without a version → 400", (await api.post("/api/agent-prompts/system/rollback", {})).status, 400);
	const target = vlist[contents.findIndex((c) => c.body?.content === edited)]?.version;
	const rolled = await api.post("/api/agent-prompts/system/rollback", { version: target });
	eq("rollback → 200", rolled.status, 200);
	eq("the override holds the restored content", (await api.get("/api/agent-prompts/system")).body?.content, edited);
	const afterRollback = (await api.get("/api/agent-prompts/system/versions")).body?.versions ?? [];
	check("the replaced content was itself backed up first", afterRollback.length >= vlist.length, `${vlist.length} → ${afterRollback.length}`);

	eq("DELETE the override → 204", (await api.del("/api/agent-prompts/system")).status, 204);
	const restored = await api.get("/api/agent-prompts/system");
	eq("the built-in is back in effect", restored.body?.source, "builtin");
	eq("with its original content", restored.body?.content, sourceBefore);
	check("the history survives the reset", ((await api.get("/api/agent-prompts/system/versions")).body?.versions ?? []).length > 0);
}

/**
 * Tool prompts: the settings page's tool editor. Same copy-on-write contract as
 * agent prompts, but the "source" is the definition in code, so a reset has no
 * file to restore — it just drops the shadow copy under `tool_overwrite/`.
 */
async function testToolPrompts(port, dataDir) {
	const api = makeApi(port);
	console.log("\n# tool prompts (copy-on-write overrides)");

	const list = await api.get("/api/tool-prompts");
	eq("GET /api/tool-prompts → 200", list.status, 200);
	const tools = Array.isArray(list.body) ? list.body : [];
	for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls", "skill", "run_agent"]) {
		check(`${name} is listed`, tools.some((t) => t.name === name), JSON.stringify(tools.map((t) => t.name)));
	}
	const read = tools.find((t) => t.name === "read");
	eq("read is flagged read-only", read?.mode, "R");
	eq("it starts un-overridden", read?.overridden, false);
	check("its content carries the snippet frontmatter", (read?.content ?? "").startsWith("---"));
	check("and the schema description as the body", (read?.content ?? "").includes(read?.description?.slice(0, 24) ?? "\u0000"));
	eq("run_agent is flagged mutating", tools.find((t) => t.name === "run_agent")?.mode, "W");

	// The tab must show EVERYTHING the model sees, so every listed tool carries
	// its parameter schema and what it costs.
	const noSchema = tools.filter((t) => !(t.schemaTokens > 0) || typeof t.schema !== "string");
	check("every tool reports a parameter schema + token estimate", noSchema.length === 0, JSON.stringify(noSchema.map((t) => t.name)));
	const unparsable = tools.filter((t) => {
		try {
			const wire = JSON.parse(t.schema);
			return wire.name !== t.name || wire.description !== t.description || !wire.input_schema;
		} catch {
			return true;
		}
	});
	check("each schema parses as the provider's {name, description, input_schema}", unparsable.length === 0, JSON.stringify(unparsable.map((t) => t.name)));
	check("prompt text is costed too", tools.every((t) => t.promptTokens > 0), JSON.stringify(tools.filter((t) => !(t.promptTokens > 0)).map((t) => t.name)));
	check(
		"read's schema carries its own parameters",
		JSON.parse(read?.schema ?? "{}").input_schema?.properties?.path !== undefined,
		read?.schema,
	);
	check(
		"run_agent's catalog schema uses the static agent-type stand-in",
		(JSON.parse(tools.find((t) => t.name === "run_agent")?.schema ?? "{}").input_schema?.properties?.type?.description ?? "").includes("the live list is embedded per session"),
	);

	eq("an invalid tool name → 400", (await api.get("/api/tool-prompts/..%2Fetc")).status, 400);
	eq("an unknown tool → 404", (await api.get("/api/tool-prompts/no-such-tool")).status, 404);
	eq("overriding an unknown tool → 404", (await api.put("/api/tool-prompts/no-such-tool", { content: "x" })).status, 404);
	eq("saving empty content → 400", (await api.put("/api/tool-prompts/read", { content: "  " })).status, 400);
	eq(
		"saving frontmatter with no description → 400",
		(await api.put("/api/tool-prompts/read", { content: "---\nsnippet: x\n---\n" })).status,
		400,
	);
	eq("resetting a non-override → 404", (await api.del("/api/tool-prompts/read")).status, 404);

	const edited = "---\nsnippet: E2E snippet\nguidelines:\n  - E2E guideline\n---\nE2E description body.\n";
	const saved = await api.put("/api/tool-prompts/read", { content: edited });
	eq("PUT an override → 200", saved.status, 200);
	check(
		"the override lands in <dataDir>/tool_overwrite",
		saved.body?.path === join(dataDir, "tool_overwrite", "read.md"),
		saved.body?.path,
	);

	const after = await api.get("/api/tool-prompts/read");
	eq("the override now wins", after.body?.source, "override");
	eq("it is flagged overridden", after.body?.overridden, true);
	eq("the description is replaced", after.body?.description, "E2E description body.");
	eq("the snippet is replaced", after.body?.snippet, "E2E snippet");
	check("the guidelines are replaced", JSON.stringify(after.body?.guidelines) === JSON.stringify(["E2E guideline"]));
	eq("the built-in is still reported as the base", after.body?.baseContent, read.content);

	eq("DELETE the override → 204", (await api.del("/api/tool-prompts/read")).status, 204);
	const restored = await api.get("/api/tool-prompts/read");
	eq("the built-in is back in effect", restored.body?.source, "builtin");
	eq("with its original content", restored.body?.content, read.content);
}

/**
 * Keyboard shortcuts + cross-session memory: the two other copy-on-write-ish
 * operator surfaces. Both must survive a malformed file rather than 500.
 */
async function testKeysAndMemory(port, dataDir) {
	const api = makeApi(port);
	console.log("\n# keybindings");

	const keys = await api.get("/api/keybindings");
	eq("GET /api/keybindings → 200", keys.status, 200);
	const rows = Array.isArray(keys.body) ? keys.body : [];
	check("every action is listed", rows.length >= 14, `got ${rows.length}`);
	const cycle = rows.find((r) => r.action === "cycle-mode");
	eq("mode cycling keeps Claude Code's Shift+Tab", cycle?.keys, "Shift+Tab");
	eq("and is not overridden yet", cycle?.overridden, false);
	check("no default binding collides", !rows.some((r) => r.conflictsWith), JSON.stringify(rows.filter((r) => r.conflictsWith)));

	eq("rebinding an unknown action → 404", (await api.put("/api/keybindings/nope", { keys: "Mod+K" })).status, 404);
	eq("a malformed binding → 400", (await api.put("/api/keybindings/abort", { keys: "Mod+" })).status, 400);
	eq("an unknown modifier → 400", (await api.put("/api/keybindings/abort", { keys: "Hyper+K" })).status, 400);
	eq("resetting an un-overridden action → 404", (await api.del("/api/keybindings/abort")).status, 404);

	const bound = await api.put("/api/keybindings/abort", { keys: "mod+shift+x" });
	eq("PUT a rebind → 200", bound.status, 200);
	eq("the binding is canonicalized", bound.body?.keys, "Mod+Shift+X");
	const after = await api.get("/api/keybindings");
	eq("it is flagged overridden", after.body?.find((r) => r.action === "abort")?.overridden, true);
	check(
		"the file only stores the deviation",
		JSON.parse(readFileSync(join(dataDir, "keybindings.json"), "utf8")).abort === "Mod+Shift+X",
	);
	eq("DELETE resets it", (await api.del("/api/keybindings/abort")).body?.keys, "Escape");

	const collided = await api.put("/api/keybindings/abort", { keys: "Shift+Tab" });
	check(
		"a collision is reported, not silently accepted",
		(collided.body?.bindings ?? []).some((r) => r.action === "abort" && r.conflictsWith?.includes("cycle-mode")),
	);
	await api.del("/api/keybindings");

	console.log("\n# memory (agent-written, no confirmation step)");
	// Memory is written by the AGENT — the `memory` tool during a turn and the
	// end-of-session reflection — and takes effect immediately. These endpoints
	// are the human's half of that: read everything, drop what you disagree with.
	const empty = await api.get("/api/memory");
	eq("GET /api/memory → 200", empty.status, 200);
	check("a fresh install remembers nothing", Array.isArray(empty.body?.blocks) && empty.body.blocks.length === 0, JSON.stringify(empty.body));

	// Seed the files directly rather than importing the store: the ON-DISK FORMAT
	// is the contract between the agent that writes memory and the UI that reads
	// it, so asserting against the format catches a drift a module import would
	// hide.
	const gid = "aa11";
	const pid2 = "bb22";
	const stamp = "2026-08-29 15:04:32";
	mkdirSync(join(dataDir, "memory", "applied", "global"), { recursive: true });
	mkdirSync(join(dataDir, "memory", "applied", "projects", "p1"), { recursive: true });
	writeFileSync(join(dataDir, "memory", "applied", "global", "style.md"), `- [${gid}] 回复用中文 (${stamp})\n`);
	writeFileSync(join(dataDir, "memory", "applied", "projects", "p1", "lessons.md"), `- [${pid2}] X 会失败因为 Y，改用 Z (${stamp})\n`);

	const listed = await api.get("/api/memory");
	const blocks = listed.body?.blocks ?? [];
	eq("both scopes are listed", blocks.length, 2);
	const style = blocks.find((b) => b.category === "style");
	const lessons = blocks.find((b) => b.category === "lessons");
	check("the global entry is parsed", style?.entries?.[0]?.content === "回复用中文", JSON.stringify(style));
	check("with the id it was written under", style?.entries?.[0]?.id === gid, `${style?.entries?.[0]?.id} !== ${gid}`);
	eq("and a timestamp down to the second", style?.entries?.[0]?.at, stamp);
	check("lessons is a real category", lessons?.entries?.[0]?.id === pid2, JSON.stringify(lessons));
	check("project scope carries its project id", lessons?.scope?.projectId === "p1", JSON.stringify(lessons?.scope));

	eq("forgetting an unknown id → 404", (await api.del("/api/memory/nope")).status, 404);
	eq("DELETE forgets one entry → 204", (await api.del(`/api/memory/${gid}`)).status, 204);
	const afterForget = await api.get("/api/memory");
	const stillThere = (afterForget.body?.blocks ?? []).flatMap((b) => b.entries.map((e) => e.id));
	check("the forgotten entry is gone", !stillThere.includes(gid), stillThere.join(","));
	check("and the other one survived", stillThere.includes(pid2), stillThere.join(","));

	// The audit log is what stands in for a confirmation step: with nobody
	// approving writes, runs.jsonl is where a human reconstructs what happened.
	const runs = join(dataDir, "memory", "runs.jsonl");
	check("the removal is recorded in runs.jsonl", existsSync(runs) && readFileSync(runs, "utf8").includes(`"${gid}"`), runs);
}

/**
 * Plugin bundles + slash commands. The fixture is written in the Claude Code
 * layout (`.claude-plugin/plugin.json`, `commands/`, `agents/`, `skills/`,
 * `.mcp.json`) inside a marketplace-style nested directory, so this also pins
 * the "descend one level" rule that makes real Claude Code installs resolve.
 */
function writePluginFixture(dataDir) {
	const root = join(dataDir, "plugins", "repos", "acme-marketplace", "acme-tools");
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme", version: "1.0.0" }));
	mkdirSync(join(root, "commands", "git"), { recursive: true });
	writeFileSync(
		join(root, "commands", "review.md"),
		"---\ndescription: Review a change\nargument-hint: \"[path]\"\nallowed-tools: Bash\n---\nReview $ARGUMENTS carefully.\n",
	);
	writeFileSync(join(root, "commands", "git", "commit.md"), "Commit the staged changes.\n");
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(join(root, "agents", "acme-helper.md"), "---\ndescription: Acme helper\n---\nYou help with acme things.\n");
	mkdirSync(join(root, "skills", "acme-skill"), { recursive: true });
	writeFileSync(
		join(root, "skills", "acme-skill", "SKILL.md"),
		"---\nname: acme-skill\ndescription: An acme skill\n---\nDo the acme thing.\n",
	);
	writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { acme: { url: "https://example.invalid/mcp" } } }));
	return root;
}

async function testPlugins(port, dataDir, pid) {
	const api = makeApi(port);
	console.log("\n# plugins + slash commands (Claude Code layout)");

	const plugins = await api.get(`/api/projects/${pid}/plugins`);
	eq("GET .../plugins → 200", plugins.status, 200);
	const acme = (plugins.body ?? []).find((p) => p.name === "acme");
	check("the nested Claude-Code bundle is found", Boolean(acme), JSON.stringify(plugins.body));
	eq("its manifest name wins over the dir name", acme?.name, "acme");
	eq("skills are wired", acme?.skills, true);
	eq("agents are wired", acme?.agents, true);
	eq("commands are wired", acme?.commands, true);
	eq(".mcp.json is wired", acme?.mcp, true);

	const commands = await api.get(`/api/projects/${pid}/commands`);
	eq("GET .../commands → 200", commands.status, 200);
	const review = (commands.body ?? []).find((c) => c.name === "review");
	check("a plugin command is listed", Boolean(review), JSON.stringify(commands.body));
	eq("its frontmatter description is used", review?.description, "Review a change");
	eq("its argument-hint is passed through", review?.argumentHint, "[path]");
	eq("it is labelled with its plugin", review?.source, "plugin:acme");
	const nested = (commands.body ?? []).find((c) => c.name === "git:commit");
	check("a nested command is namespaced with ':'", Boolean(nested));
	eq("a command with no frontmatter still loads", typeof nested?.description, "string");

	const skills = await api.get(`/api/projects/${pid}/skills`);
	check(
		"the plugin's skill is discoverable",
		(skills.body ?? []).some((s) => s.name === "acme-skill"),
		JSON.stringify(skills.body),
	);

	const agents = await api.get(`/api/agent-prompts?projectId=${pid}`);
	const helper = (agents.body ?? []).find((a) => a.name === "acme-helper");
	check("the plugin's agent is discoverable", Boolean(helper));
	eq("it is labelled with its plugin", helper?.source, "plugin:acme");
}

async function testOpenServer(port, dataDir) {
	const api = makeApi(port);
	console.log("\n# REST surface (auth off)");

	const health = await api.get("/api/health");
	eq("GET /api/health → 200", health.status, 200);
	eq("health.ok", health.body?.ok, true);

	const me = await api.get("/auth/me");
	eq("GET /auth/me → 200", me.status, 200);
	eq("auth disabled reports enabled:false", me.body?.enabled, false);
	eq("auth disabled reports authenticated:true", me.body?.authenticated, true);

	const created = await api.post("/api/projects", { name: "e2e", path: process.cwd() });
	eq("POST /api/projects → 201", created.status, 201);
	const pid = created.body?.id;
	check("project has an id", typeof pid === "string" && pid.length > 0);

	// Idempotent by path: the same workspace comes back as the SAME project with
	// 200 (not a second one with 201) — this is what lets an agent call
	// create-project as "ensure exists". The first creation's explicit name wins.
	const again = await api.post("/api/projects", { path: process.cwd() });
	eq("POST same path again → 200", again.status, 200);
	eq("same path returns the same project", again.body?.id, pid);
	eq("the first creation's explicit name wins", again.body?.name, "e2e");

	// No name given → the directory's basename.
	const namedWs = join(dataDir, "named-ws");
	mkdirSync(namedWs, { recursive: true });
	const named = await api.post("/api/projects", { path: namedWs });
	eq("POST without a name → 201", named.status, 201);
	eq("name defaults to the directory's basename", named.body?.name, "named-ws");

	const list = await api.get("/api/projects");
	check("GET /api/projects includes it", Array.isArray(list.body) && list.body.some((p) => p.id === pid));

	// The assistant (我的助理): a synthetic project injected FIRST by the model —
	// never a record on disk, one fixed session, not deletable from either side.
	check(
		"the assistant project is listed first",
		Array.isArray(list.body) && list.body[0]?.id === "assistant",
		JSON.stringify(list.body?.map((p) => p.id)),
	);
	const aGet = await api.get("/api/projects/assistant");
	eq("GET /api/projects/assistant → 200", aGet.status, 200);
	check("it carries sessionControl", aGet.body?.config?.sessionControl === true, JSON.stringify(aGet.body?.config));
	eq("DELETE the assistant project → 404", (await api.del("/api/projects/assistant")).status, 404);
	const aSessions = await api.get("/api/projects/assistant/sessions");
	check(
		"its listing ensures exactly one fixed session",
		Array.isArray(aSessions.body) && aSessions.body.length === 1 && aSessions.body[0]?.id === "assistant",
		JSON.stringify(aSessions.body),
	);
	eq("POST create on it is idempotent (200)", (await api.post("/api/projects/assistant/sessions", {})).status, 200);
	eq("DELETE its session → 403", (await api.del("/api/projects/assistant/sessions/assistant")).status, 403);

	const one = await api.get(`/api/projects/${pid}`);
	eq("GET /api/projects/:id → 200", one.status, 200);
	eq("project name round-trips", one.body?.name, "e2e");

	const renamed = await api.patch(`/api/projects/${pid}`, { name: "e2e-renamed" });
	eq("PATCH /api/projects/:id renames", renamed.body?.name, "e2e-renamed");

	// Context-window setting: only the published choices, clearable with null.
	const cwSet = await api.patch(`/api/projects/${pid}`, { config: { contextWindow: 256000 } });
	eq("PATCH contextWindow=256000 persists", cwSet.body?.config?.contextWindow, 256000);
	const cwBad = await api.patch(`/api/projects/${pid}`, { config: { contextWindow: 999 } });
	eq("an off-menu contextWindow → 400", cwBad.status, 400);
	const cwStill = await api.get(`/api/projects/${pid}`);
	eq("the rejected write changed nothing", cwStill.body?.config?.contextWindow, 256000);
	const cwClear = await api.patch(`/api/projects/${pid}`, { config: { contextWindow: null } });
	eq("contextWindow: null clears the cap", cwClear.body?.config?.contextWindow, undefined);

	const missing = await api.get("/api/projects/does-not-exist");
	eq("GET unknown project → 404", missing.status, 404);

	const skills = await api.get(`/api/projects/${pid}/skills`);
	eq("GET /api/projects/:id/skills → 200", skills.status, 200);
	check("skills is an array", Array.isArray(skills.body));

	// The panel's 全局 scope: the same inventory REST surface, mounted bare —
	// no projectId means discovery runs against dataDir (builtin + global only).
	const globalInv = await api.get("/api/inventory");
	eq("GET /api/inventory (全局) → 200", globalInv.status, 200);
	check(
		"全局 inventory lists builtin agents but no project-rooted ones",
		Array.isArray(globalInv.body?.agents) && globalInv.body.agents.some((a) => a.source === "builtin") && globalInv.body.agents.every((a) => a.source !== "project"),
		JSON.stringify(globalInv.body?.agents?.map((a) => [a.name, a.source])),
	);

	const agentTypes = await api.get("/api/agents");
	eq("GET /api/agents → 200", agentTypes.status, 200);

	// External CLI sub-agents: the settings page's form surface. The store's own
	// semantics (defaults, override, tombstone) are pinned in cli-subagent-check;
	// what matters HERE is the REST round-trip and its validation gate.
	console.log("\n# cli-agents (external CLI sub-agent configs)");
	const cliList = await api.get("/api/cli-agents");
	eq("GET /api/cli-agents → 200", cliList.status, 200);
	check(
		"the shipped defaults (claude-code + codex) are listed with availability",
		Array.isArray(cliList.body?.agents) &&
			cliList.body.agents.some((a) => a.name === "claude-code" && typeof a.available === "boolean") &&
			cliList.body.agents.some((a) => a.name === "codex"),
		JSON.stringify(cliList.body?.agents?.map((a) => [a.name, a.available])),
	);
	check("the recommended examples are served for the form", Array.isArray(cliList.body?.defaults) && cliList.body.defaults.length >= 2);
	eq("the gate is reported off without the env var", cliList.body?.enabled, false);

	eq("PUT an invalid name → 400", (await api.put("/api/cli-agents/bad entry!", { log: "none", command: "x" })).status, 400);
	eq("PUT with no command → 400", (await api.put("/api/cli-agents/nocmd", { log: "none", command: "" })).status, 400);

	const cliSaved = await api.put("/api/cli-agents/mytool", { log: "none", command: "/usr/bin/env", args: ["--flag", "{session-id}"] });
	eq("PUT a custom entry → 200", cliSaved.status, 200);
	eq("its availability is reported", cliSaved.body?.agent?.available, true);
	const cliAfter = await api.get("/api/cli-agents");
	check("the saved entry round-trips in the list", cliAfter.body?.agents?.some((a) => a.name === "mytool" && a.command === "/usr/bin/env"));
	check(
		"and lands in <dataDir>/cli-agents.json",
		JSON.parse(readFileSync(join(dataDir, "cli-agents.json"), "utf8")).agents?.some((a) => a.name === "mytool"),
	);
	eq("DELETE an unknown entry → 404", (await api.del("/api/cli-agents/no-such-tool")).status, 404);
	eq("DELETE the custom entry → 200", (await api.del("/api/cli-agents/mytool")).status, 200);
	const cliFinal = await api.get("/api/cli-agents");
	check("the defaults survive the delete (only the custom entry went)", cliFinal.body?.agents?.some((a) => a.name === "claude-code"));

	console.log("\n# sessions + transcript");
	const session = await api.post(`/api/projects/${pid}/sessions`, {});
	eq("POST session → 201", session.status, 201);
	const sid = session.body?.id;
	check("session has an id", typeof sid === "string" && sid.length > 0);

	const sessions = await api.get(`/api/projects/${pid}/sessions`);
	check("session appears in the list", Array.isArray(sessions.body) && sessions.body.some((s) => s.id === sid));

	const detail = await api.get(`/api/projects/${pid}/sessions/${sid}`);
	eq("GET session detail → 200", detail.status, 200);
	check("fresh session has an empty transcript", Array.isArray(detail.body?.messages) && detail.body.messages.length === 0);

	const titled = await api.patch(`/api/projects/${pid}/sessions/${sid}`, { title: "renamed" });
	eq("PATCH session renames", titled.body?.title, "renamed");

	const noSession = await api.get(`/api/projects/${pid}/sessions/nope`);
	eq("GET unknown session → 404", noSession.status, 404);

	// The session plan (todo list + delegation ledger). Written by the worker; the
	// endpoint reads the file, so it works with no agent running.
	const noPlan = await api.get(`/api/projects/${pid}/sessions/${sid}/todos`);
	eq("GET todos on a fresh session → 200", noPlan.status, 200);
	check("with an empty plan", Array.isArray(noPlan.body) && noPlan.body.length === 0, JSON.stringify(noPlan.body));
	const planFile = join(dataDir, "sessions", `${sid}.todo.json`);
	mkdirSync(dirname(planFile), { recursive: true });
	writeFileSync(
		planFile,
		JSON.stringify([
			{ id: "t1", task: "design the thing", status: "done", agent: "arch" },
			{ id: "t2", task: "build it", status: "running", agent: "coding", cwd: "/tmp/wt", transcript: "/tmp/x.jsonl" },
			{ id: "t3", task: "not a todo", status: "bogus" },
		]),
	);
	const plan = await api.get(`/api/projects/${pid}/sessions/${sid}/todos`);
	eq("the stored plan is served", plan.body?.length, 2);
	eq("ledger fields survive the round-trip", plan.body?.[1]?.agent, "coding");
	eq("including the worktree", plan.body?.[1]?.cwd, "/tmp/wt");
	check("items with an unknown status are dropped", !(plan.body ?? []).some((i) => i.id === "t3"));
	const otherProject = await api.post("/api/projects", { name: "plan-isolation", path: dataDir });
	const leaked = await api.get(`/api/projects/${otherProject.body?.id}/sessions/${sid}/todos`);
	eq("another project cannot read this session's plan", JSON.stringify(leaked.body), "[]");
	await api.del(`/api/projects/${otherProject.body?.id}`);

	console.log("\n# agent lifecycle");
	const status0 = await api.get(`/api/projects/${pid}/sessions/${sid}/agent/status`);
	eq("agent status before start → 404", status0.status, 404);

	const compactIdle = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/compact`);
	eq("compact with no running agent → 409", compactIdle.status, 409);

	const started = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/start`);
	eq("agent start → 200", started.status, 200);

	const status1 = await api.get(`/api/projects/${pid}/sessions/${sid}/agent/status`);
	eq("agent status after start → 200", status1.status, 200);

	const running = await api.get("/api/agents");
	check("started agent is listed", Array.isArray(running.body) && running.body.length >= 1);

	const badMode = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/mode`, { mode: "nonsense" });
	eq("unknown execution mode → 400", badMode.status, 400);

	const goodMode = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/mode`, { mode: "plan" });
	eq("mode=plan → 200", goodMode.status, 200);
	eq("mode round-trips", goodMode.body?.mode, "plan");

	const emptyRun = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/run`, { text: "  " });
	eq("background run with blank text → 400", emptyRun.status, 400);

	const pinned = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/pin`, { pinned: true });
	eq("agent pin → 200", pinned.status, 200);

	const stopped = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/stop`);
	eq("agent stop → 200", stopped.status, 200);

	const status2 = await api.get(`/api/projects/${pid}/sessions/${sid}/agent/status`);
	eq("agent status after stop → 404", status2.status, 404);

	const orphan = await api.get(`/api/projects/${pid}/sessions/nope/agent/status`);
	eq("agent status for unknown session → 404", orphan.status, 404);

	// Restart right after a stop: the manager must let the outgoing worker die
	// before respawning, rather than reusing a record whose exit handler is
	// still pending.
	const restarted = await api.post(`/api/projects/${pid}/sessions/${sid}/agent/start`);
	eq("restart immediately after stop → 200", restarted.status, 200);
	const status3 = await api.get(`/api/projects/${pid}/sessions/${sid}/agent/status`);
	eq("restarted agent reports a live status", status3.status, 200);
	check(
		"restarted agent is not dead",
		status3.body?.status !== "dead",
		`status=${status3.body?.status}`,
	);
	await api.post(`/api/projects/${pid}/sessions/${sid}/agent/stop`);

	console.log("\n# cross-project isolation");
	// A DISTINCT path: project creation is idempotent by path (same path → same
	// project), so reusing cwd here would silently return the main pid and the
	// "foreign session" below would be a native one.
	const otherWs = join(dataDir, "other-ws");
	mkdirSync(otherWs, { recursive: true });
	const other = await api.post("/api/projects", { name: "e2e-other", path: otherWs });
	const otherPid = other.body?.id;
	const otherSession = await api.post(`/api/projects/${otherPid}/sessions`, {});
	const otherSid = otherSession.body?.id;

	// A session id from another project must not be deletable through this one.
	const foreignDelete = await api.del(`/api/projects/${pid}/sessions/${otherSid}`);
	eq("deleting a foreign session → 404", foreignDelete.status, 404);

	const survived = await api.get(`/api/projects/${otherPid}/sessions/${otherSid}`);
	eq("the foreign session survives that delete", survived.status, 200);

	// Concurrent creates must not clobber each other in the registry.
	const batch = await Promise.all(
		Array.from({ length: 5 }, () => api.post(`/api/projects/${otherPid}/sessions`, {})),
	);
	const batchIds = batch.map((r) => r.body?.id).filter(Boolean);
	eq("5 concurrent creates all return an id", batchIds.length, 5);
	const afterBatch = await api.get(`/api/projects/${otherPid}/sessions`);
	const persisted = new Set((afterBatch.body ?? []).map((s) => s.id));
	check(
		"every concurrently created session persisted",
		batchIds.every((id) => persisted.has(id)),
		`${batchIds.filter((id) => !persisted.has(id)).length} lost`,
	);

	await api.del(`/api/projects/${otherPid}`);

	await testAgentPrompts(port, dataDir, pid);
	await testToolPrompts(port, dataDir);
	await testKeysAndMemory(port, dataDir);
	await testPlugins(port, dataDir, pid);

	console.log("\n# websocket handshake");
	await testChat(port, pid, sid);

	console.log("\n# cleanup");
	const delSession = await api.del(`/api/projects/${pid}/sessions/${sid}`);
	check("DELETE session succeeds", delSession.status === 200 || delSession.status === 204);
	const delProject = await api.del(`/api/projects/${pid}`);
	check("DELETE project succeeds", delProject.status === 200 || delProject.status === 204);

	return { pid, sid };
}

/** Connect to /chat, expect a `ready` frame; optionally run one real model turn. */
function testChat(port, pid, sid) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/chat`);
		let sawReady = false;
		let sawToolCall = false;
		let text = "";
		const done = () => {
			check("/chat sends a ready frame", sawReady);
			if (LIVE) {
				check("live turn produced assistant text", text.trim().length > 0);
				check("live turn called a tool", sawToolCall);
			}
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			check("/chat handshake completed before timeout", sawReady, "timed out");
			done();
		}, LIVE ? 120_000 : 20_000);

		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
		ws.on("error", (e) => {
			check("/chat connects", false, e.message);
			clearTimeout(timer);
			resolve();
		});
		ws.on("message", (data) => {
			let f;
			try {
				f = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (f.type === "ready") {
				sawReady = true;
				if (!LIVE) return done();
				ws.send(
					JSON.stringify({
						type: "prompt",
						text: "Use the ls tool to list files in the current directory, then name two of them.",
					}),
				);
			} else if (f.type === "text_delta") {
				text += f.delta;
			} else if (f.type === "tool_start") {
				sawToolCall = true;
			} else if (f.type === "agent_end") {
				done();
			} else if (f.type === "error") {
				check("live turn produced no error frame", false, f.message);
				done();
			}
		});
	});
}

async function testAuthGate(port) {
	const api = makeApi(port);
	console.log("\n# auth gate (CLOWNFISH_AUTH=google)");

	const health = await api.get("/api/health");
	eq("/api/health stays open when auth is on", health.status, 200);

	const me = await api.get("/auth/me");
	eq("/auth/me stays open when auth is on", me.status, 200);
	eq("auth enabled reports enabled:true", me.body?.enabled, true);
	eq("auth enabled reports authenticated:false", me.body?.authenticated, false);

	const projects = await api.get("/api/projects");
	eq("unauthenticated /api/projects → 401", projects.status, 401);

	const login = await api.get("/auth/google");
	eq("/auth/google redirects to the consent screen", login.status, 302);

	const callback = await api.get("/auth/google/callback?code=x&state=y");
	eq("callback without a matching state cookie → 400", callback.status, 400);

	const ws = await new Promise((resolve) => {
		const sock = new WebSocket(`ws://127.0.0.1:${port}/chat`);
		sock.on("open", () => {
			sock.close();
			resolve("open");
		});
		sock.on("error", () => resolve("rejected"));
		setTimeout(() => resolve("timeout"), 8000);
	});
	eq("unauthenticated /chat upgrade is rejected", ws, "rejected");
}

/**
 * Simple login (CLOWNFISH_AUTH=simple): the challenge/response contract the
 * login page runs in the browser, replayed here with node:crypto — the
 * password itself never appears on the wire in EITHER direction.
 */
async function testSimpleAuth(port) {
	const base = `http://127.0.0.1:${port}`;
	const USER = "fish";
	const PASSWORD = "hunter2-secret";
	console.log("\n# auth gate (CLOWNFISH_AUTH=simple)");

	const me = await fetch(`${base}/auth/me`).then((r) => r.json());
	eq("simple auth reports enabled:true", me.enabled, true);
	eq("simple auth reports authenticated:false", me.authenticated, false);
	eq("unauthenticated /api/projects → 401", (await fetch(`${base}/api/projects`)).status, 401);

	const entry = await fetch(`${base}/auth/login`, { redirect: "manual" });
	eq("/auth/login redirects to the simple page", entry.headers.get("location"), "/auth/simple");
	const nav = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
	eq("browser GET → 302 to the login page", nav.headers.get("location"), "/auth/simple");
	const page = await fetch(`${base}/auth/simple`);
	check(
		"the login page is self-contained HTML",
		page.status === 200 && page.headers.get("content-type").includes("html"),
		`${page.status}`,
	);

	// The browser's dance, mirrored: challenge → PBKDF2 → HMAC proof. A reused
	// nonce can be passed to assert single-use.
	const attempt = async (username, password, reuseNonce) => {
		const ch = await fetch(`${base}/auth/simple/challenge`).then((r) => r.json());
		const nonce = reuseNonce ?? ch.nonce;
		const k = pbkdf2Sync(password, Buffer.from(ch.salt, "hex"), ch.iterations, 32, "sha256");
		const proof = createHmac("sha256", k).update(Buffer.from(nonce, "hex")).digest("hex");
		return {
			res: await fetch(`${base}/auth/simple/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username, nonce, proof }),
			}),
			nonce,
		};
	};

	const wrong = await attempt(USER, "wrong-password");
	eq("wrong password → 401", wrong.res.status, 401);

	const badUser = await attempt("root", PASSWORD);
	eq("wrong username → 401", badUser.res.status, 401);

	const good = await attempt(USER, PASSWORD);
	eq("correct credentials → 200", good.res.status, 200);
	const cookie = good.res.headers.get("set-cookie")?.split(";")[0] ?? "";
	check("a session cookie is set", cookie.startsWith("clownfish_session="), cookie);

	const replay = await attempt(USER, PASSWORD, good.nonce);
	eq("a used nonce cannot be replayed", replay.res.status, 401);

	eq("cookie unlocks /api/projects", (await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
	const meIn = await fetch(`${base}/auth/me`, { headers: { cookie } }).then((r) => r.json());
	check("auth/me now reports authenticated", meIn.authenticated === true && meIn.user?.email === USER, JSON.stringify(meIn));

	const ws = await new Promise((resolve) => {
		const sock = new WebSocket(`ws://127.0.0.1:${port}/chat`);
		sock.on("open", () => {
			sock.close();
			resolve("open");
		});
		sock.on("error", () => resolve("rejected"));
		setTimeout(() => resolve("timeout"), 8000);
	});
	eq("unauthenticated /chat upgrade is rejected", ws, "rejected");
}

/** Token autologin — the app shell's entry (CLOWNFISH_AUTH=token). */
async function testTokenAuth(port, token) {
	const base = `http://127.0.0.1:${port}`;
	const TOKEN = token;
	console.log("\n# auth gate (CLOWNFISH_AUTH=token)");

	const me = await fetch(`${base}/auth/me`).then((r) => r.json());
	eq("token auth reports enabled:true", me.enabled, true);
	eq("token auth reports authenticated:false", me.authenticated, false);
	eq("unauthenticated /api/projects → 401", (await fetch(`${base}/api/projects`)).status, 401);
	const nav = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
	eq("browser GET → 302 to /autologin", nav.headers.get("location"), "/autologin");
	eq("wrong token → 401", (await fetch(`${base}/autologin?token=wrong`)).status, 401);

	const good = await fetch(`${base}/autologin?token=${TOKEN}`, { redirect: "manual" });
	eq("correct token → 302 to /", good.headers.get("location"), "/");
	const setCookie = good.headers.get("set-cookie") ?? "";
	const cookie = setCookie.split(";")[0];
	check("a session cookie is set", cookie.startsWith("clownfish_session="), setCookie);
	check(
		"the cookie has no Max-Age — it dies with the browser session (the app)",
		!setCookie.includes("Max-Age"),
		setCookie,
	);
	eq("token reuse (no cookie) → 401", (await fetch(`${base}/autologin?token=${TOKEN}`, { redirect: "manual" })).status, 401);
	eq(
		"autologin with a session is idempotent (the shell's health reload)",
		(await fetch(`${base}/autologin?token=${TOKEN}`, { headers: { cookie }, redirect: "manual" })).headers.get("location"),
		"/",
	);

	eq("cookie unlocks /api/projects", (await fetch(`${base}/api/projects`, { headers: { cookie } })).status, 200);
	const meIn = await fetch(`${base}/auth/me`, { headers: { cookie } }).then((r) => r.json());
	check("auth/me reports the app user", meIn.authenticated === true && meIn.user?.email === "app", JSON.stringify(meIn));

	const wsOpen = await new Promise((resolve) => {
		const sock = new WebSocket(`ws://127.0.0.1:${port}/chat`, { headers: { cookie } });
		sock.on("open", () => {
			sock.close();
			resolve("open");
		});
		sock.on("error", () => resolve("rejected"));
		setTimeout(() => resolve("timeout"), 8000);
	});
	eq("the session cookie passes the /chat upgrade gate", wsOpen, "open");
}

// -------------------------------------------------------------- main --------

/**
 * Pure-function checks that need the TypeScript sources (prompt compaction).
 * Run as a subprocess so the e2e entry point stays the single gate.
 */
async function testPromptCompaction() {
	console.log("\n# prompt compaction");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/prompt-compact-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("compaction keeps meaning and drops only typography", result.code === 0, result.out.slice(-600));
	const m = /prompt compaction: (\d+) checks passed/.exec(result.out);
	check("all compaction assertions ran", Number(m?.[1] ?? 0) >= 20, result.out.slice(-200));
}

/** Auth config fail-closed + the OAuth/OIDC client against a mock provider. */
async function testAuthConfig() {
	console.log("\n# auth config (fail closed, OIDC, PKCE, domain allowlist)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/auth-config-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("requested-but-broken auth refuses to boot open; OIDC + PKCE work", result.code === 0, result.out.slice(-800));
	const m = /auth config: (\d+) checks passed/.exec(result.out);
	check("all auth-config assertions ran", Number(m?.[1] ?? 0) >= 30, result.out.slice(-200));
}

/** Rollback of the action log — file AND shell mutations, git and copy modes. */
async function testCheckpointRollback() {
	console.log("\n# checkpoint rollback (file + shell)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/checkpoint-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("bash writes, deletes and creates are undone", result.code === 0, result.out.slice(-800));
	const m = /checkpoint rollback: (\d+) checks passed/.exec(result.out);
	check("all rollback assertions ran", Number(m?.[1] ?? 0) >= 15, result.out.slice(-200));
}

/** The shared frontmatter parser, and the two loader crashes it fixed. */
async function testFrontmatter() {
	console.log("\n# frontmatter parsing (agents / skills / commands)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/frontmatter-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("a malformed or empty frontmatter block never breaks a loader", result.code === 0, result.out.slice(-800));
	const m = /frontmatter: (\d+) checks passed/.exec(result.out);
	check("all frontmatter assertions ran", Number(m?.[1] ?? 0) >= 20, result.out.slice(-200));
}

/** OpenAI login (ChatGPT Plus/Pro OAuth) + HTTPS proxy, offline. */
async function testOpenAICodex() {
	console.log("\n# openai-codex login + https proxy (offline)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/openai-codex-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("a stored credential resolves through pi-ai's own auth path; proxy installs only for openai/openai-codex", result.code === 0, result.out.slice(-800));
	const m = /openai-codex \+ proxy: (\d+) checks passed/.exec(result.out);
	check("all openai-codex assertions ran", Number(m?.[1] ?? 0) >= 22, result.out.slice(-200));
}

/** CLI-backed (pty) sessions: the pty-worker byte pump, resize, exit reporting. */
async function testPtySession() {
	console.log("\n# pty session (CLI-backed session worker, offline)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/pty-session-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("pty-worker round-trips input/output, applies resize, reports exit", result.code === 0, result.out.slice(-800));
	const m = /pty-session: (\d+) checks passed/.exec(result.out);
	check("all pty-session assertions ran", Number(m?.[1] ?? 0) >= 7, result.out.slice(-200));
}

/** run_agent's call shapes: the routing and refusals, before any provider call. */
async function testRunAgentShapes() {
	console.log("\n# run_agent call shapes (single / fan-out / until)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/run-agent-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("bad call shapes are refused before a sub-agent is built", result.code === 0, result.out.slice(-800));
	const m = /run_agent shapes: (\d+) checks passed/.exec(result.out);
	check("all run_agent shape assertions ran", Number(m?.[1] ?? 0) >= 18, result.out.slice(-200));
}

/** External CLI sub-agents: adapters, config store, and a fake-CLI run through
 *  createRunAgentTool (spawn → log tail → events → transcript → result). */
async function testCliSubagents() {
	console.log("\n# cli sub-agents (external CLI delegation, offline)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/cli-subagent-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("claude/codex log adapters, config store, and a fake-CLI delegation all behave", result.code === 0, result.out.slice(-800));
	const m = /cli-subagent: (\d+) checks passed/.exec(result.out);
	check("all cli-subagent assertions ran", Number(m?.[1] ?? 0) >= 27, result.out.slice(-200));
}

/** The search/read tools and the shell habit they replace (context windows, nudge). */
async function testSearchTools() {
	console.log("\n# search tools (grep context, shell-inspection nudge)");
	const result = await new Promise((resolve) => {
		const child = spawn("npx", ["tsx", "scripts/search-tools-check.mts"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d.toString()));
		child.stderr.on("data", (d) => (out += d.toString()));
		child.on("exit", (code) => resolve({ code, out }));
	});
	check("grep context windows merge, and read-only shell calls are flagged", result.code === 0, result.out.slice(-800));
	const m = /search tools: (\d+) checks passed/.exec(result.out);
	check("all search-tool assertions ran", Number(m?.[1] ?? 0) >= 40, result.out.slice(-200));
}

async function main() {
	const dataDir = mkdtempSync(join(tmpdir(), "clownfish-e2e-"));
	let open;
	let gated;
	let simple;
	let tokenSrv;
	try {
		writePluginFixture(dataDir);
		const openPort = await freePort();
		console.log(`booting server (auth off) on :${openPort}, dataDir=${dataDir}`);
		open = await startServer(
			{ CLOWNFISH_DATA_DIR: dataDir, CLOWNFISH_AUTH: "off", CLOWNFISH_AGENT_IDLE_TTL: "0" },
			openPort,
		);
		await testOpenServer(openPort, dataDir);
		await testPromptCompaction();
		await testCheckpointRollback();
		await testAuthConfig();
		await testFrontmatter();
		await testOpenAICodex();
		await testPtySession();
		await testRunAgentShapes();
		await testCliSubagents();
		await testSearchTools();
		await stopServer(open);
		open = undefined;

		const gatedPort = await freePort();
		console.log(`\nbooting server (auth on) on :${gatedPort}`);
		gated = await startServer(
			{
				CLOWNFISH_DATA_DIR: join(dataDir, "gated"),
				CLOWNFISH_AUTH: "google",
				GOOGLE_CLIENT_ID: "test-client-id",
				GOOGLE_CLIENT_SECRET: "test-client-secret",
				CLOWNFISH_AUTH_REDIRECT: `http://127.0.0.1:${gatedPort}/auth/google/callback`,
				CLOWNFISH_AUTH_ALLOWED_EMAILS: "nobody@example.com",
			},
			gatedPort,
		);
		await testAuthGate(gatedPort);
		await stopServer(gated);
		gated = undefined;

		// Simple login: seed credentials the way the CLI wizard writes them
		// (PBKDF2 verifier — the e2e password never leaves this process either),
		// then boot with CLOWNFISH_AUTH=simple. No TTY → the wizard stays quiet.
		const simplePort = await freePort();
		const simpleDir = join(dataDir, "simple");
		const salt = randomBytes(16).toString("hex");
		mkdirSync(join(simpleDir, "auth"), { recursive: true });
		writeFileSync(
			join(simpleDir, "auth", "simple.json"),
			JSON.stringify({
				username: "fish",
				salt,
				iterations: 210_000,
				key: pbkdf2Sync("hunter2-secret", Buffer.from(salt, "hex"), 210_000, 32, "sha256").toString("base64"),
			}),
		);
		console.log(`\nbooting server (auth simple) on :${simplePort}`);
		simple = await startServer(
			{ CLOWNFISH_DATA_DIR: simpleDir, CLOWNFISH_AUTH: "simple", CLOWNFISH_AGENT_IDLE_TTL: "0" },
			simplePort,
		);
		await testSimpleAuth(simplePort);
		await stopServer(simple);
		simple = undefined;

		// One-time token autologin — what the macOS app shell injects. The
		// token lives in the spawn env only; the shell generates it per launch.
		const tokenPort = await freePort();
		const token = randomBytes(24).toString("hex");
		console.log(`\nbooting server (auth token) on :${tokenPort}`);
		tokenSrv = await startServer(
			{
				CLOWNFISH_DATA_DIR: join(dataDir, "token"),
				CLOWNFISH_AUTH: "token",
				CLOWNFISH_AUTH_TOKEN: token,
				CLOWNFISH_AGENT_IDLE_TTL: "0",
			},
			tokenPort,
		);
		await testTokenAuth(tokenPort, token);
	} finally {
		await stopServer(open);
		await stopServer(gated);
		await stopServer(simple);
		await stopServer(tokenSrv);
		rmSync(dataDir, { recursive: true, force: true });
	}

	console.log(`\n${failures.length ? "FAILED" : "PASSED"} — ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("\ne2e harness error:", err);
	process.exit(1);
});
