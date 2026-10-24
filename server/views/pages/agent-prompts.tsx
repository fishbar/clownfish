/**
 * Settings → Agent: the agent-prompt editor.
 *
 * Every discovered agent (built-in, global, project, plugin) is editable here,
 * built-ins included — that is the whole point: the prompts people most want
 * to tune are `system` / `coding` / `qa`, which ship with the package. Edits
 * are COPY-ON-WRITE through `/api/agent-prompts`: the save lands in
 * `<dataDir>/agent_overwrite/<name>.md` (the highest-precedence discovery
 * root), the source file is never touched, and 恢复默认 deletes the shadow.
 * Each save is versioned (newest 5 backups, kept even across a reset) and
 * hot-reloads live workers, so a running session uses the new prompt from its
 * next turn.
 *
 * Two editing modes over the same `.md` text:
 *   表单     the frontmatter's known keys as fields (description / access /
 *            model) + the prompt body; unknown keys are preserved verbatim.
 *   源文件   the whole file in one textarea — the escape hatch, and the only
 *            mode for frontmatter this simple parser does not understand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { AgentPromptInfo, FileVersionWire, InventoryItemWire, Project } from "../../protocol";
import { lineDiff, sourceChip } from "./admin";

/** What each built-in agent is FOR — the list shows it beside the name. */
const ROLE: Record<string, string> = {
	system: "主 agent · 编排",
	arch: "设计",
	coding: "实现",
	qa: "验证",
	assistant: "我的助理",
	"sys-compact": "上下文压缩",
	"sys-reflect": "记忆反思",
};

/** `{var}` placeholders renderPrompt substitutes (agent/agents/types.ts AgentPromptVars). */
const VARS: Array<{ key: string; hint: string }> = [
	{ key: "cwd", hint: "工作目录（子 agent 为其 worktree）" },
	{ key: "project", hint: "项目名" },
	{ key: "sessionId", hint: "会话 id" },
	{ key: "date", hint: "当天日期" },
	{ key: "os", hint: "操作系统" },
];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NEW_TEMPLATE = `---
description: 一句话说明这个 agent 的角色（run_agent 的可选列表里显示）
access: RW
---

You are a Clownfish specialist. You work in the workspace at \`{cwd}\` (project {project}).

`;

// --- frontmatter ----------------------------------------------------------

interface ParsedDoc {
	/** Frontmatter as ordered key/value pairs; null when the file has none. */
	fm: Array<[string, string]> | null;
	body: string;
	/** False when the frontmatter holds anything but flat `key: value` lines. */
	structured: boolean;
}

/** Split a `.md` agent file. Deliberately narrow: flat `key: value` lines
 *  only — anything richer (lists, nesting) marks the doc unstructured and the
 *  editor stays in 源文件 mode, so no key is ever lost in a round-trip. */
function parseDoc(content: string): ParsedDoc {
	if (!content.startsWith("---\n")) return { fm: null, body: content, structured: true };
	const end = content.indexOf("\n---", 4);
	if (end < 0) return { fm: null, body: content, structured: false };
	const lines = content.slice(4, end).split("\n");
	const fm: Array<[string, string]> = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
		if (!m) return { fm: null, body: content, structured: false };
		fm.push([m[1], m[2]]);
	}
	// Body = everything after the closing fence's line break.
	const after = content.indexOf("\n", end + 4);
	return { fm, body: after < 0 ? "" : content.slice(after + 1), structured: true };
}

