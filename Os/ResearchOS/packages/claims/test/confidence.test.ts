import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeConfidence, betaCredibleInterval } from "../src/index.ts";
import { deriveClaimStatus } from "../src/index.ts";
import { NOW, independentSupport, pair, makeQuality } from "./fixtures.ts";

describe("computeConfidence — core properties", () => {
  test("no evidence leaves belief at the prior", () => {
    const result = computeConfidence({ evidence: [], now: NOW });
    assert.equal(result.score, 0.5, "with nothing observed, confidence must not move");
    assert.equal(result.supportingCount, 0);
    assert.equal(result.effectiveSupportingCount, 0);
    assert.equal(deriveClaimStatus(result), "insufficient_evidence");
  });

  test("confidence never reaches certainty, however much evidence agrees", () => {
    const result = computeConfidence({ evidence: independentSupport(200), now: NOW });
    assert.ok(result.score < 1, `expected < 1, got ${result.score}`);
    assert.ok(result.score > 0.9, `200 strong independent sources should be high, got ${result.score}`);
    assert.ok(result.posteriorBeta > 0, "the posterior must stay proper");
  });

  test("confidence never reaches zero, however much evidence disagrees", () => {
    const result = computeConfidence({ evidence: independentSupport(200, { stance: "contradicts" }), now: NOW });
    assert.ok(result.score > 0, `expected > 0, got ${result.score}`);
    assert.ok(result.score < 0.1, `200 contradicting sources should be low, got ${result.score}`);
  });

  test("a single excellent source is not grounds for high confidence", () => {
    const one = computeConfidence({ evidence: independentSupport(1, { quality: 1 }), now: NOW });
    const five = computeConfidence({ evidence: independentSupport(5, { quality: 1 }), now: NOW });
    assert.ok(one.score < 0.7, `one source should stay below the "supported" threshold, got ${one.score}`);
    assert.ok(five.score > one.score, "more independent evidence must increase confidence");
    assert.equal(
      deriveClaimStatus(one),
      "insufficient_evidence",
      "a lone source cannot settle a question, regardless of its quality",
    );
  });

  test("confidence is monotonic in the amount of independent supporting evidence", () => {
    const scores = [1, 2, 3, 5, 8, 13].map(
      (n) => computeConfidence({ evidence: independentSupport(n), now: NOW }).score,
    );
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i]! > scores[i - 1]!, `score must increase: ${scores.join(" → ")}`);
    }
  });

  test("identical input produces an identical breakdown", () => {
    const evidence = independentSupport(6);
    const a = computeConfidence({ evidence, now: NOW });
    const b = computeConfidence({ evidence, now: NOW });
    assert.deepEqual(a, b, "scoring must be deterministic to be testable and auditable");
  });
});

describe("computeConfidence — independence discounting", () => {
  test("many quotes from one source count as one source", () => {
    const shared = pair();
    const duplicates = Array.from({ length: 10 }, () => ({
      evidence: { ...shared.evidence, id: `evd_${Math.random().toString(36).slice(2, 28).toUpperCase().padStart(26, "0")}` as typeof shared.evidence.id },
      source: shared.source,
    }));
    const many = computeConfidence({ evidence: duplicates, now: NOW });
    const one = computeConfidence({ evidence: [shared], now: NOW });

    assert.equal(many.distinctSources, 1);
    assert.equal(
      many.effectiveSupportingCount,
      one.effectiveSupportingCount,
      "ten quotes from one document must not outweigh one quote from that document",
    );
    assert.equal(many.score, one.score);
  });

  test("same-publisher evidence is discounted relative to independent evidence", () => {
    const samePublisher = Array.from({ length: 5 }, (_, i) =>
      pair({}, { domain: "singlepublisher.com", url: `https://singlepublisher.com/${i}`, authors: [`Writer ${i}`] }),
    );
    const independent = independentSupport(5);

    const correlated = computeConfidence({ evidence: samePublisher, now: NOW });
    const uncorrelated = computeConfidence({ evidence: independent, now: NOW });

    assert.ok(
      correlated.effectiveSupportingCount < uncorrelated.effectiveSupportingCount,
      `five same-publisher items (${correlated.effectiveSupportingCount}) must count for less than five independent ones (${uncorrelated.effectiveSupportingCount})`,
    );
    assert.ok(correlated.score < uncorrelated.score);
    assert.equal(correlated.distinctDomains, 1);
    assert.equal(uncorrelated.distinctDomains, 5);
  });

  test("shared authorship is discounted even across different domains", () => {
    const sharedAuthor = Array.from({ length: 4 }, (_, i) =>
      pair({}, { domain: `journal-${i}.org`, authors: ["R. Shared", `Co-author ${i}`] }),
    );
    const distinct = independentSupport(4);
    const correlated = computeConfidence({ evidence: sharedAuthor, now: NOW });
    const uncorrelated = computeConfidence({ evidence: distinct, now: NOW });
    assert.ok(correlated.effectiveSupportingCount < uncorrelated.effectiveSupportingCount);
  });
});

