/**
 * Pure-function checks for prompt compaction, run from the e2e entry point.
 *
 * The contract is narrow on purpose: compaction removes TYPOGRAPHY, never words.
 * A regression here would silently reword every agent's system prompt, so the
 * fidelity assertion (letters and digits are byte-identical before and after) is
 * the one that matters most.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactPrompt } from "../agent/prompt-compact";

const letters = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");
let checks = 0;
const ok = (name: string, cond: boolean, detail?: string): void => {
	assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
	checks++;
};

// Typography goes.
ok("heading hashes are dropped", compactPrompt("## Title\n\nbody\n").startsWith("Title"));
ok("bold markers are dropped", !compactPrompt("a **bold** b").includes("**"));
ok("italics are dropped", compactPrompt("a *it* b").includes("a it b"));
ok("underscore italics are dropped", compactPrompt("a _it_ b").includes("a it b"));
ok("link targets are dropped, labels kept", compactPrompt("see [the guide](https://x.dev/g) now").includes("see the guide now"));
ok("blank-line runs collapse", !compactPrompt("a\n\n\n\n b").includes("\n\n\n"));
ok("alignment spaces collapse", compactPrompt("a    b").includes("a b"));

// Content stays.
ok("list markers survive", compactPrompt("- one\n- two\n").includes("- one"));
ok("inline code is untouched", compactPrompt("run `a  **b**  c` now").includes("`a  **b**  c`"));
ok("fenced blocks are untouched", compactPrompt("x\n\n```js\nconst a = { b: 1 };   // **kept**\n```\n").includes("// **kept**"));
ok("indented samples are untouched", compactPrompt("text\n\n    key:   value\n").includes("    key:   value"));
ok("placeholders survive", compactPrompt("workspace at `{cwd}` on `{os}`").includes("{cwd}"));

// The real prompts must round-trip without losing a single word.
const dir = join(new URL("..", import.meta.url).pathname, "agent/agents/builtin");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
	const raw = readFileSync(join(dir, file), "utf8");
	ok(`${file}: compaction is meaning-preserving`, letters(compactPrompt(raw)) === letters(raw));
	ok(`${file}: compaction never grows the prompt`, compactPrompt(raw).length <= raw.length);
}

// Disabling must be exact, not approximate.
process.env.CLOWNFISH_COMPACT_PROMPTS = "0";
const { maybeCompactPrompt } = await import("../agent/prompt-compact");
ok("CLOWNFISH_COMPACT_PROMPTS=0 leaves the text alone", maybeCompactPrompt("## X\n\n**y**\n") === "## X\n\n**y**\n");

console.log(`prompt compaction: ${checks} checks passed`);
