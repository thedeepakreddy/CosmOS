/**
 * Does the quote actually appear in the source it cites?
 *
 * This is the single most important check in the system. Everything downstream —
 * confidence, contradiction detection, the report — assumes that when evidence
 * says a source said something, the source said it. A model that paraphrases
 * while claiming to quote breaks that assumption silently, and nothing else in
 * the pipeline would notice.
 *
 * Matching is normalisation-tolerant but not meaning-tolerant. Whitespace,
 * quotation-mark style and ellipses vary harmlessly between a document and a
 * quotation of it; *words* do not. So the comparison normalises typography and
 * then requires the words to be there.
 */
import { jaccardSimilarity, normalizeWhitespace, tokenizeWords } from "@research-os/shared";

/** How much of the quote's wording must be present for a near-match to pass. */
export const NEAR_MATCH_THRESHOLD = 0.92;
/** Below this, the quote is treated as unrelated to the passage rather than as a paraphrase. */
export const UNRELATED_THRESHOLD = 0.4;

const SMART_QUOTES = /[‘’‚‛′]/g;
const SMART_DOUBLES = /[“”„‟″]/g;
const DASHES = /[‐-―]/g;
const ELLIPSIS_FORMS = /(…|\.\s*\.\s*\.)/g;

/** Typography only. Words are never altered. */
export function normaliseForComparison(text: string): string {
  return normalizeWhitespace(
    text
      .replace(SMART_QUOTES, "'")
      .replace(SMART_DOUBLES, '"')
      .replace(DASHES, "-")
      .replace(ELLIPSIS_FORMS, " ... "),
  ).toLowerCase();
}

export type CitationVerdict = "exact" | "elided" | "near" | "paraphrased" | "absent";

export interface CitationFidelityResult {
  readonly verdict: CitationVerdict;
  /** Word-level overlap with the best matching region, in [0,1]. */
  readonly similarity: number;
  readonly detail: string;
}

/**
 * Checks a quote against the passage it claims to come from.
 *
 * An elided quote — one containing "..." — is checked segment by segment, in
 * order. That is a real and legitimate way to quote, and rejecting it would
 * push agents toward quoting whole paragraphs to stay safe.
 */
export function checkCitationFidelity(quote: string, sourceText: string): CitationFidelityResult {
  const normalisedQuote = normaliseForComparison(quote);
  const normalisedSource = normaliseForComparison(sourceText);

  if (normalisedQuote.length === 0) {
    return { verdict: "absent", similarity: 0, detail: "The quote is empty." };
  }

  if (normalisedSource.includes(normalisedQuote)) {
    return { verdict: "exact", similarity: 1, detail: "The quoted text appears verbatim in the source." };
  }

  const segments = normalisedQuote.split(/\s*\.\.\.\s*/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length > 1) {
    let cursor = 0;
    let allFound = true;
    for (const segment of segments) {
      const index = normalisedSource.indexOf(segment, cursor);
      if (index === -1) { allFound = false; break; }
      cursor = index + segment.length;
    }
    if (allFound) {
      return {
        verdict: "elided",
        similarity: 1,
        detail: `All ${segments.length} quoted fragments appear in the source, in the order given.`,
      };
    }
  }

  const quoteTerms = tokenizeWords(normalisedQuote);
  const similarity = bestWindowSimilarity(quoteTerms, tokenizeWords(normalisedSource));

  if (similarity >= NEAR_MATCH_THRESHOLD) {
    return {
      verdict: "near",
      similarity,
      detail: `The quote does not appear verbatim, but ${(similarity * 100).toFixed(0)}% of its wording is present in one passage. Likely a transcription difference.`,
    };
  }
  if (similarity >= UNRELATED_THRESHOLD) {
    return {
      verdict: "paraphrased",
      similarity,
      detail: `The quote does not appear in the source; the closest passage shares ${(similarity * 100).toFixed(0)}% of its wording. This is a paraphrase presented as a quotation.`,
    };
  }
  return {
    verdict: "absent",
    similarity,
    detail: `The quoted text does not appear in the cited source, and no passage resembles it (best overlap ${(similarity * 100).toFixed(0)}%).`,
  };
}

/**
 * Best overlap between the quote and any same-length window of the source.
 *
 * Whole-document Jaccard would score a short quote against a long document as
 * near zero no matter how faithful it was, so the comparison slides a window of
 * the quote's own length across the source.
 */
function bestWindowSimilarity(quoteTerms: readonly string[], sourceTerms: readonly string[]): number {
  if (quoteTerms.length === 0 || sourceTerms.length === 0) return 0;
  if (sourceTerms.length <= quoteTerms.length) return jaccardSimilarity(quoteTerms, sourceTerms);

  const windowSize = quoteTerms.length;
  const step = Math.max(1, Math.floor(windowSize / 4));
  let best = 0;

  for (let start = 0; start + 1 <= sourceTerms.length; start += step) {
    const window = sourceTerms.slice(start, start + windowSize);
    const score = jaccardSimilarity(quoteTerms, window);
    if (score > best) best = score;
    if (best === 1) break;
  }
  return Math.round(best * 10_000) / 10_000;
}
