/**
 * `npm run login` — run the auth wizard standalone (reconfigure at any time).
 *
 * The boot-time wizard only fires when nothing has decided auth yet; this entry
 * forces it, so an operator can switch 简单模式 ↔ OAuth or re-set a password.
 * Re-running 简单模式 overwrites the verifier — that IS the password-reset path.
 */
import { mkdir } from "node:fs/promises";
import { loadServerConfig } from "../server/config";
import { loadSettings, applySettings } from "../agent/settings";
import { runAuthWizard } from "../server/auth/wizard";

const config = loadServerConfig();
await mkdir(config.dataDir, { recursive: true });
applySettings(loadSettings(config.dataDir));
await runAuthWizard(config.dataDir, { force: true });
