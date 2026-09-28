import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AgentMessage, MessageStore, SendMessageInput } from '../contracts';

function toMessage(row: any): AgentMessage {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    fromInstanceId: row.from_instance_id ?? undefined,
    fromTaskId: row.from_task_id ?? undefined,
    toTaskId: row.to_task_id ?? undefined,
    toAgentDefinitionId: row.to_agent_definition_id ?? undefined,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined
  };
}

/**
 * Phase H: agent messaging.
 *
 * The audit found `messages` created in v0.1 with ZERO code references -- schema
 * without a system. It is now run-scoped (matching the Phase B identity model),
 * sequenced like events so ordering and gaps are detectable, and attributable to
 * the sending agent INSTANCE rather than a bare id.
 */
export class SqliteMessageStore implements MessageStore {
  constructor(private db: Database) {}

  send(input: SendMessageInput): AgentMessage {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, run_id, seq, type, from_instance_id, from_task_id,
                             to_task_id, to_agent_definition_id, payload, created_at)
       VALUES (@id, @run_id, @seq, @type, @from_instance_id, @from_task_id,
               @to_task_id, @to_agent_definition_id, @payload, @created_at)`
    );
    const nextSeq = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE run_id = ?'
    );

    // Same atomic sequencing as the event store: the read of MAX(seq) and the
    // insert are one IMMEDIATE transaction, so two workers cannot be handed the
    // same number, and the UNIQUE index is the backstop.
    const tx = this.db.transaction((): AgentMessage => {
      const { next } = nextSeq.get(input.runId) as { next: number };
      const message: AgentMessage = {
        id: uuidv4(),
        runId: input.runId,
        seq: next,
        type: input.type,
        fromInstanceId: input.fromInstanceId,
        fromTaskId: input.fromTaskId,
        toTaskId: input.toTaskId,
        toAgentDefinitionId: input.toAgentDefinitionId,
        payload: input.payload,
        createdAt: new Date().toISOString()
      };
      insert.run({
        id: message.id, run_id: message.runId, seq: message.seq, type: message.type,
        from_instance_id: message.fromInstanceId ?? null,
        from_task_id: message.fromTaskId ?? null,
        to_task_id: message.toTaskId ?? null,
        to_agent_definition_id: message.toAgentDefinitionId ?? null,
        payload: JSON.stringify(message.payload),
        created_at: message.createdAt
      });
      return message;
    });
    return tx.immediate();
  }

  listByRun(runId: string, afterSeq = 0): AgentMessage[] {
    return (this.db
      .prepare('SELECT * FROM messages WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as any[]).map(toMessage);
  }

  /**
   * Messages addressed to a task: directly, to its agent definition, or broadcast.
   * A message never crosses a run boundary -- run_id is part of the key.
   */
  inboxFor(runId: string, taskId: string, agentDefinitionId?: string): AgentMessage[] {
    return (this.db
      .prepare(
        `SELECT * FROM messages
          WHERE run_id = @run_id
            AND (
                  to_task_id = @task_id
               OR (to_task_id IS NULL AND to_agent_definition_id = @agent_id)
               OR (to_task_id IS NULL AND to_agent_definition_id IS NULL)
            )
          ORDER BY seq`
      )
      .all({ run_id: runId, task_id: taskId, agent_id: agentDefinitionId ?? null }) as any[])
      .map(toMessage);
  }

  /** Mark delivery, once. Returns the number newly marked. */
  markDelivered(runId: string, ids: string[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      'UPDATE messages SET delivered_at = ? WHERE run_id = ? AND id = ? AND delivered_at IS NULL'
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((): number => {
      let changed = 0;
      for (const id of ids) changed += stmt.run(now, runId, id).changes;
      return changed;
    });
    return tx.immediate();
  }
}
