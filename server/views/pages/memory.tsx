/**
 * Memory browser — what the agent has remembered across sessions.
 *
 * Memory is written autonomously (the `memory` tool during a turn, and the
 * end-of-session reflection), with no confirmation step. This view is the other
 * half of that bargain: everything written is visible here, grouped the way it
 * is filed, and any entry can be dropped. The list is the audit surface, so it
 * shows what the model sees — the same `[id]` and timestamp that ride in the
 * prompt — rather than a prettified summary of it.
 *
 * One component, two mounts: the standalone `#/memory` page and the settings
 * page's Memory tab. Two copies of a browser would drift.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { MemoryBlockWire, MemoryEntryWire, Project } from "../../protocol";

const CATEGORIES: Array<MemoryBlockWire["category"]> = ["rules", "style", "facts", "preferences", "lessons"];

const CATEGORY_LABEL: Record<MemoryBlockWire["category"], string> = {
	rules: "规则",
	style: "风格",
	facts: "事实",
	preferences: "偏好",
	lessons: "教训",
};

function scopeLabel(scope: MemoryBlockWire["scope"], projectNames: Map<string, string>): string {
	return scope.kind === "global" ? "全局" : `项目 · ${projectNames.get(scope.projectId) ?? scope.projectId}`;
}

/** The browser itself — used by both the page and the settings tab. */
export function MemoryBrowser(): preact.JSX.Element {
	const [blocks, setBlocks] = useState<MemoryBlockWire[] | null>(null);
	const [projectNames, setProjectNames] = useState<Map<string, string>>(new Map());
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<string>();

	const load = useCallback(async (): Promise<void> => {
		try {
			const [mem, projects] = await Promise.all([api.listMemory(), api.listProjects()]);
			setBlocks(mem.blocks);
			setProjectNames(new Map((projects as Project[]).map((p) => [p.id, p.name])));
			setError(undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBlocks([]);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const forget = async (id: string): Promise<void> => {
		setBusy(id);
		try {
			await api.forgetMemory(id);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(undefined);
		}
	};

	if (blocks === null) return <div class="muted small">加载中…</div>;

	const total = blocks.reduce((n, b) => n + b.entries.length, 0);
	// Global first, then projects; within a scope, the fixed category order so the
	// layout does not reshuffle as entries come and go.
	const ordered = [...blocks].sort((a, b) => {
		if (a.scope.kind !== b.scope.kind) return a.scope.kind === "global" ? -1 : 1;
		return CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
	});

	return (
		<div class="mem-browser">
			{error && <div class="settings-error">{error}</div>}
			{total === 0 ? (
				<div class="muted small">
					还没有任何记忆。智能体会在对话中主动记下值得长期保留的东西，或在会话结束时自省写入；这里随时可以删。
				</div>
			) : (
				<>
					<div class="muted small mem-summary">
						共 {total} 条 · 写入即生效，无需确认 · 完整出处见 <code>memory/runs.jsonl</code>
					</div>
					{ordered.map((block) => (
						<div class="mem-group" key={`${block.scope.kind}:${block.scope.kind === "project" ? block.scope.projectId : ""}:${block.category}`}>
							<div class="mem-group-head">
								<span class="mem-cat">{CATEGORY_LABEL[block.category]}</span>
								<span class="muted small">{scopeLabel(block.scope, projectNames)}</span>
								<span class="mem-count">{block.entries.length}</span>
							</div>
							<ul class="mem-list">
								{block.entries.map((e: MemoryEntryWire, i) => (
									<li class="mem-row" key={e.id || `${block.category}-${i}`}>
										<code class="mem-id" title="条目 id — 模型在提示词里看到的就是它">
											{e.id || "—"}
										</code>
										<span class="mem-content">{e.content}</span>
										<span class="mem-at muted">{e.at}</span>
										{e.id && (
											<button
												type="button"
												class="small ghost"
												disabled={busy === e.id}
												onClick={() => void forget(e.id)}
												title="删除这条记忆"
											>
												{busy === e.id ? "…" : "忘掉"}
											</button>
										)}
									</li>
								))}
							</ul>
						</div>
					))}
				</>
			)}
		</div>
	);
}

/** The standalone `#/memory` route. */
export function MemoryPage(): preact.JSX.Element {
	return (
		<div class="memory-page">
			<div class="memory-inner">
				<h1 class="memory-title">记忆</h1>
				<MemoryBrowser />
			</div>
		</div>
	);
}
