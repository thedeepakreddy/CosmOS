/**
 * Projects research state into the uniform node/edge model.
 *
 * A pure function: research state in, nodes and edges out. No I/O, no clock
 * beyond an injected timestamp, so the projection is exhaustively testable and
 * a graph rendered in a UI can always be reproduced from the rows it came from.
 *
 * The edges that matter most are the provenance ones — `extracted_from` and
 * `cites` — because together they are what makes "walk this conclusion back to
 * the document it came from" a graph traversal rather than a research project
 * of its own.
 */
import type {
  Claim, ClaimEvidenceLink, ClaimRelation, Contradiction, Evidence, Experiment, ExperimentRun,
  GraphEdge, GraphEdgeType, GraphNode, GraphNodeType, Hypothesis, ResearchQuestion, Source,
} from "@research-os/contracts";
import { deterministicEdgeId, deterministicNodeId } from "./identity.ts";

/** Everything the projection reads. Every field optional so partial state still projects. */
export interface ProjectionInput {
  readonly projectId: string;
  readonly questions?: readonly ResearchQuestion[];
  readonly hypotheses?: readonly Hypothesis[];
  readonly sources?: readonly Source[];
  readonly evidence?: readonly Evidence[];
  readonly claims?: readonly Claim[];
  readonly claimEvidence?: readonly ClaimEvidenceLink[];
  readonly claimRelations?: readonly ClaimRelation[];
  readonly contradictions?: readonly Contradiction[];
  readonly experiments?: readonly Experiment[];
  readonly experimentRuns?: readonly ExperimentRun[];
  readonly now: string;
}

/** Claim relation vocabulary mapped onto graph edge types. */
const CLAIM_RELATION_EDGES: Record<ClaimRelation["relation"], GraphEdgeType> = {
  supports: "supports",
  contradicts: "contradicts",
  refines: "relates_to",
  generalizes: "relates_to",
  duplicates: "relates_to",
  depends_on: "relates_to",
  explains: "relates_to",
};

class Projection {
  readonly #projectId: string;
  readonly #now: string;
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges = new Map<string, GraphEdge>();

  constructor(projectId: string, now: string) {
    this.#projectId = projectId;
    this.#now = now;
  }

  node(type: GraphNodeType, entityId: string, label: string, properties: Record<string, unknown> = {}): string {
    const id = deterministicNodeId(this.#projectId, type, entityId);
    // Last write wins on properties: a re-projection carries fresher values.
    this.#nodes.set(id, {
      id, projectId: this.#projectId as GraphNode["projectId"], type, entityId,
      label: label.slice(0, 1000), properties, createdAt: this.#now,
    } as GraphNode);
    return id;
  }

  /** Edges to or from a node that was never created are dropped, not dangled. */
  edge(type: GraphEdgeType, from: string | undefined, to: string | undefined, weight = 1, properties: Record<string, unknown> = {}): void {
    if (!from || !to || !this.#nodes.has(from) || !this.#nodes.has(to)) return;
    const id = deterministicEdgeId(this.#projectId, type, from, to);
    this.#edges.set(id, {
      id, projectId: this.#projectId as GraphEdge["projectId"], type,
      fromNodeId: from as GraphEdge["fromNodeId"], toNodeId: to as GraphEdge["toNodeId"],
      weight, properties, createdAt: this.#now,
    } as GraphEdge);
  }

  result(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: [...this.#nodes.values()], edges: [...this.#edges.values()] };
  }
}

