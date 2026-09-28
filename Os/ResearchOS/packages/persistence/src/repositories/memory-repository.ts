/**
 * SQL-backed memory store.
 *
 * Implements the persistence half of the MemoryProvider port. Kept generic —
 * it knows about layers, scopes, keys and links, not about claims or evidence —
 * so that swapping it for a shared MemoryOS backend later is a matter of
 * implementing the same port against a different store.
 */
import type { MemoryLayer, MemoryLink, MemoryQuery, MemoryRecord } from "@research-os/contracts";
import type { Database } from "../database.ts";
import { asEntity, json, jsonOrNull, num, str, strOrNull, toJson, type Row } from "../row.ts";

function toMemory(row: Row): MemoryRecord {
  return asEntity<MemoryRecord>({
    id: str(row, "id"),
    layer: str(row, "layer"),
    scope: {
      tenantId: strOrNull(row, "tenant_id"),
      projectId: strOrNull(row, "project_id"),
      application: strOrNull(row, "application"),
      visibility: str(row, "visibility"),
    },
    key: str(row, "memory_key"),
    content: json(row, "content", null),
    searchText: str(row, "search_text"),
    embedding: jsonOrNull<number[]>(row, "embedding"),
    embeddingModel: strOrNull(row, "embedding_model"),
    salience: num(row, "salience"),
    referenceIds: json(row, "reference_ids", []),
    tags: json(row, "tags", []),
    metadata: json(row, "metadata", {}),
    expiresAt: strOrNull(row, "expires_at"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    lastAccessedAt: strOrNull(row, "last_accessed_at"),
    accessCount: num(row, "access_count"),
  });
}

export class MemoryRepository {
  readonly #db: Database;
  constructor(db: Database) { this.#db = db; }

  async store(record: MemoryRecord): Promise<void> {
    const conflict = this.#db.dialect.upsert(["id"], [
      "content", "search_text", "embedding", "embedding_model", "salience", "reference_ids", "tags",
      "metadata", "expires_at", "updated_at",
    ]);
    await this.#db.execute(
      `INSERT INTO memory_records (id, layer, tenant_id, project_id, application, visibility, memory_key,
        content, search_text, embedding, embedding_model, salience, reference_ids, tags, metadata,
        expires_at, created_at, updated_at, last_accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`,
      [record.id, record.layer, record.scope.tenantId, record.scope.projectId, record.scope.application,
       record.scope.visibility, record.key, toJson(record.content), record.searchText, toJson(record.embedding),
       record.embeddingModel, record.salience, toJson(record.referenceIds), toJson(record.tags),
       toJson(record.metadata), record.expiresAt, record.createdAt, record.updatedAt,
       record.lastAccessedAt, record.accessCount],
    );
  }

  async findById(id: string): Promise<MemoryRecord | undefined> {
    const row = await this.#db.queryOne<Row>("SELECT * FROM memory_records WHERE id = ?", [id]);
    return row ? toMemory(row) : undefined;
  }

  async findByKey(key: string, projectId: string | null): Promise<MemoryRecord | undefined> {
    const row = projectId
      ? await this.#db.queryOne<Row>("SELECT * FROM memory_records WHERE memory_key = ? AND project_id = ?", [key, projectId])
      : await this.#db.queryOne<Row>("SELECT * FROM memory_records WHERE memory_key = ? AND project_id IS NULL", [key]);
    return row ? toMemory(row) : undefined;
  }

  /**
   * Candidate set for a query. Filtering that SQL can do happens here; ranking
   * (lexical scoring, vector similarity, hybrid blending) happens in the memory
   * package, so ranking behaviour is identical on both engines and unit-testable
   * without a database.
   */
  async candidates(query: MemoryQuery, now: string, limit: number): Promise<MemoryRecord[]> {
    const conditions: string[] = ["(expires_at IS NULL OR expires_at > ?)"];
    const params: (string | number)[] = [now];

    if (query.layers.length > 0) {
      conditions.push(`layer IN (${query.layers.map(() => "?").join(", ")})`);
      params.push(...query.layers);
    }
    const scope = query.scope;
    if (scope?.projectId) { conditions.push("(project_id = ? OR visibility IN ('tenant', 'global'))"); params.push(scope.projectId); }
    if (scope?.tenantId) { conditions.push("(tenant_id = ? OR visibility = 'global')"); params.push(scope.tenantId); }
    if (scope?.application) { conditions.push("(application = ? OR application IS NULL)"); params.push(scope.application); }
    if (query.keyPrefix) { conditions.push("memory_key LIKE ?"); params.push(`${query.keyPrefix}%`); }
    if (query.minSalience !== undefined) { conditions.push("salience >= ?"); params.push(query.minSalience); }
    params.push(limit);

    const rows = await this.#db.query<Row>(
      `SELECT * FROM memory_records WHERE ${conditions.join(" AND ")} ORDER BY salience DESC, id DESC LIMIT ?`,
      params,
    );
    let records = rows.map(toMemory);

    // Tag and reference filters are conjunctive over JSON arrays, which is
    // awkward and non-portable in SQL and trivial here.
    if (query.tags.length > 0) {
      records = records.filter((record) => query.tags.every((tag) => record.tags.includes(tag)));
    }
    if (query.referenceIds.length > 0) {
      records = records.filter((record) => query.referenceIds.some((id) => record.referenceIds.includes(id)));
    }
    return records;
  }

  async update(id: string, patch: Record<string, unknown>, updatedAt: string): Promise<void> {
    const columnFor: Record<string, string> = {
      content: "content", searchText: "search_text", salience: "salience", tags: "tags",
      metadata: "metadata", expiresAt: "expires_at", referenceIds: "reference_ids",
      embedding: "embedding", embeddingModel: "embedding_model",
    };
    const jsonColumns = new Set(["content", "tags", "metadata", "reference_ids", "embedding"]);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = columnFor[field];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(jsonColumns.has(column) ? toJson(value) : (value as string | number | null));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(updatedAt, id);
    await this.#db.execute(`UPDATE memory_records SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async touch(id: string, accessedAt: string): Promise<void> {
    await this.#db.execute("UPDATE memory_records SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?", [accessedAt, id]);
  }

  async delete(id: string): Promise<void> {
    await this.#db.execute("DELETE FROM memory_records WHERE id = ?", [id]);
  }

  async link(link: MemoryLink): Promise<void> {
    const conflict = this.#db.dialect.upsert(["from_memory_id", "to_memory_id", "type"], ["weight"]);
    await this.#db.execute(
      `INSERT INTO memory_links (from_memory_id, to_memory_id, type, weight, created_at) VALUES (?, ?, ?, ?, ?) ${conflict}`,
      [link.fromMemoryId, link.toMemoryId, link.type, link.weight, link.createdAt],
    );
  }

  async linksFrom(memoryId: string): Promise<MemoryLink[]> {
    const rows = await this.#db.query<Row>("SELECT * FROM memory_links WHERE from_memory_id = ?", [memoryId]);
    return rows.map((row) => asEntity<MemoryLink>({
      fromMemoryId: str(row, "from_memory_id"), toMemoryId: str(row, "to_memory_id"),
      type: str(row, "type"), weight: num(row, "weight"), createdAt: str(row, "created_at"),
    }));
  }

  async purgeExpired(now: string): Promise<number> {
    return this.#db.execute("DELETE FROM memory_records WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
  }

  async countByLayer(projectId: string): Promise<Record<MemoryLayer, number>> {
    const rows = await this.#db.query<Row>("SELECT layer, COUNT(*) AS c FROM memory_records WHERE project_id = ? GROUP BY layer", [projectId]);
    return Object.fromEntries(rows.map((row) => [str(row, "layer"), num(row, "c")])) as Record<MemoryLayer, number>;
  }
}

export { toMemory };
