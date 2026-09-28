/**
 * Error taxonomy.
 *
 * Every failure in ResearchOS is one of these. The `retryable` flag is what the
 * orchestrator reads to decide between a retry and a permanent failure, and
 * `code` is what crosses the API boundary — so callers branch on a stable
 * string rather than on message text.
 */

export const ERROR_CODES = [
  "validation_failed",
  "not_found",
  "conflict",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "budget_exhausted",
  "provider_error",
  "provider_unavailable",
  "tool_error",
  "tool_not_permitted",
  "executor_unavailable",
  "executor_timeout",
  "timeout",
  "cancelled",
  "unsupported",
  "not_implemented",
  "persistence_error",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ResearchErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  budget_exhausted: 402,
  provider_error: 502,
  provider_unavailable: 503,
  tool_error: 500,
  tool_not_permitted: 403,
  executor_unavailable: 503,
  executor_timeout: 504,
  timeout: 504,
  cancelled: 499,
  unsupported: 400,
  not_implemented: 501,
  persistence_error: 500,
  internal_error: 500,
};

const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  "provider_unavailable",
  "executor_unavailable",
  "executor_timeout",
  "timeout",
  "persistence_error",
]);

export class ResearchError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: ResearchErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ResearchError";
    this.code = options.code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(options.code);
    this.status = options.status ?? DEFAULT_STATUS[options.code];
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      details: this.details,
    };
  }
}

export const err = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "validation_failed", message, ...(details ? { details } : {}) }),
  notFound: (entity: string, id: string) =>
    new ResearchError({ code: "not_found", message: `${entity} not found: ${id}`, details: { entity, id } }),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "conflict", message, ...(details ? { details } : {}) }),
  unauthorized: (message = "Authentication required") =>
    new ResearchError({ code: "unauthorized", message }),
  forbidden: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "forbidden", message, ...(details ? { details } : {}) }),
  budgetExhausted: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "budget_exhausted", message, ...(details ? { details } : {}) }),
  provider: (message: string, options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown }) =>
    new ResearchError({ code: "provider_error", message, ...options }),
  tool: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "tool_error", message, ...(details ? { details } : {}) }),
  toolNotPermitted: (toolId: string, reason: string) =>
    new ResearchError({ code: "tool_not_permitted", message: `Tool "${toolId}" is not permitted: ${reason}`, details: { toolId, reason } }),
  /**
   * Retryable by default: an executor that is absent now may well have
   * reconnected by the time the task is retried, and giving up permanently
   * because nothing was listening for a moment loses work unnecessarily.
   */
  executorUnavailable: (capability: string, details?: Record<string, unknown>) =>
    new ResearchError({
      code: "executor_unavailable",
      message: `No healthy executor advertises the "${capability}" capability.`,
      details: { capability, ...details },
    }),
  executorTimeout: (capability: string, timeoutMs: number) =>
    new ResearchError({
      code: "executor_timeout",
      message: `No executor answered the "${capability}" request within ${timeoutMs}ms.`,
      details: { capability, timeoutMs },
    }),
  timeout: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "timeout", message, ...(details ? { details } : {}) }),
  cancelled: (message = "Operation cancelled") =>
    new ResearchError({ code: "cancelled", message, retryable: false }),
  unsupported: (message: string, details?: Record<string, unknown>) =>
    new ResearchError({ code: "unsupported", message, ...(details ? { details } : {}) }),
  notImplemented: (what: string) =>
    new ResearchError({ code: "not_implemented", message: `Not implemented: ${what}`, details: { what } }),
  persistence: (message: string, cause?: unknown) =>
    new ResearchError({ code: "persistence_error", message, cause }),
  internal: (message: string, cause?: unknown) =>
    new ResearchError({ code: "internal_error", message, cause, retryable: false }),
};

export function isResearchError(value: unknown): value is ResearchError {
  return value instanceof ResearchError;
}

/**
 * Normalises anything thrown into a ResearchError. Used at every process
 * boundary so an unexpected throw is never swallowed or reported untyped.
 */
export function toResearchError(value: unknown, fallbackMessage = "Unexpected error"): ResearchError {
  if (isResearchError(value)) return value;
  if (value instanceof Error) {
    return new ResearchError({ code: "internal_error", message: value.message || fallbackMessage, cause: value });
  }
  return new ResearchError({
    code: "internal_error",
    message: fallbackMessage,
    details: { thrown: typeof value === "string" ? value : JSON.stringify(value) },
  });
}
