# EvalOS Master Specification v0.1

## Purpose

EvalOS is the reusable evaluation, benchmarking, regression detection, quality measurement, comparison, and release-gating platform for AI systems.

**Core question: Did this system actually get better?**

EvalOS exists to answer this question with evidence, not opinions. It provides a structured, reproducible pipeline for running evaluation suites against AI system candidates, scoring their outputs, comparing results against baselines, detecting regressions, and enforcing quality gates before release.

---

## Architecture

### Design Philosophy

- **Modular monolith**: Single deployable unit with clear internal module boundaries.
- **Stack**: Node.js + TypeScript + Fastify + SQLite
- **No over-engineering**: No Kafka, no Kubernetes, no Redis, no microservices. Complexity is earned, not assumed.
- **Independent project**: EvalOS has zero runtime imports from ToolOS, AgentOS, ResearchOS, or MemoryOS. Integration happens through contracts and adapters at the boundary, never through shared code.

### Module Structure

```
src/
├── domain/          # Pure domain types, state machines, value objects
├── evaluators/      # Built-in evaluator implementations
├── engine/          # Evaluation orchestration and execution
├── persistence/     # SQLite repositories and migrations
├── api/             # Fastify routes, schemas, error handling
├── sdk/             # TypeScript client SDK
├── config/          # Environment validation and configuration
├── observability/   # Structured logging, metrics, tracing
└── shared/          # Utilities (bounded concurrency, timeout helpers)
```

---

## Domain Model

The following entities form the core domain:

| Entity | Description |
|---|---|
| **EvaluationSuite** | A named, versioned collection of evaluation cases and configuration. The top-level organizational unit. |
| **EvaluationCase** | A single test case within a suite: input, expected output, metadata, tags. |
| **Dataset** | A versioned, immutable collection of evaluation cases. Suites reference datasets. |
| **Candidate** | The system under evaluation. Represented by a `CandidateAdapter` that knows how to invoke it. |
| **EvaluationRun** | A single execution of a suite against a candidate. Tracks state, timing, and aggregate results. |
| **CaseExecution** | The result of executing a single case within a run. Links case → candidate output → scores. |
| **Evaluator** | A scoring function that examines candidate output and produces scores. Has an id, version, and type. |
| **Score** | A single measurement produced by an evaluator. Has metric name, value, unit, pass/fail, and evidence. |
| **Baseline** | A stored reference run used for comparison. Immutable once created. |
| **Comparison** | The result of comparing a run against a baseline. Contains per-metric deltas. |
| **Regression** | A detected degradation in a specific metric between run and baseline. |
| **QualityGate** | A threshold-based pass/fail check applied to aggregate scores. Blocks release on failure. |
| **Artifact** | A file (log, screenshot, trace dump) associated with a case execution. Stored on disk with path traversal prevention. |
| **Trace** | A structured record of execution steps within a case. Used for debugging and analysis. |
| **Event** | A domain event emitted during evaluation (run started, case completed, regression detected, etc.). |

---

## Evaluation Flow

The end-to-end evaluation pipeline:

```
Suite
  → Dataset (load cases)
    → Run (create, transition to RUNNING)
      → For each case (bounded concurrency):
          → CandidateAdapter.execute(input, context)
          → For each evaluator:
              → Evaluator.evaluate(candidateResult, context)
              → Score[]
          → CaseExecution (persist)
      → Aggregation (compute suite-level metrics)
      → Comparison (diff against baseline, if provided)
      → Regression Detection (apply rules)
      → QualityGate (enforce thresholds)
      → Run (transition to COMPLETED or FAILED)
```

### Key Properties

- Cases are executed with **bounded concurrency** (never unbounded `Promise.all`).
- Each case has an independent **timeout** via `Promise.race`.
- Evaluators run **sequentially** per case (a case may have multiple evaluators).
- All results are **persisted before** aggregation begins.
- Comparison and regression detection are **optional** (only when a baseline is provided).
- Quality gates are **optional** (only when configured on the suite).

---

## State Machines

### Run State Machine

```
CREATED → READY → RUNNING → COMPLETED
                          → FAILED
                          → CANCELLED
                          → TIMED_OUT
```

| Transition | Trigger |
|---|---|
| CREATED → READY | All preconditions validated (suite exists, dataset loaded, candidate reachable) |
| READY → RUNNING | Execution begins |
| RUNNING → COMPLETED | All cases finished, no fatal errors |
| RUNNING → FAILED | Fatal error during execution |
| RUNNING → CANCELLED | Explicit cancellation request |
| RUNNING → TIMED_OUT | Suite-level timeout exceeded |

