import { useEffect, useRef } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ChatClient } from "../api";
import { IconTerminal } from "../icons";
import type { SessionBackend } from "../../protocol";

/**
 * A single deferred `fit()` isn't reliably enough — a freshly-mounted
 * terminal (new tab, first ever session, a hidden tab just made visible) can
 * still measure a stale/undersized container for more than one animation
 * frame while the surrounding flex layout (sidebar, tab strip, grid) finishes
 * settling, and xterm silently falls back to its 80x24 default instead of
 * erroring. Confirmed manually: a single rAF still showed a tiny terminal
 * until the browser window was resized (which forces a fresh, correct fit).
 * Re-fitting across a few animation frames plus a trailing timeout is the
 * standard fix — cheap, and it converges on the first frame where the
 * container's real size is actually available.
 */
function settleFit(fit: FitAddon): void {
	let n = 0;
	const tick = (): void => {
		fit.fit();
		if (++n < 5) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	setTimeout(() => fit.fit(), 200);
}

/**
 * CLI-backed session view: a real terminal (xterm.js) wired to the pty
 * running on the session's worker. Far smaller than ChatPage — there is no
 * todo/dag/mode/queue state, no message log, no tool cards. Just bytes in
 * both directions plus resize, over the same /chat WebSocket ({@link ChatClient}
 * already knows the pty_input/pty_resize/pty_data/pty_exit frames).
 */
export function TerminalPage({
	projectId,
	sessionId,
	backend,
	active,
}: {
	projectId: string;
	sessionId: string;
	backend: SessionBackend;
	active: boolean;
}): preact.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal>();
	const fitRef = useRef<FitAddon>();
	const clientRef = useRef<ChatClient>();
	const exitedRef = useRef(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const term = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			theme: { background: "#0e1116", foreground: "#c9d1d9" },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		termRef.current = term;
		fitRef.current = fit;
		settleFit(fit);

		const client = new ChatClient(projectId, sessionId, {
			onReady: () => exitedRef.current === false && term.focus(),
			onPtyData: (data) => term.write(data),
			onPtyExit: (code) => {
				exitedRef.current = true;
				term.write(`\r\n\x1b[2m[process exited${code === null ? "" : ` (code ${code})`}]\x1b[0m\r\n`);
			},
			onError: (message) => term.write(`\r\n\x1b[31m[error] ${message}\x1b[0m\r\n`),
		});
		clientRef.current = client;
		client.connect();

		const onData = term.onData((data) => client.sendPtyInput(data));
		const onResize = term.onResize(({ cols, rows }) => client.sendPtyResize(cols, rows));

		const ro = new ResizeObserver(() => {
			fit.fit();
		});
		ro.observe(el);

		return () => {
			onData.dispose();
			onResize.dispose();
			ro.disconnect();
			client.close();
			term.dispose();
			termRef.current = undefined;
			fitRef.current = undefined;
			clientRef.current = undefined;
		};
		// projectId/sessionId identify the session; a change means a different
		// terminal entirely, not a prop update on the same one.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectId, sessionId]);

	// Re-fit (and let the terminal receive input) when this tab becomes active —
	// a hidden tab's container is `display:none` (zero size), so whatever size
	// was last computed while hidden is stale; re-measure once it's actually
	// laid out again, then take focus.
	useEffect(() => {
		if (!active) return;
		if (fitRef.current) settleFit(fitRef.current);
		requestAnimationFrame(() => {
			if (!exitedRef.current) termRef.current?.focus();
		});
	}, [active]);

	return (
		<div class="terminal-page">
			<div class="terminal-head">
				<IconTerminal />
				<span class="terminal-label">{backend.kind === "cli" ? backend.label || backend.command : "CLI"}</span>
			</div>
			<div class="terminal-body" ref={containerRef} />
		</div>
	);
}
