# Echo Bridge Requirements

## Why the Bridge is Required
ToolOS must execute Echo's native tools (e.g. mouse control, screenshots) to utilize macOS capabilities. However, ToolOS is an external process and Echo does not expose a generalized API to invoke tools safely from outside its own process context. 

## Evidence No Safe Interface Exists
An audit of `/Users/thedeepakreddy/J.A.R.V.I.S/Echo Mac/src` confirms:
1. `src/brain/mcp.ts` is an MCP *client* (StdioClientTransport), not a server. It connects to external servers rather than exposing Echo.
2. `src/tools/registry.ts` exposes `TOOLS` in-memory.
3. `src/frontier/remote.ts` opens an HTTP server (`server.listen(port)`) strictly for a remote phone-control interface (`/mouse`, `/command`, `/confirm`, `/events`), taking high-level UI inputs rather than programmatic tool invocations.
4. No other REST/RPC endpoints exist for general-purpose tool execution.

## Echo Files Requiring Changes
To support ToolOS, Echo would need changes. The minimal footprint is:
- **NEW**: `src/api/toolos-bridge.ts` (or `mcp-server.ts`)
- **MODIFIED**: `src/main.ts` (to initialize the bridge on startup)

## Minimal Proposed Interface
An HTTP or Unix Socket server in Echo exposing:
- `GET /bridge/v1/tools` -> returns `ToolDef[]` (mapped to JSON schema)
- `POST /bridge/v1/execute` -> invokes `runGated(tool, args, ctx)`
- `GET /bridge/v1/health` -> returns server health

Alternatively, Echo could expose a standard **MCP Server** over SSE.

## Expected Request/Response Schema
**Request to `/execute`**:
```json
{
  "tool": "click",
  "args": { "x": 100, "y": 200 }
}
```

**Response**:
```json
{
  "status": "success",
  "text": "Clicked at 100,200",
  "durationMs": 150
}
```

## How It Preserves runGated()
The bridge must strictly import `runGated` from `src/safety/gate.ts` and NEVER call `tool.handler()` directly. The bridge acts as a transparent proxy for the remote caller into `runGated()`, ensuring risk calculation and confirmations remain entirely controlled by Echo.

## Security Implications
- **Authentication**: The bridge must verify ToolOS (e.g., via shared secret, local socket permissions, or mTLS). Otherwise, any local application could request risky tools.
- **Risk Override**: ToolOS policy layer cannot override Echo's denial.

## Test Plan
1. Send `GET /tools` -> Verify response matches `registry.ts`.
2. Send `POST /execute` for a safe read-only tool (`get_mouse_position`) -> Verify successful execution and correct output.
3. Send `POST /execute` for a risky tool -> Verify Echo displays its native confirmation prompt and returns the result (success or denial based on user action).

## Smallest Possible Echo-Side Patch
```typescript
import { createServer } from "node:http";
import { TOOLS } from "../tools/registry.js";
import { runGated } from "../safety/gate.js";
import { appRoot } from "../utils/appPath.js"; // etc

export function startBridge(port = 7788, secretToken: string) {
  createServer(async (req, res) => {
    // 1. Verify Auth Header
    // 2. Handle /tools -> JSON.stringify(TOOLS)
    // 3. Handle /execute -> read body, find tool in TOOLS, call runGated(tool, args, { workingDir: appRoot() })
  }).listen(port, "127.0.0.1");
}
```

**STATUS**: ToolOS live execution of Echo is marked **BLOCKED** until this or a similar bridge is approved and merged into Echo.
