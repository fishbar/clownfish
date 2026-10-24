/**
 * One YAML-frontmatter parser for every markdown asset we load (agents, skills,
 * slash commands, prompt overrides).
 *
 * There were three copies of this regex, and they had drifted into two distinct
 * crashes: one assigned `parseYaml`'s result without a null guard (an empty
 * `---\n---` block then threw on the first property read), and one did not catch
 * at all (a single malformed third-party SKILL.md aborted the whole discovery
 * pass). Both are operator-authored files, so both are reachable. This parser is
 * total: it never throws, and a block it cannot read is treated as absent.
 */
import { parse as parseYaml } from "yaml";

export interface MarkdownDoc {
	frontmatter: Record<string, unknown>;
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split `raw` into frontmatter + body. Returns `null` when the file has no
 * frontmatter block at all — callers that require one (skills) reject on null,
 * callers that treat it as optional (agents, commands) fall back to
 * {@link parseMarkdownDocLoose}.
 */
export function parseMarkdownDoc(raw: string): MarkdownDoc | null {
	const match = raw.match(FRONTMATTER);
	if (!match) return null;
	let frontmatter: Record<string, unknown> = {};
	try {
		// A YAML scalar or list at the top level is not a frontmatter mapping;
		// `?? {}` also covers an empty block, which parses to null.
		const parsed = parseYaml(match[1]) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		/* malformed frontmatter — treat as none, never fail the load */
	}
	return { frontmatter, body: match[2].trim() };
}

/** As {@link parseMarkdownDoc}, but a file with no frontmatter is all body. */
export function parseMarkdownDocLoose(raw: string): MarkdownDoc {
	return parseMarkdownDoc(raw) ?? { frontmatter: {}, body: raw.trim() };
}
