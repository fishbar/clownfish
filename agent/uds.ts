/**
 * Unix-domain WebSocket server for agent workers.
 *
 * One shared socket (default `${dataDir}/agent.sock`) multiplexes every worker;
 * each connection identifies itself with a `register {sessionId}` frame, after
 * which the {@link AgentManager} owns the socket. The stale socket file is
 * unlinked before listen and on shutdown (`wss.close()` alone does NOT unlink).
 */
import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import type { WorkerFrame } from "./protocol";
import type { AgentManager } from "./manager";

/** Conservative `sockaddr_un.sun_path` capacity (104 on macOS/BSD, 108 on Linux). */
const SUN_PATH_MAX = 103;

export interface UdsServer {
	readonly path: string;
	close(): Promise<void>;
}

export async function startUds(udsPath: string, manager: AgentManager): Promise<UdsServer> {
	// The socket's parent dir must exist before listen — a missing parent
	// surfaces as EACCES (not ENOENT) on Linux, which is confusing. Create it
	// recursively so the server can boot into a fresh dataDir.
	await mkdir(dirname(udsPath), { recursive: true });
	// sockaddr_un.sun_path is a fixed 104/108-byte buffer; a longer path fails at
	// listen() with a bare EINVAL that points nowhere near the real cause.
	if (Buffer.byteLength(udsPath) > SUN_PATH_MAX) {
		throw new Error(
			`agent socket path is too long (${Buffer.byteLength(udsPath)} bytes, max ${SUN_PATH_MAX}): ${udsPath}\n` +
				"Set CLOWNFISH_AGENT_SOCKET to a shorter path (or use a shorter CLOWNFISH_DATA_DIR).",
		);
	}
	await unlink(udsPath).catch(() => undefined);
	const http: HttpServer = createServer();
	const wss = new WebSocketServer({ server: http, path: "/agent" });

	wss.on("connection", (ws) => {
		// First frame must be a register; only then does the manager take over.
		const onFirst = (data: unknown): void => {
			let frame: WorkerFrame;
			try {
				frame = JSON.parse(String(data)) as WorkerFrame;
			} catch {
				ws.close(1008, "invalid frame");
				return;
			}
			if (frame.type !== "register" || !frame.sessionId) {
				ws.close(1008, "expected register");
				return;
			}
			ws.off("message", onFirst);
			manager.attachWorker(frame.sessionId, ws, frame.agentId);
		};
		ws.on("message", onFirst);
	});

	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(udsPath, () => {
			http.off("error", reject);
			resolve();
		});
	});
	// Owner-only: any local user who can reach the socket can register as a
	// worker (impersonate agents / receive prompts), so don't rely on the umask.
	await chmod(udsPath, 0o600).catch(() => undefined);

	return {
		path: udsPath,
		async close(): Promise<void> {
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			http.close();
			await unlink(udsPath).catch(() => undefined);
		},
	};
}
