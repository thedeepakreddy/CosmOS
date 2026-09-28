# ResearchOS — Recovery Audit

Produced by the recovery session on **2026-09-15**, before any file was modified.
Classifies the inherited tree against the recovered master specification.

Status vocabulary (spec §2):

| Status | Meaning |
|---|---|
| `VERIFIED` | Code + wiring + a test or runtime observation proves it works |
| `IMPLEMENTED_BUT_UNVERIFIED` | Real code exists and compiles, but nothing exercises it |
| `PARTIAL` | Some of the area is real; a named part is missing |
| `BLOCKED` | Cannot proceed without something unavailable here |
| `NOT_FOUND` | Not present beyond a stub or a type declaration |

---

## 1. Environment

```text
ResearchOS absolute path:  /Users/thedeepakreddy/ResearchOS
Git root:                  /Users/thedeepakreddy/ResearchOS
Current branch:            main
Current commit:            NONE — the repository has zero commits
Git status:                every file untracked (no commit has ever been made)
Node version:              v26.8.2
npm version:               11.x (npm workspaces)
Python version:            not used by this project
Package manager:           npm workspaces (packages/*, apps/api, apps/worker)
```

> **Highest-priority risk.** `git log` fails with *"your current branch 'main' does not
> have any commits yet"*. Roughly 10,400 lines of previous-session work exist only as
> untracked files on disk. The loss the user is recovering from can recur at any moment.
> Nothing else in this audit matters as much as getting a first commit in place.

### Project structure

```text
ResearchOS/
├── architecture.json          # module graph: source of truth for deps + layers
├── external-versions.json     # pinned external versions, one place to bump
├── tsconfig.json              # solution file, 21 project references
├── tsconfig.base.json         # strict: noUncheckedIndexedAccess, exactOptionalPropertyTypes…
├── tsconfig.test.json         # typecheck-only project for tests
├── scripts/
│   └── generate-workspaces.mjs   # generates manifests + tsconfigs from architecture.json
├── tests/support/
│   └── pglite-database.ts        # real Postgres (WASM) Database adapter, test-only
├── packages/   (19 workspaces, layers 0–6)
├── apps/       api, worker (layer 7), web (empty directory)
├── docs/       EMPTY before this session
└── infrastructure/  EMPTY
```

---

## 2. Baseline checks (run before any modification)

| Command | Result |
|---|---|
| `npm run build` (`tsc -b`) | **PASS** — all 21 workspaces emit |
| `npm run typecheck` (src) | **PASS** |
| `npm run typecheck` (tests, `tsconfig.test.json`) | **FAIL — 40 errors** |
| `npm test` | **FAIL — 67 tests, 61 pass, 6 fail** |
| `npm run lint` (`eslint .`) | **FAIL — `eslint: command not found`**; no eslint dependency, no config file |
| `npm run lint:arch` | **FAIL — `MODULE_NOT_FOUND`**; `scripts/lint-architecture.mjs` does not exist |
| `npm run migrate` | **FAIL** — `scripts/migrate.mjs` and `scripts/register.mjs` do not exist |
| `npm run verify` | **FAIL** — composed of the four above |

### The 40 typecheck errors

All in test files, none in `src`:

- 37 × `packages/persistence/test/store.test.ts` — `Property 'id'/'title' does not exist on type 'never'`.
  Cause: the `makeProject()` / `makeTask()` fixtures return `... as never` to satisfy the
  branded-ID contract types, which makes every subsequent `project.id` read an error.
- 3 × `packages/claims/test/confidence.test.ts` — `TS6133` unused imports
  (`betaMean`, `betaCdf`, `betaQuantile`) under `noUnusedLocals`.

### The 6 failing tests

Three logical tests, each failing on both engines (SQLite and PGlite):

1. `transferable failures are visible from other projects` — expected 1, got 2
2. `an expired lease returns the task to the pool — this is crash recovery` — expected 0, got 1
3. `a retryable failure reschedules with backoff` — expected 0, got 1

**Root cause — diagnosed, not assumed.** Each `describe` block opens **one** database in
`before()` and shares it across every test in the block, but the three failing tests assert
on *global* result counts (`transferableFailures(...).length === 1`, `claim(...).length === 0`)
which only hold in isolation. Rows left behind by earlier tests in the same block —
a transferable failure record from the boolean round-trip test, an unclaimed low-priority
task from the priority test — are correctly returned by the queries.

