# Cosmos Contract Registry

Every cross-system interface, pointing at the file that actually defines it.
Nothing here is described from memory. When an interface changes, this file is
updated in the same commit.

**Rule:** systems integrate through these contracts and through HTTP. No system
ever imports source from a sibling repository.

---

## 1. Contracts that exist today

### 1.1 ToolOS capability plane

**Defined in:** `~/ToolOS/packages/contracts/src/index.ts`
**Served at:** `POST /v1/executions`, `GET /v1/tools`, `GET /v1/capabilities`, `GET /v1/executors`

```ts
interface ExecutorAdapter {
  id: string;
  health(): Promise<ExecutorHealth>;
  listTools(): Promise<ToolDefinition[]>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

interface PolicyProvider {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
```

Error categories, which every caller must handle:
`TOOL_NOT_FOUND`, `CAPABILITY_NOT_FOUND`, `EXECUTOR_UNAVAILABLE`,
`INVALID_ARGUMENTS`, `PERMISSION_DENIED`, `DOWNSTREAM_DENIED`, `TIMEOUT`,
`CANCELLED`, `EXECUTION_FAILED`, `SCHEMA_MISMATCH`, `PROTOCOL_ERROR`.

### 1.2 AgentOS work plane

**Defined in:** `~/AgentOS/src/domain/types.ts`, exported from `src/index.ts`
**Served at:** `/v1/agents`, `/v1/runs`, `/v1/runs/:id/{start,pause,resume,recover,cancel}`, `/v1/runs/:id/tasks`

The public surface is `AgentDefinition`, `AgentRun`, `TaskGraph`, `Task`,
`ExecutionBudget`, `AgentMessage`, `Artifact`, `AgentEvent`, plus the execution
seam:

```ts
interface AgentExecutor {
  // src/engine/Executor.ts
  // This is where ModelOS and ToolOS attach. It is currently unattached.
}

interface Planner { /* src/engine/Planner.ts. Where PlanningOS attaches later */ }
```

The persistence interfaces (`Stores`, `RunStore`, `TaskStore`, `AgentStore`,
`EventStore`, `ClaimTicket`) are public so a different backend can be supplied.
The SQLite classes behind them are deliberately internal.

### 1.3 MemoryOS port, already written

**Defined in:** `~/ResearchOS/packages/contracts/src/memory.ts` and
`~/ResearchOS/packages/memory/src/provider.ts`

This is the most valuable contract in the project because it was written to be
satisfied by a service that does not exist yet.

```ts
interface MemoryProvider {
  readonly name: string;
  store(input: StoreMemoryInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  getByKey(key: string, projectId: string | null): Promise<MemoryRecord | undefined>;
  search(query: MemoryQuery): Promise<MemorySearchHit[]>;
  update(id: string, patch: MemoryUpdate): Promise<MemoryRecord | undefined>;
  forget(id: string): Promise<void>;
  link(link: MemoryLink): Promise<void>;
  linksFrom(memoryId: string): Promise<MemoryLink[]>;
  purgeExpired(): Promise<number>;
}

interface Embedder {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}
```

Layers: `working`, `project`, `evidence`, `claim`, `experiment`, `failure`,
`preference`.
Scope: `{ tenantId, projectId, application, visibility }` where visibility is
`run | project | tenant | global`.
Link types: `derived_from`, `supports`, `contradicts`, `supersedes`,
`relates_to`, `part_of`.

One explicit non-responsibility, recorded in the source: memory does **not** own
failure memory. Failed approaches are a first-class table with their own
repository. Memory may index them; it is not their system of record. MemoryOS
must preserve that boundary.

### 1.4 ModelOS port, already written

**Defined in:** `~/ResearchOS/packages/model-router/src/provider.ts`

```ts
interface ModelProvider {
  readonly name: string;
  readonly models: readonly ModelDescriptor[];
  generate(request: GenerateRequest): Promise<ModelResponse>;
  stream?(request: GenerateRequest): AsyncIterable<ModelStreamChunk>;
  embed?(request: EmbedRequest): Promise<EmbeddingResponse>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

type ModelCallSink = (record: ModelCallRecord) => void | Promise<void>;
```

`ModelCallRecord` already carries everything a CostOS would ever need: provider,
model, task kind, input and output tokens, cached input tokens, cost in USD,
latency, stop reason, success, error message, attempt count. **CostOS is
therefore not a service. It is this record plus a query.**

### 1.5 EvalOS measurement plane

**Defined in:** `~/EvalOS/src/contracts/{Domain,Candidate,Evaluator,JudgeProvider}.ts`
**Served at:** `/v1` routes for suites, datasets, runs, traces

`Candidate` is the thing being evaluated. `Evaluator` scores it. `JudgeProvider`
is the LLM-as-judge seam, defined and unimplemented pending a live model.

---

## 2. Contracts still to define

| Contract | Between | Needed by | Notes |
|---|---|---|---|
| `TraceEnvelope` | every OS to EvalOS | Stage 1 | One shape for "here is what happened", so EvalOS can ingest from any system. Derive it from what AgentOS `AgentEvent` and ResearchOS observability already emit rather than inventing a third shape |
| `AgentExecutor` implementations | AgentOS to ToolOS and ModelOS | Stage 2 | The seam exists and is empty. This is the highest-value wiring in the project |
| `CosmosIntent` | products to Cosmos Core | Stage 4 | Intent classification input and OS selection output |
| `CosmosCapability` | each OS to Cosmos Core | Stage 4 | Self-description so Core routes without hardcoding |
| `CorrelationId` | everywhere | Stage 1 | One id threaded through every system so a single request is traceable end to end. Cheap now, very expensive to retrofit |

`CorrelationId` is the one to do first. It is a handful of lines per service and
without it cross-OS debugging is guesswork.

---

## 3. Version and compatibility policy

- Every OS publishes a semantic version and exposes it at `GET /health`.
- Contract changes are additive within a major version. Removing or narrowing a
  field is a major bump.
- Each consumer records the contract version it was built against.
- A breaking change requires the consumer to be updated in the same session.
  With six services and one maintainer, coordinated change is cheaper than
  compatibility shims.

---

## 4. Boundary decision: ToolOS versus the ResearchOS `tools` package

Two permission-checked tool systems currently exist. Left alone this becomes two
answers to "may this agent do this", which is exactly the drift the platform is
meant to prevent.

**Decision.**

- **ToolOS owns the shared capability plane.** Anything two systems could both
  want (browser, filesystem, shell, HTTP fetch, MCP servers, desktop automation)
  belongs to ToolOS, behind its policy and audit.
- **The ResearchOS `tools` package stays** as the research-domain tool layer and
  keeps its SSRF protection and default-deny checks, because those are
  correctness properties of research ingestion, not general policy.
- **They compose rather than compete.** ResearchOS gains a ToolOS-backed
  `ResearchTool` adapter, so a research tool call travels through ToolOS policy
  and audit and then through ResearchOS domain checks. Two gates in series is
  correct. Two gates in parallel is not.
- **Neither is deleted.** Collapsing them now would cost weeks and break
  ResearchOS test coverage for no user-visible gain.

**Trigger to revisit:** when a third system needs research-style tool
permissions, promote that logic into ToolOS as a policy plugin.
