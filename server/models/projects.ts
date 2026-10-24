/**
 * ProjectManager — registry of workspaces.
 *
 * Projects are stored in `<dataDir>/projects.json`. A project binds a name, a
 * workspace path (the coding tools' cwd), and a {@link ProjectConfig} (provider,
 * model, skills dirs). New projects inherit the server's default provider/model.
 */
import { generateId } from "../../agent/id";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type { Project, ProjectConfig, CreateProjectBody, UpdateProjectBody } from "../protocol";
import { ASSISTANT_PROJECT_ID } from "../protocol";

const PROJECTS_FILE = "projects.json";

export class ProjectManager {
	private cache: Project[] | undefined;
	/** Tail of the mutation chain — see {@link serialize}. */
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly dataDir: string,
		private readonly defaults: { provider: string; model: string },
	) {}

	private file(): string {
		return join(this.dataDir, PROJECTS_FILE);
	}

	private async read(): Promise<Project[]> {
		if (this.cache) return this.cache;
		const raw = await readFile(this.file(), "utf8").catch(() => "[]");
		try {
			this.cache = JSON.parse(raw) as Project[];
		} catch {
			this.cache = [];
		}
		return this.cache;
	}

	private async write(projects: Project[]): Promise<void> {
		this.cache = projects;
		await mkdir(this.dataDir, { recursive: true });
		await writeFile(this.file(), JSON.stringify(projects, null, 2), "utf8");
	}

	/**
	 * Run a read-modify-write against the registry with no other mutation
	 * interleaved. Without this, two concurrent creates both read the same array
	 * on a cold cache and the second write drops the first project.
	 */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		this.tail = run.catch(() => undefined);
		return run;
	}

	/**
	 * The 我的助理 project — synthetic, never written to projects.json, always
	 * FIRST in the list (the sort below orders real projects by recency; the
	 * assistant's position is not something a burst of activity should move).
	 * Its config turns on the cross-session tools (`sessionControl`) and picks
	 * the `assistant` agent prompt; its workspace is `<dataDir>/workspace`, the
	 * same directory project-less spawns fall back to.
	 */
	private assistant(): Project {
		return {
			id: ASSISTANT_PROJECT_ID,
			name: "我的助理",
			path: join(this.dataDir, "workspace"),
			createdAt: 0,
			updatedAt: 0,
			config: {
				provider: this.defaults.provider,
				model: this.defaults.model,
				skillsDirs: [],
				agent: "assistant",
				sessionControl: true,
			},
		};
	}

	async list(): Promise<Project[]> {
		const real = (await this.read())
			.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			// Defensive: a projects.json hand-edited (or migrated) with a record
			// at the assistant's id would shadow the synthetic one from get().
			.filter((p) => p.id !== ASSISTANT_PROJECT_ID);
		return [this.assistant(), ...real];
	}

	async get(id: string): Promise<Project | undefined> {
		if (id === ASSISTANT_PROJECT_ID) return this.assistant();
		return (await this.read()).find((p) => p.id === id);
	}

	/**
	 * Create a project for a workspace directory.
	 *
	 * `name` is optional and defaults to the directory's basename: an agent (or a
	 * script) creating a project has a path and rarely anything better to call it.
	 * Creating for a path that already has a project RETURNS that project rather
	 * than a duplicate, so the call is idempotent — "make sure a project exists
	 * for this directory" is the operation callers actually want.
	 */
	async create(body: CreateProjectBody): Promise<Project> {
		const path = resolve(body.path);
		const dirStat = await stat(path).catch(() => undefined);
		if (!dirStat?.isDirectory()) throw new ProjectError("not_a_directory", `Workspace path is not an existing directory: ${path}`);
		const name = body.name?.trim() || basename(path) || path;

		return this.serialize(async () => {
			// The assistant's workspace IS a real directory someone may point a
			// project at; that create would build a second project over the same
			// tree. It is the assistant's tree — return the assistant instead.
			if (path === resolve(join(this.dataDir, "workspace"))) return this.assistant();
			const projects = await this.read();
			const existing = projects.find((p) => resolve(p.path) === path);
			if (existing) return existing;
			const now = Date.now();
			const config: ProjectConfig = {
				provider: body.config?.provider ?? this.defaults.provider,
				model: body.config?.model ?? this.defaults.model,
				apiKeyEnv: body.config?.apiKeyEnv,
				baseUrlEnv: body.config?.baseUrlEnv,
				skillsDirs: body.config?.skillsDirs ?? ["./.clownfish/skills"],
				systemPrompt: body.config?.systemPrompt,
				contextWindow: body.config?.contextWindow,
			};
			const project: Project = { id: generateId(), name, path, createdAt: now, updatedAt: now, config };
			projects.push(project);
			await this.write(projects);
			return project;
		});
	}

	async update(id: string, body: UpdateProjectBody): Promise<Project | undefined> {
		return this.serialize(async () => {
			const projects = await this.read();
			const idx = projects.findIndex((p) => p.id === id);
			if (idx < 0) return undefined;
			const p = projects[idx];
			const merged = { ...p.config, ...(body.config ?? {}) } as Record<string, unknown>;
			// `null` in a PATCH means "clear this key" — a spread merge alone
			// can only ever add or replace, never remove.
			for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
			const updated: Project = {
				...p,
				name: body.name ?? p.name,
				config: merged as unknown as Project["config"],
				updatedAt: Date.now(),
			};
			projects[idx] = updated;
			await this.write(projects);
			return updated;
		});
	}

	async remove(id: string): Promise<boolean> {
		// The assistant is not a stored record — "deleting" it must not report
		// success (and cannot, as remove() below only filters the stored array).
		if (id === ASSISTANT_PROJECT_ID) return false;
		return this.serialize(async () => {
			const projects = await this.read();
			const next = projects.filter((p) => p.id !== id);
			if (next.length === projects.length) return false;
			await this.write(next);
			return true;
		});
	}
}

export class ProjectError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ProjectError";
	}
}
