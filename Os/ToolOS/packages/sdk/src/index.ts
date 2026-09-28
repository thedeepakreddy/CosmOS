import { ToolDefinition, ToolExecutionRequest, ToolExecutionResult, ExecutorHealth } from "@toolos/contracts";

export interface ToolOSClientOptions {
  baseUrl: string;
}

export class ToolOSClient {
  constructor(private options: ToolOSClientOptions) {}

  async health(): Promise<{ status: string, version: string }> {
    const res = await fetch(`${this.options.baseUrl}/health`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    return res.json() as any;
  }

  async listExecutors(): Promise<{ executors: { id: string, health: ExecutorHealth }[] }> {
    const res = await fetch(`${this.options.baseUrl}/v1/executors`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    return res.json() as any;
  }

  async listTools(): Promise<{ tools: ToolDefinition[] }> {
    const res = await fetch(`${this.options.baseUrl}/v1/tools`);
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    return res.json() as any;
  }

  async execute(request: Partial<ToolExecutionRequest> & { caller: { appId: string } }): Promise<ToolExecutionResult> {
    const res = await fetch(`${this.options.baseUrl}/v1/executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    return res.json() as any;
  }
}