function serializeDoc(fm: Array<[string, string]> | null, body: string): string {
	if (!fm || fm.length === 0) return body;
	return `---\n${fm.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
}

/** A YAML plain scalar breaks on `: `, ` #`, a leading indicator character or
 *  surrounding space — and a broken block silently loses EVERY key (the loader
 *  is total). Such values are written as JSON strings, which YAML reads as
 *  double-quoted scalars. */
function yamlScalar(value: string): string {
	return /: |\s#|:$|^[\s'"&*!|>%@`{}[\],?#-]|\s$/.test(value) ? JSON.stringify(value) : value;
}

function unquote(raw: string): string {
	const v = raw.trim();
	if (v.startsWith('"')) {
		try {
			return JSON.parse(v) as string;
		} catch {
			return v;
		}
	}
	if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
	return v;
}

/** Set (or, with an empty value, drop) one frontmatter key, keeping order. */
function setKey(fm: Array<[string, string]> | null, key: string, value: string): Array<[string, string]> {
	const list = [...(fm ?? [])];
	const i = list.findIndex(([k]) => k === key);
	const v = value.trim() ? yamlScalar(value.trim()) : "";
	if (!v) return i < 0 ? list : list.filter((_, j) => j !== i);
	if (i < 0) list.push([key, v]);
	else list[i] = [key, v];
	return list;
}

const getKey = (fm: Array<[string, string]> | null, key: string): string => unquote(fm?.find(([k]) => k === key)?.[1] ?? "");

/** lineDiff with unchanged runs folded to 3 lines of context on each side —
 *  a one-word edit to a 7 KB prompt should not print the whole prompt. */
type DiffRow = { mark: " " | "-" | "+"; text: string } | { fold: number };
function foldedDiff(a: string, b: string): DiffRow[] {
	const rows = lineDiff(a, b);
	const near = rows.map(() => false);
	rows.forEach((r, i) => {
		if (r.mark === " ") return;
		for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) near[j] = true;
	});
	const out: DiffRow[] = [];
	let skipped = 0;
	rows.forEach((r, i) => {
		if (near[i]) {
			if (skipped) out.push({ fold: skipped });
			skipped = 0;
			out.push(r);
		} else skipped++;
	});
	if (skipped) out.push({ fold: skipped });
	return out;
}

/** Rough request cost: CJK ≈ 1 token per char, everything else ≈ 4 chars/token. */
function estimateTokens(text: string): number {
	const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
	return Math.round(cjk + (text.length - cjk) / 4);
}

// --- panel ------------------------------------------------------------------

interface DiffView {
	label: string;
	/** The "-" side; the current draft is always the "+" side. */
	base: string;
}

