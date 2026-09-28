# Wiring Map

## POST /v1/executions
```text
→ apps/server/src/app.ts (Fastify route '/v1/executions')
→ apps/server/src/ExecutionService.ts (execute method)
→ packages/observability/src/index.ts (emit 'execution.requested')
→ packages/policy/src/index.ts (DefaultPolicyProvider.authorize)
→ packages/router/src/index.ts (ToolRouter.selectExecutorForTool/Capability)
→ packages/registry/src/index.ts (ToolRegistry.getToolById / getExecutorHealth)
→ apps/server/src/ExecutionService.ts (AJV toolSchema validation)
→ packages/adapters/src/*/index.ts (ExecutorAdapter.execute with setTimeout Promise.race for timeouts)
→ packages/observability/src/index.ts (emit 'execution.succeeded' or 'execution.failed' or 'execution.timed_out')
→ apps/server/src/app.ts (return ToolExecutionResult)
```

## GET /v1/tools
```text
→ apps/server/src/app.ts (Fastify route '/v1/tools')
→ packages/registry/src/index.ts (ToolRegistry.listTools)
→ apps/server/src/app.ts (return response)
```

## GET /openapi.json
```text
→ apps/server/src/app.ts (Fastify route '/openapi.json')
→ @fastify/swagger plugin compilation
→ apps/server/src/app.ts (return JSON)
```

## Tool Discovery at Startup
```text
→ apps/server/src/server.ts (Production boot with actual adapters [EchoAdapter, etc])
→ apps/server/src/app.ts (buildApp initialization)
→ packages/adapters/src/*/index.ts (adapter.health() & adapter.listTools())
→ packages/registry/src/index.ts (ToolRegistry.registerExecutor & registerTool)
→ packages/observability/src/index.ts (emit 'tool.registered')
```