describe("computeConfidence — opposition and conflict", () => {
  test("contradicting evidence lowers the score", () => {
    const supportOnly = computeConfidence({ evidence: independentSupport(6), now: NOW });
    const mixed = computeConfidence({
      evidence: [...independentSupport(6), ...independentSupport(3, { stance: "contradicts", ns: "against" })],
      now: NOW,
    });
    assert.ok(mixed.score < supportOnly.score);
    assert.equal(mixed.contradictingCount, 3);
  });

  test("evenly split evidence yields a contested claim near the prior", () => {
    const result = computeConfidence({
      evidence: [...independentSupport(5), ...independentSupport(5, { stance: "contradicts", ns: "against" })],
      now: NOW,
    });
    assert.ok(Math.abs(result.score - 0.5) < 0.05, `balanced evidence should sit near 0.5, got ${result.score}`);
    assert.equal(deriveClaimStatus(result), "contested", "a genuine split must be preserved, not averaged into a verdict");
  });

  test("conflict widens the uncertainty interval without moving the score", () => {
    const agreed = computeConfidence({ evidence: independentSupport(8), now: NOW });
    const conflicted = computeConfidence({
      evidence: [...independentSupport(8), ...independentSupport(4, { stance: "contradicts", ns: "against" })],
      now: NOW,
    });
    const agreedWidth = agreed.uncertaintyInterval[1] - agreed.uncertaintyInterval[0];
    const conflictedWidth = conflicted.uncertaintyInterval[1] - conflicted.uncertaintyInterval[0];
    assert.ok(conflictedWidth > agreedWidth, `conflict must widen uncertainty: ${agreedWidth} → ${conflictedWidth}`);
  });

  test("agent disagreement widens uncertainty but leaves the score alone", () => {
    const evidence = independentSupport(6);
    const agree = computeConfidence({ evidence, agentAgreement: 1, now: NOW });
    const disagree = computeConfidence({ evidence, agentAgreement: 0.2, now: NOW });
    assert.equal(agree.score, disagree.score, "disagreement is uncertainty, not evidence for either side");
    const agreeWidth = agree.uncertaintyInterval[1] - agree.uncertaintyInterval[0];
    const disagreeWidth = disagree.uncertaintyInterval[1] - disagree.uncertaintyInterval[0];
    assert.ok(disagreeWidth > agreeWidth);
  });

  test("neutral and mixed evidence move the score in neither direction", () => {
    const base = computeConfidence({ evidence: independentSupport(4), now: NOW });
    const withNeutral = computeConfidence({
      evidence: [...independentSupport(4), ...independentSupport(3, { stance: "neutral", ns: "neutral" }), ...independentSupport(2, { stance: "mixed", ns: "mixed" })],
      now: NOW,
    });
    assert.equal(withNeutral.score, base.score);
  });
});

