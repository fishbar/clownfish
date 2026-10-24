/**
 * File-backed pi-ai `CredentialStore` — persists OAuth (and any api-key)
 * credentials pi-ai's `Models` manages, so a login survives past the process
 * that ran it. Without this, `builtinModels()` falls back to its own
 * in-process `InMemoryCredentialStore` and every worker restart forgets the
 * login — exactly the OpenAI Codex (ChatGPT Plus/Pro) OAuth flow this exists
 * for: `pi-ai`'s `openai-codex` provider (`agent/models.ts`'s comment on
 * `resolveRuntime` points here) already ships the full login/refresh dance
 * (`@earendil-works/pi-ai`'s `auth/oauth/openai-codex.ts`), it only needs
 * somewhere durable to keep the result.
 *
 * One JSON file at `<dataDir>/auth/oauth-credentials.json` (0600), keyed by
 * provider id — same shape `Models` already uses as "today's auth.json"
 * (see pi-ai's `Credential` type). Writes are serialized per provider through
 * a promise chain (pi-ai's own contract for `modify`) and are atomic
 * (tmp + rename), matching the pattern already used for `dag.json`/goals.json
 * elsewhere in this codebase — a torn write must never corrupt every other
 * provider's credential.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { AuthContext, Credential, CredentialInfo, CredentialStore, AuthOperationOptions } from "@earendil-works/pi-ai";

function credentialsPath(dataDir: string): string {
	return join(dataDir, "auth", "oauth-credentials.json");
}

async function readAll(path: string): Promise<Record<string, Credential>> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, Credential>) : {};
	} catch {
		return {};
	}
}

async function writeAll(path: string, data: Record<string, Credential>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
	await rename(tmp, path);
}

/** A file-backed `CredentialStore` rooted at `<dataDir>/auth/oauth-credentials.json`. */
export function createFileCredentialStore(dataDir: string): CredentialStore {
	const path = credentialsPath(dataDir);
	// Per-provider write serialization, exactly as CredentialStore.modify requires
	// ("Mutual exclusion per provider id"). A single shared chain is simplest and
	// correct here — logins are rare, interactive, human-paced events; there is
	// no throughput case that needs true per-provider parallelism.
	let chain: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = chain.then(fn, fn);
		chain = next.catch(() => undefined);
		return next;
	};

	return {
		async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
			const all = await readAll(path);
			return all[providerId];
		},
		async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
			const all = await readAll(path);
			return Object.entries(all).map(([providerId, c]) => ({ providerId, type: c.type }));
		},
		async modify(providerId, fn, _options?: AuthOperationOptions): Promise<Credential | undefined> {
			return enqueue(async () => {
				const all = await readAll(path);
				const next = await fn(all[providerId]);
				if (next === undefined) return all[providerId];
				all[providerId] = next;
				await writeAll(path, all);
				return next;
			});
		},
		async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
			await enqueue(async () => {
				const all = await readAll(path);
				if (!(providerId in all)) return;
				delete all[providerId];
				await writeAll(path, all);
			});
		},
	};
}

/** Trivial `AuthContext`: real env vars, real filesystem — the only two things pi-ai's auth resolution ever asks for. */
export function createAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			return process.env[name];
		},
		async fileExists(path: string): Promise<boolean> {
			const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
			return existsSync(expanded);
		},
	};
}
