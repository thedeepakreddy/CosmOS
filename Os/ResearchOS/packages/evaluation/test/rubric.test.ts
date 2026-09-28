/**
 * The research-quality rubric.
 *
 * What is being tested is whether the rubric rewards the right things. A scorer
 * that gives a good grade to research whose findings do not trace to sources is
 * worse than no scorer, because a number that looks like a quality rating will
 * be read as one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { newId } from "@research-os/shared";
import { DIMENSION_WEIGHTS, EVALUATION_CAVEATS, EVALUATION_DIMENSIONS, evaluateProject, type EvaluationInput } from "../src/index.ts";
import {
  FIXTURE_NOW as NOW, makeClaim, makeClaimEvidenceLink, makeConfidence, makeContradiction,
  makeEvidence, makeProject, makeSource,
} from "../../../tests/support/fixtures.ts";

const PROJECT = makeProject().id;

const check = (targetId: string, overrides: Record<string, unknown> = {}) => ({
  id: newId("verification"), projectId: PROJECT, checkType: "citation_fidelity",
  targetType: "evidence", targetId, outcome: "passed", detail: "ok", weight: 1,
  verifierProvider: null, verifiedByRunId: null, createdAt: NOW, ...overrides,
}) as never as EvaluationInput["verificationChecks"][number];

const report = (overrides: Record<string, unknown> = {}) => ({
  id: newId("report"), projectId: PROJECT, version: 1, title: "T",
  executiveSummary: "s", originalQuestion: "q", methodology: "m",
  keyFindings: [], contradictions: [], overallConfidence: 0.7,
  confidenceRationale: "because the evidence says so", limitations: ["Only one source."],
  unansweredQuestions: ["Does it generalise?"], recommendedNextResearch: [],
  experimentSummaries: [], sections: [], citations: [], citationStyle: "apa",
  statistics: {
    sourcesConsidered: 1, sourcesCited: 1, evidenceItems: 1, claimsTotal: 1, claimsSupported: 1,
    claimsRefuted: 0, claimsContested: 0, openContradictions: 0, agentRuns: 4, tokensUsed: 100, costUsd: 0.1,
  },
  generatedByRunId: null, createdAt: NOW, ...overrides,
}) as never as NonNullable<EvaluationInput["report"]>;

const empty = (overrides: Partial<EvaluationInput> = {}): EvaluationInput => ({
  claims: [], evidence: [], evidenceLinks: [], sources: [], contradictions: [], findings: [],
  verificationChecks: [], report: null, completedTaskTypes: [], blockedWork: [],
  experimentReproducibility: [], ...overrides,
});

/** A small, well-conducted project: one claim, traced, checked and reported. */
function soundProject(): EvaluationInput {
  const sources = [
    makeSource(PROJECT, { domain: "arxiv.org", contentHash: "a" }),
    makeSource(PROJECT, { domain: "nature.com", contentHash: "b" }),
  ];
  const evidence = sources.map((source) => makeEvidence(PROJECT, source.id));
  const claim = makeClaim(PROJECT, { status: "supported", confidence: makeConfidence(0.7) });
  const links = evidence.map((item) => makeClaimEvidenceLink(claim.id, item.id));

  return empty({
    claims: [claim],
    evidence,
    evidenceLinks: links,
    sources,
    verificationChecks: [
      ...evidence.map((item) => check(item.id)),
      check(claim.id, { targetType: "claim", checkType: "evidence_traceability" }),
    ],
    completedTaskTypes: ["critique.run"],
    findings: [],
    report: report({
      keyFindings: [{
        statement: "S", claimIds: [claim.id], confidence: 0.7, supportingSources: 2, contradictingSources: 0,
        replicatedExperiments: 0, failedReplications: 0, majorUncertainties: [], citationMarkers: ["1"],
      }],
    }),
  });
}

