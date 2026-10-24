/**
 * Clownfish agent module — the reusable, multi-process agent runtime.
 *
 * Owns the agent loop (ClownfishAgent + coding tools + skills), the per-session
 * worker process, the AgentManager that owns worker lifecycle, and the
 * Unix-domain WebSocket transport. A host (the server here, or any other
 * service) imports { AgentManager, startUds } and wires them into its own
 * HTTP/UI layer.
 *
 * Runtime-independent of any host: the only references to the caller's wire
 * types are `import type` (erased at build), sourced from ../server/protocol.
 */
export { AgentManager, type AgentManagerOptions, type AgentStatusInfo } from "./manager";
export { startUds, type UdsServer } from "./uds";
export { ClownfishAgent, type ClownfishAgentOptions } from "./clownfish-agent";
export { assembleSystemPrompt, type AssemblePromptOptions, DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
export { convertToLlm } from "./convert-to-llm";
export { resolveRuntime, type ResolvedRuntime, getModels, listProviders } from "./models";
export { loadSettings, applySettings } from "./settings";
export { toWireMessage, toWireMessages } from "./messages";
export { SessionTranscript, type TranscriptPage, type CompactRecord } from "./transcript";
export { runCompaction, makeSummaryMessage, type CompactInput, type CompactOptions, type CompactResult } from "./compact";
export { generateSessionTitle } from "./title";
export { generateId } from "./id";
export {
	discoverAgentRoots,
	AgentLoader,
	renderPrompt,
	resolveAgentPrompt,
	agentsTypeList,
	createRunAgentTool,
	OVERRIDE_SOURCE,
	isValidAgentName,
	listOverrides,
	overrideDir,
	overridePath,
	readOverride,
	removeOverride,
	writeOverride,
	type DiscoverAgentOptions,
	type AgentDefinition,
	type AgentRoot,
	type AgentPromptVars,
	type RunAgentToolDeps,
} from "./agents";
export { TodoStore, createTodoTool, readTodos, type TodoItem, type TodoStatus } from "./todo";
// Cross-session memory: written by the agent itself (the `memory` tool and the
// end-of-session reflection), filed by scope + category, and auditable from the
// settings page. There is no confirmation step by design — see agent/memory.ts.
export {
	MemoryStore,
	memoryRoot,
	removeAppliedCategory,
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryScope,
	type ReflectCursor,
	type MemoryWriteRecord,
	createMemoryTool,
} from "./memory";
export { runReflection, reflectionEnabled, type ReflectInput } from "./reflect";
export { snapshot as snapshotWorkspace, restore as restoreWorkspace, type Snapshot as WorkspaceSnapshot } from "./workspace-snapshot";
export { discoverPlugins, pluginNotes, type PluginBundle, type PluginScope } from "./plugins";
export {
	discoverCommandRoots,
	loadCommands,
	renderCommand,
	type Command,
	type CommandRoot,
} from "./commands";
export type { ToolDefinition, ToolPromptContribution } from "./tools";
export {
	applyToolOverrides,
	isValidToolName,
	listToolOverrides,
	loadToolOverrides,
	parseToolPrompt,
	readToolOverride,
	removeToolOverride,
	serializeToolPrompt,
	toolOverrideDir,
	toolOverridePath,
	writeToolOverride,
	TOOL_OVERRIDE_DIR,
	type ToolOverrideMap,
	type ToolPromptOverride,
	type ToolPromptSource,
	type ToolScope,
} from "./tools/overrides";
export { builtinToolPromptSources, effectiveToolPromptSources } from "./tool-catalog";
export type { Skill } from "./skills";
export { DagStore, type DagNode, type DagTree, type DagNodeView, type ChildSpec, type NodePatch, type DagNodeStatus, type DagNodeMode } from "./dag";
export type {
	WorkerSpawnConfig,
	ManagerFrame,
	WorkerFrame,
	WorkerSnapshot,
	ActiveTool,
} from "./protocol";
export { WORKER_CONFIG_ENV } from "./protocol";
