/**
 * Executor routes — where an external execution layer attaches.
 *
 * An executor registers the capabilities it can fulfil, long-polls for work, and
 * posts results back. Nothing here names a specific host application: the
 * protocol is symmetric, and whatever advertises `browser` gets browser work.
 *
 * Every route except registration authenticates with the bearer token issued at
 * registration. An unauthenticated executor endpoint would let anyone inject
 * results into someone else's research.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ClaimWorkQuery, RegisterExecutorRequest, SubmitExecutorResultRequest } from "@research-os/contracts";
import { err } from "@research-os/shared";
import type { Executor } from "@research-os/contracts";
import type { AppContext } from "../app-context.ts";
import { parseBody, parseQuery, sendError, traceIdOf } from "../http.ts";

export function registerExecutorRoutes(app: FastifyInstance, context: AppContext): void {
  const { executors, store, logger, tools } = context;

  const authenticate = async (request: FastifyRequest): Promise<Executor> => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const executor = await executors.authenticate(token);
    if (!executor) throw err.unauthorized("A valid executor token is required.");
    return executor;
  };

  app.post("/api/v1/executors", async (request, reply) => {
    try {
      const body = parseBody(RegisterExecutorRequest, request.body);
      const { executor, token } = await executors.register(body, context.config.tenantId);
      // A newly attached executor may bring capabilities the registry has not
      // seen, so the tool routing table is rebuilt.
      await tools.refresh();
      logger.info("Executor registered", { executorId: executor.id, name: executor.name, capabilities: executor.capabilities });
      return await reply.status(201).send({ executor, token });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/executors", async (request, reply) => {
    try {
      return await reply.send({ items: await executors.listExecutors(), nextCursor: null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.post("/api/v1/executors/heartbeat", async (request, reply) => {
    try {
      const executor = await authenticate(request);
      await executors.heartbeat(executor.id, "healthy");
      return await reply.send({ ok: true, executorId: executor.id });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /**
   * Pull-mode work claim, with optional long polling.
   *
   * Long polling rather than a push callback because an executor is usually
   * behind a NAT or a firewall with no inbound route — a desktop application,
   * for instance. Asking for work is something it can always do.
   */
  app.post("/api/v1/executors/claim", async (request, reply) => {
    try {
      const executor = await authenticate(request);
      const query = parseQuery(ClaimWorkQuery, { ...(request.body as object), ...(request.query as object) });
      const capabilities = query.capabilities.length > 0
        ? executor.capabilities.filter((capability) => query.capabilities.includes(capability))
        : executor.capabilities;

      const deadline = Date.now() + query.waitMs;
      for (;;) {
        const requests = await executors.claimWork(executor.id, capabilities, query.max);
        if (requests.length > 0 || Date.now() >= deadline) {
          return await reply.send({ requests });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
      }
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.post("/api/v1/executors/requests/:requestId/result", async (request, reply) => {
    try {
      const executor = await authenticate(request);
      const { requestId } = request.params as { requestId: string };
      const body = parseBody(SubmitExecutorResultRequest, request.body);

      const completed = await executors.submitResult(requestId, executor.id, body);

      // A task parked on this request becomes runnable again. Resuming it here
      // is what closes the loop: without it the task would wait for its lease
      // to lapse and be retried from the beginning.
      let taskResumed = false;
      const parked = await store.tasks.findByAwaitingRequest(requestId);
      if (parked) {
        await store.tasks.resume(parked.id, new Date().toISOString());
        taskResumed = true;
      }

      return await reply.send({ accepted: true, taskResumed, status: completed.status });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });
}
