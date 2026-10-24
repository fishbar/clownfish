#!/usr/bin/env node
/**
 * node-pty ships its prebuilt `spawn-helper` binary (used to fork the pty on
 * macOS/Linux) WITHOUT the executable bit set — its own postinstall only
 * touches `build/Release/`, not the `prebuilds/<platform>/` tree node-pty
 * actually loads from at runtime (node-pty/lib/unixTerminal.js). Without this,
 * every pty spawn fails with a bare, unhelpful `Error: posix_spawnp failed.`
 * (reproduced and confirmed while wiring up CLI-backed sessions — see
 * agent/pty-worker.ts). Idempotent and silent when there's nothing to fix
 * (Windows, or a node-pty version that already ships it executable).
 */
import { readdirSync, statSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "node_modules", "node-pty", "prebuilds");
if (!existsSync(root)) process.exit(0);

for (const platformDir of readdirSync(root)) {
	const helper = join(root, platformDir, "spawn-helper");
	if (!existsSync(helper)) continue;
	const mode = statSync(helper).mode;
	if ((mode & 0o111) !== 0) continue; // already executable
	chmodSync(helper, mode | 0o111);
	console.log(`[fix-node-pty-perms] made executable: ${helper}`);
}