Proof: switching `before`/`after` to `beforeEach`/`afterEach` and changing nothing else
takes the suite to **67 tests, 67 pass, 0 fail**. The repository SQL is correct; the test
harness leaks state between tests.

---

## 3. Area classification

| Area | Status | Evidence |
|---|---|---|
| Monorepo/project foundation | `VERIFIED` | `tsc -b` builds 21 referenced projects; `architecture.json` drives `scripts/generate-workspaces.mjs`, which regenerates every manifest + tsconfig idempotently |
| Configuration | `PARTIAL` | `packages/shared/src/env.ts` (99 lines): `readString/readNumber/readBoolean/readEnum/readList/parseDotEnv`. No `.env.example`, no app-level config composition — nothing calls it |
| Database | `VERIFIED` | 34 tables + 47 indexes in `001-initial-schema.ts` (614 lines); `migrator.ts` with a ledger table; `dialect.ts` abstracts Postgres/SQLite; exercised against **both** engines, PGlite being a real Postgres planner |
| API | `NOT_FOUND` | `apps/api/src/main.ts` is `export {};`. Fastify is installed and declared in `architecture.json`, but there is no server, no route, no handler |
| Model provider abstraction | `PARTIAL` | `contracts/src/model.ts` (134 lines) defines `ModelDescriptor`, `ModelMessage`, `ModelResponse`, `ModelUsage`, `ModelToolCall`, `MODEL_CAPABILITIES`, `MODEL_TASK_KINDS`. `packages/model-router/src/index.ts` is `export {};` — **no `ModelProvider` port exists yet** |
| Model router | `NOT_FOUND` | `ModelRoutingRule` is declared in contracts; no router implementation |
| Tool abstraction | `PARTIAL` | `contracts/src/tool.ts` (103 lines): `ToolDescriptor`, `TOOL_CAPABILITIES`, `TOOL_RISK_LEVELS`, `ToolPermissionPolicy`. `packages/tools` is `export {};` |
| Research Director | `NOT_FOUND` | `AGENT_ROLES` enumerated in `contracts/src/agent.ts`; `packages/research-core` is `export {};` |
| Literature/Evidence Agent | `NOT_FOUND` | as above |
| Claim Extraction Agent | `NOT_FOUND` | as above |
| Critic/Skeptic Agent | `NOT_FOUND` | as above; `CritiqueFinding` contract + `RunRepository.addFindings/listFindings/resolveFinding` exist to receive its output |
| Verification Agent | `NOT_FOUND` | as above; `VerificationCheck` contract + `RunRepository.addVerificationChecks/verificationSummary` exist |
| Data Analyst Agent | `NOT_FOUND` | as above |
| Experiment Agent | `NOT_FOUND` | as above |
| Reviewer/Judge Agent | `NOT_FOUND` | as above |
| Multi-agent debate | `NOT_FOUND` | `contracts/src/debate.ts` (86 lines) defines `Debate`/`DebateTurn`/`DebateVerdict`/`DEBATE_POSITIONS`; `RunRepository.saveDebate/listDebates` persist them. **No debate engine.** Storage-ready, behaviour absent |
| Claim/evidence graph | `PARTIAL` | `contracts/src/graph.ts` (`GRAPH_NODE_TYPES`, `GRAPH_EDGE_TYPES`) + `GraphRepository` (74 lines: `upsertNodes`, `upsertEdges`, `loadGraph`, `nodeIdFor`, `clear`) are real and the projection is deliberately rebuilt from relational tables. `packages/knowledge-graph` (traversal, tree projection) is `export {};`. Untested |
| Research memory | `PARTIAL` | `contracts/src/memory.ts` (126 lines) + `MemoryRepository` (168 lines) are real. `packages/memory` — the `MemoryProvider` port that keeps MemoryOS swappable — is `export {};` |
| Failure memory | `PARTIAL` | Schema, `addFailure`, `listFailures`, `transferableFailures` all real. Boolean round-trip on both engines **passes**; the cross-project transferable test **fails** on harness state leakage (§2) |
| Research project state | `VERIFIED` | `ProjectRepository` (319 lines); round-trips with JSON columns, nested `createdBy`, and `null` preservation intact on both engines |
| Resumable workflows | `PARTIAL` | The durable substrate is real and largely verified: `TaskRepository` (263 lines) with atomic lease claiming, `FOR UPDATE SKIP LOCKED` on Postgres, dependency gating, priority ordering, backoff, attempt exhaustion, and park/resume around external tool calls. **7 of 9 queue tests pass.** But nothing drives it — `packages/orchestration` is `export {};` and no worker loop exists. Resumability of a *research run* is therefore **not** demonstrated |
| Experiment engine | `PARTIAL` | `contracts/src/experiment.ts` (151 lines) + `ExperimentRepository` (152 lines). `packages/experiments` (the runner port) is `export {};`. No execution path |
| Research reports | `PARTIAL` | `contracts/src/report.ts` (113 lines) + `ReportRepository` (53 lines) with immutable versioning (`nextVersion`, `findVersion`, `listVersions`). No report builder |
| Research evolution/history | `PARTIAL` | Event history is the mechanism and it is **verified**: gapless per-project sequences and replay-from-resume-point both tested. `ResearchTree`/`RESEARCH_TREE_NODE_KINDS` contracts exist with no projection |
| Event system | `PARTIAL` | `SqlEventStore` (81 lines) is `VERIFIED` — sequences are per-project, gapless, strictly increasing, and replayable. `InMemoryEventBus` + `RecordingEventBus` (`bus.ts`, 119 lines) are `IMPLEMENTED_BUT_UNVERIFIED` — zero tests |
| Streaming/SSE/WebSocket | `IMPLEMENTED_BUT_UNVERIFIED` | `events/src/stream.ts` (105 lines) exports `toServerSentEvent` and stream filtering. No tests, and no server consumes it |
| Observability | `IMPLEMENTED_BUT_UNVERIFIED` | `logger.ts`/`trace.ts`/`metrics.ts` (379 lines): `createLogger`, `Tracer`/`Span`/`MemorySpanSink`, `MetricsRegistry`, `computeCostUsd`, `mergeUsage`. Zero tests; the only consumer is an optional `logger` parameter on `migrate()` |
| Security | `PARTIAL` | Ingredients present — `audit_log` table + `RunRepository.recordAudit`, `ToolPermissionPolicy` contract, `TOOL_RISK_LEVELS`, `maskSecret()` in shared. **No enforcement point exists**, because no tool or agent layer exists to enforce at |
| API v1 | `NOT_FOUND` | `contracts/src/api.ts` (217 lines) fully specifies the v1 surface — `CreateProjectRequest`, `ProjectDetailResponse`, `RunProjectRequest`, `ClaimsPage`, `EvidencePage`, `SourcesPage`, `ExperimentsPage`, `ReportResponse`, `EventsQuery`, executor registration/result. **Zero of it is served** |
| Dev UI | `NOT_FOUND` | `apps/web/` exists containing only an empty `public/`. Not a workspace, not referenced by `tsconfig.json` or `architecture.json` |
| Echo integration contract | `PARTIAL` | The seam is correctly designed and persisted: `contracts/src/executor.ts` (86 lines) defines capability-based registration with push/pull modes, and `ExecutorRepository` (159 lines) stores executors and requests. `TaskRepository.waitForTool/findByAwaitingRequest/resume` is the park-and-resume half. `packages/executors` is `export {};`. **No Echo-specific identifier appears anywhere in the core — this constraint is currently honoured** |
| ToolOS integration readiness | `NOT_FOUND` | No `ToolProvider` port exists yet; `packages/tools` is a stub. The `ToolCapability` vocabulary in contracts is the intended translation surface |
| Aira integration readiness | `PARTIAL` | `ClientIdentity` (`application` + `userId`) is threaded through project creation and persisted; API contracts are complete. But there is no API server and `packages/sdk` is `export {};` |
| Testing | `PARTIAL` | 67 tests across exactly 2 of 19 packages (`persistence`, `claims`). 61 pass, 6 fail. 40 typecheck errors in test files. `shared`, `contracts`, `observability`, `events`, `evidence` have empty `test/` directories |
| Documentation | `NOT_FOUND` | `docs/` was empty. No README. The only documentation is the (genuinely good) header comment on every source file and `architecture.json` |

