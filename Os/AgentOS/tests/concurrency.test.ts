import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { AgentOSClient } from '../src/sdk/client';
import path from 'path';
import os from 'os';
import { removeDb } from './helpers/testDb';

describe('AgentOS Concurrency Limits', () => {
  let app: any;
  let client: AgentOSClient;
  const dbPath = path.join(os.tmpdir(), 'agentos-conc.db');
  process.env.DATABASE_URL = dbPath;

  beforeAll(async () => {
    removeDb(dbPath);
    app = await buildServer(new TestAgentExecutor());
    await app.listen({ port: 0 });
    client = new AgentOSClient(`http://localhost:${app.server.address().port}`);
  });

  afterAll(async () => {
    await app.close();
    removeDb(dbPath);
  });

  it('should bound concurrency to maxAgents budget', async () => {
    await client.createAgent({
      id: 'worker-v2', version: '1', name: 'Worker', description: '', role: 'Worker', capabilities: []
    });

    // We'll create 5 tasks with no dependencies, maxAgents = 2.
    // They will all take 200ms.
    // At any given time, no more than 2 should be RUNNING.
    const run = await client.createRun({
      goal: 'Concurrency',
      budget: { maxAgents: 2 },
      taskGraph: {
        tasks: Array.from({ length: 5 }, (_, i) => ({
          id: `T${i}`, name: `T${i}`, description: '', agentDefinitionId: 'worker-v2', state: 'PENDING',
          input: { delayMs: 200 }
        })),
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);

    // Sample the running count over time
    let maxRunning = 0;
    
    let currentRun = await client.getRun(run.id);
    while (currentRun.state === 'RUNNING') {
      const { tasks } = await client.getTasks(run.id);
      const runningCount = tasks.filter(t => t.state === 'RUNNING').length;
      if (runningCount > maxRunning) maxRunning = runningCount;
      
      await new Promise(r => setTimeout(r, 30));
      currentRun = await client.getRun(run.id);
    }
    
    expect(currentRun.state).toBe('COMPLETED');
    expect(maxRunning).toBe(2);
  });
});
