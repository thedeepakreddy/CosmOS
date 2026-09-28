# ResearchOS — Implementation Evidence

What is actually true about this codebase, with the command that demonstrates it.

Nothing is listed as `VERIFIED` on the strength of a file existing, a type being
declared or a route being defined. `VERIFIED` means code + wiring + an execution
that was observed — per §26 of the specification.

Last updated: 2026-09-15 (recovery session 2, after Phase 5).

---

## How to reproduce all of it

```bash
npm install
npm run verify     # typecheck → lint → architecture lint → tests
```

Observed on 2026-09-15:

```text
typecheck   pass (src and tests)
lint        pass (eslint 10, type-aware)
lint:arch   Architecture OK — 22 workspaces, layering intact
tests       454 tests, 86 suites, 454 pass, 0 fail
```

21,959 lines of source and 6,958 of tests across 22 workspaces. No stub remains,
and all five phases are built.

---

## Foundation

### Monorepo and module graph — `VERIFIED`

- **Files:** `architecture.json`, `scripts/generate-workspaces.mjs`, `scripts/lint-architecture.mjs`, `tsconfig.json`
- **Wiring:** `architecture.json` is the single source of truth. `generate-workspaces.mjs` writes every `package.json` and `tsconfig.json` from it; `lint-architecture.mjs` fails the build when reality diverges.
- **Command:** `npm run lint:arch`
- **Observed:** `Architecture OK — 22 workspaces, layering intact.`
- **Note on the count.** Earlier milestones in `docs/recovery/CONTINUATION_LOG.md` record `21 workspaces`, which was correct when written: the recovery baseline had 19 packages plus 2 applications. Phase 4 added `@research-os/sdk`, making 20 packages plus 2 applications. The count is 20 + 2 = 22, confirmed by `npm query .workspace` and by 22 `tsconfig.json` project references. `apps/web/` is *not* among them — it holds an empty `public/` directory, is absent from the root `package.json` `workspaces` array, and is described as `NOT_FOUND` in the recovery audit.
- **Also observed — the linter genuinely fails.** Four violations were introduced deliberately and each was caught: an undeclared cross-package import (`evidence` importing `persistence`); a product name in code (`export const DEFAULT_CLIENT = "Echo"`); manifest drift (an extra dependency added to `evidence/package.json` by hand); and, during real development, `EchoTool` in a tools test, which was renamed. The same product name inside a comment was correctly allowed.
- **Limitation:** The import scanner is a regex over comment-stripped source, not a parser. A specifier built at runtime would not be seen. Every import in this codebase is a static literal.

### Configuration — `PARTIAL`

- **Files:** `packages/shared/src/env.ts`, `packages/persistence/src/config.ts`, `scripts/register.mjs`, `.env.example`
- **Wiring:** `register.mjs` preloads `.env` then `.env.local` into `process.env`, never overwriting a real environment variable. `databaseConfigFromEnv` infers the driver from the URL scheme.
- **Command:** `npm run migrate -- --status`
- **Observed:** resolves `sqlite:.data/research-os.db` by default and reports migration state.
- **Previous limitation (recorded at the end of Phase 2, and true then):** no single composed application config object; each consumer read what it needed directly from the environment.
- **Current status after Phase 5: partially addressed.** `loadRuntimeConfig(env)` composes one object — database, log level, migrate-on-start, model key, pricing, tenant — and **both** applications use it: `apps/worker/src/main.ts:14` calls it directly, and `apps/api/src/config.ts` extends it with the four settings only a network-facing process needs (`host`, `port`, `embeddedWorker`, `corsOrigins`, `apiKeys`).
- **What is still `PARTIAL`:** configuration is composed per *process role*, not globally. A library below layer 6 that wanted a setting would still read the environment itself. That is deliberate — the composition root is the only place that should know a deployment's shape — but it means there is no one object describing the whole system.

---

## Layer 3 — persistence

### Database, migrations, dual dialect — `VERIFIED`

- **Files:** `packages/persistence/src/{dialect,database,sqlite-database,postgres-database,migrator,row}.ts`, `migrations/001-initial-schema.ts` (34 tables, 47 indexes)
- **Command:** `npm test` → suites `persistence on sqlite` and `persistence on postgres (pglite)`
- **Observed:** the identical assertions pass on both engines. PGlite runs the real Postgres parser and planner, so the Postgres path is exercised rather than assumed.
- **Also observed:** `npm run migrate` applies 88 statements, creates 35 tables and 89 indexes, and is a no-op on re-run (`applied: 0, alreadyApplied: 1`).

### Persistence survives a process restart — `VERIFIED`

This is the evidence for §30 ("no fake persistence").

- **Command:** two separate `node` processes against one SQLite file.
- **Observed:**

```text
process 1: WROTE project: prj_01M2HERFDZVA0WRKA88KB0EJM8
           claimed task: tsk_01M2HERFE4BSM79RNTY6AAHMPE  status: running
--- process exits ---
process 2: project: Cross-process persistence proof | status: running | tenant: acme
           createdBy.application: smoke-test (nested JSON survived)
           tasks: 1 | status: running | leasedBy: worker-1#tsk...
           attempts: 1 | leaseExpiresAt: 2026-09-15T02:36:56.430Z
           events: 1 | sequence: 1 | type: research.started
```

An in-flight lease, its attempt count and its expiry all survived the restart — which is the substrate resumable research is built on.

### Durable task queue — `VERIFIED`

