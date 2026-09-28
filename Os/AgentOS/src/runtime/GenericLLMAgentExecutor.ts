import { AgentExecutionContext, AgentExecutionResult, AgentExecutor } from '../engine/Executor';
import { AgentDefinition, AgentInstance, ExecutionBudget, Task } from '../domain/types';
import { AgentStore, UsageStore } from '../persistence/contracts';
import {
  ModelMessage, ModelProvider, ModelToolCall, MemoryProvider, ToolProvider, ToolSpec
} from '../providers/contracts';
import { metrics } from '../observability/metrics';

/**
 * Phase G: the generic agent runtime.
 *
 * The audit's finding was that NO executor existed outside `tests/` -- AgentOS
 * could orchestrate, but could not run an agent. It also found that
 * `AgentExecutor` was already exactly the right shape, which is why this is a
 * clean extension: the orchestration kernel is unchanged.
 *
 * AgentOS stays PROVIDER-NEUTRAL. This runs against the contracts in
 * ../providers/contracts and imports no vendor SDK; `lint:arch` enforces that.
 * An adapter for a specific model API belongs outside this package.
 *
 * What an agent is, here, is configuration: a definition (system prompt,
 * capabilities, tool/memory permissions, model requirements) plus a provider
 * set. Two agent types differ only by their rows in `agents`.
 */

export interface GenericAgentRuntimeOptions {
  model: ModelProvider;
  tools?: ToolProvider;
  memory?: MemoryProvider;
  agents: AgentStore;
  usage: UsageStore;
  /** Safety stop for the reason/act loop, independent of budgets. */
  maxIterations?: number;
  /** Resolves the budget for a run; budgets live on the run, not the agent. */
  budgetFor?: (runId: string) => ExecutionBudget | undefined;
}

export const DEFAULT_MAX_ITERATIONS = 12;

