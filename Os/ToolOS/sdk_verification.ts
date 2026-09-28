import { ToolOSClient } from "./packages/sdk/src/index";
import { buildApp } from "./apps/server/src/app";
import { EchoAdapter } from "./packages/adapters/src/echo";
import fastify from "fastify";

async function run() {
  const app = await buildApp({ adapters: [new EchoAdapter()] });
  await app.listen({ port: 3001 });

  const client = new ToolOSClient({ baseUrl: "http://127.0.0.1:3001" });
  
  const { executors } = await client.listExecutors();
  console.log("Executors count:", executors.length);
  if (executors.length === 0 || executors[0].id === undefined) {
    throw new Error("SDK verification failed: executors empty or id missing");
  }

  const { tools } = await client.listTools();
  console.log("Tools count:", tools.length);
  if (tools.length === 0 || tools[0].id === undefined || tools[0].description === undefined || tools[0].executorId === undefined) {
    throw new Error("SDK verification failed: tools empty or fields missing");
  }

  console.log("SDK Verification PASSED.");
  await app.close();
}

run().catch(e => { console.error(e); process.exit(1); });
