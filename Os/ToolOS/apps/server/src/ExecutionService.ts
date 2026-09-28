import { AuthorizationRequest, PolicyProvider, ToolExecutionRequest, ToolExecutionResult } from "../../../packages/contracts/src";
import { ToolRegistry } from "../../../packages/registry/src";
import { ToolRouter } from "../../../packages/router/src";
import { EventBus } from "../../../packages/observability/src";
import Ajv from "ajv";

export class ExecutionService {
  private ajv = new Ajv();

  constructor(
    private registry: ToolRegistry,
    private policy: PolicyProvider,
    private router: ToolRouter,
    private events: EventBus,
    private adapters: Map<string, any>
  ) {}

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const target = request.capability || request.toolId || "unknown";
    const authReq: AuthorizationRequest = {
      callerAppId: request.caller.appId,
      capabilityOrTool: target
    };

    this.events.emit({ type: "execution.requested", executionId: request.executionId, caller: request.caller.appId, request });

    // 1. Policy
    const auth = await this.policy.authorize(authReq);
    if (!auth.allowed) {
      this.events.emit({ type: "execution.denied", executionId: request.executionId, reason: auth.reason || "Denied by policy" });
      return this.failResult(request, "PERMISSION_DENIED", auth.reason || "Denied by policy");
    }
    this.events.emit({ type: "execution.authorized", executionId: request.executionId });

    // 2. Routing
    const toolDef = request.toolId ? this.router.selectExecutorForTool(request.toolId) : this.router.selectExecutorForCapability(request.capability!);
    if (!toolDef) {
      if (request.capability && !request.toolId) {
        this.events.emit({ type: "execution.failed", executionId: request.executionId, errorCategory: "CAPABILITY_NOT_FOUND" });
        return this.failResult(request, "CAPABILITY_NOT_FOUND", "No eligible healthy executor found for capability.");
      } else {
        this.events.emit({ type: "execution.failed", executionId: request.executionId, errorCategory: "TOOL_NOT_FOUND" });
        return this.failResult(request, "TOOL_NOT_FOUND", "No eligible healthy executor found for tool.");
      }
    }
    request.toolId = toolDef.id;

    // 3. Schema Validation
    if (toolDef.inputSchema && Object.keys(toolDef.inputSchema).length > 0) {
      try {
        const validate = this.ajv.compile(toolDef.inputSchema);
        if (!validate(request.args)) {
          this.events.emit({ type: "execution.failed", executionId: request.executionId, errorCategory: "SCHEMA_MISMATCH" });
          return this.failResult(request, "SCHEMA_MISMATCH", `Invalid arguments: ${this.ajv.errorsText(validate.errors)}`, toolDef.id, toolDef.executorId);
        }
      } catch (e: any) {
        // Fallback if schema compile fails for some reason
        console.warn("Schema compile failed", e.message);
      }
    }

    // 4. Execution
    const adapter = this.adapters.get(toolDef.executorId);
    if (!adapter) {
       return this.failResult(request, "EXECUTOR_UNAVAILABLE", "Executor missing.", toolDef.id, toolDef.executorId);
    }

    this.events.emit({ type: "execution.started", executionId: request.executionId, executorId: toolDef.executorId });

    const timeoutMs = (request.metadata?.timeoutMs as number) || toolDef.timeoutMs || 30000;
    
    return new Promise((resolve) => {
      const start = Date.now();
      let finished = false;
      
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        this.events.emit({ type: "execution.timed_out", executionId: request.executionId });
        resolve({
          executionId: request.executionId,
          status: "timed_out",
          error: { category: "TIMEOUT", message: "ToolOS stopped waiting" },
          executorId: toolDef!.executorId,
          toolId: toolDef!.id,
          startedAt: new Date(start).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          metadata: { cancellationSupported: false }
        });
      }, timeoutMs);

      adapter.execute(request).then((result: ToolExecutionResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (result.status === "succeeded") {
          this.events.emit({ type: "execution.succeeded", executionId: request.executionId, durationMs: result.durationMs });
        } else {
          this.events.emit({ type: "execution.failed", executionId: request.executionId, errorCategory: result.error?.category || "EXECUTION_FAILED" });
        }
        resolve(result);
      }).catch((err: any) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.events.emit({ type: "execution.failed", executionId: request.executionId, errorCategory: "EXECUTION_FAILED" });
        resolve(this.failResult(request, "EXECUTION_FAILED", typeof err === "object" && err !== null && "message" in err && err.message.includes("SECRET") ? "Internal execution error" : err.message, toolDef!.id, toolDef!.executorId));
      });
    });
  }

  private failResult(req: ToolExecutionRequest, category: any, message: string, toolId = "unknown", executorId = "none"): ToolExecutionResult {
    return {
      executionId: req.executionId,
      status: "failed",
      error: { category, message },
      executorId,
      toolId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0
    };
  }
}
