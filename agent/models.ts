/**
 * Multi-provider model wiring.
 *
 * `builtinModels()` registers every pi-ai provider (anthropic, openai, …) with
 * its static catalog, so {@link Models.getModel} resolves offline. Per the
 * project constraints we use only pi-agent-core's basic Agent loop — model
 * resolution here is intentionally self-contained, no pi harness.
 *
 * Auth & base URL: providers read their conventional env vars at request time
 * (e.g. anthropic checks `ANTHROPIC_AUTH_TOKEN` before `ANTHROPIC_API_KEY`, and
 * `ANTHROPIC_BASE_URL`). {@link resolveRuntime} additionally honors a config's
 * `apiKeyEnv` as an explicit per-call override (the Agent forwards it as
 * `options.apiKey`) and bridges `baseUrlEnv` onto the provider's conventional
 * env var for proxy/gateway setups.
 */
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model, Models } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFileCredentialStore, createAuthContext } from "./oauth-credential-store";
import { ProxyAgent } from "undici";

/** Conventional base-URL env var per well-known provider. */
const BASE_URL_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_BASE_URL",
	openai: "OPENAI_BASE_URL",
	google: "GOOGLE_BASE_URL",
	mistral: "MISTRAL_BASE_URL",
};

function conventionalBaseUrlEnv(provider: string): string {
	return BASE_URL_ENV[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`;
}

export interface ProviderConfigLike {
	provider: string;
	model: string;
	apiKeyEnv?: string;
	baseUrlEnv?: string;
	/** Operator cap on the context window (tokens). Only ever SHRINKS the model's declared window. */
	contextWindow?: number;
}

/** Bridge a config's baseUrlEnv onto the provider's conventional env var (before provider init). */
export function bridgeProviderEnv(config: Pick<ProviderConfigLike, "provider" | "baseUrlEnv">): void {
	if (!config.baseUrlEnv) return;
	const value = process.env[config.baseUrlEnv];
	if (!value) return;
	const target = conventionalBaseUrlEnv(config.provider);
	if (!process.env[target]) process.env[target] = value;
}

let _models: Models | undefined;
let _modelsDataDir: string | undefined;

/**
 * Initialize the singleton `Models` collection with a FILE-BACKED credential
 * store rooted at `dataDir` (`agent/oauth-credential-store.ts`), so an OAuth
 * login (OpenAI Codex / ChatGPT Plus-Pro, and any other pi-ai provider that
 * ships one) survives past the worker process that performed it. Call once,
 * before the first `resolveRuntime()`/`getModels()` of the process —
 * `agent/runtime.ts` does this in its constructor, which already has
 * `dataDir`. Idempotent for the same dataDir; a second call with a DIFFERENT
 * one is a programming error (one process is one dataDir here).
 *
 * If nothing ever calls this, `getModels()` falls back to a bare in-memory
 * store (today's behavior, unchanged) — a login would work for the life of
 * that process and then be forgotten, which is a real degradation but not a
 * crash.
 */
export function initModels(dataDir: string): void {
	if (_models) {
		if (_modelsDataDir !== dataDir) {
			throw new Error(`initModels: already initialized for a different dataDir (${_modelsDataDir}), got ${dataDir}`);
		}
		return;
	}
	_modelsDataDir = dataDir;
	_models = builtinModels({ credentials: createFileCredentialStore(dataDir), authContext: createAuthContext() });
}

/** Singleton Models collection with all built-in providers registered. */
export function getModels(): Models {
	if (!_models) _models = builtinModels();
	return _models;
}

export function listProviders(): string[] {
	return getModels()
		.getProviders()
		.map((p) => p.id);
}

export interface ResolvedRuntime {
	model: Model<Api>;
	/** Bound streamFn satisfying pi-agent-core's StreamFn. */
	streamFn: StreamFn;
	/**
	 * Per-call API key resolver (undefined → the provider resolves its own
	 * auth — ambient env var, or pi-ai's own credential-store/OAuth resolution
	 * for providers like `openai-codex` that ship a login flow; see
	 * `resolveRuntime`'s doc comment). May return a Promise: pi-agent-core's
	 * own `getApiKey` contract already allows this (an OAuth token refresh is
	 * a network call), clownfish's callers just need to `await` it.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

/**
 * Hosts this proxy applies to — OpenAI's own endpoints, both the plain API
 * (`api.openai.com`) and the ChatGPT-subscription backend `openai-codex`
 * uses (`chatgpt.com`). Never the whole process.
 */
const PROXIED_HOSTS = new Set(["api.openai.com", "chatgpt.com"]);

let _proxyAgent: ProxyAgent | undefined;
let _fetchWrapped = false;
let _originalFetch: typeof fetch | undefined;

/**
 * Route ONLY requests to OpenAI's own hosts through an HTTPS proxy — never
 * the rest of the process.
 *
 * The first version of this used undici's `setGlobalDispatcher`, which is
 * process-wide: once installed, EVERY fetch call in that process — a
 * different provider's requests (a run_agent model override), the bash
 * tool's own `curl`, `WebFetch`, MCP servers — would have been silently
 * routed through the OpenAI proxy too. That is wrong regardless of how
 * narrowly installation is gated, so this wraps `globalThis.fetch` instead:
 * only requests whose URL host is in `PROXIED_HOSTS` get the proxy's
 * dispatcher attached (as a PER-CALL fetch option, not a global default);
 * every other request goes through completely untouched, including ones
 * made moments apart in the very same process. Verified directly: a
 * simultaneous request to an unrelated host returns its real response while
 * one to `api.openai.com` is the one that reaches the (test) proxy.
 *
 * `OPENAI_HTTPS_PROXY` is an explicit clownfish-specific override; bare
 * `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` is honored as the
 * same convention curl/git/most CLIs already use. The wrapper installs once
 * per process and is a no-op if no proxy is configured.
 *
 * `undici` is pinned to the EXACT version Node bundles internally
 * (`process.versions.undici`) — the per-call `dispatcher` option is handed
 * straight to Node's own global `fetch`, and a version mismatch between the
 * npm package's `ProxyAgent` and Node's internal undici throws
 * (`invalid onRequestStart method`) the moment a request actually tries to
 * use it. Keep the pin in sync if Node's bundled undici version changes.
 */
export function installHttpsProxyIfConfigured(): void {
	if (_fetchWrapped) return;
	const proxy =
		process.env.OPENAI_HTTPS_PROXY?.trim() ||
		process.env.HTTPS_PROXY?.trim() ||
		process.env.https_proxy?.trim() ||
		process.env.HTTP_PROXY?.trim() ||
		process.env.http_proxy?.trim();
	if (!proxy) return;
	_proxyAgent = new ProxyAgent(proxy);
	_originalFetch ??= globalThis.fetch;
	const originalFetch = _originalFetch;
	const agent = _proxyAgent;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		let host: string | undefined;
		try {
			const url = typeof input === "string" || input instanceof URL ? input : (input as Request).url;
			host = new URL(url).hostname;
		} catch {
			/* not a parseable URL — fall through untouched, same as today */
		}
		if (host && PROXIED_HOSTS.has(host)) {
			return originalFetch(input, { ...init, dispatcher: agent } as RequestInit);
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	_fetchWrapped = true;
}

/** Test-only: undo `installHttpsProxyIfConfigured`'s one-shot latch AND
 *  restore the real global fetch, so a fresh check can run clean. */
export function resetHttpsProxyForTests(): void {
	_fetchWrapped = false;
	_proxyAgent = undefined;
	if (_originalFetch) globalThis.fetch = _originalFetch;
	_originalFetch = undefined;
}

/**
 * Resolve a provider/model into a runnable runtime.
 *
 * If the model id isn't in pi-ai's static catalog (common with Anthropic-
 * compatible proxies/gateways that serve their own ids, e.g. "glm-5.2"), it is
 * synthesized from a sibling model in the same provider — so the API format,
 * auth, and base URL remain correct and only the id sent in the request differs.
 *
 * OAuth-backed providers (`provider: "openai-codex"` — sign in with ChatGPT
 * Plus/Pro, using the account's subscription usage instead of metered API
 * billing) need NO special case here: `getApiKey` is simply left unset, same
 * as an ambient-env provider, and `models.streamSimple`'s own `applyAuth()`
 * already resolves auth from `Models`' credential store for ANY provider —
 * api-key or oauth — falling back to it whenever no explicit `apiKey` wins.
 * The only thing that credential store needs is to be FILE-BACKED instead of
 * in-memory, so a login survives past the process that ran it — see
 * `initModels`. Log in with `npm run login:openai` (`scripts/login-openai-codex.ts`),
 * which drives the same `openai-codex` provider's login flow through the SAME
 * file-backed store this reads from.
 *
 * @throws if the provider itself is unknown (message lists known providers).
 */
export function resolveRuntime(config: ProviderConfigLike): ResolvedRuntime {
	bridgeProviderEnv(config);
	installHttpsProxyIfConfigured();
	const models = getModels();
	let model = models.getModel(config.provider, config.model);
	if (!model) {
		const siblings = models.getModels(config.provider);
		if (siblings.length === 0) {
			throw new Error(
				`Provider not found or has no models: ${config.provider}. ` +
					`Known providers: ${listProviders().join(", ")}.`,
			);
		}
		// Clone a sibling (same provider → same api/auth); override the id.
		const sibling = siblings[0];
		model = { ...sibling, id: config.model, name: config.model };
	}

	// pi-ai builds the SDK client with `baseURL: model.baseUrl`, which OVERRIDES
	// the provider's conventional BASE_URL env var. So for Anthropic-compatible
	// proxies/gateways we must override model.baseUrl ourselves — otherwise the
	// request silently hits the provider's real API (e.g. api.anthropic.com) and
	// the proxy token gets a 403. Honor an explicit baseUrlEnv, else the
	// provider's conventional base-URL env var.
	const baseUrlEnv = config.baseUrlEnv ?? conventionalBaseUrlEnv(config.provider);
	const baseUrl = process.env[baseUrlEnv];
	if (baseUrl) model = { ...model, baseUrl };
	// Operator context-window cap. min(): granting a window the model does not
	// have would just move the failure to the provider (400 on overflow) and
	// disarm auto-compaction. Shrinking also shrinks pi-ai's per-request output
	// budget (clampMaxTokensToContext), which is the intended behaviour.
	const cw = Number(config.contextWindow);
	if (Number.isFinite(cw) && cw > 0 && cw < model.contextWindow) {
		model = { ...model, contextWindow: cw };
	}

	const streamFn: StreamFn = withProviderRetry(withStreamWatchdog(models.streamSimple.bind(models)));
	const getApiKey = config.apiKeyEnv ? ((): string | undefined => process.env[config.apiKeyEnv!]) : undefined;
	return { model, streamFn, getApiKey };
}

/**
 * No-progress watchdog around the provider stream. pi's loop awaits provider
 * events with no timeout of its own — a wedged upstream (proxy half-closed,
 * network silently dropped) parks the agent in `busy` FOREVER; only a manual
 * worker kill recovers. This wrapper tails the provider stream as a tee:
 * events flow straight through to the consumer while a stall timer re-arms on
 * every event. On `stallMs` of total silence it ends the consumer stream with
 * an error result — the loop's normal error path (message_end stopReason
 * "error") then runs instead of an eternal await.
 */
export const STREAM_STALL_MS = 5 * 60_000; // 5 min: enough for slow thinking models between tokens

function withStreamWatchdog(inner: StreamFn): StreamFn {
	return async (model, context, options) => {
		// StreamFn may return a promise (per its type); await before wrapping.
		const source = await inner(model, context, options);
		return new WatchdogStream(source) as unknown as AssistantMessageEventStream;
	};
}

// ---------------------------------------------------------------- retry ----

export interface ProviderRetryConfig {
	/** Attempts beyond the first (0 = never retry). */
	maxRetries: number;
	/** First backoff delay; doubles per attempt up to maxDelayMs. */
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_PROVIDER_RETRY: ProviderRetryConfig = {
	maxRetries: 6,
	baseDelayMs: 2_000,
	maxDelayMs: 60_000,
};

/** Config from env (`CLOWNFISH_PROVIDER_MAX_RETRIES`, unset → defaults). */
export function providerRetryConfigFromEnv(): ProviderRetryConfig {
	const raw = Number(process.env.CLOWNFISH_PROVIDER_MAX_RETRIES);
	const maxRetries = Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_PROVIDER_RETRY.maxRetries;
	return { ...DEFAULT_PROVIDER_RETRY, maxRetries };
}

/** Watchdog stalls are deliberately NOT retried here: the stream already sat
 * silent for STREAM_STALL_MS (5 min) — piling retries on top means a 30+ min
 * mute hang with no feedback. A stall ends the turn; the interrupted-run
 * recovery layer (goal re-drive) picks it up with visible logs. */
const NON_RETRYABLE_LOCAL_PATTERN = /provider stream stalled/i;

/**
 * Is a failed provider result worth another attempt? Reuses pi-ai's classifier
 * (HTTP 429/5xx, rate limit, network/transport wording — quota & billing are
 * deliberately non-retryable), minus our watchdog-stall wording (see above).
 */
function isRetryableProviderFailure(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (NON_RETRYABLE_LOCAL_PATTERN.test(message.errorMessage)) return false;
	return isRetryableAssistantError(message);
}

/**
 * Provider-call retry around the (watchdog-wrapped) stream. pi's loop stops a
 * whole run on the FIRST provider error — pi-ai's own SDK-level retry defaults
 * to 0 here, so a single transient 429/502/network blip used to kill the run.
 * This wrapper retries a failed attempt TRANSPARENTLY while nothing has been
 * streamed to the consumer yet: request-phase failures (429 at accept time, the
 * common shape) push only an error event, so the consumer never sees them. Once
 * any content event has been forwarded (stream live), an error is passed through
 * untouched — rewinding a half-streamed message is not possible; recovery for
 * that case lives one level up (interrupted-run resume, see agents/goal).
 */
export function withProviderRetry(inner: StreamFn, cfg: ProviderRetryConfig = providerRetryConfigFromEnv()): StreamFn {
	if (cfg.maxRetries <= 0) return inner;
	return async (model, context, options) => {
		return new RetryingStream(() => inner(model, context, options), cfg, options?.signal) as unknown as AssistantMessageEventStream;
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/** A minimal errored AssistantMessage matching pi's error-event shape. */
function syntheticErrorAssistant(message: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "unknown" as never,
		provider: "unknown" as never,
		model: "unknown",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage: stopReason === "error" ? message : undefined,
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * Consumer-facing buffering shared by the stream wrappers below: queued events
 * + parked `next()` waiters + a finished flag. (pi-ai's stream is a class with
 * private state we re-implement event-by-event; the StreamFn boundary only
 * needs the async-iterable + result() surface the loop consumes.)
 */
class BufferedEventStream implements AsyncIterable<AssistantMessageEvent> {
	private readonly queue: AssistantMessageEvent[] = [];
	private waiting: Array<(r: IteratorResult<AssistantMessageEvent>) => void> = [];
	private finished = false;

	protected deliver(ev: AssistantMessageEvent): void {
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: ev, done: false });
		else this.queue.push(ev);
	}

	/** End the consumer iteration (every parked next() resolves done). */
	protected settle(): void {
		this.finished = true;
		while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return this;
	}

	next(): Promise<IteratorResult<AssistantMessageEvent>> {
		if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
		if (this.finished) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.waiting.push(resolve));
	}
}

/** Tee wrapper over the provider stream. pi-ai's EventStream delivers each
 *  event to exactly ONE awaiting consumer, so the wrapper races two iterators:
 *  the consumer's pull through `next()` and an internal drain loop that (a)
 *  re-arms the watchdog and (b) buffers events until the consumer asks. */
class WatchdogStream extends BufferedEventStream implements Pick<AssistantMessageEventStream, "result" | "push" | "end"> {
	private sourceDone = false;
	private consumerDone = false;
	private timer: NodeJS.Timeout | undefined;
	private readonly resultPromise: Promise<AssistantMessage>;
	private resolveResult!: (m: AssistantMessage) => void;

	constructor(private readonly source: AssistantMessageEventStream) {
		super();
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.arm(); // pre-first-event: a provider that wedges before token #1 (the
		// common hang shape) must time out too — the drain loop only re-arms per event.
		void this.drain();
	}

	/** Tail the source forever; buffer + wake consumers, re-arm the watchdog
	 *  (armed at construction so a pre-first-event hang is covered too). */
	private async drain(): Promise<void> {
		try {
			for await (const ev of this.source) {
				if (this.consumerDone) break;
				this.arm();
				if (ev.type === "done") this.resolveResult(ev.message);
				if (ev.type === "error") this.resolveResult(ev.error);
				this.deliver(ev);
			}
		} catch {
			// Source iteration threw before any error event — the watchdog or the
			// consumer's own teardown is the usual cause; result stays unsettled
			// only if the provider truly vanished mid-stream.
		}
		this.settleSourceDone();
	}

	private settleSourceDone(): void {
		this.sourceDone = true;
		this.clear();
		this.settle();
	}

	private arm(): void {
		this.clear();
		this.timer = setTimeout(() => {
			if (this.sourceDone || this.consumerDone) return;
			const failed = syntheticErrorAssistant(`provider stream stalled: no events for ${STREAM_STALL_MS / 1000}s — aborting to unhang the run`);
			this.resolveResult(failed);
			// End the consumer iteration with the error event; pi's loop turns the
			// errored result into message_end stopReason "error" (agent_end, not a
			// hang). The source iterator stays wedged but is now unreferenced.
			this.deliver({ type: "error", reason: "error", error: failed });
			this.settleSourceDone();
		}, STREAM_STALL_MS);
	}

	private clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	// ---- AssistantMessageEventStream surface (async-iterable + result) ----
	push(ev: AssistantMessageEvent): void {
		this.arm();
		this.deliver(ev);
	}
	end(result?: AssistantMessage): void {
		if (result !== undefined) this.resolveResult(result);
		this.settleSourceDone();
	}
	result(): Promise<AssistantMessage> {
		return this.resultPromise;
	}
}

/**
 * The retry driver (see {@link withProviderRetry}). Runs one attempt at a
 * time; a request-phase failure (error before ANY content event was delivered)
 * is retried with exponential backoff; anything else — a live stream that
 * errors mid-flight, a non-retryable failure, exhausted attempts — flows to
 * the consumer untouched, exactly as the inner stream produced it.
 */
class RetryingStream extends BufferedEventStream implements Pick<AssistantMessageEventStream, "result" | "push" | "end"> {
	private readonly resultPromise: Promise<AssistantMessage>;
	private resolveResult!: (m: AssistantMessage) => void;
	private settled = false;
	/** True once any event reached the consumer — from then on the attempt (and the whole call) is unrewindable. */
	private delivered = false;

	constructor(
		private readonly makeAttempt: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
		private readonly cfg: ProviderRetryConfig,
		private readonly signal?: AbortSignal,
	) {
		super();
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		void this.run();
	}

	private finish(result: AssistantMessage): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveResult(result);
		this.settle();
	}

	private async run(): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let retry = false;
			try {
				const source = await this.makeAttempt();
				for await (const ev of source) {
					if (ev.type === "done") {
						this.delivered = true;
						this.deliver(ev);
						this.finish(await source.result());
						return;
					}
					if (ev.type === "error") {
						const failed = await source.result();
						if (!this.delivered && attempt < this.cfg.maxRetries && isRetryableProviderFailure(failed)) {
							retry = true;
							break;
						}
						this.delivered = true;
						this.deliver(ev);
						this.finish(failed);
						return;
					}
					// First content event: the attempt is LIVE — forward everything
					// from here on; a later error can no longer be retried.
					this.delivered = true;
					this.deliver(ev);
				}
				// Source ended with no terminal event (done/error). The watchdog
				// usually guarantees one; treat the silence as a retryable failure.
				if (!retry && !this.settled) {
					const failed = syntheticErrorAssistant("stream ended without a terminal event (provider dropped the connection)");
					if (!this.delivered && attempt < this.cfg.maxRetries && isRetryableProviderFailure(failed)) {
						retry = true;
					} else {
						this.deliver({ type: "error", reason: "error", error: failed });
						this.finish(failed);
						return;
					}
				}
			} catch (err) {
				// makeAttempt itself threw (pre-stream). Same policy as a failed attempt.
				const failed = syntheticErrorAssistant(err instanceof Error ? err.message : String(err));
				if (!this.delivered && attempt < this.cfg.maxRetries && isRetryableProviderFailure(failed)) {
					retry = true;
				} else {
					this.deliver({ type: "error", reason: "error", error: failed });
					this.finish(failed);
					return;
				}
			}
			const delay = Math.min(this.cfg.baseDelayMs * 2 ** attempt, this.cfg.maxDelayMs) * (1 - Math.random() * 0.2);
			console.warn(`[provider-retry] attempt ${attempt + 1}/${this.cfg.maxRetries + 1} failed — retrying in ${(delay / 1000).toFixed(1)}s`);
			try {
				await abortableSleep(delay, this.signal);
			} catch {
				// Aborted mid-backoff — normalize to an aborted result, like
				// pi-ai's retryAssistantCall does for its callers.
				const aborted = syntheticErrorAssistant("aborted", "aborted");
				this.deliver({ type: "error", reason: "aborted", error: aborted });
				this.finish(aborted);
				return;
			}
		}
	}

	// ---- AssistantMessageEventStream surface (async-iterable + result) ----
	/** Not expected on this wrapper (the consumer never pushes); conformance only. */
	push(ev: AssistantMessageEvent): void {
		this.delivered = true;
		this.deliver(ev);
	}
	end(result?: AssistantMessage): void {
		if (result !== undefined) this.finish(result);
		else this.settle();
	}
	result(): Promise<AssistantMessage> {
		return this.resultPromise;
	}
}
