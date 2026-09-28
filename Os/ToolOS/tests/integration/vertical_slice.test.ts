import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { TestExecutorAdapter } from "../fixtures/TestExecutorAdapter";

describe("Safe Full Vertical Slice", () => {
  let app: any;
  const adapter = new TestExecutorAdapter();

  beforeAll(async () => {
    app = await buildApp({ adapters: [adapter] });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should successfully execute a safe tool", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: {
        executionId: "exec-1",
        toolId: "test.echo",
        args: { hello: "world" },
        caller: { appId: "aira" }
      }
    });
    const json = res.json();
    expect(res.statusCode).toBe(200);
    expect(json.status).toBe("succeeded");
    expect(json.output).toEqual({ hello: "world" });
  });

  it("should enforce schema validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: {
        executionId: "exec-invalid",
        toolId: "test.echo",
        args: { wrongArg: 123 }, // missing 'hello'
        caller: { appId: "aira" }
      }
    });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.status).toBe("failed");
    expect(json.error.category).toBe("SCHEMA_MISMATCH");
  });

  it("should handle timeouts correctly", async () => {
    adapter.slowNext = true; // wait 100ms
    const res = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: {
        executionId: "exec-timeout",
        toolId: "test.echo",
        args: { hello: "world" },
        caller: { appId: "aira" },
        metadata: { timeoutMs: 10 } // strict timeout 10ms
      }
    });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.status).toBe("timed_out");
    expect(json.error.category).toBe("TIMEOUT");
    expect(json.metadata.cancellationSupported).toBe(false);
  });

  it("should prove executor failure does not return success", async () => {
    adapter.failNext = true;
    const res = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: {
        executionId: "exec-fail",
        toolId: "test.echo",
        args: { hello: "world" },
        caller: { appId: "aira" }
      }
    });
    const json = res.json();
    expect(res.statusCode).toBe(400);
    expect(json.status).toBe("failed");
    expect(json.error.category).toBe("EXECUTION_FAILED");
  });
  
  it("should have openapi available", async () => {
     const res = await app.inject({ method: "GET", url: "/openapi.json" });
     expect(res.statusCode).toBe(200);
     const json = res.json();
     expect(json.paths["/v1/executions"]).toBeDefined();
  });
});
