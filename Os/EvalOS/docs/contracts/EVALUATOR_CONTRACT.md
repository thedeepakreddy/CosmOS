# Evaluator Contract

## Overview

An `Evaluator` is a scoring function that examines a candidate's output and produces one or more scores. Evaluators are the core measurement mechanism in EvalOS — they define what "better" means for a given metric.

**Evaluators are pure measurement functions.** They observe and score. They do not modify, retry, or provide feedback to the candidate.

---

## Interface

```typescript
interface Evaluator {
  /** Unique identifier for this evaluator */
  readonly id: string;

  /** Semantic version of this evaluator (e.g., "1.0.0") */
  readonly version: string;

  /** The type of evaluation strategy this evaluator uses */
  readonly type: EvaluatorType;

  /**
   * Evaluate a candidate's result and produce one or more scores.
   *
   * @param candidateResult - The output from the candidate system
   * @param context - Evaluation context (case data, expected output, metadata)
   * @returns Array of scores produced by this evaluator
   */
  evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]>;
}
```

---

## Evaluator Types

```typescript
type EvaluatorType =
  | 'DETERMINISTIC'  // Pure function, no external calls
  | 'RULE_BASED'     // Configurable rules and thresholds
  | 'MODEL_JUDGE'    // LLM-based scoring (blocked in v0.1 for live providers)
  | 'HUMAN'          // Human-provided scores (out of scope for v0.1 automation)
  | 'HYBRID';        // Combination of strategies
```

---

## Supporting Types

### EvaluationContext

```typescript
interface EvaluationContext {
  /** The original evaluation case */
  case: {
    id: string;
    input: unknown;
    expectedOutput?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
  };

  /** ID of the current evaluation run */
  runId: string;

  /** Optional evaluator-specific configuration */
  config?: Record<string, unknown>;
}
```

### EvaluationScore

```typescript
interface EvaluationScore {
  /** Name of the metric (e.g., "exact_match", "latency_ms", "coherence") */
  metric: string;

  /** The score value */
  value: number | boolean | string;

  /** Optional unit of measurement */
  unit?: string;

  /** Whether this score meets its passing criteria */
  passed?: boolean;

  /** ID of the evaluator that produced this score */
  evaluatorId: string;

  /** Version of the evaluator */
  evaluatorVersion: string;

  /** Supporting evidence for the score */
  evidence?: Record<string, unknown>;
}
```

### CandidateResult

```typescript
interface CandidateResult {
  output: unknown;
  status: 'success' | 'error' | 'timeout';
  latencyMs: number;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}
```

---

## Contract Rules

1. **`id` must be unique** across all evaluators used in a suite.
2. **`version` must follow semantic versioning.** Score comparisons across evaluator versions are flagged in comparison reports.
3. **`evaluate()` must always resolve** with an array of scores. It must never throw. Errors during evaluation are captured as scores with `passed: false` and error details in `evidence`.
4. **`evaluate()` must return at least one score.** An empty array is invalid.
5. **Every score must include `evaluatorId` and `evaluatorVersion`.** This is non-negotiable for traceability.
6. **Evaluators must be stateless.** No case-to-case state. No accumulation across cases within a run.
7. **DETERMINISTIC evaluators must be pure.** Given the same `candidateResult` and `context`, they must produce the same scores. No randomness, no external calls, no time-dependent logic.
8. **MODEL_JUDGE evaluators require a `JudgeProvider`.** Live judge providers are **blocked in v0.1**. Only mock/test providers are allowed.
9. **Evidence is strongly encouraged.** Scores without evidence are harder to debug. Always include relevant context.

---

## Examples

### ExactMatchEvaluator

```typescript
class ExactMatchEvaluator implements Evaluator {
  readonly id = 'exact-match';
  readonly version = '1.0.0';
  readonly type: EvaluatorType = 'DETERMINISTIC';

  async evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]> {
    const expected = context.case.expectedOutput;
    const actual = candidateResult.output;
    const matched = JSON.stringify(actual) === JSON.stringify(expected);

    return [{
      metric: 'exact_match',
      value: matched,
      passed: matched,
      evaluatorId: this.id,
      evaluatorVersion: this.version,
      evidence: {
        expected,
        actual,
        comparison: 'JSON.stringify equality',
      },
    }];
  }
}
```

### LatencyThresholdEvaluator

