/**
 * Side-channel session-title generation.
 *
 * On a session's first user prompt we ask the model — out of band — for a short,
 * readable title. This is a SEPARATE completion run through the same resolved
 * runtime the agent uses (so provider, base URL, and credentials match), but it
 * never touches the agent: its result does not enter {@link ClownfishAgent.state}
 * and therefore never appears in the conversation transcript. The worker ships the
 * finished title to the manager as a `set_title` frame; the manager persists it.
 *
 * Every failure is swallowed — generating a title is purely a readability nicety
 * and must never disrupt the real conversation.
 */
import { normalizeContext } from "@earendil-works/pi-ai";
import type { ResolvedRuntime } from "./models";

const MAX_TITLE_LEN = 80;

const TITLE_SYSTEM_PROMPT = [
	"You write a concise, human-readable title for a chat session from the user's first message.",
	"Rules:",
	"- 2 to 8 words, plain text.",
	"- Name the task or topic, not any greeting.",
	"- No quotes, no markdown, no trailing punctuation.",
	"- Output only the title and nothing else.",
].join("\n");

/** Clean a model's free-form reply into a usable title, or undefined if empty. */
function sanitizeTitle(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	let t = raw.trim();
	t = t.replace(/^["'`]+|["'`]+$/g, ""); // strip wrapping quotes / backticks
	t = t.replace(/^[•\-*•]\s*/, ""); // strip a leading bullet / dash
	t = t.replace(/\s+/g, " ").trim();
	t = t.replace(/[.!?;:]+$/, ""); // no trailing punctuation
	if (!t) return undefined;
	return t.length > MAX_TITLE_LEN ? `${t.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…` : t;
}

/**
 * Ask the model for a short title for the session, given its first user prompt.
 * Returns undefined on any error, abort, or empty reply. Never throws.
 */
export async function generateSessionTitle(runtime: ResolvedRuntime, firstPrompt: string): Promise<string | undefined> {
	const apiKey = await runtime.getApiKey?.(runtime.model.provider);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		// streamFn may return a stream or a promise of one — normalize both.
		const stream = await Promise.resolve(
			runtime.streamFn(
				runtime.model,
				normalizeContext({
					systemPrompt: TITLE_SYSTEM_PROMPT,
					messages: [{ role: "user", content: firstPrompt.slice(0, 4000), timestamp: Date.now() }],
				}),
				{ apiKey, maxTokens: 32, timeoutMs: 20_000, signal: controller.signal },
			),
		);
		const final = await stream.result();
		if (final.stopReason === "error" || final.stopReason === "aborted") return undefined;
		const text = final.content.find((c) => c.type === "text") as { text?: string } | undefined;
		return sanitizeTitle(text?.text);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
