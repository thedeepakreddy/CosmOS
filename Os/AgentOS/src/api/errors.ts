/**
 * Phase E: error taxonomy and sanitization.
 *
 * The audit found a client input error (a dependency on a nonexistent task)
 * returning HTTP 500 with `{"code":"SQLITE_CONSTRAINT_FOREIGNKEY","message":
 * "FOREIGN KEY constraint failed"}` -- disclosing the persistence engine to any
 * caller. It also found RUN_NOT_FOUND returned as 400, and every Supervisor
 * error flattened to 400 regardless of meaning.
 *
 * Domain code keeps throwing plain Errors with stable, machine-readable codes
 * (RUN_NOT_FOUND, DUPLICATE_TASK_ID: X, ...). This module is the single place
 * that decides what a caller is allowed to see.
 */

export type ErrorCategory =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export interface ErrorBody {
  error: {
    /** Stable, machine-readable. Safe to switch on. */
    code: string;
    /** Human-readable and sanitized. Never contains internals. */
    message: string;
    category: ErrorCategory;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly category: ErrorCategory
  ) {
    super(message);
    this.name = 'ApiError';
  }
  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, category: this.category } };
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message, 'VALIDATION');
export const unauthorized = (message = 'Missing or invalid credentials') =>
  new ApiError(401, 'UNAUTHORIZED', message, 'UNAUTHORIZED');
export const notFound = (code: string, message: string) => new ApiError(404, code, message, 'NOT_FOUND');
export const conflict = (code: string, message: string) => new ApiError(409, code, message, 'CONFLICT');
export const payloadTooLarge = (code: string, message: string) =>
  new ApiError(413, code, message, 'PAYLOAD_TOO_LARGE');
export const rateLimited = (message: string) => new ApiError(429, 'RATE_LIMITED', message, 'RATE_LIMITED');

/**
 * Patterns that must NEVER reach a client. Used both to decide that an error is
 * un-sanitizable (and so becomes a generic 500) and, in tests, to assert that no
 * response body contains them.
 */
export const LEAK_PATTERNS: RegExp[] = [
  /SQLITE/i,
  /FOREIGN KEY/i,
  /constraint failed/i,
  /\bat [A-Za-z0-9_.]+ \(/,      // stack frames
  /\/Users\//,                    // absolute paths
  /node_modules/,
  /\.ts:\d+/,
  /\.js:\d+/
];

export function looksLikeInternalLeak(message: string): boolean {
  return LEAK_PATTERNS.some((p) => p.test(message));
}

/**
 * Map a domain error onto the wire.
 *
 * Anything not explicitly recognised becomes a generic 500 with NO detail --
 * an allowlist, so a new internal failure mode cannot start leaking by default.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  const message = err instanceof Error ? err.message : String(err);

  // ---- not found ----------------------------------------------------------
  if (message === 'RUN_NOT_FOUND') return notFound('RUN_NOT_FOUND', 'Run not found');
  if (message === 'AGENT_NOT_FOUND') return notFound('AGENT_NOT_FOUND', 'Agent not found');
  if (message === 'TASK_NOT_FOUND') return notFound('TASK_NOT_FOUND', 'Task not found');

  // ---- graph validation ---------------------------------------------------
  for (const code of ['DUPLICATE_TASK_ID', 'UNKNOWN_TASK_ID', 'UNKNOWN_DEPENDS_ON']) {
    if (message.startsWith(`${code}:`)) {
      return badRequest(code, message); // the id is caller-supplied, so echoing it is safe
    }
  }
  if (message === 'CYCLE_DETECTED') {
    return badRequest('CYCLE_DETECTED', 'The task graph contains a cycle');
  }
  if (message === 'GRAPH_TOO_LARGE' || message.startsWith('GRAPH_TOO_LARGE:')) {
    return payloadTooLarge('GRAPH_TOO_LARGE', message);
  }

  // ---- budgets ------------------------------------------------------------
  if (message.startsWith('BUDGET_EXCEEDED')) {
    return new ApiError(409, 'BUDGET_EXCEEDED', message, 'CONFLICT');
  }
  if (message.startsWith('BUDGET_INVALID')) {
    return badRequest('BUDGET_INVALID', message);
  }

  // ---- lifecycle ----------------------------------------------------------
  if (message.startsWith('INVALID_STATE_TRANSITION')) {
    return conflict('INVALID_STATE_TRANSITION', message);
  }
  if (message.startsWith('INVALID_RUN_TRANSITION') || message.startsWith('INVALID_TASK_TRANSITION')) {
    return conflict('INVALID_STATE_TRANSITION', message);
  }

  // ---- anything else ------------------------------------------------------
  // Deliberately opaque. The real error is logged server-side with the request id.
  return new ApiError(500, 'INTERNAL_ERROR', 'An internal error occurred', 'INTERNAL');
}
