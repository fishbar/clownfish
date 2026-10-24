/**
 * Aider Polyglot — a public, third-party benchmark, run through our harness.
 *
 * Everything in tasks*.mjs is ours: we wrote the task, so we chose the trap and
 * we chose where the bar sits. That is fine for measuring a change to Clownfish
 * against itself, but it cannot answer "is this harness good" — the tasks and the
 * harness have the same author. This suite closes that gap by running problems we
 * did not write and cannot tune: the 225 Exercism exercises Aider selected for its
 * polyglot leaderboard (the ones 3-or-fewer models could solve), with the
 * exercises' own upstream test suites as the scorer.
 *
 *   https://github.com/Aider-AI/polyglot-benchmark
 *
 * What we changed, and why:
 *
 * - **Three languages, not six.** Python, Go and Rust run offline with what a
 *   developer machine already has. Java needs a JDK, C++ needs cmake, and
 *   JavaScript needs a per-exercise `npm install` of jest+babel; adding those
 *   would measure toolchain availability, not agents. 100 of the 225 exercises
 *   remain. Absolute scores are therefore NOT comparable to the published
 *   leaderboard — see the note at the bottom.
 * - **The reference solution is deleted.** Upstream ships `.meta/example.*` next
 *   to the stub. It never reaches the workspace.
 * - **Test files are restored before scoring.** The exercise's tests sit in the
 *   workspace (the agent needs them, and Aider's own protocol shows them), so
 *   editing them to go green is the obvious shortcut. Scoring re-copies every
 *   test file from the pristine checkout first, exactly like the hidden tests in
 *   the other suites.
 *
 * Sampling is deterministic: a fixed hash of the exercise name orders the pool,
 * so `--n 12` is the same twelve exercises every round and rounds are comparable.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

/** Languages we can score with a stock developer machine, and how. */
const LANGS = {
	python: {
		testGlob: /_test\.py$/,
		// Every polyglot python exercise is plain unittest — no pytest needed.
		run: (dir) => exec(dir, "python3", ["-m", "unittest", "discover", "-p", "*_test.py"]),
	},
	go: {
		testGlob: /_test\.go$/,
		run: (dir) => exec(dir, "go", ["test", "./..."], { GOFLAGS: "-mod=mod" }),
	},
	rust: {
		testGlob: /^tests\//,
		run: (dir) => exec(dir, "cargo", ["test", "--offline"]),
	},
};

function exec(dir, cmd, args, extraEnv = {}) {
	try {
		const stdout = execFileSync(cmd, args, {
			cwd: dir,
			timeout: 300_000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...extraEnv },
		});
		return { ok: true, output: stdout };
	} catch (e) {
		return { ok: false, output: `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}\n${e.message ?? ""}` };
	}
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === ".meta" || entry.name === "target" || entry.name === "node_modules") continue;
			walk(abs, base, out);
		} else {
			out.push(relative(base, abs));
		}
	}
	return out;
}

/** Stable order without a PRNG, so a given `--n` is the same set every round. */
function hash(text) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

/** Rust exercises with third-party crates cannot build offline; skip them. */
function buildableOffline(lang, exerciseDir) {
	if (lang !== "rust") return true;
	const toml = join(exerciseDir, "Cargo.toml");
	if (!existsSync(toml)) return false;
	const body = readFileSync(toml, "utf8");
	const deps = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(body);
	return !deps || deps[1].trim() === "";
}

function instructions(exerciseDir) {
	const parts = [];
	for (const name of ["introduction.md", "instructions.md", "instructions.append.md"]) {
		const file = join(exerciseDir, ".docs", name);
		if (existsSync(file)) parts.push(readFileSync(file, "utf8").trim());
	}
	return parts.join("\n\n");
}

/**
 * Build one bench task per exercise.
 *
 * @param root  checkout of Aider-AI/polyglot-benchmark
 * @param langs which of {python,go,rust} to draw from
 * @param count how many exercises in total (deterministically sampled)
 */
export function loadPolyglotTasks({ root, langs = Object.keys(LANGS), count = 12 }) {
	if (!existsSync(root)) {
		throw new Error(`polyglot checkout missing: ${root}\nRun: make bench-polyglot-fetch`);
	}
	const pool = [];
	for (const lang of langs) {
		const spec = LANGS[lang];
		if (!spec) throw new Error(`unsupported polyglot language: ${lang}`);
		const practice = join(root, lang, "exercises", "practice");
		if (!existsSync(practice)) continue;
		for (const name of readdirSync(practice)) {
			const exerciseDir = join(practice, name);
			if (!statSync(exerciseDir).isDirectory()) continue;
			if (!buildableOffline(lang, exerciseDir)) continue;
			pool.push({ lang, name, exerciseDir, spec });
		}
	}
	// Interleave languages so a small `--n` is not all one language.
	pool.sort((a, b) => hash(a.name) - hash(b.name) || a.name.localeCompare(b.name));
	const byLang = new Map();
	for (const item of pool) {
		if (!byLang.has(item.lang)) byLang.set(item.lang, []);
		byLang.get(item.lang).push(item);
	}
	const ordered = [];
	for (let i = 0; ordered.length < pool.length; i++) {
		for (const lang of langs) {
			const list = byLang.get(lang);
			if (list && list[i]) ordered.push(list[i]);
		}
	}

	return ordered.slice(0, count).map(({ lang, name, exerciseDir, spec }) => {
		const testFiles = walk(exerciseDir).filter((rel) => spec.testGlob.test(rel));
		return {
			id: `polyglot-${lang}-${name}`,
			/** One exercise is small work; the budget is generous but not unbounded. */
			budget: { ms: 300_000, tokens: 200_000, cost: 0.8 },
			/**
			 * An untouched stub fails its own tests (that is the point) but has of
			 * course not tampered with them, so a pristine seed scores exactly 1.
			 */
			expectDry: 1,
			title: `Polyglot (${lang}) · ${name}`,
			prompt: `Solve this Exercism exercise in ${lang}.

${instructions(exerciseDir)}

The stub file(s) and the test suite are already in the working directory. Implement the stub so the tests pass.

Do not modify the test files — they are restored from a pristine copy before your work is scored, so editing them cannot help you.`,
			seed(dir) {
				mkdirSync(dir, { recursive: true });
				// Everything except .meta (which carries upstream's own solution).
				for (const rel of walk(exerciseDir)) {
					const target = join(dir, rel);
					mkdirSync(join(target, ".."), { recursive: true });
					cpSync(join(exerciseDir, rel), target);
				}
			},
			verify(dir) {
				// Restore the upstream tests before scoring: the workspace copy is
				// writable and going green by editing it is the obvious shortcut.
				const tampered = [];
				for (const rel of testFiles) {
					const live = join(dir, rel);
					const pristine = join(exerciseDir, rel);
					if (!existsSync(live) || readFileSync(live, "utf8") !== readFileSync(pristine, "utf8")) tampered.push(rel);
					mkdirSync(join(live, ".."), { recursive: true });
					cpSync(pristine, live);
				}
				// A stale build tree from the agent's own runs would mask a broken source.
				rmSync(join(dir, "target"), { recursive: true, force: true });

				const result = spec.run(dir);
				return [
					{
						name: `upstream test suite passes (${lang}/${name})`,
						ok: result.ok,
						detail: result.output.slice(-1500),
					},
					{
						name: "the exercise's own tests were left alone",
						ok: tampered.length === 0,
						detail: tampered.length ? `modified: ${tampered.join(", ")}` : "pristine",
					},
				];
			},
		};
	});
}

export const POLYGLOT_LANGS = Object.keys(LANGS);
