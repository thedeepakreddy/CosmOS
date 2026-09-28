import { ToolRegistry } from './packages/registry/src/index';
import { EchoAdapter } from './packages/adapters/src/echo/index';
const r = new ToolRegistry();
const a = new EchoAdapter();
a.listTools().then(tools => {
  r.registerExecutor(a.id, {status: "healthy"});
  tools.forEach(t => r.registerTool(t));
  console.log("ListTools stringify:", JSON.stringify(r.listTools()).substring(0, 150));
  console.log("Executors stringify:", JSON.stringify([{ id: a.id, health: r.getExecutorHealth(a.id) }]));
});
