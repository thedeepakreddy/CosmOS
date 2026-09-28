import { describe, it, expect } from "vitest";
import { EchoAdapter } from "../../packages/adapters/src/echo";
import { ExecutorAdapter } from "../../packages/contracts/src";

function runAdapterContractTests(adapterName: string, createAdapter: () => ExecutorAdapter, expectedToFailExecution = false) {
  describe(`Adapter Contract: ${adapterName}`, () => {
    it("should have a valid identity and health", async () => {
      const adapter = createAdapter();
      expect(adapter.id).toBeTruthy();
      const health = await adapter.health();
      expect(["healthy", "degraded", "unavailable", "unknown"]).toContain(health.status);
    });

    it("should list tools successfully", async () => {
      const adapter = createAdapter();
      const tools = await adapter.listTools();
      expect(Array.isArray(tools)).toBe(true);
      for (const t of tools) {
        expect(t.id).toBeTruthy();
        expect(t.executorId).toBe(adapter.id);
      }
    });

    it("should behave correctly on execution", async () => {
      const adapter = createAdapter();
      const tools = await adapter.listTools();
      if (tools.length === 0) return;
      
      const req = {
        executionId: "test-req",
        toolId: tools[0].id,
        args: {},
        caller: { appId: "test" }
      };

      const res = await adapter.execute(req);
      expect(res.executionId).toBe("test-req");
      expect(res.executorId).toBe(adapter.id);
      
      if (expectedToFailExecution) {
        expect(res.status).toBe("failed");
        expect(res.error).toBeTruthy();
      }
    });
  });
}

runAdapterContractTests("EchoAdapter", () => new EchoAdapter(), true);
