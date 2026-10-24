import { useEffect, useRef, useState } from "preact/hooks";
import { api, auth, type AuthMe } from "./api";
import { ProjectTree } from "./pages/tree";
import { ChatPage } from "./pages/chat";
import { TerminalPage } from "./pages/terminal";
import { SettingsPage } from "./pages/settings";
import type { SessionBackend } from "../protocol";
import { MemoryPage } from "./pages/memory";
import { navigate, parseHash, type Selection } from "./router";
import { useGlobalKeys, useKeymap } from "./keymap";
import { IconBell, IconBellOff, IconMenu, IconX, IconGrid, IconChevronDown } from "./icons";
import { notifyEnabled, notifyPermission, notifySupported, setNotifyEnabled, showNotification, type NotifyDetail } from "./notify";

/**
 * Single-page shell: a project/session tree on the left and a TABBED chat on the
 * right, plus a settings view (`#/settings`) that covers them.
 *
 * Settings does not unmount the workspace — it is hidden behind it — so opening
 * settings mid-run does not drop any tab's WebSocket.
 *
 * The hash encodes the *active* session. Opening a session (from the tree, a new
 * tab, etc.) adds it to the open-tab set and focuses it. Every open tab keeps its
 * own {@link ChatPage} mounted, so background tabs keep their WebSocket live and
 * continue streaming. Closing a tab only unmounts that ChatPage — which drops the
 * browser-side WS — it does NOT kill the agent process; the agent is left to idle
 * out on its own TTL (or finish a run with zero subscribers).
 */
interface Tab {
	projectId: string;
	sessionId: string;
}

interface SessionClosed {
	sessionId: string;
	projectId: string;
}

