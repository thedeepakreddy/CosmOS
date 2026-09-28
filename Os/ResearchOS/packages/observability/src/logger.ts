/**
 * Structured logging.
 *
 * Every line is JSON with a trace id, so an entire research run can be
 * reconstructed from logs by filtering on one field. Human-readable output is
 * available for development but is never the default in a deployed process —
 * pretty-printing loses fields.
 */
import type { JsonValue } from "@research-os/shared";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, JsonValue | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps the given fields onto every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly format?: "json" | "pretty";
  readonly base?: LogFields;
  readonly write?: (line: string) => void;
  readonly now?: () => string;
}

/**
 * Turns a thrown value into something loggable.
 *
 * Exported because `LogFields` is deliberately restricted to JSON values — that
 * restriction is what stops an entire database row being logged by accident —
 * and a caught `unknown` therefore has to be converted at the call site rather
 * than smuggled through. `logger.error("...", { error: toLogError(caught) })`.
 *
 * Already-converted objects pass through unchanged, so the logger's own
 * handling of an `error` field cannot double-serialise one into a string.
 */
export function toLogError(value: unknown): JsonValue {
  if (value instanceof Error) {
    const result: Record<string, JsonValue> = { name: value.name, message: value.message };
    if (value.stack) result["stack"] = value.stack;
    if ("code" in value && typeof value.code === "string") result["code"] = value.code;
    return result;
  }
  if (value !== null && typeof value === "object") return value as JsonValue;
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

const serialiseError = toLogError;

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "json";
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date().toISOString());
  const base = options.base ?? {};

  const emit = (logLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;

    const merged: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) continue;
      merged[key] = key === "error" || key === "err" ? serialiseError(value) : value;
    }

    if (format === "pretty") {
      const extras = Object.keys(merged).length ? ` ${JSON.stringify(merged)}` : "";
      write(`${now()} ${logLevel.toUpperCase().padEnd(5)} ${message}${extras}`);
      return;
    }
    write(JSON.stringify({ time: now(), level: logLevel, message, ...merged }));
  };

  const logger: Logger = {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
  return logger;
}

/** Discards everything. The default in tests, so output stays readable. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** Captures lines for assertion. */
export function createMemoryLogger(level: LogLevel = "debug"): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    format: "json",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}
