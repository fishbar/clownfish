import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api, type AgentPromptInfo, type CliAgentInfo, type KeybindingInfo, type MemoryInfo, type ToolPromptInfo } from "../api";
import { bindingFromEvent, renderBinding } from "../keymap";
import { MemoryBrowser } from "./memory";
import { AssetsPanel } from "./admin";
import { AgentPromptsPanel } from "./agent-prompts";
import type { InventoryItemWire, Project } from "../../protocol";

/**
 * Settings: four panels, three of them the same copy-on-write idea.
 *
 * → Agents: every discovered agent prompt (`.md` with frontmatter).
 * → Tools:  every tool's model-facing text — the schema description, the
 *   one-line index snippet, and the guidelines bullets. Tools are defined in
 *   code, so the "source" is the built-in definition and the edit is a shadow
 *   `.md` under `<dataDir>/tool_overwrite/` merged over it; an omitted key keeps
 *   the code default and Reset deletes the file.
 *
 * Editing is copy-on-write. The server writes the edited file to
 * `<dataDir>/agent_overwrite/<name>.md`, the highest-precedence discovery root,
 * so the built-in / project / plugin source is never mutated and "Reset" simply
 * deletes the shadow copy. The editor round-trips the WHOLE `.md` file —
 * frontmatter included — because `access` / `internal` live there and decide what
 * the agent may touch.
 *
 * A project selector widens the scan: with no project only the global roots are
 * listed; picking one adds its `.clownfish/agents` and project plugins.
 */

/** Short badge text for where the winning definition came from. */
/**
 * The editor pane shared by Agents, Tools and Memory: a path caption, a row of
 * panel-specific action buttons, the document textarea, and the error/notice
 * footer. All three panels edit one markdown document copy-on-write, so the
 * three copies of this markup only ever differed in which buttons sat in the
 * header and what the empty state said.
 */
function DocEditor(props: {
	/** Caption shown above the textarea — the file path, or a built-in label. */
	caption: string;
	/** Tooltip for the caption (the absolute path where there is one). */
	title: string;
	/** Panel-specific buttons (Revert / Reset / Save, or Forget / Save). */
	actions: preact.ComponentChildren;
	/** Shown in place of the editor when nothing is selected. */
	placeholder: string;
	selected: boolean;
	draft: string;
	onDraft: (value: string) => void;
	error: string;
	notice: string;
}): preact.JSX.Element {
	return (
		<div class="agent-editor">
			{props.selected ? (
				<>
					<div class="agent-editor-head">
						<code class="agent-path" title={props.title}>
							{props.caption}
						</code>
						<div class="agent-actions">{props.actions}</div>
					</div>
					<textarea
						class="agent-textarea"
						spellcheck={false}
						value={props.draft}
						onInput={(e) => props.onDraft((e.target as HTMLTextAreaElement).value)}
					/>
				</>
			) : (
				<div class="muted">{props.placeholder}</div>
			)}
			{props.error ? <div class="settings-error">{props.error}</div> : null}
			{props.notice && !props.error ? <div class="settings-notice muted">{props.notice}</div> : null}
		</div>
	);
}

/**
 * Settings → 记忆: what the agent has remembered, and the ability to drop any
 * of it. The same {@link MemoryBrowser} the `#/memory` page renders — memory is
 * global, so a second implementation here would only drift from that one.
 */
function MemoryPanel(): preact.JSX.Element {
	return (
		<div class="settings-panel-body">
			<p class="muted small">
				跨会话记忆。由智能体自己写入——对话中调用 <code>memory</code> 工具，或在会话结束时自省——
				<strong>写入即生效，没有确认环节</strong>。这里是它的另一半：写了什么都看得见，不认可的随时删掉。
				注入系统提示词时只取「全局 + 当前项目」，总量上限 8000 字符。
			</p>
			<MemoryBrowser />
		</div>
	);
}

