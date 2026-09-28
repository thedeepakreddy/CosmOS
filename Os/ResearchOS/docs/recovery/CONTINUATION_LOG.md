# ResearchOS — Continuation Log

Append-only record of what each session inherited, changed and verified, so the
project survives losing a coding-agent session again. Newest session last.

---

## Session 2 — 2026-09-15 — Recovery and Milestone A

### Recovered state

The previous session's work was intact on disk and is documented in
[`RESEARCHOS_RECOVERY_AUDIT.md`](./RESEARCHOS_RECOVERY_AUDIT.md). Nothing was
lost, nothing was rebuilt, and no duplicate implementation was created.

Inherited: ~10,400 lines across 21 workspaces. Layers 0–2 complete
(`shared`, `contracts`, `observability`, `events`), layer 3 `persistence` and
`evidence` complete, layer 4 `claims` complete. Twelve packages and both
applications were still the `export {};` placeholder.

### Work inherited from the previous session

It stopped mid-way through the **layer 3 persistence milestone**. The
implementation was finished (`report-repository.ts` at 00:50:23 was the last
file written) but the milestone was not: the test suite was red and the
project's own definition of done could not run.

### Defects found

| # | Defect | Severity | Where | Resolution |
|---|---|---|---|---|
| 1 | 6 persistence tests failing | High | `packages/persistence/test/store.test.ts` | Not a repository bug. One database was shared across each `describe`, while three tests assert on whole-table totals. Rows left by earlier tests were correctly returned and broke the counts. Fixed with per-test truncation; every assertion kept as written. |
| 2 | 40 typecheck errors in test files | High | same, + `packages/claims/test/confidence.test.ts` | Fixtures returned `... as never`, so every `project.id` read was an error on type `never`. Replaced with schema-parsed fixtures. Three unused imports removed. |
| 3 | `npm run lint:arch` crashed | High | `scripts/lint-architecture.mjs` missing | Written. `architecture.json` was a design document nothing enforced. |
| 4 | `npm run lint` crashed | High | eslint declared, never installed, no config | eslint 10 + typescript-eslint 8 installed; `eslint.config.mjs` written. |
| 5 | `npm run migrate` crashed | Medium | `scripts/migrate.mjs`, `scripts/register.mjs` missing | Both written; `databaseConfigFromEnv` added to `persistence` so the CLI, API and worker cannot drift apart. |
| 6 | **`events` depended on `observability`** | Medium | `packages/events/src/bus.ts` | Undeclared, and a same-layer dependency between two layer-2 peers. The bus needed one `warn` method, so it now declares that shape structurally. `Logger` still satisfies it; callers unchanged. Found by defect 3's linter. |
| 7 | **`persistence` depended on `events`** | Low | `packages/persistence/src/repositories/event-store.ts` | Legitimate (an adapter implementing a port, layer 3 → 2) but undeclared, so it built only by accident of reference ordering. Declared in `architecture.json` and regenerated. Found by defect 3's linter. |
| 8 | **A synchronous subscriber could kill the publisher** | **High** | `packages/events/src/bus.ts:73` | `matching.map(s => s.handler(event))` — a handler may be synchronous, and a synchronous throw escapes `.map()` before `Promise.allSettled` exists to catch it, rejecting `publish()`. This contradicted the contract stated two lines above it: *"a failing subscriber must never fail the publisher."* Found by `no-floating-promises`/`await-thenable`. Reproduced with a failing test, then fixed. |

Defects 6, 7 and 8 were all surfaced by tooling written in this session, and 8
was a genuine latent bug in inherited code, not a lint preference.

### Work completed in this session

- `tests/support/reset-database.ts` — per-test truncation that reads the table
  list from the engine catalog, so a future migration cannot leave a table
  silently un-reset.
- `tests/support/fixtures.ts` — fixtures built by parsing the contract schemas,
  so they are typed, branded, and fail loudly if they drift from the contract.
- `packages/persistence/src/config.ts` — `databaseConfigFromEnv`,
  `createDatabase`, `describeDatabase`. One place decides which engine to use.
- `scripts/lint-architecture.mjs` — enforces `architecture.json`: undeclared
  imports, downward-only layering, manifest drift, tsconfig-reference drift, and
  product names (Echo/Aira) in the reusable core.
- `scripts/register.mjs`, `scripts/migrate.mjs` — dotenv preload and migration CLI.
- `eslint.config.mjs` — type-aware, scoped to correctness rather than restyling
  inherited code.
