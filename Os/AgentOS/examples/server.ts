/**
 * The demo server: AgentOS with a working executor, plus a browser console.
 *
 *   npm run demo
 *
 * What this adds to `npm start` is exactly one thing -- an AgentExecutor.
 * Everything else (routes, claim protocol, leases, events, metrics) is the
 * real AgentOS server, unmodified. The UI talks to the documented `/v1/*`
 * endpoints, so the network tab shows the actual API rather than a demo
 * shortcut.
 *
 * Model provider:
 *   ANTHROPIC_API_KEY set -> AnthropicModel (real calls, real cost)
 *   otherwise             -> LocalReasoningModel (deterministic, offline)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildServer } from '../src/api/server';
import { GenericLLMAgentExecutor } from '../src/runtime/GenericLLMAgentExecutor';
import { createSqliteStores } from '../src/persistence/sqlite';
import { loadConfig } from '../src/config';
import type { ModelProvider } from '../src/providers/contracts';
import type { AgentDefinition } from '../src/domain/types';
import { LocalReasoningModel } from './providers/LocalReasoningModel';
import { AnthropicModel, DEFAULT_MODEL } from './providers/AnthropicModel';
import { DemoTools } from './providers/DemoTools';
import { InMemoryMemory } from './providers/InMemoryMemory';
import { HandoffExecutor } from './HandoffExecutor';

// Keep the demo's database separate from anything else you are running.
process.env.DATABASE_URL ??= join(process.cwd(), 'agentos-demo.db');
process.env.PORT ??= '4000';
process.env.LOG_LEVEL ??= 'warn';

const UI_PATH = join(__dirname, '..', '..', 'examples', 'ui', 'index.html');

// ---- the three agents this demo runs ----------------------------------------
// An agent here is configuration, nothing more: a row in `agents`. The same
// runtime executes all three; only the prompt, role and tool grants differ.

const AGENTS: AgentDefinition[] = [
  {
    id: 'researcher',
    version: '1.0.0',
    name: 'Researcher',
    description: 'Gathers evidence about the brief using tools before drawing any conclusion.',
    role: 'a research agent',
    capabilities: ['research', 'extract'],
    toolPermissions: ['text_stats', 'extract_entities', 'current_time'],
    systemPrompt: [
      'You are a research agent. Investigate the brief you are given.',
      'Use your tools to measure and extract concrete facts before concluding.',
      'Report findings as short bullet points. Do not speculate beyond the evidence.'
    ].join('\n')
  },
  {
    id: 'analyst',
    version: '1.0.0',
    name: 'Analyst',
    description: 'Evaluates the researcher findings and computes anything numeric.',
    role: 'an analysis agent',
    capabilities: ['analyse'],
    // Deliberately NOT granted extract_entities: the permission gate is real,
    // and you can watch it refuse if a model tries to call it anyway.
    toolPermissions: ['calculator', 'current_time'],
    memoryPermissions: ['demo'],
    systemPrompt: [
      'You are an analysis agent. You receive research findings as upstream context.',
      'Evaluate them, compute any arithmetic with the calculator tool, and state',
      'what the evidence supports. Be concise and concrete.'
    ].join('\n')
  },
  {
    id: 'writer',
    version: '1.0.0',
    name: 'Writer',
    description: 'Composes the final answer from the upstream research and analysis.',
    role: 'a writing agent',
    capabilities: ['write'],
    toolPermissions: [],
    systemPrompt: [
      'You are a writing agent. You receive research and analysis as upstream context.',
      'Compose the final answer for the person who submitted the brief.',
      'Write plainly. Do not mention that you are an agent or describe your process.'
    ].join('\n')
  }
];

function selectModel(): { model: ModelProvider; label: string; live: boolean } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const model = process.env.AGENTOS_DEMO_MODEL ?? DEFAULT_MODEL;
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
    return {
      model: new AnthropicModel({
        apiKey,
        model,
        // Only set when you supply them: this adapter will not invent a price.
        pricePerMTokIn: num(process.env.AGENTOS_DEMO_PRICE_IN),
        pricePerMTokOut: num(process.env.AGENTOS_DEMO_PRICE_OUT)
      }),
      label: model,
      live: true
    };
  }
  return { model: new LocalReasoningModel(), label: 'local-reasoning-stub', live: false };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const stores = createSqliteStores();
  const tools = new DemoTools();
  const { model, label, live } = selectModel();

  const executor = new HandoffExecutor(
    new GenericLLMAgentExecutor({
      model,
      tools,
      memory: new InMemoryMemory(),
      agents: stores.agents,
      usage: stores.usage,
      maxIterations: 6,
      // Budgets live on the run, so the runtime asks for them per run.
      budgetFor: (runId) => stores.runs.getMeta(runId)?.budget
    })
  );

  const app = await buildServer({ executor, config });

  // ---- the console ----------------------------------------------------------
  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    // Read per request so editing the HTML only needs a browser refresh.
    return readFileSync(UI_PATH, 'utf8');
  });

  // Browsers ask for these unprompted. Without them the log fills with 404s
  // that look like application errors but are just the tab asking for an icon.
  app.get('/favicon.svg', async (_req, reply) => {
    reply.header('content-type', 'image/svg+xml');
    reply.header('cache-control', 'public, max-age=86400');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
      + '<rect width="32" height="32" rx="7" fill="#0c1014"/>'
      + '<circle cx="16" cy="9" r="3.1" fill="#3fd0c9"/>'
      + '<circle cx="9" cy="22" r="3.1" fill="#3fd0c9"/>'
      + '<circle cx="23" cy="22" r="3.1" fill="#3fd0c9"/>'
      + '<path d="M16 12.1 9 18.9M16 12.1l7 6.8" stroke="#3fd0c9" stroke-width="1.6" fill="none"/>'
      + '</svg>';
  });
  for (const path of ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    app.get(path, async (_req, reply) => reply.code(204).send());
  }

  /** What the UI needs to describe the running configuration honestly. */
  app.get('/demo/config', async () => ({
    provider: model.name,
    model: label,
    live,
    liveNote: live
      ? 'Real model calls are being made and billed to your API key.'
      : 'No ANTHROPIC_API_KEY set: a deterministic local stub is standing in for the model. '
        + 'The orchestration, tools, budgets and usage accounting are real; the reasoning is not.',
    agents: AGENTS.map((a) => ({
      id: a.id,
      version: a.version,
      name: a.name,
      role: a.role,
      tools: a.toolPermissions ?? []
    })),
    toolCalls: tools.calls.length
  }));

  /** Tool invocations, so the console can show what the agents actually did. */
  app.get('/demo/tools', async () => ({ calls: tools.calls.slice(-100) }));

  await app.listen({ port: config.port, host: config.host });

  // Register the agent definitions through the real API, so this path is
  // exercised on every boot rather than being a private back door.
  for (const agent of AGENTS) {
    const res = await app.inject({ method: 'POST', url: '/v1/agents', payload: agent });
    if (res.statusCode !== 200) {
      throw new Error(`failed to register ${agent.id}: ${res.statusCode} ${res.body}`);
    }
  }

  const url = `http://localhost:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  AgentOS demo console',
      `  -> ${url}`,
      '',
      `  model     : ${label}${live ? '  (LIVE — billed)' : '  (offline stub)'}`,
      `  database  : ${process.env.DATABASE_URL}`,
      `  agents    : ${AGENTS.map((a) => a.id).join(' -> ')}`,
      `  api docs  : ${url}/docs`,
      `  metrics   : ${url}/metrics`,
      ''
    ].join('\n')
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('demo failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
