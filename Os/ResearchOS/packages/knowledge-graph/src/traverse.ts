/**
 * Graph traversal.
 *
 * The question this exists to answer is "where did this conclusion come from?",
 * and the answer has to be a walk rather than a join, because the chain has no
 * fixed length: a claim rests on evidence, which was extracted from a source,
 * but a claim may also rest on another claim that rests on an experiment result.
 *
 * Every function here is pure and works on an index built once per graph, so
 * repeated queries during report generation do not re-scan the edge list.
 */
import type { GraphEdge, GraphEdgeType, GraphNode, GraphNodeType } from "@research-os/contracts";

export type Direction = "out" | "in" | "both";

export interface GraphIndex {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly edges: readonly GraphEdge[];
}

export function buildIndex(graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }): GraphIndex {
  const nodes = new Map(graph.nodes.map((node) => [node.id as string, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    const from = edge.fromNodeId as string;
    const to = edge.toNodeId as string;
    (outgoing.get(from) ?? outgoing.set(from, []).get(from)!).push(edge);
    (incoming.get(to) ?? incoming.set(to, []).get(to)!).push(edge);
  }

  return { nodes, outgoing, incoming, edges: graph.edges };
}

export interface TraversalOptions {
  readonly direction?: Direction;
  readonly maxDepth?: number;
  /** Only follow these edge types. Empty or absent means all. */
  readonly edgeTypes?: readonly GraphEdgeType[];
  /** Only return nodes of these types. Traversal still passes through others. */
  readonly nodeTypes?: readonly GraphNodeType[];
  readonly maxNodes?: number;
}

export interface VisitedNode {
  readonly node: GraphNode;
  readonly depth: number;
  /** The edge that led here. Null for the starting node. */
  readonly via: GraphEdge | null;
}

function edgesFrom(index: GraphIndex, nodeId: string, direction: Direction): { edge: GraphEdge; next: string }[] {
  const out = direction === "in" ? [] : (index.outgoing.get(nodeId) ?? []).map((edge) => ({ edge, next: edge.toNodeId as string }));
  const inc = direction === "out" ? [] : (index.incoming.get(nodeId) ?? []).map((edge) => ({ edge, next: edge.fromNodeId as string }));
  return [...out, ...inc];
}

/**
 * Breadth-first walk from a starting node.
 *
 * Breadth-first rather than depth-first so that `maxDepth` means "within N
 * hops", which is the question callers actually ask. Visited nodes are tracked
 * by id, so a cycle terminates rather than recursing — research graphs contain
 * cycles routinely, for instance a claim that supersedes one which relates back.
 */
export function traverse(index: GraphIndex, startId: string, options: TraversalOptions = {}): VisitedNode[] {
  const start = index.nodes.get(startId);
  if (!start) return [];

  const direction = options.direction ?? "out";
  const maxDepth = options.maxDepth ?? 5;
  const maxNodes = options.maxNodes ?? 5000;
  const allowedEdges = options.edgeTypes?.length ? new Set(options.edgeTypes) : null;
  const allowedNodes = options.nodeTypes?.length ? new Set(options.nodeTypes) : null;

  const seen = new Set<string>([startId]);
  const queue: VisitedNode[] = [{ node: start, depth: 0, via: null }];
  const visited: VisitedNode[] = [];

  while (queue.length > 0 && visited.length < maxNodes) {
    const current = queue.shift();
    if (!current) break;
    if (!allowedNodes || allowedNodes.has(current.node.type)) visited.push(current);
    if (current.depth >= maxDepth) continue;

    for (const { edge, next } of edgesFrom(index, current.node.id as string, direction)) {
      if (allowedEdges && !allowedEdges.has(edge.type)) continue;
      if (seen.has(next)) continue;
      const node = index.nodes.get(next);
      if (!node) continue;
      seen.add(next);
      queue.push({ node, depth: current.depth + 1, via: edge });
    }
  }

  return visited;
}

/** Edge types that point from a derived thing toward what it was derived from. */
const PROVENANCE_EDGES: readonly GraphEdgeType[] = ["supports", "contradicts", "cites", "extracted_from", "produced_by", "tests"];

export interface ProvenanceChain {
  readonly nodeId: string;
  /** Every source reachable by following provenance edges. */
  readonly sources: GraphNode[];
  readonly evidence: GraphNode[];
  /** The full walk, for rendering or debugging. */
  readonly path: VisitedNode[];
  /**
   * True when the walk reached no source at all. A conclusion with no
   * provenance is the thing this system exists to make visible, not an edge
   * case to be tidied away.
   */
  readonly unsupported: boolean;
}

/**
 * Walks a claim back to the sources underneath it.
 *
 * `unsupported` is the load-bearing field. A claim that reaches no source is
 * either a model inference presented as a finding or a bug in extraction, and
 * either way a report must say so rather than quietly printing it next to
 * claims that are properly evidenced.
 */
export function provenanceOf(index: GraphIndex, nodeId: string, maxDepth = 8): ProvenanceChain {
  const path = traverse(index, nodeId, { direction: "out", maxDepth, edgeTypes: PROVENANCE_EDGES });
  const sources = path.filter((visited) => visited.node.type === "source").map((visited) => visited.node);
  const evidence = path.filter((visited) => visited.node.type === "evidence").map((visited) => visited.node);
  return { nodeId, sources, evidence, path, unsupported: sources.length === 0 };
}

/** Nodes that depend on this one — what breaks if it turns out to be wrong. */
export function dependentsOf(index: GraphIndex, nodeId: string, maxDepth = 8): GraphNode[] {
  return traverse(index, nodeId, { direction: "in", maxDepth })
    .filter((visited) => visited.depth > 0)
    .map((visited) => visited.node);
}

/**
 * Shortest path between two nodes, or null when none exists.
 *
 * Used to answer "how is this source connected to that conclusion?" — which is
 * the question a reader asks when a citation looks surprising.
 */
export function shortestPath(index: GraphIndex, fromId: string, toId: string, maxDepth = 10): VisitedNode[] | null {
  if (!index.nodes.has(fromId) || !index.nodes.has(toId)) return null;
  if (fromId === toId) {
    const node = index.nodes.get(fromId);
    return node ? [{ node, depth: 0, via: null }] : null;
  }

  const previous = new Map<string, { from: string; edge: GraphEdge }>();
  const seen = new Set<string>([fromId]);
  let frontier = [fromId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const { edge, next: neighbour } of edgesFrom(index, nodeId, "both")) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        previous.set(neighbour, { from: nodeId, edge });
        if (neighbour === toId) return reconstruct(index, previous, fromId, toId);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return null;
}

function reconstruct(index: GraphIndex, previous: Map<string, { from: string; edge: GraphEdge }>, fromId: string, toId: string): VisitedNode[] {
  const reversed: VisitedNode[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = previous.get(cursor);
    const node = index.nodes.get(cursor);
    if (!step || !node) break;
    reversed.push({ node, depth: 0, via: step.edge });
    cursor = step.from;
  }
  const start = index.nodes.get(fromId);
  if (start) reversed.push({ node: start, depth: 0, via: null });
  return reversed.reverse().map((visited, depth) => ({ ...visited, depth }));
}

export interface GraphSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly nodesByType: Record<string, number>;
  readonly edgesByType: Record<string, number>;
  /** Nodes with no edges at all — usually a projection gap worth looking at. */
  readonly orphanCount: number;
}

export function summarise(index: GraphIndex): GraphSummary {
  const nodesByType: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};
  let orphanCount = 0;

  for (const node of index.nodes.values()) {
    nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    const id = node.id as string;
    if ((index.outgoing.get(id)?.length ?? 0) === 0 && (index.incoming.get(id)?.length ?? 0) === 0) orphanCount++;
  }
  for (const edge of index.edges) {
    edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
  }

  return { nodeCount: index.nodes.size, edgeCount: index.edges.length, nodesByType, edgesByType, orphanCount };
}
