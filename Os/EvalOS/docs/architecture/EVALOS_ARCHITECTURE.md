# EvalOS Architecture

## Layer Overview

```
HTTP Client / SDK
        |
   Fastify API (src/api/)
        |
   EvaluationEngine (src/engine/)
   |          |
CandidateAdapter  Evaluator
        |
  Repositories (src/repositories/)
        |
    SQLite (better-sqlite3)
        |
  EventBus (src/events/)
```

---

## Core Components

### Config (`src/config/index.ts`)
Zod-validated environment configuration. Loaded once at startup. No hardcoded paths.

### Logger (`src/logger/index.ts`)
Structured JSON logging via pino. Redacts API keys, secrets, passwords, credentials.

### Database (`src/db/`)
- `sqlite.ts`: Returns a `better-sqlite3` Database instance with WAL mode and foreign keys enabled.
- `migrate.ts`: Custom migration runner that tracks applied migrations in `_migrations` table. Idempotent.
- `migrations/001_initial_schema.sql`: Full schema definition.

### EventBus (`src/events/EventBus.ts`)
In-process event emitter wrapping Node.js `EventEmitter`. Publishes typed lifecycle events:
- `eval.run.started`, `eval.run.completed`, `eval.run.failed`
- `eval.case.started`, `eval.case.completed`, `eval.case.failed`, `eval.case.timed_out`
- `eval.score.recorded`

### Contracts (`src/contracts/`)
- `Domain.ts`: Core entity interfaces (EvaluationSuite, EvaluationCase, Dataset, EvaluationRun, CaseExecution, QualityGate, RegressionRule, MetricAggregation)
- `Candidate.ts`: `CandidateAdapter` interface — health + execute
- `Evaluator.ts`: `Evaluator` interface — evaluate → EvaluationScore[]

### Repositories (`src/repositories/`)
SQLite-backed repositories. One class per entity. All JSON columns serialized/deserialized.
- `SuiteRepository`, `CaseRepository`, `DatasetRepository`
- `RunRepository`, `CaseExecutionRepository`, `ScoreRepository`

### Domain / State Machines (`src/domain/StateMachines.ts`)
Validates state transitions. Invalid transitions throw `InvalidStateTransitionError`.

**Run states**: CREATED → READY → RUNNING → COMPLETED/FAILED/CANCELLED/TIMED_OUT

**Case states**: PENDING → RUNNING → SUCCEEDED/FAILED/TIMED_OUT/SKIPPED

### Evaluators (`src/evaluators/`)
Built-in deterministic evaluators:
- `ExactMatchEvaluator`: Output must equal expected exactly
- `JsonSchemaEvaluator`: Output must validate against a JSON Schema (via Ajv)
- `LatencyThresholdEvaluator`: Candidate latencyMs must be <= threshold
- `ContainsEvaluator`: Output string must contain expected substring

### EvaluationEngine (`src/engine/EvaluationEngine.ts`)
Orchestrates run execution:
1. Validates run state → transitions to RUNNING
2. Looks up candidate, checks health
3. Loads all PENDING case executions for the run
4. Uses `p-limit` to bound concurrency to `MAX_CONCURRENCY`
5. For each case: checks timeout via `Promise.race`, calls evaluator(s), persists scores
6. Transitions run to COMPLETED or FAILED

### Comparison Layer (`src/engine/comparison/`)
- `AggregationEngine`: Aggregates scores into passRate, average, min/max per metric
- `RegressionDetector`: Compares baseline vs candidate aggregations against rules
- `QualityGateEvaluator`: Tests aggregated metrics against threshold gates

### API (`src/api/`)
Fastify v5 server. Routes:
- `GET /health` — EvalOS process health
- `GET /openapi.json` — OpenAPI document
- `GET /docs` — Swagger UI
- `POST/GET /v1/suites`
- `POST/GET /v1/datasets`
- `POST/GET /v1/runs`, `POST /v1/runs/:id/start`, `GET /v1/runs/:id/scores`
- `POST /v1/traces` — Generic trace ingestion

### Artifact Manager (`src/api/artifacts/index.ts`)
Filesystem-backed artifact storage. Path traversal rejected via `path.resolve` + prefix check.

### SDK (`sdk/index.ts`)
`EvalOSClient` — thin HTTP wrapper over the EvalOS API. Calls real HTTP.
