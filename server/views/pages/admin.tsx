/**
 * Assets — the per-project inventory of agents, skills, tools and plugins, and
 * the global MCP config. One tab of the settings page.
 *
 * This used to be a separate "管理" page beside "设置", split by who wrote it
 * rather than by what it does; the two overlapped (both edited agent prompts).
 * Merged: this inventory is the body — per project, enable/disable, create and
 * delete, version history and rollback — and the settings page's own tabs
 * (tool prompt text, keybindings, memory) sit beside it.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { FileVersionWire, InventoryItemWire, InventoryWire, Project } from "../../protocol";

type DocKind = "agents" | "skills";
type AnyKind = DocKind | "tools" | "plugins";

const SOURCE_LABEL: Record<string, string> = {
	builtin: "内置",
	global: "全局",
	project: "项目",
	"builtin-tool": "内置",
	mcp: "MCP",
};

export function sourceChip(source: string): string {
	if (source.startsWith("plugin:")) return `插件 ${source.slice("plugin:".length)}`;
	return SOURCE_LABEL[source] ?? source;
}

/** Tiny unified line diff (LCS) — prompt files are small, O(n·m) is fine. */
export function lineDiff(a: string, b: string): Array<{ mark: " " | "-" | "+"; text: string }> {
	const A = a.split("\n");
	const B = b.split("\n");
	const n = A.length;
	const m = B.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	}
	const out: Array<{ mark: " " | "-" | "+"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (A[i] === B[j]) {
			out.push({ mark: " ", text: A[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ mark: "-", text: A[i++] });
		} else {
			out.push({ mark: "+", text: B[j++] });
		}
	}
	while (i < n) out.push({ mark: "-", text: A[i++] });
	while (j < m) out.push({ mark: "+", text: B[j++] });
	return out;
}

interface EditorState {
	kind: DocKind;
	name: string;
	content: string;
	/** Content when loaded / last saved — the diff base. */
	saved: string;
	versions: FileVersionWire[];
	/** Currently inspected version + its content (diff target). */
	inspect?: { version: string; content: string };
}

/**
 * The asset inventory, one section per settings tab (Agent / Skill / Plugin /
 * MCP). The scope picker decides what discovery runs against: a project's own
 * tree, or 全局 (`pid = ""` → `/api/inventory`, builtin + global assets only).
 * The state is one whole (one inventory fetch, one MCP draft) — only the
 * RENDERED section changes per tab, so switching is cheap and the picker keeps
 * its selection.
 */
