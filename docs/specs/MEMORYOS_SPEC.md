# MemoryOS Build Spec

**Simple meaning:** REMEMBER.
**Roadmap stage:** 3.
**Approach:** extraction from `ResearchOS/packages/memory`, not a new build.

---

## 1. The one thing to understand before starting

`ResearchOS/packages/memory/src/provider.ts` carries this comment:

> *"Deliberately generic. ResearchOS ships a SQL adapter today, but the whole
> reason this is a port rather than a class is that a shared memory service is
> intended to satisfy it later, so nothing here names a research concept that a
> general memory system could not represent."*

The interface for MemoryOS was designed before MemoryOS. So the spec for
MemoryOS is not a document to be argued over. It is
`ResearchOS/packages/contracts/src/memory.ts`, verbatim.

**Do not redesign it.** Every improvement you are tempted to make is a week of
work that breaks a working 454-test suite for no measured gain.

---

## 2. Definition of done

> ResearchOS runs its full existing test suite green, with its SQL memory
> adapter replaced by an HTTP adapter pointing at a running MemoryOS, and the
> only file changed in ResearchOS outside the new adapter is the composition
> root.

If that passes, MemoryOS is correct by construction against the most demanding
consumer it will ever have. Nothing else is needed to declare v0.1.

---

## 3. Scope

**In scope for v0.1**

- The seven memory layers: `working`, `project`, `evidence`, `claim`, `experiment`, `failure`, `preference`
- Scope and visibility: `{ tenantId, projectId, application, visibility }` with `run | project | tenant | global`
- Upsert-by-key within scope, so re-remembering updates instead of duplicating
- Lexical search, always available, no model required
- Semantic search when an `Embedder` is configured, with automatic fallback to lexical when it is not
- Hybrid ranking and rank fusion, ported from `packages/memory/src/rank.ts`
- Salience with age decay, used for ranking only and never to hide data
- Typed links between memories with the six link types
- TTL and `purgeExpired()`
- Access tracking: `lastAccessedAt`, `accessCount`
- HTTP API, TypeScript SDK, OpenAPI

**Explicitly out of scope for v0.1**

- **Failure memory as system of record.** ResearchOS owns failed approaches in a
  first-class table with a cross-project query. MemoryOS may *index* them. It
  must not become a second answer to "what have we already tried". This
  boundary is written into the ResearchOS source and must be preserved.
- Automatic consolidation and summarization of old memories. Tempting, model
  dependent, and unmeasurable until ModelOS exists. Stage it after EvalOS can
  score retrieval quality.
- Cross-tenant sharing, memory merge, conflict resolution UI.
- Vector database. SQLite with stored embeddings and in-process cosine
  similarity is sufficient well past the volume a solo project will produce.
  Revisit past roughly one million records, not before.

---

## 4. Architecture

Copy the ResearchOS shape, which is the best pattern in the codebase.

```
memoryos/
  architecture.json          machine-enforced module graph, copied from ResearchOS
  scripts/
    generate-workspaces.mjs  generates manifests from architecture.json
    lint-architecture.mjs    fails the build on graph drift
  packages/
    shared/         layer 0  ids, errors, Result, clock, config
    contracts/      layer 1  the zod model, ported verbatim from ResearchOS
    sdk/            layer 2  TypeScript client
    observability/  layer 2  structured logs, correlation id propagation
    persistence/    layer 3  SQLite and Postgres dialects, migrations, repositories
    embedding/      layer 3  Embedder port plus adapters, ModelOS-backed later
    retrieval/      layer 4  lexical, semantic, hybrid, rank fusion
    core/           layer 5  MemoryProvider implementation
  apps/
    api/            layer 6  Fastify HTTP surface
```

`architecture.json` and the two scripts are the reason ResearchOS did not rot
across 20 packages. Port them on day one, not later.

---

## 5. Data model

Port `ResearchOS/packages/contracts/src/memory.ts` unchanged. One table plus one
link table plus indexes.

