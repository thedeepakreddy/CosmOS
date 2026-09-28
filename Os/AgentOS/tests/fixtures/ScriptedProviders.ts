import {
  MemoryProvider, MemoryScope, ModelProvider, ModelRequest, ModelResponse,
  ToolInvocationContext, ToolProvider, ToolResult, ToolSpec
} from '../../src/providers/contracts';

/**
 * Scripted providers.
 *
 * AgentOS makes NO live model call anywhere in this repository. A scripted
 * provider proves the wiring, the contracts and the budget arithmetic exactly;
 * it proves nothing about what a real model does with these prompts. That
 * distinction is stated here rather than left for a reader to discover.
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly script: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const response = this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    return response;
  }

  get callCount(): number { return this.index; }
}

export const say = (content: string, usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }): ModelResponse =>
  ({ content, finishReason: 'stop', usage });

export const callTool = (
  name: string,
  args: Record<string, unknown> = {},
  usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }
): ModelResponse => ({
  content: '', finishReason: 'tool_calls', usage,
  toolCalls: [{ id: `call-${name}-${Math.random().toString(36).slice(2, 6)}`, name, arguments: args }]
});

export class ScriptedToolProvider implements ToolProvider {
  readonly name = 'scripted-tools';
  readonly invocations: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    private readonly handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
    private readonly specs: ToolSpec[] = Object.keys(handlers).map((n) => ({
      name: n, description: `scripted ${n}`, parameters: { type: 'object', properties: {} }
    }))
  ) {}

  async list(permitted?: string[]): Promise<ToolSpec[]> {
    return permitted ? this.specs.filter((s) => permitted.includes(s.name)) : this.specs;
  }

  async invoke(name: string, args: Record<string, unknown>, _ctx: ToolInvocationContext): Promise<ToolResult> {
    this.invocations.push({ name, args });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`no such tool: ${name}`);
    return { content: await handler(args) };
  }
}

export class InMemoryMemoryProvider implements MemoryProvider {
  readonly name = 'scripted-memory';
  private store = new Map<string, unknown>();

  private key(scope: MemoryScope, key: string): string {
    return `${scope.runId}|${scope.namespace}|${key}`;
  }
  async read(scope: MemoryScope, key: string): Promise<unknown | undefined> {
    return this.store.get(this.key(scope, key));
  }
  async write(scope: MemoryScope, key: string, value: unknown): Promise<void> {
    this.store.set(this.key(scope, key), value);
  }
  get size(): number { return this.store.size; }
}
