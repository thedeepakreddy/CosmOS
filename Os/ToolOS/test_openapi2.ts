import { buildApp } from "./apps/server/src/app";
import { EchoAdapter } from "./packages/adapters/src/echo";

async function run() {
  const app = await buildApp({ adapters: [new EchoAdapter()] });
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  console.log(JSON.stringify(res.json(), null, 2));
}
run();
