/**
 * Server-side session storage: metadata index + transcript pages.
 *
 * Split from the transcript (which the worker owns and writes directly):
 *   - **Metadata** (id/projectId/title/timestamps) lives here, in a per-project
 *     `sessions.json` index that only the server touches. Used for the tree UI and
 *     REST listings.
 *   - **Messages** are read from the worker-owned transcript file via
 *     {@link SessionTranscript} (paginated for the UI).
 *
 * The server never writes transcript messages; that is the worker's job. So there
 * is no shared writable store and no cross-process write contention.
 */
import { generateId } from "../../agent/id";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionMeta, SessionBackend } from "../protocol";
import { SessionTranscript, type CompactRecord, type TranscriptPage } from "../../agent/transcript";
import { readTodos } from "../../agent/todo";
import type { TodoItem } from "../protocol";

export interface StoredPage extends SessionMeta {
	messages: AgentMessage[];
	total: number;
	oldestIndex: number;
	hasMore: boolean;
}

export interface SessionStore {
	create(projectId: string, title?: string, backend?: SessionBackend): Promise<SessionMeta>;
	/**
	 * Get-or-create a session with a FIXED id (the assistant's single session):
	 * returns the existing meta when the id is already in the index, otherwise
	 * creates it under that exact id. Normal `create()` mints random ids; this
	 * is the only path that may reuse a caller-chosen one.
	 */
	ensure(projectId: string, fixedId: string, title: string): Promise<SessionMeta>;
	list(projectId: string): Promise<SessionMeta[]>;
	meta(projectId: string, sessionId: string): Promise<SessionMeta | undefined>;
	loadPage(projectId: string, sessionId: string, limit: number, before?: number): Promise<StoredPage | undefined>;
	rename(projectId: string, sessionId: string, title: string | undefined): Promise<SessionMeta | undefined>;
	/**
	 * Flip a CLI-backed session's `backend.started` to true (idempotent, no-op
	 * for a builtin session or one already marked). Read back on the NEXT
	 * attach so a reopened session resumes instead of starting fresh — see
	 * agent/manager.ts's `spawnCli`.
	 */
	markCliStarted(projectId: string, sessionId: string): Promise<SessionMeta | undefined>;
	/** Delete the session and its transcript. False when it isn't in this project. */
	remove(projectId: string, sessionId: string): Promise<boolean>;
	/** The session's compaction record (summary + offset), or null if never compacted. */
	compactRecord(projectId: string, sessionId: string): Promise<CompactRecord | null>;
	/** The session plan (todo list + delegation ledger); [] when there is none. */
	todos(projectId: string, sessionId: string): Promise<TodoItem[]>;
	/** The session's shared DAG state (all plans), or null if none persisted. */
	loadDag(projectId: string, sessionId: string): Promise<unknown>;
	/** Sub-agents with a persisted transcript: id + delegation prompt (the first
	 * user message — run_agent builds it from its `task`/`context` args, so the
	 * UI can link a tool call to the sub it spawned). */
	listSubAgents(projectId: string, sessionId: string): Promise<{ agentId: string; prompt: string }[]>;
	/** One sub-agent's full transcript for the drill-down view, or undefined when
	 * the session or the sub transcript doesn't exist. */
	subAgentMessages(projectId: string, sessionId: string, agentId: string): Promise<AgentMessage[] | undefined>;
}

const INDEX_FILE = "sessions.json";

class FileSessionStore implements SessionStore {
	private readonly cache = new Map<string, SessionMeta[]>();
	/** Per-project tails of the mutation chain — see {@link serialize}. */
	private readonly tails = new Map<string, Promise<unknown>>();

	constructor(
		private readonly dataDir: string,
		private readonly sessionsDir: string,
	) {}

	private indexFile(projectId: string): string {
		return join(this.dataDir, "projects", projectId, INDEX_FILE);
	}

	private async readIndex(projectId: string): Promise<SessionMeta[]> {
		const cached = this.cache.get(projectId);
		if (cached) return cached;
		const raw = await readFile(this.indexFile(projectId), "utf8").catch(() => "[]");
		let metas: SessionMeta[];
		try {
			metas = JSON.parse(raw) as SessionMeta[];
		} catch {
			metas = [];
		}
		this.cache.set(projectId, metas);
		return metas;
	}