export function AgentPromptsPanel(): preact.JSX.Element {
	const [projects, setProjects] = useState<Project[] | null>(null);
	const [pid, setPid] = useState<string>("");
	const [agents, setAgents] = useState<AgentPromptInfo[]>([]);
	const [enabled, setEnabled] = useState<Record<string, InventoryItemWire>>({});
	const [selected, setSelected] = useState<string>("");
	/** A not-yet-saved new agent (its name is not in `agents`). */
	const [fresh, setFresh] = useState<string>("");
	const [draft, setDraft] = useState<string>("");
	const [mode, setMode] = useState<"form" | "raw">("form");
	const [versions, setVersions] = useState<FileVersionWire[]>([]);
	const [diff, setDiff] = useState<DiffView | null>(null);
	const [creating, setCreating] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const textRef = useRef<HTMLTextAreaElement>(null);

	const current = useMemo(() => agents.find((a) => a.name === selected), [agents, selected]);
	const savedContent = current?.content ?? (fresh === selected ? "" : "");
	const dirty = selected !== "" && (fresh === selected || draft !== savedContent);
	const parsed = useMemo(() => parseDoc(draft), [draft]);
	const formOk = parsed.structured;
	const effectiveMode = formOk ? mode : "raw";

	const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));

	useEffect(() => {
		void api
			.listProjects()
			.then((ps) => {
				setProjects(ps);
				const saved = localStorage.getItem("admin-pid");
				setPid(saved !== null && ps.some((p) => p.id === saved) ? saved : "");
			})
			.catch(fail);
	}, []);

	const loadVersions = useCallback(async (name: string): Promise<void> => {
		try {
			setVersions((await api.listAgentPromptVersions(name)).versions);
		} catch {
			setVersions([]);
		}
	}, []);

	const reload = useCallback(
		async (keep?: string): Promise<void> => {
			try {
				const [list, inv] = await Promise.all([api.listAgentPrompts(pid || undefined), api.listInventory(pid)]);
				// Orchestrator first, then the delegatable specialists, internal last.
				list.sort((a, b) => Number(a.internal) - Number(b.internal) || Number(b.name === "system") - Number(a.name === "system") || a.name.localeCompare(b.name));
				setAgents(list);
				setEnabled(Object.fromEntries(inv.agents.map((it) => [it.name, it])));
				const pick = list.find((a) => a.name === (keep ?? selected)) ?? list[0];
				setSelected(pick?.name ?? "");
				setDraft(pick?.content ?? "");
				setFresh("");
				setDiff(null);
				if (pick) void loadVersions(pick.name);
				setError("");
			} catch (err) {
				fail(err);
			}
		},
		[pid, loadVersions], // eslint-disable-line react-hooks/exhaustive-deps
	);
	useEffect(() => {
		if (projects !== null) void reload();
	}, [projects, reload]);

	const confirmDiscard = (): boolean => !dirty || confirm(`「${selected}」有未保存的修改，放弃吗？`);

	const select = (a: AgentPromptInfo): void => {
		if (a.name === selected || !confirmDiscard()) return;
		setSelected(a.name);
		setDraft(a.content);
		setFresh("");
		setDiff(null);
		setNotice("");
		setError("");
		void loadVersions(a.name);
	};

	const changeScope = (next: string): void => {
		if (!confirmDiscard()) return;
		localStorage.setItem("admin-pid", next);
		setPid(next);
	};

	const save = async (): Promise<void> => {
		if (!dirty || busy || !selected) return;
		if (!draft.trim()) return setError("prompt 不能为空");
		setBusy(true);
		setError("");
		try {
			await api.saveAgentPrompt(selected, draft);
			await reload(selected);
			setNotice("已保存 — 源文件未改动；运行中的会话从下一轮起使用新 prompt。");
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	};

	const reset = async (): Promise<void> => {
		if (!current?.overridden) return;
		const custom = !current.baseSource;
		const q = custom
			? `删除自定义 agent「${current.name}」？（历史版本保留，可从下方恢复）`
			: `恢复「${current.name}」的默认 prompt（${sourceChip(current.baseSource ?? "")}）？你的修改会保留在历史版本里。`;
		if (!confirm(q)) return;
		setBusy(true);
		try {
			await api.resetAgentPrompt(current.name);
			await reload(custom ? undefined : current.name);
			setNotice(custom ? `已删除「${current.name}」。` : "已恢复默认。");
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	};

	const restore = async (version: string): Promise<void> => {
		if (!selected || !confirmDiscard()) return;
		if (!confirm(`用备份 ${version} 覆盖当前 prompt？当前内容会先备份。`)) return;
		setBusy(true);
		try {
			await api.rollbackAgentPrompt(selected, version);
			await reload(selected);
			setNotice(`已恢复到 ${version}。`);
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	};

	const showVersion = async (version: string): Promise<void> => {
		try {
			const { content } = await api.getAgentPromptVersion(selected, version);
			setDiff({ label: `备份 ${version}`, base: content });
		} catch (err) {
			fail(err);
		}
	};

	const startCreate = (): void => {
		if (!confirmDiscard()) return;
		setCreating("");
		setError("");
	};
	const submitCreate = (): void => {
		const name = (creating ?? "").trim();
		if (!NAME_RE.test(name)) return setError("名称只能用字母、数字、- 和 _，且以字母或数字开头");
		if (agents.some((a) => a.name === name)) return setError(`已存在名为「${name}」的 agent`);
		setCreating(null);
		setSelected(name);
		setFresh(name);
		setDraft(NEW_TEMPLATE);
		setVersions([]);
		setDiff(null);
		setMode("form");
		setError("");
		setNotice("新 agent 尚未保存 — 编辑后点「保存」创建。");
	};

	const toggle = async (name: string, on: boolean): Promise<void> => {
		if (!on && !confirm(`禁用 ${name}？禁用后不会出现在 run_agent 的可选列表里。`)) return;
		try {
			await api.toggleInventory(pid, "agents", name, on);
			setEnabled((prev) => ({ ...prev, [name]: { ...(prev[name] ?? { name, source: "", writable: false, enabled: on }), enabled: on } }));
		} catch (err) {
			fail(err);
		}
	};

	/** Form-mode edits rebuild the whole file from fields + body. */
	const setField = (key: string, value: string): void => setDraft(serializeDoc(setKey(parsed.fm, key, value), parsed.body));
	const setBody = (body: string): void => setDraft(serializeDoc(parsed.fm, body));

	const insertVar = (key: string): void => {
		const el = textRef.current;
		const token = `{${key}}`;
		if (!el) return;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		const next = el.value.slice(0, start) + token + el.value.slice(end);
		if (effectiveMode === "form") setBody(next);
		else setDraft(next);
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(start + token.length, start + token.length);
		});
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			void save();
		}
	};

	const diffRows = useMemo(() => (diff ? foldedDiff(diff.base, draft) : []), [diff, draft]);
	const delegatable = agents.filter((a) => !a.internal);
	const internal = agents.filter((a) => a.internal);
	const isFresh = fresh !== "" && fresh === selected;
	const knownKeys = new Set(["description", "access", "model"]);
	const otherKeys = (parsed.fm ?? []).filter(([k]) => !knownKeys.has(k));

	const item = (a: AgentPromptInfo): preact.JSX.Element => {
		const on = enabled[a.name]?.enabled ?? true;
		return (
			<li key={a.name} class={`agent-item${a.name === selected ? " active" : ""}${on ? "" : " off"}`} onClick={() => select(a)} title={a.path}>
				<div class="agent-item-head">
					{!a.internal && a.name !== "system" && (
						<input
							type="checkbox"
							checked={on}
							title="启用 / 禁用（禁用后不可被 run_agent 委派）"
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => void toggle(a.name, (e.target as HTMLInputElement).checked)}
						/>
					)}
					<span class="agent-name">{a.name}</span>
					{ROLE[a.name] && <span class="badge">{ROLE[a.name]}</span>}
					{a.overridden && <span class="badge badge-override">{a.baseSource ? "已修改" : "自定义"}</span>}
				</div>
				<div class="agent-desc muted">{a.description || "（无说明）"}</div>
				<div class="agent-source muted">
					{sourceChip(a.overridden ? a.baseSource ?? "override" : a.source)}
					{a.access === "R" ? " · 只读" : ""}
				</div>
			</li>
		);
	};

	return (
		<section class="admin-section agent-prompts" onKeyDown={onKeyDown}>
			<div class="admin-section-head">
				<h2>Agent prompt</h2>
				<div class="admin-actions">
					<label class="small">
						范围{" "}
						<select value={pid} onChange={(e) => changeScope((e.target as HTMLSelectElement).value)}>
							<option value="">全局</option>
							{projects?.map((p) => (
								<option value={p.id}>{p.name}</option>
							))}
						</select>
					</label>
					<button class="small" onClick={startCreate}>
						+ 新建
					</button>
				</div>
			</div>
			<p class="muted settings-hint">
				所有 agent（含内置）都可以改。修改以 copy-on-write 保存到 <code>agent_overwrite/</code>，源文件不动；「恢复默认」删除修改版。
				每次保存自动备份（保留最近 5 个，恢复默认后仍在），并通知运行中的会话从下一轮起生效。范围只决定列出哪些项目级 agent，修改对所有项目生效。
			</p>
			{creating !== null && (
				<div class="ap-create">
					<input
						autoFocus
						placeholder="新 agent 名称，例如 reviewer（即 run_agent 的 type）"
						value={creating}
						onInput={(e) => setCreating((e.target as HTMLInputElement).value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submitCreate();
							if (e.key === "Escape") setCreating(null);
						}}
					/>
					<button class="small" onClick={submitCreate}>
						创建
					</button>
					<button class="small ghost" onClick={() => setCreating(null)}>
						取消
					</button>
				</div>
			)}
			{error && <div class="settings-error">{error}</div>}

			<div class="settings-body ap-body">
				<ul class="agent-list">
					{isFresh && (
						<li class="agent-item active">
							<div class="agent-item-head">
								<span class="agent-name">{fresh}</span>
								<span class="badge badge-override">未保存</span>
							</div>
						</li>
					)}
					{delegatable.map(item)}
					{internal.length > 0 && <li class="ap-group muted">内部 agent（框架调用，不可委派）</li>}
					{internal.map(item)}
				</ul>

				{selected ? (
					<div class="agent-editor ap-editor">
						<div class="ap-toolbar">
							<div class="ap-title">
								<span class="agent-name">{selected}</span>
								{dirty && <span class="admin-dirty">未保存</span>}
								{current && <span class="agent-path" title={current.path}>{current.path}</span>}
							</div>
							<div class="agent-actions">
								<div class="ap-mode" role="tablist">
									<button type="button" class={effectiveMode === "form" ? "on" : ""} disabled={!formOk} title={formOk ? undefined : "frontmatter 含复杂结构，只能用源文件模式编辑"} onClick={() => setMode("form")}>
										表单
									</button>
									<button type="button" class={effectiveMode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>
										源文件
									</button>
								</div>
							</div>
						</div>

						{effectiveMode === "form" && (
							<div class="ap-fields">
								<label class="ap-wide">
									<span>说明（主 agent 选择委派对象时看到）</span>
									<input value={getKey(parsed.fm, "description")} onInput={(e) => setField("description", (e.target as HTMLInputElement).value)} />
								</label>
								<label>
									<span>工具权限（作为子 agent 时）</span>
									<select value={getKey(parsed.fm, "access") || "RW"} onChange={(e) => setField("access", (e.target as HTMLSelectElement).value === "RW" ? "" : "R")}>
										<option value="RW">读写（RW）</option>
										<option value="R">只读（R）</option>
									</select>
								</label>
								<label>
									<span>固定模型（可选）</span>
									<input value={getKey(parsed.fm, "model")} placeholder="留空跟随会话模型" onInput={(e) => setField("model", (e.target as HTMLInputElement).value)} />
								</label>
								{otherKeys.length > 0 && (
									<div class="ap-wide muted small">
										其他 frontmatter（原样保留，切到源文件模式可改）：
										{otherKeys.map(([k, v]) => (
											<code key={k} class="ap-key">
												{k}: {v}
											</code>
										))}
									</div>
								)}
							</div>
						)}

						<div class="ap-vars">
							<span class="muted small">插入占位符：</span>
							{VARS.map((v) => (
								<button key={v.key} type="button" class="ap-var" title={v.hint} onClick={() => insertVar(v.key)}>
									{`{${v.key}}`}
								</button>
							))}
							<span class="muted small ap-count">
								{draft.length} 字符 · ≈{estimateTokens(effectiveMode === "form" ? parsed.body : draft)} tokens
							</span>
						</div>

						<textarea
							ref={textRef}
							class="agent-textarea ap-text"
							spellcheck={false}
							value={effectiveMode === "form" ? parsed.body : draft}
							onInput={(e) => {
								const v = (e.target as HTMLTextAreaElement).value;
								if (effectiveMode === "form") setBody(v);
								else setDraft(v);
							}}
						/>

						<div class="ap-actions">
							<button class="small" disabled={!dirty || busy} onClick={() => void save()} title="⌘/Ctrl + S">
								{busy ? "保存中…" : isFresh ? "创建" : "保存"}
							</button>
							<button class="small ghost" disabled={!dirty || busy} onClick={() => (isFresh ? (setSelected(agents[0]?.name ?? ""), setDraft(agents[0]?.content ?? ""), setFresh(""), setNotice("")) : setDraft(savedContent))}>
								{isFresh ? "取消" : "撤销修改"}
							</button>
							{current?.overridden && current.baseContent !== undefined && (
								<button class="small ghost" onClick={() => setDiff(diff?.label === "默认版本" ? null : { label: "默认版本", base: current.baseContent ?? "" })}>
									{diff?.label === "默认版本" ? "关闭对比" : "与默认对比"}
								</button>
							)}
							{dirty && !isFresh && (
								<button class="small ghost" onClick={() => setDiff(diff?.label === "已保存版本" ? null : { label: "已保存版本", base: savedContent })}>
									{diff?.label === "已保存版本" ? "关闭对比" : "查看改动"}
								</button>
							)}
							<span class="ap-spacer" />
							{current?.overridden && (
								<button class="small ghost ap-danger" disabled={busy} onClick={() => void reset()}>
									{current.baseSource ? "恢复默认" : "删除"}
								</button>
							)}
						</div>
						{notice && !error && <div class="settings-notice muted">{notice}</div>}

						{diff && (
							<div class="ap-diff">
								<div class="muted small">
									{diff.label}（<code>-</code>）→ 当前编辑内容（<code>+</code>）
								</div>
								<pre>
									{diffRows.length === 1 && "fold" in diffRows[0] ? (
										<span class="fold">没有差异</span>
									) : (
										diffRows.map((l, i) =>
											"fold" in l ? (
												<span key={i} class="fold">
													… {l.fold} 行未改动 …
												</span>
											) : (
												<span key={i} class={l.mark === "+" ? "add" : l.mark === "-" ? "del" : "ctx"}>
													{l.mark} {l.text}
												</span>
											),
										)
									)}
								</pre>
							</div>
						)}

						{!isFresh && (
							<div class="ap-versions">
								<div class="muted small">历史版本（每次保存前自动备份，保留最近 5 个）</div>
								{versions.length === 0 ? (
									<div class="muted small">暂无 — 保存过两次后这里会出现上一次的内容。</div>
								) : (
									versions.map((v) => (
										<div class="admin-version-row" key={v.version}>
											<code>{v.version}</code>
											<span class="muted tiny">{v.size} B</span>
											<button class="small ghost" onClick={() => void showVersion(v.version)}>
												对比
											</button>
											<button class="small ghost" disabled={busy} onClick={() => void restore(v.version)}>
												恢复
											</button>
										</div>
									))
								)}
							</div>
						)}
					</div>
				) : (
					<div class="muted">没有可编辑的 agent。</div>
				)}
			</div>
		</section>
	);
}
