/**
 * The planner's contract with the rest of the engine.
 *
 * A plan is not just text: every step becomes a task, and a step the engine
 * cannot satisfy becomes a task that fails. Because a failed task strands every
 * task depending on it — see `orchestration.test.ts` — a single unplannable
 * step type silently halts an entire run.
 *
 * That is not hypothetical. The prompt once said "Evidence extraction depends
 * on ingestion", so a live model dutifully planned a `source.ingest` step. The
 * planner has no URLs to put in one — discovery supplies those — so the task
 * failed with "source.ingest requires a url", and extraction, claims and the
 * report behind it were never claimable. The run sat in `running` producing
 * nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TASK_TYPES } from "@research-os/contracts";
import { researchDirector, DirectorPlanOutput } from "../src/agents/research-director.ts";
import { withRequiredIntegritySteps } from "../src/handlers/planning.ts";

const systemPrompt = researchDirector.systemPrompt({
  preferences: { depth: "standard" },
} as Parameters<typeof researchDirector.systemPrompt>[0]);

describe("research director prompt", () => {
  test("source.ingest is not offered as a plannable step", () => {
    const offered = systemPrompt.slice(systemPrompt.indexOf("Step types available:"));
    assert.ok(
      !/\bsource\.ingest\b/.test(offered.split("\n\n")[0] ?? ""),
      "a planned source.ingest has no URL, fails, and strands every step behind it",
    );
  });

  test("the prompt says why, so a model is not left guessing", () => {
    assert.match(systemPrompt, /source\.ingest/, "silence invites the model to reach for it anyway");
    assert.match(systemPrompt, /scheduled for you|created automatically/i);
  });

  test("every other step type the engine handles is still offered", () => {
    const offered = systemPrompt.slice(systemPrompt.indexOf("Step types available:"));
    for (const type of ["source.discover", "evidence.extract", "claim.extract", "claim.score", "verification.run", "report.generate"]) {
      assert.ok(offered.includes(type), `${type} must remain plannable`);
    }
  });

  test("dependency guidance points extraction at discovery, not ingestion", () => {
    assert.match(systemPrompt, /Evidence extraction depends on\s+discovery/);
  });

  /*
   * The schema still admits every task type. Narrowing it would be the stronger
   * guarantee, but it would also reject a plan outright where today the prompt
   * steers and the engine tolerates. Asserted so the gap is visible: the
   * prompt is the only thing preventing an unplannable step.
   */
  test("the schema itself still permits any task type — the prompt is the only guard", () => {
    const parsed = DirectorPlanOutput.safeParse({
      interpretation: "i",
      objectives: [{ statement: "s", rationale: "r" }],
      subQuestions: [{ text: "t", rationale: "r", priority: 50 }],
      hypotheses: [{ statement: "s", rationale: "r", falsificationCriteria: "f" }],
      strategy: "s",
      steps: [{ key: "k", type: "source.ingest", description: "d", dependsOnKeys: [], searchQueries: [], priority: 50 }],
      unanswerableIf: [],
    });
    assert.equal(parsed.success, true, "a model that ignores the prompt is still accepted by the contract");
    assert.ok(TASK_TYPES.includes("source.ingest"));
  });
});

/**
 * Verification and scoring are a system invariant, not a planning choice.
 *
 * A live model planned neither. The run completed, the report read
 * authoritatively, every finding carried confidence 0.000, and the evaluation
 * came back blocked with "Nothing was verified. No quote or figure was checked
 * against its source." The guarantee this system exists to make was optional at
 * the model's whim, so `withRequiredIntegritySteps` now supplies what a plan
 * omits.
 */
describe("required integrity steps", () => {
  const base = [
    { key: "d", type: "source.discover" as const, description: "", dependsOnKeys: [], searchQueries: [], priority: 90 },
    { key: "e", type: "evidence.extract" as const, description: "", dependsOnKeys: ["d"], searchQueries: [], priority: 80 },
    { key: "c", type: "claim.extract" as const, description: "", dependsOnKeys: ["e"], searchQueries: [], priority: 70 },
    { key: "r", type: "report.generate" as const, description: "", dependsOnKeys: ["c"], searchQueries: [], priority: 10 },
  ];

  test("a plan omitting both gets both, and the report waits for them", () => {
    const out = withRequiredIntegritySteps(base);
    const types = out.map((step) => step.type);
    assert.ok(types.includes("verification.run"), "an unverified report is the failure this system exists to prevent");
    assert.ok(types.includes("claim.score"));

    const report = out.find((step) => step.type === "report.generate");
    const added = out.filter((step) => step.type === "verification.run" || step.type === "claim.score").map((step) => step.key);
    for (const key of added) {
      assert.ok(report?.dependsOnKeys.includes(key), "a report written before its claims were checked states unchecked findings");
    }
  });

  test("scoring runs after verification, so a failed check reaches the number", () => {
    const out = withRequiredIntegritySteps(base);
    const verification = out.find((step) => step.type === "verification.run");
    const scoring = out.find((step) => step.type === "claim.score");
    assert.ok(scoring?.dependsOnKeys.includes(verification?.key ?? ""), "scoring before verification would contradict it");
  });

  test("a plan that already has them is left alone", () => {
    const complete = [
      ...base.slice(0, 3),
      { key: "v", type: "verification.run" as const, description: "", dependsOnKeys: ["c"], searchQueries: [], priority: 45 },
      { key: "s", type: "claim.score" as const, description: "", dependsOnKeys: ["v"], searchQueries: [], priority: 40 },
      { key: "r", type: "report.generate" as const, description: "", dependsOnKeys: ["s"], searchQueries: [], priority: 10 },
    ];
    assert.deepEqual(withRequiredIntegritySteps(complete), complete, "the director places them better than the fallback");
  });

  test("a plan producing no claims gets nothing invented", () => {
    const noClaims = base.slice(0, 2);
    assert.deepEqual(withRequiredIntegritySteps(noClaims), noClaims,
      "there is nothing to verify, and inventing steps would not fix that");
  });

  test("the prompt asks for them, so the fallback is a safety net not the mechanism", () => {
    assert.match(systemPrompt, /ALWAYS includes a verification\.run step and a claim\.score step/);
  });
});
