import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AgentInstance, AgentInstanceState } from '../../domain/types';
import { AgentInstanceStore } from '../contracts';

function toInstance(row: any): AgentInstance {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    definitionId: row.definition_id,
    version: row.definition_version,
    state: row.state as AgentInstanceState,
    workerId: row.worker_id ?? undefined,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? undefined,
    terminatedAt: row.terminated_at ?? undefined,
    error: row.error ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined
  };
}

export class SqliteAgentInstanceStore implements AgentInstanceStore {
  constructor(private db: Database) {}

  create(input: Omit<AgentInstance, 'id' | 'state' | 'createdAt'>): AgentInstance {
    const instance: AgentInstance = {
      ...input,
      id: uuidv4(),
      state: 'CREATED',
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO agent_instances
           (id, run_id, task_id, definition_id, definition_version, state, worker_id, created_at, metadata)
         VALUES (@id, @run_id, @task_id, @definition_id, @definition_version, @state, @worker_id, @created_at, @metadata)`
      )
      .run({
        id: instance.id, run_id: instance.runId, task_id: instance.taskId ?? null,
        definition_id: instance.definitionId, definition_version: instance.version,
        state: instance.state, worker_id: instance.workerId ?? null,
        created_at: instance.createdAt,
        metadata: instance.metadata ? JSON.stringify(instance.metadata) : null
      });
    return instance;
  }

  /**
   * Guarded lifecycle transition. CREATED -> ACTIVE -> TERMINATED|FAILED, and no
   * other move. Returns false when the instance was not in an expected state,
   * so a stale caller cannot resurrect a terminated instance.
   */
  transition(id: string, from: AgentInstanceState[], to: AgentInstanceState, error?: string): boolean {
    const now = new Date().toISOString();
    const placeholders = from.map(() => '?').join(', ');
    const info = this.db
      .prepare(
        `UPDATE agent_instances
            SET state = ?,
                activated_at  = CASE WHEN ? = 'ACTIVE' THEN ? ELSE activated_at END,
                terminated_at = CASE WHEN ? IN ('TERMINATED','FAILED') THEN ? ELSE terminated_at END,
                error = COALESCE(?, error)
          WHERE id = ? AND state IN (${placeholders})`
      )
      .run(to, to, now, to, now, error ?? null, id, ...from);
    return info.changes === 1;
  }

  get(id: string): AgentInstance | null {
    const row = this.db.prepare('SELECT * FROM agent_instances WHERE id = ?').get(id);
    return row ? toInstance(row) : null;
  }

  listByRun(runId: string): AgentInstance[] {
    return (this.db
      .prepare('SELECT * FROM agent_instances WHERE run_id = ? ORDER BY created_at')
      .all(runId) as any[]).map(toInstance);
  }

  listByTask(runId: string, taskId: string): AgentInstance[] {
    return (this.db
      .prepare('SELECT * FROM agent_instances WHERE run_id = ? AND task_id = ? ORDER BY created_at')
      .all(runId, taskId) as any[]).map(toInstance);
  }
}
