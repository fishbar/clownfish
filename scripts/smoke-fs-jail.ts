/** Smoke: filesystem jail — session isolation for agent tools.
 *  Structured tools (read/write/edit/ls/grep/find) jail paths to the agent's
 *  cwd (lexical escapes AND symlink tunnels): inside → allowed; outside but
 *  ordinary → only with a consent callback (user approval in production);
 *  session-data roots (dataDir/sessionsDir) → always refused. bash refuses
 *  commands referencing the roots (absolute / ~ / $HOME / ${HOME} forms, and
 *  `..` climbs out of the workspace) while still allowing the agent's own
 *  workspace — including a worktree living under dataDir. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createFindTool, createLsTool, createReadTool, createWriteTool, setIsolationRoots } from "../agent/tools";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}`); };

const run = async (tool: { execute: (id: string, input: unknown, signal?: undefined) => Promise<{ content: Array<{ type: string; text?: string }> }> }, input: unknown): Promise<string> => {
	try {
		const r = await tool.execute("t", input, undefined);
		return (r.content[0] as { text?: string }).text ?? "";
	} catch (err) {
		return `!ERR:${err instanceof Error ? err.message : String(err)}`;
	}
};

// Workspace + fake dataDir/session roots. The dataDir must sit under a home
// directory the jail module recognizes: os.homedir() reads $HOME on POSIX, so
// point it at the fake home before any screening runs (denyVariants() derives
// the `~` / `$HOME` / `${HOME}` forms from it).
const home = await mkdtemp(join(tmpdir(), "clownfish-jail-home-"));
process.env.HOME = home;
const dataDir = join(home, ".clownfish");
const sessionsDir = join(dataDir, "sessions");
await mkdir(join(sessionsDir, "other-session"), { recursive: true });
await writeFile(join(sessionsDir, "other-session", "index.jsonl"), '{"secret":1}');
await writeFile(join(dataDir, "settings.json"), '{"token":"sk-secret"}');

const ws = await mkdtemp(join(tmpdir(), "clownfish-jail-ws-"));
await writeFile(join(ws, "hello.txt"), "hi");
await mkdir(join(ws, "sub"));

// A worktree-style workspace nested under the dataDir (real layout:
// <dataDir>/worktrees/<sessionId>/<name>) — must stay fully usable.
const worktree = join(dataDir, "worktrees", "s1", "wt-1");
await mkdir(join(worktree, "src"), { recursive: true });
await writeFile(join(worktree, "src", "a.ts"), "export {}");

setIsolationRoots([dataDir, sessionsDir]);

// --- structured tools: inside allowed -------------------------------------------------
const read = createReadTool(ws);
const write = createWriteTool(ws);
const ls = createLsTool(ws);
const find = createFindTool(ws);

check("read inside cwd", (await run(read, { path: "hello.txt" })) === "hi");
check("read via nested rel path", (await run(read, { path: "./sub/../hello.txt" })) === "hi");
check("write inside cwd (new nested file)", !(await run(write, { path: "sub/new.txt", content: "x" })).startsWith("!ERR"));
check("ls inside cwd", (await run(ls, { path: "sub" })).includes("new.txt"));
check("find inside cwd", (await run(find, { pattern: "hello.txt" })).includes("hello.txt"));

// --- structured tools: outside refused ------------------------------------------------
const refusals: Array<[string, string, string]> = [
	["read other session transcript", "read", { path: join(sessionsDir, "other-session", "index.jsonl") }],
	["read settings.json", "read", { path: join(dataDir, "settings.json") }],
	["read via ~ form", "read", { path: "~/.clownfish/settings.json" }],
	["read /etc/passwd", "read", { path: "/etc/passwd" }],
	["write outside via ..", "write", { path: "../escaped.txt", content: "x" }],
	["write outside via nested ..", "write", { path: "sub/../../escaped.txt", content: "x" }],
	["write to other session dir", "write", { path: join(sessionsDir, "other-session", "pwn.jsonl"), content: "x" }],
	["ls outside", "ls", { path: join(dataDir, "sessions") }],
	["find outside root", "find", { pattern: "*.jsonl", path: sessionsDir }],
];
const tools = { read, write, ls, find };
for (const [name, kind, input] of refusals) {
	const text = await run(tools[kind as keyof typeof tools], input);
	check(`refuses: ${name}`, text.startsWith("!ERR") && text.includes("workspace"));
}
check("nothing escaped to disk", !(await run(read, { path: "../escaped.txt" })).includes("secret"));

// --- symlink tunnel ----------------------------------------------------------------------
await symlink(sessionsDir, join(ws, "link-to-sessions"));
const viaLink = await run(read, { path: "link-to-sessions/other-session/index.jsonl" });
check("refuses symlink tunnel to sessionsDir", viaLink.startsWith("!ERR") && viaLink.includes("workspace"));
const viaLinkLs = await run(ls, { path: "link-to-sessions" });
check("refuses ls through symlink", viaLinkLs.startsWith("!ERR") && viaLinkLs.includes("workspace"));
// A symlink pointing INSIDE the jail stays usable.
await symlink(join(ws, "sub"), join(ws, "link-to-sub"));
check("symlink inside jail usable", (await run(ls, { path: "link-to-sub" })).includes("new.txt"));

// --- bash screen -------------------------------------------------------------------------
const bashWs = createBashTool(ws);
const bashWt = createBashTool(worktree);

check("bash: plain command runs", (await run(bashWs, { command: "echo ok" })).includes("ok"));
check("bash: refuses dataDir absolute", (await run(bashWs, { command: `cat ${join(dataDir, "settings.json")}` })).includes("refused"));
check("bash: refuses ~ form", (await run(bashWs, { command: "cat ~/.clownfish/settings.json" })).includes("refused"));
check("bash: refuses $HOME form", (await run(bashWs, { command: "cat $HOME/.clownfish/settings.json" })).includes("refused"));
check("bash: refuses ${HOME} form", (await run(bashWs, { command: "cat ${HOME}/.clownfish/settings.json" })).includes("refused"));
check("bash: refuses sessionsDir", (await run(bashWs, { command: `ls ${sessionsDir}` })).includes("refused"));
check("bash: refuses bare relative climb", (await run(bashWs, { command: "cat ../.clownfish/settings.json" })).includes("refused"));
check("bash: refuses deep relative climb", (await run(bashWs, { command: "ls ../../etc" })).includes("refused"));
check("bash: refuses quoted relative climb", (await run(bashWs, { command: 'cat "../settings.json"' })).includes("refused"));
check("bash: allows .. inside a word (no climb)", !(await run(bashWs, { command: "echo foo..bar" })).includes("refused"));
check("bash: allows plain workspace-relative paths", !(await run(bashWs, { command: "ls sub" })).includes("refused"));

// Worktree under dataDir: own subtree stays usable, siblings denied.
const wtOut = await run(bashWt, { command: `cd ${worktree} && ls src` });
check("bash: worktree under dataDir usable (cwd masked)", wtOut.includes("a.ts"));
const wtEscape = await run(bashWt, { command: `cat ${worktree}/../../../settings.json` });
check("bash: climb out of worktree refused", wtEscape.includes("refused"));
const wtSibling = await run(bashWt, { command: `ls ${join(dataDir, "sessions")}` });
check("bash: worktree agent denied other dataDir paths", wtSibling.includes("refused"));

// --- consent flow: outside-workspace ≠ session data -------------------------
// A sibling file outside the workspace but not under the isolation roots:
// allowed only when the (user-proxy) approval callback consents.
const outsideFile = join(tmpdir(), "clownfish-jail-outside.txt");
await writeFile(outsideFile, "outside-content");
const approveAll = createReadTool(ws, { jailApproval: async () => true });
const denyAll = createReadTool(ws, { jailApproval: async () => false });
const strict = createReadTool(ws);

check("consent: approved outside read succeeds", (await run(approveAll, { path: outsideFile })) === "outside-content");
check("consent: declined outside read refused", (await run(denyAll, { path: outsideFile })).includes("workspace"));
check("consent: no callback (strict) refused", (await run(strict, { path: outsideFile })).includes("workspace"));
{
	let seenPath = "";
	const spy = createReadTool(ws, { jailApproval: async (info) => { seenPath = info.path; return false; } });
	await run(spy, { path: outsideFile });
	check("consent: callback receives canonical path", seenPath === outsideFile);
}
check("consent: session roots stay refused even when approved", (await run(approveAll, { path: join(dataDir, "settings.json") })).includes("session data"));
await symlink(outsideFile, join(ws, "link-outside"));
check("consent: approved read via inside symlink", (await run(approveAll, { path: "link-outside" })) === "outside-content");
check("consent: declined read via inside symlink", (await run(denyAll, { path: "link-outside" })).includes("workspace"));

// Screen is off when no roots configured (library default).
setIsolationRoots([]);
check("bash: no roots configured → no screening", !(await run(bashWs, { command: `echo ${dataDir}` })).includes("refused"));
setIsolationRoots([dataDir, sessionsDir]);

await rm(ws, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

console.log(`smoke-fs-jail: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
