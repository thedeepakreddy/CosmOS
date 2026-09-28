# AgentOS Wiring Map

## SDK to API
- \`AgentOSClient\` (src/sdk/client.ts) -> Fastify Routes (src/api/routes.ts)

## API to Engine
- Fastify Routes (src/api/routes.ts) -> \`Supervisor\` (src/engine/Supervisor.ts)

## Engine to DB
- \`Supervisor\` -> \`RunRepository\` / \`TaskRepository\` / \`EventRepository\` (src/db/repositories.ts)
- \`RunRepository\` -> \`getDb()\` (src/db/connection.ts) -> SQLite

## Engine Internals
- \`Supervisor\` -> \`DAGValidator\` (src/engine/DAGValidator.ts) (Called on startRun)
- \`Supervisor\` -> \`AgentExecutor\` (src/engine/Executor.ts) (Interface for running tasks)
