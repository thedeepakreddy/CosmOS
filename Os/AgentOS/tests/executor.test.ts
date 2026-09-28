import { describe, it, expect } from 'vitest';
import { TestAgentExecutor } from './fixtures/TestExecutor';

describe('AgentExecutor Contract', () => {
  const executor = new TestAgentExecutor();
  
  it('should return a structured success result', async () => {
    const result = await executor.execute(
      { id: 'inst', definitionId: 'def', version: '1', runId: 'run', state: 'ACTIVE' },
      { id: 'task', runId: 'run', name: 'Task', description: '', agentDefinitionId: 'def', state: 'RUNNING', retriesAllowed: 0, retriesAttempted: 0 },
      { runId: 'run', taskId: 'task', attempt: 1, agentInstanceId: 'inst', signal: new AbortController().signal, inbox: [], send: () => undefined }
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('should return structured failure result without throwing', async () => {
    const result = await executor.execute(
      { id: 'inst', definitionId: 'def', version: '1', runId: 'run', state: 'ACTIVE' },
      { id: 'task', runId: 'run', name: 'Task', description: '', agentDefinitionId: 'def', state: 'RUNNING', retriesAllowed: 0, retriesAttempted: 0, input: { shouldFail: true } },
      { runId: 'run', taskId: 'task', attempt: 1, agentInstanceId: 'inst', signal: new AbortController().signal, inbox: [], send: () => undefined }
    );
    expect(result.status).toBe('FAILED');
    expect(result.error).toBeDefined();
  });
});
