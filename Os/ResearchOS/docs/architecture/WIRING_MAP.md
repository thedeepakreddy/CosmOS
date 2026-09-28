# ResearchOS — Wiring Map

Execution paths that exist today, in actual filenames and functions. Paths that
do not exist yet are in the final section, marked as such, so this document
stays a description of the system rather than a description of the plan.

Last updated: 2026-09-15 (recovery session 2, after Phase 5).

---

## Module graph

Dependencies point strictly downward. `scripts/lint-architecture.mjs` fails the
build if that stops being true.

```text
7  applications      api · worker
                         │
6  composition       research-core            ← agents, handlers, runtime
                         │
5  engine            orchestration · verification · evaluation
                         │
4  domain services   claims · memory · retrieval · ingestion · executors
                         │
3  ports + adapters  persistence · model-router · tools · evidence ·
                     knowledge-graph · experiments
                         │
2  cross-cutting     observability · events · sdk
                         │
1  contracts         contracts
                         │
0  foundation        shared
```

All 22 workspaces are implemented. Dependencies point strictly downward, with two
exceptions that are declared and legal: `persistence` → `events` (an adapter
implementing a port) and `executors` → `tools` (a provider implementing the
`ToolProvider` port).

---

## Startup: opening a database

```text
npm run migrate
  → node --import ./scripts/register.mjs scripts/migrate.mjs
  → scripts/register.mjs
      parseDotEnv()                       packages/shared/src/env.ts
      → process.env (real env always wins)
  → scripts/migrate.mjs
      databaseConfigFromEnv()             packages/persistence/src/config.ts
        reads RESEARCH_OS_DATABASE_URL, infers the driver from its scheme
      createDatabaseFromEnv()             packages/persistence/src/config.ts
        → new SqliteDatabase()            packages/persistence/src/sqlite-database.ts
          or PostgresDatabase.connect()   packages/persistence/src/postgres-database.ts
      migrate(db, { logger })             packages/persistence/src/migrator.ts
        ensureLedger()                      CREATE TABLE schema_migrations
        MIGRATIONS[].up(db.dialect)         packages/persistence/src/migrations/001-initial-schema.ts
          → dialect emits engine-specific DDL   packages/persistence/src/dialect.ts
        → 88 statements, inside one transaction
        → ledger row written; a re-run is a no-op
```

**Verified:** applies cleanly, is idempotent, reports status with `--status`.

---

## Writing and reading research state

```text
createStore(db, now)                      packages/persistence/src/store.ts
  → ProjectRepository                     .../repositories/project-repository.ts
  → ResearchRepository                    .../repositories/research-repository.ts
  → TaskRepository                        .../repositories/task-repository.ts
  → RunRepository                         .../repositories/run-repository.ts
  → SqlEventStore                         .../repositories/event-store.ts
  → MemoryRepository · GraphRepository · ExecutorRepository
  → ExperimentRepository · ReportRepository
  → transaction(fn)
      db.transaction(tx => fn(createStore(tx, now)))
      — one transaction spanning every repository, because a claim and the
        evidence supporting it must commit together or not at all
```

Row mapping goes through `packages/persistence/src/row.ts`, which normalises the
two engines' differences (SQLite booleans as integers, JSON as text; Postgres
`jsonb` pre-parsed, `BIGINT` as a string) so repositories are written once.

---

## Claiming a unit of work

```text
TaskRepository.claim({ workerId, projectId, max, leaseMs, now })
  → build inner SELECT:
      status IN ('pending','queued')
      AND run_after <= ?
      AND NOT EXISTS (an incomplete dependency in task_dependencies)
      ORDER BY priority DESC, id ASC
      LIMIT ?
      + dialect.skipLocked            → "FOR UPDATE SKIP LOCKED" on Postgres
                                        → ""                     on SQLite
  → db.transaction:
      UPDATE tasks SET status='running', leased_by=<worker#token>,
             lease_expires_at=?, attempts=attempts+1
      WHERE id IN (<inner>)
      SELECT * FROM tasks WHERE leased_by=<token>
  → Task[]
```

The lease token (`worker-a#tsk_01J…`) is what identifies exactly the rows this
call claimed. Without it, two claims by the same worker in the same millisecond
would be indistinguishable.

Crash recovery:

