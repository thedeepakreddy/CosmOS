/**
 * Splitting a document into citable spans.
 *
 * A chunk is the unit evidence points at, so two properties matter more than
 * chunk size:
 *
 *   - **Offsets must be exact.** `document.text.slice(start, end)` has to equal
 *     the chunk text, or a quote can no longer be checked against its source.
 *     Every test here asserts that.
 *   - **Boundaries should fall where meaning does.** Splitting mid-sentence
 *     produces evidence that reads as a misquote even when it is faithful, so
 *     paragraph breaks are preferred, then sentence ends, then whitespace, and
 *     only a hard cut when a single token is longer than a chunk.
 *
 * Overlap exists because a finding that straddles a boundary would otherwise be
 * invisible to retrieval from either side.
 */
import { estimateTokens } from "@research-os/shared";
import { locatorFor, type DocumentSection } from "./parse.ts";

export interface ChunkOptions {
  /** Target characters per chunk. Roughly four characters to a token. */
  readonly targetChars?: number;
  readonly overlapChars?: number;
  /** Chunks shorter than this are folded into the previous one. */
  readonly minChars?: number;
}

export interface TextChunk {
  readonly position: number;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly locator: string | null;
  readonly tokenCount: number;
}

const PARAGRAPH_BREAK = /\n\n/g;
const SENTENCE_END = /[.!?]["')\]]?\s/g;

/** Last index of `pattern` within `[from, to)`, or -1. */
function lastBoundary(text: string, pattern: RegExp, from: number, to: number): number {
  const window = text.slice(from, to);
  let best = -1;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    best = from + match.index + match[0].length;
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return best;
}

/**
 * Chooses where to end a chunk that starts at `start`.
 *
 * Only the last quarter of the window is searched for a boundary: taking any
 * paragraph break in range would produce wildly uneven chunks, and a chunk far
 * below target wastes retrieval budget.
 */
function chooseEnd(text: string, start: number, targetChars: number): number {
  const hardEnd = Math.min(text.length, start + targetChars);
  if (hardEnd >= text.length) return text.length;

  const searchFrom = start + Math.floor(targetChars * 0.75);

  const paragraph = lastBoundary(text, PARAGRAPH_BREAK, searchFrom, hardEnd);
  if (paragraph > start) return paragraph;

  const sentence = lastBoundary(text, SENTENCE_END, searchFrom, hardEnd);
  if (sentence > start) return sentence;

  const space = text.lastIndexOf(" ", hardEnd);
  if (space > searchFrom) return space + 1;

  // A single token longer than a chunk. Cut it rather than emit an unbounded
  // chunk — the offsets stay exact either way.
  return hardEnd;
}

export function chunkText(
  text: string,
  sections: readonly DocumentSection[] = [],
  options: ChunkOptions = {},
): TextChunk[] {
  const targetChars = options.targetChars ?? 4000;
  const overlapChars = Math.min(options.overlapChars ?? 200, Math.floor(targetChars / 2));
  const minChars = options.minChars ?? 200;

  if (text.length === 0) return [];

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = chooseEnd(text, start, targetChars);
    // `chooseEnd` never returns <= start for a non-empty remainder, but a guard
    // here is what guarantees termination rather than assuming it.
    const safeEnd = end > start ? end : Math.min(text.length, start + targetChars);
    const slice = text.slice(start, safeEnd);

    if (slice.trim().length > 0) {
      chunks.push({
        position: chunks.length,
        text: slice,
        startOffset: start,
        endOffset: safeEnd,
        locator: locatorFor(sections, start),
        tokenCount: estimateTokens(slice),
      });
    }

    if (safeEnd >= text.length) break;
    start = Math.max(safeEnd - overlapChars, start + 1);
  }

  return foldShortTail(chunks, minChars, text, sections);
}

/**
 * Folds a too-short final chunk into its predecessor.
 *
 * A 30-character trailing chunk retrieves badly — too little context to judge
 * relevance — and it is almost always the tail of the previous paragraph.
 */
function foldShortTail(
  chunks: readonly TextChunk[],
  minChars: number,
  text: string,
  sections: readonly DocumentSection[],
): TextChunk[] {
  if (chunks.length < 2) return [...chunks];
  const last = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];
  if (!last || !previous || last.text.length >= minChars) return [...chunks];

  const merged: TextChunk = {
    position: previous.position,
    text: text.slice(previous.startOffset, last.endOffset),
    startOffset: previous.startOffset,
    endOffset: last.endOffset,
    locator: locatorFor(sections, previous.startOffset),
    tokenCount: estimateTokens(text.slice(previous.startOffset, last.endOffset)),
  };
  return [...chunks.slice(0, -2), merged];
}

/**
 * Verifies that every chunk's offsets address exactly its own text.
 *
 * Cheap, and it protects the property the whole citation chain rests on. Called
 * by the pipeline on every ingest rather than only in tests, because an offset
 * bug would otherwise surface as an unreproducible quote months later.
 */
export function offsetsAreExact(text: string, chunks: readonly TextChunk[]): boolean {
  return chunks.every((chunk) => text.slice(chunk.startOffset, chunk.endOffset) === chunk.text);
}
