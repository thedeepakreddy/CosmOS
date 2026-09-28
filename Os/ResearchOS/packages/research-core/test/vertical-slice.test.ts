/**
 * One complete research run, end to end.
 *
 * This is the test the whole system exists to pass. A project is created, a
 * plan is made, a real HTTP server is fetched, passages are chunked, evidence is
 * extracted with verbatim quotes, claims are made from that evidence, quotes are
 * mechanically checked against the source, confidence is computed by arithmetic,
 * and a report is produced whose every finding traces back to a source.
 *
 * The model is scripted, because a real one makes this non-deterministic and
 * expensive; everything else is real — real database, real HTTP, real chunking,
 * real verification, real arithmetic, real task queue.
 *
 * Two deliberate hostilities are planted in the scripted output: one evidence
 * item quotes text that does not appear in the source, and one claim cites
 * nothing. Neither may reach the report.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { TASK_TYPES, Task, ToolDescriptor, parseEvent } from "@research-os/contracts";
import { InMemoryEventBus, RecordingEventBus } from "@research-os/events";
import { silentLogger } from "@research-os/observability";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { ModelRouter, ScriptedModelProvider, scriptedModels, type ScriptedTurn } from "@research-os/model-router";
import { LocalToolProvider, ToolRegistry, WebFetchTool, type ResearchTool } from "@research-os/tools";
import { IngestionPipeline } from "@research-os/ingestion";
import { ChunkRetriever } from "@research-os/retrieval";
import { SqlMemoryProvider, ResearchMemory } from "@research-os/memory";
import { systemClock, newId } from "@research-os/shared";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import { makeProject } from "../../../tests/support/fixtures.ts";
import { createResearchEngine } from "../src/index.ts";

/* ------------------------------------------------------------------ */
/* The source document the run will actually read.                     */
/* ------------------------------------------------------------------ */

const PAPER_BODY =
  "Agents equipped with persistent memory recalled 18% more prior context than the control group. " +
  "The effect was consistent across three independent trials. " +
  "Retrieval latency increased by roughly 40 milliseconds per query when memory was enabled. " +
  "The authors note that the sample was drawn from a single deployment and may not generalise.";

/* ------------------------------------------------------------------ */
/* A search tool, standing in for whatever a deployment actually has.  */
/* ------------------------------------------------------------------ */

const SearchInput = z.object({ query: z.string().min(1), limit: z.number().int().positive().default(10) });

class FixedSearchTool implements ResearchTool<z.infer<typeof SearchInput>, { results: { url: string; title: string }[] }> {
  readonly inputSchema = SearchInput;
  readonly descriptor: ToolDescriptor;
  readonly queries: string[] = [];
  readonly #urls: readonly { url: string; title: string }[];

  constructor(urls: readonly { url: string; title: string }[]) {
    this.#urls = urls;
    this.descriptor = ToolDescriptor.parse({
      id: "fixed_search",
      name: "Search",
      description: "Returns a fixed result set. Stands in for whatever search capability a deployment provides.",
      capability: "web_search",
      riskLevel: "read_only",
      inputSchema: z.toJSONSchema(SearchInput) as Record<string, unknown>,
      provider: "local",
    });
  }

