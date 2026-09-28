/**
 * Retry with exponential backoff and full jitter.
 *
 * Full jitter (rather than a fixed multiplier) matters here because research
 * runs fan out many concurrent model and tool calls; without jitter a single
 * provider rate-limit produces a synchronised retry stampede.
 */
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { type ResearchError, toResearchError } from "./errors.ts";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  /** 0 = no jitter (deterministic), 1 = full jitter. */
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: 1,
};

export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  multiplier: 1,
  jitter: 0,
};

export interface RetryContext {
  readonly attempt: number;
  readonly error: ResearchError;
  readonly delayMs: number;
}

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  /** Defaults to the error's own `retryable` flag. */
  readonly isRetryable?: (error: ResearchError) => boolean;
  readonly onRetry?: (context: RetryContext) => void;
  /** Injectable for deterministic tests; defaults to Math.random. */
  readonly random?: () => number;
}

export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exponential = Math.min(policy.initialDelayMs * policy.multiplier ** (attempt - 1), policy.maxDelayMs);
  if (policy.jitter <= 0) return Math.round(exponential);
  const jittered = exponential * (1 - policy.jitter) + exponential * policy.jitter * random();
  return Math.round(jittered);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? ((error: ResearchError) => error.retryable);

  let lastError: ResearchError | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (thrown) {
      const error = toResearchError(thrown);
      lastError = error;
      if (attempt >= policy.maxAttempts || !isRetryable(error)) throw error;
      const delayMs = backoffDelay(attempt, policy, random);
      options.onRetry?.({ attempt, error, delayMs });
      await clock.sleep(delayMs, options.signal);
    }
  }
  /* c8 ignore next */
  throw lastError ?? toResearchError(new Error("Retry loop exited without a result"));
}