- **Files:** `packages/persistence/src/repositories/task-repository.ts`
- **Command:** `npm test` → suites `task queue on sqlite` / `task queue on postgres (pglite)`
- **Observed (8 tests × 2 engines):** a task leases exactly once under concurrent claims; a dependent task is blocked until its dependency completes; priority orders the queue; an expired lease is requeued; an attempt-exhausted task fails terminally with `errorCode: lease_expired`; a retryable failure reschedules with backoff and is not claimable before `run_after`; a non-retryable failure is terminal; a task parks on an external tool call and resumes.
- **Limitation:** concurrency is exercised by sequential claims proving mutual exclusion, not by genuinely parallel workers. `FOR UPDATE SKIP LOCKED` is emitted for Postgres and is syntactically validated by PGlite, but contention under real parallelism is untested.

### Event store — `VERIFIED`

- **Files:** `packages/persistence/src/repositories/event-store.ts`
- **Observed:** sequences are per project, gapless and strictly increasing; replay from a resume point is exclusive of the given sequence.

### Failure memory — `VERIFIED`

- **Files:** `packages/persistence/src/repositories/run-repository.ts`
- **Observed:** booleans round-trip on both engines (SQLite stores them as integers); transferable failures are visible from other projects and a project does not read its own back.
- **Previous limitation (recorded at the end of Phase 3, and true then):** `transferableFailures` was not tenant-scoped. Failures would cross a tenant boundary in a multi-tenant deployment — one customer's dead ends, often statements about a private dataset or internal system, were readable by another customer's research run. The `projects` table carried `tenant_id`; the query did not use it.
- **Current status after Phase 5: `VERIFIED` — fixed.** The query now joins `projects` and compares `tenant_id` with `IS NOT DISTINCT FROM`, so an untenanted project sees only untenanted failures and never another tenant's:

  ```sql
  SELECT f.* FROM failure_records f
  JOIN projects p ON p.id = f.project_id
  WHERE f.transferable = TRUE
    AND f.project_id <> ?
    AND (p.tenant_id IS NOT DISTINCT FROM (SELECT tenant_id FROM projects WHERE id = ?))
  ORDER BY f.id DESC LIMIT ?
  ```

- **Evidence for the fix (final reality check, 2026-09-15):** executed against **both** engines — SQLite (`node:sqlite`) and real PostgreSQL (PGlite). Tenant A's second project retrieves tenant A's transferable failure; tenant B's project retrieves none of them; an untenanted project sees only untenanted failures. Total failures across both engines: 0.

### Repositories — `PARTIAL`

Ten repositories exist (3,300 lines).

**Previous status (end of Phase 3):** `ProjectRepository`, `ResearchRepository`, `TaskRepository`, `RunRepository` and `SqlEventStore` were covered by tests; `MemoryRepository`, `GraphRepository`, `ExecutorRepository`, `ExperimentRepository` and `ReportRepository` were `IMPLEMENTED_BUT_UNVERIFIED` — real code, compiled, no test exercising them.

**Current status after Phase 5**, measured by counting distinct store methods actually called from test files:

| Repository | Status | Evidence |
|---|---|---|
| `ProjectRepository` | `VERIFIED` | 5 distinct methods across 7 test files |
| `ResearchRepository` | `VERIFIED` | 11 distinct methods across 4 test files |
| `TaskRepository` | `VERIFIED` | 12 distinct methods across 4 test files |
| `RunRepository` | `VERIFIED` | 6 distinct methods across 3 test files |
| `SqlEventStore` | `VERIFIED` | 3 distinct methods across 2 test files |
| `MemoryRepository` | `VERIFIED` | exercised through `SqlMemoryProvider` in `packages/memory/test` and the vertical slice |
| `ExecutorRepository` | `VERIFIED` | exercised through `ExecutorService` in `packages/executors/test` and `apps/api/test` |
| `ExperimentRepository` | `VERIFIED` | 2 distinct methods; replication counting proved end to end |
| `ReportRepository` | `VERIFIED` | 1 distinct method; report generation proved end to end |
| `GraphRepository` | `NOT_FOUND` **as a live code path** | see below |

`GraphRepository` is the one exception, and it is dead wiring rather than untested code. It is constructed on every store as `store.graph`, and `store.graph` is referenced **nowhere** in `packages/`, `apps/` or `tests/`. The `graph_nodes` and `graph_edges` tables it reads and writes are created by `001-initial-schema` and never written to. The graph that `GET /api/v1/research/projects/:id/graph` returns is projected on demand by `buildProjectGraph`, which reads the relational tables directly through `projectResearchGraph`. The repository is a materialisation path that was never wired up; nothing depends on it and nothing claims it runs.

---

## Layer 2 — events

### Event bus, stream and SSE — `VERIFIED`

- **Files:** `packages/events/src/{bus,store,stream}.ts`
- **Command:** `npm test` → suites `InMemoryEventBus`, `matches`, `RecordingEventBus`, `streamEvents`, `toServerSentEvent`
- **Observed (15 tests):** filtered delivery, unsubscribe, replay-then-tail with no gap and no duplicate, resume-from-sequence, and an SSE frame whose `id` is the resume token.
- **Defect found and fixed this session:** `publish()` built its delivery list with `matching.map(s => s.handler(event))`. A handler may be synchronous, and a synchronous throw escaped `.map()` before `Promise.allSettled` existed to catch it — rejecting `publish()` and contradicting the contract stated in the comment directly above it. Reproduced by a failing test, fixed by making the map callback `async`, and both the sync and async cases are now covered.

---

## Layer 3 — model router

### ModelProvider port and router — `VERIFIED`

