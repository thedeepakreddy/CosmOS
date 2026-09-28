import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from '../config';
import { Repositories } from '../repositories';
import { getDb } from '../db/sqlite';
import { runMigrations } from '../db/migrate';
import { EvaluationEngine } from '../engine/EvaluationEngine';
import { registerRoutes } from './routes';

export interface ServerOptions {
  dbPath?: string;
}

export async function buildServer(opts: ServerOptions = {}) {
  const server = Fastify({
    logger: config.NODE_ENV !== 'test',
    bodyLimit: config.PAYLOAD_LIMIT,
  });

  await server.register(swagger, {
    openapi: {
      info: {
        title: 'EvalOS API',
        description: 'Evaluation and Benchmarking Platform API',
        version: '0.1.0',
      },
      servers: [{ url: 'http://' + config.HOST + ':' + config.PORT }],
    },
  });

  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false,
    },
  });

  server.get('/openapi.json', async () => {
    return server.swagger();
  });

  server.get('/health', async () => {
    return { status: 'healthy', version: '0.1.0' };
  });

  const dbPath = opts.dbPath ?? config.DATABASE_URL;
  const db = getDb(dbPath);
  runMigrations(db);
  const repos = new Repositories(db);

  const engine = new EvaluationEngine(
    repos,
    () => null,
    () => null,
    config.MAX_CONCURRENCY,
  );

  server.decorate('repos', repos);
  server.decorate('engine', engine);

  await registerRoutes(server);

  return server;
}

// Add types for decorators
declare module 'fastify' {
  interface FastifyInstance {
    repos: Repositories;
    engine: EvaluationEngine;
  }
}
