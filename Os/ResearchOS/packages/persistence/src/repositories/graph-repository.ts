/**
 * Research graph projection.
 *
 * Nodes and edges are a *view* over the relational tables, rebuilt from them
 * rather than written alongside them. Keeping one source of truth means the
 * graph cannot drift from the data it describes — the failure mode where a
 * visualisation shows a relationship the database no longer has.
 */
import type { GraphEdge, GraphNode } from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, json, num, str, toJson, type Row } from "../row.ts";

export class GraphRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  async upsertNodes(nodes: readonly GraphNode[]): Promise<void> {
    const conflict = this.#db.dialect.upsert(["project_id", "type", "entity_id"], ["label", "properties"]);
    await this.#db.transaction(async (tx) => {
      for (const node of nodes) {
        await tx.execute(
          `INSERT INTO graph_nodes (id, project_id, type, entity_id, label, properties, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ${conflict}`,
          [node.id, node.projectId, node.type, node.entityId, node.label, toJson(node.properties), node.createdAt],
        );
      }
    });
  }

  async upsertEdges(edges: readonly GraphEdge[]): Promise<void> {
    const conflict = this.#db.dialect.upsert(["from_node_id", "to_node_id", "type"], ["weight", "properties"]);
    await this.#db.transaction(async (tx) => {
      for (const edge of edges) {
        await tx.execute(
          `INSERT INTO graph_edges (id, project_id, type, from_node_id, to_node_id, weight, properties, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
          [edge.id, edge.projectId, edge.type, edge.fromNodeId, edge.toNodeId, edge.weight, toJson(edge.properties), edge.createdAt],
        );
      }
    });
  }

  async nodeIdFor(projectId: string, type: string, entityId: string): Promise<string | undefined> {
    const row = await this.#db.queryOne<Row>(
      "SELECT id FROM graph_nodes WHERE project_id = ? AND type = ? AND entity_id = ?",
      [projectId, type, entityId],
    );
    return row ? str(row, "id") : undefined;
  }

  async loadGraph(projectId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const [nodeRows, edgeRows] = await Promise.all([
      this.#db.query<Row>("SELECT * FROM graph_nodes WHERE project_id = ? ORDER BY id", [projectId]),
      this.#db.query<Row>("SELECT * FROM graph_edges WHERE project_id = ? ORDER BY id", [projectId]),
    ]);
    return {
      nodes: nodeRows.map((row) => asEntity<GraphNode>({
        id: str(row, "id"), projectId: str(row, "project_id"), type: str(row, "type"),
        entityId: str(row, "entity_id"), label: str(row, "label"),
        properties: json(row, "properties", {}), createdAt: str(row, "created_at"),
      })),
      edges: edgeRows.map((row) => asEntity<GraphEdge>({
        id: str(row, "id"), projectId: str(row, "project_id"), type: str(row, "type"),
        fromNodeId: str(row, "from_node_id"), toNodeId: str(row, "to_node_id"),
        weight: num(row, "weight"), properties: json(row, "properties", {}), createdAt: str(row, "created_at"),
      })),
    };
  }

  /** Clears the projection before a rebuild. Edges cascade from nodes. */
  async clear(projectId: string): Promise<void> {
    await this.#db.execute("DELETE FROM graph_nodes WHERE project_id = ?", [projectId]);
  }
}