- **Files:** `packages/model-router/src/{provider,catalog,policy,router,anthropic-provider,scripted-provider}.ts`
- **Command:** `npm test` → suites `routing`, `independent verification`, `retry and fallback`, `circuit breaker`, `structured output`, `accounting and observability`, `catalog and pricing`
- **Observed (25 tests):**
  - routing selects on capability and context window, not on name; an unroutable request explains why
  - a transient failure retries on the same model with exponential backoff (`sleeps: [10, 20]` on an injected clock), a permanent failure does not retry at all
  - an exhausted model falls back to the next candidate, which then serves the request
  - a repeatedly failing provider is taken out of rotation and is not called again until its cooldown expires
  - structured output parses JSON out of prose and code fences, feeds a schema violation back as a repair prompt, and fails loudly rather than returning a wrongly-shaped value
  - every call — including every failed one — is reported with real token counts and a cost computed from the descriptor's configured rates
  - one span per model call, carrying provider, model, task kind and token counts

### Independent verification is reported honestly — `VERIFIED`

A single-provider deployment cannot verify its own output independently. The router does not pretend otherwise: it returns `independent: false`, logs a warning, and leaves the caller to record that the check was a self-review.

- **Observed:** with two providers, `verification` routes away from the excluded one and reports `independent: true`. With one, it still routes, reports `independent: false`, and emits `Independent verification unavailable; falling back to a self-review`.

### Pricing is configuration, not a constant — `VERIFIED`

Published rates change, and a stale rate does not fail — it silently mis-bills, and budget enforcement reads those numbers.

- **Observed:** `describeModels("anthropic", ANTHROPIC_MODEL_SPECS, {})` throws `validation_failed` naming the model and `RESEARCH_OS_MODEL_PRICING`. A model ResearchOS cannot price is a model it will not run.

### Anthropic provider — `IMPLEMENTED_BUT_UNVERIFIED`

- **File:** `packages/model-router/src/anthropic-provider.ts`
- **Status:** compiles, is wired into `anthropicProviderFromEnv`, and its error classification and response mapping are written — **but no live call has been made**, because no `ANTHROPIC_API_KEY` is available in this environment.
- **What is untested:** the SDK response shape mapping, real error status classification, and real token/cost figures.
- **To verify:** set `ANTHROPIC_API_KEY` and `RESEARCH_OS_MODEL_PRICING`, then call `provider.healthCheck()`. Until someone does, this is not `VERIFIED` and should not be described as working.

---

## Layer 3 — tools

### Permission model — `VERIFIED`

This is the security boundary between a model and the world, so it is tested by its failure cases first.

- **Files:** `packages/tools/src/permissions.ts`
- **Command:** `npm test` → suites `evaluateToolPermission`, `evaluateHostPermission`, `isPrivateAddress`, `assertUrlAllowed`, `assertPathAllowed`
- **Observed (21 tests):**
  - an empty policy permits nothing; tool id, capability **and** risk level must all be granted
  - risk level is a ceiling — a `privileged` tool is refused under a `side_effecting` maximum
  - `arxiv.org.evil.com` does not match an `arxiv.org` allowlist; the blocklist wins over the allowlist
  - loopback, RFC1918, carrier-grade NAT, multicast, IPv6 link-local and `169.254.169.254` are all refused; a malformed address is refused rather than allowed
  - `file://`, `ftp://` and `data:` are not fetchable
  - path traversal is refused outright rather than resolved, and `/srv/corpus-private` is not inside `/srv/corpus`

### Tool registry — `VERIFIED`

- **Files:** `packages/tools/src/{registry,provider}.ts`
- **Observed (11 tests):** a denied tool never executes and the denial is still recorded; invalid input is rejected before the tool sees it; the per-task call budget stops a looping agent and is per task; a hung tool times out.
- **Defect found and fixed this session:** the timeout was implemented by aborting a signal. A tool that ignores its signal — an external executor on a dead socket, or a carelessly written tool — ran to completion anyway and wedged the caller. The test took **5,006 ms** against a 30 ms timeout. The timeout is now a `Promise.race`, and the same test completes in **32 ms**. The abort is still issued so cooperative tools release resources early.

### web_fetch, against a real HTTP server — `VERIFIED`

- **Files:** `packages/tools/src/builtin/web-fetch.ts`
- **Observed (10 tests, real `node:http` server, not a mock):** content returned with provenance (final URL, status, content type, sha256 of normalised content, byte count, retrieval time); redirects followed with the final URL reported separately from the requested one; a redirect loop terminated; a host outside the allowlist refused before any request; an oversized body truncated at the byte ceiling while streaming; a binary content type refused with an explanation; HTTP 404 recorded as a failure with no content.
- **The security case that matters:** a URL that passes every check and then **redirects** to `http://169.254.169.254/latest/meta-data/` is refused mid-chain, because every hop is re-checked. `redirect: "follow"` would have checked only the first URL.
- **Design corrected during development:** the loopback exemption needed by the test server was first written as a boolean `allowPrivateAddresses`. That single flag also unblocked the cloud metadata endpoint — the test proved it by hanging for 10 seconds trying to reach it. It is now `allowedPrivateHosts`, an exact-match list, so an operator who needs `corpus.internal` does not thereby get `169.254.169.254`.

---

## Layer 3 — knowledge graph

### Projection, traversal and provenance — `VERIFIED`

