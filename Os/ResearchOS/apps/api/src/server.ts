/**
 * The HTTP server.
 *
 * The only network surface ResearchOS has. Everything it exposes is defined in
 * `contracts/src/api.ts`, so the SDK's types and this server's behaviour come
 * from one definition rather than two that drift.
 *
 * Authentication is opt-in and defaults to off, which is the right default for
 * a locally-run research tool and the wrong one for anything reachable. The
 * server says so at startup rather than leaving it to be discovered.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { toLogError } from "@research-os/observability";
import type { AppContext } from "./app-context.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerExecutorRoutes } from "./routes/executors.ts";
import { registerHealthRoutes } from "./routes/health.ts";

export async function createServer(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's own logger is disabled: this process already has a structured
    // logger, and two logging systems produce two formats in one stream.
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
    disableRequestLogging: true,
  });

  if (context.config.corsOrigins.length > 0) {
    await app.register(cors, { origin: context.config.corsOrigins, credentials: true });
  }

  /* ---------- Authentication ---------- */

  if (context.config.apiKeys.length > 0) {
    app.addHook("onRequest", async (request, reply) => {
      // Health and executor registration stay open: a load balancer cannot hold
      // an API key, and an executor has none until it has registered.
      const open = request.url.startsWith("/health") || request.url.startsWith("/api/v1/executors");
      if (open) return;

      const header = request.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      // Constant-time comparison against each configured key. A
      // timing-variable compare on a credential leaks it a byte at a time.
      const accepted = context.config.apiKeys.some((key) => constantTimeEquals(key, presented));
      if (!accepted) {
        await reply.status(401).send({
          error: { code: "unauthorized", message: "A valid API key is required.", traceId: request.id },
        });
      }
    });
  } else {
    context.logger.warn("The API is unauthenticated", {
      hint: "Set RESEARCH_OS_API_KEYS before exposing this process beyond localhost.",
    });
  }

  /* ---------- Observability ---------- */

  app.addHook("onResponse", async (request, reply) => {
    context.metrics.increment("http.request", {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: String(reply.statusCode),
    });
    context.metrics.observe("http.latency_ms", reply.elapsedTime, { route: request.routeOptions.url ?? "unmatched" });
  });

  /**
   * Last-resort error mapping.
   *
   * Fastify raises its own errors before a handler ever runs — a malformed JSON
   * body, an unsupported content type, a payload over the limit — and those
   * carry a `statusCode` that is already correct. Collapsing them all to 500
   * would tell a client its own bad request was a server fault, and send them
   * looking in the wrong place. Client-caused failures are mapped through and
   * logged as warnings; anything 5xx is a real bug and keeps its stack in the
   * log while the client gets a stable code and a trace id.
   */
  app.setErrorHandler(async (thrown, request, reply) => {
    // `useUnknownInCatchVariables` reaches here too: Fastify's error type is
    // widened to unknown, so its fields are read rather than assumed.
    const error = thrown as { statusCode?: unknown; code?: unknown; message?: unknown };
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    const clientFault = status < 500;

    if (clientFault) {
      context.logger.warn("Rejected request", {
        url: request.url,
        status,
        code: typeof error.code === "string" ? error.code : null,
        traceId: request.id,
      });
    } else {
      context.logger.error("Unhandled route error", { url: request.url, error: toLogError(thrown), traceId: request.id });
    }

    return reply.status(status).send({
      error: {
        code: clientFault ? "validation_failed" : "internal_error",
        message: clientFault && typeof error.message === "string" ? error.message : "An internal error occurred.",
        traceId: request.id,
      },
    });
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({
      error: { code: "not_found", message: `No route for ${request.method} ${request.url}`, traceId: request.id },
    }),
  );

  registerHealthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerEventRoutes(app, context);
  registerExecutorRoutes(app, context);

  return app;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
