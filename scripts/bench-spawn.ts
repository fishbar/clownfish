/** Bench: worker spawn→ready latency + RSS — source (tsx) vs prebuilt bundle.
 *
 *  `npm start` forks the esbuild bundle (dist/worker.mjs) instead of the tsx
 *  source entry; this bench quantifies the difference. Phases (skipped when
 *  the prebuilt bundle is absent):
 *
 *    source   — npx tsx bench against agent/worker.ts (tsx loader + esbuild
 *               transpile on every fork)
 *    prebuilt — plain-node fork of dist/worker.mjs (run `make build-worker`)
 *
 *  Each phase: N sequential spawns (first = cold, rest = warm) then one
 *  K-parallel burst (wall time). Usage:
 *
 *    npx tsx scripts/bench-spawn.ts [--runs 4] [--parallel 6] [--only source|prebuilt]
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "../agent/manager";
import { startUds } from "../agent/uds";
import type { Project } from "../server/protocol";

const args = process.argv.slice(2);
const val = (name: string, dflt: number): number => {
	const i = args.indexOf(`--${name}`);
	const inline = args.find((a) => a.startsWith(`--${name}=`));
	return Number((i >= 0 ? args[i + 1] : undefined) ?? inline?.split("=")[1] ?? dflt);
};
const runs = val("runs", 4);
const parallel = val("parallel", 6);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

const sourceEntry = fileURLToPath(new URL("../agent/worker.ts", import.meta.url));
const prebuiltEntry = fileURLToPath(new URL("../dist/worker.mjs", import.meta.url));

const project = {
	id: "p1",
	name: "bench",
	path: process.cwd(),
	createdAt: 0,
	updatedAt: 0,
	config: { provider: "anthropic", model: "glm-5.1", skillsDirs: [] },
} as unknown as Project;

async function vmRss(pid: number | undefined): Promise<number | undefined> {
	if (!pid) return undefined;
	const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => null);
	const m = status?.match(/VmRSS:\s+(\d+) kB/);
	return m ? Math.round(Number(m[1]) / 1024) : undefined; // MB
}

const canPrebuilt = await readFile(prebuiltEntry, "utf8")
	.then(() => true)
	.catch(() => false);

const phases: Array<{ name: string; entry: string }> = [];
if (!only || only === "source") phases.push({ name: "source (tsx)", entry: sourceEntry });
if ((!only || only === "prebuilt") && canPrebuilt) phases.push({ name: "prebuilt (dist/worker.mjs)", entry: prebuiltEntry });
if (phases.length === 0) {
	console.error("nothing to bench: --only prebuilt but dist/worker.mjs is missing (run `make build-worker`)");
	process.exit(1);
}

const avg = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1));

for (const phase of phases) {
	const work = await mkdtemp(join(tmpdir(), "clownfish-bench-"));
	const udsPath = join(work, "agent.sock");
	const mgr = new AgentManager({
		dataDir: join(work, "data"),
		sessionsDir: join(work, "sessions"),
		udsPath,
		workerModule: phase.entry,
		idleTtlMs: 0, // never reap mid-bench
		spawnMode: "process",
	});
	const uds = await startUds(udsPath, mgr);
	console.log(`\n=== ${phase.name} — ${runs} sequential + ${parallel}-parallel burst ===`);

	const seq: Array<{ ms: number; rss?: number }> = [];
	for (let i = 0; i < runs; i++) {
		const sid = `seq-${i}`;
		const t0 = performance.now();
		await mgr.ensureAgent(project, sid);
		const ms = Math.round(performance.now() - t0);
		const rss = await vmRss(mgr.status(sid)?.pid);
		seq.push({ ms, rss });
		console.log(`  spawn ${i + 1}/${runs}: ${ms}ms${rss ? `, RSS ${rss}MB` : ""}`);
		await mgr.stop(sid);
		await new Promise((r) => setTimeout(r, 200));
	}
	const warm = seq.slice(1);
	console.log(`  cold(first) ${seq[0]?.ms}ms | warm avg ${avg(warm.map((s) => s.ms))}ms | warm RSS avg ${avg(warm.map((s) => s.rss ?? 0))}MB`);

	const ids = Array.from({ length: parallel }, (_, i) => `burst-${i}`);
	const t0 = performance.now();
	await Promise.all(ids.map((id) => mgr.ensureAgent(project, id)));
	const burstMs = Math.round(performance.now() - t0);
	const rssAll = await Promise.all(ids.map((id) => vmRss(mgr.status(id)?.pid)));
	console.log(`  ${parallel}-parallel burst: ${burstMs}ms wall | RSS avg ${avg(rssAll.filter((r): r is number => !!r))}MB`);

	await mgr.shutdownAll();
	await uds.close();
	await rm(work, { recursive: true, force: true });
}
console.log("\ndone.");
