import { getDb } from '../../db/connection';
import { Stores } from '../contracts';
import { SqliteAgentStore } from './SqliteAgentStore';
import { SqliteEventStore } from './SqliteEventStore';
import { SqliteRunStore } from './SqliteRunStore';
import { SqliteTaskStore } from './SqliteTaskStore';
import { SqliteAgentInstanceStore } from './SqliteAgentInstanceStore';
import { SqliteUsageStore } from './SqliteUsageStore';
import { SqliteMessageStore } from './SqliteMessageStore';
import { SqliteRateLimitStore } from './SqliteRateLimitStore';

export {
  SqliteAgentStore, SqliteEventStore, SqliteRunStore, SqliteTaskStore,
  SqliteAgentInstanceStore, SqliteUsageStore, SqliteMessageStore, SqliteRateLimitStore
};

/** Build the SQLite-backed store bundle against the process-wide connection. */
export function createSqliteStores(): Stores {
  const db = getDb();
  const tasks = new SqliteTaskStore(db);
  return {
    tasks,
    runs: new SqliteRunStore(db, tasks),
    agents: new SqliteAgentStore(db),
    events: new SqliteEventStore(db),
    instances: new SqliteAgentInstanceStore(db),
    usage: new SqliteUsageStore(db),
    messages: new SqliteMessageStore(db),
    rateLimits: new SqliteRateLimitStore(db)
  };
}
