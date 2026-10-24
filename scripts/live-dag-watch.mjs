/**
 * Attach to a running session and wait for a given background agent to end,
 * then dump the final dag state. Usage:
 *   node scripts/live-dag-watch.mjs <sessionId> <agentId> [dagId]
 */
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const [, , sid, agentId, dagIdArg] = process.argv;
if (!sid || !agentId) {
	console.error("usage: node scripts/live-dag-watch.mjs <sessionId> <agentId> [dagId]");
	process.exit(1);
}
const pid = "BWDvYYTtA2qG";
const dir = join(homedir(), ".clownfish", "sessions", sid);

await new Promise((resolveDone) => {
	const ws = new WebSocket("ws://localhost:4317/chat");
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", projectId: pid, sessionId: sid })));
	ws.on("message", (data) => {
		const f = JSON.parse(data.toString());
		if (f.type === "agent_spawned" && f.agentId === agentId) console.log(`[watch] ${agentId.slice(0, 8)} alive (snapshot replay)`);
		if (f.type === "agent_ended" && f.agentId === agentId) {
			console.log(`[watch] ${agentId.slice(0, 8)} ended`);
			setTimeout(async () => {
				const dag = JSON.parse(await readFile(join(dir, "dag.json"), "utf8"));
				for (const tree of dag.dags) {
					if (dagIdArg && tree.id !== dagIdArg) continue;
					const root = tree.nodes[tree.rootId];
					const kids = Object.values(tree.nodes).filter((n) => n.id !== tree.rootId);
					const by = Object.groupBy(kids, (n) => n.status);
					console.log(`[watch] dag ${tree.id.slice(0, 8)} root=${root.status} owner=${tree.ownerAgent.slice(0, 8)} children=${JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])))}`);
					console.log(`[watch] root result: ${(root.result ?? "").slice(0, 300)}`);
				}
				ws.close();
				resolveDone();
			}, 1500);
		}
	});
	ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
	setTimeout(() => { console.log("[watch timeout 600s]"); process.exit(2); }, 600_000);
});
console.log("watch done");
process.exit(0);
