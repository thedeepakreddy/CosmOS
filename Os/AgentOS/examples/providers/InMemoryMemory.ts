/**
 * The smallest possible MemoryProvider: a Map keyed by scope.
 *
 * Enough to show the contract working and the permission gate being honoured
 * (the runtime only reads and writes when the agent definition declares a
 * `memoryPermissions` namespace). Nothing here survives a restart -- a real
 * provider would be backed by MemoryOS or a vector store.
 */

import type { MemoryProvider, MemoryScope } from '../../src/providers/contracts';

const keyOf = (scope: MemoryScope, key: string) => `${scope.namespace}:${scope.runId}:${key}`;

export class InMemoryMemory implements MemoryProvider {
  readonly name = 'in-memory';
  private readonly store = new Map<string, unknown>();

  async read(scope: MemoryScope, key: string): Promise<unknown | undefined> {
    return this.store.get(keyOf(scope, key));
  }

  async write(scope: MemoryScope, key: string, value: unknown): Promise<void> {
    this.store.set(keyOf(scope, key), value);
  }

  async search(scope: MemoryScope, query: string, limit = 5): Promise<Array<{ key: string; value: unknown }>> {
    const needle = query.toLowerCase();
    const hits: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of this.store) {
      if (!key.startsWith(`${scope.namespace}:${scope.runId}:`)) continue;
      if (JSON.stringify(value).toLowerCase().includes(needle)) {
        hits.push({ key, value });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }
}
