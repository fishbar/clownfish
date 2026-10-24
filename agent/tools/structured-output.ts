/**
 * Terminating structured-output tool.
 *
 * Vendored from pi-dynamic-workflows v1.0.1 (MIT, Michaelliv),
 * src/structured-output.ts, on clownfish's own {@link defineTool} layer.
 *
 * Appended to a sub-agent's toolset when a caller needs machine-readable
 * output: the sub-agent MUST call it exactly once; the captured, schema-
 * validated arguments become the sub-agent's return value, and `terminate:
 * true` (honored by pi-agent-core) ends its loop without paying for an extra
 * assistant follow-up turn.
 */
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "./definition";

export interface StructuredOutputCapture<T = unknown> {
	value: T | undefined;
	called: boolean;
}

export interface StructuredOutputToolOptions<TSchemaDef extends TSchema> {
	schema: TSchemaDef;
	capture: StructuredOutputCapture<Static<TSchemaDef>>;
	name?: string;
}

/**
 * Create a terminating tool that captures validated params as the sub-agent
 * result. The loop's schema validation runs before `execute`, so `params` is
 * already checked against `schema` when captured.
 */
export function createStructuredOutputTool<TSchemaDef extends TSchema>({
	schema,
	capture,
	name = "structured_output",
}: StructuredOutputToolOptions<TSchemaDef>): ToolDefinition<TSchemaDef, Static<TSchemaDef>> {
	return defineTool({
		name,
		label: "Structured Output",
		description: "Return the final machine-readable result for this sub-agent task.",
		prompt: {
			snippet: "Return final machine-readable output",
			guidelines: [
				`${name} is the final answer channel for this task; call ${name} exactly once when done.`,
				`Do not write a prose final answer after calling ${name}.`,
			],
		},
		parameters: schema,
		mode: "R",
		async execute(_toolCallId, params) {
			capture.value = params;
			capture.called = true;
			return {
				content: [{ type: "text", text: "Structured output received." }],
				details: params,
				terminate: true,
			};
		},
	});
}
