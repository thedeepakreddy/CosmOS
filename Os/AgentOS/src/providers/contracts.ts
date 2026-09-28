/**
 * Phase G: provider contracts.
 *
 * The audit recorded these as correctly ABSENT -- AgentOS imported no model or
 * tool vendor, and that neutrality is the reason a generic agent runtime was a
 * clean extension rather than a rewrite. These are interfaces only. AgentOS
 * still depends on no vendor SDK, and `lint:arch` forbids one.
 *
 * An adapter for a specific vendor belongs OUTSIDE this package.
 */

// ---- Model ------------------------------------------------------------------

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on a tool result message, naming the call it answers. */
  toolCallId?: string;
  name?: string;
}

/** A tool offered to the model, described in a vendor-neutral way. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * What a call consumed. `costUsd` is supplied by the adapter, because only it
 * knows the price of the model it called -- AgentOS never hardcodes pricing.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ToolSpec[];
  /** Hints from AgentDefinition.modelRequirements. The adapter decides how to honour them. */
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  /** Assistant text, when the model produced any. */
  content?: string;
  /** Tool calls the model wants performed before it continues. */
  toolCalls?: ModelToolCall[];
  /** Why generation stopped. 'tool_calls' means the loop should run them. */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage: ModelUsage;
}

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

// ---- Tools ------------------------------------------------------------------

export interface ToolInvocationContext {
  runId: string;
  taskId: string;
  agentInstanceId: string;
  signal: AbortSignal;
}

export interface ToolResult {
  /** Serialised back to the model as a tool message. */
  content: string;
  isError?: boolean;
}

export interface ToolProvider {
  readonly name: string;
  /** Tools this provider offers, optionally filtered by the agent's permissions. */
  list(permitted?: string[]): Promise<ToolSpec[]>;
  invoke(name: string, args: Record<string, unknown>, ctx: ToolInvocationContext): Promise<ToolResult>;
}

// ---- Memory -----------------------------------------------------------------

export interface MemoryScope {
  runId: string;
  agentInstanceId?: string;
  /** Namespace, matched against AgentDefinition.memoryPermissions. */
  namespace: string;
}

export interface MemoryProvider {
  readonly name: string;
  read(scope: MemoryScope, key: string): Promise<unknown | undefined>;
  write(scope: MemoryScope, key: string, value: unknown): Promise<void>;
  /** Optional recall. A provider without search simply omits it. */
  search?(scope: MemoryScope, query: string, limit?: number): Promise<Array<{ key: string; value: unknown }>>;
}

/** The provider set a generic agent runs against. All are optional. */
export interface Providers {
  model?: ModelProvider;
  tools?: ToolProvider;
  memory?: MemoryProvider;
}
