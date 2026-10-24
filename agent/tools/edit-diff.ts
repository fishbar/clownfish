/**
 * Diff computation + exact/fuzzy text replacement for the edit tool.
 *
 * Adapted from pi (edit-diff.ts): the matching algorithm (exact then
 * fuzzy-normalized), BOM stripping, CRLF preservation, and unified-patch /
 * display-diff generation are unchanged. Preview-only helpers were dropped.
 */
import * as Diff from "diff";
import { resolveToCwd } from "./path-utils";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Normalize text for fuzzy matching: NFKC, trim trailing ws, ASCII quotes/dashes/spaces. */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[  -   　]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (replacementStart >= lines[i].start && replacementStart < lines[i].end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) throw new Error("Replacement range is outside the base content.");

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) endLine++;
	if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) +
			replacement.newText +
			result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");
	return result;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

/** Find oldText in content, trying exact match first, then fuzzy-normalized match. */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}
	return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent };
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1)
		return new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);
	return new Error(`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1)
		return new Error(`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`);
	return new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1)
		return new Error(`No changes made to ${path}. The replacement produced identical content.`);
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Apply one or more exact-text replacements to LF-normalized content. */
export function applyEditsToNormalizedContent(normalizedContent: string, edits: Edit[], path: string): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) throw getEmptyOldTextError(path, i, normalizedEdits.length);
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) throw getNotFoundError(path, i, normalizedEdits.length);
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		matchedEdits.push({ editIndex: i, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) throw getNoChangeError(path, normalizedEdits.length);
	return { baseContent, newContent };
}

export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/** Display-oriented diff with line numbers; returns first changed line in the new file. */
export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leading = raw.slice(0, contextLines);
					const trailing = raw.slice(raw.length - contextLines);
					const skipped = raw.length - leading.length - trailing.length;
					for (const line of leading) {
						output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipped;
					newLineNum += skipped;
					for (const line of trailing) {
						output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shown = raw.slice(0, contextLines);
				const skipped = raw.length - shown.length;
				for (const line of shown) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				if (skipped > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipped;
					newLineNum += skipped;
				}
			} else if (hasTrailingChange) {
				const skipped = Math.max(0, raw.length - contextLines);
				if (skipped > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipped;
					newLineNum += skipped;
				}
				for (const line of raw.slice(skipped)) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}
			lastWasChange = false;
		}
	}
	return { diff: output.join("\n"), firstChangedLine };
}