/** Raised when a declared budget stops the agent. */
export class BudgetExhaustedError extends Error {
  constructor(readonly budget: string, message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export class GenericLLMAgentExecutor implements AgentExecutor {
  private readonly maxIterations: number;

  constructor(private readonly options: GenericAgentRuntimeOptions) {
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  async execute(
    agent: AgentInstance,
    task: Task,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult> {
    // The instance pins an exact definition VERSION, so a redeploy mid-run
    // cannot silently change an agent's behaviour underneath it.
    const definition = this.options.agents.get(agent.definitionId, agent.version);
    if (!definition) {
      return { status: 'FAILED', error: `AGENT_DEFINITION_NOT_FOUND: ${agent.definitionId}@${agent.version}` };
    }

    const budget = this.options.budgetFor?.(context.runId);

    try {
      const output = await this.runLoop(definition, task, context, budget);
      return { status: 'SUCCEEDED', output };
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        return { status: 'FAILED', error: `BUDGET_EXCEEDED: ${e.budget} -- ${e.message}` };
      }
      if ((e as Error)?.name === 'AbortError' || context.signal.aborted) {
        return { status: 'FAILED', error: 'EXECUTION_ABORTED' };
      }
      return { status: 'FAILED', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async runLoop(
    definition: AgentDefinition,
    task: Task,
    context: AgentExecutionContext,
    budget: ExecutionBudget | undefined
  ): Promise<unknown> {
    const { model, tools, memory, usage } = this.options;

    // Tools are filtered by the definition's permissions, so an agent cannot
    // reach a tool it was not granted.
    const available: ToolSpec[] = tools
      ? await tools.list(definition.toolPermissions)
      : [];

    const messages: ModelMessage[] = [
      { role: 'system', content: this.systemPrompt(definition, context) },
      { role: 'user', content: this.taskPrompt(task) }
    ];

    // Optional recall, gated on the definition's memory permissions.
    if (memory && definition.memoryPermissions?.length) {
      const namespace = definition.memoryPermissions[0];
      const recalled = await memory.read(
        { runId: context.runId, agentInstanceId: context.agentInstanceId, namespace },
        task.id
      );
      if (recalled !== undefined) {
        messages.push({ role: 'user', content: `Relevant memory: ${JSON.stringify(recalled)}` });
      }
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (context.signal.aborted) throw new Error('EXECUTION_ABORTED');

      // Cost is only knowable AFTER a call, so the ceiling stops the NEXT one.
      if (usage.isCostExhausted(context.runId, budget?.maxCostUsd)) {
        throw new BudgetExhaustedError('maxCostUsd', `spend reached ${budget?.maxCostUsd}`);
      }
      // Atomic reserve: the limit is enforced inside the UPDATE, so the ceiling
      // holds across workers rather than being a read-then-act race.
      if (!usage.reserveModelCall(context.runId, budget?.maxModelCalls)) {
        throw new BudgetExhaustedError('maxModelCalls', `limit ${budget?.maxModelCalls} reached`);
      }

      const response = await model.complete({
        messages,
        tools: available.length ? available : undefined,
        model: definition.modelRequirements?.preferredModel,
        signal: context.signal
      });

      const recorded = usage.recordModelUsage(context.runId, response.usage, budget?.maxCostUsd);
      metrics.increment('agentos_model_calls_total', { provider: model.name });
      metrics.observe('agentos_model_tokens', response.usage.inputTokens + response.usage.outputTokens);

      if (response.finishReason === 'error') {
        throw new Error('MODEL_PROVIDER_ERROR');
      }

      if (response.finishReason === 'tool_calls' && response.toolCalls?.length) {
        messages.push({ role: 'assistant', content: response.content ?? '' });
        for (const call of response.toolCalls) {
          messages.push(await this.invokeTool(call, definition, context, budget));
        }
        // A cost ceiling breached by THIS call stops the loop before the next.
        if (!recorded.withinBudget) {
          throw new BudgetExhaustedError('maxCostUsd', `spend ${recorded.total.costUsd} exceeds ${budget?.maxCostUsd}`);
        }
        continue;
      }

      const output = { content: response.content ?? '', iterations: iteration + 1, usage: recorded.total };
      if (memory && definition.memoryPermissions?.length) {
        await memory.write(
          { runId: context.runId, agentInstanceId: context.agentInstanceId, namespace: definition.memoryPermissions[0] },
          task.id,
          output.content
        );
      }
      return output;
    }

    throw new Error(`MAX_ITERATIONS_EXCEEDED: ${this.maxIterations}`);
  }

  private async invokeTool(
    call: ModelToolCall,
    definition: AgentDefinition,
    context: AgentExecutionContext,
    budget: ExecutionBudget | undefined
  ): Promise<ModelMessage> {
    const { tools, usage } = this.options;

    if (!tools) {
      return { role: 'tool', toolCallId: call.id, name: call.name, content: 'ERROR: no tool provider configured' };
    }
    // Permissions are enforced here as well as at list() time, so a model that
    // invents a tool name cannot reach anything the agent was not granted.
    if (definition.toolPermissions && !definition.toolPermissions.includes(call.name)) {
      return { role: 'tool', toolCallId: call.id, name: call.name, content: `ERROR: tool '${call.name}' is not permitted for this agent` };
    }
    if (!usage.reserveToolCall(context.runId, budget?.maxToolCalls)) {
      throw new BudgetExhaustedError('maxToolCalls', `limit ${budget?.maxToolCalls} reached`);
    }

    metrics.increment('agentos_tool_calls_total', { tool: call.name });
    try {
      const result = await tools.invoke(call.name, call.arguments, {
        runId: context.runId,
        taskId: context.taskId,
        agentInstanceId: context.agentInstanceId,
        signal: context.signal
      });
      return { role: 'tool', toolCallId: call.id, name: call.name, content: result.content };
    } catch (e) {
      // A failing tool is reported back to the model rather than killing the
      // task: recovering from a bad call is the agent's job.
      return {
        role: 'tool', toolCallId: call.id, name: call.name,
        content: `ERROR: ${e instanceof Error ? e.message : String(e)}`
      };
    }
  }

  private systemPrompt(definition: AgentDefinition, context: AgentExecutionContext): string {
    return definition.systemPrompt ?? [
      `You are ${definition.name}, ${definition.role}.`,
      definition.description,
      definition.capabilities.length ? `Your capabilities: ${definition.capabilities.join(', ')}.` : '',
      `You are working on run ${context.runId}, task ${context.taskId}.`
    ].filter(Boolean).join('\n');
  }

  private taskPrompt(task: Task): string {
    const input = task.input === undefined ? '' : `\n\nInput:\n${JSON.stringify(task.input, null, 2)}`;
    return `Task: ${task.name}\n${task.description}${input}`;
  }
}
