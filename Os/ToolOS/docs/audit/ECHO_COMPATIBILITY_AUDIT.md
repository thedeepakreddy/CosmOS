# Echo Compatibility Audit

## Verified Facts

1. **Echo Repository Location**: The source of truth is located at `/Users/thedeepakreddy/J.A.R.V.I.S/Echo Mac`.
2. **Tool Registry**:
   - Path: `src/tools/registry.ts`
   - Symbols: `TOOLS: ToolDef[]`, `ToolDef`, `ToolOutput`.
   - Tool execution is defined via `handler: (args: any) => Promise<ToolOutput>`.
3. **Safety System**:
   - Path: `src/safety/gate.ts`
   - Symbols: `runGated()`, `decide()`, `GateDecision`.
   - All tool executions must be routed through `runGated()` to ensure risk assessment, approval, and snapshotting.
4. **Tool Schema Generator**:
   - Path: `src/_toolspec.ts`
   - Exists as a script to export the tools vocabulary as JSON schema to `deepakllm/tools.json`. This can be repurposed or used to fetch schemas deterministically.
5. **MCP Support**:
   - Path: `src/brain/mcp.ts`
   - Echo is an MCP *client*, not an MCP server. It connects to servers listed in `mcp.json` using `@modelcontextprotocol/sdk/client/index.js` and `StdioClientTransport`.
   - It runs in-process MCP discovery and execution `connectMcpServers()`.

## Rejected Assumptions

- **Assumption**: Echo runs its own MCP server that ToolOS can just connect to.
  - **Reality**: Echo only connects to external MCP servers via stdio. It does not expose its native tools via MCP.
- **Assumption**: ToolOS can bypass the Echo safety gate if it authenticates.
  - **Reality**: `runGated()` is strictly required for safety logging and user confirmation (as explicitly documented in `gate.ts`).
- **Assumption**: Echo provides a ready-made external API for tools.
  - **Reality**: No generalized REST/WS/RPC interface for tools exists. `src/frontier/remote.ts` only provides a specific UI/Voice web interface for remote phone control, not a programmatic execution boundary for tools.

## Current External Execution Options

- **None**. There is no externally reachable safe execution boundary for generalized tool execution in Echo. `ipcMain` is used for Electron internal IPC.

## Proposed Integration Boundary

Since there is no live execution boundary, the safest proposed integration for the future is to introduce a minimal HTTP/WebSocket/Unix-Socket bridge within Echo that:
1. Lists tools by utilizing `TOOLS` from `registry.ts`.
2. Executes tools exclusively by calling `runGated()` from `gate.ts`.
3. Returns normalized `ToolOutput` objects.

For now, the Echo execution adapter in ToolOS will report **BLOCKED** as per instructions.
