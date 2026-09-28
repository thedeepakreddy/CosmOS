import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../packages/registry/src";
import { ToolDefinition } from "../../packages/contracts/src";

describe("ToolRegistry", () => {
  it("should register and list tools", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      id: "echo.click",
      namespace: "echo",
      name: "click",
      version: "1.0.0",
      description: "Click a button",
      capabilities: ["mouse.click"],
      inputSchema: {},
      executorId: "echo",
      readOnly: false
    };

    registry.registerTool(tool);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.getToolById("echo.click")).toEqual(tool);
  });

  it("should prevent duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      id: "echo.click",
      namespace: "echo",
      name: "click",
      version: "1.0.0",
      description: "Click a button",
      capabilities: ["mouse.click"],
      inputSchema: {},
      executorId: "echo",
      readOnly: false
    };

    registry.registerTool(tool);
    expect(() => registry.registerTool(tool)).toThrowError(/already registered/);
  });
});
