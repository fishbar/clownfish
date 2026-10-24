/**
 * RealtimeHub — thin browser ↔ agent proxy.
 *
 * The browser connects over TCP `/chat` and is bound to (projectId, sessionId) on
 * `hello`. The hub resolves the project/session, asks the {@link AgentManager} to
 * ensure the agent worker is running, and subscribes the socket. From then on the
 * manager fans the worker's events out to subscribers and replays in-flight state
 * for late joiners; `prompt`/`abort` are forwarded to the worker. The agent runs
 * independently of this connection — closing the tab does not stop a run.
 *
 * Protocol (browser ⇄ server) is unchanged: see {@link ClientToServer} /
 * {@link ServerToClient} in ../protocol.
 */
import type { Server, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientToServer, ServerToClient } from "../protocol";
import type { ServerContext } from "../context";
import { readSession } from "../auth";

interface Conn {
	ws: WebSocket;
	projectId?: string;
	sessionId?: string;
}

/**
 * Liveness probe interval. A browser tab that vanishes with the network (laptop
 * lid, VPN drop) never sends a FIN, so without this its socket stays in the
 * manager's subscriber set forever and every fan-out writes into a dead pipe.
 */
const PING_INTERVAL_MS = 30_000;

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Cross-site WS handshakes are rejected: browsers always send `Origin` on an
 * upgrade (non-browser clients omit it and pass). The origin's host must match
 * the request's Host header — true for same-origin pages and the Vite dev
 * proxy (which forwards without changeOrigin), false for other sites. This
 * backs up the SameSite=Lax cookie against older/partial browser impls.
 */
function originAllowed(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		const host = new URL(origin).host;
		return host !== "" && host === req.headers.host;
	} catch {
		return false;
	}
}

export class RealtimeHub {
	constructor(private readonly ctx: ServerContext) {}

	attach(server: Server): void {
		// When auth is on, reject the WS upgrade without a valid session cookie
		// (same HMAC check as requireAuth, applied to the HTTP upgrade request).
		const auth = this.ctx.auth;
		const wss = new WebSocketServer({
			server,
			path: "/chat",
			verifyClient: (
				info: { req: IncomingMessage },
				cb: (ok: boolean, code?: number, message?: string) => void,
			) => {
				if (!originAllowed(info.req)) return cb(false, 403, "cross-origin");
				if (auth && !readSession(auth.sessionSecret, info.req.headers.cookie)) {
					return cb(false, 401, "unauthorized");
				}
				cb(true);
			},
		});
		wss.on("connection", (ws) => this.handle(ws));

		// Standard ws heartbeat: mark on pong, terminate anything that missed the
		// previous round. Cleared when the server closes so tests can exit.
		const alive = new WeakSet<WebSocket>();
		wss.on("connection", (ws) => {
			alive.add(ws);
			ws.on("pong", () => alive.add(ws));
		});
		const timer = setInterval(() => {
			for (const ws of wss.clients) {
				if (!alive.has(ws)) {
					ws.terminate();
					continue;
				}
				alive.delete(ws);
				try {
					ws.ping();
				} catch {
					ws.terminate();
				}
			}
		}, PING_INTERVAL_MS);
		timer.unref?.();
		wss.on("close", () => clearInterval(timer));
	}

	private send(ws: WebSocket, frame: ServerToClient): void {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	}

	private handle(ws: WebSocket): void {
		const conn: Conn = { ws };

		ws.on("message", async (data) => {
			let msg: ClientToServer;
			try {
				msg = JSON.parse(data.toString()) as ClientToServer;
			} catch {
				return this.send(ws, { type: "error", message: "invalid JSON frame" });
			}
			try {
				if (msg.type === "hello") await this.onHello(conn, msg);
				else if (msg.type === "subscribe") this.onSubscribe(conn, msg);
				else if (msg.type === "prompt") await this.onPrompt(conn, msg);
				else if (msg.type === "abort") conn.sessionId && this.ctx.agents.abort(conn.sessionId);
				else if (msg.type === "detach_agent") conn.sessionId && this.ctx.agents.detachAgent(conn.sessionId, msg.agentId);
				else if (msg.type === "tool_decision")
					conn.sessionId && this.ctx.agents.decideTool(conn.sessionId, msg.toolCallId, msg.approved);
				else if (msg.type === "pty_input") conn.sessionId && this.ctx.agents.sendPtyInput(conn.sessionId, msg.data);
				else if (msg.type === "pty_resize") conn.sessionId && this.ctx.agents.sendPtyResize(conn.sessionId, msg.cols, msg.rows);
				else this.send(ws, { type: "error", message: `unknown frame type: ${(msg as { type: string }).type}` });
			} catch (err) {
				this.send(ws, { type: "error", message: errMessage(err) });
			}
		});

		ws.on("close", () => {
			if (conn.sessionId) this.ctx.agents.unsubscribe(ws);
		});
		ws.on("error", () => {
			if (conn.sessionId) this.ctx.agents.unsubscribe(ws);
		});
	}

	private async onHello(conn: Conn, msg: Extract<ClientToServer, { type: "hello" }>): Promise<void> {
		const project = await this.ctx.projects.get(msg.projectId);
		if (!project) throw new Error(`project not found: ${msg.projectId}`);
		const meta = await this.ctx.sessions.meta(msg.projectId, msg.sessionId);
		if (!meta) throw new Error(`session not found: ${msg.sessionId}`);

		// Lazy init (builtin sessions): opening a session only ATTACHES the socket
		// (no worker spawn — history comes from the REST transcript API). The first
		// prompt spawns the agent. A CLI-backed (pty) session spawns eagerly inside
		// attach() instead. Either way the manager replays in-flight state and
		// sends `ready`.
		//
		// A second hello (client switching sessions on one socket) must first
		// leave the previous session — otherwise the socket stays in the old
		// record's subscriber map and receives frames from BOTH sessions.
		if (conn.sessionId && conn.sessionId !== msg.sessionId) this.ctx.agents.unsubscribe(conn.ws);
		conn.projectId = msg.projectId;
		conn.sessionId = msg.sessionId;
		await this.ctx.agents.attach(project, msg.sessionId, conn.ws, msg.agentId, meta.backend);
	}

	/** Switch the socket's agentId interest (drill into a subagent stream / back out). */
	private onSubscribe(conn: Conn, msg: Extract<ClientToServer, { type: "subscribe" }>): void {
		if (!conn.sessionId) throw new Error("session not ready; send hello first");
		this.ctx.agents.setInterest(conn.ws, msg.agentId);
	}

	private async onPrompt(conn: Conn, msg: Extract<ClientToServer, { type: "prompt" }>): Promise<void> {
		if (!conn.projectId || !conn.sessionId) throw new Error("session not ready; send hello first");
		const project = await this.ctx.projects.get(conn.projectId);
		if (!project) throw new Error(`project not found: ${conn.projectId}`);
		await this.ctx.agents.prompt(project, conn.sessionId, msg.text, msg.mode);
	}
}
