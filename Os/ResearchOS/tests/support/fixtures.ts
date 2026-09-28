/**
 * Domain fixtures, built by parsing the contract schemas.
 *
 * Every factory returns a real, validated contract type rather than a cast. That
 * buys two things a cast cannot: the branded IDs come out correctly typed, so
 * `project.id` is a `ProjectId` and not `never`; and a fixture that drifts away
 * from its schema fails loudly at construction instead of quietly exercising a
 * shape the system would never actually see.
 *
 * Fields the schema defaults are omitted here on purpose — the defaults are part
 * of the contract, and fixtures should get them the same way production does.
 */
import {
  Claim, ClaimEvidenceLink, ClaimRelation, ConfidenceBreakdown, Contradiction, Evidence, FailureRecord,
  Hypothesis, Objective, ResearchProject, ResearchQuestion, Source, Task,
} from "@research-os/contracts";
import { newId } from "@research-os/shared";

/** Fixed clock for fixtures. Deterministic timestamps make ordering assertions stable. */
export const FIXTURE_NOW = "2026-02-01T10:00:00.000Z";

export const at = (msFromNow: number): string =>
  new Date(Date.parse(FIXTURE_NOW) + msFromNow).toISOString();

type Overrides = Record<string, unknown>;

export function makeProject(overrides: Overrides = {}): ResearchProject {
  return ResearchProject.parse({
    id: newId("project"),
    tenantId: "acme",
    createdBy: { application: "test-harness", userId: "u1" },
    title: "Does persistent memory improve agent performance?",
    description: null,
    originalQuestion: "Investigate whether persistent memory improves autonomous AI agent performance.",
    status: "draft",
    preferences: { citationStyle: "apa", depth: "standard" },
    budget: { maxTokens: 1000, maxCostUsd: 1 },
    failureReason: null,
    metadata: {},
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    completedAt: null,
    ...overrides,
  });
}

export function makeTask(projectId: string, overrides: Overrides = {}): Task {
  return Task.parse({
    id: newId("task"),
    projectId,
    type: "source.discover",
    status: "pending",
    priority: 50,
    dependsOn: [],
    input: { query: "persistent memory agents" },
    output: null,
    attempts: 0,
    maxAttempts: 3,
    leasedBy: null,
    leaseExpiresAt: null,
    runAfter: FIXTURE_NOW,
    awaitingRequestId: null,
    errorCode: null,
    errorMessage: null,
    traceId: null,
    metadata: {},
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  });
}