```text
TaskRepository.reclaimExpiredLeases(now)
  → attempts >= max_attempts  → status='failed', error_code='lease_expired'
  → attempts <  max_attempts  → status='pending', lease cleared
```

---

## Appending an event

```text
SqlEventStore.append({ projectId, type, payload })
  → db.transaction:
      SELECT COALESCE(MAX(sequence),0)+1 FROM research_events WHERE project_id=?
      INSERT INTO research_events (…, sequence, …)
  → ResearchEvent
```

The sequence is assigned inside the insert's own transaction, which is what
makes it gapless — and gapless is what makes "I have up to 41" an unambiguous
resume point.

Streaming to a client:

```text
streamEvents(store, bus, { projectId, since })   packages/events/src/stream.ts
  1. bus.subscribe(...)        ← FIRST, buffering anything that arrives
  2. store.read(projectId, { since })   ← replay history, in batches
  3. drain the buffer, skipping any sequence the replay already covered
  → toServerSentEvent(event)   → "id: <sequence>\nevent: <type>\ndata: {…}\n\n"
```

Subscribing before replaying is why an event published *during* the replay is
buffered rather than lost; de-duplicating by sequence afterwards is why it is
not delivered twice.

**Verified.** No HTTP server consumes this yet.

---

## Making a model call

```text
ModelRouter.complete({ taskKind, messages, … })   packages/model-router/src/router.ts
  → route(options)
      ruleFor(rules, taskKind)                    packages/model-router/src/policy.ts
      filter candidates by required capabilities and context window
      prefer a provider != excludeProvider        ← independent verification
      move providers in breaker cooldown to the back
      → RouteDecision { chosen, fallbacks, independenceRequested, independent }

  → for each candidate, for each attempt:
      tracer.withSpan("model_call", …)            packages/observability/src/trace.ts
        provider.generate(request)
          → AnthropicProvider.generate()          .../anthropic-provider.ts
              lazy import("@anthropic-ai/sdk"), maxRetries: 0
              → messages.create(...)
              → toStopReason() · toProviderError()
              → computeCostUsd(usage, descriptor) packages/observability/src/metrics.ts
          or ScriptedModelProvider.generate()     .../scripted-provider.ts  (tests)
      on success → recordSuccess(provider); onModelCall(record); return
      on failure → recordFailure(provider); onModelCall(failed record)
                   retryable and attempts left? → clock.sleep(backoff) and retry
                   otherwise                     → next candidate
```

`onModelCall` is a callback, not a database write: the router is layer 3 and does
not know persistence exists. The composition root wires it to
`RunRepository.recordModelCall`.

Structured output:

```text
ModelRouter.structured({ schema, … })
  → complete(...) with "structured_output" added to the required capabilities
  → extractJsonObject(text)                       packages/shared/src/json.ts
      direct parse → fenced code block → first {…last }
  → schema.safeParse(candidate)
      ok       → { value, repairs }
      not ok   → append the assistant turn + a repair prompt naming the failed
                 fields, and call again (up to maxRepairAttempts)
      still not ok → throw validation_failed with a preview of the output
```

---

## Calling a tool

```text
ToolRegistry.call(toolId, input, context)         packages/tools/src/registry.ts
  1. route lookup            → unknown tool      → denied
  2. evaluateToolPermission(descriptor, policy)   packages/tools/src/permissions.ts
       tool id listed? capability allowed? risk within ceiling?
       filesystem capability with no granted root → denied
                                 → denied  → recorded, agent told no, run continues
  3. per-task call budget    → over maxCallsPerTask    → denied
  4. per-task concurrency    → over maxConcurrentCalls → denied
  5. tracer.withSpan("tool_call", …)
       Promise.race([ provider.execute(...), timeout ])
         ← a race, not just an abort: a tool that ignores its signal must not
           be able to wedge the run
       → LocalToolProvider.execute()               packages/tools/src/provider.ts
           tool.inputSchema.safeParse(input)       ← model output is untrusted
           → WebFetchTool.execute()                .../builtin/web-fetch.ts
               assertUrlAllowed(url, policy, id)   ← scheme, private address, host policy
               fetch(redirect: "manual")
               for each redirect hop:
                 assertUrlAllowed(location, …)     ← EVERY hop re-checked
               content-type gate → streamed read with a byte ceiling
               → { content, finalUrl, provenance{ url, retrievedAt, status,
                   contentType, contentHash, bytes } }
  6. onToolCall(report) — succeeded, failed, denied or timed_out, always
  → ToolOutcome
```

