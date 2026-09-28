/**
 * Mechanical verification.
 *
 * The check that matters most is citation fidelity: everything downstream
 * assumes that when evidence quotes a source, the source said it. A model that
 * paraphrases inside quotation marks breaks that assumption silently, and these
 * tests exist to make sure it cannot.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { newId } from "@research-os/shared";
import {
  BLOCKING_CHECK_TYPES, checkArithmetic, checkCitationFidelity, checkNumericConsistency,
  extractNumbers, hasBlockingFailure, summariseChecks, verifyClaim, verifyEvidence, verifyExperiment,
} from "../src/index.ts";
import {
  FIXTURE_NOW as NOW, makeClaim, makeClaimEvidenceLink, makeConfidence, makeEvidence, makeProject,
} from "../../../tests/support/fixtures.ts";

const PROJECT = makeProject().id;
const SOURCE_A = newId("source");
const SOURCE_B = newId("source");
const context = { projectId: PROJECT, now: NOW, runId: null };

const SOURCE_TEXT =
  "Agents equipped with persistent memory recalled 18% more prior context than the control group. " +
  "The effect was consistent across three independent trials, though the sample was small.";

const chunk = (text: string, id = newId("chunk")) => ({
  id, projectId: PROJECT, sourceId: SOURCE_A, documentId: newId("document"), position: 0, text,
  startOffset: 0, endOffset: text.length, locator: null, tokenCount: 20,
  embedding: null, embeddingModel: null, createdAt: NOW,
}) as never;

describe("citation fidelity", () => {
  test("a verbatim quote passes", () => {
    const result = checkCitationFidelity("recalled 18% more prior context", SOURCE_TEXT);
    assert.equal(result.verdict, "exact");
    assert.equal(result.similarity, 1);
  });

  test("typography differences do not break a faithful quote", () => {
    const result = checkCitationFidelity(
      "The effect was consistent across three independent trials — though the sample was small.",
      SOURCE_TEXT.replace("trials, though", "trials - though"),
    );
    assert.ok(["exact", "near"].includes(result.verdict), `expected a pass, got ${result.verdict}`);
  });

  test("an elided quote passes when its fragments appear in order", () => {
    const result = checkCitationFidelity(
      "Agents equipped with persistent memory ... consistent across three independent trials",
      SOURCE_TEXT,
    );
    assert.equal(result.verdict, "elided", "eliding is a legitimate way to quote");
  });

  test("fragments in the wrong order do not pass as an elision", () => {
    const result = checkCitationFidelity(
      "consistent across three independent trials ... Agents equipped with persistent memory",
      SOURCE_TEXT,
    );
    assert.notEqual(result.verdict, "elided");
  });

  test("a paraphrase presented as a quotation fails", () => {
    // Close enough to the source that it is recognisably about the same
    // passage, which is exactly the dangerous case: it reads plausible.
    const result = checkCitationFidelity(
      "Agents equipped with persistent memory were able to recall more of the earlier context than the control",
      SOURCE_TEXT,
    );
    assert.equal(result.verdict, "paraphrased");
    assert.match(result.detail, /paraphrase presented as a quotation/);
  });

  test("a heavy reword is reported as absent rather than as a paraphrase", () => {
    const result = checkCitationFidelity(
      "Agents that had persistent memory were able to recall substantially more of the earlier context",
      SOURCE_TEXT,
    );
    assert.equal(result.verdict, "absent", "at 33% shared wording this is not a quotation of anything");
  });

  test("a fabricated quote is reported as absent", () => {
    const result = checkCitationFidelity(
      "Quantum entanglement reduced the training cost by two orders of magnitude.",
      SOURCE_TEXT,
    );
    assert.equal(result.verdict, "absent");
  });

  test("every non-matching verdict fails verification, whatever it is called", () => {
    // The verdict label is diagnostic; the property that matters is that
    // nothing which is not actually in the source is allowed to pass.
    const chunkId = newId("chunk");
    for (const quote of [
      "Agents equipped with persistent memory were able to recall more of the earlier context than the control",
      "Quantum entanglement reduced the training cost by two orders of magnitude.",
    ]) {
      const checks = verifyEvidence(
        makeEvidence(PROJECT, SOURCE_A, { quote, chunkIds: [chunkId] }),
        [chunk(SOURCE_TEXT, chunkId)],
        context,
      );
      assert.equal(checks[0]?.outcome, "failed", `"${quote.slice(0, 40)}..." must not pass`);
    }
  });

  test("an empty quote is absent, not vacuously true", () => {
    assert.equal(checkCitationFidelity("", SOURCE_TEXT).verdict, "absent");
  });

  test("a short quote is not penalised for the document being long", () => {
    const long = `${"Irrelevant filler sentence. ".repeat(500)}${SOURCE_TEXT}`;
    assert.equal(checkCitationFidelity("recalled 18% more prior context", long).verdict, "exact");
  });
});

describe("numbers", () => {
  test("extracts figures with their units", () => {
    const numbers = extractNumbers("Revenue was $1,200 and margin rose 18% from 12 units.");
    assert.deepEqual(numbers.map((number) => [number.value, number.unit]), [[1200, "currency"], [18, "percent"], [12, "none"]]);
  });

  test("a figure not in the evidence fails the check", () => {
    const result = checkNumericConsistency("Memory improved recall by 18%.", ["recall improved by 8% in the treatment arm"]);
    assert.equal(result.outcome, "failed");
    assert.equal(result.unsupported[0]?.value, 18, "a transcription error that changes the finding");
  });

  test("a figure present in the evidence passes, within rounding", () => {
    assert.equal(checkNumericConsistency("improved by 18%", ["improved by 18.3%"]).outcome, "passed");
    assert.equal(checkNumericConsistency("improved by 18%", ["improved by 18%"]).outcome, "passed");
  });

  test("units must agree before values are compared", () => {
    const result = checkNumericConsistency("improved by 18%", ["across 18 trials"]);
    assert.equal(result.outcome, "failed", "a percentage and a count sharing a digit are not the same figure");
  });

  test("a claim with no figures is not applicable rather than passing", () => {
    assert.equal(checkNumericConsistency("Memory improves recall.", ["some text"]).outcome, "not_applicable");
  });

  test("a claim with figures and evidence with none fails", () => {
    assert.equal(checkNumericConsistency("improved by 18%", ["no numbers here"]).outcome, "failed");
  });

  test("arithmetic stated in prose is checked", () => {
    const wrong = checkArithmetic("The totals were 120 + 35 = 165, which we rounded.");
    assert.equal(wrong[0]?.correct, false);
    assert.equal(wrong[0]?.computed, 155);

    const right = checkArithmetic("The totals were 120 + 35 = 155.");
    assert.equal(right[0]?.correct, true);
  });

  test("percentage-of statements are checked", () => {
    assert.equal(checkArithmetic("20% of 400 is 80")[0]?.correct, true);
    assert.equal(checkArithmetic("20% of 400 is 60")[0]?.correct, false);
  });

  test("prose containing no arithmetic yields no statements", () => {
    assert.deepEqual(checkArithmetic("Memory improves recall substantially."), []);
  });

  test("division by zero does not produce a false verdict", () => {
    const statements = checkArithmetic("10 / 0 = 0");
    assert.equal(statements.length, 0, "an undefined result is not a wrong result");
  });
});

describe("verifyEvidence", () => {
  test("a faithful quote passes against its own chunk", () => {
    const chunkId = newId("chunk");
    const evidence = makeEvidence(PROJECT, SOURCE_A, {
      quote: "recalled 18% more prior context",
      chunkIds: [chunkId],
    });
    const checks = verifyEvidence(evidence, [chunk(SOURCE_TEXT, chunkId)], context);

    assert.equal(checks[0]?.checkType, "citation_fidelity");
    assert.equal(checks[0]?.outcome, "passed");
    assert.equal(checks[0]?.verifierProvider, null, "a mechanical check names no model");
  });

  test("a fabricated quote fails", () => {
    const chunkId = newId("chunk");
    const evidence = makeEvidence(PROJECT, SOURCE_A, {
      quote: "The study found a 90% reduction in hallucination.",
      chunkIds: [chunkId],
    });
    const checks = verifyEvidence(evidence, [chunk(SOURCE_TEXT, chunkId)], context);
    assert.equal(checks[0]?.outcome, "failed");
  });

  test("no stored chunk gives inconclusive, not failed", () => {
    const evidence = makeEvidence(PROJECT, SOURCE_A, { quote: "anything", chunkIds: [] });
    const checks = verifyEvidence(evidence, [], context);
    assert.equal(checks[0]?.outcome, "inconclusive");
    assert.match(String(checks[0]?.detail), /unverified, not disproven/);
  });

  test("evidence naming no chunk is flagged even when the quote is found", () => {
    const evidence = makeEvidence(PROJECT, SOURCE_A, { quote: "recalled 18% more prior context", chunkIds: [] });
    const checks = verifyEvidence(evidence, [chunk(SOURCE_TEXT)], context);
    assert.equal(checks[0]?.outcome, "passed");
    assert.equal(checks[1]?.checkType, "citation_resolvable");
    assert.equal(checks[1]?.outcome, "inconclusive");
  });
});

describe("verifyClaim", () => {
  test("a claim citing nothing fails traceability", () => {
    const claim = makeClaim(PROJECT, { statement: "Persistent memory improves recall." });
    const checks = verifyClaim({ claim, evidence: [] }, context);
    const traceability = checks.find((check) => check.checkType === "evidence_traceability");

    assert.equal(traceability?.outcome, "failed");
    assert.match(String(traceability?.detail), /model assertion, not a finding/);
    assert.equal(hasBlockingFailure(checks), true, "this must block the claim from being reported as supported");
  });

  test("a traceable claim with matching figures passes", () => {
    const claim = makeClaim(PROJECT, { statement: "Persistent memory improved recall by 18%." });
    const evidence = [makeEvidence(PROJECT, SOURCE_A, { quote: "recalled 18% more prior context" })];
    const checks = verifyClaim({ claim, evidence }, context);

    assert.equal(checks.find((check) => check.checkType === "evidence_traceability")?.outcome, "passed");
    assert.equal(checks.find((check) => check.checkType === "numeric_consistency")?.outcome, "passed");
    assert.equal(hasBlockingFailure(checks), false);
  });

  test("a universal claim on thin evidence fails scope support", () => {
    const claim = makeClaim(PROJECT, { statement: "Persistent memory always improves recall in every agent." });
    const evidence = [makeEvidence(PROJECT, SOURCE_A)];
    const scope = verifyClaim({ claim, evidence }, context).find((check) => check.checkType === "scope_support");

    assert.equal(scope?.outcome, "failed");
    assert.match(String(scope?.detail), /Narrow the scope/);
  });

  test("a universal claim on broad evidence is inconclusive, not passed", () => {
    const claim = makeClaim(PROJECT, { statement: "Persistent memory always improves recall." });
    const evidence = [SOURCE_A, SOURCE_B, newId("source"), newId("source")].map((sourceId) => makeEvidence(PROJECT, sourceId));
    const scope = verifyClaim({ claim, evidence }, context).find((check) => check.checkType === "scope_support");

    assert.equal(scope?.outcome, "inconclusive", "breadth of evidence never establishes a universal");
  });

  test("a hedged claim passes scope support", () => {
    const claim = makeClaim(PROJECT, { statement: "Persistent memory may improve recall in some agents." });
    const scope = verifyClaim({ claim, evidence: [makeEvidence(PROJECT, SOURCE_A)] }, context)
      .find((check) => check.checkType === "scope_support");
    assert.equal(scope?.outcome, "passed");
  });

  test("two claims citing the same evidence with opposite stances conflict", () => {
    const evidence = makeEvidence(PROJECT, SOURCE_A);
    const claim = makeClaim(PROJECT, { statement: "Memory improves recall.", confidence: makeConfidence(0.8) });
    const accepted = makeClaim(PROJECT, { statement: "Memory does not improve recall.", confidence: makeConfidence(0.8) });

    const consistency = verifyClaim(
      {
        claim,
        evidence: [evidence],
        acceptedClaims: [accepted],
        evidenceLinks: [
          makeClaimEvidenceLink(claim.id, evidence.id, { stance: "supports" }),
          makeClaimEvidenceLink(accepted.id, evidence.id, { stance: "contradicts" }),
        ],
      },
      context,
    ).find((check) => check.checkType === "internal_consistency");

    assert.equal(consistency?.outcome, "failed", "the same evidence cannot both support and refute");
  });

  test("bad arithmetic in a claim statement is caught", () => {
    const claim = makeClaim(PROJECT, { statement: "Across both arms, 120 + 35 = 165 participants were measured." });
    const arithmetic = verifyClaim({ claim, evidence: [makeEvidence(PROJECT, SOURCE_A)] }, context)
      .find((check) => check.checkType === "arithmetic");
    assert.equal(arithmetic?.outcome, "failed");
    assert.match(String(arithmetic?.detail), /computes to 155/);
  });
});

describe("verifyExperiment", () => {
  const experiment = (overrides: Record<string, unknown>) => ({
    id: newId("experiment"), projectId: PROJECT, hypothesisId: null, title: "T", design: "d",
    expectedOutcome: null, falsificationCriteria: null, status: "completed", code: "print(1)",
    environment: { runtime: "python", runtimeVersion: "3.12.0", dependencies: ["numpy==1.26.4"], platform: "linux-x64", envVarNames: [], randomSeed: null },
    parameters: {}, datasetIds: [], designedByRunId: null, createdAt: NOW, updatedAt: NOW, ...overrides,
  }) as never;

  test("a fully recorded environment is reproducible", () => {
    const checks = verifyExperiment(experiment({}), context);
    assert.equal(checks[0]?.outcome, "passed");
  });

  test("a missing interpreter version is not reproducible", () => {
    const checks = verifyExperiment(experiment({
      environment: { runtime: "python", runtimeVersion: null, dependencies: ["numpy==1.26.4"], platform: "linux-x64", envVarNames: [], randomSeed: null },
    }), context);
    assert.equal(checks[0]?.outcome, "failed");
    assert.match(String(checks[0]?.detail), /runtime version/);
  });

  test("stochastic code with no recorded seed is not reproducible", () => {
    const checks = verifyExperiment(experiment({ code: "import random; random.shuffle(data)" }), context);
    assert.equal(checks[0]?.outcome, "failed");
    assert.match(String(checks[0]?.detail), /random seed/);
  });
});

describe("summary", () => {
  test("inconclusive checks are excluded from the pass rate", () => {
    const claim = makeClaim(PROJECT);
    const checks = [
      ...verifyClaim({ claim, evidence: [makeEvidence(PROJECT, SOURCE_A)] }, context),
    ];
    const summary = summariseChecks("claim", claim.id, checks);

    assert.equal(summary.total, checks.length);
    assert.ok(summary.passRate !== null);
    const decisive = summary.passed + summary.failed;
    assert.equal(summary.passRate, decisive === 0 ? null : summary.passed / decisive);
  });

  test("a target with only inconclusive checks has no pass rate", () => {
    const evidence = makeEvidence(PROJECT, SOURCE_A, { chunkIds: [] });
    const summary = summariseChecks("evidence", evidence.id, verifyEvidence(evidence, [], context));
    assert.equal(summary.passRate, null, "we could not tell is not the same as it is wrong");
    assert.equal(summary.inconclusive, 1);
  });

  test("blocking check types are the ones that invalidate a finding", () => {
    assert.deepEqual([...BLOCKING_CHECK_TYPES].sort(), ["citation_fidelity", "evidence_traceability"]);
  });
});
