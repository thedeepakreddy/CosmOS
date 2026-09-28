# JudgeProvider Contract

## Overview

A `JudgeProvider` is the interface for LLM-based evaluation. It abstracts the model API behind a simple `judge()` method, allowing EvalOS to score candidate outputs using language model judgments.

---

> **⚠️ BLOCKED IN v0.1: Live judge providers are NOT implemented in v0.1.**
>
> Only mock/test providers are allowed. No real LLM API calls are made during evaluation.
> This contract is documented to establish the interface for future implementation.

---

## Interface

```typescript
interface JudgeProvider {
  /** Unique identifier for this judge provider */
  readonly id: string;

  /**
   * Check if the judge provider is reachable and ready.
   * For mock providers, this always returns healthy.
   * For live providers (future), this checks API connectivity.
   *
   * @returns HealthCheckResult indicating provider readiness
   */
  health(): Promise<HealthCheckResult>;

  /**
   * Submit a judgment request to the provider.
   *
   * @param request - The judgment request containing candidate output and evaluation criteria
   * @returns JudgeResult containing the judgment, scores, and reasoning
   */
  judge(request: JudgeRequest): Promise<JudgeResult>;
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

### JudgeRequest

```typescript
interface JudgeRequest {
  /** The candidate's output to judge */
  candidateOutput: unknown;

  /** The original input that produced the output */
  input: unknown;

  /** Optional expected/reference output for comparison */
  expectedOutput?: unknown;

  /** The evaluation criteria to apply */
  criteria: JudgeCriteria[];

  /** Optional system prompt override */
  systemPrompt?: string;

  /** Optional model configuration */
  modelConfig?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}
```

### JudgeCriteria

```typescript
interface JudgeCriteria {
  /** Name of the criterion (becomes the metric name in scores) */
  name: string;

  /** Description of what to evaluate */
  description: string;

  /** Scoring scale */
  scale: {
    type: 'numeric' | 'boolean' | 'categorical';
    min?: number;
    max?: number;
    categories?: string[];
  };

  /** Weight for aggregation (default: 1.0) */
  weight?: number;
}
```

### JudgeResult

```typescript
interface JudgeResult {
  /** Overall judgment status */
  status: 'success' | 'error';

  /** Per-criteria judgments */
  judgments: Judgment[];

  /** Raw model response (for debugging and auditing) */
  rawResponse?: unknown;

  /** Token usage information */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Time taken for the judgment */
  latencyMs: number;

  /** Error details if status is 'error' */
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Judgment

```typescript
interface Judgment {
  /** The criterion this judgment applies to */
  criterion: string;

  /** The score value */
  value: number | boolean | string;

  /** The model's reasoning for this judgment */
  reasoning: string;

  /** Confidence level (0.0 - 1.0), if available */
  confidence?: number;
}
```

---

## Contract Rules

1. **`id` must be unique** across all judge providers.
2. **`health()` must not throw.** Returns `{ healthy: false }` on failure.
3. **`judge()` must always resolve** with a `JudgeResult`. Errors are captured in `result.status = 'error'`, not thrown.
4. **`judge()` must return a judgment for every criterion** in the request. Missing criteria judgments are an error.
5. **`judge()` must include reasoning** for every judgment. Scores without reasoning are not acceptable for model-judged evaluation.
6. **Raw model responses must be preserved** in `rawResponse` for auditing and debugging.
7. **Token usage should be reported** when available, for cost tracking.
8. **Providers must be stateless.** No request-to-request state.

---

## v0.1 Limitations

| Feature | Status |
|---|---|
| Live LLM API calls | ❌ **BLOCKED** |
| Mock/test providers | ✅ Allowed |
| Multiple model support | ❌ Not implemented |
| Prompt versioning | ❌ Not implemented |
| Cost tracking | ❌ Not implemented |
| Rate limiting | ❌ Not implemented |
| Caching | ❌ Not implemented |

### Why Blocked?

Live judge providers are blocked in v0.1 because:

1. **Cost control**: Uncontrolled LLM API calls during evaluation runs can be expensive.
2. **Reproducibility**: Model API responses are non-deterministic, making regression detection unreliable.
3. **Availability**: External API dependencies make evaluation runs fragile.
4. **Scope**: v0.1 focuses on deterministic and rule-based evaluation, which covers the majority of use cases.

### Mock Provider Example

For testing evaluators that will eventually use model judges:

```typescript
class MockJudgeProvider implements JudgeProvider {
  readonly id = 'mock-judge';
  private readonly responses: Map<string, Judgment[]>;

  constructor(responses: Record<string, Judgment[]>) {
    this.responses = new Map(Object.entries(responses));
  }

  async health(): Promise<HealthCheckResult> {
    return { healthy: true, latencyMs: 0, message: 'Mock provider' };
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const key = JSON.stringify(request.candidateOutput);
    const judgments = this.responses.get(key);

    if (!judgments) {
      return {
        status: 'error',
        judgments: [],
        latencyMs: 0,
        error: {
          code: 'NO_MOCK_RESPONSE',
          message: 'No mock response configured for this input',
        },
      };
    }

    return {
      status: 'success',
      judgments,
      latencyMs: 1,
      rawResponse: { mock: true },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}
```

---

## Future Implementation Notes

When live providers are implemented (post-v0.1):

1. **Rate limiting** must be built in to prevent API abuse.
2. **Prompt versioning** is required — changing the judge prompt changes the evaluator and must be tracked.
3. **Caching** should be considered for identical inputs to reduce cost and improve reproducibility.
4. **Multiple model support** allows comparing judgments across models.
5. **Cost tracking** per-run and per-case for budget management.
6. **Fallback chains** for provider resilience (e.g., try GPT-4, fall back to GPT-3.5).
7. **Structured output** enforcement (JSON mode / function calling) for reliable parsing.

---

## Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Make live LLM calls in v0.1 | Use mock providers for testing |
| Throw exceptions from `judge()` | Return `{ status: 'error', error: { ... } }` |
| Omit reasoning from judgments | Always include reasoning for traceability |
| Discard raw model responses | Preserve in `rawResponse` for auditing |
| Assume deterministic model output | Account for non-determinism in comparison logic |
| Ignore token usage | Track and report usage when available |