  async execute(input: z.infer<typeof SearchInput>): Promise<{ results: { url: string; title: string }[] }> {
    this.queries.push(input.query);
    return { results: [...this.#urls] };
  }
}

/* ------------------------------------------------------------------ */
/* The scripted model.                                                  */
/* ------------------------------------------------------------------ */

function script(baseUrl: string): ScriptedTurn[] {
  void baseUrl;
  return [
    {
      when: "Produce the plan as JSON",
      repeat: true,
      json: {
        interpretation: "Whether persistent memory improves an agent's recall of prior context.",
        objectives: [{ statement: "Establish whether persistent memory improves recall.", rationale: "It is the question asked." }],
        subQuestions: [{ text: "Does persistent memory improve recall of prior context?", rationale: "Direct restatement.", priority: 90 }],
        hypotheses: [{
          statement: "Persistent memory improves recall of prior context.",
          rationale: "Reported in trials.",
          falsificationCriteria: "A controlled trial showing no difference in recall between memory-enabled and control agents.",
        }],
        strategy: "Find primary sources reporting measured recall, extract verbatim evidence, and check every quote.",
        steps: [
          { key: "discover", type: "source.discover", description: "Find sources.", dependsOnKeys: [], searchQueries: ["persistent memory agent recall"], priority: 90 },
          { key: "extract", type: "evidence.extract", description: "Extract evidence.", dependsOnKeys: ["discover"], searchQueries: [], priority: 80 },
          { key: "claims", type: "claim.extract", description: "Extract claims.", dependsOnKeys: ["extract"], searchQueries: [], priority: 70 },
          { key: "verify", type: "verification.run", description: "Check every quote.", dependsOnKeys: ["claims"], searchQueries: [], priority: 60 },
          { key: "score", type: "claim.score", description: "Score claims.", dependsOnKeys: ["verify"], searchQueries: [], priority: 50 },
          { key: "contradictions", type: "contradiction.detect", description: "Find conflicts.", dependsOnKeys: ["score"], searchQueries: [], priority: 40 },
          { key: "critique", type: "critique.run", description: "Critique.", dependsOnKeys: ["score"], searchQueries: [], priority: 30 },
          { key: "report", type: "report.generate", description: "Write the report.", dependsOnKeys: ["critique", "contradictions"], searchQueries: [], priority: 10 },
        ],
        unanswerableIf: ["No source reports a measured recall comparison."],
      },
    },
    {
      when: "Extract evidence as JSON",
      repeat: true,
      json: {
        items: [
          {
            passageIndex: 1,
            quote: "Agents equipped with persistent memory recalled 18% more prior context than the control group.",
            interpretation: "A measured recall improvement attributed to persistent memory.",
            stance: "supports",
            relevance: 0.95,
            strength: { directness: 0.9, specificity: 0.9, methodologicalRigor: 0.6, quoteFidelity: 1 },
          },
          {
            passageIndex: 1,
            quote: "The authors note that the sample was drawn from a single deployment and may not generalise.",
            interpretation: "The finding's generality is limited by the sample.",
            stance: "mixed",
            relevance: 0.8,
            strength: { directness: 0.7, specificity: 0.7, methodologicalRigor: 0.6, quoteFidelity: 1 },
          },
          {
            // PLANTED: this sentence is not in the document. Mechanical
            // verification must catch it.
            passageIndex: 1,
            quote: "Memory eliminated hallucination entirely across every benchmark tested.",
            interpretation: "A far stronger claim than the paper makes.",
            stance: "supports",
            relevance: 0.9,
            strength: { directness: 0.9, specificity: 0.9, methodologicalRigor: 0.8, quoteFidelity: 1 },
          },
        ],
        notes: "",
      },
    },
    {
      when: "Extract atomic claims as JSON",
      repeat: true,
      json: {
        claims: [
          {
            statement: "Persistent memory improved recall of prior context by 18% relative to a control group.",
            claimType: "empirical",
            scope: "A single deployment, across three trials.",
            assumptions: ["Recall was measured the same way in both arms."],
            evidence: [{ evidenceIndex: 1, stance: "supports", rationale: "States the measured improvement." }],
          },
          {
            statement: "The reported recall improvement may not generalise beyond the studied deployment.",
            claimType: "methodological",
            scope: null,
            assumptions: [],
            evidence: [{ evidenceIndex: 2, stance: "supports", rationale: "The authors say so." }],
          },
          {
            // PLANTED: every cited index is out of range, so this claim has
            // nothing behind it and must never reach the report.
            statement: "Persistent memory is universally superior for all agent architectures.",
            claimType: "causal",
            scope: null,
            assumptions: [],
            evidence: [{ evidenceIndex: 99, stance: "supports", rationale: "Invented citation." }],
          },
        ],
        unsupportable: ["Any claim about cost, which no source addresses."],
      },
    },
    {
      when: "Critique this research as JSON",
      repeat: true,
      json: {
        findings: [{
          kind: "overgeneralization",
          targetIndex: 1,
          description: "A single deployment cannot establish a general effect.",
          resolutionCriteria: "A replication in a second, independent deployment.",
          severity: 0.6,
        }],
        alternativeExplanations: ["The control group may have had shorter sessions."],
        missingEvidence: ["A pre-registered replication."],
        overallAssessment: "The measured finding is credible but narrow.",
      },
    },
    {
      when: "Write the report as JSON",
      repeat: true,
      json: {
        title: "Persistent memory and agent recall",
        executiveSummary: "One trial reports an 18% recall improvement [claim 1]; its generality is limited [claim 2].",
        methodology: "One source was fetched, chunked and quoted. Every quote was checked against the source text.",
        confidenceRationale: "Confidence reflects a single source with a limited sample.",
        limitations: ["Only one source was available."],
        unansweredQuestions: ["Does the effect hold in other deployments?"],
        recommendedNextResearch: [{ direction: "Replicate in a second deployment.", rationale: "Generality is unestablished.", priority: 0.9 }],
        sections: [{ key: "findings", heading: "Findings", body: "Recall improved by 18% [claim 1].", claimIndices: [1] }],
      },
    },
  ];
}

/* ------------------------------------------------------------------ */

describe("a complete research run", () => {
  let server: Server;
  let baseUrl: string;
  let db: Database;
  let store: ResearchStore;

  before(async () => {
    server = createServer((request, response) => {
      if ((request.url ?? "").startsWith("/paper")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<html lang="en"><head>
          <meta name="citation_title" content="Persistent Memory and Recall in Autonomous Agents">
          <meta name="citation_author" content="Ada Lovelace">
          <meta name="citation_publication_date" content="2025-06-01">
          </head><body><h1>Results</h1><p>${PAPER_BODY}</p></body></html>`);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    db = new SqliteDatabase({ file: ":memory:" });
    await migrate(db);
    store = createStore(db);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function runToCompletion() {
    const startedAt = new Date().toISOString();
    const project = makeProject({
      status: "running",
      // A live run measured against the system clock, so the fixture's fixed
      // timestamp would make the project look seven months old.
      createdAt: startedAt,
      updatedAt: startedAt,
      budget: { maxTasks: 200, maxModelCalls: 100, maxCostUsd: 100 },
    });
    await store.projects.create(project);

    const provider = new ScriptedModelProvider({
      name: "scripted",
      models: scriptedModels(["scripted-1"], { provider: "scripted" }),
      script: script(baseUrl),
    });
    const router = new ModelRouter({ providers: [provider], logger: silentLogger });

    const search = new FixedSearchTool([{ url: `${baseUrl}/paper`, title: "Persistent Memory and Recall" }]);
    const tools = new ToolRegistry({
      providers: [new LocalToolProvider([search, new WebFetchTool({ allowedPrivateHosts: ["127.0.0.1"] })])],
    });
    await tools.refresh();

    const bus = new RecordingEventBus();
    const engine = createResearchEngine({
      store,
      router,
      logger: silentLogger,
      clock: systemClock,
      bus,
      tools,
      ingestion: new IngestionPipeline({ tools, chunkOptions: { targetChars: 1200, overlapChars: 100 } }),
      retriever: new ChunkRetriever({ repository: store.research }),
      memory: new ResearchMemory({ provider: new SqlMemoryProvider({ repository: store.memory }), tenantId: "acme" }),
    });

    const now = new Date().toISOString();
    await store.tasks.create([
      Task.parse({
        id: newId("task"), projectId: project.id, type: "plan.create", status: "pending", priority: 100,
        dependsOn: [], input: {}, output: null, leasedBy: null, leaseExpiresAt: null, runAfter: now,
        awaitingRequestId: null, errorCode: null, errorMessage: null, traceId: null,
        createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      }),
    ]);

    const worker = engine.createWorker({ workerId: "slice", batchSize: 4 });
    for (let tick = 0; tick < 30; tick++) {
      const result = await worker.tick(project.id);
      if (result.claimed === 0 && !(await store.tasks.hasRunnableWork(project.id))) break;
    }
    const settled = await engine.coordinator.settleIfFinished(project.id);

    return { project, engine, bus, search, settled, provider };
  }

  test("produces a report whose every finding traces to a source", async () => {
    const { project, bus, search, settled } = await runToCompletion();

    assert.equal(settled, "completed", "the run must finish, not stall");
    assert.ok(search.queries.length > 0, "the planned search actually ran");

    /* --- The chain exists, link by link --- */
    const sources = await store.research.listSources(project.id);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.title, "Persistent Memory and Recall in Autonomous Agents", "metadata came from the document");
    assert.equal(sources[0]?.status, "parsed");
    assert.equal(sources[0]?.contentHash?.length, 64, "content is hashed, so a re-fetch is comparable");

    const chunks = await store.research.listChunks(sources[0]!.id);
    assert.ok(chunks.length > 0);

    const evidence = await store.research.listEvidence(project.id);
    assert.ok(evidence.length >= 2);
    for (const item of evidence) {
      assert.ok(item.chunkIds.length > 0, "every evidence item points at the chunk it came from");
      assert.equal(item.sourceId, sources[0]?.id);
    }

    /* --- The report --- */
    const report = await store.reports.latest(project.id);
    assert.ok(report, "a report must exist");
    assert.equal(report.version, 1);
    assert.ok(report.keyFindings.length >= 2);

    const claims = await store.research.listClaims(project.id);
    const claimIds = new Set(claims.map((claim) => claim.id as string));
    for (const finding of report.keyFindings) {
      assert.ok(finding.claimIds.length > 0, "a finding with no claim behind it is a bug");
      for (const claimId of finding.claimIds) assert.ok(claimIds.has(claimId), "findings cite real claims");
      assert.ok(finding.citationMarkers.length > 0, "and each carries a citation marker");
    }

    const sourceIds = new Set(sources.map((source) => source.id as string));
    for (const citation of report.citations) {
      assert.ok(sourceIds.has(citation.sourceId), "every citation names a source row that exists");
      assert.ok(citation.url?.startsWith("http"), "with the URL it was actually fetched from");
    }

    assert.equal(report.originalQuestion, project.originalQuestion);
    assert.ok(report.statistics.sourcesConsidered >= 1);
    assert.ok(report.statistics.agentRuns >= 4, "the director, evidence, claim and synthesis agents all ran");

    /* --- Events tell the story --- */
    const types = bus.events.map((event) => event.type);
    for (const expected of [
      "research.plan.created", "research.source.processed", "research.evidence.extracted",
      "research.claim.created", "research.verification.completed", "research.report.generated",
    ]) {
      assert.ok(types.includes(expected as never), `expected a ${expected} event`);
    }

    const stored = await store.events.read(project.id, { limit: 500 });
    assert.deepEqual(stored.map((event) => event.sequence), stored.map((_event, index) => index + 1), "the event log is gapless");
  });

  test("every emitted event validates against its declared payload", async () => {
    const { project } = await runToCompletion();
    const stored = await store.events.read(project.id, { limit: 500 });

    assert.ok(stored.length >= 8, "a real run emits a substantial stream");

    // `parseEvent` checks the envelope and then the payload schema registered
    // for that event type. An emit that drifts from its contract is invisible to
    // a client subscribing by type and is rejected here — which is the whole
    // point of declaring payloads alongside the vocabulary.
    for (const event of stored) {
      assert.doesNotThrow(
        () => parseEvent(event),
        `event ${event.sequence} (${event.type}) does not match its declared payload: ${JSON.stringify(event.payload)}`,
      );
    }

    // And the stream is id-centric: a client can act on each event without
    // re-fetching the project to find out what changed.
    const entityEvents = stored.filter((event) => event.type !== "research.evolution.derived");
    for (const event of entityEvents) {
      const payload = event.payload as Record<string, unknown>;
      const namesAnEntity = Object.keys(payload).some((key) => /Id$/.test(key)) ||
        ["research.project.created", "research.started", "research.plan.created", "research.project.status_changed", "research.failed", "research.completed", "research.cancelled", "research.verification.completed"].includes(event.type);
      assert.ok(namesAnEntity, `${event.type} names no entity: ${JSON.stringify(payload)}`);
    }
  });

  test("a fabricated quote is caught and does not become a supported finding", async () => {
    const { project } = await runToCompletion();

    const checks = await store.runs.listVerificationChecks(project.id, 500);
    const fidelity = checks.filter((check) => check.checkType === "citation_fidelity");
    assert.ok(fidelity.length >= 3, "every evidence item is checked");

    const failed = fidelity.filter((check) => check.outcome === "failed");
    assert.equal(failed.length, 1, "exactly the planted fabrication fails");
    assert.match(String(failed[0]?.detail), /does not appear in the cited source/);

    const evidence = await store.research.listEvidence(project.id);
    const fabricated = evidence.find((item) => item.quote.includes("eliminated hallucination"));
    assert.ok(fabricated);
    assert.equal(fabricated.verificationPassed, false, "the evidence row records that it failed");

    const report = await store.reports.latest(project.id);
    assert.ok(
      !report?.keyFindings.some((finding) => /hallucination/i.test(finding.statement)),
      "a fabricated quote must not produce a reported finding",
    );
  });

  test("a claim citing nothing never reaches the report", async () => {
    const { project } = await runToCompletion();

    const claims = await store.research.listClaims(project.id);
    assert.ok(
      !claims.some((claim) => claim.statement.includes("universally superior")),
      "a claim whose every citation was invented is discarded at extraction",
    );

    const report = await store.reports.latest(project.id);
    assert.ok(!report?.keyFindings.some((finding) => /universally superior/.test(finding.statement)));
  });

  test("confidence is computed from evidence, not asserted by the model", async () => {
    const { project } = await runToCompletion();

    const claims = await store.research.listClaims(project.id);
    const scored = claims.filter((claim) => claim.confidence !== null);
    assert.ok(scored.length > 0, "claims are scored");

    for (const claim of scored) {
      const breakdown = claim.confidence!;
      assert.equal(breakdown.method, "weighted-beta-v1");
      // The score is the posterior mean, and recomputing it by hand from the
      // stored pseudo-counts must agree — to the precision they are stored at.
      // `score` keeps 4 decimals and the posteriors 6, so the agreement bound
      // is the rounding of the stored values, not machine epsilon.
      const recomputed = breakdown.posteriorAlpha / (breakdown.posteriorAlpha + breakdown.posteriorBeta);
      assert.ok(
        Math.abs(recomputed - breakdown.score) < 1e-4,
        `the score must be reproducible by hand from its own stored inputs (stored ${breakdown.score}, recomputed ${recomputed})`,
      );

      // And the posterior must be the prior plus the evidence weights, which is
      // the step a reader would check first.
      assert.ok(Math.abs(breakdown.priorAlpha + breakdown.supportWeight - breakdown.posteriorAlpha) < 1e-4);
      assert.ok(Math.abs(breakdown.priorBeta + breakdown.contradictionWeight - breakdown.posteriorBeta) < 1e-4);
      assert.ok(breakdown.contributions.length > 0, "and every contributing evidence item is recorded");
      assert.equal(breakdown.uncertaintyInterval.length, 2);
    }
  });

  test("the report records what the run could not do", async () => {
    const { project } = await runToCompletion();
    const report = await store.reports.latest(project.id);

    assert.ok(report);
    assert.ok(report.limitations.length > 0, "a report that omits its limitations overstates itself");
    assert.ok(report.unansweredQuestions.length > 0);
    assert.ok(report.overallConfidence > 0 && report.overallConfidence <= 1);
  });

  test("the engine reports its capability gaps rather than hiding them", async () => {
    const provider = new ScriptedModelProvider({ name: "scripted", models: scriptedModels(["m"], { provider: "scripted" }) });
    const engine = createResearchEngine({
      store,
      router: new ModelRouter({ providers: [provider], logger: silentLogger }),
      logger: silentLogger,
      clock: systemClock,
      bus: new InMemoryEventBus(),
    });

    const gaps = engine.capabilityGaps();
    assert.ok(gaps.some((gap) => /No tool registry/.test(gap)));
    assert.ok(gaps.some((gap) => /No ingestion pipeline/.test(gap)));
    assert.ok(gaps.some((gap) => /No experiment runner/.test(gap)));
    assert.ok(gaps.some((gap) => /Only one model provider/.test(gap)), "independence is unavailable and says so");
  });

  test("every task type in the contract has a handler", () => {
    const provider = new ScriptedModelProvider({ name: "scripted", models: scriptedModels(["m"], { provider: "scripted" }) });
    const engine = createResearchEngine({
      store,
      router: new ModelRouter({ providers: [provider], logger: silentLogger }),
      logger: silentLogger,
      clock: systemClock,
    });

    // A task type with no handler fails terminally at run time with
    // `not_implemented`, which is honest but means a plan naming it can never
    // succeed. Checking the whole vocabulary here catches that at build time.
    const supported = new Set(engine.supportedTaskTypes());
    const missing = TASK_TYPES.filter((type) => !supported.has(type));
    assert.deepEqual(missing, [], `these task types have no handler: ${missing.join(", ")}`);
  });

  test("a run with no search capability blocks discovery instead of inventing sources", async () => {
    const startedAt = new Date().toISOString();
    const project = makeProject({ status: "running", createdAt: startedAt, updatedAt: startedAt });
    await store.projects.create(project);

    const provider = new ScriptedModelProvider({
      name: "scripted",
      models: scriptedModels(["m"], { provider: "scripted" }),
      script: script(baseUrl),
    });
    // A tool registry with fetching but no search — the common real case.
    const tools = new ToolRegistry({ providers: [new LocalToolProvider([new WebFetchTool()])] });
    await tools.refresh();

    const engine = createResearchEngine({
      store,
      router: new ModelRouter({ providers: [provider], logger: silentLogger }),
      logger: silentLogger,
      clock: systemClock,
      tools,
      ingestion: new IngestionPipeline({ tools }),
      retriever: new ChunkRetriever({ repository: store.research }),
    });

    const now = new Date().toISOString();
    await store.tasks.create([
      Task.parse({
        id: newId("task"), projectId: project.id, type: "source.discover", status: "pending", priority: 90,
        dependsOn: [], input: { searchQueries: ["persistent memory"] }, output: null, leasedBy: null,
        leaseExpiresAt: null, runAfter: now, awaitingRequestId: null, errorCode: null, errorMessage: null,
        traceId: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      }),
    ]);

    await engine.createWorker().tick(project.id);

    const tasks = await store.tasks.list(project.id, { status: "failed" });
    assert.equal(tasks.length, 1);
    assert.match(String(tasks[0]?.errorMessage), /^BLOCKED: source discovery/);
    assert.match(String(tasks[0]?.errorMessage), /will not answer from model recollection/);
    assert.equal(tasks[0]?.attempts, 1, "a missing capability is not retried — waiting does not configure one");
  });
});