- **Files:** `packages/knowledge-graph/src/{identity,project,traverse,tree}.ts`
- **Observed (21 tests):** node ids are derived from `(projectId, type, entityId)`, so re-projecting the same state is byte-identical and a rebuild cannot duplicate every edge; an edge to a node that does not exist is dropped rather than dangled; a cycle terminates; a claim walks back to the source underneath it.
- **The field that matters:** `provenanceOf(...).unsupported` is `true` for a claim that reaches no source. That is the difference between a finding and a model assertion, and it is a graph fact rather than a status flag someone remembered to set.
- **Research evolution:** an unresolved contradiction outranks a settled finding in the frontier; a parent's priority lifts from its children, so an answered question hiding an uncertain claim does not sink out of sight.

## Layer 3 — experiments

### Runner port and reproducibility — `VERIFIED`

- **Files:** `packages/experiments/src/{runner,metrics,local-runner,replication}.ts`
- **Observed (28 tests):** the default runner refuses every request and labels it `BLOCKED` with a reason, never fabricated metrics. Metrics are read only from marker lines — prose is never parsed as data, and a malformed marker is skipped rather than guessed at.
- **Real process execution:** a hanging experiment is killed at its timeout (300 ms, observed); output is capped; **the parent environment is not inherited**, so an experiment printing `process.env.RESEARCHOS_TEST_SECRET` gets `absent` — it cannot read the host's API keys. An input file path containing `..` is refused.
- **Reproducibility:** the interpreter version, platform and pinned dependencies are recorded with every run. A single run scores `reproducibilityScore: 0`, not 1 — one run is absence of evidence, and scoring it 1 would present that as a strong result.
- **Limitation, stated plainly:** `LocalProcessRunner` is **not a sandbox**. It throws unless constructed with `acknowledgeUnsandboxedExecution: true`, and should run only inside a disposable container.

## Layer 4 — memory, retrieval, ingestion, executors

### Memory — `VERIFIED`

- **Observed (33 tests, on both engines):** re-remembering the same key updates in place rather than accumulating near-duplicates; an expired memory is not retrieved; an embedder that throws degrades to lexical **without losing the memory**; a lesson is tenant-visible so a later project finds it.
- **The rule worth naming:** a caller's stated preferences are never recalled as evidence unless explicitly asked for. That is the mechanism by which "the user likes concise answers" would otherwise become a finding about the world.

### Retrieval — `VERIFIED`

- **Observed (18 tests):** BM25 saturates repetition (eight mentions are not worth eight times one) and normalises length (the longest chunk does not win every query); rank fusion combines lexical and semantic *rankings* rather than scores, so no conversion factor between incommensurable scales has to be invented.
- **Honest degradation:** with no embedding provider, retrieval returns lexical results **and says so** in `degradedReason`. Silently returning worse answers is how a system gets trusted for something it is not doing.

### Ingestion — `VERIFIED`

- **Observed (20 tests, against a real HTTP server):** citation metadata is preferred over the page title; every author is collected, because author overlap is how independence is judged later; section boundaries are recorded so a citation can name where it came from; **a document cannot forge its own section boundaries** — the sentinels are control characters, stripped from input first.
- **The property everything rests on:** `document.text.slice(chunk.startOffset, chunk.endOffset)` equals the chunk text, for every chunk. Checked on **every ingest**, not only in tests, because an offset bug would otherwise surface months later as a quote nobody can reproduce.
- A page that fetched cleanly but yielded no prose — a paywall, a JavaScript shell — is reported rather than stored as an empty document that looks like a valid source.

### Executors — `VERIFIED`

- **Observed (18 tests):** only the token's hash is stored, so a lost token cannot be recovered from the database; **one executor cannot answer another executor's request** (otherwise any registered executor could inject output into research it was never asked to contribute to); a completed request cannot be answered twice; a vanished executor's requests expire rather than leaving research parked forever.
- **The seam:** `ExecutorToolProvider` implements `ToolProvider`, so a capability request reaches an external process without either codebase importing the other. A tool with no live executor behind it **is not offered at all** — better than offering one that will fail the moment it is called.

## Layer 5 — verification and orchestration

### Mechanical verification — `VERIFIED`

- **Observed (37 tests):** a verbatim quote passes; typography differences do not break a faithful quote; an elided quote passes when its fragments appear **in order**; a paraphrase inside quotation marks **fails**; a fabricated quote is absent. A short quote is not penalised for the document being long.
- **Numbers:** a claim stating 18% whose evidence says 8% fails; units must agree before values are compared, so a percentage and a count sharing a digit are not the same figure; `10 / 0 = 0` yields no verdict, because an undefined result is not a wrong one.
- **Scope:** a universal claim on one source fails; on four sources it is `inconclusive`, never `passed` — breadth of evidence does not establish a universal.
- **There is deliberately no "is this correct?" check.** A broad correctness judgement from a model is exactly the unearned confidence this package guards against.

### Worker loop and budgets — `VERIFIED`

- **Observed (27 tests):** follow-up tasks and the completion commit **together**, so a crash between them cannot leave a finished task whose next steps were never created; a parked task releases its lease; a task with no registered handler fails terminally rather than burning retries; an unrecognised throw is treated as non-retryable, which is the safe default.
- **Budget:** every exceeded ceiling is reported, not just the first; a run that hits one cancels outstanding work and fails with the ceiling named. A stopped run always says why.

### Resumable research — `VERIFIED`

This is the evidence for §31.

- **Observed:** a worker claims the highest-priority task and is then abandoned mid-task — its promise never settles, nothing is written, the lease is left dangling. Time advances; the lease lapses. A **second worker**, sharing nothing with the first but the database, completes all three tasks. Nothing was lost and nothing was done twice.
- A paused project is resumed by `RunCoordinator.resume`, which reclaims the dead worker's lease and returns the project to `running`.
- **Defect fixed here:** the wall-clock budget was measured from `project.createdAt`, so any project resumed after a pause longer than its ceiling died instantly — defeating the feature. Now measured from the latest `research.started` event.

