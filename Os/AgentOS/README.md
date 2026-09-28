# AgentOS

Agent orchestration, lifecycle, coordination, supervision and execution-control.

AgentOS runs a **graph of tasks** across **agents**, and guarantees the parts that
are hard when more than one process is involved: a task is claimed by exactly one
worker at a time, work survives a crash, cancellation actually stops work, and
every state change is recorded as an ordered, replayable event.

It depends on **no model vendor**. Model, tool and memory access are interfaces
you implement; `examples/` shows how.

---

## Try it in one command

```bash
npm install && npm run demo
```

Then open **http://localhost:4000**.

Type a brief, press **Run pipeline**, and watch three agents — researcher →
analyst → writer — claim tasks, call tools, hand off to each other and produce an
answer. The console shows the live event stream, each task's ownership
(`attempt`, `fence`), and what the run cost.

With no `ANTHROPIC_API_KEY` set the demo uses a deterministic offline stub in
place of a model: **the orchestration, tools, budgets, handoffs and accounting
are real, the reasoning is not.** To use a real model:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run demo
```

`examples/providers/AnthropicModel.ts` is a complete adapter written with
`fetch` and no SDK — the reference for writing your own.

---

## Running it for real

```bash
npm install
npm run build        # REQUIRED before start/worker: both run compiled output
npm start            # HTTP API on :3000
npm run worker       # a headless worker, in another terminal
```

`npm start` with no executor accepts runs and **fails every task** with
`No AgentExecutor configured`. That is deliberate — AgentOS will not silently
run a stand-in. Supply one:

```ts
import { buildServer, GenericLLMAgentExecutor } from 'agentos';

const app = await buildServer({
  executor: new GenericLLMAgentExecutor({ model, tools, agents, usage })
});
```

### Configuration

Every setting is validated at startup; an invalid one is a hard failure, not a
silent default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `DATABASE_URL` | `./agentos.db` | SQLite file path |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, `silent` |
| `AGENTOS_AUTH_TOKENS` | *(empty)* | Comma-separated bearer tokens. Empty = **auth disabled** |
| `AGENTOS_REQUIRE_AUTH` | `false` | `true` makes empty tokens a startup failure |
| `AGENTOS_LEASE_MS` | `30000` | How long a task claim is held before it can be reclaimed |
| `AGENTOS_MAX_BODY_BYTES` | `1048576` | Request body cap |
| `AGENTOS_MAX_TASKS_PER_RUN` | `10000` | Graph size cap |
| `AGENTOS_RATE_LIMIT_ENABLED` | `true` | Fixed-window limiter |
| `AGENTOS_RATE_LIMIT_MAX` / `_WINDOW_MS` | `300` / `60000` | Limit and window |
| `AGENTOS_SHARED_RATE_LIMIT` | `false` | `true` shares the window across workers via the DB |
| `AGENTOS_EVENT_RETENTION_MS` | *(off)* | Prune events of finished runs older than this |

### API

Full OpenAPI at **`/docs`**. Prometheus metrics at **`/metrics`**. Health at `/health`.

| | |
|---|---|
| `POST /v1/agents` | Register an agent definition (`id` + `version`) |
| `GET /v1/agents` | List, filterable by capability |
| `POST /v1/runs` | Create a run and its task graph |
| `POST /v1/runs/:id/start` | Start it. **Creating a run does not start it** |
| `POST /v1/runs/:id/pause` · `/resume` · `/cancel` · `/recover` | Lifecycle |
| `GET /v1/runs/:id` · `/tasks` · `/usage` · `/attempts` · `/instances` | State |
| `GET /v1/runs/:id/events` | Ordered event history (`?afterSeq=`) |
| `GET /v1/runs/:id/events/stream` | SSE, resumable via `Last-Event-ID` |

A minimal run:

```bash
curl -X POST localhost:3000/v1/runs -H 'content-type: application/json' -d '{
  "goal": "example",
  "taskGraph": {
    "tasks": [{
      "id": "t1", "name": "First", "description": "do the thing",
      "agentDefinitionId": "writer", "state": "PENDING",
      "retriesAllowed": 0, "retriesAttempted": 0,
      "input": { "prompt": "hello" }
    }],
    "dependencies": []
  }
}'
```

---

## What it guarantees

- **One owner per task.** Claims are a single conditional `UPDATE`; the winner
  gets a lease and a monotonic **fence**. A late write from a superseded owner is
  rejected rather than overwriting a newer result.
- **Crash recovery.** A worker that dies leaves an expired lease; another worker
  reclaims the task. Verified against real `SIGKILL`, not simulated failure.
- **Cancellation that cancels.** `cancelRun` aborts in-flight work through an
  `AbortSignal` and drains the run's tasks in one transaction.
- **Explainable failure.** Every run has a gap-free, ordered event sequence with
  correlation ids, per-attempt history and usage accounting.
- **Budgets that hold across workers.** Model/tool call ceilings are reserved
  inside the `UPDATE`, not read-then-acted.

## Verification

```bash
npm run verify     # build + typecheck + lint + test + crash-recovery
```

`tests/certification.test.ts` maps every claim above to the test that proves it
and fails if a proving test is renamed, skipped or removed.

## Architecture

[AGENTOS_ARCHITECTURE.md](./docs/architecture/AGENTOS_ARCHITECTURE.md) ·
[WIRING_MAP.md](./docs/architecture/WIRING_MAP.md)

> These describe v0.1 and have not been updated for the current persistence,
> claim-protocol, observability or agent-runtime layers. The contracts in
> `src/persistence/contracts.ts` and `src/providers/contracts.ts` are the
> accurate reference.
