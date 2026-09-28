import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "acceptance-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "acceptance_mcp_echo",
        description: "Echoes input via MCP",
        inputSchema: { type: "object", properties: { message: { type: "string" } } }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "acceptance_mcp_echo") {
    return { content: [{ type: "text", text: `MCP ECHO: ${request.params.arguments.message}` }] };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