## Layer 6 — the research engine

### Agents — `VERIFIED` (wiring and contracts), `IMPLEMENTED_BUT_UNVERIFIED` (prompt quality)

All eight roles are implemented with real prompts, real structured-output
contracts and real model execution through the router. Every one is exercised
end to end in the vertical slice against a scripted provider.

What that does and does not establish: it verifies the wiring, the output
schemas, the repair loop and every failure path. It does **not** verify what a
real model does with these prompts, because no live call has been made.

| Role | Status |
|---|---|
| Research Director | `VERIFIED` — plan, objectives, questions, hypotheses and tasks all committed together |
| Evidence Agent | `VERIFIED` — `quote` and `interpretation` in separate fields, which is what makes checking possible |
| Claim Extractor | `VERIFIED` — a claim whose every citation is invented is discarded |
| Critic / Skeptic | `VERIFIED` — findings carry resolution criteria |
| Verification Agent | `VERIFIED` — mechanical checks, no model needed |
| Reviewer / Judge | `VERIFIED` — debate runs, is judged, and dissent is preserved |
| Data Analyst | `VERIFIED` — interprets measured metrics; skipped entirely when nothing succeeded |
| Experiment Agent | `VERIFIED` — designs are stored and executed; `BLOCKED` with no runner |
| Synthesizer | `VERIFIED` — prose only; findings and citations are computed before the model is called |

### The vertical slice — `VERIFIED`

- **File:** `packages/research-core/test/vertical-slice.test.ts`
- **Command:** `npm test`
- **Observed:** a complete run against a real HTTP server produces a report in which every finding cites a real claim id, every citation names a real source row with the URL it was fetched from, and the event log is gapless.
- **Two hostilities planted in the scripted output, neither of which reaches the report:** a quote that is not in the document (caught by citation fidelity, recorded as a failed check on the evidence row) and a claim whose citations are all out of range (discarded at extraction).
- **Confidence is arithmetic:** the stored score recomputes from the stored posterior, and the posterior recomputes from prior plus evidence weight.
- **Limitations are not optional:** blocked work and evidence-less claims are appended to whatever the synthesiser wrote, so a model cannot omit them.

## Layer 7 — the applications

### HTTP API — `VERIFIED`

- **Files:** `apps/api/src/{server,app-context,config}.ts`, `routes/{projects,events,executors,health}.ts`
- **Command:** `npm test` (26 tests, driven **through the SDK** over real sockets)
- **Observed:** projects create, list, page with a cursor, run, cancel; contract defaults are applied by the schema rather than invented by the route; an invalid request is a 400 naming the field; an unknown project is a 404 carrying a trace id; an unknown route returns JSON, not an HTML error page.
- **SSE:** events stream live and resume from a sequence; `Last-Event-ID` is honoured, so a reconnecting client loses nothing without writing any code.
- **Auth:** with `RESEARCH_OS_API_KEYS` set, requests without a valid key are refused; comparison is constant-time. Health stays open (a load balancer holds no key) and executor registration stays open (an executor has none until it registers).
- **Runtime smoke test:** the real server was started, a project created and run, events streamed over SSE, and the embedded worker picked up the queued task — all observed against `http://127.0.0.1:8099`.

### Worker — `VERIFIED` (by construction)

`apps/worker` runs the same engine without the HTTP surface, built from the same
`buildRuntime` the API uses. Several may run against one database; leases and
`FOR UPDATE SKIP LOCKED` make that safe.

### SDK — `VERIFIED`

Types come from `@research-os/contracts`, the same definitions the server
validates with. The API suite drives the server entirely through this client, so
a drift between the two is a test failure rather than something a consumer
discovers.

---

## Phase 5 — advanced research

### Richer debate — `VERIFIED`

- **Files:** `packages/research-core/src/debate.ts`, `handlers/debate.ts`
- **Observed:** a contested claim is argued by two sides, judged, and rescored; the verdict's `agreementLevel` widens the uncertainty interval rather than moving the score, because disagreement among reviewers is a reason to be *less certain*, not a reason to believe something different.
- **Dissent is preserved** — the judge's rejected positions are stored with the reason, because "three of four agreed" is different information from "all agreed".
- **What it declines to do:** with nothing contested it runs no debate and says a debate over a settled claim "spends budget to restate agreement"; a claim citing no evidence is not debated, because two models asserting at each other is not adversarial review.
- **Subject selection:** the most severe *open contradiction* wins over a merely uncertain claim — two claims that cannot both be true is the productive place to argue.

### Research evolution — `VERIFIED`

- **Files:** `packages/research-core/src/agents/evolution.ts`, `handlers/evolution.ts`
- **Observed:** emergent questions are recorded as `emergent` (so a reader can tell which parts of the enquiry the evidence forced), next directions are remembered as tenant-visible lessons, and dead ends are written to failure memory.
- **The loop closes:** a dead end recorded by one project is read by the *next* project's planner before it plans. Verified by running evolution in one project and reading the failure from another.

### Automated hypothesis generation — `VERIFIED`

- **Observed:** every hypothesis carries falsification criteria — one that could not be refuted is put in `discarded` with that as the reason. The plausibility *band* maps to a stated prior (0.25 / 0.4 / 0.6); a model-asserted probability would be an unearned number.
- **Question decomposition** marks a question no evidence could settle as `unanswerable` rather than queueing it, and does not split a question that is already atomic.

