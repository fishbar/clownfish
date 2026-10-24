/**
 * The UI's icon set — one family, drawn here, so every control and status mark
 * reads as one thing.
 *
 * Emoji and text glyphs were what was there before (🧠 ⚙️ 🛠 ✎ 🔔 ⛓ ⚡ ✓ × ⟳),
 * and they do not make a set:
 * every platform renders them in its own style and weight, they cannot take
 * the theme's colour, and next to each other they look like four different
 * apps. These are 16px line icons on a shared 1.6px stroke, `currentColor`
 * throughout — so a row's icon dims, brightens and tints exactly as its label
 * does.
 */

const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" as const, "stroke-linejoin": "round" as const, "aria-hidden": true };

/** 记忆 — a brain, outlined like everything else. */
export function IconBrain(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M11 4.5c-1.9 0-3.4 1.2-3.7 2.9C5.5 7.9 4.3 9.4 4.3 11.2c0 .9.3 1.7.8 2.4-.4.7-.6 1.4-.6 2.2 0 2 1.5 3.6 3.4 3.8.5 1 1.6 1.7 2.8 1.7H11V4.5z" />
			<path d="M13 4.5c1.9 0 3.4 1.2 3.7 2.9 1.8.5 3 2 3 3.8 0 .9-.3 1.7-.8 2.4.4.7.6 1.4.6 2.2 0 2-1.5 3.6-3.4 3.8-.5 1-1.6 1.7-2.8 1.7H13V4.5z" />
			<path d="M7.5 10.2c1-.6 2-.6 3.5 0M13 10.2c1.5-.6 2.5-.6 3.5 0M7 15c1.2-.8 2.4-.8 4 0M13 15c1.6-.8 2.8-.8 4 0" />
		</svg>
	);
}

/** 设置 — sliders, not a gear: three tracks with a thumb each. */
export function IconSliders(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M4 7h16M4 12h16M4 17h16" opacity="0.55" />
			<circle cx="15" cy="7" r="2.2" fill="var(--panel)" />
			<circle cx="8" cy="12" r="2.2" fill="var(--panel)" />
			<circle cx="17" cy="17" r="2.2" fill="var(--panel)" />
		</svg>
	);
}

/** 项目 — a folder. */
export function IconFolder(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M3.5 7.5a2 2 0 0 1 2-2H9l2 2h7.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9z" />
		</svg>
	);
}

/** New — a bare plus. */
export function IconPlus(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}

/** Close — a bare cross (the + button's other state). */
export function IconX(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	);
}

/** Rename. */
export function IconPencil(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4z" />
			<path d="M13.5 6.5l4 4" />
		</svg>
	);
}

/** Delete. */
export function IconTrash(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
		</svg>
	);
}

/** Disclosure caret for a project row; rotates when open. */
export function IconCaret(): preact.JSX.Element {
	return (
		<svg {...base} class="icon icon-caret">
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

// ---------------------------------------------------------------- status ----

/** Done. */
export function IconCheck(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M5 12.5l4.5 4.5L19 7.5" />
		</svg>
	);
}

/** Failed — a cross, drawn inside a circle so it reads as a state, not a close button. */
export function IconCross(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<circle cx="12" cy="12" r="8.5" />
			<path d="M9 9l6 6M15 9l-6 6" />
		</svg>
	);
}

/** Running — an open arc; CSS spins it. */
export function IconSpinner(): preact.JSX.Element {
	return (
		<svg {...base} class="icon icon-spin">
			<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" />
		</svg>
	);
}

/** Pending / idle — a hollow dot. */
export function IconDot(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<circle cx="12" cy="12" r="3.5" />
		</svg>
	);
}

/** Cancelled / stopped — a circle with a slash. */
export function IconBan(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<circle cx="12" cy="12" r="8.5" />
			<path d="M6 6l12 12" />
		</svg>
	);
}

/**
 * One status → one icon. Every card, row and tree in the chat used to carry its
 * own inline ternary of ✓ × ⟳ · glyphs; this is the single place the mapping
 * lives, so "running" looks the same on a tool row, a workflow step, a sub-agent
 * chip and a plan node.
 */