```sql
CREATE TABLE memories (
  id               TEXT PRIMARY KEY,
  layer            TEXT NOT NULL,
  tenant_id        TEXT,
  project_id       TEXT,
  application      TEXT,
  visibility       TEXT NOT NULL DEFAULT 'project',
  key              TEXT NOT NULL,
  content          TEXT NOT NULL,          -- JSON
  search_text      TEXT NOT NULL,
  embedding        BLOB,                   -- float32 array, null when unembedded
  embedding_model  TEXT,
  salience         REAL NOT NULL DEFAULT 0.5,
  reference_ids    TEXT NOT NULL DEFAULT '[]',
  tags             TEXT NOT NULL DEFAULT '[]',
  metadata         TEXT NOT NULL DEFAULT '{}',
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count     INTEGER NOT NULL DEFAULT 0
);

-- upsert-by-key within scope is the core invariant
CREATE UNIQUE INDEX ux_memories_scope_key
  ON memories (key, COALESCE(project_id,''), COALESCE(tenant_id,''), COALESCE(application,''));

CREATE INDEX ix_memories_layer_scope ON memories (layer, tenant_id, project_id);
CREATE INDEX ix_memories_expires     ON memories (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX ix_memories_salience    ON memories (salience DESC);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  search_text, content=memories, content_rowid=rowid
);

CREATE TABLE memory_links (
  from_memory_id TEXT NOT NULL,
  to_memory_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 0.5,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (from_memory_id, to_memory_id, type)
);
```

Use FTS5 for lexical search. ResearchOS uses BM25 rank fusion in
`packages/retrieval`; port that ranking rather than reinventing it.

---

## 6. HTTP API

Follow the ToolOS and AgentOS convention: `/v1`, Fastify, zod schemas, Swagger
served at `/docs` and `/openapi.json`.

| Method | Path | Maps to |
|---|---|---|
| `POST` | `/v1/memories` | `store` (upsert by key within scope) |
| `GET` | `/v1/memories/:id` | `get` |
| `GET` | `/v1/memories/by-key` | `getByKey`, query params `key`, `projectId` |
| `POST` | `/v1/memories/search` | `search`. POST because `MemoryQuery` is structured |
| `PATCH` | `/v1/memories/:id` | `update` |
| `DELETE` | `/v1/memories/:id` | `forget` |
| `POST` | `/v1/links` | `link` |
| `GET` | `/v1/memories/:id/links` | `linksFrom` |
| `POST` | `/v1/maintenance/purge-expired` | `purgeExpired` |
| `GET` | `/health` | status, version, and a `gaps` array in the ResearchOS style |

`/health` should report what it cannot do, the way the ResearchOS API does. If
no embedder is configured, say so, and say that search is lexical only.

Every endpoint accepts and returns `X-Correlation-Id` per `02-CONTRACTS.md`.

---

## 7. Failure behaviour

Copy the ToolOS discipline: typed error categories, never a success response
carrying an error string.

`MEMORY_NOT_FOUND`, `INVALID_SCOPE`, `INVALID_QUERY`, `EMBEDDER_UNAVAILABLE`,
`STORAGE_FAILURE`, `PERMISSION_DENIED`, `TIMEOUT`.

`EMBEDDER_UNAVAILABLE` is never fatal for a search. It degrades to lexical and
says so in the response, because memory that refuses to answer is worse than
memory that answers less well.

---

## 8. Test plan

Mirror the EvalOS and ResearchOS test layout, since both already work.

**Unit.** Scope resolution and visibility rules. Salience decay. Rank fusion.
TTL boundaries. Upsert-by-key collisions across differing scopes.

**Contract.** A shared suite that any `MemoryProvider` implementation must pass,
run against both the in-process implementation and the HTTP SDK. This is the
suite that proves the port is honest.

**Integration.** Migrations forward and backward. Durability: write, close,
reopen, read, the exact test EvalOS already uses. Concurrent upsert of the same
key from two callers resolves to one record.

**Acceptance.** Store across all seven layers, retrieve by each of the five
query modes, and confirm `run`-visibility memory is invisible from another run
while `tenant`-visibility memory is visible across projects.

**The real one.** Point ResearchOS at MemoryOS and run its whole suite. See
section 2.

---

## 9. Build order

1. Repo scaffold, `architecture.json`, generation and lint scripts. Prove the
   graph lint fails on a deliberate violation before writing any feature code
2. `contracts`: port the zod model verbatim
3. `persistence`: migrations, repositories, FTS5
4. `core`: implement `MemoryProvider` against persistence, no HTTP yet
5. Run the contract suite in process. Green here means the logic is right
6. `apps/api`: Fastify surface
7. `sdk`: client
8. Run the contract suite through HTTP. Green here means the boundary is right
9. Write the ResearchOS `HttpMemoryProvider` adapter, swap it in the composition
   root, run the ResearchOS suite
10. Point AgentOS at MemoryOS for task and agent lessons. Second consumer, which
    is what satisfies the promotion rule

Steps 1 through 8 are one clean build. Step 9 is the proof. Step 10 is what
makes it a platform rather than a refactor.