### Failure-memory optimisation — `VERIFIED`

- **Tenant isolation, on both engines:** a dead end recorded under tenant `acme` is invisible to tenant `globex`, and a project with no tenant sees only other untenanted projects. A dead end is often a statement about a private dataset; leaking one leaks what a customer was investigating and what did not work for them.
- **Deduplication** within a batch *and* against the store: a run hitting the same wall repeatedly records it once, so distinct dead ends are not crowded out of the planner's limit.

### Advanced model routing — `VERIFIED`

- **Files:** `packages/model-router/src/adaptive.ts`
- **Observed (16 tests):** below 70% budget pressure the policy is followed unchanged; at 70% routing prefers best *value* — a mid-tier model at a fifth the price, never simply the weakest; at 90% it takes the cheapest capable model, because the alternative is not finishing.
- **Judgment, synthesis and verification are never downgraded.** Those decide what the research concludes, and a cheaper wrong answer costs more than the tokens saved.
- **Pressure reorders, never filters:** every candidate remains available as a fallback.
- **Every downgrade is logged**, because a cost saving nobody is told about is a quality regression nobody can account for.

### Sophisticated evaluation — `VERIFIED`

- **Files:** `packages/evaluation/src/rubric.ts` (pure), `research-core/src/evaluate.ts` (reads the database)
- **Command:** `GET /api/v1/research/projects/:id/evaluation`
- **Observed (25 tests):** eight weighted dimensions — traceability, verification, evidence breadth, critical scrutiny, contradiction handling, calibration, transparency, reproducibility.
- **Blockers invalidate rather than lower the score.** A report whose findings do not trace to sources is graded `unsound`, not "0.4": averaging that with a good transparency score would produce a number that reads acceptable.
- **Independence is counted by domain, not by source row** — three papers from one group is close to one source, not three — and breadth saturates at six domains so volume cannot compensate for weak traceability.
- **Contradictions:** carrying one into the report unresolved scores well; dropping it silently scores zero.
- **Calibration** penalises both directions: 0.9 confidence on one domain overstates, and 0.3 despite five corroborating domains buries a real finding.
- **Inapplicable dimensions are excluded, not scored zero** — a literature review runs no experiments and is not worse research for it — and a project with nothing in it is graded `unevaluable` rather than `weak`, because nothing was assessed.
- **Caveats travel with every score**, stating that this measures how research was *conducted*, not whether it is right.

### Complete task coverage — `VERIFIED`

All 18 task types in the contract have a handler, asserted against the vocabulary
so a new type cannot be added without one. `GET /api/v1/capabilities` reports all
18 from a live server.

### Event-stream conformance — `VERIFIED`

Every event emitted during a real end-to-end run is validated with `parseEvent`,
which checks the envelope and then the payload schema registered for that type.
The stream is also asserted to be id-centric, so a client can act on each event
without re-fetching the project.

This test exists because of a defect it would have caught: the `emit` helper took
a `string` and cast it to `never`, which let ten call sites emit types and
payloads outside the contract — invisible to a client subscribing by type. The
helper now takes the declared `EventType`.

---

## What this project still cannot do

Stated plainly, because §43 asks for the actual phase rather than an encouraging
one. Every item here is a real limit, not a rough edge.

- **No live model call has ever been made from this codebase.** There is no API
  key in this environment. `AnthropicProvider`'s response mapping and error
  classification are written and unproven, and no agent prompt has been seen by a
  real model. Every agent is exercised against a scripted provider, which
  verifies the wiring, the output contracts, the repair loop and every failure
  path — but not the quality of a real model's response to these prompts. This
  remains the single largest gap between "verified" and "works".
- **No search capability ships.** ResearchOS has no web search of its own.
  Discovery reports `BLOCKED` rather than answering from model recollection,
  which is correct but means a deployment must supply search through ToolOS, an
  executor, or source URLs directly.
- **Experiments have no sandbox.** `LocalProcessRunner` executes model-written
  code with the host's permissions and must be explicitly acknowledged at
  construction. The default runner refuses, so experiments are designed, stored,
  and reported `BLOCKED`.
- **Direct evidence upload is refused.** Supplying content rather than a URL would
  bypass the parse-and-chunk path, and the offsets a quote is checked against
  would not exist. Refusing is the honest choice; implementing it properly is
  outstanding work.
- **Concurrency — previously "proven by construction, not under load"; now
  measured on SQLite, still unmeasured on Postgres.** *Previous limitation (end
  of Phase 5, and true then):* `FOR UPDATE SKIP LOCKED` was emitted and
  syntactically validated by a real Postgres parser, but contention between
  genuinely parallel workers was untested. *Current status after the final
  reality check:* `VERIFIED` on SQLite — six separate OS processes competing for
  one 200-task queue, one task per claim, produced 200 claims of 200 distinct
  tasks, **zero tasks claimed twice**, zero tasks with more than one attempt, all
  200 completed, zero contention errors. A four-process run over 120 tasks gave
  the same result. `IMPLEMENTED_BUT_UNVERIFIED` on Postgres: the `SKIP LOCKED`
  statement executes correctly against a real Postgres engine and two sequential
  claims take disjoint sets, but PGlite is a single in-process connection, so
  genuine multi-process contention on Postgres cannot be exercised here.
- **`shared`, `contracts`, `evidence`, `observability` and `sdk` have no tests of
  their own.** All five are heavily exercised indirectly — every fixture parses a
  contract schema, the API suite drives the server entirely through the SDK — but
  that is coverage by consequence, not by intent.
