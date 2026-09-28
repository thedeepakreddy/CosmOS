/**
 * Memory ranking and the SQL provider.
 *
 * Ranking is tested against a real database on both engines, because "why did
 * it not recall that?" is the hardest question to answer about a memory system
 * and the answer must not depend on which engine is underneath.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { MemoryQuery } from "@research-os/contracts";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { TestClock } from "@research-os/shared";
import { PgliteDatabase } from "../../../tests/support/pglite-database.ts";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import { FIXTURE_NOW as NOW, makeProject } from "../../../tests/support/fixtures.ts";
import {
  ResearchMemory, SqlMemoryProvider, inverseDocumentFrequency, lexicalScore, normaliseKey,
  recencyFactor, renderSearchText, type Embedder,
} from "../src/index.ts";

const query = (overrides: Record<string, unknown>) => MemoryQuery.parse(overrides);

describe("ranking primitives", () => {
  test("a term in every document carries less weight than a rare one", () => {
    const idf = inverseDocumentFrequency([
      ["memory", "agent", "recall"],
      ["memory", "agent", "latency"],
      ["memory", "agent", "cost"],
    ]);
    assert.ok((idf.get("recall") ?? 0) > (idf.get("memory") ?? 0), "the discriminating term must rank higher");
  });

  test("lexical score is the fraction of query information covered", () => {
    const idf = inverseDocumentFrequency([["a", "b"], ["a", "c"]]);
    assert.equal(lexicalScore([], ["a"], idf), 0, "an empty query matches nothing");
    assert.equal(lexicalScore(["a"], ["a", "b"], idf), 1);
    assert.equal(lexicalScore(["a"], ["z"], idf), 0);
    assert.ok(lexicalScore(["a", "c"], ["a"], idf) < 1, "partial coverage scores partially");
  });

  test("recency discounts but never erases", () => {
    assert.equal(recencyFactor(0), 1);
    assert.ok(recencyFactor(30 * 86_400_000) < 1);
    assert.ok(recencyFactor(3650 * 86_400_000) >= 0.2, "an old memory must stay retrievable, only lower-ranked");
  });

  test("keys normalise so the same memory is not written twice", () => {
    assert.equal(normaliseKey("Hypothesis: Memory Helps"), normaliseKey("hypothesis:memory-helps"));
    assert.equal(normaliseKey("lesson:Two Year Lag"), "lesson:two-year-lag");
  });

  test("search text is rendered from structured content", () => {
    assert.match(renderSearchText({ finding: "memory improves recall", n: 42 }), /memory improves recall/);
    assert.match(renderSearchText({ nested: { deep: ["alpha", "beta"] } }), /alpha beta/);
    assert.equal(renderSearchText(null), "");
    assert.equal(renderSearchText("plain"), "plain");
  });
});

const engines: { name: string; create: () => Promise<Database> }[] = [
  { name: "sqlite", create: async () => new SqliteDatabase({ file: ":memory:" }) },
  { name: "postgres (pglite)", create: () => PgliteDatabase.create() },
];

for (const engine of engines) {
  describe(`memory provider on ${engine.name}`, () => {
    let db: Database;
    let store: ResearchStore;
    let provider: SqlMemoryProvider;
    let clock: TestClock;
    let projectId: string;

    before(async () => {
      db = await engine.create();
      await migrate(db);
      store = createStore(db, () => NOW);
    });

    beforeEach(async () => {
      await resetDatabase(db);
      const project = makeProject();
      await store.projects.create(project);
      projectId = project.id;
      clock = new TestClock(Date.parse(NOW));
      provider = new SqlMemoryProvider({ repository: store.memory, clock });
    });

    after(async () => {
      await db.close();
    });

    const scope = () => ({ tenantId: "acme", projectId, application: null, visibility: "project" as const });

    test("a stored memory round-trips with its scope and content intact", async () => {
      const record = await provider.store({
        layer: "project", scope: scope(), key: "plan:v1",
        content: { steps: ["search", "extract"] }, tags: ["plan"], referenceIds: ["qst_1"],
      });

      const loaded = await provider.get(record.id);
      assert.ok(loaded);
      assert.deepEqual(loaded.content, { steps: ["search", "extract"] });
      assert.equal(loaded.scope.projectId, projectId);
      assert.deepEqual(loaded.tags, ["plan"]);
      assert.match(loaded.searchText, /search/, "search text is derived from content when not given");
    });

    test("re-remembering updates in place rather than duplicating", async () => {
      const first = await provider.store({ layer: "project", scope: scope(), key: "plan:v1", content: { version: 1 } });
      const second = await provider.store({ layer: "project", scope: scope(), key: "plan:v1", content: { version: 2 } });

      assert.equal(second.id, first.id, "the same key in the same project is the same memory");
      assert.equal(second.createdAt, first.createdAt, "creation time is preserved across updates");
      const hits = await provider.search(query({ layers: ["project"], scope: { projectId }, mode: "exact", limit: 50 }));
      assert.equal(hits.length, 1, "a memory store that accumulates near-duplicates cannot retrieve cleanly");
    });

    test("lexical search finds the relevant memory and ranks it first", async () => {
      await provider.store({ layer: "project", scope: scope(), key: "a", content: "Latency increased under load." });
      await provider.store({ layer: "project", scope: scope(), key: "b", content: "Persistent memory improved recall of prior context." });
      await provider.store({ layer: "project", scope: scope(), key: "c", content: "Cost per token fell in Q3." });

      const hits = await provider.search(query({ text: "recall of prior context", layers: ["project"], scope: { projectId }, limit: 5 }));

      assert.ok(hits.length >= 1);
      assert.match(String(hits[0]?.record.content), /Persistent memory improved recall/);
      assert.equal(hits[0]?.matchedBy, "lexical", "with no embedder configured, retrieval degrades to lexical");
    });

    test("semantic search is used when an embedder is configured", async () => {
      // A deterministic embedder: the vector is a term histogram, so texts
      // sharing vocabulary end up close without needing a real model.
      const embedder: Embedder = {
        model: "test-embedder",
        embed: async (texts) =>
          texts.map((text) => {
            const vector = new Array<number>(16).fill(0);
            for (const character of text.toLowerCase()) vector[character.charCodeAt(0) % 16]! += 1;
            const magnitude = Math.hypot(...vector) || 1;
            return vector.map((value) => value / magnitude);
          }),
      };
      const semantic = new SqlMemoryProvider({ repository: store.memory, clock, embedder });

      await semantic.store({ layer: "project", scope: scope(), key: "a", content: "Persistent memory improves recall." });
      const hits = await semantic.search(query({ text: "Persistent memory improves recall.", layers: ["project"], scope: { projectId }, limit: 5 }));

      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.matchedBy, "hybrid", "both signals available means both are used");
      assert.equal(hits[0]?.record.embeddingModel, "test-embedder");
    });

    test("an embedder that throws degrades to lexical instead of losing the memory", async () => {
      const broken: Embedder = { model: "broken", embed: async () => { throw new Error("provider down"); } };
      const degraded = new SqlMemoryProvider({ repository: store.memory, clock, embedder: broken });

      const record = await degraded.store({ layer: "project", scope: scope(), key: "a", content: "still remembered" });

      assert.equal(record.embedding, null);
      assert.equal(record.embeddingModel, null);
      assert.ok(await degraded.get(record.id), "losing the memory would be the worse failure");
    });

    test("an expired memory is not retrieved, and purge removes it", async () => {
      await provider.store({
        layer: "working", scope: scope(), key: "scratch", content: "temporary note",
        expiresAt: new Date(Date.parse(NOW) - 1000).toISOString(),
      });

      const hits = await provider.search(query({ layers: ["working"], scope: { projectId }, mode: "exact", limit: 10 }));
      assert.equal(hits.length, 0);
      assert.equal(await provider.purgeExpired(), 1);
    });

    test("exact lookup by reference id returns what was asked for", async () => {
      await provider.store({ layer: "claim", scope: scope(), key: "about-claim", content: "note", referenceIds: ["clm_target"] });
      await provider.store({ layer: "claim", scope: scope(), key: "other", content: "unrelated", referenceIds: ["clm_other"] });

      const hits = await provider.search(query({ referenceIds: ["clm_target"], scope: { projectId }, mode: "exact", limit: 10 }));
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.matchedBy, "exact");
    });

    test("updating search text recomputes nothing when no embedder is configured", async () => {
      const record = await provider.store({ layer: "project", scope: scope(), key: "a", content: "first" });
      const updated = await provider.update(record.id, { searchText: "second", salience: 0.9 });
      assert.equal(updated?.searchText, "second");
      assert.equal(updated?.salience, 0.9);
    });

    test("forgetting removes the memory", async () => {
      const record = await provider.store({ layer: "project", scope: scope(), key: "a", content: "x" });
      await provider.forget(record.id);
      assert.equal(await provider.get(record.id), undefined);
    });

    test("reading records access, so salience can reflect use", async () => {
      const record = await provider.store({ layer: "project", scope: scope(), key: "a", content: "x" });
      await provider.get(record.id);
      const reloaded = await provider.getByKey("a", projectId);
      assert.equal(reloaded?.accessCount, 1);
    });

    describe("ResearchMemory", () => {
      test("a lesson is tenant-visible so a later project can find it", async () => {
        const memory = new ResearchMemory({ provider, tenantId: "acme" });
        await memory.rememberLesson(projectId, "stats-lag", "Regional statistics are published with a two-year lag.", ["methodology"]);

        const otherProject = makeProject();
        await store.projects.create(otherProject);
        const hits = await memory.recallLessons("published lag statistics");

        assert.equal(hits.length, 1, "lessons must cross project boundaries — that is what makes them lessons");
        assert.match(String((hits[0]?.record.content as { lesson: string }).lesson), /two-year lag/);
      });

      test("preferences are not recalled as evidence", async () => {
        const memory = new ResearchMemory({ provider, tenantId: "acme" });
        await memory.rememberPreference(projectId, "tone", "Prefer concise answers about memory and recall.");
        await memory.remember(projectId, "claim", "finding:1", "Persistent memory improves recall.");

        const hits = await memory.recallRelevant(projectId, "memory and recall");

        assert.ok(hits.length >= 1);
        assert.ok(
          hits.every((hit) => hit.record.layer !== "preference"),
          "a caller's stated preference must never surface as a finding about the world",
        );

        const withPreferences = await memory.recallRelevant(projectId, "memory and recall", { includePreferences: true });
        assert.ok(withPreferences.some((hit) => hit.record.layer === "preference"), "but they are retrievable when asked for");
      });

      test("working memory is cleared when a run ends", async () => {
        const memory = new ResearchMemory({ provider, tenantId: "acme" });
        await memory.remember(projectId, "working", "note:1", "scratch");
        await memory.remember(projectId, "working", "note:2", "more scratch");
        await memory.remember(projectId, "project", "keep", "durable");

        assert.equal(await memory.clearWorking(projectId), 2);
        assert.ok(await provider.getByKey("keep", projectId), "only working memory is discarded");
      });

      test("recallAbout returns everything recorded about one entity", async () => {
        const memory = new ResearchMemory({ provider, tenantId: "acme" });
        await memory.remember(projectId, "claim", "note:a", "first note", { referenceIds: ["clm_1"] });
        await memory.remember(projectId, "claim", "note:b", "second note", { referenceIds: ["clm_1"] });
        await memory.remember(projectId, "claim", "note:c", "unrelated", { referenceIds: ["clm_2"] });

        assert.equal((await memory.recallAbout(projectId, "clm_1")).length, 2);
      });
    });
  });
}
