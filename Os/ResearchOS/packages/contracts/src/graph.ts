import { z } from "zod";
import { idSchema, IsoDateTime, Metadata, UnitInterval } from "./primitives.ts";

/**
 * The research graph.
 *
 * Every significant research object is projected into a uniform node/edge
 * model so that provenance is traversable: a conclusion can be walked back to
 * the claims, evidence and sources that produced it, and forward to the
 * experiments and questions it generated.
 *
 * The projection is a view over the relational tables, not a second source of
 * truth — which avoids the two diverging.
 */

export const GRAPH_NODE_TYPES = [
  "research_question",
  "hypothesis",
  "claim",
  "evidence",
  "source",
  "contradiction",
  "experiment",
  "experiment_result",
  "dataset",
  "agent_run",
  "finding",
  "entity",
  "concept",
] as const;
export const GraphNodeType = z.enum(GRAPH_NODE_TYPES);
export type GraphNodeType = z.infer<typeof GraphNodeType>;

export const GRAPH_EDGE_TYPES = [
  "decomposes_into",
  "tests",
  "asserts",
  "supports",
  "contradicts",
  "cites",
  "extracted_from",
  "produced_by",
  "measured_by",
  "uses_dataset",
  "resolves",
  "raises",
  "supersedes",
  "mentions",
  "relates_to",
] as const;
export const GraphEdgeType = z.enum(GRAPH_EDGE_TYPES);
export type GraphEdgeType = z.infer<typeof GraphEdgeType>;

export const GraphNode = z.object({
  id: idSchema("node"),
  projectId: idSchema("project"),
  type: GraphNodeType,
  /** Id of the underlying row this node projects. */
  entityId: z.string().max(64),
  label: z.string().max(1000),
  /** Denormalised display fields, so a graph render needs no extra queries. */
  properties: Metadata.default({}),
  createdAt: IsoDateTime,
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: idSchema("edge"),
  projectId: idSchema("project"),
  type: GraphEdgeType,
  fromNodeId: idSchema("node"),
  toNodeId: idSchema("node"),
  weight: UnitInterval.default(1),
  properties: Metadata.default({}),
  createdAt: IsoDateTime,
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ResearchGraph = z.object({
  projectId: idSchema("project"),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  generatedAt: IsoDateTime,
});
export type ResearchGraph = z.infer<typeof ResearchGraph>;

/**
 * Research evolution.
 *
 * Research produces questions as well as answers. The tree records what a
 * finding opened up, so the next run starts from the frontier rather than from
 * the original question.
 */
export const RESEARCH_TREE_NODE_KINDS = [
  "original_question",
  "finding",
  "open_question",
  "contradiction",
  "explanation",
  "proposed_experiment",
  "alternative_hypothesis",
] as const;
export const ResearchTreeNodeKind = z.enum(RESEARCH_TREE_NODE_KINDS);
export type ResearchTreeNodeKind = z.infer<typeof ResearchTreeNodeKind>;

export type ResearchTreeNode = {
  id: string;
  kind: ResearchTreeNodeKind;
  label: string;
  /** Underlying entity, when this node projects one. */
  entityId: string | null;
  /** Confidence, where the underlying entity has one. */
  confidence: number | null;
  /** Why this line of inquiry is worth pursuing, in [0,1]. */
  priority: number;
  rationale: string | null;
  children: ResearchTreeNode[];
};

export const ResearchTreeNode: z.ZodType<ResearchTreeNode> = z.lazy(() =>
  z.object({
    id: z.string().max(64),
    kind: ResearchTreeNodeKind,
    label: z.string().max(1000),
    entityId: z.string().max(64).nullable(),
    confidence: UnitInterval.nullable(),
    priority: UnitInterval,
    rationale: z.string().max(2000).nullable(),
    children: z.array(ResearchTreeNode),
  }),
);

export const ResearchTree = z.object({
  projectId: idSchema("project"),
  root: ResearchTreeNode,
  generatedAt: IsoDateTime,
});
export type ResearchTree = z.infer<typeof ResearchTree>;