	private async writeIndex(projectId: string, metas: SessionMeta[]): Promise<void> {
		this.cache.set(projectId, metas);
		const file = this.indexFile(projectId);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(metas, null, 2), "utf8");
	}

	/**
	 * Run a read-modify-write against one project's index with no other mutation
	 * of that project interleaved. Without this, two concurrent creates both read
	 * the same array on a cold cache and the second write drops the first session.
	 */
	private serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.tails.get(projectId) ?? Promise.resolve()).then(fn, fn);
		this.tails.set(
			projectId,
			run.catch(() => undefined),
		);
		return run;
	}

	async create(projectId: string, title?: string, backend?: SessionBackend): Promise<SessionMeta> {
		return this.serialize(projectId, async () => {
			const now = Date.now();
			const m: SessionMeta = { id: generateId(), projectId, title, createdAt: now, updatedAt: now, ...(backend ? { backend } : {}) };
			const metas = await this.readIndex(projectId);
			metas.push(m);
			await this.writeIndex(projectId, metas);
			return m;
		});
	}

	async ensure(projectId: string, fixedId: string, title: string): Promise<SessionMeta> {
		return this.serialize(projectId, async () => {
			const metas = await this.readIndex(projectId);
			const existing = metas.find((m) => m.id === fixedId);
			if (existing) return existing;
			const now = Date.now();
			const m: SessionMeta = { id: fixedId, projectId, title, createdAt: now, updatedAt: now };
			metas.push(m);
			await this.writeIndex(projectId, metas);
			return m;
		});
	}

	async list(projectId: string): Promise<SessionMeta[]> {
		return (await this.readIndex(projectId))
			.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async meta(projectId: string, sessionId: string): Promise<SessionMeta | undefined> {
		return (await this.readIndex(projectId)).find((m) => m.id === sessionId);
	}

	async loadPage(projectId: string, sessionId: string, limit: number, before?: number): Promise<StoredPage | undefined> {
		const m = await this.meta(projectId, sessionId);
		if (!m) return undefined;
		const page: TranscriptPage = await new SessionTranscript(this.sessionsDir, sessionId).loadPage(limit, before);
		return { ...m, ...page };
	}

	async rename(projectId: string, sessionId: string, title: string | undefined): Promise<SessionMeta | undefined> {
		return this.serialize(projectId, async () => {
			const metas = await this.readIndex(projectId);
			const idx = metas.findIndex((m) => m.id === sessionId);
			if (idx < 0) return undefined;
			metas[idx] = { ...metas[idx], title, updatedAt: Date.now() };
			await this.writeIndex(projectId, metas);
			return metas[idx];
		});
	}

	async markCliStarted(projectId: string, sessionId: string): Promise<SessionMeta | undefined> {
		return this.serialize(projectId, async () => {
			const metas = await this.readIndex(projectId);
			const idx = metas.findIndex((m) => m.id === sessionId);
			if (idx < 0 || metas[idx].backend?.kind !== "cli" || metas[idx].backend.started) return metas[idx];
			metas[idx] = { ...metas[idx], backend: { ...metas[idx].backend, started: true } };
			await this.writeIndex(projectId, metas);
			return metas[idx];
		});
	}

	async remove(projectId: string, sessionId: string): Promise<boolean> {
		return this.serialize(projectId, async () => {
			const metas = await this.readIndex(projectId);
			// `sessionsDir` is flat and keyed by sessionId alone, so never touch
			// the filesystem for an id this index doesn't own — remove() rm -rf's
			// the session directory, so a cross-project (or traversal-shaped) id
			// must be a no-op here, not a deletion (the router also shape-checks
			// ids).
			if (!metas.some((m) => m.id === sessionId)) return false;
			await this.writeIndex(
				projectId,
				metas.filter((m) => m.id !== sessionId),
			);
			const transcript = new SessionTranscript(this.sessionsDir, sessionId);
			await transcript.remove();
			await transcript.clearCompact();
			return true;
		});
	}

	async todos(projectId: string, sessionId: string): Promise<TodoItem[]> {
		// Ownership check first — same flat-namespace hazard as compactRecord().
		if (!(await this.meta(projectId, sessionId))) return [];
		return readTodos(this.sessionsDir, sessionId);
	}

	async compactRecord(projectId: string, sessionId: string): Promise<CompactRecord | null> {
		// Same flat-namespace hazard as remove(): confirm ownership before reading,
		// or one project could read another's summary by id.
		if (!(await this.meta(projectId, sessionId))) return null;
		return new SessionTranscript(this.sessionsDir, sessionId).loadCompact();
	}

	async loadDag(projectId: string, sessionId: string): Promise<unknown> {
		void projectId;
		return new SessionTranscript(this.sessionsDir, sessionId).loadDag();
	}

	async listSubAgents(projectId: string, sessionId: string): Promise<{ agentId: string; prompt: string }[]> {
		if (!(await this.meta(projectId, sessionId))) return [];
		const tx = new SessionTranscript(this.sessionsDir, sessionId);
		const out: { agentId: string; prompt: string }[] = [];
		for (const agentId of await tx.listSubAgentIds()) {
			const prompt = await new SessionTranscript(this.sessionsDir, sessionId, agentId).firstPrompt();
			if (prompt) out.push({ agentId, prompt });
		}
		return out;
	}

	async subAgentMessages(projectId: string, sessionId: string, agentId: string): Promise<AgentMessage[] | undefined> {
		if (!(await this.meta(projectId, sessionId))) return undefined;
		// agentId becomes a filename — only the exact id shape is ever read.
		if (!/^[A-Za-z0-9_-]{6,64}$/.test(agentId) || agentId === "index") return undefined;
		const messages = await new SessionTranscript(this.sessionsDir, sessionId, agentId).load();
		return messages.length ? messages : undefined;
	}
}

export function createSessionStore(dataDir: string, sessionsDir: string): SessionStore {
	return new FileSessionStore(dataDir, sessionsDir);
}