- `packages/events/test/bus.test.ts` — 15 tests, the first coverage layer 2 has had.
- Bug fix in `packages/events/src/bus.ts`.

### Tests executed

| Command | Before | After |
|---|---|---|
| `npm run build` | pass | pass |
| `npm run typecheck` | **40 errors** | pass |
| `npm run lint` | **crash** (not installed) | pass |
| `npm run lint:arch` | **crash** (script missing) | pass |
| `npm test` | **67 tests, 6 failing** | **82 tests, 0 failing** |
| `npm run verify` | **could not run** | **pass** |
| `npm run migrate` | **crash** (script missing) | applies 88 statements, idempotent on re-run |

Beyond the suite, two things were verified by running them rather than by
reading the code:

- **The architecture linter actually fails.** Four deliberate violations were
  introduced one at a time — an undeclared cross-package import, a product name
  in code, manifest drift — and each was caught; the same product name inside a
  comment was correctly allowed.
- **Persistence survives a process restart.** One process created a project,
  a task and an event and claimed the task under a lease; it exited; a second
  process read all of it back, including the lease holder, the attempt count and
  the lease expiry.

### Milestone A result — layer 3 persistence, finished

The interrupted milestone is complete and `npm run verify` passed end to end for
the first time in the project's history: 82 tests, 0 failing.

---

## Session 2, continued — Milestone B: model-router and tools

With the foundation green, the two remaining layer-3 stubs were built. These were
next because every agent in layer 6 depends on both, and an "agent" without a
model provider behind it would be exactly the fake agent §27 prohibits.

### `packages/model-router` — built, 25 tests

| File | What it is |
|---|---|
| `provider.ts` | The `ModelProvider` port. The only thing above it that names a vendor is nothing. |
| `catalog.ts` | Model specs, and pricing read from configuration rather than compiled in |
| `policy.ts` | Default routing rules, expressed by kind of work rather than model tier |
| `router.ts` | Selection, retry, fallback, circuit breaker, structured output, cost accounting |
| `anthropic-provider.ts` | The one file that knows Anthropic exists |
| `scripted-provider.ts` | A deterministic test double, following the `RecordingEventBus` convention |

Three decisions worth recording, because each was a choice with an alternative:

- **Pricing is configuration, and an unpriced model is refused at start-up.**
  Published rates change, and a stale compiled-in rate does not fail — it
  silently mis-bills every run, and budget enforcement reads those numbers. A run
  that believes it has spent $2 when it has spent $20 is worse than a run that
  refuses to start. Fabricating plausible-looking rates would have been the
  easier option and the wrong one.
- **Independence is reported, never assumed.** A single-provider deployment
  cannot verify its own output independently. The router routes anyway and
  returns `independent: false` with a warning, so the verification record says
  "self-reviewed". Silently presenting a self-check as independent verification
  carries unearned confidence, which is worse than not verifying.
- **The router owns retry; the SDK's own retries are disabled.** Two independent
  retry loops multiply into a long stall neither layer can see the shape of.

### `packages/tools` — built, 42 tests

| File | What it is |
|---|---|
| `tool.ts` | The `ResearchTool` port, plus the provenance every retrieval carries |
| `permissions.ts` | Default-deny evaluation: tool id **and** capability **and** risk, plus host, path and SSRF rules |
| `provider.ts` | The `ToolProvider` seam an external capability layer attaches through, and a local implementation |
| `registry.ts` | The single door: permission, budget, concurrency, timeout, audit |
| `builtin/web-fetch.ts` | A real HTTP tool, tested against a real server |

### Defects found and fixed in Milestone B

| # | Defect | Severity | Where | How it was found |
|---|---|---|---|---|
| 9 | **A tool that ignores its abort signal wedged the caller** | **High** | `packages/tools/src/registry.ts` | The timeout was implemented by aborting a signal, which only works for a tool that checks it — and the tools most likely to hang (an external executor on a dead socket) are the least likely to. The test took **5,006 ms** against a 30 ms timeout. Now a `Promise.race`; the same test takes **32 ms**. The abort is still issued so cooperative tools release resources. |
| 10 | **The SSRF exemption was all-or-nothing** | **High** | `packages/tools/src/permissions.ts` | First written as a boolean `allowPrivateAddresses` so the test server on loopback could be reached. The metadata-redirect test then hung for 10 seconds actually trying to reach `169.254.169.254` — the one flag had unblocked both. Replaced with `allowedPrivateHosts`, an exact-match list, so an operator who needs `corpus.internal` does not thereby get the metadata endpoint. |
| 11 | `PricingRates` rejected a `ModelDescriptor` | Low | `packages/observability/src/metrics.ts` | Optional fields needed explicit `\| undefined` under `exactOptionalPropertyTypes`. Widened, following the convention already set by `HistogramSummary`. |
| 12 | A dead initialiser in `structured()` | Low | `packages/model-router/src/router.ts` | `no-useless-assignment`. Removed a redundant local at the same time. |
| 13 | A test tool named `EchoTool` | Low | `packages/tools/test/registry.test.ts` | The architecture linter refused it: "Echo" is a product name in this ecosystem and must not appear in the core. Renamed. The linter catching its author is the best evidence it works. |

