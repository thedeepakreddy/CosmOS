# ResearchOS v0.1 — Final Certification Report

**Date:** 2026-09-15
**Scope:** an independent reality check of the built tree. No feature was added,
no external project was touched, and the repository is uncommitted.

## Evidence standard applied

Per §1, none of the following counts as verification on its own: a file exists,
an interface exists, a test exists, or an earlier report said it passed. Every
`VERIFIED` below rests on an observation made during this check, against the
built tree, with the command and its result recorded. Where something could not
be observed here, it is `BLOCKED` or `IMPLEMENTED_BUT_UNVERIFIED` — not
`VERIFIED`, and not quietly omitted.

## Environment

| | |
|---|---|
| Path | `/Users/thedeepakreddy/ResearchOS` |
| Node | v26.8.2 |
| npm | 11.19.1 |
| OS | Darwin 25.3.0 arm64 (macOS 26.3) |
| Git | 0 commits, 0 tags, branch `main`, nothing staged |

Clean install from `package-lock.json`: `npm ci` exit 0, 192 packages, all 22
`@research-os/*` workspace links present.

## Gates

| Command | Exit | Result |
|---|---|---|
| `npm run build` | 0 | all 22 workspaces emit |
| `npm run typecheck` | 0 | src and tests |
| `npm run lint` | 0 | ESLint 10, type-aware |
| `npm run lint:arch` | 0 | `Architecture OK — 22 workspaces, layering intact.` |
| `npm test` | 0 | `tests 454 / suites 86 / pass 454 / fail 0 / cancelled 0 / skipped 0 / todo 0` |
| `npm run verify` | 0 | full gate |

Re-run after the documentation edits in this pass: all six still exit 0, 454/454.

## §29 Certification table

