/**
 * Project routes — the surface an application talks to.
 *
 * A caller creates a project with a question, starts it, watches progress, and
 * reads the result. Nothing here knows which application is calling: the
 * `client` field on a request records it for audit, and that is the whole
 * coupling.
 */
import type { FastifyInstance } from "fastify";
import {
  AddEvidenceRequest, CancelProjectRequest, CreateProjectRequest, ListClaimsQuery, ListProjectsQuery,
  ResearchBudget, ResearchPreferences, ResearchProject, RunProjectRequest, Task,
} from "@research-os/contracts";
import { buildIndex, projectResearchGraph, projectResearchTree, provenanceOf } from "@research-os/knowledge-graph";
import { evaluateResearchProject } from "@research-os/research-core";
import { err, newId, truncate } from "@research-os/shared";
import type { AppContext } from "../app-context.ts";
import { parseBody, parseQuery, sendError, traceIdOf } from "../http.ts";

export function registerProjectRoutes(app: FastifyInstance, context: AppContext): void {
  const { store, engine, logger } = context;

  /* ---------- Create ---------- */

  app.post("/api/v1/research/projects", async (request, reply) => {
    try {
      const body = parseBody(CreateProjectRequest, request.body);
      const now = new Date().toISOString();

      const project = ResearchProject.parse({
        id: newId("project"),
        tenantId: body.client?.tenantId ?? context.config.tenantId,
        createdBy: body.client ?? null,
        // A question makes a serviceable title when the caller supplies none;
        // better than "Untitled", and the full question is stored regardless.
        title: body.title ?? truncate(body.question, 120),
        description: body.description ?? null,
        originalQuestion: body.question,
        status: "draft",
        preferences: ResearchPreferences.parse(body.preferences ?? {}),
        budget: ResearchBudget.parse(body.budget ?? {}),
        failureReason: null,
        metadata: body.metadata ?? {},
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });

      await store.projects.create(project);
      await store.events.append({
        projectId: project.id,
        type: "research.project.created",
        // Matches the payload declared for this type in `contracts/src/events.ts`.
        // A client validating with `parseEvent` rejects anything else.
        payload: { title: project.title, originalQuestion: project.originalQuestion },
      });

      if (body.autoStart) await startRun(context, project.id, {});

      const created = await store.projects.findById(project.id);
      return await reply.status(201).send({ project: created ?? project });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /* ---------- Read ---------- */

  app.get("/api/v1/research/projects", async (request, reply) => {
    try {
      const query = parseQuery(ListProjectsQuery, request.query);
      const items = await store.projects.list({
        limit: query.limit,
        ...(query.status ? { status: query.status } : {}),
        ...(query.application ? { application: query.application } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return await reply.send({ items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const project = await store.projects.findById(id);
      if (!project) throw err.notFound("Project", id);

      const [progress, objectives, questions, hypotheses, plan] = await Promise.all([
        engine.coordinator.progress(id),
        store.projects.listObjectives(id),
        store.projects.listQuestions(id),
        store.projects.listHypotheses(id),
        store.projects.latestPlan(id),
      ]);

      return await reply.send({ project, progress, objectives, questions, hypotheses, plan: plan ?? null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/status", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const project = await store.projects.findById(id);
      if (!project) throw err.notFound("Project", id);

      const [progress, running, agents, lastSequence] = await Promise.all([
        engine.coordinator.progress(id),
        store.tasks.list(id, { status: "running", limit: 50 }),
        store.runs.activeRuns(id),
        store.events.lastSequence(id),
      ]);

      return await reply.send({
        projectId: id,
        status: project.status,
        progress,
        activeTasks: running.map((task) => ({ taskId: task.id, type: task.type, startedAt: task.startedAt })),
        activeAgents: agents.map((run) => ({ runId: run.id, role: run.role, startedAt: run.startedAt })),
        lastEventSequence: lastSequence,
      });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /* ---------- Run control ---------- */

  app.post("/api/v1/research/projects/:id/run", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(RunProjectRequest, request.body);
      return await reply.send(await startRun(context, id, body));
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.post("/api/v1/research/projects/:id/cancel", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(CancelProjectRequest, request.body);
      const cancelled = await store.tasks.cancelAll(id, new Date().toISOString());
      await engine.coordinator.transition(id, "cancelled", {
        force: true,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return await reply.send({ projectId: id, status: "cancelled", cancelledTasks: cancelled });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /* ---------- Research artifacts ---------- */

  app.get("/api/v1/research/projects/:id/claims", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = parseQuery(ListClaimsQuery, request.query);
      const items = await store.research.listClaims(id, {
        limit: query.limit,
        ...(query.status ? { status: query.status } : {}),
        ...(query.minConfidence !== undefined ? { minConfidence: query.minConfidence } : {}),
        ...(query.questionId ? { questionId: query.questionId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return await reply.send({ items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /**
   * One claim with everything needed to audit it.
   *
   * `provenance` is the field that matters: it walks the graph back to the
   * sources underneath the claim, and reports `unsupported` when it reaches
   * none. A client rendering a claim can therefore show whether it actually
   * rests on anything without trusting a status field.
   */
  app.get("/api/v1/research/projects/:id/claims/:claimId", async (request, reply) => {
    try {
      const { id, claimId } = request.params as { id: string; claimId: string };
      const claim = await store.research.findClaim(claimId);
      if (!claim || claim.projectId !== id) throw err.notFound("Claim", claimId);

      const [linked, relations, contradictions, findings, debates] = await Promise.all([
        store.research.evidenceForClaim(claimId),
        store.research.listRelations(id),
        store.research.contradictionsForClaim(claimId),
        store.runs.listFindings(id, { targetId: claimId }),
        store.runs.listDebates(id, claimId),
      ]);

      const sources = await store.research.findSourcesByIds([...new Set(linked.map(({ evidence }) => evidence.sourceId as string))]);
      const graph = await buildProjectGraph(context, id);
      const chain = provenanceOf(buildIndex(graph), nodeIdFor(graph, "claim", claimId));

      return await reply.send({
        claim,
        evidence: linked
          .map(({ link, evidence }) => ({
            evidence,
            source: sources.get(evidence.sourceId as string),
            stance: link.stance,
            rationale: link.rationale ?? null,
          }))
          .filter((entry) => entry.source),
        relations: relations.filter((relation) => relation.fromClaimId === claimId || relation.toClaimId === claimId),
        contradictions,
        findings,
        debates,
        provenance: {
          sources: chain.sources.map((node) => ({ id: node.entityId, label: node.label })),
          evidenceCount: chain.evidence.length,
          unsupported: chain.unsupported,
        },
      });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/evidence", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = parseQuery(ListClaimsQuery, request.query);
      const items = await store.research.listEvidence(id, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return await reply.send({ items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/sources", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = parseQuery(ListClaimsQuery, request.query);
      const items = await store.research.listSources(id, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return await reply.send({ items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/tasks", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const items = await store.tasks.list(id, { limit: 200 });
      return await reply.send({ items, nextCursor: null });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/graph", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const graph = await buildProjectGraph(context, id);
      return await reply.send({ graph: { projectId: id, ...graph, generatedAt: new Date().toISOString() } });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/tree", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const project = await store.projects.findById(id);
      if (!project) throw err.notFound("Project", id);

      const [questions, hypotheses, claims, contradictions] = await Promise.all([
        store.projects.listQuestions(id),
        store.projects.listHypotheses(id),
        store.research.listClaims(id, { limit: 500 }),
        store.research.listContradictions(id),
      ]);

      return await reply.send({
        tree: projectResearchTree({
          projectId: id,
          originalQuestion: project.originalQuestion,
          questions, hypotheses, claims, contradictions,
          now: new Date().toISOString(),
        }),
      });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /**
   * How well this research was conducted.
   *
   * Explicitly not a judgement on whether the findings are true — the caveats
   * are returned with every response so that cannot be inferred away.
   */
  app.get("/api/v1/research/projects/:id/evaluation", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      if (!(await store.projects.findById(id))) throw err.notFound("Project", id);
      return await reply.send({ evaluation: await evaluateResearchProject(store, id) });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  app.get("/api/v1/research/projects/:id/report", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { version } = request.query as { version?: string };
      const report = version
        ? await store.reports.findVersion(id, Number(version))
        : await store.reports.latest(id);
      if (!report) throw err.notFound("Report for project", id);
      return await reply.send({ report });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });

  /* ---------- Caller-supplied material ---------- */

  app.post("/api/v1/research/projects/:id/evidence", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(AddEvidenceRequest, request.body);
      const project = await store.projects.findById(id);
      if (!project) throw err.notFound("Project", id);

      const now = new Date().toISOString();
      const sourceId = newId("source");

      if (!body.url) {
        // Content supplied directly is not yet stored: doing it properly means
        // running it through the same parse-and-chunk path a fetch takes, or
        // the offsets a quote is checked against would not exist.
        throw err.unsupported(
          "Supplying evidence content directly is not implemented yet; supply a `url` so it is fetched, parsed and chunked through the same path as any other source.",
        );
      }

      const task = Task.parse({
        id: newId("task"), projectId: id, type: "source.ingest", status: "pending", priority: 70,
        dependsOn: [], input: { url: body.url, sourceId }, output: null, leasedBy: null,
        leaseExpiresAt: null, runAfter: now, awaitingRequestId: null, errorCode: null,
        errorMessage: null, traceId: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      });
      await store.tasks.create([task]);

      return await reply.status(202).send({ sourceId, taskId: task.id, status: "discovered" });
    } catch (error) {
      return sendError(reply, logger, error, traceIdOf(request));
    }
  });
}

/* ---------- Helpers ---------- */

async function buildProjectGraph(context: AppContext, projectId: string) {
  const { store } = context;
  const [questions, hypotheses, sources, evidence, claims, claimEvidence, claimRelations, contradictions] = await Promise.all([
    store.projects.listQuestions(projectId),
    store.projects.listHypotheses(projectId),
    store.research.listSources(projectId, { limit: 500 }),
    store.research.listEvidence(projectId, { limit: 1000 }),
    store.research.listClaims(projectId, { limit: 500 }),
    store.research.listEvidenceLinks(projectId),
    store.research.listRelations(projectId),
    store.research.listContradictions(projectId),
  ]);

  return projectResearchGraph({
    projectId, questions, hypotheses, sources, evidence, claims, claimEvidence, claimRelations, contradictions,
    now: new Date().toISOString(),
  });
}

function nodeIdFor(graph: { nodes: readonly { id: string; type: string; entityId: string }[] }, type: string, entityId: string): string {
  return graph.nodes.find((node) => node.type === type && node.entityId === entityId)?.id ?? "";
}

/**
 * Starts or resumes a run.
 *
 * A project with runnable work left is resumed rather than replanned — that is
 * what makes an interrupted run continuable rather than restartable. `restart`
 * is the explicit opt-out.
 */
async function startRun(
  context: AppContext,
  projectId: string,
  // Typed from the request contract itself rather than restated: under
  // `exactOptionalPropertyTypes` a hand-written `Partial<T>` is a different
  // type from what zod's `.partial()` infers, and restating it drifts.
  body: Partial<RunProjectRequest>,
): Promise<{ projectId: string; status: string; planVersion: number; tasksQueued: number }> {
  const { store, engine } = context;
  const project = await store.projects.findById(projectId);
  if (!project) throw err.notFound("Project", projectId);
  const now = new Date().toISOString();

  if (body.budget || body.preferences) {
    await store.projects.update(
      projectId,
      {
        ...(body.budget ? { budget: ResearchBudget.parse({ ...project.budget, ...body.budget }) } : {}),
        ...(body.preferences ? { preferences: ResearchPreferences.parse({ ...project.preferences, ...body.preferences }) } : {}),
      },
      now,
    );
  }

  const hasWork = await store.tasks.hasRunnableWork(projectId);
  if (hasWork && !body.restart) {
    const resumed = await engine.coordinator.resume(projectId);
    const counts = await store.tasks.countByStatus(projectId);
    return {
      projectId,
      status: resumed.resumed ? "running" : project.status,
      planVersion: (await store.projects.latestPlan(projectId))?.version ?? 1,
      tasksQueued: (counts["pending"] ?? 0) + (counts["queued"] ?? 0),
    };
  }

  if (project.status === "completed" || project.status === "cancelled") {
    throw err.conflict(`Project ${projectId} is ${project.status} and cannot be run again.`, { projectId });
  }

  if (project.status === "draft") await engine.coordinator.transition(projectId, "planning");
  await engine.coordinator.transition(projectId, "running", { force: true });

  await store.tasks.create([
    Task.parse({
      id: newId("task"), projectId, type: "plan.create", status: "pending", priority: 100,
      dependsOn: [], input: {}, output: null, leasedBy: null, leaseExpiresAt: null, runAfter: now,
      awaitingRequestId: null, errorCode: null, errorMessage: null, traceId: null,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    }),
  ]);

  return {
    projectId,
    status: "running",
    planVersion: ((await store.projects.latestPlan(projectId))?.version ?? 0) + 1,
    tasksQueued: 1,
  };
}