---

## 4. Where the previous session stopped

File modification times give an unambiguous ordering. The previous session built strictly
bottom-up and stopped mid-layer-3:

```text
00:35–00:44  shared, contracts, evidence, claims          (layers 0, 1, 3-pure, 4-pure)
00:45:10     observability/src/trace.ts
00:45:44     events/src/{bus,store,stream}.ts             (layer 2)
00:46:03     persistence/src/{database,dialect}.ts
00:46:17     persistence/src/{sqlite,postgres}-database.ts
00:47:03     persistence/src/migrator.ts
00:47:25     tests/support/pglite-database.ts
00:48:44     persistence/src/migrations/001-initial-schema.ts
00:49:00     project / research / task repositories
00:49:23     run-repository.ts
00:49:41     event-store, memory repositories
00:49:59     executor, graph repositories
00:50:18     experiment repository, store.ts, index.ts
00:50:23     report-repository.ts          ← LAST FILE WRITTEN
00:52       (session ends)
```

`packages/sdk`, `model-router`, `tools`, `knowledge-graph`, `experiments`, `memory`,
`retrieval`, `ingestion`, `executors`, `verification`, `orchestration`, `research-core`,
`apps/api`, `apps/worker` are all still the `export {};` placeholder that
`generate-workspaces.mjs` writes for a new workspace. None was ever started.