| # | Area | Status | Evidence |
|---|---|---|---|
| — | Build, typecheck, lint, architecture, tests | `VERIFIED` | six gates, each exit 0, counts above |
| — | Module graph | `VERIFIED` | independent audit: 22 workspaces, 77 cross-package import edges, **0 problems**; 22 tsconfig project references |
| — | Task coverage | `VERIFIED` | read from runtime objects: 18 declared, 18 handled, `declared − handled = ∅`, `handled − declared = ∅` |
| — | Full vertical slice | `VERIFIED` | 15 ticks, settled `completed`, 18/18 tasks, 17 distinct task types; 2 sources, 3 evidence, 2 claims, 5 links, 1 contradiction, 1 debate (verdict `qualify`, agreement 0.55, 1 dissent), 2 hypotheses, 4 questions, 1 experiment, 1 transferable failure, 10 verification checks, report v1 |
| — | Event integrity | `VERIFIED` | 49 events, 22 distinct types, 0 invalid envelopes, 0 invalid payloads, 0 undeclared types, 0 invalid ids, sequence gapless |
| — | Hostile model output | `VERIFIED` | fabricated quote → `citation_fidelity` FAILED, `verificationPassed: false`; invented passage index → dropped; all-invented citations → claim discarded; malformed JSON → 2 repair prompts |
| — | Report provenance | `VERIFIED` | 2 findings, 0 without evidence, 0 not reaching a real source, 0 citations missing sources, 0 ghost evidence; both citations carry url + accessedAt; 1 of 1 contradictions carried into the report |
| — | Confidence reproducibility | `VERIFIED` | both claims recomputed **exactly**: `0.425700 = 0.425700` (α 1.6797, β 2.26644) and `0.446000 = 0.446000` (α 1.696, β 2.106576) |
| — | Replication counting | `VERIFIED` | attempt 1 baseline `matched=null`, attempt 2 `matched=true`, summary `replications=1` computed **after** marking, score 1, variance reported |
| — | Evaluation | `VERIFIED` | grade `unsound`, overall 0.814 across 8 applicable dimensions, blocker "1 quotation(s) could not be found in the source they cite" |
| — | Both persistence engines | `VERIFIED` | SQLite and real PostgreSQL (PGlite): tenant isolation passes on both; JSON scalars round-trip for `"a plain string…"`, `"42"`, `"true"`, `'{"looks":"like json"}'`, `""` and nested structures. Total failures: 0 |
| §14 | Process durability / resumability | `VERIFIED` | two real OS processes (pid 86167, then 86181 after the first had exited), one SQLite file. Abandoned lease requeued (`attempts: 2`); the task process #1 completed was **not** re-executed and still reads `doneBy: "process-1"`; all tasks terminal, no lease held |
| §15 | API + SDK over a real socket | `VERIFIED` | 28 checks. Negative control first: SDK to an unused port fails `provider_unavailable` before the server exists; the same port then serves the real spawned `node apps/api/src/main.ts` (pid 86452). No `Fastify.inject` anywhere |
| §16 | SSE | `VERIFIED` | 1 replayed + 3 live on one open connection; sequence strictly increasing 1..5; **0 duplicates, 0 gaps** at the replay→live handoff; `?since=3` and `Last-Event-ID: 3` both return exactly 4,5; frames carry `id:`/`event:`/`data:` |
| §17 | API contract | `VERIFIED` | invalid body → 400 naming both fields; unknown project → 404; unknown route → 404; missing and wrong bearer → 401; malformed JSON → 400 blamed on the client. 3 error bodies inspected: no stack frames, no API key, no `SQLITE_`/`SQLSTATE`, no absolute paths, no `ANTHROPIC_API_KEY` |
| §18 | Model router | `VERIFIED` | 25 checks: determinism, capability and context-window constraints, loud failure on unsatisfiable constraints, retry only when retryable, every attempt in the ledger, fallback, breaker that demotes rather than removes, structured output repaired twice then failing rather than coerced, cost from real tokens and real rates, independence honestly reported, budget pressure reordering without filtering, protected kinds never downgraded at 99% pressure |
| §19 | Live model | `BLOCKED` | `ANTHROPIC_API_KEY` **not set**; `RESEARCH_OS_MODEL_PRICING` **not set**; no `.env` exists — only a fully commented `.env.example`. Only these two documented variables and the project's own example file were inspected. The live path is wired (`anthropicProviderFromEnv({})` → `undefined`; `new AnthropicProvider({apiKey:""})` → `validation_failed` naming the variable) but **no live call has ever been made** |
| §20 | Search | `VERIFIED` (correct refusal) | no `web_search`/`academic_search` tool registered. Discovery returns a non-retryable failure, `errorCode: unsupported`, message beginning `BLOCKED:` and stating research "will not answer from model recollection". 0 sources, 0 follow-ups. Supplying URLs directly still works (2 discovered, 2 follow-ups) |
| §21 | Tool permission security | `VERIFIED` | tool id, capability and risk level all required; filesystem with no granted root denied; blocklist beats allowlist and covers subdomains; 8/8 SSRF probes refused (loopback, `localhost`, `169.254.169.254`, `10/8`, `192.168/16`, `[::1]`, `file://`, `gopher://`) while a public URL is allowed; a blocked-host call still spends the call budget |
| §22 | Experiment safety | `VERIFIED` | default runner refuses: `exitCode: null`, `BLOCKED:` message, **no metrics, no artifacts, no stdout**. `LocalProcessRunner` refuses construction without `acknowledgeUnsandboxedExecution: true`, and **was not constructed during this audit**. Production runtime never mentions it; a runnerless engine reports the gap |
| §24 | Parallel-worker contention | `VERIFIED` (SQLite) / `IMPLEMENTED_BUT_UNVERIFIED` (Postgres) | 6 separate OS processes, 200 tasks, 1 task per claim → 200 claims of 200 distinct tasks, **0 claimed twice**, 0 with attempts > 1, 200 completed, 0 errors. A 4-process/120-task run matched. On Postgres the `FOR UPDATE SKIP LOCKED` statement executes correctly and two sequential claims take disjoint sets, but PGlite is a single in-process connection, so genuine multi-process contention there is **not** proven |
| §25 | Production test-double isolation | `VERIFIED` | live runtime constructs `InMemoryEventBus`, `SqliteDatabase`, `LocalToolProvider(WebFetchTool)`, `UnconfiguredModelProvider` — **zero** test doubles. Neither application source tree nor `runtime.ts` names one. Doubles are reachable in the module graph (they are exported for other packages' tests) but never instantiated |
| §26 | Placeholder / dead wiring | `VERIFIED` with findings | 162 files swept: 0 `TODO`, 0 `FIXME`, 0 `XXX`, 0 `HACK`, 0 `@ts-ignore`/`@ts-expect-error`. 0 unreachable routes (4/4 modules registered, 26 routes), 0 SDK endpoints without a route (17/17), 0 unregistered handlers. **Findings:** `GraphRepository`/`store.graph` is fully dead; 18 repository methods are never called; `EventsQuery.types` is unvalidated `string[]`; event payloads are not schema-checked at the persistence boundary; `apps/web/` is an empty leftover |
| §27 | Documentation consistency | `VERIFIED` | five stale statements corrected in the previous-limitation/current-status form; historical milestone records left intact |
| §28 | External project isolation | `VERIFIED` | 0 references to Echo/Aira/AgentOS/ToolOS/EvalOS/MemoryOS in **code** — all are comments, descriptions or docs, which the architecture linter permits and enforces. No `file:`/`link:` dependency leaves the repo. Only non-workspace imports: `zod`, `fastify`, `@fastify/cors`, `node:*`. **No file under `AgentOS`, `EvalOS` or `ToolOS` was modified** |

## §26 findings in full

Recorded, **not fixed** — this pass adds no features.

1. **`GraphRepository` is dead wiring.** Constructed on every store as
   `store.graph`; `store.graph` appears nowhere in `packages/`, `apps/` or
   `tests/`. Its `graph_nodes`/`graph_edges` tables are created by
   `001-initial-schema` and never written. The graph the API serves is projected
   on demand from relational tables by `buildProjectGraph`. 5 methods, 0 call
   sites, 0 coverage direct or indirect.
2. **Event payloads are not validated at the persistence boundary.**
   `EVENT_PAYLOADS` and `parseEvent` exist, and `emit()` is now typed to a
   declared `EventType` — but `SqlEventStore.append` casts `input.payload as
   never` and `read` casts the row payload the same way. The 49 events emitted in
   the vertical slice were all valid when re-parsed, so this is currently a
   consequence of correct handlers rather than a property the store enforces.
3. **`EventsQuery.types` is `z.array(z.string())`, not `z.array(EventType)`.**
   The API accepts an undeclared event type as a filter and silently returns an
   empty page instead of a 400. Two `as never` casts in `routes/events.ts` exist
   only to bridge this.
4. **18 repository methods are never called** from outside the repository layer —
   unused surface area, not incorrect code.
5. **`apps/web/` contains one empty `public/` directory** and is not a workspace.
   Already recorded as `NOT_FOUND` at recovery; still present.
6. **Residual weakness carried forward from the slice.** Fabricated evidence is
   auto-linked to a claim by word overlap in `claim.link_evidence`, contributes
   support weight to that claim's `contributions`, and the claim — correctly
   downgraded to `insufficient_evidence` — still appears under
   `report.keyFindings`. It is **not silent**: the finding carries the text "The
   quoted text does not appear in the cited source, and no passage resembles it
   (best overlap 7%)", confidence 0.446, and the project evaluation grades the
   whole run `unsound`. But `ReportFinding` has no status field, so the
   `insufficient_evidence` label itself is not shown to a reader.

## §30 Certification verdicts

These are two separate judgements. A blocked live-model certification is **not**
a failure of the scripted core.

### SCRIPTED-CORE CERTIFICATION — **PASS**

Every layer from foundation to applications is built, wired, and verified by
observation against the built tree. Six gates green. A full research run executes
end to end across 18 task types and produces a report whose every finding traces
to real evidence and a real source. Confidence recomputes exactly from stored
inputs. Fabricated quotations, invented passages and malformed output are caught,
and the run that contains one is graded `unsound`. Work survives a process exit
and is not executed twice. Six concurrent OS processes cannot claim the same task.
The API, SDK and event stream work over a real socket with correct status codes
and no leakage. Permission and SSRF paths refuse everything they should. No test
double reaches production. The named §26 findings are real but none of them
causes the system to assert something untrue.

### LIVE-MODEL CERTIFICATION — **BLOCKED**

No `ANTHROPIC_API_KEY` and no `RESEARCH_OS_MODEL_PRICING` exist in this
environment, and no `.env` file is present. **No live model call has ever been
made from this codebase.** `AnthropicProvider`'s response mapping, its error
classification, its real token and cost figures, and the quality of every agent
prompt against a real model are therefore unproven. This is a blocked
certification, not a failed one: the seam is wired, it refuses correctly when
unconfigured, and it names exactly what is missing. It becomes verifiable the
moment someone sets those two variables and calls `provider.healthCheck()`.

## Also unproven here

- Multi-process contention on **PostgreSQL** (PGlite is single-connection).
- Search: none ships; discovery correctly reports `BLOCKED`.
- Experiment execution: no sandbox; the default runner correctly refuses.
- ToolOS and Echo integration: the seams exist and are exercised by a test
  executor, but neither product's API is available in this workspace.

## Repository state at the end of this report

Unchanged from the start except the two documentation files edited in this pass.
**0 commits, 0 tags, nothing staged, no git initialisation performed.**

---

# Addendum — test UI added after certification, 2026-09-15

The tree no longer matches the fingerprint recorded above. This section says
exactly what changed and what did not, so the certification does not quietly
become untrue.

## What was added

| File | Purpose |
|---|---|
| `apps/web/server.mjs` | dependency-free static server for the test UI, proxying `/api/*` and `/health` to the API |
| `apps/web/public/index.html` | the UI itself — one file, no build step, no CDN |
| `scripts/demo.mjs` | launches API + UI together, in unconfigured or live-Anthropic mode |
| `package.json` | three new scripts: `web`, `demo`, `demo:live` |
| `eslint.config.mjs` | lints `apps/web/**/*.mjs` as an operational script; adds `URL` to that block's globals |

`apps/web` is deliberately **not** a workspace: it is absent from
`architecture.json`, from the root `package.json` `workspaces` array and from
`tsc -b`'s 22 project references. It cannot be imported by the platform and
cannot appear in a published package. The §26 finding recording `apps/web/` as
an empty leftover is therefore superseded in fact — the directory now holds the
test UI — while the finding that it is not a workspace still stands, now by
design rather than by accident.

## What did not change

All **249** files of the certified core — every file under `packages/`,
`apps/api/`, `apps/worker/`, `tests/` and `docs/`, plus `architecture.json`,
`package-lock.json` and every `tsconfig` — are **byte-for-byte identical** to the
certified state. The gates were re-run after the addition:

| Gate | Exit | Result |
|---|---|---|
| `npm run build` | 0 | |
| `npm run typecheck` | 0 | |
| `npm run lint` | 0 | |
| `npm run lint:arch` | 0 | `Architecture OK — 22 workspaces, layering intact.` |
| `npm test` | 0 | 454/454 |
| `npm run verify` | 0 | |

Workspace count is still 22. The UI adds no twenty-third.

## A limitation of the API that the UI had to work around

`GET /api/v1/research/projects/:id/events/stream` writes its response headers
with `reply.raw.writeHead()`, which **bypasses Fastify's CORS hook**. Measured
directly:

```
normal API response, Origin: http://127.0.0.1:5173
  access-control-allow-origin: http://127.0.0.1:5173
SSE response, same Origin
  (no access-control-allow-origin header at all)
```

So a browser on any other origin can call every REST endpoint but cannot read
the event stream, whatever `RESEARCH_OS_CORS_ORIGINS` is set to. The UI avoids
this by serving the API under its own origin through a proxy, which needs no
CORS configuration at all and required no change to the API.

**Status: `KNOWN FINDING`, not fixed.** Recorded here alongside the §26 findings
as a candidate for v0.1.1.

## Live-model routing — partially upgraded

`LIVE-MODEL CERTIFICATION` remains **BLOCKED**: no valid key exists here and no
successful live call has been made. One thing previously unproven is now proven.

A single request was sent to Anthropic with a deliberately invalid key, with
`ANTHROPIC_BASE_URL` explicitly cleared so that the host's Claude Code endpoint
and credentials were not involved:

```
provider name   : anthropic
models offered  : claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001
routes planning → anthropic/claude-opus-5   (fallback: claude-sonnet-5)

  code     : provider_error
  status   : 502
  retryable: false
  message  : Anthropic rejected the credentials: 401
             {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}
```

A 401 from Anthropic can only be produced by a request that was built, sent over
the network and answered by Claude's API.

| Aspect of the live path | Status |
|---|---|
| Provider construction, model catalogue, pricing gate | `VERIFIED` |
| Routing a task kind to a real Anthropic model + fallback | `VERIFIED` |
| Request reaching Anthropic over the network | `VERIFIED` |
| Authentication-failure classification (401 → non-retryable `provider_error`) | `VERIFIED` |
| **Success-path response mapping** | `IMPLEMENTED_BUT_UNVERIFIED` |
| **Real token counts and cost figures** | `IMPLEMENTED_BUT_UNVERIFIED` |
| **Agent prompt quality against a real model** | `IMPLEMENTED_BUT_UNVERIFIED` |

The overall verdict is unchanged. Routing to Claude is proven; getting a useful
answer back from Claude is not.

---

# Addendum 2 — Gemini provider added, 2026-09-16

Unlike the test UI, this change reaches **inside** the certified core. Recorded
plainly so the certification above is read with it.

## What changed

| File | Change |
|---|---|
| `packages/model-router/src/gemini-provider.ts` | **new** — `GeminiProvider`, `geminiProviderFromEnv` |
| `packages/model-router/test/gemini.test.ts` | **new** — 29 tests, no network |
| `packages/model-router/src/catalog.ts` | `GEMINI_MODEL_SPECS` added; Anthropic specs untouched |
| `packages/model-router/src/index.ts` | one export line |
| `packages/research-core/src/runtime.ts` | `geminiApiKey` on `RuntimeConfig`; provider registration made additive |
| `.env.example`, `package.json`, `eslint.config.mjs` | configuration and one npm script |

Seven of 251 certified files changed; the other 244 are byte-identical. No
contract, schema, handler, repository, orchestration or API file was touched.

Gates after the change: `build` 0, `typecheck` 0, `lint` 0, `lint:arch` 0
(`Architecture OK — 22 workspaces, layering intact.`), `test` 0 with **483 tests
/ 92 suites / 483 pass / 0 fail** (454 before, plus the 29 new), `verify` 0.

**No new dependency.** The adapter speaks the Generative Language REST API over
`fetch`, so `architecture.json`'s `external` list for `model-router` is
unchanged and `package-lock.json` is byte-identical.

## One `else if` became a loop, and it mattered

Provider registration previously stopped at the first configured vendor. It now
registers each independently, because two vendors is not merely additive:
independent verification requires a second *provider*, and a review by the
vendor that wrote the artifact is a self-review the router already reports as
one. Measured through `buildRuntime`:

| Configuration | Providers | Capability gaps |
|---|---|---|
| no keys | `unconfigured` | 4 |
| `GEMINI_API_KEY` only | `gemini` | 3 — *embedding gap closed* |
| `GOOGLE_API_KEY` only | `gemini` | 3 |
| both vendors | `anthropic, gemini` | 2 — *embedding and independence both closed* |

`gemini-embedding-001` is the only embedding model in either catalog, so a
Gemini deployment has hybrid retrieval where an Anthropic-only one is
lexical-only. Independence, measured directly:

```
gemini only   : requested=true achieved=false chosen=gemini      (self-review, reported)
gemini+claude : requested=true achieved=true  chosen=anthropic   (genuinely independent)
```

## Live routing to Gemini — same standard of proof as Claude

A single request was sent to Google with a deliberately invalid key:

```
provider name  : gemini
models offered : gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-embedding-001
routes planning   → gemini/gemini-2.5-pro         (fallbacks: 2.5-flash, 2.5-flash-lite)
routes extraction → gemini/gemini-2.5-flash-lite  (cheapest capable)
routes judgment   → gemini/gemini-2.5-pro
budget pressure 0.95: extraction downgrades, judgment does not   (protected kind)

  code     : provider_error
  retryable: false
  message  : Gemini rejected the request: API key not valid. Please pass a valid API key.
```

That message is Google's own, returned over the network — the request was built,
sent and answered.

| Aspect of the Gemini path | Status |
|---|---|
| Provider construction, catalogue, pricing gate | `VERIFIED` |
| Routing by task kind, fallback ordering, protected kinds | `VERIFIED` |
| Request reaching Google over the network | `VERIFIED` |
| Rejection classified as final rather than retried | `VERIFIED` |
| Request/response mapping — roles, system prompt, usage, tool calls, refusals | `VERIFIED` (29 tests, stubbed transport) |
| **Success-path response from a real key** | `IMPLEMENTED_BUT_UNVERIFIED` |
| **Real token counts and cost figures** | `IMPLEMENTED_BUT_UNVERIFIED` |
| **Embeddings against the live endpoint** | `IMPLEMENTED_BUT_UNVERIFIED` |
| **Agent prompt quality against a real model** | `IMPLEMENTED_BUT_UNVERIFIED` |

**LIVE-MODEL CERTIFICATION remains `BLOCKED`** — for Gemini exactly as for
Anthropic. No valid key for either vendor exists here, and no successful live
call has been made from this codebase.

## One imprecision worth naming

Google returns **HTTP 400** for an invalid API key, where Anthropic returns 401.
The adapter therefore words that failure "Gemini rejected the request" rather
than "rejected the credentials". The *classification* is right either way —
non-retryable, so the router does not burn budget re-asking — but the wording is
less specific than it could be. Matching on Google's `API_KEY_INVALID` reason
string would fix the wording at the cost of depending on a vendor's message
text. Left as-is, recorded here.

---

# Addendum 3 — blocked discovery stalls its dependents, 2026-09-16

A defect found by running the demo, not by the test suite.

## What happens

A plan hangs `evidence.extract` off `source.discover`, and everything else off
that. With no search tool registered, discovery returns `BLOCKED` — which is a
**`failed`** task. The claim query admits a task only when every dependency is
`completed`:

```sql
NOT EXISTS (SELECT 1 FROM task_dependencies d
            JOIN tasks dep ON dep.id = d.depends_on_task_id
            WHERE d.task_id = tasks.id AND dep.status <> 'completed')
```

So every step behind discovery becomes permanently unclaimable. Observed:

```
plan.create      completed
source.discover  failed     BLOCKED: no tool providing web_search or academic_search
evidence.extract pending    ← forever
claim.extract    pending    ← forever
report.generate  pending    ← forever
project status : running    claims: 0    report: NONE
```

Supplying source URLs through `POST /evidence` does **not** rescue it: those
create standalone `source.ingest` tasks outside the plan graph. The corpus
ingests correctly and nothing consumes it, because the step that would is
waiting on discovery.

## Why 483 passing tests did not catch it

`vertical-slice.test.ts` registers a `FixedSearchTool`, so discovery always
succeeds there. The one test covering blocked discovery builds a **single task
with no dependents** and asserts only its error message and attempt count. The
suite therefore proves that discovery refuses honestly, and never proves what
becomes of the rest of the run when it does. **Status: `KNOWN FINDING`.** The
gap is in coverage, not in the assertions that exist.

## What was done

The demo registers a `supplied_corpus` tool through `BuildRuntimeOptions.extraTools`
— the documented seam — which answers discovery with the URLs the caller
supplied and nothing else. Its descriptor says so in terms a reader cannot
mistake: *"This is NOT a web search: it discovers nothing, reaches no search
engine, and can only surface what was already provided."* It does not filter by
the query, because ranking a caller-supplied list against a model-written query
would invent a relevance signal that does not exist and every downstream
confidence number would inherit it.

Measured through `buildRuntime` with a scripted model and two real Wikipedia
URLs:

```
plan.create      completed
source.discover  completed     ← was failed
source.ingest    completed  ×2
evidence.extract completed     ← was permanently unclaimable
claim.extract    completed
claim.score      completed
sources: 2   evidence: 1
```

Every stage is now reached and runs. No certified package changed: the tool and
its launcher live in `scripts/`, and `apps/api` is untouched.

## What this does not fix

The underlying orchestration behaviour is unchanged and still applies to any
deployment without a search tool. A blocked dependency still strands everything
behind it, silently — the project sits in `running` with no runnable work, no
report, and no event saying why. Two things worth considering, neither attempted
here because both are real design decisions rather than repairs:

- a run with no reachable work left should reach a terminal state and say what
  stranded it, instead of idling in `running` indefinitely;
- a report generated from partial evidence, explicitly labelled as partial, may
  be more useful than no report at all — but that is a judgement about research
  integrity, not a bug fix.

---

# Addendum 4 — Gemini wired, live run achieved, 2026-09-16

The largest change since certification, and the first time this codebase has
produced research from a live model.

## Read this before treating the certification above as current

Nine certified files have changed, five of them source:

| File | Change |
|---|---|
| `packages/model-router/src/router.ts` | **shared routing** — `jsonSchema` added to `CompleteRequest` and forwarded in `#callProvider`; `structured()` converts the zod schema |
| `packages/model-router/src/catalog.ts` | `GEMINI_MODEL_SPECS`, twice — ids now read from the live API |
| `packages/model-router/src/gemini-provider.ts` | **new** adapter + schema narrowing |
| `packages/research-core/src/runtime.ts` | provider registration made additive |
| `packages/research-core/src/agents/research-director.ts` | **planner prompt** — changes every plan written |
| `.env.example`, `package.json`, `eslint.config.mjs`, this file | configuration |

The frozen fingerprint `8289bb43…` no longer describes this tree. The honest
description of the current state is **"v0.1 certified, plus the changes below"**
— not "v0.1 certified".

## Four defects found only by a live call

None was visible to the test suite, which was green throughout.

1. **Stale model ids.** `gemini-2.5-*` were written from documentation. They
   still appear in `ListModels` but `generateContent` answers *"no longer
   available to new users"*. Listing is not callability. Ids and token limits
   now come from the live API, and `-latest` aliases are preferred so the list
   does not go stale again.
2. **`jsonSchema` was dropped in transit.** `structured()` computed it;
   `#callProvider` rebuilds the request field by field and never copied it.
   Native structured output was therefore dead code in every provider. Gemini
   returned `objectives: ["…"]` where the schema wanted objects, burned two
   repair rounds and failed. After the fix: `repairs=0` first try.
3. **Gemini rejects value constraints.** `minimum`, `maxLength`, `minItems` and
   friends make it 400 the entire request rather than ignore them. Measured
   empirically, then stripped. Safe: they constrain decoding only, and the
   result is still validated against the real zod schema.
4. **The prompt told the planner to plan an ingest step.** It said "Evidence
   extraction depends on ingestion", so a live model planned `source.ingest` —
   which has no URL, fails, and stranded the run. Ingestion is scheduled by
   discovery; the prompt now says so and the step type is off the plannable list.

## The live run

Question: *does teaching to a preferred learning style improve outcomes?* Two
Wikipedia URLs supplied as the corpus.

```
plan.create · source.discover · source.ingest ×2 · evidence.extract
claim.extract · claim.link_evidence · contradiction.detect · report.generate
                                                       all completed

2 sources · 13 evidence · 4 claims · report v1
```

The report's conclusion is substantively correct — the evidence contradicts the
meshing hypothesis — with an executive summary, methodology, four findings and a
citation carrying url and access date.

**LIVE-MODEL CERTIFICATION for Gemini: the success path is now `VERIFIED`.**
Anthropic's remains `IMPLEMENTED_BUT_UNVERIFIED`; no valid Anthropic key exists
here. One run, one question, one model is evidence, not a guarantee.

**Confidence in that report reads 0.000**, because the plan omitted
`claim.score` and `verification.run`. Claims sit at `proposed` and ResearchOS
reports 0 rather than inventing a number. Correct behaviour; also a real limit
on what this run proves — the scoring, verification, debate and evaluation
stages have still never run against a live model.

## Tests added for the changes

Previously: the router forwarding had **0** tests, the planner guidance **0**,
the narrowing **0**. Now 497 tests / 95 suites, up from 483 / 92.

- **`router.test.ts` — "structured output reaches the provider"** asserts the
  schema arrives at the provider, that the nested object-in-array shape
  survives, that a repair round still carries it, and that a plain `complete()`
  carries none. The original bug was silent precisely because nothing looked at
  the far end of the pipe.
- **`gemini.test.ts` — "schema narrowing"** asserts every keyword Gemini rejects
  is stripped at any depth, and that the structural shape survives.
- **`research-director.test.ts`** asserts `source.ingest` is not offered as a
  plannable step, that the prompt says why, and that every other handled type
  remains. It also asserts that `DirectorPlanOutput` still *accepts* any task
  type — the prompt is the only guard, and that gap is now visible rather than
  assumed away.
- **`orchestration.test.ts` — "a failed dependency permanently strands every
  task behind it"** documents the defect from Addendum 3 rather than fixing it,
  including the contradiction that makes it hard to diagnose: the queue reports
  `hasRunnableWork = true` while `claim()` returns nothing.

## Still open

- **The dependency stall is unfixed.** Two triggers were removed; the mechanism
  is untouched. A stranded run still idles in `running` with no terminal state
  and no event explaining why.
- **The six §26 findings** stand, except `apps/web`, which now holds the test UI.
- **SSE carries no CORS headers** (Addendum 2); the UI proxies around it.
- **One live run is not a sample.** Scoring, verification, debate and evaluation
  have never run live.
- **The narrowing keyword set is empirical**, derived from one model on one day.
  Another model or a later API version may reject more.
