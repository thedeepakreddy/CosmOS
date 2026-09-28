import { err } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function safeJsonParse(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Key-sorted serialisation. Required anywhere a JSON blob is hashed or used as
 * a cache key — `JSON.stringify` preserves insertion order, so two equal
 * objects can otherwise produce different bytes.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/**
 * Extracts a JSON object from model output that may be wrapped in prose or a
 * fenced code block.
 *
 * Structured outputs are the primary path (see the model router); this exists
 * for providers that do not support them, and it deliberately fails loudly
 * rather than returning a partial object.
 */
export function extractJsonObject(text: string): JsonObject {
  const trimmed = text.trim();
  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = safeJsonParse(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }

  throw err.validation("Model output did not contain a JSON object", {
    preview: trimmed.slice(0, 400),
  });
}