```text
LAST VERIFIED MILESTONE:
  Layers 0–2 and the pure domain packages.
  shared, contracts, observability, events, evidence, claims — all build; claims is
  covered by 52 passing tests (beta distribution, confidence aggregation).

CURRENT PARTIALLY COMPLETED MILESTONE:
  Layer 3 — persistence.
  The implementation is complete and good: 34 tables, dual-dialect migrations, 10
  repositories, a durable lease-based task queue, and a test suite that runs every
  assertion against both SQLite and a real Postgres engine. It was abandoned with the
  suite red: 6 failing tests and 40 test-file typecheck errors. Separately, three
  scripts that package.json advertises (lint-architecture, migrate, register) were
  never written, and eslint is declared but not installed — so `npm run verify`,
  the project's own definition of done, cannot run at all.

NEXT REQUIRED IMPLEMENTATION:
  1. Finish the persistence milestone rather than moving past it:
     a. Give the persistence tests real isolation so the 6 failures go away without
        weakening any assertion.
     b. Type the test fixtures properly and clear the 40 typecheck errors.
     c. Write scripts/lint-architecture.mjs so architecture.json is enforced and not
        merely documented — it is the thing keeping Echo/Aira out of the core.
     d. Install and configure eslint; write scripts/migrate.mjs + scripts/register.mjs.
     e. Get `npm run verify` green end to end.
  2. Only then continue up the layer graph: model-router and tools are the two
     layer-3 stubs that every agent in layer 6 depends on.
```

---

## 5. Competing or orphaned implementations

**None found.** There is exactly one implementation of every concept present.
`architecture.json` + `generate-workspaces.mjs` appear to have prevented the drift that
spec §44 warns about. No dead code, no `TODO`/`FIXME`/`HACK` marker anywhere in the tree.

---

## 6. Assessment of inherited quality

Worth recording, because spec §33 says not to rewrite functional-but-imperfect work:
this code is better than "functional". It should be preserved and extended, not reworked.

- The strictest reasonable TypeScript settings are on (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) and the
  `src` tree is clean under them.
- Branded IDs (`Id<"claim">`) make cross-entity ID confusion a compile error.
- The dual-engine test strategy is the real thing: PGlite runs the genuine Postgres
  parser and planner, so the Postgres path is verified rather than assumed.
- `asEntity()` exists specifically to make every unchecked cast greppable, with the
  trade-off written down at the definition.
- Comments explain *why* (timestamps as ISO strings to stop the two drivers returning
  different JS types; reports versioned because a silently-changed report is worse than
  no report), not *what*.

The one place the quality drops is the persistence test harness, which is the file the
session was working on when it was lost.