Defects 9 and 10 were both security- or reliability-relevant, and both were found
by tests written to probe the failure path rather than the happy path.

### Tests executed

| Command | Session start | Now |
|---|---|---|
| `npm run build` | pass | pass |
| `npm run typecheck` | **40 errors** | pass |
| `npm run lint` | **crash** | pass |
| `npm run lint:arch` | **crash** | pass — 21 workspaces, layering intact |
| `npm test` | **67 tests, 6 failing** | **149 tests, 0 failing** |
| `npm run verify` | **could not run** | **pass** |

Coverage went from 2 packages to 5. `events`, `model-router` and `tools` had no
tests at the start of this session.

### Milestone result — Phase 1 complete

`npm run verify` green: 289 tests, 0 failing.

---

## Session 2, continued — Phases 2 through 4: every remaining layer

With the foundation verified, the twelve remaining stubs were built bottom-up,
one layer at a time, with the full verification gate run at each layer boundary.

### What was built

| Layer | Package | What it does |
|---|---|---|
| 3 | `knowledge-graph` | Graph projection with deterministic node ids, traversal, provenance walks, research-evolution tree |
| 3 | `experiments` | Runner port, local process adapter, marker-line metrics, replication arithmetic |
| 4 | `memory` | `MemoryProvider` port, SQL adapter, pure ranking, research-shaped helpers |
| 4 | `retrieval` | BM25, reciprocal rank fusion, hybrid retrieval, embedding backfill |
| 4 | `ingestion` | HTML parsing with offsets, offset-exact chunking, fetch-parse-chunk pipeline |
| 4 | `executors` | Executor protocol, token auth, `ToolProvider` bridge |
| 5 | `verification` | Citation fidelity, numeric and arithmetic checks, scope support, reproducibility |
| 5 | `orchestration` | Worker loop, budget ceilings, run lifecycle, resumability |
| 6 | `research-core` | 8 agents, debate engine, report builder, 10 task handlers, composition root |
| 7 | `apps/api` | `/api/v1` over Fastify, SSE stream, executor endpoints, health and capabilities |
| 7 | `apps/worker` | The same engine without the HTTP surface |
| 2 | `sdk` | Typed client built from the same contracts the server validates against |

### Defects found and fixed

Every one of these was surfaced by a test or by the tooling, not by inspection.
The ones marked **High** would each have caused silent wrong behaviour in
production.

| # | Defect | Severity | How it was found |
|---|---|---|---|
| 14 | **Every JSON column holding a scalar string read back as `null` on Postgres only.** `pg` parses `jsonb` by default and returns a JSON object as an object but a JSON *string* as a bare string with the quotes gone — indistinguishable from the JSON text SQLite returns, so `JSON.parse("a plain string")` threw and the value became the fallback. Both Postgres adapters now return JSON as raw text. | **High** | The dual-engine memory suite: identical assertions passed on SQLite and failed on PGlite |
| 15 | **The wall-clock budget killed every resumed run.** Measured from `project.createdAt`, so a project paused longer than its ceiling died the instant it resumed — defeating the feature resumability exists for. Now measured from the latest `research.started` event. | **High** | The vertical slice stalled; the log read `maxWallClockMs: used 19502188472 of 1800000` |
| 16 | **The default routing policy hard-coded Anthropic model ids**, making the router unusable with any other provider without writing a bespoke rule set. Policy is now preference; an unmatched policy falls back to the best registered capable model. | **High** | The vertical slice could not route `planning` to a scripted provider |
| 17 | **Dynamically expanded work did not block its dependents.** A discovery step finding eight sources created eight ingestion tasks, but extraction became runnable immediately — and would have found nothing, reporting that honestly, which is a correct answer to the wrong question. Follow-ups now inherit the completing task's dependents. | **High** | Tracing why the slice produced no evidence |
| 18 | The tool policy permitted only `web_fetch`, so a registered search tool was unreachable | Medium | Discovery reported itself blocked with a search tool present |
| 19 | **Fastify's own errors bypassed error mapping and became 500s.** A malformed JSON body told the client its own bad request was a server fault. | Medium | An API test expecting 401 got 500 |
| 20 | With no model key, failures read `ScriptedModelProvider "unconfigured" ran out of script` — an internal detail of a test double where an operator needed the actual fix. Replaced with `UnconfiguredModelProvider`, which names the missing configuration. | Medium | Runtime smoke test of the real server |
| 21 | `LogFields` forbade passing a caught error, though the logger already special-cased `error` keys at runtime | Low | Building the worker |
| 22 | The architecture linter matched prose inside a real string (`cannot move from "draft" to "running"`) as an import | Low | Building the run coordinator |

