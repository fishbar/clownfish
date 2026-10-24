import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { navigate } from "../router";
import type { Project, SessionMeta, SessionBackend, PathSuggestion } from "../../protocol";
import { ASSISTANT_PROJECT_ID } from "../../protocol";
import type { AgentStatus } from "../api";
import { IconBrain, IconSliders, IconPlus, IconX, IconPencil, IconTrash, IconCaret, IconFolder, IconTerminal, IconClaude, IconCodex, IconMore, IconStop } from "../icons";

/** CLI presets the new-session dialog offers — prefills command/label; "自定义" leaves command editable. */
const CLI_PRESETS: Array<{ key: string; label: string; command: string }> = [
	{ key: "codex", label: "Codex", command: "codex" },
	{ key: "claude", label: "Claude Code", command: "claude" },
	{ key: "custom", label: "自定义命令", command: "" },
];

/** The session-row icon for a CLI-backed session: the CLI's own mark when it
 *  is Codex or Claude Code (the dialog's preset, or — for a custom command —
 *  the executable's basename), a generic terminal otherwise. */
function CliIcon({ backend }: { backend: Extract<SessionBackend, { kind: "cli" }> }): preact.JSX.Element {
	const bin = backend.command.split("/").pop() ?? "";
	const which = backend.preset ?? (bin === "codex" ? "codex" : bin === "claude" ? "claude" : undefined);
	if (which === "claude") return <IconClaude />;
	if (which === "codex") return <IconCodex />;
	return <IconTerminal />;
}

/** Per-session worker state shown as a colored dot in the tree. */
type SessionDot = "idle" | "connecting" | "ready" | "busy";

/** Sidebar width bounds (desktop resizer). */
const DEFAULT_SIDEBAR_W = 220;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 520;
const clampSidebarW = (x: number): number => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, x));
/** Latest pointer x during a drag (persists across re-renders for mouseup). */
const lastXRef = { current: 0 };

function timeStr(ms: number): string {
	return new Date(ms).toLocaleString();
}

/**
 * ProjectTree — the left pane of the single-page shell.
 *
 * A collapsible tree of every project and its sessions (sessions load lazily on
 * first expand and are cached). Selection is pure routing: clicking a session
 * sets the hash and the shell renders the matching chat. The active session's
 * project auto-expands so the selection stays visible.
 */
