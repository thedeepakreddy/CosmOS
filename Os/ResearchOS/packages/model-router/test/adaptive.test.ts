/**
 * Budget-pressure-aware routing.
 *
 * The property being protected is that a run finishes. A fixed policy spends the
 * same on the last task as on the first, and a run that exhausts its budget at
 * 80% produces nothing — having paid for everything.
 *
 * The property being protected *from* this is that saving money never silently
 * degrades the work that decides what the research concludes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor } from "@research-os/contracts";
import { createMemoryLogger, silentLogger } from "@research-os/observability";
import {
  CHEAPEST_CAPABLE_AT, ModelRouter, PREFER_CHEAPER_AT, PROTECTED_TASK_KINDS, ScriptedModelProvider,
  applyAdaptiveTier, decideAdaptiveTier, estimatedCallCostUsd, scriptedModels,
} from "../src/index.ts";

const model = (id: string, overrides: Partial<ModelDescriptor>): ModelDescriptor =>
  scriptedModels([id], { provider: "scripted", ...overrides })[0]!;

const FLAGSHIP = model("flagship", { reasoningTier: 1, inputCostPerMTokUsd: 15, outputCostPerMTokUsd: 75 });
const MIDRANGE = model("midrange", { reasoningTier: 0.8, inputCostPerMTokUsd: 3, outputCostPerMTokUsd: 15 });
const CHEAP = model("cheap", { reasoningTier: 0.4, inputCostPerMTokUsd: 0.25, outputCostPerMTokUsd: 1.25 });

const candidates = [FLAGSHIP, MIDRANGE, CHEAP].map((descriptor) => ({ descriptor }));

describe("tier selection", () => {
  test("a run within budget follows the policy unchanged", () => {
    const decision = decideAdaptiveTier("extraction", { pressure: 0.3 });
    assert.equal(decision.tier, "none");
    assert.match(decision.reason, /Within budget/);
  });

  test("pressure moves through the tiers in order", () => {
    assert.equal(decideAdaptiveTier("extraction", { pressure: PREFER_CHEAPER_AT - 0.01 }).tier, "none");
    assert.equal(decideAdaptiveTier("extraction", { pressure: PREFER_CHEAPER_AT }).tier, "prefer_cheaper");
    assert.equal(decideAdaptiveTier("extraction", { pressure: CHEAPEST_CAPABLE_AT }).tier, "cheapest_capable");
    assert.equal(decideAdaptiveTier("extraction", { pressure: 1 }).tier, "cheapest_capable");
  });

  test("work that decides the conclusion is never downgraded", () => {
    for (const taskKind of PROTECTED_TASK_KINDS) {
      const decision = decideAdaptiveTier(taskKind, { pressure: 1 });
      assert.equal(decision.tier, "none", `${taskKind} must not be downgraded`);
      assert.equal(decision.protectedKind, true);
      assert.match(decision.reason, /cheaper wrong answer/);
    }
  });

  test("the reason is stated, so a downgrade is never silent", () => {
    const decision = decideAdaptiveTier("extraction", { pressure: 0.95 });
    assert.match(decision.reason, /95% of the tightest budget ceiling/);
    assert.match(decision.reason, /cheapest capable/);
  });
});

describe("candidate reordering", () => {
  test("no pressure leaves the policy order alone", () => {
    assert.deepEqual(
      applyAdaptiveTier(candidates, "none").map((candidate) => candidate.descriptor.id),
      ["flagship", "midrange", "cheap"],
    );
  });

  test("prefer_cheaper takes the best value, not the weakest model", () => {
    const ordered = applyAdaptiveTier(candidates, "prefer_cheaper").map((candidate) => candidate.descriptor.id);
    assert.equal(ordered[0], "midrange", "a mid-tier model at a fifth the price is a good trade; the weakest is not");
    assert.ok(!ordered.includes("cheap") || ordered.indexOf("cheap") > 0);
  });

  test("cheapest_capable takes the cheapest, because the alternative is not finishing", () => {
    assert.equal(applyAdaptiveTier(candidates, "cheapest_capable")[0]?.descriptor.id, "cheap");
  });

  test("a single candidate is returned unchanged whatever the tier", () => {
    const single = [{ descriptor: FLAGSHIP }];
    for (const tier of ["none", "prefer_cheaper", "cheapest_capable"] as const) {
      assert.equal(applyAdaptiveTier(single, tier)[0]?.descriptor.id, "flagship");
    }
  });

  test("a free model sorts first under prefer_cheaper without dividing by zero", () => {
    const free = model("free", { reasoningTier: 0.9, inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 });
    const ordered = applyAdaptiveTier([{ descriptor: FLAGSHIP }, { descriptor: free }], "prefer_cheaper");
    assert.equal(ordered[0]?.descriptor.id, "free");
  });

  test("cost estimation is ordered as expected", () => {
    assert.ok(estimatedCallCostUsd(FLAGSHIP) > estimatedCallCostUsd(MIDRANGE));
    assert.ok(estimatedCallCostUsd(MIDRANGE) > estimatedCallCostUsd(CHEAP));
    assert.equal(estimatedCallCostUsd(model("z", { inputCostPerMTokUsd: 0, outputCostPerMTokUsd: 0 })), 0);
  });
});

describe("the router under pressure", () => {
  const provider = () => new ScriptedModelProvider({
    name: "scripted",
    models: [FLAGSHIP, MIDRANGE, CHEAP],
    script: [{ text: "ok", repeat: true }],
  });

  const router = (logger = silentLogger) => new ModelRouter({
    providers: [provider()],
    rules: [
      { taskKind: "extraction", candidates: [FLAGSHIP, MIDRANGE, CHEAP].map((m) => ({ provider: "scripted", model: m.id })), requiredCapabilities: [], requireDistinctProvider: false },
      { taskKind: "synthesis", candidates: [FLAGSHIP, MIDRANGE, CHEAP].map((m) => ({ provider: "scripted", model: m.id })), requiredCapabilities: [], requireDistinctProvider: false },
    ],
    logger,
  });

  test("an unpressured run gets the policy's first choice", () => {
    const decision = router().route({ taskKind: "extraction", budget: { pressure: 0.2 } });
    assert.equal(decision.chosen.descriptor.id, "flagship");
    assert.equal(decision.adaptive.tier, "none");
  });

  test("a pressured run is routed to a cheaper model, and the decision records why", () => {
    const decision = router().route({ taskKind: "extraction", budget: { pressure: 0.95 } });
    assert.equal(decision.chosen.descriptor.id, "cheap");
    assert.equal(decision.adaptive.tier, "cheapest_capable");
    assert.match(decision.adaptive.reason, /so the run finishes/);
  });

  test("synthesis keeps the flagship even at full pressure", () => {
    const decision = router().route({ taskKind: "synthesis", budget: { pressure: 1 } });
    assert.equal(decision.chosen.descriptor.id, "flagship", "saving money on the conclusion buys a cheaper wrong answer");
    assert.equal(decision.adaptive.protectedKind, true);
  });

  test("omitting the budget leaves routing exactly as it was", () => {
    assert.equal(router().route({ taskKind: "extraction" }).chosen.descriptor.id, "flagship");
  });

  test("a downgrade is logged", () => {
    const logger = createMemoryLogger();
    router(logger.logger).route({ taskKind: "extraction", budget: { pressure: 0.95 } });
    assert.ok(
      logger.lines.some((line) => /Routing adapted to budget pressure/.test(String(line["message"]))),
      "a cost saving nobody is told about is a quality regression nobody can account for",
    );
  });

  test("pressure reorders but never filters: every candidate remains a fallback", () => {
    const decision = router().route({ taskKind: "extraction", budget: { pressure: 0.95 } });
    assert.equal(decision.fallbacks.length, 2, "a cheaper first choice must not lose the others as fallbacks");
  });
});
