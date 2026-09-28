/**
 * SQL-backed event store.
 *
 * The sequence number is assigned inside the same transaction as the insert, so
 * it is gapless and strictly increasing per project. That guarantee is the
 * entire resume contract for streaming clients: "I have up to 41" is
 * unambiguous only if there is exactly one event 42.
 */
import type { EventType, ResearchEvent } from "@research-os/contracts";
import type { AppendEventInput, EventStore, ReadEventsOptions } from "@research-os/events";
import { newId } from "@research-os/shared";
import type { Database } from "../database.ts";
import { json, num, str, strOrNull, toJson, type Row } from "../row.ts";

export class SqlEventStore implements EventStore {
  readonly #db: Database;
  readonly #now: () => string;

  constructor(db: Database, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  async append(input: AppendEventInput): Promise<ResearchEvent> {
    return this.#db.transaction(async (tx) => {
      // MAX + 1 inside the transaction. On Postgres the surrounding transaction
      // plus the unique index on (project_id, sequence) makes a concurrent
      // duplicate impossible: the second writer's insert fails and the caller
      // retries. A shared sequence generator would be faster but would not be
      // gapless, which is the property that matters here.
      const row = await tx.queryOne<Row>("SELECT COALESCE(MAX(sequence), 0) AS seq FROM research_events WHERE project_id = ?", [input.projectId]);
      const sequence = (row ? num(row, "seq") : 0) + 1;
      const event: ResearchEvent = {
        id: newId("event"),
        projectId: input.projectId,
        sequence,
        type: input.type,
        payload: input.payload as never,
        traceId: input.traceId ?? null,
        occurredAt: this.#now(),
        metadata: input.metadata ?? {},
      };
      await tx.execute(
        `INSERT INTO research_events (id, project_id, sequence, type, payload, trace_id, metadata, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [event.id, event.projectId, event.sequence, event.type, toJson(event.payload), event.traceId,
         toJson(event.metadata), event.occurredAt],
      );
      return event;
    });
  }

  async read(projectId: string, options: ReadEventsOptions = {}): Promise<ResearchEvent[]> {
    const conditions = ["project_id = ?", "sequence > ?"];
    const params: (string | number)[] = [projectId, options.since ?? 0];
    if (options.types && options.types.length > 0) {
      conditions.push(`type IN (${options.types.map(() => "?").join(", ")})`);
      params.push(...options.types);
    }
    params.push(options.limit ?? 200);
    const rows = await this.#db.query<Row>(
      `SELECT * FROM research_events WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      id: str(row, "id"),
      projectId: str(row, "project_id"),
      sequence: num(row, "sequence"),
      type: str(row, "type") as EventType,
      payload: json(row, "payload", {}) as never,
      traceId: strOrNull(row, "trace_id"),
      occurredAt: str(row, "occurred_at"),
      metadata: json(row, "metadata", {}),
    }));
  }

  async lastSequence(projectId: string): Promise<number> {
    const row = await this.#db.queryOne<Row>("SELECT COALESCE(MAX(sequence), 0) AS seq FROM research_events WHERE project_id = ?", [projectId]);
    return row ? num(row, "seq") : 0;
  }
}