Denials are returned outcomes, not thrown errors: an agent asking for something
it may not have is ordinary traffic, and the run should continue.

---

## A research run, end to end

The path the vertical slice actually takes. Every arrow is code that runs.

```text
POST /api/v1/research/projects            apps/api/src/routes/projects.ts
  → CreateProjectRequest.parse()          contracts/src/api.ts
  → ProjectRepository.create()
  → SqlEventStore.append("research.project.created")

POST /api/v1/research/projects/:id/run
  → startRun()                            apps/api/src/routes/projects.ts
      hasRunnableWork() → resume, not replan      ← what makes a run continuable
      RunCoordinator.transition(planning → running)
      TaskRepository.create([plan.create])

Worker.tick()                             orchestration/src/worker.ts
  → reclaimExpiredLeases()                        ← crash recovery first
  → checkProjectBudget()                          ← before dispatch, not after
  → TaskRepository.claim({ leaseMs })
  → handler.handle(context)
      ├─ plan.create        research-core/src/handlers/planning.ts
      │    memory.recallLessons()          ← what worked before
      │    runs.transferableFailures()     ← what did not
      │    runAgent(researchDirector) → ModelRouter.structured()
      │    transaction: objectives + questions + hypotheses + plan
      │    → followUps: the planned task DAG
      │
      ├─ source.discover    .../handlers/discovery.ts
      │    tools.listAll() → a web_search tool, or BLOCKED
      │    ToolRegistry.call(searchTool)   ← permission, budget, audit
      │    → followUps: one source.ingest per URL
      │       and dependents of this task now depend on them too
      │
      ├─ source.ingest      .../handlers/evidence.ts
      │    IngestionPipeline.ingest()      ingestion/src/pipeline.ts
      │      ToolRegistry.call("web_fetch")
      │        → WebFetchTool: assertUrlAllowed on EVERY redirect hop
      │      parseByContentType() → text + section offsets
      │      chunkText() → offsets checked exact, every time
      │    deterministicQuality() → aggregateQuality()   evidence/src/
      │    ResearchRepository.upsertSource() (dedup by content hash)
      │    ResearchRepository.saveDocument(document, chunks)
      │
      ├─ evidence.extract   .../handlers/evidence.ts
      │    ChunkRetriever.retrieve()       retrieval/src/retriever.ts
      │      bm25Search() + cosine → reciprocalRankFusion()
      │    runAgent(evidenceAgent)
      │      a passageIndex out of range is dropped, not stored
      │    ResearchRepository.addEvidence()
      │
      ├─ claim.extract      .../handlers/claims.ts
      │    runAgent(claimExtractor)
      │      a claim whose every citation is invented is discarded
      │    transaction: addClaim() + linkEvidence()
      │
      ├─ verification.run   .../handlers/claims.ts
      │    verifyEvidence(evidence, chunks)   verification/src/verifier.ts
      │      checkCitationFidelity() → exact | elided | near | paraphrased | absent
      │      markEvidenceVerified()
      │    verifyClaim(...) → traceability, numeric, arithmetic, scope, consistency
      │    RunRepository.addVerificationChecks()
      │
      ├─ claim.score        .../handlers/claims.ts
      │    computeConfidence({ evidence, verification })   claims/src/confidence.ts
      │      evidenceWeight() → computeIndependence() → Beta posterior
      │    hasBlockingFailure() → insufficient_evidence, overriding the score
      │    deriveClaimStatus() → updateClaim()
      │
      ├─ contradiction.detect → detectContradictionCandidates() + severity
      ├─ critique.run         → runAgent(skeptic) → addFindings()
      │
      ├─ debate.run         research-core/src/handlers/debate.ts
      │    resolveSubject(): most severe open contradiction, else the most
      │      *uncertain* contested claim — the one an argument could move
      │    runDebate()                      research-core/src/debate.ts
      │      advocate ↔ skeptic, structured turns citing evidence by id
      │      judge routed away from the advocate's provider where one exists
      │    computeConfidence({ agentAgreement })   ← widens the interval,
      │                                              never moves the score
      │
      ├─ hypothesis.generate  → runAgent(hypothesisGenerator)
      │    plausibility band → a stated prior; never a model-asserted number
      │    every hypothesis carries falsification criteria, or is discarded
      │
      ├─ question.decompose   → runAgent(questionDecomposer)
      │    kind: "emergent", so a reader can tell what the evidence forced
      │    "unanswerable" is recorded, not queued
      │
      ├─ experiment.design    → runAgent(experimenter)
      │    status "ready" only where a runner can execute that runtime
      │
      ├─ experiment.run       → ExperimentRunner.execute() × repeats
      │    metricsMatch(baseline, run) as each finishes  ← marks replication
      │    runAgent(dataAnalyst) — skipped entirely when nothing succeeded
      │
      ├─ evolution.derive     → runAgent(evolutionAgent)
      │    emergent questions → projects.addQuestions()
      │    dead ends → runs.addFailure()   ← read by the NEXT run's planner
      │    next directions → memory.rememberLesson()
      │
      └─ report.generate    .../handlers/report.ts
           buildReportStructure()          research-core/src/report.ts
             reportableClaims()   ← a claim with no evidence never becomes a finding
             buildCitations()     ← only sources actually cited
             overallConfidence()  ← evidence-weighted, 0 when there are none
           runAgent(synthesizer)  ← prose only; it cannot add a finding
           assembleReport()       ← blocked work appended as limitations
           ReportRepository.save() (version N+1, never overwritten)

  → every agent call carries the run's budget pressure:
      Worker.tick() → checkProjectBudget().pressure
        → TaskContext.budgetPressure → AgentContext → ModelRouter.route()
          → decideAdaptiveTier()          model-router/src/adaptive.ts
             < 0.70  follow the policy
             ≥ 0.70  prefer best value per dollar
             ≥ 0.90  cheapest capable — the alternative is not finishing
             judgment · synthesis · verification: never downgraded
          → applyAdaptiveTier()  reorders; never filters, so every candidate
                                 remains a fallback

  → Worker.#applyOutcome()
      transaction: create followUps + addDependencies(dependents) + complete
  → SqlEventStore.append(...) → EventBus.publish()

GET /api/v1/research/projects/:id/evaluation
  → evaluateResearchProject()          research-core/src/evaluate.ts
      reads claims, evidence, links, sources, contradictions, findings,
      checks, report, tasks, experiment replication
  → evaluateProject()                  evaluation/src/rubric.ts  (pure)
      8 weighted dimensions; inapplicable ones excluded, not zeroed
      blockers invalidate rather than lower the score
  → { grade, overall, dimensions, weaknesses, blockers, caveats }

GET /api/v1/research/projects/:id/events/stream
  → streamEvents(store, bus, { since })   events/src/stream.ts
      subscribe FIRST, replay, then drain the buffer skipping replayed sequences
  → toServerSentEvent() → "id: <sequence>\nevent: <type>\ndata: {…}"
```

