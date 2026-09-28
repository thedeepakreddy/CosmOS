# ResearchOS

A reusable research intelligence platform. ResearchOS conducts structured
research — plan, gather evidence, extract claims, criticise, verify, experiment,
synthesise, report — and keeps every conclusion traceable to the source it came
from.

It is a standalone system with an API, not a feature of any product. Applications
attach through contracts; ResearchOS never imports them.

```text
                   Applications
                        │
                        ▼
                   ResearchOS            ← research and reasoning
                        │
       ┌────────────────┼────────────────┐
       ▼                ▼                ▼
   Memory layer      Tool layer      Model APIs
                        │
                        ▼
                External executors       ← browser, filesystem, terminal, Python
```

## Status

**All five phases are built. 454 tests pass. No live model call has ever been
made from this codebase** — every agent is verified against a scripted provider,
which proves the wiring and the contracts but not what a real model does with
these prompts.

For what is actually true about this codebase — with the command that
demonstrates each claim, and a plain list of what it cannot do — see
[`docs/evidence/IMPLEMENTATION_EVIDENCE.md`](docs/evidence/IMPLEMENTATION_EVIDENCE.md).

| Layer | Package | Status |
|---|---|---|
| 0 | `shared` | implemented |
| 1 | `contracts` | implemented — the full domain model in zod |
| 2 | `observability` | implemented |
| 2 | `events` | **verified** — gapless sequences, resumable streams |
| 2 | `sdk` | **verified** — the API suite drives the server through it |
| 3 | `persistence` | **verified** — 34 tables, dual dialect, durable task queue |
| 3 | `model-router` | **verified** — retry, fallback, circuit breaker, structured output |
| 3 | `tools` | **verified** — default-deny permissions, SSRF protection |
| 3 | `evidence` | implemented, exercised through `claims` |
| 3 | `knowledge-graph` | **verified** — provenance traversal, research evolution |
| 3 | `experiments` | **verified** — runner port, reproducibility, `BLOCKED` by default |
| 4 | `claims` | **verified** — Beta-posterior confidence |
| 4 | `memory` | **verified** on both engines |
| 4 | `retrieval` | **verified** — BM25 + rank fusion |
| 4 | `ingestion` | **verified** — offset-exact chunking |
| 4 | `executors` | **verified** — the external execution seam |
| 5 | `verification` | **verified** — citation fidelity, numeric, scope |
| 5 | `evaluation` | **verified** — 8-dimension research-quality rubric, pure |
| 5 | `orchestration` | **verified** — including resumability under worker death |
| 6 | `research-core` | **verified** — 11 agents, all 18 task handlers, end-to-end slice |
| 7 | `apps/api` | **verified** — `/api/v1`, SSE, executors, health |
| 7 | `apps/worker` | implemented — the same engine without HTTP |

What the project still cannot do — no search capability, no experiment sandbox,
no live model call — is listed in full at the end of
[`IMPLEMENTATION_EVIDENCE.md`](docs/evidence/IMPLEMENTATION_EVIDENCE.md).

## Getting started

Node 22.6+ is required. No other infrastructure is needed — the default database
is a SQLite file, using the driver that ships with Node.

```bash
npm install
cp .env.example .env
npm run migrate
npm run verify
```

`npm run verify` is the project's definition of done: typecheck, lint,
architecture lint, and the full test suite.

To start the API — it runs a worker in the same process by default:

```bash
npm run start:api
```

It starts without a model key and reports what it cannot do:

```bash
curl -s localhost:8080/health | jq '.status, .gaps'
```

Then create a project and follow it:

```bash
curl -s -X POST localhost:8080/api/v1/research/projects -H 'content-type: application/json' -d '{"question":"Does persistent memory improve agent recall?","autoStart":true}'
```

## Design commitments

Four things this codebase will not trade away.

**Provenance is not optional.** A claim points at evidence, which points at a
source, which carries the URL, retrieval time and content hash it was fetched
with. A model-generated statement is never allowed to look like a source-derived
fact.

**The architecture is enforced, not documented.** `architecture.json` declares
the module graph; `scripts/generate-workspaces.mjs` generates every manifest
from it and `scripts/lint-architecture.mjs` fails the build when an import, a
manifest or a tsconfig drifts from it — or when a client product's name appears
anywhere in the reusable core.

**Nothing is claimed without evidence.** A status of `VERIFIED` in the docs means
code, wiring, and an execution that was observed. A file existing proves nothing.

**Agents are untrusted actors.** Every tool call passes a default-deny permission
check, a per-task budget and an audit record. A model that has read a hostile
document and asks to fetch `169.254.169.254` is refused — including when it
arrives there via a redirect from somewhere allowed.

**A run that cannot finish produces nothing.** As a run approaches a budget
ceiling, routing trades model strength for reach so it ends with a weaker answer
rather than an exhausted budget and no report. The work that decides what the
research concludes — judgment, synthesis, verification — is never downgraded, and
every downgrade that does happen is recorded.

## Repository layout

```text
architecture.json      the module graph — source of truth for dependencies
external-versions.json pinned external versions, one place to bump
packages/              20 workspaces, layers 0–6
apps/                  api and worker (layer 7)
scripts/               workspace generation, architecture lint, migrations
tests/support/         shared fixtures, a real Postgres engine for tests
docs/
  recovery/            recovery audit and continuation log
  evidence/            what is actually verified, and how
  architecture/        wiring map — real execution paths
```

## Documentation

- [Recovery audit](docs/recovery/RESEARCHOS_RECOVERY_AUDIT.md) — how the project stood when this session inherited it
- [Continuation log](docs/recovery/CONTINUATION_LOG.md) — what each session changed and verified
- [Implementation evidence](docs/evidence/IMPLEMENTATION_EVIDENCE.md) — claims with the commands that back them
- [Wiring map](docs/architecture/WIRING_MAP.md) — execution paths in real filenames