export type IconStatus = "ok" | "error" | "running" | "pending" | "cancelled";
export function StatusIcon({ status }: { status: IconStatus }): preact.JSX.Element {
	switch (status) {
		case "ok":
			return <IconCheck />;
		case "error":
			return <IconCross />;
		case "running":
			return <IconSpinner />;
		case "cancelled":
			return <IconBan />;
		default:
			return <IconDot />;
	}
}

// ---------------------------------------------------------------- topbar ----

export function IconBell(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15l1.5-1.5zM10 20a2 2 0 0 0 4 0" />
		</svg>
	);
}

export function IconBellOff(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M8.5 6.2A6 6 0 0 1 18 11v5.5l1.5 1.5H9M6 11v5.5L4.5 18H15M10 20a2 2 0 0 0 4 0M4 4l16 16" />
		</svg>
	);
}

export function IconMenu(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M4 7h16M4 12h16M4 17h16" />
		</svg>
	);
}

// ------------------------------------------------------------ kind marks ----

/** Workflow — two links. */
export function IconChain(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.3 1.3" />
			<path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3" />
		</svg>
	);
}

/** Live activity — a bolt. */
export function IconBolt(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M13 3L5 13.5h6L10.5 21 19 10.5h-6L13 3z" />
		</svg>
	);
}

/** Summary / document. */
export function IconDoc(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
			<path d="M14 3.5v4h4M9 12h6M9 16h6" />
		</svg>
	);
}

/** HTML demo — a browser window. */
export function IconWindow(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<rect x="3.5" y="5" width="17" height="14" rx="2" />
			<path d="M3.5 9.5h17M7 7.3h.01M9.5 7.3h.01" />
		</svg>
	);
}

/** Grid monitor — four panes in a window. */
export function IconGrid(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<rect x="4" y="4" width="7" height="7" rx="1.5" />
			<rect x="13" y="4" width="7" height="7" rx="1.5" />
			<rect x="4" y="13" width="7" height="7" rx="1.5" />
			<rect x="13" y="13" width="7" height="7" rx="1.5" />
		</svg>
	);
}

/** A bare chevron pointing down (pickers under their button). */
export function IconChevronDown(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<path d="M6 9l6 6 6-6" />
		</svg>
	);
}

/** Plan tree — a branching node. */
export function IconTree(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<circle cx="12" cy="5.5" r="2" />
			<circle cx="6" cy="18.5" r="2" />
			<circle cx="18" cy="18.5" r="2" />
			<path d="M12 7.5V12M12 12L6 16.5M12 12l6 4.5" />
		</svg>
	);
}

/** CLI-backed (pty) session — a terminal prompt. */
export function IconTerminal(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<rect x="3" y="4.5" width="18" height="15" rx="2" />
			<path d="M7 9.5l4 3-4 3M13 15.5h4" />
		</svg>
	);
}

/** Claude Code session — Claude's spark: twelve rays of alternating length
 *  around the centre, in Claude's own terracotta (a brand mark keeps its
 *  colour — the one exception to `currentColor` in this set). */
export function IconClaude(): preact.JSX.Element {
	return (
		<svg {...base} class="icon icon-brand" stroke="#D97757" stroke-width={2.4}>
			{Array.from({ length: 12 }, (_, i) => (
				<line key={i} x1="12" y1="10.8" x2="12" y2={i % 2 ? 4.5 : 1.8} transform={`rotate(${i * 30 + 15} 12 12)`} />
			))}
		</svg>
	);
}

/** Codex session — OpenAI's knot, reduced to three interlocked capsules
 *  rotated 120° apart (reads cleanly at 13px where the six-petal original
 *  smears). Monochrome like the original, so it takes `currentColor`. */
export function IconCodex(): preact.JSX.Element {
	return (
		<svg {...base} class="icon icon-brand">
			{[0, 120, 240].map((deg) => (
				<rect key={deg} x="8.5" y="4.5" width="7" height="15" rx="3.5" transform={`rotate(${deg} 12 12)`} />
			))}
		</svg>
	);
}

/** Row overflow menu — three horizontal dots. */
export function IconMore(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
			<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
			<circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** Terminate a session's process — a stop square. */
export function IconStop(): preact.JSX.Element {
	return (
		<svg {...base} class="icon">
			<rect x="6" y="6" width="12" height="12" rx="2" />
		</svg>
	);
}
