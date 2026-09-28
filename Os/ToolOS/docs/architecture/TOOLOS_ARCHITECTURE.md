# ToolOS Architecture

## Core Purpose
ToolOS is an independent reusable platform that serves as a shared capability control plane for AI systems. It connects clients (Echo, Aira, ResearchOS) to tool executors (Echo, MCP Servers) enforcing unified schema, authorization, routing, and observability.

## Components and Module Boundaries

- **`packages/contracts`**: Pure interfaces and types (ToolDefinition, ExecutorAdapter, AuthorizationDecision, ToolExecutionResult). No dependencies.
- **`packages/registry`**: In-memory registry for capabilities, tools, and executors. Handles deterministic discovery and namespace collision prevention.
- **`packages/policy`**: Middleware for evaluating whether a caller (e.g. Aira vs ResearchOS) is allowed to invoke a capability.
- **`packages/router`**: Selects the appropriate executor for a capability request based on health, policy, and configuration.
- **`packages/adapters`**: Translations between ToolOS common contracts and external runtimes (EchoAdapter, McpAdapter).
- **`packages/observability`**: Event bus, tracing, and structured logging of tool executions.
- **`packages/sdk`**: TypeScript client SDK.
- **`apps/server`**: Fastify-based HTTP API server orchestrating the packages.

## Data Flow
1. **Registration**: Adapters poll or subscribe to downstream systems (Echo toolspec, MCP `listTools`). They map these to `ToolDefinition` and push them into `packages/registry`.
2. **Execution Request**: Caller sends `POST /v1/executions` containing caller identity, requested `toolId` or `capability`, and arguments.
3. **Response**: Execution outcome mapped to `ToolExecutionResult`, preserving executor-native information when useful.

## Execution Flow
```text
Client Application (e.g., Aira, ResearchOS)
    │
    ▼
ToolOS API Server (apps/server)
    │
    ├── identify requested capability
    ├── authorize caller via PolicyProvider
    ├── discover eligible tools via Registry
    ├── select healthy executor via Router
    ├── validate arguments against schema
    ├── execute through Adapter (e.g., McpAdapter, EchoToolAdapter)
    ├── preserve downstream security (e.g., Echo's runGated)
    ├── normalize result to ToolExecutionResult
    ├── emit audit event
    └── return result
```

## Trust Boundaries & Security
- **ToolOS Policy (Application-Level)**: Authorizes whether the client is allowed to request a capability.
- **Executor Policy (Downstream)**: Authorizes whether the action can actually happen. ToolOS **never overrides** executor safety (e.g., Echo's `runGated()`).
- **Caller Identity**: Callers must authenticate. ToolOS assumes callers are untrusted.
- **Input Validation**: All execution arguments are validated against JSON schema definitions before routing.

## Adapter Boundaries
Adapters implement the `ExecutorAdapter` interface:
```typescript
interface ExecutorAdapter {
  id: string;
  health(): Promise<ExecutorHealth>;
  listTools(): Promise<ToolDefinition[]>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
```
Adapters are strictly translation layers. They contain NO domain logic, NO tool implementations, and NO duplicate safety systems.

## Failure Behavior
- **Explicit Typed Errors**: Failures are returned as explicit error categories (`TOOL_NOT_FOUND`, `PERMISSION_DENIED`, `TIMEOUT`, `EXECUTION_FAILED`), never masked as a "success: true" response with an error string.
- **Timeouts**: ToolOS enforces execution deadlines.
- **Retries**: Side-effecting operations are strictly prohibited from auto-retrying. Only `readOnly + idempotent` capabilities may be retried.
- **Graceful Degradation**: If an executor goes offline, the `registry` reflects the degraded capability, preventing hung requests.

## Deliberately NOT in ToolOS
- Tool implementations (mouse control, screenshots, OCR)
- User interface (Echo UI)
- The LLM integration/model adapters (Claude/Gemini/Ollama)
- Native application automation
- Downstream risk calculation and snapshots (Echo owns these)
- Distributed systems complexities (no Kafka, Kubernetes, or complex DBs for V1)