export function makeSource(projectId: string, overrides: Overrides = {}): Source {
  return Source.parse({
    id: newId("source"),
    projectId,
    url: "https://example.org/paper",
    doi: null,
    title: "A paper",
    authors: ["X"],
    publisher: null,
    publishedAt: null,
    sourceType: "preprint",
    status: "discovered",
    domain: "example.org",
    contentHash: "abc123",
    storageKey: null,
    retrievedAt: null,
    quality: null,
    discoveredBy: "test",
    failureReason: null,
    metadata: {},
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeFailure(projectId: string, overrides: Overrides = {}): FailureRecord {
  return FailureRecord.parse({
    id: newId("failure"),
    projectId,
    kind: "dead_end_approach",
    approach: "Keyword search alone",
    reason: "Missed the relevant literature entirely",
    lesson: "Use citation chaining",
    context: {},
    transferable: true,
    recordedByRunId: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeObjective(projectId: string, overrides: Overrides = {}): Objective {
  return Objective.parse({
    id: newId("objective"),
    projectId,
    statement: "First",
    position: 0,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

/* ---------- Research artifacts ---------- */

/**
 * A valid `ConfidenceBreakdown` at a given score.
 *
 * Confidence is a large structure because every input to the calculation is
 * stored alongside the result — that is the point of `weighted-beta-v1`. A
 * fixture still has to produce a *coherent* one, so the posterior here is
 * derived from the requested score rather than stapled onto arbitrary counts.
 */
export function makeConfidence(score: number, overrides: Overrides = {}): ConfidenceBreakdown {
  const total = 10;
  const posteriorAlpha = Math.max(0.01, score * total);
  const posteriorBeta = Math.max(0.01, total - posteriorAlpha);
  return ConfidenceBreakdown.parse({
    method: "weighted-beta-v1",
    priorAlpha: 1,
    priorBeta: 1,
    supportWeight: Math.max(0, posteriorAlpha - 1),
    contradictionWeight: Math.max(0, posteriorBeta - 1),
    posteriorAlpha,
    posteriorBeta,
    score,
    contributions: [],
    supportingCount: 1,
    contradictingCount: 0,
    effectiveSupportingCount: 1,
    effectiveContradictingCount: 0,
    distinctSources: 1,
    distinctDomains: 1,
    replications: 0,
    failedReplications: 0,
    verificationPassRate: null,
    agentAgreement: null,
    uncertaintyInterval: [Math.max(0, score - 0.1), Math.min(1, score + 0.1)],
    majorUncertainties: [],
    computedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeEvidence(projectId: string, sourceId: string, overrides: Overrides = {}): Evidence {
  return Evidence.parse({
    id: newId("evidence"),
    projectId,
    sourceId,
    chunkIds: [],
    quote: "Agents with persistent memory recalled 18% more prior context.",
    locator: "p. 4",
    interpretation: "The paper reports a measured recall improvement attributable to persistent memory.",
    stance: "supports",
    strength: { directness: 0.8, specificity: 0.8, methodologicalRigor: 0.7, quoteFidelity: 1 },
    relevance: 0.9,
    extractedByRunId: null,
    verifiedAt: null,
    verificationPassed: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeClaim(projectId: string, overrides: Overrides = {}): Claim {
  return Claim.parse({
    id: newId("claim"),
    projectId,
    questionId: null,
    hypothesisId: null,
    statement: "Persistent memory improves an agent's recall of prior context.",
    scope: null,
    claimType: "empirical",
    status: "proposed",
    assumptions: [],
    confidence: null,
    proposedByRunId: null,
    supersededByClaimId: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeQuestion(projectId: string, overrides: Overrides = {}): ResearchQuestion {
  return ResearchQuestion.parse({
    id: newId("question"),
    projectId,
    parentQuestionId: null,
    text: "Does persistent memory improve recall?",
    kind: "sub",
    status: "open",
    priority: 50,
    answerClaimIds: [],
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeHypothesis(projectId: string, overrides: Overrides = {}): Hypothesis {
  return Hypothesis.parse({
    id: newId("hypothesis"),
    projectId,
    questionId: null,
    statement: "Persistent memory improves recall by reducing context re-derivation.",
    status: "proposed",
    priorConfidence: 0.5,
    posteriorConfidence: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeContradiction(projectId: string, claimIdA: string, claimIdB: string, overrides: Overrides = {}): Contradiction {
  return Contradiction.parse({
    id: newId("contradiction"),
    projectId,
    claimIdA,
    claimIdB,
    kind: "incompatible_direction",
    status: "open",
    description: "One study reports improvement, another reports no effect.",
    severity: 0.7,
    candidateExplanations: [],
    resolution: null,
    resolvedByRunId: null,
    detectedByRunId: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeClaimEvidenceLink(claimId: string, evidenceId: string, overrides: Overrides = {}): ClaimEvidenceLink {
  return ClaimEvidenceLink.parse({
    claimId,
    evidenceId,
    stance: "supports",
    linkedByRunId: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}

export function makeClaimRelation(fromClaimId: string, toClaimId: string, overrides: Overrides = {}): ClaimRelation {
  return ClaimRelation.parse({
    fromClaimId,
    toClaimId,
    relation: "supports",
    strength: 0.7,
    createdByRunId: null,
    createdAt: FIXTURE_NOW,
    ...overrides,
  });
}