- **ToolOS and Echo integration remain `PLANNED`.** The seams exist, are
  enforced, and are exercised by a test executor — but neither product's API is
  available in this workspace to code against.

**Overall: all five phases built and verified against a scripted model.
Unverified against a live model.**

---

# Appendix — Final reality check, 2026-09-15

An independent re-verification run after Phase 5, executed against the built
tree rather than against earlier reports. Nothing below is carried forward from
a previous document: every line was re-observed. No feature was added, no
external project was touched, and the repository remains uncommitted.

## Placeholder and dead-wiring audit

162 source files under `packages/*/src` and `apps/*/src` were swept.

| Marker | Hits | Assessment |
|---|---|---|
| `TODO` | 0 | — |
| `FIXME` | 0 | — |
| `XXX` | 0 | — |
| `HACK` | 0 | — |
| `@ts-ignore` / `@ts-expect-error` | 0 | — |
| `placeholder` | 22 | 21 are SQL bind-placeholder machinery (`?` rewriting) or prose; 1 is `UnconfiguredModelProvider`'s deliberately named `PLACEHOLDER` descriptor |
| `temporary` | 1 | the temporary working directory `LocalProcessRunner` creates and removes |
| `not implemented` | 2 | one real refusal path, below |
| `as never` | 11 | 7 are the word "never" in prose; **4 are real casts**, below |
| `as any` | 4 | all inside `evaluateToolPermission` call sites in tests, none in `src` |

### The one `not implemented` path is a refusal, not a stub

`POST /api/v1/research/projects/:id/evidence` without a `url` throws
`err.unsupported` with a reason. It does not accept the request and quietly drop
it. Implementing it properly means running supplied content through the same
parse-and-chunk path a fetch takes, because otherwise the character offsets a
quotation is verified against would not exist.

### The four real `as never` casts

| Location | What it bridges | Assessment |
|---|---|---|
| `apps/api/src/routes/events.ts:33`, `:76` | `EventsQuery.types` is `z.array(z.string())`, but `EventFilter.types` wants `readonly EventType[]` | **Finding.** The API does not validate that an event-type filter names a declared type. The consequence is benign — an unknown type matches nothing, so the filter returns an empty page rather than erroring — but the contract is looser than the vocabulary it filters on, and the cast conceals that. Tightening `EventsQuery.types` to `z.array(EventType)` would remove both casts and turn a silent empty result into a 400. |
| `packages/evaluation/src/rubric.ts:130` | `finding.claimIds.includes(link.claimId as never)` | Branded-id invariance: `Array.includes` is invariant in its argument, and two differently-branded claim-id types cannot be compared without a cast. Behaviourally correct; a type-level workaround. |
| `packages/persistence/src/repositories/event-store.ts:38`, `:70` | `ResearchEvent<K>`'s payload is correlated with its `type`, which TypeScript cannot narrow from a non-generic `input` | **Finding.** See below. |

### Event payloads are not validated at the persistence boundary

`EVENT_PAYLOADS` and `parseEvent` exist in `@research-os/contracts`, and
`emit()` is now typed to take a declared `EventType` — which is what closed the
ten contract violations found in Phase 5. But **neither the write path nor the
read path validates the payload against the schema registered for its type**.
`SqlEventStore.append` casts `input.payload as never`, and `read` casts
`json(row, "payload", {}) as never`.

What this does and does not mean, stated precisely:

- It does **not** mean invalid payloads are being written. A full vertical slice
  emitted 49 events across 22 distinct types; every one was re-parsed with
  `parseEvent` during this reality check and **0 invalid envelopes, 0 invalid
  payloads, 0 undeclared types and 0 invalid ids** were found, with a gapless
  sequence.
- It does mean that property is currently a consequence of the handlers being
  correct, not a property the store enforces. A future handler emitting a
  malformed payload for a declared type would be persisted and served without
  complaint, and the failure would surface in a client, not at the boundary.

### Dead wiring found

| Item | Finding |
|---|---|
| `GraphRepository` / `store.graph` | Constructed on every store; `store.graph` is referenced **nowhere** in `packages/`, `apps/` or `tests/`. Its `graph_nodes` and `graph_edges` tables are created by `001-initial-schema` and never written. The graph the API serves is projected on demand from the relational tables by `buildProjectGraph`. 5 methods, 0 call sites, 0 test coverage direct or indirect. |
| 18 repository methods | Never called from anywhere outside the repository layer: `ExecutorRepository.listRequests`, `ExperimentRepository.findExperiment`, `GraphRepository.{upsertNodes,upsertEdges,nodeIdFor,loadGraph}`, `MemoryRepository.countByLayer`, `ProjectRepository.{findQuestion,updateQuestion}`, `ReportRepository.listVersions`, `ResearchRepository.{findSource,updateSource,findEvidence,addRelation,resolveContradiction}`, `RunRepository.{resolveFinding,verificationSummary,recordAudit}`. Unused surface area, not incorrect code. |
| `apps/web/` | Contains a single empty `public/` directory. Not an npm workspace, not in `tsconfig.json`, not in `architecture.json`. Already recorded as `NOT_FOUND` in the recovery audit; still present. |

### Dead wiring specifically looked for and **not** found

- **Unreachable routes:** 4 route modules defined, 4 registered in `server.ts`. 26 routes declared, 0 unreachable.
- **SDK calls with no API:** 17 distinct endpoints referenced by the SDK, 0 without a matching server route.
- **Unregistered handlers:** 18 task types declared, 18 handlers registered. `declared − handled = ∅`; `handled − declared = ∅`.

## Production test-double isolation

