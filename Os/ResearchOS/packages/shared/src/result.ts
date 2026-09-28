/**
 * Explicit success/failure values for operations whose failure is an expected
 * outcome rather than an exception — agent steps, tool calls, verification
 * checks. Using a Result here forces call sites to handle the failure branch,
 * which is the mechanism behind the "never silently ignore errors" rule.
 *
 * Genuinely exceptional conditions still throw.
 */
import { type ResearchError, toResearchError } from "./errors.ts";

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E = ResearchError> = { readonly ok: false; readonly error: E };
export type Result<T, E = ResearchError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const fail = <E = ResearchError>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwraps or throws. Only for call sites that have already checked, or where a failure is a bug. */
export function unwrap<T>(result: Result<T, ResearchError>): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Runs a throwing async function and converts any throw into an Err. */
export async function attempt<T>(fn: () => Promise<T> | T, fallbackMessage?: string): Promise<Result<T, ResearchError>> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(toResearchError(error, fallbackMessage));
  }
}

/** Collects results, failing on the first error. */
export function allOk<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Partitions results instead of short-circuiting — for batch work where partial success is useful. */
export function partition<T, E>(results: readonly Result<T, E>[]): { values: T[]; errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}
