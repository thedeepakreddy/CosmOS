/**
 * The generative half of a research run.
 *
 * Debate, hypothesis generation, question decomposition, evolution and
 * experiments — the handlers that let a run follow what it finds rather than
 * only execute a plan written before anything was known.
 *
 * Driven through the real worker against a real database, with a scripted model
 * so the assertions are about behaviour rather than about what a model happened
 * to say.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Task } from "@research-os/contracts";
import { RecordingEventBus } from "@research-os/events";
import { silentLogger } from "@research-os/observability";
import { createStore, migrate, SqliteDatabase, type Database, type ResearchStore } from "@research-os/persistence";
import { ModelRouter, ScriptedModelProvider, scriptedModels, type ScriptedTurn } from "@research-os/model-router";
import { LocalProcessRunner, UnavailableExperimentRunner } from "@research-os/experiments";
import { SqlMemoryProvider, ResearchMemory } from "@research-os/memory";
import { systemClock, newId } from "@research-os/shared";
import { resetDatabase } from "../../../tests/support/reset-database.ts";
import {
  makeClaim, makeClaimEvidenceLink, makeConfidence, makeContradiction, makeEvidence, makeProject, makeSource,
} from "../../../tests/support/fixtures.ts";
import { createResearchEngine, type ResearchEngine } from "../src/index.ts";

/* ---------- Scripted turns, keyed on each agent's prompt ---------- */

const DEBATE_TURNS: ScriptedTurn[] = [
  {
    when: "Make your argument as JSON",
    repeat: true,
    json: {
      position: "qualify",
      argument: "The measured effect is real but the sample is one deployment.",
      citedEvidenceIndices: [1],
      rebutsRounds: [],
    },
  },
  {
    when: "Deliver your verdict as JSON",
    repeat: true,
    json: {
      position: "qualify",
      reasoning: "The evidence supports a narrow version of the claim.",
      decidingFactors: [{ factor: "scope_fit", weight: 0.8, note: "One deployment cannot establish a general effect." }],
      dissent: [{ roleName: "evidence_agent", position: "affirm", whyRejected: "Overstates the scope." }],
      agreementLevel: 0.6,
      residualUncertainties: ["Generality is unestablished."],
    },
  },
];

const HYPOTHESIS_TURN: ScriptedTurn = {
  when: "Propose hypotheses as JSON",
  repeat: true,
  json: {
    hypotheses: [{
      statement: "The recall gain comes from reduced context re-derivation rather than from storage itself.",
      rationale: "It would explain both the gain and the added latency.",
      falsificationCriteria: "An arm with storage but no re-derivation saving shows the same gain.",
      plausibility: "plausible",
      explainsClaimIndices: [1],
      testableBy: "experiment",
    }],
    discarded: [{ statement: "Memory is simply better.", whyDiscarded: "Not falsifiable as stated." }],
  },
};

const DECOMPOSE_TURN: ScriptedTurn = {
  when: "Decompose as JSON",
  repeat: true,
  json: {
    subQuestions: [
      { text: "Does the gain persist beyond one deployment?", rationale: "Generality is unestablished.", priority: 85, contributesBy: "Settles scope.", likelyAnswerable: "needs_new_sources" },
      { text: "Is the effect attributable to a mechanism nobody can measure here?", rationale: "No instrument exists.", priority: 20, contributesBy: "Nothing.", likelyAnswerable: "unanswerable" },
    ],
    alreadyAtomic: false,
    notes: "",
  },
};

const EVOLUTION_TURN: ScriptedTurn = {
  when: "Record how understanding changed",
  repeat: true,
  json: {
    summary: "One measured finding, narrow in scope, with generality unestablished.",
    heldUp: [1],
    revised: [],
    emergentQuestions: [{ text: "Does the effect hold under memory pressure?", whyItArose: "Latency rose with context.", priority: 70 }],
    nextDirections: [{ direction: "Replicate in a second deployment.", rationale: "Generality is unestablished.", expectedValue: "Would settle scope.", priority: 0.9 }],
    deadEnds: [
      { approach: "Keyword search alone", reason: "Missed the relevant literature", lesson: "Use citation chaining", transferable: true },
      { approach: "Keyword search alone", reason: "Missed the relevant literature", lesson: "Use citation chaining", transferable: true },
    ],
  },
};