### Case State Machine

```
PENDING → RUNNING → SUCCEEDED
                  → FAILED
                  → TIMED_OUT
                  → SKIPPED
```

| Transition | Trigger |
|---|---|
| PENDING → RUNNING | Case execution begins |
| RUNNING → SUCCEEDED | Candidate returned output, all evaluators scored |
| RUNNING → FAILED | Candidate error or evaluator error |
| RUNNING → TIMED_OUT | Per-case timeout exceeded |
| PENDING → SKIPPED | Case filtered out by tag/filter or dependency failed |

### Enforcement

**Invalid transitions are rejected at the domain layer.** The state machine is not advisory — it is enforced. Attempting `COMPLETED → RUNNING` throws a `InvalidStateTransitionError` with the current state, attempted state, and entity id.

---

## Evaluator Types

| Type | Description |
|---|---|
| `DETERMINISTIC` | Pure function. Same input always produces same score. No external calls. |
| `RULE_BASED` | Applies configurable rules (thresholds, patterns, schemas) to candidate output. |
| `MODEL_JUDGE` | Uses an LLM to score candidate output. Requires a `JudgeProvider`. **Blocked in v0.1** for live providers. |
| `HUMAN` | Score provided by a human reviewer. Out of scope for v0.1 automation. |
| `HYBRID` | Combines multiple evaluation strategies. E.g., deterministic pre-filter + model judge. |

---

## Built-in Evaluators

### ExactMatchEvaluator
- **Type**: DETERMINISTIC
- **Metric**: `exact_match`
- **Description**: Checks if candidate output exactly matches expected output.
- **Score**: boolean (true/false)

### ContainsEvaluator
- **Type**: DETERMINISTIC
- **Metric**: `contains`
- **Description**: Checks if candidate output contains expected substring(s).
- **Score**: boolean (true/false)
- **Config**: `substrings: string[]`, `mode: 'all' | 'any'`

### JsonSchemaEvaluator
- **Type**: RULE_BASED
- **Metric**: `json_schema_valid`
- **Description**: Validates candidate output against a JSON Schema.
- **Score**: boolean (true/false)
- **Evidence**: Validation errors on failure.

### StatusEvaluator
- **Type**: DETERMINISTIC
- **Metric**: `status`
- **Description**: Checks if candidate execution status matches expected status.
- **Score**: boolean (true/false)

### LatencyThresholdEvaluator
- **Type**: RULE_BASED
- **Metric**: `latency_within_threshold`
- **Description**: Checks if candidate execution latency is within a configured threshold.
- **Score**: boolean (true/false)
- **Config**: `maxLatencyMs: number`
- **Evidence**: Actual latency vs threshold.

### NumericThresholdEvaluator
- **Type**: RULE_BASED
- **Metric**: `numeric_threshold`
- **Description**: Checks if a numeric value from candidate output meets a threshold.
- **Score**: boolean (true/false)
- **Config**: `field: string`, `operator: '>=' | '<=' | '>' | '<' | '=='`, `threshold: number`

---

## Score Model

A `Score` represents a single measurement produced by an evaluator.

```typescript
interface Score {
  metric: string;           // e.g., "exact_match", "latency_ms", "coherence"
  value: number | boolean | string;  // The actual score value
  unit?: string;            // e.g., "ms", "percent", "boolean"
  passed?: boolean;         // Whether this score meets its threshold
  evaluatorId: string;      // Which evaluator produced this score
  evaluatorVersion: string; // Version of the evaluator
  evidence?: Record<string, unknown>;  // Supporting data for the score
}
```

### Value Types

- **number**: Continuous metrics (latency, similarity score, token count)
- **boolean**: Binary pass/fail checks (exact match, schema valid)
- **string**: Categorical assessments (grade: "A"/"B"/"C", sentiment: "positive"/"negative")

### Evidence

Every score MAY include an `evidence` object with arbitrary structured data explaining how the score was computed. This is essential for debugging and for human review of model-judged scores.

---

## Comparison

Comparison produces per-metric deltas between a run and a baseline.

```typescript
interface MetricComparison {
  metric: string;
  baselineValue: number;
  currentValue: number;
  absoluteDelta: number;    // current - baseline
  relativeDelta: number;    // (current - baseline) / baseline
  direction: 'improved' | 'degraded' | 'unchanged';
}
```

### Rules