describe("rubric structure", () => {
  test("weights cover every dimension and sum to one", () => {
    assert.deepEqual(Object.keys(DIMENSION_WEIGHTS).sort(), [...EVALUATION_DIMENSIONS].sort());
    const total = Object.values(DIMENSION_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  });

  test("caveats are returned, so a score cannot be mistaken for a verdict", () => {
    const result = evaluateProject(soundProject());
    assert.ok(EVALUATION_CAVEATS.length >= 3);
    assert.match(EVALUATION_CAVEATS[0] ?? "", /not whether its conclusions are true/);
    assert.equal(result.dimensions.length, EVALUATION_DIMENSIONS.length);
  });
});

describe("traceability", () => {
  test("a well-traced project scores full marks and is not blocked", () => {
    const result = evaluateProject(soundProject());
    const traceability = result.dimensions.find((dimension) => dimension.dimension === "traceability");

    assert.equal(traceability?.score, 1);
    assert.deepEqual(result.blockers, []);
    assert.ok(["strong", "adequate"].includes(result.grade));
  });

  test("a finding with no evidence behind it makes the whole result unsound", () => {
    const orphan = makeClaim(PROJECT, { statement: "Asserted with nothing behind it." });
    const result = evaluateProject(empty({
      claims: [orphan],
      report: report({
        keyFindings: [{
          statement: "Asserted", claimIds: [orphan.id], confidence: 0.9, supportingSources: 0,
          contradictingSources: 0, replicatedExperiments: 0, failedReplications: 0,
          majorUncertainties: [], citationMarkers: [],
        }],
      }),
      verificationChecks: [check(orphan.id, { targetType: "claim" })],
    }));

    assert.equal(result.grade, "unsound");
    assert.ok(result.blockers.some((blocker) => /traces to a source/.test(blocker)));
    assert.match(result.summary, /^Unsound/);
    assert.match(result.summary, /should not be read as a quality rating/);
  });

  test("a project with no report has nothing to trace, and is not penalised for it", () => {
    const traceability = evaluateProject(empty()).dimensions.find((dimension) => dimension.dimension === "traceability");
    assert.equal(traceability?.applicable, false);
  });
});

describe("verification", () => {
  test("a failed citation-fidelity check makes the result unsound", () => {
    const base = soundProject();
    const evidenceId = base.evidence[0]!.id;
    const result = evaluateProject({
      ...base,
      verificationChecks: [
        ...base.verificationChecks.filter((item) => item.targetId !== evidenceId),
        check(evidenceId, { outcome: "failed", detail: "The quoted text does not appear in the cited source." }),
      ],
    });

    assert.equal(result.grade, "unsound");
    assert.ok(result.blockers.some((blocker) => /could not be found in the source/.test(blocker)));
  });

  test("verifying nothing is a blocker, not a low score", () => {
    const result = evaluateProject({ ...soundProject(), verificationChecks: [] });
    assert.ok(result.blockers.some((blocker) => /Nothing was verified/.test(blocker)));
  });

  test("inconclusive checks neither help nor hurt the pass rate", () => {
    const base = soundProject();
    const withInconclusive = evaluateProject({
      ...base,
      verificationChecks: [...base.verificationChecks, check(newId("evidence"), { outcome: "inconclusive" })],
    });
    const verification = withInconclusive.dimensions.find((dimension) => dimension.dimension === "verification");
    assert.match(String(verification?.detail), /inconclusive/, "they are reported");
    assert.ok((verification?.score ?? 0) > 0, "but 'we could not tell' is not 'it is wrong'");
  });
});

describe("evidence breadth", () => {
  test("independence is counted by domain, not by source row", () => {
    const sameDomain = ["1", "2", "3"].map((hash) => makeSource(PROJECT, { domain: "arxiv.org", contentHash: hash }));
    const evidence = sameDomain.map((source) => makeEvidence(PROJECT, source.id));
    const claim = makeClaim(PROJECT);

    const breadth = evaluateProject(empty({
      claims: [claim],
      sources: sameDomain,
      evidence,
      evidenceLinks: evidence.map((item) => makeClaimEvidenceLink(claim.id, item.id)),
    })).dimensions.find((dimension) => dimension.dimension === "evidenceBreadth");

    assert.match(String(breadth?.detail), /1 independent domain/, "three papers from one group is close to one source, not three");
    assert.ok((breadth?.score ?? 1) < 0.3);
  });

  test("breadth saturates, so volume cannot compensate for weak traceability", () => {
    const many = Array.from({ length: 12 }, (_value, index) =>
      makeSource(PROJECT, { domain: `source-${index}.org`, contentHash: `h${index}` }));
    const evidence = many.map((source) => makeEvidence(PROJECT, source.id));
    const claim = makeClaim(PROJECT);

    const breadth = evaluateProject(empty({
      claims: [claim], sources: many, evidence,
      evidenceLinks: evidence.map((item) => makeClaimEvidenceLink(claim.id, item.id)),
    })).dimensions.find((dimension) => dimension.dimension === "evidenceBreadth");

    assert.equal(breadth?.score, 1, "twelve domains is not twice as good as six");
  });
});

describe("critical scrutiny", () => {
  test("research nobody attacked scores zero", () => {
    const scrutiny = evaluateProject(empty({ claims: [makeClaim(PROJECT)] }))
      .dimensions.find((dimension) => dimension.dimension === "criticalScrutiny");
    assert.equal(scrutiny?.applicable, true, "a project with claims could have been critiqued");
    assert.equal(scrutiny?.score, 0);
    assert.match(String(scrutiny?.detail), /Nothing looked for the research being wrong/);
  });

  test("a project that reached no claims is not scored on scrutiny it could not have done", () => {
    const scrutiny = evaluateProject(empty()).dimensions.find((dimension) => dimension.dimension === "criticalScrutiny");
    assert.equal(scrutiny?.applicable, false);
  });

  test("an adversarial debate scores above critique alone", () => {
    const a = evaluateProject({ ...soundProject(), completedTaskTypes: ["critique.run"] })
      .dimensions.find((dimension) => dimension.dimension === "criticalScrutiny")?.score ?? 0;
    const b = evaluateProject({ ...soundProject(), completedTaskTypes: ["critique.run", "debate.run"] })
      .dimensions.find((dimension) => dimension.dimension === "criticalScrutiny")?.score ?? 0;
    assert.ok(b > a);
  });

  test("severe objections left open cost, but raising them still beats raising none", () => {
    const severe = {
      id: newId("finding"), projectId: PROJECT, kind: "overgeneralization", status: "open",
      targetType: "claim", targetId: newId("claim"), description: "Too broad.",
      resolutionCriteria: "A replication.", severity: 0.9, raisedByRunId: null,
      resolvedByRunId: null, resolution: null, createdAt: NOW, updatedAt: NOW,
    } as never as EvaluationInput["findings"][number];

    const withSevere = evaluateProject({ ...soundProject(), completedTaskTypes: ["critique.run"], findings: [severe, severe] })
      .dimensions.find((dimension) => dimension.dimension === "criticalScrutiny")?.score ?? 0;
    const none = evaluateProject({ ...soundProject(), completedTaskTypes: [] })
      .dimensions.find((dimension) => dimension.dimension === "criticalScrutiny")?.score ?? 0;

    assert.ok(withSevere > none);
    assert.ok(withSevere < 1, "unaddressed severe objections still cost");
  });
});

describe("contradiction handling", () => {
  const claimA = makeClaim(PROJECT);
  const claimB = makeClaim(PROJECT);

  test("a contradiction dropped from the report scores nothing for it", () => {
    const contradiction = makeContradiction(PROJECT, claimA.id, claimB.id, { candidateExplanations: [] });
    const handling = evaluateProject({
      ...soundProject(),
      contradictions: [contradiction],
      report: report({ contradictions: [], keyFindings: [] }),
    }).dimensions.find((dimension) => dimension.dimension === "contradictionHandling");

    assert.equal(handling?.score, 0, "averaging a disagreement away is the failure this guards against");
  });

  test("carrying a contradiction into the report unresolved scores well", () => {
    const contradiction = makeContradiction(PROJECT, claimA.id, claimB.id, {
      candidateExplanations: ["Different populations"],
    });
    const handling = evaluateProject({
      ...soundProject(),
      contradictions: [contradiction],
      report: report({
        contradictions: [{
          contradictionId: contradiction.id, description: contradiction.description, status: "open",
          severity: 0.7, candidateExplanations: ["Different populations"], resolution: null,
        }],
        keyFindings: soundProject().report!.keyFindings,
      }),
    }).dimensions.find((dimension) => dimension.dimension === "contradictionHandling");

    assert.ok((handling?.score ?? 0) >= 0.8, "reporting a disagreement honestly is the right behaviour");
  });

  test("no contradictions is not applicable, not a zero", () => {
    const handling = evaluateProject(soundProject()).dimensions.find((dimension) => dimension.dimension === "contradictionHandling");
    assert.equal(handling?.applicable, false);
  });
});

describe("calibration", () => {
  test("high confidence on a single domain is flagged as overstated", () => {
    const source = makeSource(PROJECT, { domain: "blog.example", contentHash: "x" });
    const evidence = makeEvidence(PROJECT, source.id);
    const overconfident = makeClaim(PROJECT, {
      confidence: makeConfidence(0.9, { distinctDomains: 1, distinctSources: 1 }),
    });

    const calibration = evaluateProject(empty({
      claims: [overconfident], sources: [source], evidence: [evidence],
      evidenceLinks: [makeClaimEvidenceLink(overconfident.id, evidence.id)],
    })).dimensions.find((dimension) => dimension.dimension === "calibration");

    assert.equal(calibration?.score, 0);
    assert.match(String(calibration?.detail), /1 independent domain/);
  });

  test("low confidence despite broad corroboration is flagged as understated", () => {
    const understated = makeClaim(PROJECT, {
      confidence: makeConfidence(0.3, {
        distinctDomains: 5, distinctSources: 5,
        effectiveSupportingCount: 4, effectiveContradictingCount: 0,
      }),
    });
    const calibration = evaluateProject(empty({ claims: [understated] }))
      .dimensions.find((dimension) => dimension.dimension === "calibration");

    assert.ok((calibration?.score ?? 1) < 1, "burying a real finding is also miscalibration");
    assert.match(String(calibration?.detail), /despite 5 corroborating domains/);
  });

  test("confidence matching its evidence base scores full marks", () => {
    const calibration = evaluateProject(soundProject()).dimensions.find((dimension) => dimension.dimension === "calibration");
    assert.equal(calibration?.score, 1);
  });
});

describe("transparency", () => {
  test("blocked work not declared as a limitation costs", () => {
    const transparency = evaluateProject({
      ...soundProject(),
      blockedWork: ["source.discover: no search tool"],
      report: report({ limitations: ["Only one source."], keyFindings: soundProject().report!.keyFindings }),
    }).dimensions.find((dimension) => dimension.dimension === "transparency");

    assert.ok((transparency?.score ?? 1) < 1);
    assert.match(String(transparency?.detail), /not declared as limitations/);
  });

  test("declaring blocked work restores the score", () => {
    const transparency = evaluateProject({
      ...soundProject(),
      blockedWork: ["source.discover: no search tool"],
      report: report({
        limitations: ["Could not be carried out: source discovery."],
        keyFindings: soundProject().report!.keyFindings,
      }),
    }).dimensions.find((dimension) => dimension.dimension === "transparency");

    assert.equal(transparency?.score, 1);
  });
});

describe("overall scoring", () => {
  test("inapplicable dimensions are excluded rather than scored zero", () => {
    // A literature review runs no experiments. Scoring that absence would make
    // every literature review look unsound.
    const withoutExperiments = evaluateProject(soundProject());
    const withExperiments = evaluateProject({ ...soundProject(), experimentReproducibility: [1] });

    assert.equal(
      withoutExperiments.dimensions.find((dimension) => dimension.dimension === "reproducibility")?.applicable,
      false,
    );
    assert.ok(withoutExperiments.overall > 0.5, "a project with no experiments is not worse research for it");
    assert.ok(withExperiments.overall >= withoutExperiments.overall);
  });

  test("weaknesses are listed worst first and name what to fix", () => {
    const weak = evaluateProject({ ...soundProject(), completedTaskTypes: [] });
    assert.ok(weak.weaknesses.length > 0);
    assert.match(weak.weaknesses[0] ?? "", /criticalScrutiny/);
    for (let index = 1; index < weak.weaknesses.length; index++) {
      const previous = Number(/\(([0-9.]+)\)/.exec(weak.weaknesses[index - 1] ?? "")?.[1] ?? 0);
      const current = Number(/\(([0-9.]+)\)/.exec(weak.weaknesses[index] ?? "")?.[1] ?? 0);
      assert.ok(previous <= current, "worst first");
    }
  });

  test("an empty project is unevaluable, not weak", () => {
    const result = evaluateProject(empty());
    assert.equal(result.overall, 0);
    assert.ok(result.dimensions.every((dimension) => !dimension.applicable));
    assert.equal(result.grade, "unevaluable", "nothing was assessed, which is not the same as assessing it badly");
    assert.match(result.summary, /nothing to assess/);
    assert.ok(!/No dimension scored below/.test(result.summary), "and the summary must not contradict itself");
  });
});
