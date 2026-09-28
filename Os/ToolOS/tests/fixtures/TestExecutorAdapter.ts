import { ExecutorAdapter, ExecutorHealth, ToolDefinition, ToolExecutionRequest, ToolExecutionResult } from "../../packages/contracts/src";

export class TestExecutorAdapter implements ExecutorAdapter {
  id = "test-executor";
  public failNext = false;
  public slowNext = false;

  async health(): Promise<ExecutorHealth> {
    return { status: "healthy" };
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        id: "test.echo",
        namespace: "test",
        name: "echo",
        version: "1.0.0",
        description: "Returns the input args",
        capabilities: ["test.echo"],
        inputSchema: { type: "object", properties: { hello: { type: "string" } }, required: ["hello"] },
        executorId: this.id,
        readOnly: true,
        timeoutMs: 50 // small for tests
      }
    ];
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const start = Date.now();
    if (this.failNext) {
      this.failNext = false;
      return {
        executionId: request.executionId,
        status: "failed",
        output: undefined,
        error: { category: "EXECUTION_FAILED", message: "Deliberate failure" },
        executorId: this.id,
        toolId: request.toolId || "unknown",
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start
      };
    }
    
    if (this.slowNext) {
      this.slowNext = false;
      await new Promise(r => setTimeout(r, 100)); // Will trigger timeout if limit is 50ms
    }
    
    return {
      executionId: request.executionId,
      status: "succeeded",
      output: request.args,
      executorId: this.id,
      toolId: request.toolId || "unknown",
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start
    };
  }
}
