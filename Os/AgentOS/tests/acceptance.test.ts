import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import { AgentOSClient } from '../src/sdk/client';
import path from 'path';
import os from 'os';
import { removeDb } from './helpers/testDb';

describe('AgentOS Acceptance Tests', () => {
  let app: any;
  let client: AgentOSClient;
  const dbPath = path.join(os.tmpdir(), 'agentos-acc.db');
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

  it('should run a standard DAG (A -> B,C -> D)', async () => {
    await client.createAgent({
      id: 'worker-v1',
      version: '1',
      name: 'Worker',
      description: 'Does work',
      role: 'Worker',
      capabilities: []
    });

    const run = await client.createRun({
      goal: 'Do D',
      taskGraph: {
        tasks: [
          { id: 'A', name: 'Task A', description: 'A', agentDefinitionId: 'worker-v1', state: 'PENDING' },
          { id: 'B', name: 'Task B', description: 'B', agentDefinitionId: 'worker-v1', state: 'PENDING' },
          { id: 'C', name: 'Task C', description: 'C', agentDefinitionId: 'worker-v1', state: 'PENDING' },
          { id: 'D', name: 'Task D', description: 'D', agentDefinitionId: 'worker-v1', state: 'PENDING' },
        ],
        dependencies: [
          { taskId: 'B', dependsOn: 'A' },
          { taskId: 'C', dependsOn: 'A' },
          { taskId: 'D', dependsOn: 'B' },
          { taskId: 'D', dependsOn: 'C' }
        ]
      }
    } as any);

    await client.startRun(run.id);

    // Wait for completion
    let currentRun = await client.getRun(run.id);
    while (currentRun.state === 'RUNNING') {
      await new Promise(r => setTimeout(r, 50));
      currentRun = await client.getRun(run.id);
    }

    expect(currentRun.state).toBe('COMPLETED');
    
    const { tasks } = await client.getTasks(run.id);
    expect(tasks.every(t => t.state === 'SUCCEEDED')).toBe(true);

    const taskA = tasks.find(t => t.id === 'A')!;
    const taskB = tasks.find(t => t.id === 'B')!;
    const taskC = tasks.find(t => t.id === 'C')!;
    const taskD = tasks.find(t => t.id === 'D')!;

    expect(new Date(taskB.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(taskA.completedAt!).getTime());
    expect(new Date(taskC.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(taskA.completedAt!).getTime());
    expect(new Date(taskD.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(taskB.completedAt!).getTime());
    expect(new Date(taskD.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(taskC.completedAt!).getTime());
  });

  it('should handle failure and skipping (A succeeds, B fails, C depends on B)', async () => {
    const run = await client.createRun({
      goal: 'Fail B',
      taskGraph: {
        tasks: [
          { id: 'A2', name: 'A', description: 'A', agentDefinitionId: 'worker-v1', state: 'PENDING' },
          { id: 'B2', name: 'B', description: 'B', agentDefinitionId: 'worker-v1', state: 'PENDING', input: { shouldFail: true } },
          { id: 'C2', name: 'C', description: 'C', agentDefinitionId: 'worker-v1', state: 'PENDING' },
        ],
        dependencies: [
          { taskId: 'C2', dependsOn: 'B2' }
        ]
      }
    } as any);

    await client.startRun(run.id);

    let currentRun = await client.getRun(run.id);
    while (currentRun.state === 'RUNNING') {
      await new Promise(r => setTimeout(r, 50));
      currentRun = await client.getRun(run.id);
    }

    expect(currentRun.state).toBe('FAILED');
    expect(currentRun.error).toBe('TASK_FAILED');

    const { tasks } = await client.getTasks(run.id);
    expect(tasks.find(t => t.id === 'B2')?.state).toBe('FAILED');
    expect(tasks.find(t => t.id === 'C2')?.state).toBe('SKIPPED');
  });

  it('should timeout a slow task', async () => {
    const run = await client.createRun({
      goal: 'Timeout task',
      taskGraph: {
        tasks: [
          { 
            id: 'T1', name: 'T1', description: 'T1', agentDefinitionId: 'worker-v1', state: 'PENDING',
            timeoutMs: 50,
            input: { delayMs: 200 }
          }
        ],
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);

    let currentRun = await client.getRun(run.id);
    while (currentRun.state === 'RUNNING') {
      await new Promise(r => setTimeout(r, 50));
      currentRun = await client.getRun(run.id);
    }

    expect(currentRun.state).toBe('FAILED');
    
    const { tasks } = await client.getTasks(run.id);
    expect(tasks.find(t => t.id === 'T1')?.state).toBe('TIMED_OUT');
  });
});
