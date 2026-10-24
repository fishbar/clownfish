/**
 * Clownfish runner — drive the agent exactly the way the web UI does.
 *
 * One server per bench process (auth off, its own throwaway dataDir), one project
 * per task workspace, one session per run. The prompt goes over the `/chat`
 * WebSocket and the run is finished when the worker reports `agent_end`; there is
 * no privileged back door, so what is measured is the real product path.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clownfishUsage } from "../usage.mjs";
import { createServer } from "node:net";
import { WebSocket } from "ws";

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Boot a server and wait for /api/health. Returns a handle with `stop()`. */
export async function startClownfish({ dataDir, model, env = {}, log = () => {} }) {
	const sessionsDir = join(dataDir, "sessions");
	const port = await freePort();
	const child = spawn("npx", ["tsx", "server/index.ts"], {
		env: {
			...process.env,
			...env,
			CLOWNFISH_AUTH: "off",
			CLOWNFISH_DATA_DIR: dataDir,
			CLOWNFISH_PORT: String(port),
			CLOWNFISH_MODEL: model,
			// One idle session must not be reaped mid-benchmark.
			CLOWNFISH_AGENT_IDLE_TTL: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const logs = [];
	const collect = (d) => {
		const text = d.toString();
		logs.push(text);
		if (logs.length > 4000) logs.shift();
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`clownfish server exited (${child.exitCode}):\n${logs.join("")}`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (res.ok) break;
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) throw new Error(`clownfish server did not start:\n${logs.join("")}`);
		await new Promise((r) => setTimeout(r, 250));
	}
	log(`clownfish server on :${port}`);

	const api = async (path, init) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		});
		const text = await res.text();
		let body;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = text;
		}
		if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
		return body;
	};

	return {
		port,
		api,
		logs,
		sessionsDir,
		async stop() {
			child.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 800));
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}

/**
 * Run one task in `workspace` and resolve with a transcript-level summary.
 * Resolves (never rejects) on timeout so a hung run still scores.
 */
export async function runClownfishTask({ server, workspace, name, prompt, timeoutMs, log = () => {} }) {
	const project = await server.api("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, path: workspace }),
	});
	const session = await server.api(`/api/projects/${project.id}/sessions`, { method: "POST", body: JSON.stringify({}) });

	const started = Date.now();
	// `turns` = model round-trips. Claude Code reports its own; without the same
	// number on this side the cost difference cannot be explained, only observed.
	const stats = { toolCalls: 0, subAgents: 0, todos: 0, textChars: 0, turns: 0, errors: [] };
	let settled = false;

	const outcome = await new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat`);
		const finish = (status) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(status);
		};
		const timer = setTimeout(() => finish("timeout"), timeoutMs);

		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: project.id, sessionId: session.id })));
		ws.on("message", (data) => {
			let f;
			try {
				f = JSON.parse(data.toString());
			} catch {
				return;
			}
			switch (f.type) {
				case "ready":
					ws.send(JSON.stringify({ type: "prompt", text: prompt }));
					break;
				// One assistant message = one model round-trip. This is the number
				// that explains the token gap: every round-trip re-sends the whole
				// conversation, so turns multiply prompt tokens.
				case "message_start":
					stats.turns++;
					break;
				case "tool_start":
					stats.toolCalls++;
					if (f.toolName === "run_agent") stats.subAgents++;
					if (f.toolName === "todo") stats.todos++;
					break;
				case "text_delta":
					stats.textChars += f.delta?.length ?? 0;
					break;
				case "error":
					stats.errors.push(String(f.message).slice(0, 300));
					break;
				case "agent_end":
					finish("done");
					break;
			}
		});
		ws.on("error", (err) => {
			stats.errors.push(`ws: ${err.message}`);
			finish("ws-error");
		});
		ws.on("close", () => finish("closed"));
	});

	// Stop the worker so its transcript is flushed and the reflection pass runs —
	// the same lifecycle a real session gets.
	await server.api(`/api/projects/${project.id}/sessions/${session.id}/agent/stop`, { method: "POST" }).catch(() => {});

	// Plan hygiene: a plan whose steps never leave `pending`, or that grows a
	// duplicate entry per delegation, is worse than no plan — it misinforms the
	// user. These are the numbers an improvement to the todo/run_agent contract
	// has to move.
	const planFile = join(server.sessionsDir, `${session.id}.todo.json`);
	const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : [];
	const planStats = {
		planItems: plan.length,
		planPending: plan.filter((i) => i.status === "pending").length,
		planDelegated: plan.filter((i) => i.agent).length,
		planSettled: plan.filter((i) => i.status === "done" || i.status === "failed" || i.status === "stopped").length,
	};
	log(`clownfish ${name}: ${outcome} in ${((Date.now() - started) / 1000).toFixed(0)}s, ${stats.toolCalls} tool calls`);
	// Token accounting, summed over the session AND every sub-agent it spawned —
	// a delegation's tokens are still the run's tokens.
	const usage = clownfishUsage(server.sessionsDir, session.id);
	return {
		agent: "clownfish",
		outcome,
		ms: Date.now() - started,
		...stats,
		...planStats,
		usage,
		projectId: project.id,
		sessionId: session.id,
	};
}
