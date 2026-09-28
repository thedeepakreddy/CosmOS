# CandidateAdapter Contract

## Overview

The `CandidateAdapter` is the boundary interface between EvalOS and the system under evaluation. It abstracts away the details of how a candidate system is invoked, allowing EvalOS to evaluate any system that implements this contract.

**EvalOS never calls a candidate system directly.** All candidate interaction goes through a `CandidateAdapter`.

---

## Interface

```typescript
interface CandidateAdapter {
  /** Unique identifier for this candidate adapter */
  readonly id: string;

  /**
   * Check if the candidate system is reachable and ready.
   * Called during run preparation (CREATED → READY transition).
   * Must resolve within a reasonable timeout (e.g., 5 seconds).
   *
   * @returns HealthCheckResult indicating system readiness
   */
  health(): Promise<HealthCheckResult>;

  /**
   * Execute the candidate system with the given input.
   * This is the core method — it sends input to the candidate and returns the result.
   *
   * @param input - The evaluation case input to send to the candidate
   * @param context - Execution context (run ID, case ID, timeout, metadata)
   * @returns CandidateResult containing the output, timing, and status
   */
  execute(input: CandidateInput, context: ExecutionContext): Promise<CandidateResult>;
}
```

---

## Supporting Types

### HealthCheckResult

```typescript
interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}
```

### CandidateInput

```typescript
interface CandidateInput {
  /** The primary input data for the candidate */
  data: unknown;

  /** Optional metadata from the evaluation case */
  metadata?: Record<string, unknown>;
}
```

### ExecutionContext

```typescript
interface ExecutionContext {
  /** ID of the current evaluation run */
  runId: string;

  /** ID of the current evaluation case */
  caseId: string;

  /** Timeout in milliseconds for this execution */
  timeoutMs: number;

  /** Optional additional context */
  metadata?: Record<string, unknown>;
}
```

### CandidateResult

```typescript
interface CandidateResult {
  /** The output produced by the candidate system */
  output: unknown;

  /** Execution status */
  status: 'success' | 'error' | 'timeout';

  /** Time taken to execute in milliseconds */
  latencyMs: number;

  /** Error details if status is 'error' */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };

  /** Optional metadata returned by the candidate */
  metadata?: Record<string, unknown>;
}
```

---

## Contract Rules

1. **`id` must be unique** across all adapters registered in a run.
2. **`health()` must not throw.** It returns `{ healthy: false }` on failure, never rejects.
3. **`execute()` must always resolve** with a `CandidateResult`. Errors in the candidate system are captured in `result.status = 'error'` and `result.error`, not thrown as exceptions.
4. **`execute()` must not handle its own timeout.** EvalOS wraps execution in `Promise.race` with a per-case timeout. The adapter should not implement competing timeout logic.
5. **`execute()` must measure its own latency** and include it in `result.latencyMs`. This is the adapter's measurement of candidate response time, independent of EvalOS's timeout wrapper.
6. **Adapters must be stateless** between executions. No case-to-case state leakage.
7. **Adapters must not modify the input.** The input object should be treated as read-only.

---

## Examples

### HTTP API Candidate

An adapter that calls a REST API:

```typescript
class HttpCandidateAdapter implements CandidateAdapter {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(id: string, baseUrl: string) {
    this.id = id;
    this.baseUrl = baseUrl;
  }

  async health(): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
      const response = await fetch(this.baseUrl + '/health');
      const latencyMs = performance.now() - start;
      return {
        healthy: response.ok,
        latencyMs,
        message: response.ok ? 'OK' : 'Unhealthy: status ' + response.status,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: performance.now() - start,
        message: 'Connection failed: ' + String(error),
      };
    }
  }

  async execute(input: CandidateInput, context: ExecutionContext): Promise<CandidateResult> {
    const start = performance.now();
    try {
      const response = await fetch(this.baseUrl + '/v1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.data),
      });
      const latencyMs = performance.now() - start;
      const output = await response.json();

      if (!response.ok) {
        return {
          output: null,
          status: 'error',
          latencyMs,
          error: {
            code: 'HTTP_' + response.status,
            message: 'Candidate returned ' + response.status,
            details: { body: output },
          },
        };
      }

      return { output, status: 'success', latencyMs };
    } catch (error) {
      return {
        output: null,
        status: 'error',
        latencyMs: performance.now() - start,
        error: {
          code: 'EXECUTION_ERROR',
          message: String(error),
        },
      };
    }
  }
}
```

### In-Process Function Candidate

An adapter that calls a local function (useful for testing evaluators):

```typescript
class FunctionCandidateAdapter implements CandidateAdapter {
  readonly id: string;
  private readonly fn: (input: unknown) => Promise<unknown>;

  constructor(id: string, fn: (input: unknown) => Promise<unknown>) {
    this.id = id;
    this.fn = fn;
  }

  async health(): Promise<HealthCheckResult> {
    return { healthy: true, latencyMs: 0, message: 'In-process function' };
  }

  async execute(input: CandidateInput, context: ExecutionContext): Promise<CandidateResult> {
    const start = performance.now();
    try {
      const output = await this.fn(input.data);
      return {
        output,
        status: 'success',
        latencyMs: performance.now() - start,
      };
    } catch (error) {
      return {
        output: null,
        status: 'error',
        latencyMs: performance.now() - start,
        error: {
          code: 'FUNCTION_ERROR',
          message: String(error),
        },
      };
    }
  }
}
```

### Mock Candidate (Testing)

An adapter that returns canned responses for evaluator testing:

```typescript
class MockCandidateAdapter implements CandidateAdapter {
  readonly id = 'mock-candidate';
  private readonly responses: Map<string, unknown>;

  constructor(responses: Record<string, unknown>) {
    this.responses = new Map(Object.entries(responses));
  }

  async health(): Promise<HealthCheckResult> {
    return { healthy: true, latencyMs: 0 };
  }

  async execute(input: CandidateInput, context: ExecutionContext): Promise<CandidateResult> {
    const key = JSON.stringify(input.data);
    const output = this.responses.get(key) ?? null;
    return {
      output,
      status: output !== null ? 'success' : 'error',
      latencyMs: 1,
      error: output === null
        ? { code: 'NO_MOCK', message: 'No mock response for input: ' + key }
        : undefined,
    };
  }
}
```

---

## Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Throw exceptions from `execute()` | Return `{ status: 'error', error: { ... } }` |
| Implement timeout logic in the adapter | Let EvalOS handle timeouts via `Promise.race` |
| Store state between executions | Keep adapters stateless |
| Import EvalOS internals | Depend only on the contract types |
| Mutate the input object | Treat input as read-only |
| Catch and suppress errors silently | Always populate the `error` field on failure |
