/**
 * Typed environment access.
 *
 * Reads go through these helpers so that a missing or malformed variable fails
 * at startup with the variable's name, rather than surfacing as `undefined`
 * somewhere deep in a research run.
 */
import { err } from "./errors.ts";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function readString(env: EnvSource, key: string, fallback?: string): string {
  const raw = env[key]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw err.validation(`Missing required environment variable ${key}`, { key });
}

export function readOptionalString(env: EnvSource, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

export function readNumber(env: EnvSource, key: string, fallback?: number): number {
  const raw = env[key]?.trim();
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw err.validation(`Missing required environment variable ${key}`, { key });
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw err.validation(`Environment variable ${key} must be a number, received "${raw}"`, { key, raw });
  }
  return parsed;
}

export function readBoolean(env: EnvSource, key: string, fallback = false): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw err.validation(`Environment variable ${key} must be a boolean, received "${raw}"`, { key, raw });
}

export function readEnum<const T extends readonly string[]>(
  env: EnvSource,
  key: string,
  allowed: T,
  fallback?: T[number],
): T[number] {
  const raw = env[key]?.trim();
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw err.validation(`Missing required environment variable ${key}`, { key });
  }
  if (!allowed.includes(raw)) {
    throw err.validation(`Environment variable ${key} must be one of ${allowed.join(", ")}, received "${raw}"`, {
      key,
      raw,
      allowed,
    });
  }
  return raw as T[number];
}

export function readList(env: EnvSource, key: string, fallback: readonly string[] = []): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [...fallback];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Loads a `.env` file into a plain object without mutating `process.env`.
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes.
 * Anything more elaborate belongs in a real secret manager, not a dotfile.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Masks a secret for logs: keeps a short prefix so keys remain distinguishable. */
export function maskSecret(value: string | undefined): string {
  if (!value) return "<unset>";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}
