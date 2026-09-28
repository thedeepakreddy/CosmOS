import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ToolRegistry } from '../../../packages/registry/src';
import { ToolRouter } from '../../../packages/router/src';
import { DefaultPolicyProvider } from '../../../packages/policy/src';
import { EventBus } from '../../../packages/observability/src';
import { ExecutionService } from './ExecutionService';
import { randomUUID } from 'crypto';
import { ExecutorAdapter } from '../../../packages/contracts/src';

export interface AppOptions {
  adapters: ExecutorAdapter[];
}

export async function buildApp(options: AppOptions) {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors);

  // Add schemas directly to Fastify for serialization/validation
  fastify.addSchema({
    $id: 'ToolDefinition',
    type: 'object',
    properties: {
      id: { type: 'string' },
      namespace: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      description: { type: 'string' },
      capabilities: { type: 'array', items: { type: 'string' } },
      inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true },
      executorId: { type: 'string' },
      readOnly: { type: 'boolean' },
      idempotent: { type: 'boolean' },
      platforms: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      riskHint: { type: 'string' },
      timeoutMs: { type: 'number' },
      metadata: { type: 'object', additionalProperties: true }
    },
    required: ['id', 'namespace', 'name', 'version', 'description', 'capabilities', 'inputSchema', 'executorId', 'readOnly']
  });

  fastify.addSchema({
    $id: 'ExecutorHealth',
    type: 'object',
    properties: {
      status: { type: 'string' },
      message: { type: 'string' }
    },
    required: ['status']
  });

  fastify.addSchema({
    $id: 'Executor',
    type: 'object',
    properties: {
      id: { type: 'string' },
      health: { $ref: 'ExecutorHealth#' }
    },
    required: ['id', 'health']
  });

  fastify.addSchema({
    $id: 'ToolExecutionRequest',
    type: 'object',
    properties: {
      executionId: { type: 'string' },
      toolId: { type: 'string' },
      capability: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
      caller: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] }
    },
    required: ['args', 'caller']
  });

  fastify.addSchema({
    $id: 'ToolExecutionResult',
    type: 'object',
    properties: {
      executionId: { type: 'string' },
      status: { type: 'string' },
      executorId: { type: 'string' },
      toolId: { type: 'string' },
      error: { type: 'object', additionalProperties: true },
      output: { type: 'object', additionalProperties: true },
      metadata: { type: 'object', additionalProperties: true },
      startedAt: { type: 'string' },
      finishedAt: { type: 'string' },
      durationMs: { type: 'number' }
    },
    required: ['executionId', 'status', 'executorId', 'toolId']
  });
  
  await fastify.register(swagger, {
    openapi: {
      info: { title: 'ToolOS API', version: '1.0.0' }
    }
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'full', deepLinking: false }
  });

  fastify.get('/openapi.json', async () => fastify.swagger());

  const registry = new ToolRegistry();
  const policy = new DefaultPolicyProvider();
  const router = new ToolRouter(registry);
  const events = new EventBus();
  const adapters = new Map<string, ExecutorAdapter>();

  events.subscribe((event: any) => {
    fastify.log.info({ auditEvent: event }, `Audit Event: ${event.type}`);
  });

  for (const adapter of options.adapters) {
    adapters.set(adapter.id, adapter);
    const health = await adapter.health();
    registry.registerExecutor(adapter.id, health);
    
    if (health.status !== "healthy") {
        fastify.log.warn(`Executor ${adapter.id} is ${health.status}`);
    }

    const tools = await adapter.listTools();
    for (const t of tools) {
      try {
        registry.registerTool(t);
        events.emit({ type: "tool.registered", toolId: t.id });
      } catch (e: any) {
        fastify.log.warn(e.message);
      }
    }
  }

  const executionService = new ExecutionService(registry, policy, router, events, adapters);

  fastify.get('/health', {
    schema: { response: { 200: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' } } } } }
  }, async () => ({ status: 'ok', version: '1.0.0' }));

  fastify.get('/v1/executors', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            executors: {
              type: 'array',
              items: { $ref: 'Executor#' }
            }
          }
        }
      }
    }
  }, async () => ({ executors: Array.from(adapters.keys()).map(id => ({ id, health: registry.getExecutorHealth(id) })) }));

  fastify.get('/v1/executors/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { $ref: 'Executor#' }, 404: { type: 'object', properties: { message: { type: 'string' } } } }
    }
  }, async (request: any, reply) => {
    const health = registry.getExecutorHealth(request.params.id);
    if (!health || health.status === "unknown") return reply.code(404).send({ message: "Executor not found" });
    return { id: request.params.id, health };
  });

  fastify.get('/v1/tools', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: { $ref: 'ToolDefinition#' }
            }
          }
        }
      }
    }
  }, async () => ({ tools: registry.listTools() }));

  fastify.get('/v1/tools/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { $ref: 'ToolDefinition#' }, 404: { type: 'object', properties: { message: { type: 'string' } } } }
    }
  }, async (request: any, reply) => {
    const tool = registry.listTools().find(t => t.id === request.params.id);
    if (!tool) return reply.code(404).send({ message: "Tool not found" });
    return tool;
  });

  fastify.get('/v1/capabilities', {
    schema: {
      response: {
        200: { type: 'object', properties: { capabilities: { type: 'array', items: { type: 'string' } } } }
      }
    }
  }, async () => {
    const caps = new Set<string>();
    registry.listTools().forEach(t => t.capabilities.forEach(c => caps.add(c)));
    return { capabilities: Array.from(caps) };
  });

  fastify.get('/v1/capabilities/:capability/tools', {
    schema: {
      params: { type: 'object', properties: { capability: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { tools: { type: 'array', items: { $ref: 'ToolDefinition#' } } } }
      }
    }
  }, async (request: any) => ({ tools: registry.findToolsByCapability(request.params.capability) }));

  fastify.post('/v1/executions', {
    schema: {
      body: { $ref: 'ToolExecutionRequest#' },
      response: {
        200: { $ref: 'ToolExecutionResult#' },
        400: { $ref: 'ToolExecutionResult#' },
        500: { $ref: 'ToolExecutionResult#' }
      }
    }
  }, async (request: any, reply) => {
    const body = request.body;
    const executionId = body.executionId || randomUUID();
    const result = await executionService.execute({ ...body, executionId });
    return reply.code(result.status === "succeeded" ? 200 : 400).send(result);
  });

  return fastify;
}
