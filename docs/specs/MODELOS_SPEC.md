# ModelOS Build Spec

**Simple meaning:** CHOOSE THE BRAIN.
**Roadmap stage:** 4.
**Approach:** extraction from `ResearchOS/packages/model-router`, not a new build.

---

## 1. Why this stage matters more than the others

From the ResearchOS README:

> *"No live model call has ever been made from this codebase. Every agent is
> verified against a scripted provider, which proves the wiring and the
> contracts but not what a real model does with these prompts."*

That is an unusually honest sentence and it names the largest unknown in the
whole project. Eleven agents, eighteen task handlers, a debate engine and a
report builder have never met a real model.

ModelOS is not primarily an architecture task. It is the task that finally
tells you whether the intelligence layer works. Plan for the prompts to be the
hard part, not the plumbing.

---

## 2. Definition of done

> One ResearchOS research project runs end to end against a live model through
> ModelOS and produces a report with real citations, and the `ModelCallRecord`
> ledger shows real token counts, real latency and real cost.

Not "ModelOS responds to a curl". The consumer has to complete real work.

---

## 3. The port already exists

`ResearchOS/packages/model-router/src/provider.ts`:

```ts
interface ModelProvider {
  readonly name: string;
  readonly models: readonly ModelDescriptor[];
  generate(request: GenerateRequest): Promise<ModelResponse>;
  stream?(request: GenerateRequest): AsyncIterable<ModelStreamChunk>;
  embed?(request: EmbedRequest): Promise<EmbeddingResponse>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

The router around it already implements retry, fallback, circuit breaking and
structured output, all verified. It also already emits a complete accounting
record:

```ts
interface ModelCallRecord {
  provider, model, taskKind,
  inputTokens, outputTokens, cachedInputTokens,
  costUsd, latencyMs, stopReason,
  succeeded, errorMessage, attempts
}
```

**Consequence worth stating plainly: CostOS is not a service.** It is this
record, persisted, plus a few queries. Do not build a CostOS. Build a
`/v1/usage` endpoint on ModelOS.

---

## 4. Scope

**In scope for v0.1**

- Provider-neutral generate, stream and embed
- Live adapters: Anthropic first (ResearchOS already depends on `@anthropic-ai/sdk`), then OpenAI, then Ollama for local and private work
- Model catalog with capabilities, context window, and pricing per model
- Task-kind-aware routing: the same policy engine ResearchOS already has
- Retry, fallback, circuit breaker, ported not rewritten
- Structured output with schema validation and repair
- Health probes, and routing away from an unhealthy provider
- The `ModelCallRecord` ledger persisted, with `/v1/usage` aggregation
- Budget ceilings per caller, per run, per tenant
- The scripted provider, kept as a first-class citizen for deterministic testing

**Explicitly out of scope for v0.1**

- Fine-tuning and training orchestration
- Prompt management and versioning. It belongs to whoever owns the prompt, until
  a second consumer needs the same prompt
- Semantic response caching. Measure first. Cached-input tokens are already in
  the record, so the data to justify it will exist
- A routing policy learned from EvalOS scores. That is a genuinely good idea and
  it is EvolutionOS. It requires a human gate and it comes much later

**Keep the scripted provider.** It is why ResearchOS could build 454 tests
without an API key, and it stays the default in CI forever. Live models in CI
make the suite slow, expensive and flaky.

---

## 5. Architecture

Same shape as MemoryOS.

```
modelos/
  architecture.json
  packages/
    shared/         layer 0
    contracts/      layer 1  ModelProvider, GenerateRequest, ModelResponse, ModelDescriptor, ModelCallRecord
    sdk/            layer 2
    observability/  layer 2  correlation id propagation
    providers/      layer 3  anthropic, openai, ollama, scripted
    persistence/    layer 3  the call ledger, budgets
    routing/        layer 4  policy, task-kind rules, fallback chains, circuit breakers
    core/           layer 5  the router composed from routing and providers
  apps/
    api/            layer 6
```

Ports come from `ResearchOS/packages/model-router`. Read that code before
writing a line: retry policy, circuit breaker thresholds and the structured
output repair loop are already solved there.

---

## 6. HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/generate` | Non-streaming completion |
| `POST` | `/v1/generate/stream` | SSE streaming |
| `POST` | `/v1/embed` | Embeddings. MemoryOS is the first consumer |
| `GET` | `/v1/models` | Catalog with capabilities, limits, pricing |
| `GET` | `/v1/providers` | Providers with health |
| `GET` | `/v1/usage` | Ledger aggregation, filterable by caller, run, tenant, window |
| `GET` | `/v1/budgets` and `POST` | Budget ceilings |
| `GET` | `/health` | Status, version, and a `gaps` array naming unconfigured providers |

---

## 7. Routing policy

Port the ResearchOS policy rather than designing a new one. The property worth
protecting, quoted from the ResearchOS design commitments:

> *"As a run approaches a budget ceiling, routing trades model strength for
> reach so it ends with a weaker answer rather than an exhausted budget and no
> report. The work that decides what the research concludes, judgment,
> synthesis, verification, is never downgraded, and every downgrade that does
> happen is recorded."*

That is a genuinely good policy and it belongs in ModelOS for every consumer,
not only research. Two rules follow:

1. Degradation is allowed on breadth, never on judgment.
2. Every degradation is recorded in the call ledger so it appears in the trace.

---

## 8. Secrets and keys

- Keys come from environment only. Never from the database, never from a request
- `/v1/models` and `/health` report which providers are configured, never any key material
- Redact keys in logs. EvalOS already has a pino redaction config to copy
- Per-caller budgets are enforced before the provider call, not after

---

## 9. Test plan

**Unit.** Routing rule selection. Fallback chain ordering. Circuit breaker open,
half-open and close transitions. Cost computation against the catalog. Budget
ceiling arithmetic at exact boundaries.

**Contract.** The provider suite every adapter must pass, run against the
scripted provider in CI and against each live provider in a manual,
key-required job.

**Integration.** Provider failure triggers fallback. All providers unhealthy
returns a typed error, never a hang. Ledger rows persist across restart.
Streaming delivers ordered chunks and a terminal record.

**Live, manual, key-required, never in CI.** One real call per provider.
Structured output against a real model, which is where reality usually differs
from the scripted provider. Token counts reconciled against the provider's own
usage reporting.

**The real one.** A ResearchOS project end to end. See section 2.

---

## 10. Build order

1. Scaffold, `architecture.json`, lint
2. `contracts`: port from `model-router`
3. `providers/scripted` first, so everything downstream is testable with no key
4. `routing`: port policy, retry, fallback, circuit breaker
5. `core`: compose. Contract suite green against scripted
6. `persistence`: the call ledger
7. `apps/api` and `sdk`
8. `providers/anthropic`. **The first live call in the project's history.** Log it in the continuation log
9. ResearchOS `HttpModelProvider` adapter, swap in the composition root
10. One live research project end to end
11. Expect prompt work. Budget real time for it, and use EvalOS to tell whether a prompt change helped

Steps 1 to 7 are a clean week of engineering. Step 8 onward is where the project
learns what it is actually worth, which is the whole point of building it.
