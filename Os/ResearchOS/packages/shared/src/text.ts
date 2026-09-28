import { createHash } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Content hash used for source deduplication — whitespace-insensitive by design. */
export function contentHash(text: string): string {
  return sha256(text.replace(/\s+/g, " ").trim().toLowerCase());
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Rough token estimate (~4 chars/token) for budgeting *before* a call is made.
 * Actual accounting always uses provider-reported usage; this is only for
 * pre-flight checks and chunk sizing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, maxChars: number, suffix = "…"): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

export function slugify(text: string, maxLength = 80): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength) || "untitled";
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have if in into is it its of on or that the their then there these they this to was were what when where which who will with".split(" "),
);

/** Content words used by the lexical half of hybrid retrieval and by overlap heuristics. */
export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Registrable domain, used as the default proxy for source independence. */
export function domainOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}
