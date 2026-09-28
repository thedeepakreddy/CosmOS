import { ExecutorAdapter, ExecutorHealth, ToolDefinition, ToolExecutionRequest, ToolExecutionResult } from "@toolos/contracts";
import * as fs from "node:fs";
import * as path from "node:path";

export class EchoAdapter implements ExecutorAdapter {
  id = "echo-native";
  private echoPath = "/Users/thedeepakreddy/J.A.R.V.I.S/Echo Mac";
  
  async health(): Promise<ExecutorHealth> {
    // Echo live external execution is BLOCKED. 
    // We cannot reach the executor via HTTP/WS, so it's unavailable for external execution.
    return { status: "unavailable", message: "BLOCKED: Echo live external execution boundary not present." };
  }

  async listTools(): Promise<ToolDefinition[]> {
    const specPath = path.join(this.echoPath, "deepakllm", "tools.json");
    if (!fs.existsSync(specPath)) {
      return [];
    }

    try {
      const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
      return spec.tools.map((t: any) => ({
        id: `echo.${t.name}`,
        namespace: "echo",
        name: t.name,
        version: "1.0.0",
        description: t.description,
        capabilities: [`echo.${t.name}`], // Echo tools natively map to their own capability for now
        inputSchema: t.parameters,
        executorId: this.id,
        readOnly: !!t.readOnly
      }));
    } catch (e) {
      console.error("Failed to load Echo toolspec", e);
      return [];
    }
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    // Return BLOCKED as per instruction for live Echo execution
    return {
      executionId: request.executionId,
      status: "failed",
      error: {
        category: "EXECUTOR_UNAVAILABLE",
        message: "BLOCKED: Echo live external execution boundary not present. Cannot execute Echo tools externally."
      },
      executorId: this.id,
      toolId: request.toolId || "unknown",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0
    };
  }
}
