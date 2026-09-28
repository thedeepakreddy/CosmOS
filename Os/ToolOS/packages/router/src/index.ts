import { ToolRegistry } from "@toolos/registry";
import { ToolDefinition } from "@toolos/contracts";

export class ToolRouter {
  constructor(private registry: ToolRegistry) {}

  public selectExecutorForTool(toolId: string): ToolDefinition | null {
    const tool = this.registry.getToolById(toolId);
    if (!tool) return null;

    const health = this.registry.getExecutorHealth(tool.executorId);
    if (health?.status !== "healthy") {
      // For v1, we require the exact executor to be healthy.
      return null;
    }
    return tool;
  }

  public selectExecutorForCapability(capability: string): ToolDefinition | null {
    const tools = this.registry.findToolsByCapability(capability);
    if (tools.length === 0) return null;

    // Filter by healthy executors
    const healthyTools = tools.filter(t => {
      const health = this.registry.getExecutorHealth(t.executorId);
      return health?.status === "healthy";
    });

    if (healthyTools.length === 0) return null;

    // V1 routing strategy: just pick the first healthy tool
    return healthyTools[0];
  }
}
