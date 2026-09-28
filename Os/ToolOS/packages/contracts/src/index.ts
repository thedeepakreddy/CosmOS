export interface ToolDefinition {
  id: string;
  namespace: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  inputSchema: any;
  outputSchema?: any;
  executorId: string;
  readOnly: boolean;
  idempotent?: boolean;
  platforms?: string[];
  tags?: string[];
  riskHint?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutorHealth {
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  message?: string;
}

export interface ToolExecutionRequest {
  executionId: string;
  toolId?: string;
  capability?: string;
  args: unknown;
  caller: {
    appId: string;
    agentId?: string;
    userId?: string;
  };
  context?: {
    sessionId?: string;
    requestId?: string;
  };
  deadline?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionError {
  category: "TOOL_NOT_FOUND" | "CAPABILITY_NOT_FOUND" | "EXECUTOR_UNAVAILABLE" | "INVALID_ARGUMENTS" | "PERMISSION_DENIED" | "DOWNSTREAM_DENIED" | "TIMEOUT" | "CANCELLED" | "EXECUTION_FAILED" | "SCHEMA_MISMATCH" | "PROTOCOL_ERROR";
  message: string;
}

export interface ToolExecutionResult {
  executionId: string;
  status: "succeeded" | "failed" | "denied" | "timed_out" | "cancelled";
  output?: unknown;
  error?: ToolExecutionError;
  executorId: string;
  toolId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutorAdapter {
  id: string;
  health(): Promise<ExecutorHealth>;
  listTools(): Promise<ToolDefinition[]>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

export interface AuthorizationRequest {
  callerAppId: string;
  capabilityOrTool: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

export interface PolicyProvider {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