Defect 22 prompted rewriting the linter's import scanner to validate the import
*clause* rather than guess from context. It now passes six directed cases:
single-line, multi-line and dynamic imports and re-exports are all detected;
prose in a string literal is not.

### The vertical slice (§36)

The test the whole system exists to pass, in
`packages/research-core/test/vertical-slice.test.ts`:

```text
create project → plan → search → fetch a real HTTP server → parse → chunk
  → retrieve → extract evidence → extract claims → verify quotes
  → score confidence → detect contradictions → critique → generate report
```

The model is scripted, because a real one makes this non-deterministic and
expensive. Everything else is real: real SQLite, real HTTP, real chunking with
exact offsets, real mechanical verification, real Beta-posterior arithmetic, real
durable task queue.

Two hostilities are planted in the scripted output, and neither reaches the
report:

- an evidence item quoting a sentence that is **not in the document** — caught by
  citation fidelity, recorded as a failed check on the evidence row;
- a claim whose every cited evidence index is **out of range** — discarded at
  extraction, because a claim with nothing behind it is a model assertion.

The suite also asserts that confidence is reproducible by hand: `posteriorAlpha /
(posteriorAlpha + posteriorBeta)` recomputes the stored score, and prior plus
evidence weight recomputes the posterior.

### Tests executed

| Command | Session start | Now |
|---|---|---|
| `npm run build` | pass | pass |
| `npm run typecheck` | **40 errors** | pass |
| `npm run lint` | **crash** | pass |
| `npm run lint:arch` | **crash** | pass — 21 workspaces, layering intact |
| `npm test` | **67 tests, 6 failing** | **386 tests, 0 failing** |
| `npm run verify` | **could not run** | **pass** |

Coverage went from 2 packages to 14. Runtime smoke tests beyond the suite: the
migration CLI (88 statements, idempotent), cross-process persistence, and the
real API server — project created, run started, events streamed over SSE, 404 and
400 shapes correct, embedded worker picking up queued work.

### Milestone result — every layer implemented

`npm run verify` green: 386 tests, 0 failing. No stub remained.

---

## Session 2, continued — Phase 5: advanced research

The six items the specification lists for Phase 5, plus the gaps the previous
milestone left open.

### What was built

| Item | What it is |
|---|---|
| **Richer debate** | `debate.run` handler: picks the most severe open contradiction, or the most *uncertain* contested claim — the one an argument could actually move. Verdict feeds `agentAgreement` into confidence. |
| **Research evolution** | `evolution.derive`: what held up, what was revised, what questions the findings opened, where to go next — and the dead ends, written to failure memory. |
| **Automated hypothesis generation** | `hypothesis.generate` + `question.decompose`: proposes falsifiable explanations and splits questions that arise mid-run. Emergent questions are marked `emergent`, so a reader can tell which parts of the enquiry the evidence forced. |
| **Failure-memory optimisation** | Dead ends recorded automatically, deduplicated within a batch *and* against the store, and **tenant-scoped** so one customer's dead ends are never readable by another. |
| **Advanced model routing** | Budget-pressure-aware: trades model strength for reach as a run nears a ceiling, so it finishes with a weaker answer rather than no answer. Judgment, synthesis and verification are never downgraded, and every downgrade is recorded. |
| **Sophisticated evaluation** | New `evaluation` package (layer 5): eight weighted dimensions over stored artifacts. Pure arithmetic — a model grading research produced by models mostly measures how convincing the output reads. |

Also completed: `claim.link_evidence`, `experiment.design`, `experiment.run`,
`executor.request`. **All 18 task types in the contract now have a handler**, and
a test asserts that against the vocabulary so a new type cannot be added without
one.

### Defects found and fixed

