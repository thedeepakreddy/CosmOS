/**
 * Graph projection, traversal and the research tree.
 *
 * The property that matters most here is provenance: a claim must walk back to
 * the source it came from, and a claim that walks back to nothing must be
 * *detectable*, because an unsupported conclusion presented alongside evidenced
 * ones is the failure this whole system exists to prevent.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { newId } from "@research-os/shared";
import {
  FIXTURE_NOW as NOW, makeClaim, makeClaimEvidenceLink, makeClaimRelation, makeConfidence,
  makeContradiction, makeEvidence, makeHypothesis, makeProject, makeQuestion, makeSource,
} from "../../../tests/support/fixtures.ts";
import {
  buildIndex, dependentsOf, deterministicNodeId, informationValue, projectResearchGraph,
  projectResearchTree, provenanceOf, researchFrontier, shortestPath, summarise, traverse,
} from "../src/index.ts";

const PROJECT = makeProject().id;

const source = (title: string, domain: string) => makeSource(PROJECT, { title, domain, url: `https://${domain}/x`, sourceType: "peer_reviewed_article", status: "parsed", contentHash: null });
const evidence = (sourceId: string, quote: string, stance: "supports" | "contradicts") => makeEvidence(PROJECT, sourceId, { quote, stance });
const claim = (statement: string, confidence: number | null, overrides: Record<string, unknown> = {}) =>
  makeClaim(PROJECT, { statement, confidence: confidence === null ? null : makeConfidence(confidence), ...overrides });
const link = (claimId: string, evidenceId: string, stance: "supports" | "contradicts") => makeClaimEvidenceLink(claimId, evidenceId, { stance });

describe("deterministic identity", () => {
  test("the same entity always projects to the same node id", () => {
    const first = deterministicNodeId(PROJECT, "claim", "clm_1");
    const second = deterministicNodeId(PROJECT, "claim", "clm_1");
    assert.equal(first, second, "a rebuild must not renumber the graph");
    assert.match(first, /^nod_[0-9A-HJKMNP-TV-Z]{26}$/, "and must still satisfy the branded id shape");
  });

  test("different entities, types and projects do not collide", () => {
    const base = deterministicNodeId(PROJECT, "claim", "clm_1");
    assert.notEqual(base, deterministicNodeId(PROJECT, "claim", "clm_2"));
    assert.notEqual(base, deterministicNodeId(PROJECT, "evidence", "clm_1"));
    assert.notEqual(base, deterministicNodeId(newId("project"), "claim", "clm_1"));
  });

  test("length-prefixing prevents a boundary-shifting collision", () => {
    // Without length prefixes, ("ab","c") and ("a","bc") would hash identically.
    assert.notEqual(
      deterministicNodeId(PROJECT, "claim", "ab"),
      deterministicNodeId(PROJECT, "claim", "a") === deterministicNodeId(PROJECT, "claim", "ab") ? "collision" : deterministicNodeId(PROJECT, "claim", "b"),
    );
  });
});

describe("projectResearchGraph", () => {
  test("projects entities to nodes and links them with provenance edges", () => {
    const s = source("A paper", "arxiv.org");
    const e = evidence(s.id, "Memory improved recall by 18%.", "supports");
    const c = claim("Persistent memory improves recall.", 0.7);
    const graph = projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "supports")], now: NOW,
    });

    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2, "claim→evidence and evidence→source");
    assert.ok(graph.edges.some((edge) => edge.type === "extracted_from"));
    assert.ok(graph.edges.some((edge) => edge.type === "supports"));
  });

  test("re-projecting the same state is idempotent", () => {
    const s = source("A paper", "arxiv.org");
    const e = evidence(s.id, "q", "supports");
    const c = claim("statement", 0.5);
    const input = { projectId: PROJECT, sources: [s], evidence: [e], claims: [c], claimEvidence: [link(c.id, e.id, "supports")], now: NOW };

    const first = projectResearchGraph(input);
    const second = projectResearchGraph({ ...input, now: "2026-03-01T00:00:00.000Z" });

    assert.deepEqual(first.nodes.map((n) => n.id).sort(), second.nodes.map((n) => n.id).sort());
    assert.deepEqual(first.edges.map((e2) => e2.id).sort(), second.edges.map((e2) => e2.id).sort());
  });

  test("an edge to a missing node is dropped rather than dangled", () => {
    const c = claim("orphan claim", 0.5);
    const graph = projectResearchGraph({
      projectId: PROJECT, claims: [c],
      claimEvidence: [link(c.id, newId("evidence"), "supports")],
      now: NOW,
    });
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0, "a graph must never reference a node it does not contain");
  });

  test("a contradicting link projects as a contradicts edge, not a supports edge", () => {
    const s = source("Counter-paper", "nature.com");
    const e = evidence(s.id, "No effect was observed.", "contradicts");
    const c = claim("Persistent memory improves recall.", 0.4);
    const graph = projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "contradicts")], now: NOW,
    });
    assert.ok(graph.edges.some((edge) => edge.type === "contradicts"));
    assert.ok(!graph.edges.some((edge) => edge.type === "supports"));
  });

  test("denormalised properties are carried so a render needs no extra queries", () => {
    const c = claim("statement", 0.73);
    const graph = projectResearchGraph({ projectId: PROJECT, claims: [c], now: NOW });
    assert.equal(graph.nodes[0]?.properties["confidence"], 0.73);
    assert.equal(graph.nodes[0]?.properties["status"], "proposed");
  });
});

describe("provenance", () => {
  test("a claim walks back to the source underneath it", () => {
    const s = source("A paper", "arxiv.org");
    const e = evidence(s.id, "Memory improved recall.", "supports");
    const c = claim("Persistent memory improves recall.", 0.7);
    const graph = projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "supports")], now: NOW,
    });
    const index = buildIndex(graph);
    const claimNodeId = deterministicNodeId(PROJECT, "claim", c.id);

    const chain = provenanceOf(index, claimNodeId);

    assert.equal(chain.unsupported, false);
    assert.equal(chain.sources.length, 1);
    assert.equal(chain.sources[0]?.label, "A paper");
    assert.equal(chain.evidence.length, 1);
  });

  test("a claim with no evidence is reported as unsupported", () => {
    const c = claim("The model asserted this with nothing behind it.", null);
    const index = buildIndex(projectResearchGraph({ projectId: PROJECT, claims: [c], now: NOW }));

    const chain = provenanceOf(index, deterministicNodeId(PROJECT, "claim", c.id));

    assert.equal(chain.unsupported, true, "this is the failure the system exists to surface");
    assert.equal(chain.sources.length, 0);
  });

  test("provenance reaches a source two evidence hops away without double counting", () => {
    const s = source("One paper", "arxiv.org");
    const e1 = evidence(s.id, "first passage", "supports");
    const e2 = evidence(s.id, "second passage", "supports");
    const c = claim("statement", 0.6);
    const index = buildIndex(projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e1, e2], claims: [c],
      claimEvidence: [link(c.id, e1.id, "supports"), link(c.id, e2.id, "supports")], now: NOW,
    }));

    const chain = provenanceOf(index, deterministicNodeId(PROJECT, "claim", c.id));
    assert.equal(chain.evidence.length, 2);
    assert.equal(chain.sources.length, 1, "two passages from one paper is still one source");
  });

  test("dependents show what breaks if a source turns out to be wrong", () => {
    const s = source("A paper", "arxiv.org");
    const e = evidence(s.id, "q", "supports");
    const c = claim("statement", 0.7);
    const index = buildIndex(projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "supports")], now: NOW,
    }));

    const dependents = dependentsOf(index, deterministicNodeId(PROJECT, "source", s.id));
    assert.deepEqual(dependents.map((node) => node.type).sort(), ["claim", "evidence"]);
  });
});

describe("traversal", () => {
  test("a cycle terminates instead of recursing forever", () => {
    const a = claim("A", 0.5);
    const b = claim("B", 0.5);
    const graph = projectResearchGraph({
      projectId: PROJECT, claims: [a, b],
      claimRelations: [
        makeClaimRelation(a.id, b.id, { strength: 1 }),
        makeClaimRelation(b.id, a.id, { strength: 1 }),
      ],
      now: NOW,
    });
    const index = buildIndex(graph);
    const visited = traverse(index, deterministicNodeId(PROJECT, "claim", a.id), { maxDepth: 50 });
    assert.equal(visited.length, 2, "each node is visited once");
  });

  test("maxDepth bounds the walk", () => {
    const s = source("p", "d.com");
    const e = evidence(s.id, "q", "supports");
    const c = claim("statement", 0.5);
    const index = buildIndex(projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "supports")], now: NOW,
    }));
    const start = deterministicNodeId(PROJECT, "claim", c.id);
    assert.equal(traverse(index, start, { maxDepth: 0 }).length, 1);
    assert.equal(traverse(index, start, { maxDepth: 1 }).length, 2);
    assert.equal(traverse(index, start, { maxDepth: 2 }).length, 3);
  });

  test("shortest path connects a source to the conclusion built on it", () => {
    const s = source("p", "d.com");
    const e = evidence(s.id, "q", "supports");
    const c = claim("statement", 0.5);
    const index = buildIndex(projectResearchGraph({
      projectId: PROJECT, sources: [s], evidence: [e], claims: [c],
      claimEvidence: [link(c.id, e.id, "supports")], now: NOW,
    }));

    const path = shortestPath(index, deterministicNodeId(PROJECT, "source", s.id), deterministicNodeId(PROJECT, "claim", c.id));
    assert.ok(path);
    assert.deepEqual(path.map((step) => step.node.type), ["source", "evidence", "claim"]);
    assert.equal(shortestPath(index, deterministicNodeId(PROJECT, "source", s.id), deterministicNodeId(PROJECT, "claim", "unknown")), null);
  });

  test("summary counts nodes, edges and orphans", () => {
    const orphan = claim("unconnected", null);
    const s = source("p", "d.com");
    const e = evidence(s.id, "q", "supports");
    const index = buildIndex(projectResearchGraph({ projectId: PROJECT, sources: [s], evidence: [e], claims: [orphan], now: NOW }));

    const summary = summarise(index);
    assert.equal(summary.nodeCount, 3);
    assert.equal(summary.edgeCount, 1);
    assert.equal(summary.orphanCount, 1, "an unconnected claim is worth noticing");
    assert.equal(summary.nodesByType["claim"], 1);
  });
});

describe("research tree", () => {
  test("information value peaks where the evidence is most uncertain", () => {
    assert.equal(informationValue(0.5), 1, "a coin-flip claim is where more evidence pays");
    assert.ok(informationValue(0.5) > informationValue(0.8));
    assert.ok(informationValue(0.95) < 0.2, "a settled claim buys little");
    assert.equal(informationValue(null), 0.8, "unmeasured is worth measuring");
  });

  test("an unresolved contradiction outranks a settled finding", () => {
    const settled = claim("Well established.", 0.95, { status: "supported" });
    const tree = projectResearchTree({
      projectId: PROJECT,
      originalQuestion: "Does persistent memory help?",
      claims: [settled],
      contradictions: [makeContradiction(PROJECT, settled.id, newId("claim"), {
        description: "Two studies disagree on direction.",
        severity: 0.9,
        candidateExplanations: ["Different populations"],
      })],
      now: NOW,
    });

    const frontier = researchFrontier(tree);
    assert.equal(frontier[0]?.kind, "contradiction");
    assert.ok((frontier[0]?.priority ?? 0) > 0.8);
  });

  test("the root carries the original question and children sort by priority", () => {
    const tree = projectResearchTree({
      projectId: PROJECT,
      originalQuestion: "Does persistent memory improve agent performance?",
      questions: [
        makeQuestion(PROJECT, { text: "Low priority sub-question", priority: 10 }),
        makeQuestion(PROJECT, { text: "High priority sub-question", priority: 95 }),
      ],
      now: NOW,
    });

    assert.equal(tree.root.kind, "original_question");
    assert.equal(tree.root.label, "Does persistent memory improve agent performance?");
    assert.equal(tree.root.children[0]?.label, "High priority sub-question");
  });

  test("a parent is at least as urgent as its most urgent child", () => {
    const questionId = newId("question");
    const tree = projectResearchTree({
      projectId: PROJECT,
      originalQuestion: "Root",
      questions: [makeQuestion(PROJECT, { id: questionId, text: "Answered question", status: "answered", priority: 5 })],
      claims: [claim("A genuinely uncertain finding", 0.5, { questionId })],
      now: NOW,
    });

    const question = tree.root.children[0];
    assert.equal(question?.label, "Answered question");
    assert.ok((question?.priority ?? 0) >= 0.9, "an answered question hiding an uncertain claim must not sink out of sight");
  });

  test("a hypothesis with no falsification criteria says so", () => {
    const tree = projectResearchTree({
      projectId: PROJECT,
      originalQuestion: "Root",
      hypotheses: [makeHypothesis(PROJECT, { statement: "Memory helps" })],
      now: NOW,
    });
    const node = tree.root.children.find((child) => child.kind === "alternative_hypothesis");
    assert.match(String(node?.rationale), /not yet testable/);
  });
});
