/**
 * Wires Phase H messaging into the Phase G agent runtime.
 *
 * WHY THIS EXISTS: `GenericLLMAgentExecutor` never reads `context.inbox` and
 * never calls `context.send`. The Supervisor delivers an inbox and offers
 * `send`, but the generic runtime ignores both -- so out of the box, agent B
 * cannot see what agent A produced. That is a real gap in the runtime, not
 * something this demo invented.
 *
 * This decorator closes it without touching the kernel:
 *   1. fold delivered HANDOFF payloads into the task input, so they reach the
 *      model as context;
 *   2. broadcast this task's output as a HANDOFF when it succeeds, so whatever
 *      runs next receives it.
 *
 * Because it is a decorator over `AgentExecutor`, it composes with any
 * executor, not just the generic one.
 */

import type { AgentExecutor, AgentExecutionContext, AgentExecutionResult } from '../src/engine/Executor';
import type { AgentInstance, Task } from '../src/domain/types';

export class HandoffExecutor implements AgentExecutor {
  constructor(private readonly inner: AgentExecutor) {}

  async execute(
    agent: AgentInstance,
    task: Task,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult> {
    const handoffs = context.inbox
      .filter((m) => m.type === 'HANDOFF' || m.type === 'RESULT')
      .map((m) => m.payload);

    // The task the inner executor sees carries upstream context. The ORIGINAL
    // row is untouched -- this is a per-attempt view, not a persisted edit.
    const augmented: Task = handoffs.length
      ? { ...task, input: { ...(task.input as object ?? {}), upstream: handoffs } }
      : task;

    const result = await this.inner.execute(agent, augmented, context);

    if (result.status === 'SUCCEEDED' && result.output !== undefined) {
      // Broadcast: any later task in this run picks it up from its inbox.
      // Addressing a specific task would need the graph, which the executor
      // deliberately cannot see.
      context.send({
        type: 'HANDOFF',
        payload: {
          fromTaskId: task.id,
          fromAgent: `${agent.definitionId}@${agent.version}`,
          output: result.output
        }
      });
    }

    return result;
  }
}