```typescript
class LatencyThresholdEvaluator implements Evaluator {
  readonly id = 'latency-threshold';
  readonly version = '1.0.0';
  readonly type: EvaluatorType = 'RULE_BASED';

  async evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]> {
    const maxLatencyMs = (context.config?.maxLatencyMs as number) ?? 5000;
    const actualMs = candidateResult.latencyMs;
    const passed = actualMs <= maxLatencyMs;

    return [{
      metric: 'latency_within_threshold',
      value: passed,
      unit: 'boolean',
      passed,
      evaluatorId: this.id,
      evaluatorVersion: this.version,
      evidence: {
        actualLatencyMs: actualMs,
        maxLatencyMs,
        message: passed
          ? 'Latency ' + actualMs + 'ms within threshold ' + maxLatencyMs + 'ms'
          : 'Latency ' + actualMs + 'ms exceeded threshold ' + maxLatencyMs + 'ms',
      },
    }];
  }
}
```

### JsonSchemaEvaluator

```typescript
import Ajv from 'ajv';

class JsonSchemaEvaluator implements Evaluator {
  readonly id = 'json-schema';
  readonly version = '1.0.0';
  readonly type: EvaluatorType = 'RULE_BASED';

  private readonly ajv = new Ajv({ allErrors: true });

  async evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]> {
    const schema = context.config?.schema;
    if (!schema) {
      return [{
        metric: 'json_schema_valid',
        value: false,
        passed: false,
        evaluatorId: this.id,
        evaluatorVersion: this.version,
        evidence: { error: 'No schema provided in evaluator config' },
      }];
    }

    const validate = this.ajv.compile(schema as object);
    const valid = validate(candidateResult.output);

    return [{
      metric: 'json_schema_valid',
      value: valid,
      passed: valid,
      evaluatorId: this.id,
      evaluatorVersion: this.version,
      evidence: {
        valid,
        errors: valid ? null : validate.errors,
        schema,
      },
    }];
  }
}
```

### ContainsEvaluator

```typescript
class ContainsEvaluator implements Evaluator {
  readonly id = 'contains';
  readonly version = '1.0.0';
  readonly type: EvaluatorType = 'DETERMINISTIC';

  async evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]> {
    const substrings = (context.config?.substrings as string[]) ?? [];
    const mode = (context.config?.mode as 'all' | 'any') ?? 'all';
    const output = String(candidateResult.output);

    const results = substrings.map(s => ({
      substring: s,
      found: output.includes(s),
    }));

    const passed = mode === 'all'
      ? results.every(r => r.found)
      : results.some(r => r.found);

    return [{
      metric: 'contains',
      value: passed,
      passed,
      evaluatorId: this.id,
      evaluatorVersion: this.version,
      evidence: {
        mode,
        substrings: results,
        outputLength: output.length,
      },
    }];
  }
}
```

### Multi-Score Evaluator

An evaluator can return multiple scores:

```typescript
class ComprehensiveEvaluator implements Evaluator {
  readonly id = 'comprehensive';
  readonly version = '1.0.0';
  readonly type: EvaluatorType = 'RULE_BASED';

  async evaluate(
    candidateResult: CandidateResult,
    context: EvaluationContext
  ): Promise<EvaluationScore[]> {
    const scores: EvaluationScore[] = [];
    const base = { evaluatorId: this.id, evaluatorVersion: this.version };

    // Score 1: Status check
    const statusOk = candidateResult.status === 'success';
    scores.push({
      ...base,
      metric: 'status_success',
      value: statusOk,
      passed: statusOk,
      evidence: { actualStatus: candidateResult.status },
    });

    // Score 2: Latency measurement
    scores.push({
      ...base,
      metric: 'latency_ms',
      value: candidateResult.latencyMs,
      unit: 'ms',
      evidence: { rawLatencyMs: candidateResult.latencyMs },
    });

    // Score 3: Output non-empty check
    const hasOutput = candidateResult.output != null
      && String(candidateResult.output).length > 0;
    scores.push({
      ...base,
      metric: 'output_non_empty',
      value: hasOutput,
      passed: hasOutput,
      evidence: {
        outputType: typeof candidateResult.output,
        outputLength: candidateResult.output != null
          ? String(candidateResult.output).length
          : 0,
      },
    });

    return scores;
  }
}
```

---

## Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Throw exceptions from `evaluate()` | Return scores with `passed: false` and error evidence |
| Return an empty array | Always return at least one score |
| Omit `evaluatorId` or `evaluatorVersion` | Always include both for traceability |
| Maintain state between evaluations | Keep evaluators stateless |
| Make external calls in DETERMINISTIC evaluators | Use RULE_BASED or MODEL_JUDGE type instead |
| Omit evidence | Include evidence explaining how the score was computed |
| Use random values in DETERMINISTIC evaluators | DETERMINISTIC means pure: same input → same output |