export function AssetsPanel({ which }: { which: "agents" | "skills" | "plugins" | "mcp" }): preact.JSX.Element {
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [pid, setPid] = useState<string>("");
	const [inv, setInv] = useState<InventoryWire | null>(null);
	const [error, setError] = useState<string>();
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [mcpDraft, setMcpDraft] = useState<string>("");
	const [mcpDirty, setMcpDirty] = useState(false);
	const [creating, setCreating] = useState<{ kind: "agents" | "skills" | "plugins"; name: string; content: string } | null>(null);

	// Scope picker: remembered in localStorage. The empty pid (全局) is a legal,
	// remembered value — getItem distinguishing "" from null is what keeps it.
	useEffect(() => {
		void api
			.listProjects()
			.then((ps) => {
				setProjects(ps);
				const saved = localStorage.getItem("admin-pid");
				setPid(saved !== null && ps.some((p) => p.id === saved) ? saved : "");
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, []);
	useEffect(() => {
		localStorage.setItem("admin-pid", pid);
	}, [pid]);

	const reload = useCallback(async (): Promise<void> => {
		try {
			setInv(await api.listInventory(pid));
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [pid]);
	useEffect(() => {
		setEditor(null);
		setCreating(null);
		void reload();
	}, [reload]);

	const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));

	const toggle = async (kind: AnyKind, name: string, enabled: boolean): Promise<void> => {
		if (!enabled && !confirm(`禁用 ${kind}/${name}?下次 agent 启动后生效。`)) return;
		try {
			await api.toggleInventory(pid, kind, name, enabled);
			await reload();
		} catch (e) {
			fail(e);
		}
	};

	const openDoc = async (kind: DocKind, name: string): Promise<void> => {
		try {
			const [{ content }, { versions }] = await Promise.all([api.getInventoryDoc(pid, kind, name), api.listInventoryVersions(pid, kind, name)]);
			setEditor({ kind, name, content, saved: content, versions, inspect: undefined });
			setCreating(null);
		} catch (e) {
			fail(e);
		}
	};

	const saveDoc = async (): Promise<void> => {
		if (!editor) return;
		try {
			await api.putInventoryDoc(pid, editor.kind, editor.name, editor.content);
			const { versions } = await api.listInventoryVersions(pid, editor.kind, editor.name);
			setEditor({ ...editor, saved: editor.content, versions, inspect: undefined });
			await reload();
		} catch (e) {
			fail(e);
		}
	};

	const rollback = async (version: string): Promise<void> => {
		if (!editor) return;
		if (!confirm(`回滚到 ${version}?当前内容会先自动备份。`)) return;
		try {
			const { content } = await api.rollbackInventory(pid, editor.kind, editor.name, version);
			const { versions } = await api.listInventoryVersions(pid, editor.kind, editor.name);
			setEditor({ ...editor, content, saved: content, versions, inspect: undefined });
			await reload();
		} catch (e) {
			fail(e);
		}
	};

	const inspectVersion = async (version: string): Promise<void> => {
		if (!editor) return;
		try {
			const { content } = await api.getInventoryVersion(pid, editor.kind, editor.name, version);
			setEditor({ ...editor, inspect: { version, content } });
		} catch (e) {
			fail(e);
		}
	};

	const remove = async (kind: "agents" | "skills" | "plugins", name: string): Promise<void> => {
		if (!confirm(`删除 ${kind}/${name}?文件会从磁盘移除(含历史版本)。`)) return;
		try {
			await api.deleteInventory(pid, kind, name);
			if (editor && editor.kind === kind && editor.name === name) setEditor(null);
			await reload();
		} catch (e) {
			fail(e);
		}
	};

	const submitCreate = async (): Promise<void> => {
		if (!creating) return;
		try {
			if (creating.kind === "plugins") await api.createInventoryPlugin(pid, creating.name);
			else if (creating.kind === "agents") await api.createInventoryAgent(pid, creating.name, creating.content);
			else await api.createInventorySkill(pid, creating.name, creating.content);
			setCreating(null);
			await reload();
		} catch (e) {
			fail(e);
		}
	};

	const loadMcp = useCallback(async (): Promise<void> => {
		try {
			const { content } = await api.getMcpConfig(pid);
			setMcpDraft(content ?? "");
			setMcpDirty(false);
		} catch (e) {
			fail(e);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pid]);
	useEffect(() => {
		if (pid) void loadMcp();
	}, [pid, loadMcp]);

	const saveMcp = async (): Promise<void> => {
		try {
			await api.putMcpConfig(pid, mcpDraft);
			setMcpDirty(false);
			await reload(); // server list may have changed
		} catch (e) {
			fail(e);
		}
	};

	if (projects === null) return <div class="muted small pad">加载中…</div>;

	const dirty = editor !== null && editor.content !== editor.saved;

	/** One inventory table. `docs` enables the 编辑 column (agents/skills). */
	const section = (title: string, kind: AnyKind, items: InventoryItemWire[] | undefined, docs: boolean): preact.JSX.Element => (
		<section class="admin-section" key={title}>
			<div class="admin-section-head">
				<h2>{title}</h2>
				{(kind === "agents" || kind === "skills" || kind === "plugins") && (
					<button class="small" onClick={() => setCreating({ kind, name: "", content: kind === "plugins" ? "" : (kind === "agents" ? "---\ndescription: \n---\n\n" : "---\nname: \ndescription: \n---\n\n") })}>
						+ 新建
					</button>
				)}
			</div>
			{items === undefined ? (
				<div class="muted small">加载中…</div>
			) : items.length === 0 ? (
				<div class="muted small">无</div>
			) : (
				<table class="admin-table">
					<thead>
						<tr>
							<th>名称</th>
							<th class="hide-narrow">来源</th>
							<th class="hide-narrow">说明</th>
							<th>启用</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{items.map((it) => (
							<tr key={it.name} class={it.enabled ? "" : "off"}>
								<td title={it.path}>{it.name}</td>
								<td class="hide-narrow">
									<span class="chip">{sourceChip(it.source)}</span>
								</td>
								<td class="muted small hide-narrow">{it.description ?? ""}</td>
								<td>
									<input
										type="checkbox"
										checked={it.enabled}
										onChange={(e) => void toggle(kind, it.name, (e.target as HTMLInputElement).checked)}
									/>
								</td>
								<td class="admin-row-actions">
									{docs && (
										<button class="small" onClick={() => void openDoc(kind as DocKind, it.name)} disabled={!it.writable}>
											编辑
										</button>
									)}
									{(kind === "plugins" || docs) && it.writable && (
										<button class="small danger" onClick={() => void remove(kind as "agents" | "skills" | "plugins", it.name)}>
											删除
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);

	const DOC_TABS = which === "agents" || which === "skills";
	return (
		<div class="assets-panel">
				<div class="admin-toolbar">
					<label class="small">
						范围{" "}
						<select value={pid} onChange={(e) => setPid((e.target as HTMLSelectElement).value)}>
							{/* 全局 first: discovery against dataDir — builtin + global assets,
							    no project tree. "" is a legal, remembered value. */}
							<option value="">全局</option>
							{projects.map((p) => (
								<option value={p.id}>{p.name}</option>
							))}
						</select>
					</label>
					<span class="muted small">改动在 agent 下次启动时生效(空闲 worker 已被自动重启)。</span>
				</div>
				{error && <div class="error">{error}</div>}

				{DOC_TABS && creating && (
					<section class="admin-section creating">
						<h2>新建 {creating.kind === "agents" ? "agent prompt" : creating.kind === "skills" ? "skill" : "plugin"}</h2>
						<div class="admin-create">
							<input placeholder="名称 (字母/数字/._-)" value={creating.name} onInput={(e) => setCreating({ ...creating, name: (e.target as HTMLInputElement).value })} />
							{creating.kind !== "plugins" && (
								<textarea
									rows={8}
									placeholder={creating.kind === "agents" ? "agent prompt 内容(可用 YAML frontmatter + 模板)" : "SKILL.md 内容"}
									value={creating.content}
									onInput={(e) => setCreating({ ...creating, content: (e.target as HTMLTextAreaElement).value })}
								/>
							)}
							<div class="admin-actions">
								<button class="primary" disabled={creating.name.trim() === ""} onClick={() => void submitCreate()}>
									创建
								</button>
								<button onClick={() => setCreating(null)}>取消</button>
							</div>
						</div>
					</section>
				)}

				{DOC_TABS && editor && (
					<section class="admin-section editor">
						<div class="admin-section-head">
							<h2>
								编辑 {editor.kind === "agents" ? "agent" : "skill"} · {editor.name}
								{dirty && <span class="admin-dirty">未保存</span>}
							</h2>
							<div class="admin-actions">
								<button class="primary" disabled={!dirty} onClick={() => void saveDoc()}>
									保存(自动备份)
								</button>
								<button onClick={() => setEditor(null)}>关闭</button>
							</div>
						</div>
						<textarea
							class="admin-editor"
							value={editor.content}
							onInput={(e) => setEditor({ ...editor, content: (e.target as HTMLTextAreaElement).value })}
							spellcheck={false}
						/>
						<div class="admin-versions">
							<h3>历史版本(保留最近 5 个)</h3>
							{editor.versions.length === 0 && <div class="muted small">暂无 — 保存一次后当前内容会作为第一个备份。</div>}
							{editor.versions.map((v) => (
								<div class="admin-version-row" key={v.version}>
									<code>{v.version}</code>
									<span class="muted tiny">{v.size} B</span>
									<button class="small" onClick={() => void inspectVersion(v.version)}>
										{editor.inspect?.version === v.version ? "刷新对比" : "对比"}
									</button>
									<button class="small" onClick={() => void rollback(v.version)}>
										回滚
									</button>
								</div>
							))}
							{editor.inspect && (
								<div class="admin-diff">
									<div class="muted small">
										当前编辑内容(<code>+</code>) vs 备份 {editor.inspect.version}(<code>-</code>):
									</div>
									<pre>
										{lineDiff(editor.inspect.content, editor.content).map((l, i) => (
											<span key={i} class={`diff-${l.mark === " " ? "ctx" : l.mark}`}>
												{l.mark}
												{l.text}
												{"\n"}
											</span>
										))}
									</pre>
								</div>
							)}
						</div>
					</section>
				)}

				{which === "agents" && section("Agent prompt", "agents", inv?.agents, true)}
				{which === "skills" && section("Skill", "skills", inv?.skills, true)}
				{which === "plugins" && section("Plugin", "plugins", inv?.plugins, false)}
				{which === "mcp" && section("MCP 服务器", "tools", inv?.tools?.filter((t) => t.source === "mcp"), false)}

				{which === "mcp" && (
				<section class="admin-section">
					<div class="admin-section-head">
						<h2>MCP 全局配置(mcp.json)</h2>
						<div class="admin-actions">
							<button class="primary" disabled={!mcpDirty} onClick={() => void saveMcp()}>
								保存
							</button>
							<button onClick={() => void loadMcp()}>重载</button>
						</div>
					</div>
					<textarea
						class="admin-editor json"
						placeholder='{ "mcpServers": { … } }'
						value={mcpDraft}
						onInput={(e) => {
							setMcpDraft((e.target as HTMLTextAreaElement).value);
							setMcpDirty(true);
						}}
						spellcheck={false}
					/>
					<div class="muted tiny">保存前会做 JSON 校验;项目级 .mcp.json 需在项目里设置 CLOWNFISH_MCP_PROJECT=1 信任后才生效,不在此编辑。</div>
				</section>
				)}
		</div>
	);
}