const EXPERIMENT_DESIGN_TURN: ScriptedTurn = {
  when: "Design the experiment as JSON",
  repeat: true,
  json: {
    title: "Re-derivation cost under memory",
    design: "Compare context re-derivation counts with and without persistent memory.",
    expectedOutcome: "Fewer re-derivations in the memory arm.",
    falsificationCriteria: "Equal or higher re-derivation counts in the memory arm.",
    runtime: "node",
    code: "console.log('RESEARCHOS_METRIC ' + JSON.stringify({ rederivations: 12, recall: 0.87 }));",
    dependencies: [],
    parameters: { randomSeed: 7 },
    expectedMetrics: ["rederivations", "recall"],
    limitations: ["Synthetic data."],
  },
};

const ANALYSIS_TURN: ScriptedTurn = {
  when: "Analyse as JSON",
  repeat: true,
  json: {
    summary: "Re-derivation count is consistent across runs.",
    observations: [{ statement: "Recall was 0.87.", metrics: ["recall"], support: "direct" }],
    overinterpretations: ["That this generalises beyond synthetic data."],
    limitations: ["Synthetic data, single machine."],
    suggestedAnalyses: ["A paired test across deployments."],
  },
};

/* ---------- Harness ---------- */

describe("phase 5 handlers", () => {
  let db: Database;
  let store: ResearchStore;

  before(async () => {
    db = new SqliteDatabase({ file: ":memory:" });
    await migrate(db);
    store = createStore(db);
  });

  after(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  function buildEngine(script: ScriptedTurn[], overrides: Record<string, unknown> = {}): { engine: ResearchEngine; bus: RecordingEventBus } {
    const bus = new RecordingEventBus();
    const engine = createResearchEngine({
      store,
      router: new ModelRouter({
        providers: [new ScriptedModelProvider({ name: "scripted", models: scriptedModels(["m"], { provider: "scripted" }), script })],
        logger: silentLogger,
      }),
      logger: silentLogger,
      clock: systemClock,
      bus,
      memory: new ResearchMemory({ provider: new SqlMemoryProvider({ repository: store.memory }), tenantId: "acme" }),
      ...overrides,
    });
    return { engine, bus };
  }

  async function seedProject(): Promise<string> {
    const now = new Date().toISOString();
    const project = makeProject({ status: "running", createdAt: now, updatedAt: now, tenantId: "acme" });
    await store.projects.create(project);
    return project.id;
  }

  async function runTask(engine: ResearchEngine, projectId: string, type: Task["type"], input: unknown = {}): Promise<Task> {
    const now = new Date().toISOString();
    const task = Task.parse({
      id: newId("task"), projectId, type, status: "pending", priority: 50, dependsOn: [], input,
      output: null, leasedBy: null, leaseExpiresAt: null, runAfter: now, awaitingRequestId: null,
      errorCode: null, errorMessage: null, traceId: null, createdAt: now, updatedAt: now,
      startedAt: null, finishedAt: null,
    });
    await store.tasks.create([task]);
    await engine.createWorker({ batchSize: 1 }).tick(projectId);
    const loaded = await store.tasks.findById(task.id);
    assert.ok(loaded);
    return loaded;
  }

  /** A claim with two pieces of evidence, contested enough to be worth debating. */
  async function seedContestedClaim(projectId: string): Promise<string> {
    const source = makeSource(projectId, { contentHash: newId("source") });
    await store.research.upsertSource(source);
    const supporting = makeEvidence(projectId, source.id, { stance: "supports" });
    const opposing = makeEvidence(projectId, source.id, { stance: "contradicts", quote: "No difference was observed between arms." });
    await store.research.addEvidence([supporting, opposing]);

    const claim = makeClaim(projectId, { status: "contested", confidence: makeConfidence(0.5) });
    await store.research.addClaim(claim);
    await store.research.linkEvidence([
      makeClaimEvidenceLink(claim.id, supporting.id, { stance: "supports" }),
      makeClaimEvidenceLink(claim.id, opposing.id, { stance: "contradicts" }),
    ]);
    return claim.id;
  }

  /* ---------- Debate ---------- */

  describe("debate.run", () => {
    test("a contested claim is debated, judged, and rescored with the agreement level", async () => {
      const { engine, bus } = buildEngine(DEBATE_TURNS);
      const projectId = await seedProject();
      const claimId = await seedContestedClaim(projectId);

      const task = await runTask(engine, projectId, "debate.run", { claimId });
      assert.equal(task.status, "completed", String(task.errorMessage));

      const output = task.output as { debated: number; position: string; agreementLevel: number; dissent: number; newStatus: string };
      assert.equal(output.debated, 1);
      assert.equal(output.position, "qualify");
      assert.equal(output.newStatus, "contested", "a qualified verdict leaves the claim contested");
      assert.equal(output.dissent, 1, "the minority position is preserved, not deleted");

      const debates = await store.runs.listDebates(projectId, claimId);
      assert.equal(debates.length, 1);
      assert.ok(debates[0]!.turns.length >= 2, "both sides argued");
      assert.ok(debates[0]!.turns.every((turn) => turn.citedEvidenceIds.length > 0), "arguments cite real evidence ids");
      assert.equal(debates[0]!.verdict?.agreementLevel, 0.6);

      assert.ok(bus.events.some((event) => event.type === "research.debate.judged"));
    });

    test("the judge's agreement level widens the interval rather than moving the score", async () => {
      const { engine } = buildEngine(DEBATE_TURNS);
      const projectId = await seedProject();
      const claimId = await seedContestedClaim(projectId);

      const before = await store.research.findClaim(claimId);
      const beforeWidth = (before!.confidence!.uncertaintyInterval[1] - before!.confidence!.uncertaintyInterval[0]);

      await runTask(engine, projectId, "debate.run", { claimId });

      const after = await store.research.findClaim(claimId);
      const afterWidth = (after!.confidence!.uncertaintyInterval[1] - after!.confidence!.uncertaintyInterval[0]);

      assert.ok(afterWidth > 0);
      assert.ok(
        afterWidth >= beforeWidth * 0.5,
        "disagreement is a reason to be less certain, not a reason to believe something different",
      );
    });

    test("with nothing contested, no debate is run and budget is not spent", async () => {
      const { engine } = buildEngine(DEBATE_TURNS);
      const projectId = await seedProject();

      const task = await runTask(engine, projectId, "debate.run", {});
      assert.equal(task.status, "completed");
      assert.equal((task.output as { debated: number }).debated, 0);
      assert.match(String((task.output as { note: string }).note), /spends budget to restate agreement/);
    });

    test("a claim citing no evidence is not debated", async () => {
      const { engine } = buildEngine(DEBATE_TURNS);
      const projectId = await seedProject();
      const claim = makeClaim(projectId, { status: "contested", confidence: makeConfidence(0.5) });
      await store.research.addClaim(claim);

      const task = await runTask(engine, projectId, "debate.run", { claimId: claim.id });
      assert.equal((task.output as { debated: number }).debated, 0);
      assert.match(String((task.output as { note: string }).note), /nothing to argue from/);
    });

    test("an open contradiction is preferred over a merely uncertain claim", async () => {
      const { engine } = buildEngine(DEBATE_TURNS);
      const projectId = await seedProject();
      const claimId = await seedContestedClaim(projectId);
      const other = makeClaim(projectId, { statement: "A conflicting claim.", confidence: makeConfidence(0.5) });
      await store.research.addClaim(other);
      await store.research.addContradiction(
        makeContradiction(projectId, claimId, other.id, { severity: 0.9, status: "open" }),
      );

      const task = await runTask(engine, projectId, "debate.run", {});
      const debates = await store.runs.listDebates(projectId);
      assert.equal((task.output as { debated: number }).debated, 1);
      assert.equal(debates[0]?.subjectType, "contradiction", "two claims that cannot both be true is the productive place to argue");
    });
  });

  /* ---------- Hypothesis generation ---------- */

  describe("hypothesis.generate", () => {
    test("proposes falsifiable hypotheses and records a prior from the plausibility band", async () => {
      const { engine, bus } = buildEngine([HYPOTHESIS_TURN]);
      const projectId = await seedProject();
      await seedContestedClaim(projectId);

      const task = await runTask(engine, projectId, "hypothesis.generate");
      assert.equal(task.status, "completed", String(task.errorMessage));

      const stored = await store.projects.listHypotheses(projectId);
      assert.equal(stored.length, 1);
      assert.ok(stored[0]!.falsificationCriteria, "a hypothesis with no falsification criteria is not testable");
      assert.equal(stored[0]!.priorConfidence, 0.4, "the band maps to a stated prior, not a model-asserted number");
      assert.equal(stored[0]!.posteriorConfidence, null, "nothing has tested it yet");

      const output = task.output as { generated: number; testableByExperiment: number; discarded: unknown[] };
      assert.equal(output.generated, 1);
      assert.equal(output.testableByExperiment, 1);
      assert.equal(output.discarded.length, 1, "explanations set aside are kept with the reason");

      assert.ok(bus.events.some((event) => event.type === "research.hypothesis.created"));
    });
  });

  /* ---------- Question decomposition ---------- */

  describe("question.decompose", () => {
    test("adds emergent questions and marks the unanswerable one as such", async () => {
      const { engine } = buildEngine([DECOMPOSE_TURN]);
      const projectId = await seedProject();

      const task = await runTask(engine, projectId, "question.decompose", {});
      assert.equal(task.status, "completed", String(task.errorMessage));

      const questions = await store.projects.listQuestions(projectId);
      assert.equal(questions.length, 2);
      assert.ok(questions.every((question) => question.kind === "emergent"), "a reader can tell which parts the evidence forced");

      const unanswerable = questions.find((question) => question.status === "unanswerable");
      assert.ok(unanswerable, "a question no evidence could settle is recorded, not queued");
      assert.equal((task.output as { unanswerable: number }).unanswerable, 1);
    });

    test("an atomic question is not split", async () => {
      const { engine } = buildEngine([{
        when: "Decompose as JSON",
        repeat: true,
        json: { subQuestions: [], alreadyAtomic: true, notes: "Already answerable as posed." },
      }]);
      const projectId = await seedProject();

      const task = await runTask(engine, projectId, "question.decompose", {});
      assert.equal((task.output as { added: number; alreadyAtomic: boolean }).added, 0);
      assert.equal((task.output as { alreadyAtomic: boolean }).alreadyAtomic, true);
      assert.equal((await store.projects.listQuestions(projectId)).length, 0);
    });
  });

  /* ---------- Evolution and failure memory ---------- */

  describe("evolution.derive", () => {
    test("records emergent questions, dead ends and next directions", async () => {
      const { engine, bus } = buildEngine([EVOLUTION_TURN]);
      const projectId = await seedProject();
      await seedContestedClaim(projectId);

      const task = await runTask(engine, projectId, "evolution.derive");
      assert.equal(task.status, "completed", String(task.errorMessage));

      const output = task.output as { emergentQuestions: number; deadEndsRecorded: number; deadEndsAlreadyKnown: number; nextDirections: unknown[] };
      assert.equal(output.emergentQuestions, 1);
      assert.equal(output.nextDirections.length, 1);

      const questions = await store.projects.listQuestions(projectId);
      assert.equal(questions[0]?.kind, "emergent");

      assert.ok(bus.events.some((event) => event.type === "research.evolution.derived"));
    });

    test("the same dead end is recorded once, however many times it is reported", async () => {
      const { engine } = buildEngine([EVOLUTION_TURN]);
      const projectId = await seedProject();
      await seedContestedClaim(projectId);

      // The scripted turn reports the identical dead end twice.
      const task = await runTask(engine, projectId, "evolution.derive");
      const output = task.output as { deadEndsRecorded: number; deadEndsAlreadyKnown: number };

      assert.equal(output.deadEndsRecorded, 1);
      assert.equal(output.deadEndsAlreadyKnown, 1, "a run hitting the same wall twice must not crowd out distinct dead ends");
      assert.equal((await store.runs.listFailures(projectId)).length, 1);
    });

    test("a dead end recorded here is read by the next project's planner", async () => {
      const { engine } = buildEngine([EVOLUTION_TURN]);
      const projectId = await seedProject();
      await seedContestedClaim(projectId);
      await runTask(engine, projectId, "evolution.derive");

      const laterProject = makeProject({ status: "running", tenantId: "acme" });
      await store.projects.create(laterProject);

      const inherited = await store.runs.transferableFailures(laterProject.id);
      assert.equal(inherited.length, 1, "this is the whole mechanism behind not repeating a failed approach");
      assert.match(inherited[0]!.approach, /Keyword search alone/);
      assert.equal(inherited[0]!.lesson, "Use citation chaining");
    });

    test("next directions are remembered as lessons for a later project", async () => {
      const provider = new SqlMemoryProvider({ repository: store.memory });
      const memory = new ResearchMemory({ provider, tenantId: "acme" });
      const { engine } = buildEngine([EVOLUTION_TURN], { memory });

      const projectId = await seedProject();
      await seedContestedClaim(projectId);
      await runTask(engine, projectId, "evolution.derive");

      const recalled = await memory.recallLessons("replicate deployment generality");
      assert.ok(recalled.length >= 1, "a direction nobody remembers is rediscovered from scratch next time");
    });
  });

  /* ---------- Experiments ---------- */

  describe("experiment.design and experiment.run", () => {
    test("a design is stored, and marked not runnable when nothing can run it", async () => {
      const { engine } = buildEngine([EXPERIMENT_DESIGN_TURN, HYPOTHESIS_TURN], {
        experimentRunner: new UnavailableExperimentRunner(),
      });
      const projectId = await seedProject();
      await seedContestedClaim(projectId);
      await runTask(engine, projectId, "hypothesis.generate");

      const task = await runTask(engine, projectId, "experiment.design");
      assert.equal(task.status, "completed", String(task.errorMessage));

      const output = task.output as { status: string; runnable: boolean };
      assert.equal(output.status, "designed");
      assert.equal(output.runnable, false, "a design nobody can execute is not 'ready'");

      const experiments = await store.experiments.listExperiments(projectId);
      assert.ok(experiments[0]!.falsificationCriteria, "an experiment that cannot fail establishes nothing");
    });

    test("with no runner, running is BLOCKED and no result is invented", async () => {
      const { engine } = buildEngine([EXPERIMENT_DESIGN_TURN]);
      const projectId = await seedProject();

      const task = await runTask(engine, projectId, "experiment.run", {});
      assert.equal(task.status, "failed");
      assert.match(String(task.errorMessage), /^BLOCKED: experiment execution/);
      assert.match(String(task.errorMessage), /must never be reported as one/);
      assert.equal(task.attempts, 1, "a missing capability is not retried");
    });

    test("a real experiment runs repeatedly, and the analyst interprets only what was measured", async () => {
      const { engine, bus } = buildEngine([EXPERIMENT_DESIGN_TURN, HYPOTHESIS_TURN, ANALYSIS_TURN], {
        experimentRunner: new LocalProcessRunner({ acknowledgeUnsandboxedExecution: true, runtimes: ["node"] }),
      });
      const projectId = await seedProject();
      await seedContestedClaim(projectId);
      await runTask(engine, projectId, "hypothesis.generate");
      await runTask(engine, projectId, "experiment.design");

      const task = await runTask(engine, projectId, "experiment.run", { repeats: 2 });
      assert.equal(task.status, "completed", String(task.errorMessage));

      const output = task.output as {
        runs: number; succeeded: number; reproducibilityScore: number;
        replications: number; interpretation: string | null; overinterpretations: string[];
      };
      assert.equal(output.runs, 2, "one run is an anecdote");
      assert.equal(output.succeeded, 2);
      assert.equal(output.replications, 1, "the second run reproduced the first");
      assert.equal(output.reproducibilityScore, 1);
      assert.ok(output.interpretation, "the analyst read the numbers");
      assert.ok(output.overinterpretations.length > 0, "and named what the data does not license");

      const runs = await store.experiments.listRuns((await store.experiments.listExperiments(projectId))[0]!.id);
      assert.deepEqual(runs[0]?.metrics, { rederivations: 12, recall: 0.87 }, "metrics come from marker lines, not from prose");
      assert.ok(runs.some((run) => run.interpretation !== null), "the reading is stored beside the numbers, not instead of them");

      assert.ok(bus.events.some((event) => event.type === "research.experiment.completed"));
    });

    test("a failed experiment gets no interpretation", async () => {
      const failing: ScriptedTurn = {
        when: "Design the experiment as JSON",
        repeat: true,
        json: {
          ...(EXPERIMENT_DESIGN_TURN.json as Record<string, unknown>),
          code: "process.exit(3)",
        },
      };
      const { engine } = buildEngine([failing, HYPOTHESIS_TURN, ANALYSIS_TURN], {
        experimentRunner: new LocalProcessRunner({ acknowledgeUnsandboxedExecution: true, runtimes: ["node"] }),
      });
      const projectId = await seedProject();
      await seedContestedClaim(projectId);
      await runTask(engine, projectId, "hypothesis.generate");
      await runTask(engine, projectId, "experiment.design");

      const task = await runTask(engine, projectId, "experiment.run", { repeats: 1 });
      const output = task.output as { succeeded: number; interpretation: string | null };

      assert.equal(output.succeeded, 0);
      assert.equal(output.interpretation, null, "asking a model to interpret nothing is how a failed experiment acquires a narrative");
    });
  });

  /* ---------- Evidence linking ---------- */

  describe("claim.link_evidence", () => {
    test("links later evidence to an earlier claim, and does not duplicate a link", async () => {
      const { engine } = buildEngine([]);
      const projectId = await seedProject();

      const source = makeSource(projectId, { contentHash: newId("source") });
      await store.research.upsertSource(source);
      const claim = makeClaim(projectId, { statement: "Persistent memory improves recall of prior context." });
      await store.research.addClaim(claim);
      await store.research.addEvidence([
        makeEvidence(projectId, source.id, { quote: "Persistent memory improved recall of prior context markedly." }),
      ]);

      const first = await runTask(engine, projectId, "claim.link_evidence");
      assert.equal((first.output as { linked: number }).linked, 1);
      assert.equal((first.output as { rescoreRequired: boolean }).rescoreRequired, true);

      const second = await runTask(engine, projectId, "claim.link_evidence");
      assert.equal((second.output as { linked: number }).linked, 0, "an existing link is not written twice");
    });

    test("unrelated evidence is not linked", async () => {
      const { engine } = buildEngine([]);
      const projectId = await seedProject();

      const source = makeSource(projectId, { contentHash: newId("source") });
      await store.research.upsertSource(source);
      await store.research.addClaim(makeClaim(projectId, { statement: "Persistent memory improves recall of prior context." }));
      await store.research.addEvidence([
        makeEvidence(projectId, source.id, {
          quote: "Quarterly revenue in the northern territories fell by eleven percent.",
          // The fixture's default interpretation mentions memory and recall, so
          // it has to be overridden too — otherwise the evidence is not
          // unrelated and the test would pass for the wrong reason.
          interpretation: "A regional sales figure with no bearing on the question.",
        }),
      ]);

      const task = await runTask(engine, projectId, "claim.link_evidence");
      assert.equal((task.output as { linked: number }).linked, 0);
    });
  });

  /* ---------- Evaluation ---------- */

  describe("project evaluation", () => {
    test("a project whose findings are unverified is graded unsound", async () => {
      const { engine } = buildEngine([]);
      const projectId = await seedProject();
      await seedContestedClaim(projectId);

      const { evaluateResearchProject } = await import("../src/evaluate.ts");
      const evaluation = await evaluateResearchProject(engine.deps.store, projectId);

      assert.equal(evaluation.projectId, projectId);
      assert.equal(evaluation.grade, "unsound", "nothing was verified");
      assert.ok(evaluation.blockers.some((blocker) => /Nothing was verified/.test(blocker)));
      assert.ok(evaluation.caveats.length >= 3, "the caveats travel with every score");
      assert.match(evaluation.caveats[0] ?? "", /not whether its conclusions are true/);
    });
  });
});
