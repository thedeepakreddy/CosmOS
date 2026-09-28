/**
 * The graph store port.
 *
 * The research graph is a *projection* of the relational tables, rebuilt from
 * them rather than written alongside them. That is the whole design: with one
 * source of truth the graph cannot drift from the data it describes, and the
 * failure mode where a visualisation shows a relationship the database no
 * longer has becomes impossible rather than merely unlikely.
 *
 * This package owns the projection and the traversal; it does not own storage.
 * `GraphRepository` in the persistence package satisfies this port.
 */
import type { GraphEdge, GraphNode } from "@research-os/contracts";

export interface GraphStore {
  upsertNodes(nodes: readonly GraphNode[]): Promise<void>;
  upsertEdges(edges: readonly GraphEdge[]): Promise<void>;
  loadGraph(projectId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  /** Clears the projection before a rebuild. */
  clear(projectId: string): Promise<void>;
}
