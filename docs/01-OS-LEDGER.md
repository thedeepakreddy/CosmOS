# Cosmos OS Ledger

**The single place where status is asserted.** No other document in this repo
makes a status claim. Verified against the repositories on 2026-09-15.

Status vocabulary, borrowed from ResearchOS because it is the right one:

| Status | Meaning |
|---|---|
| `VERIFIED` | Code exists, is wired, and an execution has been observed |
| `IMPLEMENTED` | Code exists and is wired, execution not independently observed |
| `DECLARED` | A type or field exists, the behaviour behind it does not |
| `PLANNED` | Specified, not written |
| `DEFERRED` | Deliberately not being built yet, with a named trigger |

A claim marked *(repo-asserted)* is taken from that project's own evidence
documents and was not re-run during this audit. A claim marked *(audited)* was
checked directly against source in this session.

---

## 0. Repository health, and it is not good

This is the most urgent item in the ledger and it outranks every feature below.

| Repo | Git | Commits | Uncommitted | Remote |
|---|---|---|---|---|
| `~/ToolOS` | yes | 1 | 0 | **none** |
| `~/AgentOS` | yes | 1 | **48** | **none** |
| `~/ResearchOS` | yes | **0** | 17 | **none** |
| `~/EvalOS` | **not a repo** | n/a | n/a | **none** |
| `~/cosmos` | yes | several | 1 | github.com/thedeepakreddy/CosmOS |

ResearchOS, the largest and most sophisticated system in Cosmos, has never been
committed. EvalOS is not under version control at all. Nothing but `cosmos` has
an off-machine copy.

**Action, before any feature work:** commit all four, push all four to private
remotes. Nothing else in this ledger matters if the code can vanish.

---

## 1. ToolOS

**Simple meaning:** CAN DO. The safe doorway to capabilities.
**Location:** `~/ToolOS` | **Version:** 1.0.0 | **Runtime:** Node, TypeScript, Fastify

| Area | Status | Notes |
|---|---|---|
| Contract types | `VERIFIED` *(audited)* | `packages/contracts/src/index.ts`. Clean, dependency-free, complete |
| Registry | `IMPLEMENTED` *(repo-asserted)* | In-memory. Namespace collision prevention |
| Policy provider | `IMPLEMENTED` *(repo-asserted)* | `authorize(callerAppId, capabilityOrTool)`. Coarse-grained by design |
| Router | `IMPLEMENTED` *(repo-asserted)* | Executor selection by health and policy |
| Adapters | `IMPLEMENTED` *(repo-asserted)* | `echo/` and `mcp/` present |
| HTTP API | `VERIFIED` *(audited)* | 7 routes under `/v1` plus `/health` and `/openapi.json` |
| SDK | `VERIFIED` *(audited)* | `packages/sdk`. Thin, honest fetch wrapper |
| Typed failures | `VERIFIED` *(audited)* | 11 explicit error categories. No success-with-error-string |

**What is genuinely good:** the error taxonomy, the refusal to let adapters hold
domain logic, and the explicit "deliberately NOT in ToolOS" list.

**Real gaps.** Registry is in-memory, so capabilities vanish on restart. No
persistence layer at all. Policy is caller-level only, with no per-user, per-run
or budget dimension. No rate limiting. The MCP adapter is present but the SDK is
a devDependency, which is a packaging smell worth checking.

---

## 2. AgentOS

**Simple meaning:** ORGANIZE WORK.
**Location:** `~/AgentOS` | **Version:** 0.2.0-phase-a | **Runtime:** Node, TypeScript, Fastify, better-sqlite3

| Area | Status | Notes |
|---|---|---|
| Domain model | `VERIFIED` *(audited)* | Full zod model in `src/domain/types.ts` |
| Run and task state machines | `VERIFIED` *(audited)* | Explicit transition tables, terminal-state guards |
| DAG validation | `IMPLEMENTED` *(audited)* | `src/engine/DAGValidator.ts` |
| Supervisor | `IMPLEMENTED` *(audited)* | Concurrency limits, leases, fencing, retry backoff |
| Durable persistence | `IMPLEMENTED` *(audited)* | SQLite with migrations. Adapter kept internal on purpose |
| Claim, lease, fence ownership | `IMPLEMENTED` *(audited)* | Phase B. Ownership only moves through claim, renew, complete |
| Crash recovery | `IMPLEMENTED` *(repo-asserted)* | `npm run test:recovery` exists as a separate node test |
| HTTP API | `VERIFIED` *(audited)* | 11 routes: 6 declared directly plus 5 lifecycle routes registered through a `lifecycle()` helper |
| SDK | `IMPLEMENTED` *(audited)* | `src/sdk/client.ts`, exported from the package entry point |
| `maxAgents`, `maxTasks`, `maxRunDurationMs` | `VERIFIED` *(repo-asserted)* | Enforced |
| `maxModelCalls`, `maxToolCalls`, `maxCostUsd` | **`DECLARED`** *(audited)* | Present in the schema, **not enforced**. Deferred to Phase G |

**Under active change.** During this audit `src/api/routes.ts` was modified
while it was being read. AgentOS has since gained `src/api/errors.ts`,
`src/api/rateLimit.ts`, `src/config.ts` and a `RECOVERING` run state, none of
which appear in `docs/architecture/AGENTOS_ARCHITECTURE.md`. Treat the AgentOS
rows above as a snapshot taken on 2026-09-15 and re-audit before relying on
them. The architecture document needs updating to match.

**What is genuinely good:** the source comments state exactly which budget
fields are enforced and which are not. That honesty is the highest-value habit
in this codebase. Propagate it.

