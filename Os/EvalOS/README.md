# EvalOS

**Evaluation, Benchmarking, Regression Detection, Quality Measurement, Comparison, and Release-Gating Platform for AI Systems.**

EvalOS answers the question: *Did this system actually get better?*

---

## What EvalOS Does

- Runs evaluation cases against AI system candidates (agents, models, prompts, routers)
- Scores results via deterministic, rule-based, or LLM-as-judge evaluators
- Persists all runs, scores, and evidence in SQLite
- Compares candidate runs against baselines
- Detects regressions with deterministic rules
- Evaluates quality gates before a release
- Exposes a versioned REST API and TypeScript SDK

---

## Quick Start

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# Edit HOST, PORT, DATABASE_URL, ARTIFACT_DIR, MAX_CONCURRENCY
```

### Run Development Server

```bash
npx tsx src/index.ts
```

### Run Production Build

```bash
npm run build
node dist/src/index.js
```

### API Docs

```
http://localhost:3000/docs
http://localhost:3000/openapi.json
http://localhost:3000/health
```

---

## Run Tests

```bash
npm test                    # All tests
npm run lint                # ESLint
npx tsc -p tsconfig.check.json  # Full typecheck
```

---

## Architecture

See [`docs/architecture/EVALOS_ARCHITECTURE.md`](docs/architecture/EVALOS_ARCHITECTURE.md)

## Implementation Evidence

See [`docs/evidence/IMPLEMENTATION_EVIDENCE.md`](docs/evidence/IMPLEMENTATION_EVIDENCE.md)

## Full Specification

See [`docs/MASTER_EVALOS_SPEC.md`](docs/MASTER_EVALOS_SPEC.md)

---

## Project Structure

```
src/
  config/         Environment-based configuration (Zod)
  db/             SQLite connection, migration runner, migration files
  events/         In-process EventBus
  contracts/      TypeScript interfaces (Domain, Candidate, Evaluator)
  repositories/   SQLite-backed data access
  domain/         State machine validators
  evaluators/     Built-in deterministic evaluators
  engine/         EvaluationEngine (execution, timeouts, concurrency)
  engine/comparison/  AggregationEngine, RegressionDetector, QualityGateEvaluator
  api/            Fastify server, routes, artifact manager
  logger/         Structured pino logger with redaction
  index.ts        Production entrypoint

sdk/              TypeScript client SDK

tests/
  unit/           Config, migrations, EventBus, StateMachines, Artifacts
  integration/    Repository CRUD, API HTTP
  acceptance/     Engine scenarios (ExactMatch, JSON Schema, Timeout, Concurrency, Regression)
  contracts/      Candidate and Evaluator contract tests
  fixtures/       Test-only candidate implementations

docs/
  MASTER_EVALOS_SPEC.md
  CONTINUATION_LOG.md
  architecture/
  evidence/
  contracts/
  integration/
```

---

## Key Design Decisions

- **No fake results**: All scores are derived from real candidate execution and real evaluator logic.
- **Test fixtures are isolated**: `tests/fixtures/` only. Zero references in production code.
- **Versioned everything**: Suites, datasets, candidates, evaluators, rubrics all carry versions.
- **Bounded concurrency**: `p-limit` enforces `MAX_CONCURRENCY` — never unbounded `Promise.all`.
- **State machines**: Invalid run/case state transitions are rejected at the domain layer.
- **No external OS dependencies**: EvalOS is fully standalone. Future integrations are via HTTP/adapters.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| NODE_ENV | development | Environment |
| PORT | 3000 | HTTP port |
| HOST | 127.0.0.1 | Bind address |
| DATABASE_URL | ./evalos.db | SQLite path |
| ARTIFACT_DIR | ./artifacts/runtime | Artifact storage |
| MAX_CONCURRENCY | 4 | Max parallel case executions |
| PAYLOAD_LIMIT | 10485760 | Body size limit (bytes) |
