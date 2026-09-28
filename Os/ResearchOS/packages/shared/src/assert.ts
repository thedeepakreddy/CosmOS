import { err } from "./errors.ts";

/** Invariant check. Failing one is a programming error, not a user error. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw err.internal(`Invariant violated: ${message}`);
}

/** Guards a value that must exist by this point in the flow. */
export function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw err.internal(`Expected ${name} to be present`);
  }
  return value;
}

/** Exhaustiveness check for discriminated unions — a new variant becomes a compile error. */
export function assertNever(value: never, context = "value"): never {
  throw err.internal(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamps to [0,1] and rejects NaN/Infinity — used wherever a score crosses a boundary. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
}

/** Rounds to a fixed precision so scores are stable across serialisation round-trips. */
export function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