export function App(): preact.JSX.Element {
	const [sel, setSel] = useState<Selection>(parseHash());
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [titles, setTitles] = useState<Record<string, string | undefined>>({});
	/** Which backend each open session uses — decides ChatPage vs TerminalPage. */
	const [backends, setBackends] = useState<Record<string, SessionBackend | undefined>>({});
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [me, setMe] = useState<AuthMe | null>(null);


	// Browser notifications: a finished turn / pending approval asks the user to
	// take over. Noisy sources are muted — the CURRENT session in a FOCUSED tab
	// is already on screen (its own UI shows completion/approval); only unseen
	// work pulls the user back.
	const selRef = useRef(sel);
	selRef.current = sel;
	const tabsRef = useRef<Tab[]>([]);
	tabsRef.current = tabs;
	useEffect(() => {
		const onNotify = (ev: Event): void => {
			const d = (ev as CustomEvent<NotifyDetail>).detail;
			if (!d?.sessionId || !d.projectId) return;
			// The sidebar poll covers EVERY session; a mounted tab's ChatPage
			// reports its own turn_end over WS with a richer body — skip the
			// poll's duplicate when both see the same completion.
			if (d.source === "poll" && tabsRef.current.some((t) => t.sessionId === d.sessionId)) return;
			if (document.visibilityState === "visible" && selRef.current.sessionId === d.sessionId && !selRef.current.memory && !selRef.current.settings) return;
			showNotification(d);
		};
		window.addEventListener("clownfish:notify", onNotify as EventListener);
		return () => window.removeEventListener("clownfish:notify", onNotify as EventListener);
	}, []);

	// 🔔 toggle: enable → ask permission once (denied stays a click-away hint).
	const [bell, setBell] = useState(() => (notifySupported() ? notifyEnabled() && notifyPermission() === "granted" : false));
	const toggleBell = (): void => {
		if (!notifySupported()) return;
		if (bell) {
			setNotifyEnabled(false);
			setBell(false);
			return;
		}
		const next = (): void => {
			const granted = Notification.permission === "granted";
			setNotifyEnabled(granted);
			setBell(granted);
		};
		if (Notification.permission === "granted") next();
		else void Notification.requestPermission().then(next);
	};

	// Auth status probe. When auth is on and we're not logged in, bounce to Google
	// (the /api 401 path does this too, but checking here avoids a UI flash).
	useEffect(() => {
		let alive = true;
		void auth
			.me()
			.then((m) => {
				if (!alive) return;
				setMe(m);
				if (m.enabled && !m.authenticated) window.location.assign("/auth/login");
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const onLogout = async (): Promise<void> => {
		await auth.logout();
		window.location.assign("/");
	};

	useEffect(() => {
		const on = (): void => {
			setSel(parseHash());
			// Mobile: collapse the tree drawer once a navigation happens (session
			// picked, project created, brand clicked, …).
			setDrawerOpen(false);
		};
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);

	// The hash points at the active session — make sure it's an open tab and seed
	// its title (cheap: read the project's session index). An empty/"" title is
	// stored distinctly from "not yet fetched" (undefined) so we don't re-fetch.
	useEffect(() => {
		const { projectId, sessionId } = sel;
		if (!projectId || !sessionId || sel.memory || sel.settings) return;
		setTabs((prev) => (prev.some((t) => t.sessionId === sessionId) ? prev : [...prev, { projectId, sessionId }]));
		if (titles[sessionId] === undefined) {
			void api
				.listSessions(projectId)
				.then((list) => {
					const m = list.find((s) => s.id === sessionId);
					setTitles((prev) => ({ ...prev, [sessionId]: m?.title ?? "" }));
					setBackends((prev) => ({ ...prev, [sessionId]: m?.backend }));
				})
				.catch(() => undefined);
		}
	}, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

	/** ChatPage for a builtin session, TerminalPage for a CLI-backed one. */
	const renderSessionPage = (t: Tab, active: boolean): preact.JSX.Element =>
		backends[t.sessionId]?.kind === "cli" ? (
			<TerminalPage projectId={t.projectId} sessionId={t.sessionId} backend={backends[t.sessionId]!} active={active} />
		) : (
			<ChatPage projectId={t.projectId} sessionId={t.sessionId} active={active} />
		);

	// Live-update tab titles from the worker's side-channel title event.
	useEffect(() => {
		const onTitle = (ev: Event): void => {
			const d = (ev as CustomEvent<{ sessionId?: string; title?: string }>).detail;
			const sid = d?.sessionId;
			if (!sid) return;
			const title = d.title ?? "";
			setTitles((prev) => ({ ...prev, [sid]: title }));
		};
		window.addEventListener("clownfish:session-title", onTitle as EventListener);
		return () => window.removeEventListener("clownfish:session-title", onTitle as EventListener);
	}, []);

	// Tab breathing lights: every mounted ChatPage reports its session's busy
	// state (turn start/end + the authoritative seed on connect), so each tab
	// shows a pulsing dot while its agent works — background tabs included.
	const [tabBusy, setTabBusy] = useState<Record<string, boolean>>({});
	useEffect(() => {
		const onBusy = (ev: Event): void => {
			const d = (ev as CustomEvent<{ sessionId?: string; busy?: boolean }>).detail;
			if (!d?.sessionId) return;
			setTabBusy((prev) => (prev[d.sessionId!] === Boolean(d.busy) ? prev : { ...prev, [d.sessionId!]: Boolean(d.busy) }));
		};
		window.addEventListener("clownfish:tab-busy", onBusy as EventListener);
		return () => window.removeEventListener("clownfish:tab-busy", onBusy as EventListener);
	}, []);

	const activeSid = sel.sessionId && tabs.some((t) => t.sessionId === sel.sessionId) ? sel.sessionId : undefined;

	/** Focus a neighbor after closing, else fall back to the project tree / home. */
	const focusNeighbor = (next: Tab[], removedSid: string, fallbackProjectId?: string): void => {
		if (removedSid !== activeSid) return;
		const idx = tabs.findIndex((t) => t.sessionId === removedSid);
		const neighbor = next[idx] ?? next[idx - 1];
		if (neighbor) navigate(`#/projects/${neighbor.projectId}/sessions/${neighbor.sessionId}`);
		else if (fallbackProjectId) navigate(`#/projects/${fallbackProjectId}`);
		else navigate("#/");
	};

	// A session/project was deleted (from the tree) — drop its tab(s) and refocus.
	useEffect(() => {
		const onClose = (ev: Event): void => {
			const d = (ev as CustomEvent<SessionClosed>).detail;
			if (!d?.sessionId) return;
			setTabs((prev) => {
				const next = prev.filter((t) => t.sessionId !== d.sessionId);
				focusNeighbor(next, d.sessionId, d.projectId);
				return next;
			});
		};
		const onProject = (ev: Event): void => {
			const d = (ev as CustomEvent<{ projectId: string }>).detail;
			if (!d?.projectId) return;
			setTabs((prev) => {
				const next = prev.filter((t) => t.projectId !== d.projectId);
				if (activeSid && prev.some((t) => t.sessionId === activeSid && t.projectId === d.projectId)) {
					const neighbor = next[0];
					if (neighbor) navigate(`#/projects/${neighbor.projectId}/sessions/${neighbor.sessionId}`);
					else navigate("#/");
				}
				return next;
			});
		};
		window.addEventListener("clownfish:session-closed", onClose as EventListener);
		window.addEventListener("clownfish:project-closed", onProject as EventListener);
		return () => {
			window.removeEventListener("clownfish:session-closed", onClose as EventListener);
			window.removeEventListener("clownfish:project-closed", onProject as EventListener);
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	const closeTab = (sid: string): void => {
		setTabs((prev) => {
			const next = prev.filter((t) => t.sessionId !== sid);
			focusNeighbor(next, sid);
			return next;
		});
	};

	const focusTab = (t: Tab): void => navigate(`#/projects/${t.projectId}/sessions/${t.sessionId}`);

	// Workspace-level shortcuts. Session navigation lives here because this is what
	// owns the tab strip; the per-session ones (mode, abort, plan…) are in ChatPage.
	const keymap = useKeymap();
	const step = (delta: number): void => {
		if (tabs.length === 0) return;
		const idx = tabs.findIndex((t) => t.sessionId === activeSid);
		const next = tabs[(((idx < 0 ? 0 : idx) + delta) % tabs.length + tabs.length) % tabs.length];
		if (next) focusTab(next);
	};
	useGlobalKeys(keymap, {
		"open-settings": () => navigate("#/settings"),
		"open-projects": () => navigate("#/"),
		"next-session": () => step(1),
		"prev-session": () => step(-1),
		"close-session": () => {
			if (activeSid) closeTab(activeSid);
		},
		"new-session": () => {
			const projectId = sel.projectId ?? tabs.find((t) => t.sessionId === activeSid)?.projectId;
			if (!projectId) return;
			void api
				.createSession(projectId)
				.then((meta) => navigate(`#/projects/${projectId}/sessions/${meta.id}`))
				.catch(() => undefined);
		},
	});

	const hasTabs = tabs.length > 0;
	// Tabs live IN the topbar (they ride its bottom edge — browser-style) and so
	// consume zero chat-body height. Hidden while the memory/admin page replaces
	// the chat workspace.
	const tabsInHeader = hasTabs && !sel.memory && !sel.settings;
	// Grid monitor: ⊞ in the tab strip toggles the chat pane between the
	// single-session view and a GRID of every open tab (multi-session watch).
	// The same ChatPages stay mounted either way — the WS streams never drop;
	// the toggle only changes how the layers are laid out.
	const [grid, setGrid] = useState(false);
	// Explicit grid layout (cols × rows). Default 2×2; picking from the size
	// popover sets it (and turns grid mode on). Cells flow row-major; empty
	// slots in the last row just stay blank.
	const [gridCols, setGridCols] = useState(2);
	const [gridRows, setGridRows] = useState(2);
	const [sizeOpen, setSizeOpen] = useState(false);
	// Popover anchor (viewport coords, set at open time from the ▾ button's
	// rect) — the popover is position:fixed, escaping the tab strip's clip.
	const [sizeAnchor, setSizeAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
	// Cell layout as a SPARSE slot array: index = grid slot (row-major),
	// value = sessionId or undefined (EMPTY slot — a legal drop target: dropping
	// onto an empty slot MOVES the session there, onto an occupied one SWAPS).
	// New tabs fill the first hole (else append); closed tabs leave their slot
	// empty for later drops.
	const [gridOrder, setGridOrder] = useState<Array<string | undefined>>([]);
	useEffect(() => {
		setGridOrder((prev) => {
			const alive = new Set(tabs.map((t) => t.sessionId));
			const next = prev.map((sid) => (sid !== undefined && alive.has(sid) ? sid : undefined));
			for (const t of tabs) {
				if (next.includes(t.sessionId)) continue;
				const hole = next.indexOf(undefined);
				if (hole >= 0) next[hole] = t.sessionId;
				else next.push(t.sessionId);
			}
			return next;
		});
	}, [tabs]);
	// Drag state. dragRef is set SYNCHRONOUSLY in onDragStart — dragover
	// handlers read it without waiting for a React re-render (state updates
	// batch async; the ref removes the missed-first-highlight lag).
	const dragRef = useRef<string | undefined>(undefined);
	const [dragSid, setDragSid] = useState<string | undefined>(undefined);
	const [dropSlot, setDropSlot] = useState<number | undefined>(undefined);
	// Drag-ghost node: the cloned title chip shown at the cursor. Appended to
	// body at dragstart (off-screen — the browser snapshots it for the drag
	// image), removed at dragend.
	const ghostRef = useRef<HTMLElement | null>(null);
	// Grab point: where the mouse sat within the head at MOUSEDOWN (relative
	// to its top-left). The drag image is anchored at the same offset, so the
	// ghost title chip rides the cursor exactly where the user gripped it —
	// no snap to a canned (24,12) hotspot. rect-based (not offsetX) so child
	// spans don't skew it; clamped when used.
	const grabRef = useRef({ x: 24, y: 12 });
	const clearDrag = (): void => {
		dragRef.current = undefined;
		setDragSid(undefined);
		setDropSlot(undefined);
	};
	/** Drop the dragged session at slot `i`: swap if occupied, move if empty. */
	const dropTo = (i: number): void => {
		const from = dragRef.current;
		if (from === undefined) return;
		setGridOrder((prev) => {
			const size = Math.max(gridCols * gridRows, prev.length, i + 1);
			const next: Array<string | undefined> = Array.from({ length: size }, (_, k) => prev[k]);
			const a = next.indexOf(from);
			if (a < 0 || a === i) return prev;
			// Exchange the two slots — swapping with an empty slot IS a move.
			[next[a], next[i]] = [next[i], next[a]];
			return next;
		});
		clearDrag();
	};

	return (
		<div class="app">
			<header class="topbar">
				<a class="brand" href="#/">
					<img
						class="logo"
						src="/logo-128.png"
						srcSet="/logo-128.png 1x, /logo-256.png 2x"
						width={22}
						height={22}
						alt=""
					/>
					Clownfish
				</a>
				{tabsInHeader ? (
					<div class="tabbar">
						{tabs.map((t) => (
							<div
								key={t.sessionId}
								class={`tab${t.sessionId === activeSid ? " active" : ""}`}
								onClick={() => focusTab(t)}
								title={titles[t.sessionId] || "Untitled session"}
							>
								<span class="tab-title">{titles[t.sessionId] || "Untitled session"}</span>
								{/* Busy slot: breathing dot while the session's agent works,
								    × on hover — mutually exclusive, one slot. */}
								<span class="tab-slot">
									{tabBusy[t.sessionId] ? <i class="tab-live" title="agent 正在工作中" /> : null}
									<button
										class="tab-close"
										title="Close tab (the agent keeps running)"
										onClick={(e) => {
											e.stopPropagation();
											closeTab(t.sessionId);
										}}
									>
										<IconX />
									</button>
								</span>
							</div>
						))}
						{/* Grid toggle + size picker: click ⊞ to toggle the grid
						    monitor; the caret next to it opens the SIZE picker (a
						    hover-diagonal grid, like doc-editor table insert).
						    Rides the strip's bottom edge with the tabs — where a
						    tab-strip "+" would sit. */}
						<span class="grid-controls">
							<button
								class={`icon-btn grid-toggle${grid ? " on" : ""}`}
								onClick={() => setGrid((g) => !g)}
								title={grid ? "返回单会话视图" : "宫格视图：同时监视所有打开的会话"}
							>
								<IconGrid />
							</button>
							<button
								class="icon-btn grid-size-btn"
								onClick={(e) => {
									e.stopPropagation();
									// Anchor the popover to the button's on-screen rect —
									// it renders position:fixed (the tab strip is an
									// overflow-x:auto scroller that would CLIP an
									// absolutely-positioned child popover).
									const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
									setSizeAnchor({ x: r.left, y: r.bottom });
									setSizeOpen((o) => !o);
								}}
								title="选择宫格布局"
							>
								<IconChevronDown />
							</button>
							{sizeOpen && sizeAnchor && (
								<GridSizePicker
									x={sizeAnchor.x}
									y={sizeAnchor.y}
									cols={gridCols}
									rows={gridRows}
									onPick={(c, r) => {
										setGridCols(c);
										setGridRows(r);
										setSizeOpen(false);
										setGrid(true); // picking a layout implies grid mode
									}}
									onClose={() => setSizeOpen(false)}
								/>
							)}
						</span>
					</div>
				) : null}
				{me?.user ? (
					<div class="topbar-user" title={me.user.email}>
						{me.user.picture ? (
							<img class="avatar" src={me.user.picture} alt="" referrerPolicy="no-referrer" />
						) : null}
						<span class="user-email">{me.user.name || me.user.email}</span>
						<button class="logout-btn" onClick={() => void onLogout()} title="Sign out">
							Sign out
						</button>
					</div>
				) : null}
				{notifySupported() && (
					<button
						class={`icon-btn bell${bell ? " on" : ""}`}
						onClick={toggleBell}
						title={bell ? "会话通知已开启(点击关闭)" : "开启会话通知(回合完成/等待确认时提醒)"}
					>
						{bell ? <IconBell /> : <IconBellOff />}
					</button>
				)}
				<button
					class="menu-toggle"
					onClick={() => setDrawerOpen((o) => !o)}
					aria-label="Toggle session tree"
					title="Sessions"
				>
					{drawerOpen ? <IconX /> : <IconMenu />}
				</button>
			</header>
			<main class="main">
				<div class={`workspace${tabsInHeader ? " has-session" : ""}`}>
					<ProjectTree activeProjectId={sel.projectId} activeSessionId={activeSid} drawerOpen={drawerOpen} />
					<div class={`drawer-backdrop${drawerOpen ? " open" : ""}`} onClick={() => setDrawerOpen(false)} />
					{sel.memory ? (
						<MemoryPage />
					) : sel.settings ? (
						<SettingsPage tab={sel.settingsTab} />
					) : (
					// The pane has no padding of its own — messages/composer inset
					// themselves, the grid fills edge to edge (table-tight cells).
					<div class="chat-pane">
						{hasTabs ? (
							grid ? (
								/* Grid monitor: one cell per SLOT (cols × rows, row-major),
								 * occupied or EMPTY. Click a cell → focus that tab.
								 * Shift+drag a cell's title bar: drop onto an occupied slot
								 * SWAPS, onto an empty slot MOVES. While dragging, the
								 * source cell collapses to its title bar and the ghost
								 * follows the cursor as a bare title chip. */
								<div
									class="chat-grid"
									style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))` }}
									onDragOver={(e) => e.preventDefault()}
									onDrop={(e) => {
										e.preventDefault();
										clearDrag();
									}}
								>
									{Array.from({ length: gridCols * gridRows }, (_, slot) => {
										const sid = gridOrder[slot];
										const t = sid !== undefined ? tabs.find((x) => x.sessionId === sid) : undefined;
										if (!t) {
											// Empty slot: a legal drop target (moves the session here).
											return (
												<div
													key={`hole-${slot}`}
													class={`grid-cell empty${dropSlot === slot ? " drop-target" : ""}`}
													onDragOver={(e) => {
														e.preventDefault();
														e.stopPropagation();
														if (dragRef.current !== undefined) setDropSlot(slot);
													}}
													onDrop={(e) => {
														e.preventDefault();
														e.stopPropagation();
														dropTo(slot);
													}}
												/>
											);
										}
										return (
											<div
												key={t.sessionId}
												class={`grid-cell${t.sessionId === activeSid ? " active" : ""}${dragSid === t.sessionId ? " dragging" : ""}${dropSlot === slot ? " drop-target" : ""}`}
												onClick={() => focusTab(t)}
												title={titles[t.sessionId] || "Untitled session"}
												onDragOver={(e) => {
													e.preventDefault();
													e.stopPropagation();
													if (dragRef.current !== undefined && dragRef.current !== t.sessionId) setDropSlot(slot);
												}}
												onDrop={(e) => {
													e.preventDefault();
													e.stopPropagation();
													dropTo(slot);
												}}
											>
												{/* Title-bar drag re-slots the cell — plain HTML5 DnD,
												    NO modifier key. Three Shift-detection strategies all
												    hit browser timing/reporting hazards (dragstart
												    modifier snapshots, draggable locked at mousedown,
												    window-vs-iframe key focus); a title bar needs no
												    modifier (OS window metaphor) and click-vs-drag is
												    free: a click focuses the tab, a drag moves the cell. */}
												<div
													class="grid-cell-head"
													draggable
													title="拖拽标题栏到其他宫格（占用则交换，空位则移动）"
													onMouseDown={(e) => {
														const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
														grabRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
													}}
													onDragStart={(e) => {
														dragRef.current = t.sessionId;
														setDragSid(t.sessionId);
														if (e.dataTransfer) {
															e.dataTransfer.effectAllowed = "move";
															e.dataTransfer.setData("text/plain", t.sessionId);
															// Ghost = a bare title chip, not the whole cell:
															// clone the head off-screen, let the browser
															// snapshot it. Kept in a ref and removed on
															// dragend (an early setTimeout(0) removal can
															// race the snapshot).
															const ghost = (e.currentTarget as HTMLElement).cloneNode(true) as HTMLElement;
															ghost.classList.add("drag-ghost");
															ghost.style.width = `${(e.currentTarget as HTMLElement).offsetWidth}px`;
															document.body.appendChild(ghost);
															ghostRef.current = ghost;
															// Anchor the ghost at the recorded grip offset (clamped
															// into the chip) — the cursor keeps holding the exact
															// point it grabbed, instead of snapping to a canned
															// hotspot.
															e.dataTransfer.setDragImage(
																ghost,
																Math.min(grabRef.current.x, ghost.offsetWidth - 8),
																Math.min(grabRef.current.y, Math.max(4, ghost.offsetHeight - 4)),
															);
														}
													}}
													onDragEnd={() => {
														ghostRef.current?.remove();
														ghostRef.current = null;
														clearDrag();
													}}
												>
													<span class="grid-cell-title">{titles[t.sessionId] || "Untitled session"}</span>
													{tabBusy[t.sessionId] ? <i class="tab-live" title="agent 正在工作中" /> : null}
												</div>
												{/* While dragging, the SOURCE cell keeps only its title
												    bar (body unmounts → cheap drag + clear "it moved"). */}
												{dragSid !== t.sessionId && (
													<div class="grid-cell-body">
														{/* Fully interactive: any cell scrolls and takes prompt
														    input (pointer-events unlocked in CSS). */}
														{renderSessionPage(t, true)}
													</div>
												)}
											</div>
										);
									})}
								</div>
							) : (
							<>
								{/* Tabs moved into the topbar — they ride the header's
								    bottom edge and take no chat-body height. */}
								<div class="chat-stack">
									{tabs.map((t) => (
										<div key={t.sessionId} class="chat-layer" hidden={t.sessionId !== activeSid}>
											{renderSessionPage(t, t.sessionId === activeSid)}
										</div>
									))}
								</div>
							</>
							)
						) : (
							<div class="chat-empty">
								<div>
									<img class="empty-logo" src="/logo-256.png" alt="" width={96} height={96} />
									<div class="muted">Pick a session from the tree, or create a project to begin.</div>
								</div>
							</div>
						)}
					</div>
					)}
				</div>
			</main>
		</div>
	);
}

/** Grid size picker — the doc-editor "insert table" interaction: an N×N
 *  hover grid; sweeping the mouse fills a rect from the top-left cell to the
 *  hovered one (the "diagonal"), a caption reads "r × c", click applies.
 *  Hovering past the grid's edge clamps to the max. */
const PICKER_N = 6;
function GridSizePicker({
	x,
	y,
	cols,
	rows,
	onPick,
	onClose,
}: {
	x: number;
	y: number;
	cols: number;
	rows: number;
	onPick: (cols: number, rows: number) => void;
	onClose: () => void;
}): preact.JSX.Element {
	const [pick, setPick] = useState<{ c: number; r: number }>({ c: cols, r: rows });
	useEffect(() => {
		const off = (e: MouseEvent): void => {
			if (!(e.target as HTMLElement).closest?.(".grid-size-pop")) onClose();
		};
		window.addEventListener("mousedown", off);
		return () => window.removeEventListener("mousedown", off);
	}, [onClose]);
	const cells: preact.JSX.Element[] = [];
	for (let r = 1; r <= PICKER_N; r++) {
		for (let c = 1; c <= PICKER_N; c++) {
			const on = c <= pick.c && r <= pick.r;
			cells.push(
				<div
					key={`${r}-${c}`}
					class={"pick-cell" + (on ? " on" : "")}
					onMouseEnter={() => setPick({ c, r })}
					onClick={() => onPick(c, r)}
				/>,
			);
		}
	}
	return (
		// position:fixed at the captured button coords — the tab strip is an
		// overflow-x scroller and would clip an absolute child downward.
		<div class="grid-size-pop" style={{ left: `${x}px`, top: `${y + 6}px` }} onClick={(e) => e.stopPropagation()}>
			<div class="pick-grid" style={{ gridTemplateColumns: `repeat(${PICKER_N}, 16px)` }}>
				{cells}
			</div>
			<div class="pick-caption">
				{pick.r} 行 × {pick.c} 列
				<span class="muted">（点击应用）</span>
			</div>
		</div>
	);
}
