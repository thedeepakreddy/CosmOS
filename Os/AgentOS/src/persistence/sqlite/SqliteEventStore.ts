import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AgentEvent } from '../../domain/events';
import { EventStore, AppendEventInput, TaskAttemptRecord } from '../contracts';

interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: string | null;
  timestamp: string;
  correlation_id: string | null;
  causation_id: string | null;
  task_id: string | null;
}

function toEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    timestamp: row.timestamp,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    taskId: row.task_id ?? undefined,
    payload: row.payload ? JSON.parse(row.payload) : undefined
  };
}

export class SqliteEventStore implements EventStore {
  constructor(private db: Database) {}

  /**
   * Append an event, assigning the next per-run sequence number atomically.
   *
   * The read of MAX(seq) and the insert are one IMMEDIATE transaction, so two
   * workers appending to the same run cannot be handed the same number. The
   * UNIQUE index on (run_id, seq) is the backstop: a duplicate is a database
   * error, never a silently corrupted stream.
   */
  append(input: AppendEventInput): AgentEvent {
    const insert = this.db.prepare(
      `INSERT INTO events (id, run_id, seq, type, payload, timestamp, correlation_id, causation_id, task_id)
       VALUES (@id, @run_id, @seq, @type, @payload, @timestamp, @correlation_id, @causation_id, @task_id)`
    );
    const nextSeq = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?'
    );

    const tx = this.db.transaction((): AgentEvent => {
      const { next } = nextSeq.get(input.runId) as { next: number };
      const event: AgentEvent = {
        id: uuidv4(),
        runId: input.runId,
        seq: next,
        type: input.type,
        timestamp: input.timestamp ?? new Date().toISOString(),
        correlationId: input.correlationId,
        causationId: input.causationId,
        taskId: input.taskId,
        payload: input.payload
      };
      insert.run({
        id: event.id,
        run_id: event.runId,
        seq: event.seq,
        type: event.type,
        payload: event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
        correlation_id: event.correlationId ?? null,
        causation_id: event.causationId ?? null,
        task_id: event.taskId ?? null
      });
      return event;
    });

    return tx.immediate();
  }

  listByRun(runId: string, afterSeq = 0): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as EventRow[];
    return rows.map(toEvent);
  }

  listByTask(runId: string, taskId: string): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND task_id = ? ORDER BY seq')
      .all(runId, taskId) as EventRow[];
    return rows.map(toEvent);
  }

  // ---- per-attempt history (Phase F) ---------------------------------------

  /** Record that an attempt began. One row per real execution. */
  beginAttempt(record: Omit<TaskAttemptRecord, 'endedAt' | 'durationMs' | 'outcome' | 'error'>): void {
    this.db
      .prepare(
        `INSERT INTO task_attempts (run_id, task_id, attempt, fence, worker_id, started_at)
         VALUES (@run_id, @task_id, @attempt, @fence, @worker_id, @started_at)
         ON CONFLICT(run_id, task_id, attempt) DO UPDATE SET
           fence = excluded.fence, worker_id = excluded.worker_id, started_at = excluded.started_at`
      )
      .run({
        run_id: record.runId, task_id: record.taskId, attempt: record.attempt,
        fence: record.fence, worker_id: record.workerId, started_at: record.startedAt
      });
  }

  /** Close an attempt with its outcome and measured duration. */
  endAttempt(
    ref: { runId: string; taskId: string; attempt: number },
    outcome: string,
    endedAt: string,
    durationMs: number,
    error?: string
  ): void {
    this.db
      .prepare(
        `UPDATE task_attempts
            SET ended_at = @ended_at, duration_ms = @duration_ms, outcome = @outcome, error = @error
          WHERE run_id = @run_id AND task_id = @task_id AND attempt = @attempt`
      )
      .run({
        ended_at: endedAt, duration_ms: durationMs, outcome, error: error ?? null,
        run_id: ref.runId, task_id: ref.taskId, attempt: ref.attempt
      });
  }

  listAttempts(runId: string, taskId?: string): TaskAttemptRecord[] {
    const rows = (taskId === undefined
      ? this.db.prepare('SELECT * FROM task_attempts WHERE run_id = ? ORDER BY task_id, attempt').all(runId)
      : this.db.prepare('SELECT * FROM task_attempts WHERE run_id = ? AND task_id = ? ORDER BY attempt').all(runId, taskId)
    ) as any[];
    return rows.map((r) => ({
      runId: r.run_id, taskId: r.task_id, attempt: r.attempt, fence: r.fence,
      workerId: r.worker_id, startedAt: r.started_at, endedAt: r.ended_at ?? undefined,
      durationMs: r.duration_ms ?? undefined, outcome: r.outcome ?? undefined,
      error: r.error ?? undefined
    }));
  }

  /**
   * Phase F: bounded retention. The events table previously grew without limit --
   * 7,320 rows from a single 2,400-task workload in the audit.
   * Only events for runs that finished before the cutoff are removed, so a live
   * run's history is never truncated underneath it.
   */
  pruneBefore(cutoffIso: string): number {
    const info = this.db
      .prepare(
        `DELETE FROM events WHERE run_id IN (
           SELECT id FROM runs
            WHERE completed_at IS NOT NULL AND completed_at < @cutoff
              AND state IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT')
         )`
      )
      .run({ cutoff: cutoffIso });
    return info.changes;
  }
}
