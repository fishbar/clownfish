/**
 * skill tool — model-driven skill loading.
 *
 * The system prompt lists available skills; the model calls `skill({name})` to
 * pull a skill's full instructions into context when a task matches.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "../tools/definition";
import type { Skill } from "./types";

const skillSchema = Type.Object({
	name: Type.String({ description: "Name of the skill to load, as listed in the system prompt." }),
});

export function createSkillTool(getSkills: () => Promise<Skill[]> | Skill[]): ToolDefinition<typeof skillSchema, undefined> {
	return defineTool<typeof skillSchema, undefined>({
		name: "skill",
		label: "skill",
		mode: "R",
		description:
			"Load a skill's full instructions into context by name. Use this when the user's task matches one of the skills listed in the system prompt, before doing the work it describes.",
		parameters: skillSchema,
		prompt: {
			snippet: "Load a skill's instructions",
			guidelines: [
				"Check the Skills list in the system prompt. If a skill matches the task, call this tool to load its instructions before proceeding.",
				"A loaded skill's instructions take precedence over your default approach for that task — follow them.",
				"Do not load a skill you have already loaded in this conversation.",
			],
		},
		async execute(_toolCallId, { name }): Promise<AgentToolResult<undefined>> {
			const skills = await getSkills();
			const skill = skills.find((s) => s.name === name);
			if (!skill) {
				const available = skills.map((s) => s.name).join(", ") || "(none)";
				throw new Error(`Skill '${name}' not found. Available skills: ${available}`);
			}
			return {
				content: [{ type: "text", text: `# Skill: ${skill.name}\n\n${skill.body}` }],
				details: undefined,
			};
		},
	});
}
