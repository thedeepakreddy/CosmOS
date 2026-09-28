import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { ExecutorAdapter, ToolDefinition, ToolExecutionRequest, ToolExecutionResult, ExecutorHealth } from "../../packages/contracts/src";

class AcceptanceAdapter implements ExecutorAdapter {
  id = "acceptance-harness";
  public healthStatus: "healthy" | "unavailable" = "healthy";
  public invocations: Record<string, number> = {};

  async health(): Promise<ExecutorHealth> {
    return { status: this.healthStatus };
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      { id: "acceptance.echo", namespace: "acceptance", name: "echo", version: "1.0", description: "d", capabilities: ["acceptance.echo"], inputSchema: { type: "object" }, executorId: this.id, readOnly: true },
      { id: "acceptance.fail", namespace: "acceptance", name: "fail", version: "1.0", description: "d", capabilities: ["acceptance.fail"], inputSchema: { type: "object" }, executorId: this.id, readOnly: false },
      { id: "acceptance.slow", namespace: "acceptance", name: "slow", version: "1.0", description: "d", capabilities: ["acceptance.slow"], inputSchema: { type: "object" }, executorId: this.id, readOnly: true, timeoutMs: 10 },
      { id: "acceptance.secret", namespace: "acceptance", name: "secret", version: "1.0", description: "d", capabilities: ["acceptance.secret"], inputSchema: { type: "object" }, executorId: this.id, readOnly: true },
      { id: "acceptance.read", namespace: "acceptance", name: "read", version: "1.0", description: "d", capabilities: ["acceptance.read"], inputSchema: { type: "object" }, executorId: this.id, readOnly: true },
      { id: "echo.test", namespace: "echo", name: "test", version: "1.0", description: "d", capabilities: ["echo.test"], inputSchema: { type: "object" }, executorId: "echo-native", readOnly: false }
    ];
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const start = Date.now();
    this.invocations[request.toolId!] = (this.invocations[request.toolId!] || 0) + 1;
    if (request.toolId === "acceptance.fail") return { executionId: request.executionId, status: "failed", error: { category: "EXECUTION_FAILED", message: "fail" }, executorId: this.id, toolId: request.toolId, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 };
    if (request.toolId === "acceptance.secret") throw new Error("SECRET_TEST_TOKEN_123");
    if (request.toolId === "acceptance.slow") { await new Promise(r => setTimeout(r, 50)); return { executionId: request.executionId, status: "succeeded", output: {}, executorId: this.id, toolId: request.toolId, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 }; }
    return { executionId: request.executionId, status: "succeeded", output: request.args, executorId: this.id, toolId: request.toolId!, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 };
  }
}

class EchoMockAdapter implements ExecutorAdapter {
  id = "echo-native";
  async health(): Promise<ExecutorHealth> { return { status: "unavailable" }; }
  async listTools(): Promise<ToolDefinition[]> { return []; }
  async execute(req: ToolExecutionRequest): Promise<ToolExecutionResult> { throw new Error("Blocked"); }
}

describe("ToolOS Final Acceptance Tests", () => {
  let app: any;
  const adapter = new AcceptanceAdapter();
  const echoAdapter = new EchoMockAdapter();

  beforeAll(async () => {
    app = await buildApp({ adapters: [adapter, echoAdapter] });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("Step 9 & 22: Full Success", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/executions", payload: { executionId: "trace-123", toolId: "acceptance.echo", args: { message: "hello" }, caller: { appId: "researchos" } } });
    const json = res.json();
    expect(res.statusCode).toBe(200);
    expect(json.status).toBe("succeeded");
  });

  it("Step 11: Unknown Tool Test", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/executions", payload: { executionId: "unknown-tool", toolId: "acceptance.doesnotexist", args: {}, caller: { appId: "researchos" } } });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.error.category).toBe("TOOL_NOT_FOUND");
  });

  it("Step 12: Unknown Capability Test", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/executions", payload: { executionId: "unknown-cap", capability: "magic.flight", args: {}, caller: { appId: "researchos" } } });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.error.category).toBe("CAPABILITY_NOT_FOUND");
  });

  it("Step 12b: Echo Capability while bridge unavailable", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/executions", payload: { executionId: "echo-blocked", capability: "echo.test", args: {}, caller: { appId: "researchos" } } });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.error.category).toBe("CAPABILITY_NOT_FOUND"); // Because no healthy executor handles it
  });

  it("Step 29: Error Sanitization", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/executions", payload: { executionId: "secret", toolId: "acceptance.secret", args: {}, caller: { appId: "researchos" } } });
    expect(JSON.stringify(res.json())).not.toContain("SECRET_TEST_TOKEN_123");
  });
});
