import { AgentExecutor, AgentInstance, Task, AgentExecutionContext, AgentExecutionResult } from '../../src/engine/Executor';

export class TestAgentExecutor implements AgentExecutor {
  async execute(agent: AgentInstance, task: Task, _context: AgentExecutionContext): Promise<AgentExecutionResult> {
    const input = task.input as any;
    
    if (input?.delayMs) {
      await new Promise(resolve => setTimeout(resolve, input.delayMs));
    }

    if (input?.shouldFail) {
      return { status: 'FAILED', error: 'Intentional failure for testing' };
    }

    return {
      status: 'SUCCEEDED',
      output: { result: `Task ${task.name} executed by ${agent.id}` }
    };
  }
}
