npx tsx apps/server/src/index.ts > server.log 2>&1 &
SERVER_PID=$!
sleep 2

echo "--- GET /health ---"
curl -s http://127.0.0.1:3000/health

echo -e "\n--- GET /v1/executors ---"
curl -s http://127.0.0.1:3000/v1/executors

echo -e "\n--- GET /v1/tools ---"
curl -s http://127.0.0.1:3000/v1/tools

echo -e "\n--- GET /openapi.json ---"
curl -s http://127.0.0.1:3000/openapi.json | head -c 100

echo -e "\n--- 1. SUCCESSFUL EXECUTION ---"
# Need to use a tool that exists in production. Since TestExecutorAdapter is removed, only Echo is registered. Echo is blocked, so we can't do a successful execution unless we inject a test adapter.
# Ah! Production server has NO working adapters right now.
# "If no real executable adapter is configured, ToolOS should still start and truthfully report that no executable adapter is available."
# So a successful execution is impossible on the prod server right now!