describe("computeConfidence — quality, veto, verification, replication", () => {
  test("low-quality sources contribute less than high-quality ones", () => {
    const strong = computeConfidence({ evidence: independentSupport(5, { quality: 0.9 }), now: NOW });
    const weak = computeConfidence({ evidence: independentSupport(5, { quality: 0.2 }), now: NOW });
    assert.ok(weak.score < strong.score, `${weak.score} should be below ${strong.score}`);
  });

  test("an unfaithful quote vetoes its evidence entirely", () => {
    const fabricated = pair({ strength: { directness: 1, specificity: 1, methodologicalRigor: 1, quoteFidelity: 0 } });
    const result = computeConfidence({ evidence: [fabricated], now: NOW });
    const contribution = result.contributions[0]!;
    assert.equal(contribution.weight, 0, "a quote that is not in the source must count for nothing");
    assert.equal(result.score, 0.5, "and must not move the score");
  });

  test("failed verification checks subtract from confidence", () => {
    const evidence = independentSupport(6);
    const clean = computeConfidence({ evidence, now: NOW });
    const flagged = computeConfidence({
      evidence,
      verification: { targetType: "claim", targetId: "clm_x", total: 6, passed: 3, failed: 3, inconclusive: 0, passRate: 0.5, failedCheckTypes: ["citation_fidelity"] },
      now: NOW,
    });
    assert.ok(flagged.score < clean.score);
    assert.equal(flagged.verificationPassRate, 0.5);
  });

  test("a failed replication costs more than a successful one gains", () => {
    const evidence = independentSupport(4);
    const base = computeConfidence({ evidence, now: NOW });
    const replicated = computeConfidence({ evidence, replications: 1, now: NOW });
    const failed = computeConfidence({ evidence, failedReplications: 1, now: NOW });
    const gain = replicated.score - base.score;
    const loss = base.score - failed.score;
    assert.ok(gain > 0, "a successful replication should help");
    assert.ok(loss > gain, `a failed replication (−${loss.toFixed(3)}) must outweigh a success (+${gain.toFixed(3)})`);
  });
});

describe("computeConfidence — auditability", () => {
  test("every contribution records the factors that produced it", () => {
    const result = computeConfidence({ evidence: independentSupport(3), now: NOW });
    assert.equal(result.contributions.length, 3);
    for (const contribution of result.contributions) {
      for (const factor of ["sourceQuality", "relevance", "directness", "specificity", "methodologicalRigor", "quoteFidelity", "independenceWeight"] as const) {
        assert.equal(typeof contribution.factors[factor], "number", `missing factor ${factor}`);
      }
      assert.equal(typeof contribution.pseudoCount, "number");
      assert.equal(
        Math.abs(contribution.pseudoCount),
        contribution.weight,
        "the pseudo-count magnitude must equal the recorded weight",
      );
    }
  });

  test("the score is reproducible by hand from the recorded breakdown", () => {
    const result = computeConfidence({ evidence: independentSupport(4), now: NOW });
    // The published formula, recomputed from the stored intermediate values.
    const expected = result.posteriorAlpha / (result.posteriorAlpha + result.posteriorBeta);
    assert.ok(
      Math.abs(expected - result.score) < 1e-3,
      `breakdown must reproduce the score: recomputed ${expected.toFixed(5)} vs reported ${result.score}`,
    );
    assert.ok(Math.abs(result.posteriorAlpha - (result.priorAlpha + result.supportWeight)) < 1e-5);
    assert.ok(Math.abs(result.posteriorBeta - (result.priorBeta + result.contradictionWeight)) < 1e-5);
  });

  test("the reported interval is the posterior's own credible interval", () => {
    const result = computeConfidence({ evidence: independentSupport(5), now: NOW });
    const [low, high] = betaCredibleInterval(result.posteriorAlpha, result.posteriorBeta, 0.95);
    assert.ok(Math.abs(low - result.uncertaintyInterval[0]) < 1e-3, "lower bound must come from the posterior");
    assert.ok(Math.abs(high - result.uncertaintyInterval[1]) < 1e-3, "upper bound must come from the posterior");
    assert.ok(result.uncertaintyInterval[0] < result.score && result.score < result.uncertaintyInterval[1]);
  });

  test("a non-default prior is honoured and recorded", () => {
    const skeptical = computeConfidence({ evidence: independentSupport(3), prior: 0.2, now: NOW });
    const neutral = computeConfidence({ evidence: independentSupport(3), prior: 0.5, now: NOW });
    assert.ok(skeptical.score < neutral.score, "a skeptical prior must require more evidence");
    assert.ok(Math.abs(skeptical.priorAlpha - 0.4) < 1e-5, "prior 0.2 at strength 2 means alpha 0.4");
    assert.ok(Math.abs(skeptical.priorBeta - 1.6) < 1e-5, "and beta 1.6");
  });

  test("a stronger prior resists the same evidence", () => {
    const weak = computeConfidence({ evidence: independentSupport(3), prior: 0.5, priorStrength: 2, now: NOW });
    const strong = computeConfidence({ evidence: independentSupport(3), prior: 0.5, priorStrength: 20, now: NOW });
    assert.ok(strong.score < weak.score, "a heavier prior must move less for the same evidence");
  });

  test("stated uncertainties are carried through verbatim, never invented", () => {
    const result = computeConfidence({
      evidence: independentSupport(3),
      majorUncertainties: ["dataset selection bias"],
      now: NOW,
    });
    assert.deepEqual(result.majorUncertainties, ["dataset selection bias"]);
    const none = computeConfidence({ evidence: independentSupport(3), now: NOW });
    assert.deepEqual(none.majorUncertainties, [], "no uncertainties may be fabricated");
  });

  test("quality is not silently substituted when a source has none", () => {
    const unassessed = pair({}, { quality: null });
    const assessed = pair({}, { quality: makeQuality(0.8) });
    const a = computeConfidence({ evidence: [unassessed], now: NOW });
    const b = computeConfidence({ evidence: [assessed], now: NOW });
    assert.ok(
      a.contributions[0]!.factors.sourceQuality < b.contributions[0]!.factors.sourceQuality,
      "an unassessed source must be treated conservatively, not optimistically",
    );
  });
});

