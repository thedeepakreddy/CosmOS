import { describe, it, expect } from "vitest";
import { McpAdapter } from "../../packages/adapters/src/mcp";

describe("Step 34 & 35: MCP Contract Test with Local Fixture", () => {
  it("should list tools and execute through real MCP protocol", async () => {
    // Configure adapter to point to our local node script fixture
    const adapter = new McpAdapter("test-mcp-server", "node", ["tests/fixtures/mcp_fixture.mjs"]);

    const health = await adapter.health();
    expect(health.status).toBe("healthy");

    const tools = await adapter.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0].id).toBe("mcp.test-mcp-server.acceptance_mcp_echo");
    expect(tools[0].executorId).toBe("mcp-test-mcp-server");

    const result = await adapter.execute({
      executionId: "mcp-1",
      toolId: "mcp.test-mcp-server.acceptance_mcp_echo",
      args: { message: "hello protocol" },
      caller: { appId: "test" }
    });

    expect(result.status).toBe("succeeded");
    expect((result.output as any).content[0].text).toBe("MCP ECHO: hello protocol");
    
    // Step 35: MCP Failure Test
    const failResult = await adapter.execute({
      executionId: "mcp-2",
      toolId: "mcp.test-mcp-server.acceptance_mcp_unknown",
      args: {},
      caller: { appId: "test" }
    });
    
    expect(failResult.status).toBe("failed");
    expect(failResult.error?.category).toBe("EXECUTION_FAILED");
  });
});
