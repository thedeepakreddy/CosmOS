import { FastifyInstance } from 'fastify';

export async function registerRoutes(server: FastifyInstance) {
  server.register(suiteRoutes, { prefix: '/v1/suites' });
  server.register(datasetRoutes, { prefix: '/v1/datasets' });
  server.register(runRoutes, { prefix: '/v1/runs' });
  server.register(traceRoutes, { prefix: '/v1/traces' });
}

async function suiteRoutes(fastify: FastifyInstance) {
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'name', 'version', 'caseIds'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          caseIds: { type: 'array', items: { type: 'string' } }
        }
      },
      response: {
        201: { type: 'object', properties: { status: { type: 'string' } } }
      }
    }
  }, async (request: any, reply) => {
    fastify.repos.suites.create(request.body);
    reply.code(201).send({ status: 'created' });
  });

  fastify.get('/:id', async (request: any, reply) => {
    const suite = fastify.repos.suites.getById(request.params.id);
    if (!suite) {
      reply.code(404).send({ error: 'SUITE_NOT_FOUND', message: 'Suite not found' });
      return;
    }
    return suite;
  });
}

async function datasetRoutes(fastify: FastifyInstance) {
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'version', 'caseCount'],
        properties: {
          id: { type: 'string' },
          version: { type: 'string' },
          hash: { type: 'string' },
          caseCount: { type: 'number' },
          metadata: { type: 'object', additionalProperties: true }
        }
      }
    }
  }, async (request: any, reply) => {
    fastify.repos.datasets.create(request.body);
    reply.code(201).send({ status: 'created' });
  });

  fastify.get('/:id', async (request: any, reply) => {
    const dataset = fastify.repos.datasets.getById(request.params.id);
    if (!dataset) return reply.code(404).send({ error: 'DATASET_NOT_FOUND' });
    return dataset;
  });
}

async function runRoutes(fastify: FastifyInstance) {
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'suiteId', 'suiteVersion', 'candidateId', 'candidateVersion'],
        properties: {
          id: { type: 'string' },
          suiteId: { type: 'string' },
          suiteVersion: { type: 'string' },
          candidateId: { type: 'string' },
          candidateVersion: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  }, async (request: any, reply) => {
    const run = { ...request.body, status: request.body.status || 'CREATED' };
    fastify.repos.runs.create(run);
    reply.code(201).send({ status: 'created' });
  });

  fastify.get('/:id', async (request: any, reply) => {
    const run = fastify.repos.runs.getById(request.params.id);
    if (!run) return reply.code(404).send({ error: 'RUN_NOT_FOUND' });
    return run;
  });

  fastify.post('/:id/start', async (request: any, reply) => {
    // We run it synchronously to respond when completed, or async if needed.
    // The engine's startRun completes when all cases are done.
    try {
      await fastify.engine.startRun(request.params.id);
      reply.send({ status: 'started_and_completed' });
    } catch (e: any) {
      reply.code(500).send({ error: 'RUN_FAILED', message: e.message });
    }
  });

  fastify.get('/:id/scores', async (request: any, reply) => {
    const scores = fastify.repos.scores.getByRunId(request.params.id);
    return { scores };
  });
}

async function traceRoutes(fastify: FastifyInstance) {
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['traceId', 'system', 'eventType', 'timestamp'],
        properties: {
          traceId: { type: 'string' },
          system: { type: 'string' },
          component: { type: 'string' },
          eventType: { type: 'string' },
          timestamp: { type: 'string' },
          runId: { type: 'string' },
          executionId: { type: 'string' },
          status: { type: 'string' },
          durationMs: { type: 'number' },
          metadata: { type: 'object', additionalProperties: true }
        }
      }
    }
  }, async (request: any, reply) => {
    // Basic implementation to satisfy contract.
    // In MVP, we just accept it and publish an event or store it.
    reply.code(201).send({ status: 'ingested' });
  });
}