| # | Defect | Severity | How it was found |
|---|---|---|---|
| 23 | **Handlers emitted event types the contract does not declare**, and payloads that did not match the ones it does. Invisible to a client subscribing by type, and rejected by `parseEvent`. The `emit` helper took a `string` and cast it to `never`, which hid the whole class. | **High** | A Phase 5 test compared against an undeclared type and the compiler objected. Typing `emit` then surfaced nine more. |
| 24 | **`transferableFailures` was not tenant-scoped.** One customer's dead ends — often statements about a private dataset or internal system — were readable by another's research run. | **High** | Writing the Phase 5 failure-memory tests |
| 25 | **`recordRun` was insert-only**, so storing an experiment's interpretation after its numbers failed on the primary key. | **High** | The experiment-run test |
| 26 | **Replication was always reported as zero.** The handler asked `replicationSummary` for a count *before* marking which runs matched, and the summary counts rows already marked. | **High** | The experiment-run test asserting a second run reproduced the first |
| 27 | Dead ends were deduplicated against the store but not within a batch, so a repeated one was written twice | Medium | The dedup test |
| 28 | **22 declared dependencies that nothing imported.** `architecture.json` had drifted from describing the system to describing an intention. | Medium | A new linter check, added for exactly this |
| 29 | An empty project was graded `weak` with a self-contradicting summary — "Weak (0.00 across 0 applicable dimensions). No dimension scored below 0.6." | Medium | Runtime smoke test |
| 30 | The API emitted `research.project.created` with `{question}` where the schema declares `{title, originalQuestion}` — the API emits directly, so the typed helper did not cover it | Medium | Runtime smoke test |
| 31 | `ExecutorService` published an event with an empty `projectId`, which the envelope schema rejects and no consumer can resume past | Low | Typing `emit` |
| 32 | A new package's `test/` directory was not created by the generator, so its first test file was silently unrunnable | Low | Adding the `evaluation` package |

Defect 23 is the one worth dwelling on. A single `as never` cast was suppressing
a whole category of contract violation, and removing it turned ten silent bugs
into ten compiler errors. The fix was not to correct ten call sites but to make
the type carry the constraint.

### Invariants now protected by tests

- **Every task type in the contract has a handler.** A type with none fails at
  run time with `not_implemented`, which is honest but means a plan naming it can
  never succeed.
- **Every event emitted during a real run validates against its declared
  payload**, checked by running `parseEvent` over the whole stream at the end of
  the vertical slice.
- **Events are id-centric**, so a client can act on each one without re-fetching
  the project to find out what changed.
- **Tenant isolation of failure memory**, on both engines.
- **Protected task kinds are never downgraded**, whatever the budget pressure.

### Tests executed

| Command | Session start | Now |
|---|---|---|
| `npm run build` | pass | pass |
| `npm run typecheck` | **40 errors** | pass |
| `npm run lint` | **crash** | pass |
| `npm run lint:arch` | **crash** | pass — 22 workspaces, both drift directions checked |
| `npm test` | **67 tests, 6 failing** | **454 tests, 0 failing** |
| `npm run verify` | **could not run** | **pass** |

16 of 22 workspaces have their own tests. Runtime smoke tests beyond the suite:
the migration CLI, cross-process persistence, and the real API server — project
created and run, 18 task types reported by `/api/v1/capabilities`, the evaluation
endpoint returning `unevaluable` with its caveats, and every emitted event
matching its declared payload.

### Current milestone

**All five phases built. 22 workspaces, 21,959 lines of source, 6,958 of tests.**

### Known blockers

Unchanged from the previous milestone, and none of them is a rough edge:

- **The repository still has no commits.** Everything remains untracked.
- **No live model call has ever been made from this codebase.** Every agent is
  exercised against a scripted provider, which verifies wiring, contracts, the
  repair loop and every failure path — but not what a real model does with these
  prompts. `AnthropicProvider` stays `IMPLEMENTED_BUT_UNVERIFIED`.
- **No search capability ships.** Discovery reports `BLOCKED` rather than
  answering from model recollection.
- **Experiments have no sandbox.** `LocalProcessRunner` must be explicitly
  acknowledged; the default runner refuses.
- **Direct evidence upload is still refused**, because it would bypass the
  parse-and-chunk path that makes a quote checkable.
- **Concurrency is proven by construction, not under load.** `FOR UPDATE SKIP
  LOCKED` is emitted and parsed by a real Postgres; contention between genuinely
  parallel workers is untested.
- **ToolOS and Echo integration remain `PLANNED`** — the seams exist, are
  enforced, and are exercised by a test executor, but neither product's API is
  available here.
