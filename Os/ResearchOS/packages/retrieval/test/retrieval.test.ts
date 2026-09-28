/**
 * BM25, rank fusion and hybrid retrieval.
 *
 * The behaviours worth protecting are the ones that make retrieval trustworthy
 * rather than merely functional: a long chunk must not win by being long, a
 * repeated word must not win by repetition, and a deployment with no embedding
 * provider must return lexical results *and say that is what it did*.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { ModelRouter, ScriptedModelProvider, scriptedModels } from "@research-os/model-router";
import { newId } from "@research-os/shared";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import { FIXTURE_NOW as NOW, makeProject, makeSource } from "../../../tests/support/fixtures.ts";
import {
  ChunkRetriever, bm25Idf, bm25Search, buildBm25Index, embedProjectChunks, reciprocalRankFusion,
} from "../src/index.ts";

describe("BM25", () => {
  const corpus = [
    { id: "a", text: "Persistent memory improves recall in autonomous agents." },
    { id: "b", text: "Latency and cost of inference across model sizes." },
    { id: "c", text: "Memory memory memory memory memory memory memory memory." },
    { id: "d", text: `Recall improves with memory. ${"filler word ".repeat(200)}` },
  ];
  const index = buildBm25Index(corpus);

  test("finds documents containing the query terms", () => {
    const hits = bm25Search(index, "persistent memory recall");
    assert.equal(hits[0]?.id, "a");
    assert.ok(hits[0]?.matchedTerms.includes("memory"), "a hit explains which terms matched");
  });

  test("repetition saturates rather than compounding", () => {
    const hits = bm25Search(index, "memory");
    const repetitive = hits.find((hit) => hit.id === "c");
    const genuine = hits.find((hit) => hit.id === "a");
    assert.ok(repetitive && genuine);
    assert.ok(repetitive.score < genuine.score * 3, "eight repetitions must not be worth eight times one");
  });

  test("a long document does not win by being long", () => {
    const hits = bm25Search(index, "recall improves memory");
    const long = hits.findIndex((hit) => hit.id === "d");
    const short = hits.findIndex((hit) => hit.id === "a");
    assert.ok(short < long, "length normalisation is what stops the longest chunk winning every query");
  });

  test("a term in every document contributes nothing negative", () => {
    assert.ok(bm25Idf(10, 10) >= 0, "a negative contribution would penalise containing a queried word");
    assert.ok(bm25Idf(100, 1) > bm25Idf(100, 50));
  });

  test("an empty query or corpus returns nothing rather than everything", () => {
    assert.deepEqual(bm25Search(index, ""), []);
    assert.deepEqual(bm25Search(buildBm25Index([]), "memory"), []);
  });

  test("a query matching nothing returns nothing", () => {
    assert.deepEqual(bm25Search(index, "cryptocurrency blockchain"), []);
  });
});

describe("reciprocal rank fusion", () => {
  test("a document ranked well by both rankers beats one ranked well by either", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["b", "a", "d"]]);
    assert.ok(fused[0]?.id === "a" || fused[0]?.id === "b");
    const scores = new Map(fused.map((entry) => [entry.id, entry.score]));
    assert.ok((scores.get("a") ?? 0) > (scores.get("c") ?? 0));
    assert.ok((scores.get("b") ?? 0) > (scores.get("d") ?? 0));
  });

  test("it fuses rankings, not scores, so scales never need converting", () => {
    // The second ranker's "scores" would be on a wildly different scale; only
    // position is used, so the fusion is unaffected by that.
    const fused = reciprocalRankFusion([["x"], ["x"]]);
    assert.equal(fused.length, 1);
    assert.ok((fused[0]?.score ?? 0) > 0);
  });

  test("weights let one ranker count for more", () => {
    const equal = reciprocalRankFusion([["a", "b"], ["b", "a"]]);
    const weighted = reciprocalRankFusion([["a", "b"], ["b", "a"]], { weights: [3, 1] });
    assert.equal(weighted[0]?.id, "a");
    assert.equal(equal.length, 2);
  });

  test("an empty ranking set fuses to nothing", () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
  });
});

describe("ChunkRetriever", () => {
  let db: Database;
  let store: ResearchStore;
  let projectId: string;
  let sourceId: string;

  const texts = [
    "Persistent memory improves recall of prior context in autonomous agents.",
    "Inference latency grew linearly with the number of retained context tokens.",
    "The remembering of earlier material was materially better in the treatment arm.",
    "Unrelated discussion of database index maintenance and vacuum scheduling.",
  ];

  before(async () => {
    db = new SqliteDatabase({ file: ":memory:" });
    await migrate(db);
    store = createStore(db, () => NOW);
  });

  after(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    const project = makeProject();
    await store.projects.create(project);
    projectId = project.id;

    const source = makeSource(projectId);
    await store.research.upsertSource(source);
    sourceId = source.id;

    const documentId = newId("document");
    await store.research.saveDocument(
      {
        id: documentId, projectId, sourceId, title: "A paper", text: texts.join("\n\n"),
        sections: [], language: "en", tokenCount: 100, createdAt: NOW,
      } as never,
      texts.map((text, position) => ({
        id: newId("chunk"), projectId, sourceId, documentId, position, text,
        startOffset: 0, endOffset: text.length, locator: null, tokenCount: 20,
        embedding: null, embeddingModel: null, createdAt: NOW,
      })) as never,
    );
  });

  test("lexical retrieval finds the right passage and reports its strategy", async () => {
    const retriever = new ChunkRetriever({ repository: store.research });
    const result = await retriever.retrieve({ projectId, query: "persistent memory recall", limit: 3 });

    assert.equal(result.strategy, "lexical");
    assert.equal(result.candidatesConsidered, 4);
    assert.match(String(result.hits[0]?.chunk.text), /Persistent memory improves recall/);
    assert.ok(result.hits[0]?.matchedTerms.length);
  });

  test("with no model router configured it degrades to lexical and says so", async () => {
    const retriever = new ChunkRetriever({ repository: store.research });
    const result = await retriever.retrieve({ projectId, query: "memory", strategy: "hybrid" });

    assert.equal(result.strategy, "lexical");
    assert.match(String(result.degradedReason), /No model router is configured/);
  });

  test("with a router but no embeddings yet it degrades and says which", async () => {
    const router = new ModelRouter({
      providers: [new ScriptedModelProvider({
        name: "scripted",
        models: scriptedModels(["embed-1"], { provider: "scripted", capabilities: ["embedding"] }),
      })],
    });
    const retriever = new ChunkRetriever({ repository: store.research, router });
    const result = await retriever.retrieve({ projectId, query: "memory", strategy: "hybrid" });

    assert.equal(result.strategy, "lexical");
    assert.match(String(result.degradedReason), /has an embedding yet/);
  });

  test("once embeddings exist, retrieval is genuinely hybrid", async () => {
    const router = new ModelRouter({
      providers: [new ScriptedModelProvider({
        name: "scripted",
        models: scriptedModels(["embed-1"], { provider: "scripted", capabilities: ["embedding"] }),
        embeddingDimensions: 24,
      })],
    });

    const backfill = await embedProjectChunks(projectId, { repository: store.research, router });
    assert.equal(backfill.embedded, 4);
    assert.equal(backfill.unavailableReason, null);

    const retriever = new ChunkRetriever({ repository: store.research, router });
    const result = await retriever.retrieve({ projectId, query: "memory recall", limit: 4, strategy: "hybrid" });

    assert.equal(result.strategy, "hybrid");
    assert.equal(result.degradedReason, null);
    assert.ok(result.hits.some((hit) => hit.lexicalRank !== null && hit.semanticRank !== null), "a hit records where each ranker placed it");
  });

  test("retrieval can be scoped to particular sources", async () => {
    const other = makeSource(projectId, { contentHash: "different", url: "https://other.example/x" });
    await store.research.upsertSource(other);

    const retriever = new ChunkRetriever({ repository: store.research });
    const scoped = await retriever.retrieve({ projectId, query: "memory", sourceIds: [other.id] });
    assert.equal(scoped.candidatesConsidered, 0, "a source with no chunks contributes none");

    const unscoped = await retriever.retrieve({ projectId, query: "memory", sourceIds: [sourceId] });
    assert.equal(unscoped.candidatesConsidered, 4);
  });

  test("a project with no chunks returns nothing rather than failing", async () => {
    const empty = makeProject();
    await store.projects.create(empty);
    const retriever = new ChunkRetriever({ repository: store.research });
    const result = await retriever.retrieve({ projectId: empty.id, query: "anything" });
    assert.deepEqual(result.hits, []);
    assert.equal(result.candidatesConsidered, 0);
  });

  test("embedding backfill is idempotent and skips what is already done", async () => {
    const router = new ModelRouter({
      providers: [new ScriptedModelProvider({
        name: "scripted",
        models: scriptedModels(["embed-1"], { provider: "scripted", capabilities: ["embedding"] }),
      })],
    });
    await embedProjectChunks(projectId, { repository: store.research, router });
    const second = await embedProjectChunks(projectId, { repository: store.research, router });

    assert.equal(second.embedded, 0);
    assert.equal(second.skipped, 4, "a re-run must not pay for embeddings that already exist");
  });

  test("no embedding provider is reported as a configuration state, not a batch failure", async () => {
    const router = new ModelRouter({
      providers: [new ScriptedModelProvider({
        name: "scripted",
        models: scriptedModels(["text-1"], { provider: "scripted", capabilities: ["text"] }),
      })],
    });
    const result = await embedProjectChunks(projectId, { repository: store.research, router });

    assert.equal(result.embedded, 0);
    assert.match(String(result.unavailableReason), /No registered provider offers embeddings/);
    assert.equal(result.failed, 0, "a missing provider is not a failure to retry");
  });
});
