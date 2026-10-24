/** Skill types. A skill is a SKILL.md file with YAML frontmatter + a markdown body. */

export interface SkillFrontmatter {
	/** Stable kebab-case id used to invoke the skill. */
	name: string;
	/** One-line description shown in the system prompt skill index. */
	description: string;
}

export interface Skill extends SkillFrontmatter {
	/** Absolute path to the SKILL.md file. */
	path: string;
	/** Directory containing the SKILL.md (skills may bundle helper files alongside). */
	dir: string;
	/** Markdown instructions after the frontmatter. */
	body: string;
	/**
	 * Where the skill was discovered from — `"global"`, `"project"`, or
	 * `"plugin:<name>"`. Used for logging/debugging (which root won on a name
	 * collision); not surfaced to the model.
	 */
	source?: string;
}

/**
 * A skill search root: a directory to scan plus a label recording its origin
 * (global / project / plugin). Roots are scanned in precedence order (low→high);
 * on a name collision the last root wins.
 */
export interface SkillRoot {
	/** Directory to scan recursively for `SKILL.md` (before `~`/relative resolution). */
	dir: string;
	/** Origin label, e.g. `"global"`, `"project"`, `"plugin:my-plugin"`. */
	source: string;
}