describe("computeConfidence — regressions", () => {
  // Both of these encode bugs found while building the scoring model. They fail
  // loudly if the saturation or shrinkage strategy is ever reverted.

  test("penalties still register when supporting evidence is overwhelming", () => {
    // Regression: a hard clamp on the log-odds total meant that once support
    // exceeded the ceiling, failed verification changed nothing at all.
    const evidence = independentSupport(30);
    const clean = computeConfidence({ evidence, now: NOW });
    const flagged = computeConfidence({
      evidence,
      verification: { targetType: "claim", targetId: "c", total: 10, passed: 4, failed: 6, inconclusive: 0, passRate: 0.4, failedCheckTypes: ["citation_fidelity"] },
      now: NOW,
    });
    assert.ok(
      flagged.score < clean.score,
      `failed checks must lower the score even with 30 supporting sources (${clean.score} → ${flagged.score})`,
    );
  });

  test("adding contradicting evidence can never raise the score", () => {
    // Regression: shrinkage applied in probability space let extra
    // contradicting evidence increase the effective sample size enough to push
    // the final score *up*.
    const support = independentSupport(6);
    let previous = computeConfidence({ evidence: support, now: NOW }).score;
    for (let n = 1; n <= 6; n++) {
      const score = computeConfidence({
        evidence: [...support, ...independentSupport(n, { stance: "contradicts", ns: "against" })],
        now: NOW,
      }).score;
      assert.ok(score <= previous, `adding contradicting item ${n} raised the score: ${previous} → ${score}`);
      previous = score;
    }
  });

  test("the worked example from the specification produces a defensible number", () => {
    // 17 supporting / 5 contradicting sources, 3 replications, 1 failed.
    const result = computeConfidence({
      evidence: [
        ...independentSupport(17, { ns: "for" }),
        ...independentSupport(5, { stance: "contradicts", ns: "against" }),
      ],
      replications: 3,
      failedReplications: 1,
      agentAgreement: 0.75,
      majorUncertainties: ["dataset selection bias"],
      now: NOW,
    });
    assert.equal(result.supportingCount, 17);
    assert.equal(result.contradictingCount, 5);
    assert.equal(result.replications, 3);
    assert.equal(result.failedReplications, 1);
    assert.ok(result.score > 0.6 && result.score < 0.85, `expected a moderately high score, got ${result.score}`);
    assert.deepEqual(result.majorUncertainties, ["dataset selection bias"]);
    assert.equal(
      deriveClaimStatus(result),
      "contested",
      "5 dissenting sources out of 22 is a genuine split and must be reported as one, not smoothed into a verdict",
    );
  });
});