## Composition

```text
apps/api/src/main.ts                 apps/worker/src/main.ts
  loadConfig()                         loadRuntimeConfig()
    ↓ extends                              ↓
  loadRuntimeConfig()  ←──────────────────┘   research-core/src/runtime.ts
  buildRuntime(config) ←──────────────────┐
    createDatabase() · migrate()          │  the same assembly for both
    ModelRouter(providers, onModelCall)   │  processes, so two of them cannot
    ToolRegistry(local + executor)        │  be wired to different databases
    createResearchEngine(...)             │
    engine.capabilityGaps()  ← surfaced on /health
  createServer(context)                  │
  engine.createWorker().run() ───────────┘
```

## Where an external system attaches

```text
An application (any caller)
  → @research-os/sdk  →  /api/v1  →  the engine
     types from @research-os/contracts, the same the server validates against

A capability layer (ToolOS, or anything else)
  → implements ToolProvider          tools/src/provider.ts
       listCapabilities · execute · healthCheck
  → ToolRegistry routes to it, applying permission, budget and audit first

An execution host (Echo, or anything else)
  → POST /api/v1/executors            registers capabilities, receives a token
  → POST /api/v1/executors/claim      long-polls for work it can do
  → POST /api/v1/executors/requests/:id/result
       → validated, then the parked task resumes
```

Neither side imports the other. `scripts/lint-architecture.mjs` fails the build
if a product name ever appears in the reusable core — a rule that has already
caught its own author naming a test fixture `EchoTool`.