/**
 * Settings → Agent, 下半区: 外部 CLI agent —— run_agent 可委派的外部 agent CLI
 * (Codex / Claude Code / 任意命令)。配置是完整的进程启动参数（可执行文件 +
 * 全量 argv + 占位符），存 `<dataDir>/cli-agents.json`，保存即热重载所有在跑的
 * worker；`log` 决定进度走哪种 session 日志适配器。表单初始值就是内置推荐配置。
 */
function CliAgentsPanel(): preact.JSX.Element {
	const [agents, setAgents] = useState<CliAgentInfo[]>([]);
	const [enabled, setEnabled] = useState(false);
	const [selected, setSelected] = useState<string>("");
	/** The editing draft ("" name = creating a new entry). */
	const [draft, setDraft] = useState<CliAgentInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const reload = useCallback(async (keep?: string): Promise<void> => {
		setError("");
		try {
			const r = await api.listCliAgents();
			setAgents(r.agents);
			setEnabled(r.enabled);
			const name = keep ?? selected;
			const current = r.agents.find((a) => a.name === name) ?? r.agents[0];
			setSelected(current?.name ?? "");
			setDraft(current ? { ...current } : null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [selected]);
	useEffect(() => {
		void reload();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	const select = (a: CliAgentInfo): void => {
		setSelected(a.name);
		setDraft({ ...a, args: [...a.args] });
		setNotice("");
		setError("");
	};

	const createNew = (): void => {
		// Prefilled with the shipped recommended claude example — the shape is
		// easiest to understand by editing a working config.
		setSelected("");
		setDraft({
			name: "",
			log: "none",
			command: "claude",
			args: ["-p", "--output-format", "json", "--verbose", "--session-id", "{session-id}", "--permission-mode", "bypassPermissions", "--model", "{model}"],
		});
		setNotice("");
		setError("");
	};

	const save = async (): Promise<void> => {
		if (!draft?.name.trim()) return void setError("name required");
		setBusy(true);
		setError("");
		try {
			const r = await api.saveCliAgent(draft);
			setNotice(`已保存 ${r.agent.name}${r.agent.available === false ? "（注意：命令当前不在 PATH 上，运行时会提示不可用）" : ""}。在跑的 worker 已热重载。`);
			await reload(draft.name.trim());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (): Promise<void> => {
		if (!selected) return;
		if (!confirm(`删除 CLI agent "${selected}"？`)) return;
		setBusy(true);
		setError("");
		try {
			await api.deleteCliAgent(selected);
			setNotice(`已删除 ${selected}。`);
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const setArgv = (value: string): void => {
		if (!draft) return;
		// One arg per line keeps quoting trivial — argv entries never contain
		// newlines in practice.
		setDraft({ ...draft, args: value.split("\n").map((l) => l.trim()).filter((l) => l !== "") });
	};

	return (
		<section class="admin-section cli-agents">
			<div class="admin-section-head">
				<h2>外部 CLI agent</h2>
				<button class="small" onClick={createNew}>
					+ 新建
				</button>
			</div>
			{!enabled ? (
				<p class="settings-error">
					CLI 子agent 未启用：在 settings.json 的 <code>env</code> 里设 <code>CLOWNFISH_CLI_SUBAGENTS=1</code>（或环境变量）后生效。下面的配置仍可编辑。
				</p>
			) : null}
			<p class="muted settings-hint">
				在 run_agent 里可被委派的外部 agent CLI，跑在同一工作区、用它自己的模型和登录。配置是<strong>完整的进程启动参数</strong>：
				可执行文件路径 + 全量参数（每行一个），任务本身走 stdin 不进 argv。占位符：<code>{"{session-id}"}</code>（自生成，让日志路径可预测）、
				<code>{"{workdir}"}</code>、<code>{"{model}"}</code>（无模型时连同前一个 flag 一起删除）、<code>{"{result-file}"}</code>（结果落盘文件）。
				<code>log</code> 选进度日志格式（claude / codex / none）。保存即热重载。
			</p>
			<div class="settings-body">
				<ul class="agent-list">
					{agents.map((a) => (
						<li key={a.name} class={`agent-item${a.name === selected ? " active" : ""}`} onClick={() => select(a)}>
							<div class="agent-item-head">
								<span class="agent-name">{a.name}</span>
								<span class="badge">{a.log}</span>
								{a.available === false ? <span class="badge badge-warn" title="命令不在 PATH 上，运行时该 agent 会被跳过">不可用</span> : null}
							</div>
							<div class="agent-desc muted">{a.description || a.command}</div>
						</li>
					))}
					{agents.length === 0 ? <li class="muted">（无配置 — 点「新建」从推荐示例开始）</li> : null}
				</ul>
				{draft ? (
					<div class="cli-agent-form">
						<label>
							名称（run_agent 的 type）
							<input value={draft.name} disabled={!!selected && agents.some((a) => a.name === selected)} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} placeholder="例如 claude-code" />
						</label>
						<label>
							说明
							<input value={draft.description ?? ""} onInput={(e) => setDraft({ ...draft, description: (e.target as HTMLInputElement).value })} placeholder="外部 Claude Code CLI（headless）" />
						</label>
						<label>
							命令（完整路径或 PATH 名）
							<input value={draft.command} onInput={(e) => setDraft({ ...draft, command: (e.target as HTMLInputElement).value })} placeholder="/opt/homebrew/bin/claude" />
						</label>
						<label>
							参数（每行一个，支持占位符）
							<textarea rows={8} spellcheck={false} value={draft.args.join("\n")} onInput={(e) => setArgv((e.target as HTMLTextAreaElement).value)} />
						</label>
						<label>
							进度日志格式
							<select value={draft.log} onChange={(e) => setDraft({ ...draft, log: (e.target as HTMLSelectElement).value })}>
								<option value="claude">claude（~/.claude/projects 的 session jsonl）</option>
								<option value="codex">codex（~/.codex/sessions 的 rollout jsonl）</option>
								<option value="none">none（不 tail，只看退出结果）</option>
							</select>
						</label>
						<label>
							固定模型（可选，传给 {"{model}"}
							）
							<input value={draft.model ?? ""} onInput={(e) => setDraft({ ...draft, model: (e.target as HTMLInputElement).value })} placeholder="留空跟随 CLI 自己的默认" />
						</label>
						<label>
							操作指令（前置进任务，作为给 CLI 的工作说明）
							<textarea rows={4} spellcheck={false} value={draft.instructions ?? ""} onInput={(e) => setDraft({ ...draft, instructions: (e.target as HTMLTextAreaElement).value })} />
						</label>
						<div class="agent-actions">
							<button class="small ghost" onClick={() => void remove()} disabled={busy || !selected}>
								删除
							</button>
							<button class="small" onClick={() => void save()} disabled={busy}>
								{busy ? "保存中…" : "保存"}
							</button>
						</div>
					</div>
				) : null}
			</div>
			{error ? <div class="settings-error">{error}</div> : null}
			{notice && !error ? <div class="settings-notice muted">{notice}</div> : null}
		</section>
	);
}

type Tab = "project" | "agents" | "other-agents" | "skills" | "plugins" | "tools" | "mcp" | "memory" | "keys";

const TABS: Array<{ id: Tab; label: string }> = [
	{ id: "project", label: "项目" },
	{ id: "agents", label: "Agent" },
	{ id: "other-agents", label: "Other Agent" },
	{ id: "skills", label: "Skill" },
	{ id: "plugins", label: "Plugin" },
	{ id: "tools", label: "Tool" },
	{ id: "mcp", label: "MCP" },
	{ id: "memory", label: "Memory" },
	{ id: "keys", label: "Keymap" },
];

/**
 * The one settings page. One tab per THING managed, singular labels — the
 * earlier "资产" tab held agents, skills, tools, plugins and MCP in one
 * column, and one thing per tab is what keeps each panel legible:
 *
 *   Other Agent  external agent CLIs (codex / claude …) as run_agent types —
 *           the cli-agents.json form editor.
 *   Agent / Skill / Plugin  the per-kind inventory — scope picker (全局 or a
 *                           project), enable/disable, create, edit
 *                           (copy-on-write, versioned), delete.
 *   Tool    the same tools from two angles FUSED into one master-detail view:
 *           the list row carries the enable checkbox, selecting it edits the
 *           model-facing prompt text beside it.
 *   MCP     server enable/disable (a disabled server is never connected) +
 *           the global mcp.json editor.
 *   Memory  what the agent has remembered; delete anything.
 *   Keymap  rebindable actions.
 *
 * It renders INSIDE the workspace beside the sidebar, like every other
 * app-level page, rather than covering the whole window.
 */
export function SettingsPage({ tab: initial }: { tab?: Tab }): preact.JSX.Element {
	const [tab, setTab] = useState<Tab>(initial ?? "agents");
	// The router can re-render this page with a different tab prop (hash
	// navigation); useState's initial value would ignore it and show the old tab.
	useEffect(() => {
		if (initial) setTab(initial);
	}, [initial]);
	return (
		<div class="settings">
			<div class="settings-tabs" role="tablist">
				{TABS.map((t) => (
					<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
						{t.label}
					</button>
				))}
			</div>
			<div class="settings-panel">
				{tab === "project" ? (
					<ProjectPanel />
				) : tab === "agents" ? (
					// The tab is the scroller; the panel sizes to its content.
					<div class="agents-tab">
						<AgentPromptsPanel />
					</div>
				) : tab === "other-agents" ? (
					<div class="agents-tab">
						<CliAgentsPanel />
					</div>
				) : tab === "skills" ? (
					<AssetsPanel which="skills" />
				) : tab === "plugins" ? (
					<AssetsPanel which="plugins" />
				) : tab === "tools" ? (
					<ToolsPanel />
				) : tab === "mcp" ? (
					<AssetsPanel which="mcp" />
				) : tab === "memory" ? (
					<MemoryPanel />
				) : (
					<KeysPanel />
				)}
			</div>
		</div>
	);
}

/**
 * Settings → Tool: the same tools from two angles, FUSED into one
 * master-detail view instead of an enable table stacked over a separate
 * prompt editor (two lists of the same tools is what made the old tab feel
 * disjointed).
 *
 * The list row carries the enable checkbox (registry state — a disabled tool
 * is dropped from the agent's toolset at next boot); selecting a row edits
 * the model-facing text beside it. The editable document is YAML frontmatter
 * (`snippet`, `guidelines`) plus a body that is the tool `description` sent
 * in the provider's schema; edits are copy-on-write into `tool_override/` and
 * apply to the orchestrator and every sub-agent alike.
 */
function ToolsPanel(): preact.JSX.Element {
	const [projects, setProjects] = useState<Project[] | null>(null);
	/** Scope for the enable toggles: "" = 全局 (same remembered key as the other asset tabs). */
	const [pid, setPid] = useState<string>("");
	const [tools, setTools] = useState<ToolPromptInfo[]>([]);
	const [inv, setInv] = useState<Record<string, InventoryItemWire>>({});
	const [selected, setSelected] = useState<string>("");
	const [draft, setDraft] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>("");
	const [notice, setNotice] = useState<string>("");

	const current = useMemo(() => tools.find((t) => t.name === selected), [tools, selected]);
	const dirty = current ? draft !== current.content : false;

	useEffect(() => {
		void api
			.listProjects()
			.then((ps) => {
				setProjects(ps);
				const saved = localStorage.getItem("admin-pid");
				setPid(saved !== null && ps.some((p) => p.id === saved) ? saved : "");
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	const reload = useCallback(
		async (keep?: string): Promise<void> => {
			setError("");
			try {
				const [list, inventory] = await Promise.all([api.listToolPrompts(), api.listInventory(pid)]);
				setTools(list);
				// Enable state comes from the inventory's builtin tools (MCP servers
				// are managed on the MCP tab).
				const byName: Record<string, InventoryItemWire> = {};
				for (const it of inventory.tools) if (it.source !== "mcp") byName[it.name] = it;
				setInv(byName);
				const next = list.find((t) => t.name === (keep ?? selected)) ?? list[0];
				setSelected(next?.name ?? "");
				setDraft(next?.content ?? "");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setTools([]);
			}
		},
		[pid], // eslint-disable-line react-hooks/exhaustive-deps
	);
	useEffect(() => {
		void reload();
	}, [reload]);

	const toggle = async (name: string, enabled: boolean): Promise<void> => {
		if (!enabled && !confirm(`禁用 ${name}?下次 agent 启动后生效。`)) return;
		setBusy(true);
		setError("");
		try {
			await api.toggleInventory(pid, "tools", name, enabled);
			setInv((prev) => ({
				...prev,
				[name]: { ...(prev[name] ?? { name, source: "builtin-tool", enabled: true, writable: false }), enabled },
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const select = (t: ToolPromptInfo): void => {
		if (dirty && !confirm("Discard unsaved changes to this tool prompt?")) return;
		setSelected(t.name);
		setDraft(t.content);
		setNotice("");
		setError("");
	};

	const save = async (): Promise<void> => {
		if (!current || !dirty) return;
		setBusy(true);
		setError("");
		try {
			const { path } = await api.saveToolPrompt(current.name, draft);
			setNotice(`Saved override → ${path}. New sessions pick it up; restart a running agent to apply it there.`);
			await reload(current.name);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const reset = async (): Promise<void> => {
		if (!current?.overridden) return;
		if (!confirm(`Delete the override for "${current.name}" and fall back to the built-in prompt?`)) return;
		setBusy(true);
		setError("");
		try {
			await api.resetToolPrompt(current.name);
			setNotice(`Override removed for "${current.name}".`);
			await reload(current.name);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const revertEdits = (): void => setDraft(current?.content ?? "");

	return (
		<div class="settings-panel">
			<div class="settings-head">
				<h2>Tool</h2>
				<label class="small">
					范围{" "}
					<select value={pid} onChange={(e) => setPid((e.target as HTMLSelectElement).value)}>
						<option value="">全局</option>
						{projects?.map((p) => (
							<option value={p.id}>{p.name}</option>
						))}
					</select>
				</label>
			</div>
			<p class="muted settings-hint">
				左列勾选启用（禁用的工具下次 agent 启动后从工具集里消失），点选名称在右侧编辑模型看到的说明文字：frontmatter 的{" "}
				<code>snippet</code> 和 <code>guidelines</code> 进入系统提示词，正文是工具 schema 里的 <code>description</code>。编辑以
				copy-on-write 写入 <code>tool_override/</code>；Reset 恢复内置。MCP 工具在 MCP 页管理。
			</p>

			<div class="settings-body">
				<ul class="agent-list">
					{tools.map((t) => {
						const enabled = inv[t.name]?.enabled ?? true;
						return (
							<li
								key={t.name}
								class={`agent-item${t.name === selected ? " active" : ""}${enabled ? "" : " off"}`}
								onClick={() => select(t)}
								title={t.path ?? "built-in"}
							>
								<div class="agent-item-head">
									<input
										type="checkbox"
										checked={enabled}
										title="启用/禁用(下次 agent 启动生效)"
										disabled={busy}
										onClick={(e) => e.stopPropagation()}
										onChange={(e) => void toggle(t.name, (e.target as HTMLInputElement).checked)}
									/>
									<span class="agent-name">{t.name}</span>
									{t.overridden ? <span class="badge badge-override">edited</span> : null}
									<span class="badge">{t.mode === "R" ? "read-only" : t.mode === "W" ? "mutating" : "rw"}</span>
									<span class="badge" title={t.scope === "dag" ? "默认不加载（能力已并入 run_agent）；对应的 CLOWNFISH_* 开关可恢复" : undefined}>{t.scope === "all" ? "全部" : t.scope === "assistant" ? "仅助理" : t.scope === "dag" ? "默认关闭" : "主 agent"}</span>
									{/* What this tool COSTS every request: schema + prompt text, estimated. */}
									<span class="badge" title={`schema ≈${t.schemaTokens ?? 0} tok + 提示词 ≈${t.promptTokens ?? 0} tok（估算）`}>
										~{(t.schemaTokens ?? 0) + (t.promptTokens ?? 0)} tok
									</span>
								</div>
								<div class="agent-desc muted">{t.snippet || "(no snippet)"}</div>
							</li>
						);
					})}
					{tools.length === 0 && !error ? <li class="muted">No tools found.</li> : null}
				</ul>

				<div class="tool-detail">
				<DocEditor
					caption={current ? (current.path ?? `${current.name} (built-in)`) : ""}
					title={current?.path ?? "defined in code"}
					selected={!!current}
					placeholder="Pick a tool to edit its prompt."
					draft={draft}
					onDraft={setDraft}
					error={error}
					notice={notice}
					actions={
						current ? (
							<>
								{dirty ? (
									<button class="small ghost" onClick={revertEdits} disabled={busy}>
										Revert
									</button>
								) : null}
								<button class="small ghost" onClick={() => void reset()} disabled={busy || !current.overridden}>
									Reset
								</button>
								<button class="small" onClick={() => void save()} disabled={busy || !dirty}>
									{busy ? "保存中…" : "保存"}
								</button>
							</>
						) : null
					}
				/>
				{/* The half of the prompt surface the editor does NOT own: the parameter
				    schema the provider is sent. Read-only, collapsed by default. */}
				{current?.schema ? (
					<details class="tool-schema">
						<summary>
							参数 schema（模型所见，只读）<span class="badge">≈{current.schemaTokens ?? 0} tok</span>
						</summary>
						<pre>{current.schema}</pre>
					</details>
				) : null}
				</div>
			</div>
		</div>
	);
}

/**
 * Settings → Keys: the shortcut table.
 *
 * Bindings live on the server (`<dataDir>/keybindings.json`, only the deviations)
 * so they follow the operator between browsers; the defaults stay in code and a
 * reset is deleting the entry. Rebinding is capture-based — click a row and press
 * the combination — because typing "Mod+Shift+K" by hand is how you end up with a
 * binding that never fires.
 */
/**
 * Per-project settings — today: the context-window budget. The config is
 * frozen into the worker's spawn env, so a change takes effect on the
 * session's NEXT worker spawn (idle reap → next prompt respawns), which the
 * panel says out loud rather than letting the operator assume it's live.
 */
function ProjectPanel(): preact.JSX.Element {
	const [projects, setProjects] = useState<Project[]>([]);
	const [pid, setPid] = useState<string>(() => localStorage.getItem("admin-pid") ?? "");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const load = useCallback(async () => {
		try {
			setProjects(await api.listProjects());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	const current = projects.find((p) => p.id === pid);
	const isAssistant = current?.id === "assistant";
	const setWindow = async (value: number | null): Promise<void> => {
		if (!current) return;
		setBusy(true);
		setError(undefined);
		try {
			const updated = await api.updateProject(current.id, { config: { contextWindow: value } });
			setProjects((list) => list.map((p) => (p.id === updated.id ? updated : p)));
			setNotice("已保存 — 在该会话下一次 worker 启动时生效（空闲回收后自动重启）。");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	const CHOICES = [128_000, 256_000, 512_000, 1_024_000];
	return (
		<div class="assets-panel">
			<div class="admin-toolbar">
				<label class="small">
					项目{" "}
					<select
						value={pid}
						onChange={(e) => {
							const v = (e.target as HTMLSelectElement).value;
							setPid(v);
							localStorage.setItem("admin-pid", v);
							setNotice(undefined);
						}}
					>
						<option value="">— 选择项目 —</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
			</div>
			{current && isAssistant ? (
				<p class="muted">我的助理 是内存合成的固定项目，暂不支持按项目设置。</p>
			) : current ? (
				<section class="admin-section project-settings">
					<div class="admin-section-head">
						<h2>上下文窗口</h2>
					</div>
						<p class="muted small">
							限制会话可用的上下文长度（token）。只会收紧、不会放宽模型自身的窗口；
							自动压缩在用量达到该值的 75% 时触发。改动在下一次 worker 启动时生效。
						</p>
						<div class="cw-choices">
							<label>
								<input type="radio" name="cw" checked={!current.config.contextWindow} disabled={busy} onChange={() => void setWindow(null)} />
								模型默认
							</label>
							{CHOICES.map((c) => (
								<label key={c}>
									<input type="radio" name="cw" checked={current.config.contextWindow === c} disabled={busy} onChange={() => void setWindow(c)} />
									{c / 1000}K
								</label>
							))}
						</div>
						<p class="muted small">
							当前模型：{current.config.provider}/{current.config.model}
						</p>
						{notice && <p class="notice">{notice}</p>}
				</section>
			) : (
				<p class="muted">选择一个项目以查看其设置。</p>
			)}
			{error && <div class="error">{error}</div>}
		</div>
	);
}

function KeysPanel(): preact.JSX.Element {
	const [rows, setRows] = useState<KeybindingInfo[]>([]);
	const [capturing, setCapturing] = useState<string>("");
	const [error, setError] = useState<string>("");
	const [notice, setNotice] = useState<string>("");

	const announce = (next: KeybindingInfo[]): void => {
		setRows(next);
		// Open chat tabs re-read their table on this, so a rebind takes effect
		// without a reload.
		window.dispatchEvent(new CustomEvent("clownfish:keybindings"));
	};

	useEffect(() => {
		void api
			.listKeybindings()
			.then(setRows)
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, []);

	// While a row is armed, the next keystroke becomes its binding.
	useEffect(() => {
		if (!capturing) return;
		const onKey = (e: KeyboardEvent): void => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setCapturing("");
				return;
			}
			const keys = bindingFromEvent(e);
			if (!keys) return; // a bare modifier — keep waiting for the real key
			const action = capturing;
			setCapturing("");
			setError("");
			void api
				.setKeybinding(action as KeybindingInfo["action"], keys)
				.then((r) => {
					announce(r.bindings);
					setNotice(`${action} → ${renderBinding(r.keys)}`);
				})
				.catch((err) => setError(err instanceof Error ? err.message : String(err)));
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [capturing]);

	const reset = (action: KeybindingInfo["action"]): void => {
		void api
			.resetKeybinding(action)
			.then((r) => {
				announce(r.bindings);
				setNotice(`${action} reset`);
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	};

	const resetAll = (): void => {
		if (!confirm("Reset every shortcut to its default?")) return;
		void api
			.resetAllKeybindings()
			.then((next) => {
				announce(next);
				setNotice("All shortcuts reset.");
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	};

	return (
		<div class="settings-panel">
			<div class="settings-head">
				<h2>快捷键</h2>
				<button class="small ghost" onClick={resetAll}>
					全部重置
				</button>
			</div>
			<p class="muted settings-hint">
				Click a shortcut and press the new combination (Esc cancels). <code>Mod</code> is ⌘ on macOS and Ctrl elsewhere, so
				one table fits both. Only your changes are stored — Reset restores the built-in binding.
			</p>
			<div class="keys-body">
				<table class="keys-table">
					<tbody>
						{rows.map((r) => (
							<tr key={r.action} class={r.conflictsWith ? "conflict" : ""}>
								<td class="keys-action">
									<div>{r.label}</div>
									<div class="muted small">{r.action}</div>
								</td>
								<td class="keys-binding">
									<button
										type="button"
										class={`key-cap${capturing === r.action ? " capturing" : ""}`}
										onClick={() => setCapturing(capturing === r.action ? "" : r.action)}
									>
										{capturing === r.action ? "按下新的组合…" : renderBinding(r.keys)}
									</button>
									{r.conflictsWith ? <span class="keys-warn">与 {r.conflictsWith.join(", ")} 冲突</span> : null}
								</td>
								<td class="keys-reset">
									{r.overridden ? (
										<button class="small ghost" onClick={() => reset(r.action)}>
											Reset
										</button>
									) : (
										<span class="muted small">default</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{error ? <div class="settings-error">{error}</div> : null}
			{notice && !error ? <div class="settings-notice muted">{notice}</div> : null}
		</div>
	);
}

