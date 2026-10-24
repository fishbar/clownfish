/**
 * Short id generation (replaces uuid v4).
 *
 * Alphanumeric only — A–Z, a–z, 0–9, no symbols — so ids are compact, URL-safe,
 * and easy to read and copy. 12 chars from a 62-symbol alphabet ≈ 71 bits of
 * entropy: ample collision resistance for projects, sessions, and transcript
 * lines at this scale. Existing uuid ids keep working — ids are opaque strings,
 * never parsed.
 */
import { customAlphabet } from "nanoid";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const generate = customAlphabet(ALPHABET, 12);

/** Generate a short, symbol-free alphanumeric id. */
export function generateId(): string {
	return generate();
}
