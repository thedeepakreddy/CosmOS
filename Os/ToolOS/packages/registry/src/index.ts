import { ToolDefinition, ExecutorHealth } from "@toolos/contracts";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private executors = new Map<string, { id: string, health: ExecutorHealth }>();

  public registerExecutor(id: string, health: ExecutorHealth) {
    this.executors.set(id, { id, health });
  }

  public getExecutorHealth(id: string): ExecutorHealth | undefined {
    return this.executors.get(id)?.health;
  }

  public registerTool(tool: ToolDefinition) {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with ID ${tool.id} is already registered.`);
    }
    this.tools.set(tool.id, tool);
  }

  public unregisterTool(id: string) {
    this.tools.delete(id);
  }

  public getToolById(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public findToolsByCapability(capability: string): ToolDefinition[] {
    return this.listTools().filter(t => t.capabilities.includes(capability));
  }

  public findToolsByNamespace(namespace: string): ToolDefinition[] {
    return this.listTools().filter(t => t.namespace === namespace);
  }

  public findToolsByExecutor(executorId: string): ToolDefinition[] {
    return this.listTools().filter(t => t.executorId === executorId);
  }
}
