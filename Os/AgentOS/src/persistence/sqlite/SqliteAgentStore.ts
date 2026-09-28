import type { Database } from 'better-sqlite3';
import { AgentDefinition } from '../../domain/types';
import { AgentStore } from '../contracts';

function toAgent(row: any): AgentDefinition {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    role: row.role,
    capabilities: JSON.parse(row.capabilities),
    modelRequirements: row.model_requirements ? JSON.parse(row.model_requirements) : undefined,
    toolPermissions: row.tool_permissions ? JSON.parse(row.tool_permissions) : undefined,
    memoryPermissions: row.memory_permissions ? JSON.parse(row.memory_permissions) : undefined,
    maxConcurrency: row.max_concurrency ?? undefined,
    defaultTimeoutMs: row.default_timeout_ms ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    systemPrompt: row.system_prompt ?? undefined
  };
}

export class SqliteAgentStore implements AgentStore {
  constructor(private db: Database) {}

  /**
   * Register a definition at a specific version.
   *
   * Phase G: keyed by (id, version), so versions COEXIST. v0.1 upserted on id
   * alone, which meant registering v2 silently destroyed v1 and made `version` a
   * decorative string. Re-registering the SAME version still updates in place,
   * which keeps development ergonomic.
   */
  save(agent: AgentDefinition): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, version, name, description, role, capabilities, model_requirements,
                             tool_permissions, memory_permissions, max_concurrency, default_timeout_ms,
                             metadata, system_prompt)
         VALUES (@id, @version, @name, @description, @role, @capabilities, @model_requirements,
                 @tool_permissions, @memory_permissions, @max_concurrency, @default_timeout_ms,
                 @metadata, @system_prompt)
         ON CONFLICT(id, version) DO UPDATE SET
           name=excluded.name, description=excluded.description, role=excluded.role,
           capabilities=excluded.capabilities, model_requirements=excluded.model_requirements,
           tool_permissions=excluded.tool_permissions, memory_permissions=excluded.memory_permissions,
           max_concurrency=excluded.max_concurrency, default_timeout_ms=excluded.default_timeout_ms,
           metadata=excluded.metadata, system_prompt=excluded.system_prompt`
      )
      .run({
        id: agent.id, version: agent.version, name: agent.name,
        description: agent.description, role: agent.role,
        capabilities: JSON.stringify(agent.capabilities),
        model_requirements: agent.modelRequirements ? JSON.stringify(agent.modelRequirements) : null,
        tool_permissions: agent.toolPermissions ? JSON.stringify(agent.toolPermissions) : null,
        memory_permissions: agent.memoryPermissions ? JSON.stringify(agent.memoryPermissions) : null,
        max_concurrency: agent.maxConcurrency ?? null,
        default_timeout_ms: agent.defaultTimeoutMs ?? null,
        metadata: agent.metadata ? JSON.stringify(agent.metadata) : null,
        system_prompt: agent.systemPrompt ?? null
      });
  }

  /** Omitting `version` returns the newest registered version. */
  get(id: string, version?: string): AgentDefinition | null {
    const row = version === undefined
      ? this.db.prepare('SELECT * FROM agents WHERE id = ? ORDER BY created_at DESC, version DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT * FROM agents WHERE id = ? AND version = ?').get(id, version);
    return row ? toAgent(row) : null;
  }

  listVersions(id: string): AgentDefinition[] {
    return (this.db
      .prepare('SELECT * FROM agents WHERE id = ? ORDER BY created_at, version')
      .all(id) as any[]).map(toAgent);
  }

  /**
   * Phase G: capability-based routing.
   *
   * `capabilities[]` existed on AgentDefinition from v0.1 and nothing ever read
   * it. Returns the newest version of each definition covering ALL required
   * capabilities.
   */
  findByCapabilities(required: string[]): AgentDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY id, created_at DESC, version DESC')
      .all() as any[];
    const newestPerId = new Map<string, AgentDefinition>();
    for (const row of rows) {
      if (!newestPerId.has(row.id)) newestPerId.set(row.id, toAgent(row));
    }
    return [...newestPerId.values()].filter((agent) =>
      required.every((cap) => agent.capabilities.includes(cap))
    );
  }
}