**Real gaps.** No executor is wired to ToolOS or ModelOS, so agents coordinate
work that nothing performs. Task ids are unique per run, not globally, which
will matter when Cosmos Core correlates across runs. The three unenforced budget
fields are the seam where ModelOS and ToolOS accounting has to land.

---

## 3. ResearchOS

**Simple meaning:** INVESTIGATE. The most mature system in Cosmos.
**Location:** `~/ResearchOS` | **Runtime:** Node 22.6+, TypeScript, Fastify, SQLite or Postgres
**Shape:** 20 packages across 7 enforced layers, plus `apps/api` and `apps/worker`

Per-package status is maintained in that repo's own README and evidence
document and is not duplicated here. The summary that matters to Cosmos:

| Capability | Status | Cosmos relevance |
|---|---|---|
| Machine-enforced module graph | `VERIFIED` *(audited)* | `architecture.json` plus `lint-architecture.mjs`. **Copy this pattern into every future OS** |
| Memory substrate | `VERIFIED` *(repo-asserted)* | `packages/memory`. **This is MemoryOS in embryo** |
| Model router | `VERIFIED` *(repo-asserted)* | Retry, fallback, circuit breaker, structured output. **This is ModelOS in embryo** |
| Permission-checked tools | `VERIFIED` *(repo-asserted)* | Default-deny, SSRF protection including via redirect |
| Durable orchestration | `VERIFIED` *(repo-asserted)* | Queue, leases, retries, budgets, resumable under worker death. Overlaps AgentOS |
| Evaluation rubric | `VERIFIED` *(repo-asserted)* | 8-dimension, pure, no I/O. Overlaps EvalOS |
| Claims and confidence | `VERIFIED` *(repo-asserted)* | Beta-posterior confidence, contradiction detection |
| Verification harness | `VERIFIED` *(repo-asserted)* | Citation fidelity, numeric checks, scope checks |
| External executor seam | `VERIFIED` *(repo-asserted)* | How a desktop agent attaches without code coupling |
| **Live model call** | **never made** *(repo-asserted)* | Every agent verified against a scripted provider only |
| Search capability | **absent** *(repo-asserted)* | No web search is wired |
| Experiment sandbox | **absent** *(repo-asserted)* | `LocalProcessRunner` is not a sandbox and the repo says so |

**Real gaps, in priority order.** No live model call has ever been made, so
prompt quality and real model behaviour are entirely unmeasured. No search
capability means the research engine has nothing external to research with. No
sandbox means experiments cannot safely run. And it has zero commits.

---

## 4. EvalOS

**Simple meaning:** JUDGE QUALITY.
**Location:** `~/EvalOS` | **Runtime:** Node, TypeScript, Fastify, SQLite

| Area | Status | Notes |
|---|---|---|
| Config, migrations, event bus | `VERIFIED` *(repo-asserted)* | Phase 1 |
| Engine: execution, timeouts, concurrency | `VERIFIED` *(repo-asserted)* | `p-limit` bounded, never unbounded `Promise.all` |
| Built-in evaluators | `VERIFIED` *(repo-asserted)* | ExactMatch, JSON Schema, numeric threshold, status |
| Aggregation and regression detection | `VERIFIED` *(repo-asserted)* | Absolute and relative drop rules |
| Quality gates | `VERIFIED` *(repo-asserted)* | Six comparison operators |
| REST API and SDK | `VERIFIED` *(repo-asserted)* | Suites, datasets, runs, traces. Swagger served |
| Durability | `VERIFIED` *(repo-asserted)* | Write, close, reopen, read |
| Test suite | `VERIFIED` *(repo-asserted)* | 44 of 44 passing |
| **LLM-as-judge** | **`BLOCKED`** *(repo-asserted)* | No API keys. `JudgeProvider` contract exists, no live provider |
| **Adapters to other OSes** | **`DEFERRED`** *(repo-asserted)* | None. AgentOS, ToolOS, ResearchOS, MemoryOS adapters all listed as deferred |
| Comparison persistence | `PLANNED` | Baseline comparisons are computed, not stored |

**The defining gap.** EvalOS is complete and evaluates nothing. It is a
measurement instrument that has never been attached to a subject. The guide says
every major component should send traces to EvalOS; today none do. Closing that
is worth more than any new EvalOS feature.

---

## 5. Cosmos Core

**Status:** `PLANNED`. `~/cosmos` currently contains a marketing website and a
Render deploy config. No coordinator code exists.

Spec: [`specs/COSMOS_CORE_SPEC.md`](specs/COSMOS_CORE_SPEC.md).

---

## 6. MemoryOS and ModelOS

**Status:** `PLANNED`, and both are extractions rather than new builds. See
[`specs/MEMORYOS_SPEC.md`](specs/MEMORYOS_SPEC.md) and
[`specs/MODELOS_SPEC.md`](specs/MODELOS_SPEC.md).

---

## 7. Everything else in the guide

ContextOS, PlanningOS, ExecutionOS, PolicyOS, IdentityOS, ObserveOS,
AutomationOS, ArtifactOS, WorkflowOS, DataOS, ReliabilityOS, CostOS,
CommunicationOS, SafetyOS, KnowledgeOS, ReasoningOS, SkillOS, WorldModelOS,
GoalOS, DecisionOS, ReflectionOS, LearningOS, EvolutionOS, TrustOS, PerceptionOS.

**Status: `DEFERRED`, all of them,** under the promotion rule in section 3 of the
master plan. Each begins life as a module inside whichever system needs it
first. The trigger for reconsidering any one of them is a second independent
consumer, its own durable state, and a contract that has already survived a
change.

This is not pessimism about the vision. It is the only way a solo builder
reaches it.