- Comparisons are only computed for **numeric** metrics.
- Boolean metrics are aggregated to pass rates before comparison.
- String metrics are not compared (no ordinal assumption).
- **No claims of statistical significance** are made unless a proper statistical test is actually performed. EvalOS does not perform statistical tests in v0.1.

---

## Regression Detection

Regression detection applies deterministic rules to comparison results.

### Rules

| Rule | Description |
|---|---|
| `maxAbsoluteDrop` | Maximum allowed absolute decrease in a metric. |
| `maxRelativeDrop` | Maximum allowed relative decrease in a metric (as a fraction, e.g., 0.05 = 5%). |

### Outcome

| Outcome | Meaning |
|---|---|
| `PASS` | No regressions detected. All metrics within tolerance. |
| `FAIL` | At least one metric exceeded its regression threshold. |
| `WARNING` | Metrics degraded but within tolerance. Advisory only. |

### Configuration

Regression rules are configured per-suite and can be overridden per-metric:

```typescript
interface RegressionConfig {
  defaultRules: RegressionRule;
  metricOverrides?: Record<string, RegressionRule>;
}

interface RegressionRule {
  maxAbsoluteDrop?: number;
  maxRelativeDrop?: number;
}
```

---

## Quality Gates

Quality gates enforce hard thresholds on aggregate metrics.

```typescript
interface QualityGate {
  metric: string;
  operator: '>=' | '<=' | '>' | '<' | '==' | '!=';
  threshold: number;
}
```

### Evaluation

Each gate produces a `QualityGateResult`:

```typescript
interface QualityGateResult {
  gate: QualityGate;
  actualValue: number;
  passed: boolean;
  evidence: {
    metric: string;
    operator: string;
    threshold: number;
    actualValue: number;
    message: string;  // Human-readable explanation
  };
}
```

### Behavior

- All gates must pass for the run to be considered gate-passed.
- Gate failure does NOT stop the run — it marks the run and provides evidence.
- Full evidence is always provided on failure (no silent failures).

---

## API

Versioned Fastify API with JSON Schema validation on all routes.

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (returns 200 with status) |
| GET | `/v1/suites` | List evaluation suites |
| POST | `/v1/suites` | Create evaluation suite |
| GET | `/v1/suites/:id` | Get suite by ID |
| GET | `/v1/datasets` | List datasets |
| POST | `/v1/datasets` | Create dataset |
| GET | `/v1/datasets/:id` | Get dataset by ID |
| POST | `/v1/runs` | Start evaluation run |
| GET | `/v1/runs/:id` | Get run status and results |
| GET | `/v1/runs/:id/results` | Get detailed case-level results |
| GET | `/v1/traces` | List traces |
| GET | `/v1/traces/:id` | Get trace by ID |
| GET | `/openapi.json` | OpenAPI 3.0 specification |
| GET | `/docs` | Swagger UI documentation |

### Conventions

- All IDs are UUIDs.
- All timestamps are ISO 8601 in UTC.
- Pagination via `limit` and `offset` query parameters.
- Error responses follow RFC 7807 Problem Details format.
- Payload size limits enforced via Fastify configuration.

---

## SDK

TypeScript client SDK that wraps real HTTP calls.

```typescript
import { EvalOSClient } from '@evalos/sdk';

const client = new EvalOSClient({ baseUrl: 'http://localhost:3000' });

// Create a suite
const suite = await client.suites.create({ name: 'my-suite', ... });

// Start a run
const run = await client.runs.create({ suiteId: suite.id, ... });

// Poll for results
const result = await client.runs.get(run.id);
```

### Properties

- No code generation — hand-written client with full type safety.
- Uses `fetch` (Node.js 18+ built-in) — no axios or other HTTP dependencies.
- All methods return typed responses.
- Errors are typed and include the Problem Details response.

---

## Persistence

### Database

- **SQLite** via `better-sqlite3` (synchronous, fast, zero-config).
- **WAL mode** enabled for concurrent read performance.
- **Foreign keys** enforced (`PRAGMA foreign_keys = ON`).

### Migration Runner

Custom versioned migration runner (no ORM, no Knex):

- Migrations are numbered SQL files: `001_initial_schema.sql`, `002_add_traces.sql`, etc.
- Applied migrations tracked in a `_migrations` table.
- Migrations run in order, exactly once, within a transaction.
- Rollback is manual (write a compensating migration).

### Schema Highlights

