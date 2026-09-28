import { AgentExecutionResult } from './Executor';

/**
 * Phase C: validate what an executor returned.
 *
 * The audit found `{}`, `42` and `{status:'WAT'}` all producing a FAILED task
 * with a NULL error -- an undiagnosable failure. A buggy executor should produce
 * a clear contract violation, not silence.
 */
export type ExecutorResultCheck =
  | { ok: true; result: AgentExecutionResult }
  | { ok: false; error: string };

export function validateExecutorResult(value: unknown): ExecutorResultCheck {
  if (value === null || value === undefined) {
    return { ok: false, error: `EXECUTOR_CONTRACT_VIOLATION: executor returned ${String(value)}` };
  }
  if (typeof value !== 'object') {
    return {
      ok: false,
      error: `EXECUTOR_CONTRACT_VIOLATION: executor returned a ${typeof value}, expected an object`
    };
  }

  const status = (value as { status?: unknown }).status;
  if (status !== 'SUCCEEDED' && status !== 'FAILED') {
    return {
      ok: false,
      error: `EXECUTOR_CONTRACT_VIOLATION: status must be 'SUCCEEDED' or 'FAILED', got ${JSON.stringify(status)}`
    };
  }

  const error = (value as { error?: unknown }).error;
  if (error !== undefined && typeof error !== 'string') {
    return {
      ok: false,
      error: `EXECUTOR_CONTRACT_VIOLATION: error must be a string when present, got ${typeof error}`
    };
  }

  return { ok: true, result: value as AgentExecutionResult };
}
