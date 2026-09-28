# EvalOS Wiring Map

## HTTP Trace: POST /v1/suites

```
HTTP POST /v1/suites (body: {id, name, version, caseIds})
→ Fastify schema validation (required fields enforced)
→ suiteRoutes handler
→ fastify.repos.suites.create(request.body)
→ SuiteRepository.create()
→ SQLite INSERT INTO suites
→ reply 201 { status: 'created' }
```

## HTTP Trace: POST /v1/runs/:id/start

```
HTTP POST /v1/runs/:id/start
→ runRoutes handler
→ fastify.engine.startRun(request.params.id)
→ EvaluationEngine.startRun(runId)
  → RunRepository.getById(runId)
  → validateRunTransition('READY' → 'RUNNING')
  → RunRepository.updateStatus('RUNNING')
  → EventBus.publish('eval.run.started', ...)
  → SuiteRepository.getById(suiteId)
  → getCandidate(candidateId, candidateVersion)   [factory fn]
  → candidate.health()
  → pLimit(MAX_CONCURRENCY)
  → CaseExecutionRepository.getByRunId(runId)
  → for each pending exec in parallel (bounded):
    → EvaluationEngine.executeCase(run, exec, candidate)
      → validateCaseTransition('PENDING' → 'RUNNING')
      → CaseExecutionRepository.update(RUNNING)
      → EventBus.publish('eval.case.started', ...)
      → CaseRepository.getById(caseId)
      → candidate.execute(input, context)
            [with optional Promise.race timeout]
      → for each evaluatorId in evalCase.evaluators:
        → getEvaluator(evalId) [factory fn]
        → evaluator.evaluate(candidateResult, context)
        → for each score:
          → ScoreRepository.create(execId, runId, score)
          → EventBus.publish('eval.score.recorded', ...)
      → CaseExecutionRepository.update(SUCCEEDED)
      → EventBus.publish('eval.case.completed', ...)
  → validateRunTransition('RUNNING' → 'COMPLETED')
  → RunRepository.updateStatus('COMPLETED')
  → EventBus.publish('eval.run.completed', ...)
→ reply { status: 'started_and_completed' }
```

## HTTP Trace: GET /v1/runs/:id/scores

```
HTTP GET /v1/runs/:id/scores
→ runRoutes handler
→ fastify.repos.scores.getByRunId(id)
→ ScoreRepository.getByRunId(runId)
→ SQLite SELECT * FROM scores WHERE run_id = ?
→ rows mapped to EvaluationScore[]
→ reply { scores: [...] }
```

## HTTP Trace: POST /v1/traces

```
HTTP POST /v1/traces (body: TraceEvent)
→ Fastify schema validation
→ traceRoutes handler
→ reply 201 { status: 'ingested' }
```

## Comparison / Regression Flow (in-process, no HTTP)

```
ScoreRepository.getByRunId(baselineRunId) → EvaluationScore[]
ScoreRepository.getByRunId(candidateRunId) → EvaluationScore[]
AggregationEngine.aggregateScores(baselineScores) → MetricAggregation[]
AggregationEngine.aggregateScores(candidateScores) → MetricAggregation[]
RegressionDetector.detect(baselineAggs, candidateAggs, rules) → RegressionResult[]
QualityGateEvaluator.evaluate(candidateAggs, gates) → QualityGateResult[]
```
