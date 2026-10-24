/**
 * Frontmatter parsing — the shared parser, and the two loader crashes it fixed.
 *
 * Both inputs here are operator-authored files (an agent prompt, a third-party
 * SKILL.md), so both were reachable in normal use: an empty `---\n---` block
 * made the agent loader read a property off `null`, and a malformed SKILL.md
 * threw straight out of skill discovery.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownDoc, parseMarkdownDocLoose } from "../agent/frontmatter.ts";
import { AgentLoader } from "../agent/agents/loader.ts";
import { SkillLoader } from "../agent/skills/loader.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- the parser itself -------------------------------------------------

check("no frontmatter → null (strict)", parseMarkdownDoc("# hi\n\nbody") === null);
check("no frontmatter → all body (loose)", parseMarkdownDocLoose("# hi\n\nbody").body === "# hi\n\nbody");

const ok = parseMarkdownDoc("---\nname: a\ndescription: b\n---\n\nbody here\n");
check("frontmatter keys are parsed", ok?.frontmatter.name === "a" && ok?.frontmatter.description === "b");
check("body is trimmed", ok?.body === "body here");

const empty = parseMarkdownDoc("---\n\n---\n\nbody\n");
check("empty frontmatter block → {} not null", !!empty && typeof empty.frontmatter === "object" && empty.frontmatter !== null);
check("empty frontmatter keeps the body", empty?.body === "body");
// The pre-fix crash: reading a property off the parse result.
check("empty frontmatter is safe to read from", empty !== null && empty.frontmatter.description === undefined);

const bad = parseMarkdownDoc("---\nname: [unclosed\n  bad: : :\n---\n\nbody\n");
check("malformed YAML does not throw", bad !== null);
check("malformed YAML → empty frontmatter", Object.keys(bad?.frontmatter ?? { x: 1 }).length === 0);
check("malformed YAML keeps the body", bad?.body === "body");

const scalar = parseMarkdownDoc("---\njust-a-string\n---\n\nbody\n");
check("top-level scalar is not a frontmatter mapping", Object.keys(scalar?.frontmatter ?? { x: 1 }).length === 0);
const list = parseMarkdownDoc("---\n- a\n- b\n---\n\nbody\n");
check("top-level list is not a frontmatter mapping", Object.keys(list?.frontmatter ?? { x: 1 }).length === 0);

check("CRLF frontmatter parses", parseMarkdownDoc("---\r\nname: a\r\n---\r\nbody")?.frontmatter.name === "a");
check("loose never returns null", parseMarkdownDocLoose("").body === "");

// ---- the loaders that used to crash ------------------------------------

const dir = mkdtempSync(join(tmpdir(), "clownfish-fm-"));
try {
	const agentsDir = join(dir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "empty-fm.md"), "---\n\n---\n\nYou are a test agent.\n");
	writeFileSync(join(agentsDir, "broken-fm.md"), "---\nname: [unclosed\n---\n\nBroken but loadable.\n");
	writeFileSync(join(agentsDir, "good.md"), "---\ndescription: fine\naccess: R\n---\n\nGood agent.\n");

	let agents: Awaited<ReturnType<AgentLoader["load"]>> = [];
	let threw: unknown = null;
	try {
		agents = await new AgentLoader([{ dir: agentsDir, source: "test" }]).load();
	} catch (err) {
		threw = err;
	}
	check("agent loader survives an empty frontmatter block", threw === null, String(threw));
	check("all three agents load", agents.length === 3, `got ${agents.length}`);
	check("empty-frontmatter agent keeps its body", agents.find((a) => a.name === "empty-fm")?.body === "You are a test agent.");
	check("empty-frontmatter agent has no description", agents.find((a) => a.name === "empty-fm")?.description === undefined);
	check("valid frontmatter still reads access", agents.find((a) => a.name === "good")?.access === "R");

	const skillsDir = join(dir, "skills");
	mkdirSync(join(skillsDir, "broken"), { recursive: true });
	mkdirSync(join(skillsDir, "fine"), { recursive: true });
	writeFileSync(join(skillsDir, "broken", "SKILL.md"), "---\nname: [unclosed\n  : :\n---\n\nBroken.\n");
	writeFileSync(join(skillsDir, "fine", "SKILL.md"), "---\nname: fine\ndescription: a working skill\n---\n\nDo the thing.\n");

	let skills: Awaited<ReturnType<SkillLoader["load"]>> = [];
	threw = null;
	try {
		skills = await new SkillLoader([{ dir: skillsDir, source: "test" }], dir).load();
	} catch (err) {
		threw = err;
	}
	check("skill loader survives a malformed SKILL.md", threw === null, String(threw));
	// The pre-fix crash lost every skill, not just the bad one.
	check("the valid skill still loads alongside the broken one", skills.length === 1 && skills[0].name === "fine", `got ${skills.map((s) => s.name).join(",")}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`frontmatter: ${passed} checks passed`);
if (failures.length) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