export function projectResearchGraph(input: ProjectionInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const projection = new Projection(input.projectId, input.now);

  // Nodes are created before any edge is drawn, because `edge()` refuses to
  // connect a node that does not exist — which is how dangling edges are made
  // impossible rather than merely discouraged.
  const questionNodes = new Map<string, string>();
  for (const question of input.questions ?? []) {
    questionNodes.set(question.id, projection.node("research_question", question.id, question.text, {
      kind: question.kind, status: question.status, priority: question.priority,
    }));
  }

  const hypothesisNodes = new Map<string, string>();
  for (const hypothesis of input.hypotheses ?? []) {
    hypothesisNodes.set(hypothesis.id, projection.node("hypothesis", hypothesis.id, hypothesis.statement, {
      status: hypothesis.status,
      priorConfidence: hypothesis.priorConfidence,
      posteriorConfidence: hypothesis.posteriorConfidence,
    }));
  }

  const sourceNodes = new Map<string, string>();
  for (const source of input.sources ?? []) {
    sourceNodes.set(source.id, projection.node("source", source.id, source.title, {
      url: source.url, domain: source.domain, sourceType: source.sourceType,
      status: source.status, publishedAt: source.publishedAt,
      quality: source.quality?.score ?? null,
    }));
  }

  const evidenceNodes = new Map<string, string>();
  for (const item of input.evidence ?? []) {
    evidenceNodes.set(item.id, projection.node("evidence", item.id, item.quote, {
      stance: item.stance, relevance: item.relevance,
      verificationPassed: item.verificationPassed, locator: item.locator,
    }));
  }

  const claimNodes = new Map<string, string>();
  for (const claim of input.claims ?? []) {
    claimNodes.set(claim.id, projection.node("claim", claim.id, claim.statement, {
      status: claim.status, claimType: claim.claimType,
      confidence: claim.confidence?.score ?? null,
      uncertaintyInterval: claim.confidence?.uncertaintyInterval ?? null,
    }));
  }

  const contradictionNodes = new Map<string, string>();
  for (const contradiction of input.contradictions ?? []) {
    contradictionNodes.set(contradiction.id, projection.node("contradiction", contradiction.id, contradiction.description, {
      kind: contradiction.kind, status: contradiction.status, severity: contradiction.severity,
    }));
  }

  const experimentNodes = new Map<string, string>();
  for (const experiment of input.experiments ?? []) {
    experimentNodes.set(experiment.id, projection.node("experiment", experiment.id, experiment.title, {
      status: experiment.status, runtime: experiment.environment.runtime,
    }));
  }

  const runNodes = new Map<string, string>();
  for (const run of input.experimentRuns ?? []) {
    runNodes.set(run.id, projection.node("experiment_result", run.id, `Attempt ${run.attempt}: ${run.status}`, {
      status: run.status, attempt: run.attempt, metrics: run.metrics,
      reproductionMatched: run.reproductionMatched,
    }));
  }

  /* ---------- Edges ---------- */

  for (const question of input.questions ?? []) {
    if (question.parentQuestionId) {
      projection.edge("decomposes_into", questionNodes.get(question.parentQuestionId), questionNodes.get(question.id));
    }
  }

  for (const hypothesis of input.hypotheses ?? []) {
    if (hypothesis.questionId) {
      projection.edge("raises", questionNodes.get(hypothesis.questionId), hypothesisNodes.get(hypothesis.id));
    }
  }

  // Provenance: evidence came out of a source, and nothing else did.
  for (const item of input.evidence ?? []) {
    projection.edge("extracted_from", evidenceNodes.get(item.id), sourceNodes.get(item.sourceId));
  }

  for (const claim of input.claims ?? []) {
    if (claim.questionId) projection.edge("asserts", questionNodes.get(claim.questionId), claimNodes.get(claim.id));
    if (claim.hypothesisId) projection.edge("tests", claimNodes.get(claim.id), hypothesisNodes.get(claim.hypothesisId));
    if (claim.supersededByClaimId) {
      projection.edge("supersedes", claimNodes.get(claim.supersededByClaimId), claimNodes.get(claim.id));
    }
  }

  // The link that carries a stance: a claim cites evidence either way, and the
  // edge type records which way it cut.
  for (const link of input.claimEvidence ?? []) {
    const claimNode = claimNodes.get(link.claimId);
    const evidenceNode = evidenceNodes.get(link.evidenceId);
    const type: GraphEdgeType =
      link.stance === "supports" ? "supports" : link.stance === "contradicts" ? "contradicts" : "cites";
    projection.edge(type, claimNode, evidenceNode, 1, { stance: link.stance });
  }

  for (const relation of input.claimRelations ?? []) {
    projection.edge(
      CLAIM_RELATION_EDGES[relation.relation],
      claimNodes.get(relation.fromClaimId),
      claimNodes.get(relation.toClaimId),
      relation.strength,
      { relation: relation.relation },
    );
  }

  for (const contradiction of input.contradictions ?? []) {
    projection.edge("contradicts", contradictionNodes.get(contradiction.id), claimNodes.get(contradiction.claimIdA), contradiction.severity);
    projection.edge("contradicts", contradictionNodes.get(contradiction.id), claimNodes.get(contradiction.claimIdB), contradiction.severity);
  }

  for (const experiment of input.experiments ?? []) {
    if (experiment.hypothesisId) {
      projection.edge("tests", experimentNodes.get(experiment.id), hypothesisNodes.get(experiment.hypothesisId));
    }
  }

  for (const run of input.experimentRuns ?? []) {
    projection.edge("produced_by", runNodes.get(run.id), experimentNodes.get(run.experimentId));
    if (run.reproducedRunId) {
      projection.edge("relates_to", runNodes.get(run.id), runNodes.get(run.reproducedRunId), 1, {
        reproductionMatched: run.reproductionMatched,
      });
    }
  }

  return projection.result();
}
