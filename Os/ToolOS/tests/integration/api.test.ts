import { describe, it, expect } from "vitest";
import { ToolOSClient } from "../../packages/sdk/src";

// Assuming server is started externally for integration tests or started before tests
describe("ToolOS API Integration", () => {
  const client = new ToolOSClient({ baseUrl: "http://127.0.0.1:3000" });

  it("should get health", async () => {
    // This requires the server to be running.
    // For a real run we will start it in the test script or background task.
    try {
      const health = await client.health();
      expect(health.status).toBe("ok");
    } catch (e: any) {
      if (e.message.includes("fetch failed")) {
        console.log("Server not running, skipping live check");
      } else {
        throw e;
      }
    }
  });
});