- All tables have `id TEXT PRIMARY KEY` (UUIDs stored as text).
- All tables have `created_at TEXT NOT NULL` and `updated_at TEXT NOT NULL` (ISO 8601).
- Scores stored as JSON in `case_executions.scores` column.
- Artifacts reference file paths relative to `ARTIFACT_DIR`.

---

## Security

### Path Traversal Prevention

Artifact file paths are validated to ensure they resolve within the configured `ARTIFACT_DIR`. Any path containing `..` or resolving outside the artifact directory is rejected.

### Payload Size Limits

Fastify body size limit configured via `PAYLOAD_LIMIT` environment variable. Default: `1mb`.

### Input Validation

All API inputs validated via Fastify JSON Schema validation. Invalid requests receive 400 responses with validation error details.

### Secret Redaction

Structured logging (via pino) with custom serializers that redact fields matching known secret patterns (`apiKey`, `token`, `password`, `secret`, `authorization`).

### Test Isolation

No test fixtures, mock data, or test utilities in production code. Test helpers live exclusively in `tests/` directory.

---

## Concurrency

### Bounded Execution

Case execution uses `p-limit` to bound concurrency:

```typescript
import pLimit from 'p-limit';

const limit = pLimit(config.maxConcurrency);

const results = await Promise.all(
  cases.map(c => limit(() => executeCase(c)))
);
```

### Configuration

- `MAX_CONCURRENCY` environment variable (default: 5).
- Never unbounded `Promise.all` on case execution.
- Evaluators within a case run sequentially (no parallel evaluator execution per case).

---

## Timeouts

### Per-Case Timeout

Each case execution is wrapped in a `Promise.race` with a timeout:

```typescript
const result = await Promise.race([
  executeCase(caseData),
  timeout(caseTimeoutMs).then(() => {
    throw new CaseTimeoutError(caseData.id, caseTimeoutMs);
  }),
]);
```

### Limitations

- `cancellationSupported = false`: When a timeout fires, the downstream work (candidate execution) is NOT killed. The promise is abandoned but the underlying operation may continue.
- This is a known limitation documented for v0.1. True cancellation requires AbortController propagation to candidate adapters.

---

## Future Integration Points (NOT implemented in v0.1)

> **These are documented for architectural planning only. None of these integrations exist in v0.1.**

### AgentOS
- Export agent traces and results to EvalOS.
- Score agent performance on task completion, tool selection, reasoning quality.
- Regression detection on agent behavior across versions.

### ToolOS
- Evaluate tool success rates, latency, timeout frequency.
- Score tool output quality and correctness.
- Compare tool versions for regression.

### ResearchOS
- Evaluate citation correctness and source attribution.
- Detect unsupported claims in research outputs.
- Score research quality metrics (coverage, accuracy, relevance).

### MemoryOS
- Evaluate recall accuracy and precision.
- Score retrieval latency and relevance.
- Regression detection on memory quality across versions.

### Aira / Echo
- Evaluation via adapters and APIs (not direct code import).
- EvalOS provides the measurement infrastructure; Aira/Echo provide the candidates.

---

## Boundaries

**EvalOS MEASURES. It does NOT:**

- ❌ Rewrite prompts
- ❌ Edit code
- ❌ Change routing
- ❌ Deploy versions
- ❌ Self-modify
- ❌ Make decisions about what to do with evaluation results
- ❌ Automatically fix regressions

EvalOS produces scores, comparisons, and regression reports. What happens with those results is the responsibility of the calling system.

---

## Configuration

Environment variables validated by Zod at startup. Missing required variables cause immediate, clear failure.

| Variable | Type | Default | Description |
|---|---|---|---|
| `PORT` | number | `3000` | HTTP server port |
| `HOST` | string | `'0.0.0.0'` | HTTP server host |
| `DATABASE_URL` | string | `'./data/evalos.db'` | SQLite database file path |
| `ARTIFACT_DIR` | string | `'./data/artifacts'` | Directory for artifact storage |
| `MAX_CONCURRENCY` | number | `5` | Maximum concurrent case executions |
| `PAYLOAD_LIMIT` | string | `'1mb'` | Maximum request body size |
| `LOG_LEVEL` | string | `'info'` | Logging level (debug, info, warn, error) |
| `NODE_ENV` | string | `'development'` | Environment (development, production, test) |

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('./data/evalos.db'),
  ARTIFACT_DIR: z.string().default('./data/artifacts'),
  MAX_CONCURRENCY: z.coerce.number().min(1).max(100).default(5),
  PAYLOAD_LIMIT: z.string().default('1mb'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
```
