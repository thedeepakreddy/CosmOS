import { ExecutorAdapter, ExecutorHealth, ToolDefinition, ToolExecutionRequest, ToolExecutionResult } from "@toolos/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class McpAdapter implements ExecutorAdapter {
  id: string;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  
  constructor(private serverName: string, private command: string, private args: string[] = [], private env: Record<string, string> = {}) {
    this.id = `mcp-${serverName}`;
  }

  async connect() {
    if (this.client) return;
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...(process.env as Record<string,string>), ...this.env }
    });
    this.client = new Client({ name: "ToolOS", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async health(): Promise<ExecutorHealth> {
    try {
      if (!this.client) await this.connect();
      return { status: "healthy" };
    } catch (e) {
      return { status: "unavailable", message: String(e) };
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.client) await this.connect();
    
    try {
      const response = await this.client!.listTools();
      return (response.tools || []).map(t => ({
        id: `mcp.${this.serverName}.${t.name}`,
        namespace: `mcp.${this.serverName}`,
        name: t.name,
        version: "1.0.0",
        description: t.description || "",
        capabilities: [`mcp.${this.serverName}.${t.name}`],
        inputSchema: t.inputSchema,
        executorId: this.id,
        readOnly: false // MCP doesn't natively expose this
      }));
    } catch (e) {
      console.error(`Failed to list MCP tools for ${this.serverName}`, e);
      return [];
    }
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (!this.client) await this.connect();
      
      // toolId format: mcp.serverName.toolName
      const toolName = request.toolId?.split(".").pop() || "";
      
      const result = await this.client!.callTool({
        name: toolName,
        arguments: request.args as any
      });
      
      return {
        executionId: request.executionId,
        status: result.isError ? "failed" : "succeeded",
        output: result,
        error: result.isError ? { category: "EXECUTION_FAILED", message: "MCP Execution Error" } : undefined,
        executorId: this.id,
        toolId: request.toolId || "unknown",
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start
      };
    } catch (e: any) {
      return {
        executionId: request.executionId,
        status: "failed",
        error: { category: "EXECUTION_FAILED", message: e.message },
        executorId: this.id,
        toolId: request.toolId || "unknown",
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start
      };
    }
  }
}
