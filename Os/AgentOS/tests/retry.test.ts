import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/api/server';
import { AgentOSClient } from '../src/sdk/client';
import { TestAgentExecutor } from './fixtures/TestExecutor';
import path from 'path';
import os from 'os';
import { removeDb } from './helpers/testDb';
import { Task } from '../src/domain/types';
import { AgentExecutionContext } from '../src/engine/Executor';

class RetryTestExecutor extends TestAgentExecutor {
  public invocationCounts: Record<string, number> = {};

  async execute(agent: any, task: Task, context: AgentExecutionContext): Promise<{ status: 'SUCCEEDED' | 'FAILED', output?: any, error?: string }> {
    if (!this.invocationCounts[task.id]) {
      this.invocationCounts[task.id] = 0;
    }
    this.invocationCounts[task.id]++;
    const attempt = this.invocationCounts[task.id];

    if (task.name === 'FailOnce') {
      if (attempt === 1) return { status: 'FAILED', error: 'Transient error' };
      return { status: 'SUCCEEDED', output: 'Success' };
    }

    if (task.name === 'AlwaysFail') {
      return { status: 'FAILED', error: 'Permanent error' };
    }

    return super.execute(agent, task, context);
  }
}

describe('AgentOS Retry Policies', () => {
  let app: any;
  let client: AgentOSClient;
  let executor: RetryTestExecutor;
  const dbPath = path.join(os.tmpdir(), 'agentos-retry.db');

  beforeAll(async () => {
    process.env.DATABASE_URL = dbPath;
    executor = new RetryTestExecutor();
    app = await buildServer(executor);
    await app.listen({ port: 0 });
    client = new AgentOSClient(`http://localhost:${app.server.address().port}`);

    await client.createAgent({
      id: 'retry-agent', version: '1', name: 'Retry Agent', description: '', role: '', capabilities: []
    });
  });

  afterAll(async () => {
    await app.close();
    removeDb(dbPath);
  });

  const waitForRunTerminalState = async (runId: string) => {
    while (true) {
      const run = await client.getRun(runId);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) {
        return run;
      }
      await new Promise(r => setTimeout(r, 50));
    }
  };

  it('should retry on failure and eventually succeed', async () => {
    const run = await client.createRun({
      goal: 'Retry success test',
      taskGraph: {
        tasks: [
          { id: 'T1', name: 'FailOnce', description: '', agentDefinitionId: 'retry-agent', state: 'PENDING', retriesAllowed: 3 }
        ],
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);
    const finalRun = await waitForRunTerminalState(run.id);

    expect(finalRun.state).toBe('COMPLETED');
    expect(executor.invocationCounts['T1']).toBe(2); // Failed once, succeeded on second attempt
    
    const tasks = await client.getTasks(run.id);
    expect(tasks.tasks[0].state).toBe('SUCCEEDED');
    expect(tasks.tasks[0].retriesAttempted).toBe(1);
  });

  it('should not retry if retries are disabled', async () => {
    const run = await client.createRun({
      goal: 'Retry disabled test',
      taskGraph: {
        tasks: [
          { id: 'T2', name: 'FailOnce', description: '', agentDefinitionId: 'retry-agent', state: 'PENDING', retriesAllowed: 0 }
        ],
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);
    const finalRun = await waitForRunTerminalState(run.id);

    expect(finalRun.state).toBe('FAILED');
    expect(executor.invocationCounts['T2']).toBe(1); // Failed once, no retries
    
    const tasks = await client.getTasks(run.id);
    expect(tasks.tasks[0].state).toBe('FAILED');
    expect(tasks.tasks[0].retriesAttempted).toBe(0);
  });

  it('should exhaust retries and fail', async () => {
    const run = await client.createRun({
      goal: 'Retry exhaustion test',
      taskGraph: {
        tasks: [
          { id: 'T3', name: 'AlwaysFail', description: '', agentDefinitionId: 'retry-agent', state: 'PENDING', retriesAllowed: 2 }
        ],
        dependencies: []
      }
    } as any);

    await client.startRun(run.id);
    const finalRun = await waitForRunTerminalState(run.id);

    expect(finalRun.state).toBe('FAILED');
    expect(executor.invocationCounts['T3']).toBe(3); // 1 initial + 2 retries = 3 invocations
    
    const tasks = await client.getTasks(run.id);
    expect(tasks.tasks[0].state).toBe('FAILED');
    expect(tasks.tasks[0].retriesAttempted).toBe(2);
  });
});