export function ProjectTree({
	activeProjectId,
	activeSessionId,
	drawerOpen,
}: {
	activeProjectId?: string;
	activeSessionId?: string;
	drawerOpen?: boolean;
}): preact.JSX.Element {
	const [projects, setProjects] = useState<Project[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [sessions, setSessions] = useState<Record<string, SessionMeta[]>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [path, setPath] = useState("");
	const [statuses, setStatuses] = useState<Record<string, SessionDot>>({});
	/** Id (session or project) whose delete button has its inline confirm popover open. */
	// The one open row menu (a project or session id) — opening another closes it.
	const [menuId, setMenuId] = useState<string>();
	// The session whose rename dialog is open.
	const [renaming, setRenaming] = useState<{ pid: string; session: SessionMeta }>();
	/** Project id the "new session" dialog is open for (backend picker). */
	const [sessionDialogFor, setSessionDialogFor] = useState<string>();

	// ---- sidebar width (desktop): drag the resizer or double-click to reset ----
	// Clamp to sane px bounds; the workspace grid's other column is 1fr so the
	// chat pane just yields. Persisted in localStorage; the drawer (mobile)
	// ignores the inline width via CSS.
	const [width, setWidth] = useState<number>(() => {
		const saved = Number(localStorage.getItem("sidebar-w"));
		return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : DEFAULT_SIDEBAR_W;
	});
	const resizing = useRef(false);

	// Mirror the sidebar width onto <body> as --sidebar-w: the topbar's tab
	// strip aligns its left edge with the chat column (sidebar right edge +
	// the pane's gutter) — exactly where the conversation below starts.
	useEffect(() => {
		document.body.style.setProperty("--sidebar-w", `${width}px`);
	}, [width]);

	useEffect(() => {
		const move = (ev: MouseEvent): void => {
			if (!resizing.current) return;
			lastXRef.current = ev.clientX;
			setWidth(clampSidebarW(ev.clientX));
		};
		const up = (): void => {
			if (!resizing.current) return;
			resizing.current = false;
			document.body.classList.remove("resizing-col");
			localStorage.setItem("sidebar-w", String(clampSidebarW(lastXRef.current)));
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
		return () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
	}, []);

	// Ref mirrors the sessions cache so the lazy-load guard is race-free.
	const loadedRef = useRef<Set<string>>(new Set());

	const reloadProjects = useCallback(async (): Promise<void> => {
		setLoading(true);
		try {
			setProjects(await api.listProjects());
			setError(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reloadProjects();
	}, [reloadProjects]);

	const ensureSessions = useCallback(async (pid: string): Promise<void> => {
		if (loadedRef.current.has(pid)) return;
		loadedRef.current.add(pid);
		try {
			const list = await api.listSessions(pid);
			setSessions((prev) => ({ ...prev, [pid]: list }));
		} catch (e) {
			loadedRef.current.delete(pid);
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const toggle = (pid: string): void => {
		const isOpen = expanded.has(pid);
		setExpanded((prev) => {
			const next = new Set(prev);
			if (isOpen) next.delete(pid);
			else next.add(pid);
			return next;
		});
		if (!isOpen) void ensureSessions(pid);
	};

	// Auto-expand the active project and make sure its sessions are loaded.
	useEffect(() => {
		if (activeProjectId && !expanded.has(activeProjectId)) {
			setExpanded((prev) => new Set(prev).add(activeProjectId));
			void ensureSessions(activeProjectId);
		}
	}, [activeProjectId, ensureSessions]); // eslint-disable-line react-hooks/exhaustive-deps

	// Live-update a session label when the worker auto-generates a title
	// (side-channel — never part of the chat). ChatPage re-broadcasts the server's
	// `session_meta` frame as this window event.
	useEffect(() => {
		const onTitle = (ev: Event): void => {
			const d = (ev as CustomEvent<{ projectId?: string; sessionId?: string; title?: string }>).detail;
			if (!d?.projectId || !d.sessionId || !d.title) return;
			const { projectId, sessionId, title } = d;
			setSessions((prev) => {
				const list = prev[projectId];
				if (!list) return prev;
				return { ...prev, [projectId]: list.map((x) => (x.id === sessionId ? { ...x, title } : x)) };
			});
		};
		window.addEventListener("clownfish:session-title", onTitle as EventListener);
		return () => window.removeEventListener("clownfish:session-title", onTitle as EventListener);
	}, []);

	// Poll running agents so each session row shows a live status dot (ready/busy/
	// connecting). This covers every session, including background runs in other
	// tabs; the active session's own WS still streams instantly into the chat.
	// A busy→idle transition also feeds the notification hub — a tab-less run
	// (cron / background turn) has no WS listener of its own, so this poll is the
	// only place its completion is seen.
	const busyRef = useRef<Record<string, boolean>>({});
	useEffect(() => {
		let cancelled = false;
		const tick = async (): Promise<void> => {
			try {
				const list: AgentStatus[] = await api.listAgents();
				if (cancelled) return;
				const next: Record<string, SessionDot> = {};
				const busyNow: Record<string, boolean> = {};
				for (const a of list) {
					const dot: SessionDot | null = a.busy
						? "busy"
						: a.status === "starting"
							? "connecting"
							: a.status === "ready"
								? "ready"
								: null;
					if (dot) next[a.sessionId] = dot;
					if (a.busy) busyNow[a.sessionId] = true;
				}
				// Turn-finished edges → the app-level notify listener decides whether
				// it's worth a browser notification (open tab / current session …).
				for (const a of list) {
					if (busyRef.current[a.sessionId] && !busyNow[a.sessionId]) {
						window.dispatchEvent(new CustomEvent("clownfish:notify", {
							detail: { kind: "turn_end", projectId: a.projectId, sessionId: a.sessionId, title: "回合完成,可以接管", body: `会话 ${a.sessionId.slice(0, 8)} 的后台回合已结束`, source: "poll" },
						}));
					}
				}
				busyRef.current = busyNow;
				setStatuses(next);
			} catch {
				/* server unavailable — leave dots as they are */
			}
		};
		void tick();
		const h = window.setInterval(tick, 3000);
		return () => {
			cancelled = true;
			window.clearInterval(h);
		};
	}, []);

	const createSession = async (pid: string, backend?: SessionBackend): Promise<void> => {
		try {
			const s = await api.createSession(pid, undefined, backend);
			setSessions((prev) => ({ ...prev, [pid]: [s, ...(prev[pid] ?? [])] }));
			navigate(`#/projects/${pid}/sessions/${s.id}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const removeSession = async (pid: string, sid: string): Promise<void> => {
		try {
			await api.deleteSession(pid, sid);
			setSessions((prev) => ({ ...prev, [pid]: (prev[pid] ?? []).filter((s) => s.id !== sid) }));
			// Let the shell close any open tab for this session and refocus.
			window.dispatchEvent(new CustomEvent("clownfish:session-closed", { detail: { sessionId: sid, projectId: pid } }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const renameSession = async (pid: string, s: SessionMeta, next: string): Promise<void> => {
		const title = next.trim();
		if (title === (s.title ?? "")) return; // unchanged
		try {
			const updated = await api.renameSession(pid, s.id, title);
			setSessions((prev) => ({
				...prev,
				[pid]: (prev[pid] ?? []).map((x) => (x.id === s.id ? { ...x, title: updated?.title ?? title } : x)),
			}));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 终止: kill the session's process (agent worker or CLI pty). The record and
	 *  transcript stay — the next prompt (or opening a CLI tab) respawns it. */
	const terminateSession = async (pid: string, sid: string): Promise<void> => {
		try {
			await api.stopAgent(pid, sid);
			setStatuses((prev) => ({ ...prev, [sid]: "idle" }));
			// A terminated session's open tab would only show a dead worker — close
			// it the same way a delete does (the shell refocuses a neighbour).
			window.dispatchEvent(new CustomEvent("clownfish:session-closed", { detail: { sessionId: sid, projectId: pid } }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const removeProject = async (pid: string): Promise<void> => {
		try {
			await api.deleteProject(pid);
			loadedRef.current.delete(pid);
			setSessions((prev) => {
				const next = { ...prev };
				delete next[pid];
				return next;
			});
			await reloadProjects();
			// Let the shell close any open tabs for this project and refocus.
		window.dispatchEvent(new CustomEvent("clownfish:project-closed", { detail: { projectId: pid } }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const createProject = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (!path.trim()) return;
		try {
			const p = await api.createProject({ name: name.trim() || undefined, path: path.trim() });
			// A new project ships with one default session — drop the user straight in.
			const s = await api.createSession(p.id);
			setName("");
			setPath("");
			setCreating(false);
			await reloadProjects();
			loadedRef.current.add(p.id);
			setSessions((prev) => ({ ...prev, [p.id]: [s] }));
			setExpanded((prev) => new Set(prev).add(p.id));
			navigate(`#/projects/${p.id}/sessions/${s.id}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<aside class={`sidebar${drawerOpen ? " open" : ""}`} style={{ width: `${width}px` }}>
			<div class="sidebar-head">
				{/* Same row as 记忆 / 设置 below: the rail's three top-level items share
				    one height, one type size, one inset. The + is the row's action. */}
				<div class="tree-node rail-row rail-head">
					<IconFolder />
					<span class="label">项目</span>
					<button class="icon-btn rail-add" onClick={() => setCreating((c) => !c)} title={creating ? "取消" : "新建项目"}>
						{creating ? <IconX /> : <IconPlus />}
					</button>
				</div>
				{creating && (
					<NewProjectDialog
						name={name}
						path={path}
						onName={setName}
						onPath={setPath}
						onSubmit={createProject}
						onClose={() => setCreating(false)}
					/>
				)}
			</div>
			{sessionDialogFor && (
				<NewSessionDialog
					onSubmit={(backend) => {
						const pid = sessionDialogFor;
						setSessionDialogFor(undefined);
						void createSession(pid, backend);
					}}
					onClose={() => setSessionDialogFor(undefined)}
				/>
			)}

			{renaming && (
				<RenameSessionDialog
					initial={renaming.session.title ?? ""}
					onSubmit={(title) => {
						const r = renaming;
						setRenaming(undefined);
						void renameSession(r.pid, r.session, title);
					}}
					onClose={() => setRenaming(undefined)}
				/>
			)}

			<div class="tree">
				{error && <div class="error">{error}</div>}
				{loading && <div class="muted small">Loading…</div>}
				{projects.map((p) => {
					const open = expanded.has(p.id);
					const list = sessions[p.id];
					// The assistant is a fixed single-session project: no "New
					// session" (there is exactly one, ensured server-side) and no
					// rename/delete on its session — the row is the butler itself.
					const isAssistant = p.id === ASSISTANT_PROJECT_ID;
					// The assistant IS its one session: a leaf row that opens it
					// directly — no caret, no children, no session management.
					if (isAssistant) {
						const active = activeSessionId === ASSISTANT_PROJECT_ID;
						return (
							<div class="tree-project" key={p.id}>
								<a
									class={`tree-node project-row leaf${active ? " active" : ""}`}
									href={`#/projects/${p.id}/sessions/${p.id}`}
								>
									<span class={`status-dot ${statuses[p.id] ?? "idle"}`} />
									<span class="label">{p.name}</span>
								</a>
							</div>
						);
					}
					return (
						<div class="tree-project" key={p.id}>
							<div class={`tree-node project-row${open ? " open" : ""}`} onClick={() => toggle(p.id)}>
								<span class={`caret${open ? " open" : ""}`}>
									<IconCaret />
								</span>
								<span class="label">{p.name}</span>
{!isAssistant && (
								<button
									class="icon-btn add"
									title="New session"
									onClick={(e) => {
										e.stopPropagation();
										setSessionDialogFor(p.id);
									}}
								>
									<IconPlus />
								</button>
								)}
								<RowMenu
									title="项目操作"
									open={menuId === p.id}
									onToggle={(o) => setMenuId(o ? p.id : undefined)}
									items={[{ label: "删除项目", icon: <IconTrash />, danger: true, confirm: "确认删除项目?", onSelect: () => void removeProject(p.id) }]}
								/>
							</div>
							{open && (
								<div class="tree-children">
									{!list && <div class="muted small indent">…</div>}
									{list?.map((s) => (
										<a
											key={s.id}
											class={`tree-node session-row${s.id === activeSessionId ? " active" : ""}`}
											href={`#/projects/${p.id}/sessions/${s.id}`}
											title={timeStr(s.updatedAt)}
										>
											<span class={`status-dot ${statuses[s.id] ?? "idle"}`} />
											{s.backend?.kind === "cli" && (
												<span class="cli-badge" title={s.backend.label || s.backend.command}>
													<CliIcon backend={s.backend} />
												</span>
											)}
											<span class="label">{s.title ?? "Untitled session"}</span>
											<RowMenu
												title="会话操作"
												open={menuId === s.id}
												onToggle={(o) => setMenuId(o ? s.id : undefined)}
												items={[
													{ label: "重命名", icon: <IconPencil />, onSelect: () => setRenaming({ pid: p.id, session: s }) },
													{
														label: "终止",
														icon: <IconStop />,
														hint: statuses[s.id] && statuses[s.id] !== "idle" ? "杀死会话进程" : "进程未运行",
														disabled: !statuses[s.id] || statuses[s.id] === "idle",
														onSelect: () => void terminateSession(p.id, s.id),
													},
													{ label: "删除", icon: <IconTrash />, danger: true, confirm: "确认删除?", onSelect: () => void removeSession(p.id, s.id) },
												]}
											/>
										</a>
									))}
								</div>
							)}
						</div>
					);
				})}
				{!loading && projects.length === 0 && <div class="muted small">No projects yet. Click “+” to add one.</div>}
			</div>

			{/* App-level pages. Same row anatomy as a session row — icon, label — so
			    the rail reads as one list rather than a tree with a footer. */}
			<nav class="rail-nav">
				<a class={`tree-node rail-row${activeSessionId ? "" : window.location.hash.startsWith("#/memory") ? " active" : ""}`} href="#/memory" title="记忆：智能体跨会话记住的东西">
					<IconBrain />
					<span class="label">记忆</span>
				</a>
				<a class={`tree-node rail-row${window.location.hash.startsWith("#/settings") || window.location.hash.startsWith("#/admin") ? " active" : ""}`} href="#/settings" title="设置：资产 / 工具提示词 / 快捷键 / 记忆">
					<IconSliders />
					<span class="label">设置</span>
				</a>
			</nav>

			{/* Desktop width resizer: drag to resize, double-click to reset. */}
			<div
				class="sidebar-resizer"
				onDblClick={() => {
					setWidth(DEFAULT_SIDEBAR_W);
					localStorage.setItem("sidebar-w", String(DEFAULT_SIDEBAR_W));
				}}
				onMouseDown={(e) => {
					resizing.current = true;
					lastXRef.current = (e as MouseEvent).clientX;
					document.body.classList.add("resizing-col");
				}}
			/>
		</aside>
	);
}

/**
 * New-project dialog. A modal rather than an inline form: the form has two
 * fields and a path autocomplete dropdown, which inside a 220px rail either
 * clipped or pushed the tree down. Esc / backdrop close; Enter submits. The
 * path is the only required field — name defaults to the directory's basename
 * server-side, the same way the REST call does for an agent.
 */
function NewProjectDialog({
	name,
	path,
	onName,
	onPath,
	onSubmit,
	onClose,
}: {
	name: string;
	path: string;
	onName: (v: string) => void;
	onPath: (v: string) => void;
	onSubmit: (e: Event) => void;
	onClose: () => void;
}): preact.JSX.Element {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<form class="modal" role="dialog" aria-modal="true" aria-labelledby="np-title" onSubmit={onSubmit}>
				<div class="modal-head">
					<h2 id="np-title">新建项目</h2>
					<button type="button" class="icon-btn modal-close" title="关闭" onClick={onClose}>
						<IconX />
					</button>
				</div>
				<label class="field">
					<span class="field-label">工作区目录</span>
					<PathInput value={path} onChange={onPath} />
					<span class="field-hint muted">必须是已存在的目录。</span>
				</label>
				<label class="field">
					<span class="field-label">
						名称 <span class="muted">（可选，默认用目录名）</span>
					</span>
					<input value={name} placeholder={path.trim().split("/").filter(Boolean).pop() ?? ""} onInput={(e) => onName((e.target as HTMLInputElement).value)} />
				</label>
				<div class="modal-actions">
					<button type="button" class="ghost" onClick={onClose}>
						取消
					</button>
					<button type="submit" disabled={!path.trim()}>
						创建
					</button>
				</div>
			</form>
		</div>
	);
}

/**
 * New-session dialog: pick clownfish's built-in agent (default) or hand the
 * session to an external CLI (Codex / Claude Code / any command) running
 * under an embedded terminal. A `cli` backend gets no model/provider fields —
 * the CLI is assumed to already be configured (e.g. `codex login` on the
 * host) — only an env override (proxy on/off, etc.), the one knob clownfish
 * adds on spawn.
 */
function NewSessionDialog({
	onSubmit,
	onClose,
}: {
	onSubmit: (backend?: SessionBackend) => void;
	onClose: () => void;
}): preact.JSX.Element {
	const [presetKey, setPresetKey] = useState<string>("builtin");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const preset = CLI_PRESETS.find((p) => p.key === presetKey);
	const effectiveCommand = presetKey === "custom" ? command : (preset?.command ?? "");

	const submit = (e: Event): void => {
		e.preventDefault();
		if (presetKey === "builtin") return onSubmit(undefined);
		const cmd = effectiveCommand.trim();
		if (!cmd) return;
		const env: Record<string, string> = {};
		for (const row of envRows) {
			if (row.key.trim()) env[row.key.trim()] = row.value;
		}
		onSubmit({
			kind: "cli",
			command: cmd,
			args: args.trim() ? args.trim().split(/\s+/) : undefined,
			env: Object.keys(env).length ? env : undefined,
			label: preset && preset.key !== "custom" ? preset.label : undefined,
			preset: preset?.key === "codex" || preset?.key === "claude" ? preset.key : undefined,
		});
	};

	return (
		<div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<form class="modal" role="dialog" aria-modal="true" aria-labelledby="ns-title" onSubmit={submit}>
				<div class="modal-head">
					<h2 id="ns-title">新建会话</h2>
					<button type="button" class="icon-btn modal-close" title="关闭" onClick={onClose}>
						<IconX />
					</button>
				</div>
				<div class="field">
					<span class="field-label">Agent运行时</span>
					<div class="runtime-picker" role="radiogroup" aria-label="Agent运行时">
						<button
							type="button"
							role="radio"
							aria-checked={presetKey === "builtin"}
							class={`runtime-opt${presetKey === "builtin" ? " on" : ""}`}
							onClick={() => setPresetKey("builtin")}
						>
							Clownfish 内置 agent
						</button>
						{CLI_PRESETS.map((p) => (
							<button
								key={p.key}
								type="button"
								role="radio"
								aria-checked={presetKey === p.key}
								class={`runtime-opt${presetKey === p.key ? " on" : ""}`}
								onClick={() => setPresetKey(p.key)}
							>
								{p.label}
							</button>
						))}
					</div>
				</div>
				{presetKey === "custom" && (
					<label class="field">
						<span class="field-label">命令</span>
						<input value={command} placeholder="例如 codex 或 claude" onInput={(e) => setCommand((e.target as HTMLInputElement).value)} />
					</label>
				)}
				{presetKey !== "builtin" && (
					<>
						<label class="field">
							<span class="field-label">
								参数 <span class="muted">（可选，空格分隔）</span>
							</span>
							<input value={args} onInput={(e) => setArgs((e.target as HTMLInputElement).value)} />
						</label>
						<div class="field">
							<span class="field-label">
								环境变量 <span class="muted">（可选，例如代理设置；命令自身的登录/模型配置不受影响）</span>
							</span>
							{envRows.map((row, i) => (
								<div class="env-row" key={i}>
									<input
										placeholder="KEY"
										value={row.key}
										onInput={(e) => setEnvRows((prev) => prev.map((r, j) => (j === i ? { ...r, key: (e.target as HTMLInputElement).value } : r)))}
									/>
									<input
										placeholder="VALUE"
										value={row.value}
										onInput={(e) => setEnvRows((prev) => prev.map((r, j) => (j === i ? { ...r, value: (e.target as HTMLInputElement).value } : r)))}
									/>
									<button type="button" class="icon-btn" title="删除" onClick={() => setEnvRows((prev) => prev.filter((_, j) => j !== i))}>
										<IconX />
									</button>
								</div>
							))}
							<button type="button" class="ghost small" onClick={() => setEnvRows((prev) => [...prev, { key: "", value: "" }])}>
								+ 添加环境变量
							</button>
						</div>
					</>
				)}
				<div class="modal-actions">
					<button type="button" class="ghost" onClick={onClose}>
						取消
					</button>
					<button type="submit" disabled={presetKey !== "builtin" && !effectiveCommand.trim()}>
						创建
					</button>
				</div>
			</form>
		</div>
	);
}

/** One entry in a row's "..." menu. A `confirm` entry asks first: the first
 *  click swaps its label for the question, the second one acts. */
interface RowMenuItem {
	label: string;
	icon?: preact.JSX.Element;
	hint?: string;
	danger?: boolean;
	disabled?: boolean;
	confirm?: string;
	onSelect: () => void;
}

/**
 * RowMenu — a tree row's "..." button and its dropdown. The row's actions
 * (rename / terminate / delete) live here instead of as a strip of hover
 * glyphs. The dropdown is position:fixed at coords captured when it opens —
 * the tree is an overflow-y scroller and would clip an absolute child — and
 * right-aligned under the button. Click-outside or Esc closes it; the parent
 * holds the single open menu id, so opening another row's menu closes this one.
 */
function RowMenu({
	title,
	open,
	onToggle,
	items,
}: {
	title: string;
	open: boolean;
	onToggle: (open: boolean) => void;
	items: RowMenuItem[];
}): preact.JSX.Element {
	const wrap = useRef<HTMLElement>(null);
	const btn = useRef<HTMLButtonElement>(null);
	const [anchor, setAnchor] = useState<{ right: number; top: number }>();
	const [armed, setArmed] = useState<number>();
	useEffect(() => {
		if (!open) {
			setArmed(undefined);
			return;
		}
		const onDown = (e: MouseEvent): void => {
			if (!wrap.current?.contains(e.target as Node)) onToggle(false);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onToggle(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]); // eslint-disable-line react-hooks/exhaustive-deps
	// The row underneath is a link: every handler here must stop the event
	// before it navigates (mousedown included — it fires first).
	const swallow = (e: Event): void => {
		e.preventDefault();
		e.stopPropagation();
	};
	return (
		<span class="row-menu-wrap" ref={wrap}>
			<button
				class={`icon-btn row-menu-btn${open ? " open" : ""}`}
				title={title}
				aria-haspopup="menu"
				aria-expanded={open}
				ref={btn}
				onMouseDown={swallow}
				onClick={(e) => {
					swallow(e);
					if (open) return onToggle(false);
					const r = btn.current?.getBoundingClientRect();
					if (r) setAnchor({ right: window.innerWidth - r.right, top: r.bottom + 4 });
					onToggle(true);
				}}
			>
				<IconMore />
			</button>
			{open && anchor && (
				<div class="row-menu" role="menu" style={{ right: `${anchor.right}px`, top: `${anchor.top}px` }}>
					{items.map((it, i) => (
						<button
							key={it.label}
							type="button"
							role="menuitem"
							class={`row-menu-item${it.danger ? " destructive" : ""}${armed === i ? " armed" : ""}`}
							disabled={it.disabled}
							title={it.hint}
							onMouseDown={swallow}
							onClick={(e) => {
								swallow(e);
								if (it.confirm && armed !== i) return setArmed(i);
								onToggle(false);
								it.onSelect();
							}}
						>
							{it.icon}
							<span>{armed === i ? it.confirm : it.label}</span>
						</button>
					))}
				</div>
			)}
		</span>
	);
}

/**
 * Rename-session dialog — the same modal shell as 新建项目, replacing the
 * browser's window.prompt (unstyled, blocks the page, can't be themed). The
 * field opens focused with the current title selected; Enter saves, Esc or
 * the backdrop cancels.
 */
function RenameSessionDialog({
	initial,
	onSubmit,
	onClose,
}: {
	initial: string;
	onSubmit: (title: string) => void;
	onClose: () => void;
}): preact.JSX.Element {
	const [title, setTitle] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<form
				class="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="rs-title"
				onSubmit={(e) => {
					e.preventDefault();
					onSubmit(title);
				}}
			>
				<div class="modal-head">
					<h2 id="rs-title">重命名会话</h2>
					<button type="button" class="icon-btn modal-close" title="关闭" onClick={onClose}>
						<IconX />
					</button>
				</div>
				<label class="field">
					<span class="field-label">会话名称</span>
					<input ref={input} value={title} placeholder="Untitled session" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
				</label>
				<div class="modal-actions">
					<button type="button" class="ghost" onClick={onClose}>
						取消
					</button>
					<button type="submit">保存</button>
				</div>
			</form>
		</div>
	);
}

/**
 * PathInput — a workspace-path text field with prefix-match autocomplete.
 *
 * On each (debounced) keystroke it asks the server for directories whose final
 * segment starts with what's been typed and shows them in a dropdown. Picking
 * one fills the field with the full absolute path (plus a trailing slash, so
 * the next keystroke descends into it). Arrow keys + Enter select; Esc closes.
 */
function PathInput({ value, onChange }: { value: string; onChange: (v: string) => void }): preact.JSX.Element {
	const [suggestions, setSuggestions] = useState<PathSuggestion[]>([]);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [loading, setLoading] = useState(false);
	const debounce = useRef<number>(0);
	const blur = useRef<number>(0);

	const fetchSuggest = useCallback((prefix: string): void => {
		window.clearTimeout(debounce.current);
		debounce.current = window.setTimeout(async (): Promise<void> => {
			setLoading(true);
			try {
				const r = await api.completePath(prefix);
				setSuggestions(r.suggestions);
				setActive(0);
				setOpen(true);
			} catch {
				setSuggestions([]);
			} finally {
				setLoading(false);
			}
		}, 120);
	}, []);

	const pick = (s: PathSuggestion): void => {
		onChange(s.path);
		setOpen(false);
		setSuggestions([]);
	};

	/** Shell-style Tab: fill the selection into the input and descend into it (keep the dropdown open). */
	const completeInto = (s: PathSuggestion): void => {
		onChange(s.path);
		// s.path ends with "/" → the server lists that directory's children, so the
		// dropdown refreshes to the next level without closing.
		fetchSuggest(s.path);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!open || suggestions.length === 0) return; // Tab/etc. keep default behavior (blur the field)
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => (a + 1) % suggestions.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
		} else if (e.key === "Tab") {
			// Shell-style: fill the highlighted dir into the input and descend into it
			// (refresh the dropdown to its children) without closing. preventDefault
			// keeps focus in the field so completion can continue.
			e.preventDefault();
			if (suggestions[active]) completeInto(suggestions[active]);
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (suggestions[active]) pick(suggestions[active]);
		} else if (e.key === "Escape") {
			setOpen(false);
		}
	};

	return (
		<div class="path-input">
			<input
				placeholder="Workspace path (absolute, or ~/…)"
				value={value}
				onInput={(e) => {
					onChange((e.target as HTMLInputElement).value);
					fetchSuggest((e.target as HTMLInputElement).value);
				}}
				onKeyDown={onKeyDown}
				onFocus={() => {
					if (suggestions.length) setOpen(true);
					else fetchSuggest(value);
				}}
				onBlur={() => {
					blur.current = window.setTimeout(() => setOpen(false), 120);
				}}
			/>
			{open && (
				<ul class="path-suggest">
					{loading && suggestions.length === 0 && <li class="path-suggest-hint">…</li>}
					{suggestions.map((s, i) => (
						<li key={s.path}>
							<button
								type="button"
								class={`path-suggest-item${i === active ? " active" : ""}`}
								// mousedown (not click) + preventDefault keeps focus on the input,
								// so onBlur doesn't close the list before the pick registers.
								onMouseDown={(e) => {
									e.preventDefault();
									pick(s);
								}}
								onMouseEnter={() => setActive(i)}
							>
								{s.name}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
