/**
 * Health and capability reporting.
 *
 * `/health` answers "can this process do its job?", and answers it honestly:
 * a deployment with no model provider is `degraded`, not `ok`. A health check
 * that reports green while research cannot run is worse than none, because
 * something is relying on it.
 *
 * `gaps` is the operator-facing half — what this deployment cannot do and what
 * would fix it.
 */
import type { FastifyInstance } from "fastify";
import { UNCONFIGURED_PROVIDER_NAME } from "@research-os/model-router";
import type { AppContext } from "../app-context.ts";

export function registerHealthRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/health", async (_request, reply) => {
    const database = await context.db.healthCheck();
    const models = context.engine.deps.router.describe();
    const breakers = context.engine.deps.router.breakerStatus();

    const checks: Record<string, { status: "ok" | "error"; detail?: string }> = {
      database: database.ok
        ? { status: "ok", detail: context.config.databaseDescription }
        : { status: "error", detail: database.detail ?? "unreachable" },
      models: models.some((model) => model.provider !== UNCONFIGURED_PROVIDER_NAME)
        ? { status: "ok", detail: `${models.length} model(s) across ${new Set(models.map((model) => model.provider)).size} provider(s)` }
        : { status: "error", detail: "no model provider is configured" },
      tools: { status: "ok", detail: `${context.tools.listAll().length} tool(s) registered` },
    };

    for (const [provider, state] of Object.entries(breakers)) {
      if (state.open) checks[`provider:${provider}`] = { status: "error", detail: "in cooldown after repeated failures" };
    }

    const degraded = Object.values(checks).some((check) => check.status === "error");
    return reply.status(degraded ? 503 : 200).send({
      status: degraded ? "degraded" : "ok",
      version: "0.1.0",
      uptimeMs: Date.now() - context.startedAt,
      checks,
      gaps: context.gaps,
    });
  });

  /** Liveness: is the process up? Deliberately answers nothing about capability. */
  app.get("/health/live", async (_request, reply) => reply.send({ status: "ok" }));

  app.get("/api/v1/capabilities", async (_request, reply) =>
    reply.send({
      taskTypes: context.engine.supportedTaskTypes(),
      tools: context.tools.listAll().map((tool) => ({
        id: tool.id, capability: tool.capability, riskLevel: tool.riskLevel, provider: tool.provider,
      })),
      models: context.engine.deps.router.describe().map((model) => ({
        id: model.id, provider: model.provider, capabilities: model.capabilities,
      })),
      gaps: context.gaps,
    }),
  );
}