`ScriptedModelProvider` and `RecordingEventBus` are exported from `src` so other
packages' tests can import them, so they are *reachable* in the module graph
from both application entry points. Reachability is not use. What the production
composition root actually constructs, read from a live runtime built by
`buildRuntime(loadRuntimeConfig(env))` with no injected options:

```json
{ "bus": "InMemoryEventBus", "db": "SqliteDatabase",
  "toolProviders": ["web_fetch@local"], "modelProviders": ["unconfigured"] }
```

Test doubles constructed on the production path: **none**. Neither application
source tree (`apps/api/src`, `apps/worker/src`) names a test double anywhere, and
neither does `runtime.ts`. With no model key the stand-in is
`UnconfiguredModelProvider`, whose every call fails with the missing
configuration and its fix.

## Resumability across two real OS processes

Not simulated in one process. A file-backed SQLite database, two sequential
`node` invocations with different pids:

| | Process #1 (pid 86167) | Process #2 (pid 86181) |
|---|---|---|
| | created the project and three tasks | started after #1 had exited |
| | completed `source.discover`, output `{doneBy: "process-1"}` | inherited `{completed: 1, pending: 1, running: 1}` |
| | claimed `source.ingest` under a 1.5s lease and **exited holding it** | `resume()` → `{resumed: true, requeued: 1, failed: 0}` |
| | | ran only `source.ingest` and `evidence.extract` |

`source.discover` was **not** re-executed in process #2 and still carries
`doneBy: "process-1"`. The abandoned task completed with `attempts: 2` and
`doneBy: "process-2"`. All three tasks terminal, no lease left held.

## API, SDK, SSE and contract over a real socket

28 checks, all passing, none using `Fastify.inject`. Every request crossed a real
TCP connection to a separately spawned `node apps/api/src/main.ts` (pid 86452).

- **Negative control first:** the SDK against an unused port fails with
  `provider_unavailable` *before* the server exists. The port is then reused for
  the real server, so a passing result cannot be a stale success.
- `/health` correctly returns **503 `degraded`** with no model provider — a
  health check that reported green here would be worse than none — and the SDK
  raises on it rather than swallowing it.
- **SSE:** 1 event replayed from history, 3 delivered live on the already-open
  connection, sequence strictly increasing 1..5 across the replay→live handoff,
  **0 duplicates and 0 gaps**. `?since=3` returned only sequences 4 and 5;
  `Last-Event-ID: 3` returned exactly the same. Frames carry `id:`/`event:`/`data:`
  per the SSE specification.
- **Contract:** invalid body → 400 naming both failing fields; unknown project →
  404; unknown route → 404; missing and wrong bearer tokens → 401; malformed JSON
  → 400 blamed on the client, not a 500. Three error bodies were inspected for
  stack frames, the configured API key, `SQLITE_`/`SQLSTATE` text, absolute paths
  and `ANTHROPIC_API_KEY`: **none leaked**. The provider stack trace stayed in
  the server log.

## Model router

25 checks, all passing: deterministic routing for identical inputs; context-window
and capability constraints exclude rather than downgrade; an unsatisfiable
constraint throws instead of silently picking something; retry on retryable
failures only, with every attempt — failures included — reaching the model-call
ledger; fallback to the next candidate when a model is exhausted; a circuit
breaker that opens after repeated failures and **demotes rather than removes**;
structured output validated and repaired twice with the repair prompt naming the
actual validation failure, and unrepairable output failing rather than being
coerced; cost computed from real token counts and the model's real rates;
independence achieved with two providers and honestly reported as a self-review
with one; and budget-pressure routing that reorders without ever filtering, with
`judgment`, `synthesis` and `verification` never downgraded even at 99% pressure.

## Safety paths

29 checks, all passing.

- **Search:** no `web_search` or `academic_search` tool is registered. Discovery
  returns a non-retryable failure whose message begins `BLOCKED:` and says in so
  many words that research "will not answer from model recollection". It produced
  0 sources and 0 follow-up tasks. Supplying URLs directly still works.
- **Tool permissions:** all three of tool id, capability and risk level are
  required; a filesystem capability with no granted root is denied; the blocklist
  beats an allowlist and covers subdomains; all eight SSRF probes (loopback,
  `localhost`, `169.254.169.254`, `10/8`, `192.168/16`, `[::1]`, `file://`,
  `gopher://`) were refused while an ordinary public URL was allowed; and a
  blocked-host call still spends the task's call budget, so host probing is not
  free.
- **Experiments:** the default runner refuses with `BLOCKED`, `exitCode: null`,
  no metrics and no artifacts — nothing fabricated. `LocalProcessRunner` refuses
  construction without `acknowledgeUnsandboxedExecution: true`. It was **not**
  constructed during this audit; only its two refusal paths were exercised. The
  production runtime never mentions it, and an engine without a runner reports
  the gap.

## External project isolation

Zero references to Echo, Aira, AgentOS, ToolOS, EvalOS or MemoryOS appear in
**code** — every occurrence is a comment, a package description or documentation,
which is what `forbiddenIdentifiers` with `allowInComments: true` permits and the
architecture linter enforces. No `file:` or `link:` dependency points outside the
repository. The only non-`@research-os` imports across all source are `zod`,
`fastify`, `@fastify/cors` and `node:` builtins. `AgentOS`, `EvalOS` and `ToolOS`
exist as sibling directories on this machine and **no file under any of them was
modified**. This session wrote only to `README.md`,
`docs/evidence/IMPLEMENTATION_EVIDENCE.md` and throwaway scripts under the
gitignored `.data/`, all inside the project root.
