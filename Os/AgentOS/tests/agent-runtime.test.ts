import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Supervisor } from '../src/engine/Supervisor';
import { GenericLLMAgentExecutor } from '../src/runtime/GenericLLMAgentExecutor';
import { runMigrations } from '../src/db/migrations';
import { closeDb } from '../src/db/connection';
import { createSqliteStores } from '../src/persistence/sqlite';
import type { Stores } from '../src/persistence/contracts';
import { AgentDefinition, ExecutionBudget, Task } from '../src/index';
import {
  ScriptedModelProvider, ScriptedToolProvider, InMemoryMemoryProvider, say, callTool
} from './fixtures/ScriptedProviders';
import { testDbPath, removeDb } from './helpers/testDb';

/**
 * Phase G: agent instances, versioning, the generic runtime and budget enforcement.
 *
 * NO live model call is made anywhere. Every agent here runs against a scripted
 * provider, which proves the wiring, the contracts and the budget arithmetic --
 * and proves nothing about what a real model would do with these prompts.
 */
describe('Agent runtime (Phase G)', () => {
  const dbPath = testDbPath('agent-runtime');
  process.env.DATABASE_URL = dbPath;
  let stores: Stores;
  let seq = 0;

  beforeAll(() => {
    removeDb(dbPath);
    process.env.DATABASE_URL = dbPath;
    runMigrations();
    stores = createSqliteStores();
  });
  afterAll(() => { closeDb(); removeDb(dbPath); });
  beforeEach(() => { seq++; });

  const define = (over: Partial<AgentDefinition> & { id: string; version: string }): AgentDefinition => ({
    name: over.id, description: 'a scripted agent', role: 'worker', capabilities: [], ...over
  });

  function makeRun(agentId: string, budget?: ExecutionBudget, input?: unknown): string {
    const runId = `AG${seq}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const task: Task = {
      id: 'T1', runId, name: 'do the thing', description: 'a scripted task',
      agentDefinitionId: agentId, state: 'PENDING', createdAt: now,
      retriesAllowed: 0, retriesAttempted: 0, input
    };
    stores.runs.save({ id: runId, goal: 'agent runtime', state: 'CREATED', createdAt: now, budget, taskGraph: { tasks: [task], dependencies: [] } });
    return runId;
  }

  const settle = async (runId: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const run = stores.runs.getMeta(runId)!;
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.state)) return run;
      if (Date.now() > deadline) return run;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  // ---- agent instance lifecycle (was NOT_FOUND) ---------------------------
  describe('agent instance lifecycle', () => {
    it('persists a real instance pinned to the exact definition version', async () => {
      stores.agents.save(define({ id: 'inst-agent', version: '2.1.0' }));
      const runId = makeRun('inst-agent');
      const model = new ScriptedModelProvider([say('done')]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, agents: stores.agents, usage: stores.usage }),
        { stores, workerId: 'w-instances', leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      const instances = stores.instances.listByRun(runId);
      // v0.1 fabricated `{id:'inst-<defId>', version:'1'}` inline and persisted nothing.
      expect(instances).toHaveLength(1);
      const instance = instances[0];
      expect(instance.definitionId).toBe('inst-agent');
      expect(instance.version).toBe('2.1.0');
      expect(instance.taskId).toBe('T1');
      expect(instance.workerId).toBe('w-instances');
      expect(instance.state).toBe('TERMINATED');
      expect(instance.activatedAt).toBeTruthy();
      expect(instance.terminatedAt).toBeTruthy();
    });

    it('marks the instance FAILED when execution fails, with the reason', async () => {
      stores.agents.save(define({ id: 'fail-agent', version: '1.0.0' }));
      const runId = makeRun('fail-agent');
      const model = new ScriptedModelProvider([
        { content: '', finishReason: 'error', usage: { inputTokens: 1, outputTokens: 0 } }
      ]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      const instance = stores.instances.listByRun(runId)[0];
      expect(instance.state).toBe('FAILED');
      expect(instance.error).toContain('MODEL_PROVIDER_ERROR');
    });

    it('refuses to transition a terminated instance (guarded lifecycle)', () => {
      stores.agents.save(define({ id: 'guard-agent', version: '1.0.0' }));
      // agent_instances has a foreign key to runs, so the run must exist.
      stores.runs.save({ id: 'GUARD', goal: 'guard', state: 'CREATED', createdAt: new Date().toISOString() });
      const inst = stores.instances.create({
        runId: 'GUARD', definitionId: 'guard-agent', version: '1.0.0', workerId: 'w'
      });
      expect(stores.instances.transition(inst.id, ['CREATED'], 'ACTIVE')).toBe(true);
      expect(stores.instances.transition(inst.id, ['ACTIVE'], 'TERMINATED')).toBe(true);
      // A stale caller cannot resurrect it.
      expect(stores.instances.transition(inst.id, ['ACTIVE'], 'ACTIVE')).toBe(false);
      expect(stores.instances.get(inst.id)!.state).toBe('TERMINATED');
    });

    it('a task naming an unknown agent fails clearly instead of running a phantom', async () => {
      const runId = makeRun('no-such-agent');
      const model = new ScriptedModelProvider([say('unreachable')]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.error).toContain('AGENT_DEFINITION_NOT_FOUND');
      expect(model.callCount).toBe(0);
    });
  });

  // ---- versioning (was fiction) -------------------------------------------
  describe('definition versioning', () => {
    it('versions coexist; registering v2 does not destroy v1', () => {
      stores.agents.save(define({ id: 'versioned', version: '1.0.0', role: 'original' }));
      stores.agents.save(define({ id: 'versioned', version: '2.0.0', role: 'revised' }));

      // v0.1 upserted on id alone, so v1 was silently destroyed.
      expect(stores.agents.get('versioned', '1.0.0')!.role).toBe('original');
      expect(stores.agents.get('versioned', '2.0.0')!.role).toBe('revised');
      expect(stores.agents.listVersions('versioned').map((a) => a.version)).toEqual(['1.0.0', '2.0.0']);
      // Omitting the version yields the newest.
      expect(stores.agents.get('versioned')!.version).toBe('2.0.0');
    });

    it('re-registering the same version updates in place', () => {
      stores.agents.save(define({ id: 'same-ver', version: '1.0.0', role: 'first' }));
      stores.agents.save(define({ id: 'same-ver', version: '1.0.0', role: 'second' }));
      expect(stores.agents.listVersions('same-ver')).toHaveLength(1);
      expect(stores.agents.get('same-ver', '1.0.0')!.role).toBe('second');
    });

    it('an instance keeps running the version it was created from', async () => {
      stores.agents.save(define({ id: 'pinned', version: '1.0.0', systemPrompt: 'I am v1' }));
      const runId = makeRun('pinned');
      const model = new ScriptedModelProvider([say('ok')]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.instances.listByRun(runId)[0].version).toBe('1.0.0');
      expect(model.requests[0].messages[0].content).toBe('I am v1');
    });
  });

  // ---- capability routing (capabilities[] was never read) -----------------
  it('routes by capability', () => {
    stores.agents.save(define({ id: 'coder', version: '1.0.0', capabilities: ['code', 'test'] }));
    stores.agents.save(define({ id: 'writer', version: '1.0.0', capabilities: ['write'] }));
    stores.agents.save(define({ id: 'polyglot', version: '1.0.0', capabilities: ['code', 'write', 'test'] }));

    expect(stores.agents.findByCapabilities(['code']).map((a) => a.id).sort()).toEqual(['coder', 'polyglot']);
    expect(stores.agents.findByCapabilities(['code', 'write']).map((a) => a.id)).toEqual(['polyglot']);
    expect(stores.agents.findByCapabilities(['nonexistent'])).toEqual([]);
    expect(stores.agents.findByCapabilities([]).length).toBeGreaterThan(0);
  });

  // ---- the generic runtime -------------------------------------------------
  describe('generic agent runtime', () => {
    it('runs a reason/act loop and returns the model output', async () => {
      stores.agents.save(define({
        id: 'loop-agent', version: '1.0.0',
        toolPermissions: ['lookup'], systemPrompt: 'You look things up.'
      }));
      const runId = makeRun('loop-agent', undefined, { query: 'weather' });

      const model = new ScriptedModelProvider([
        callTool('lookup', { q: 'weather' }),
        say('It is sunny.')
      ]);
      const tools = new ScriptedToolProvider({ lookup: (a) => `result for ${a.q}` });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      const task = stores.tasks.get({ runId, taskId: 'T1' })!;
      expect(task.state).toBe('SUCCEEDED');
      expect((task.output as { content: string }).content).toBe('It is sunny.');
      expect((task.output as { iterations: number }).iterations).toBe(2);
      expect(tools.invocations).toEqual([{ name: 'lookup', args: { q: 'weather' } }]);
      // The tool result was fed back to the model.
      expect(JSON.stringify(model.requests[1].messages)).toContain('result for weather');
    });

    it('only offers tools the definition permits', async () => {
      stores.agents.save(define({ id: 'limited', version: '1.0.0', toolPermissions: ['allowed'] }));
      const runId = makeRun('limited');
      const model = new ScriptedModelProvider([say('done')]);
      const tools = new ScriptedToolProvider({ allowed: () => 'ok', forbidden: () => 'nope' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(model.requests[0].tools?.map((t) => t.name)).toEqual(['allowed']);
    });

    it('refuses a tool the agent was not granted, even if the model invents it', async () => {
      stores.agents.save(define({ id: 'sneaky', version: '1.0.0', toolPermissions: ['allowed'] }));
      const runId = makeRun('sneaky');
      const model = new ScriptedModelProvider([callTool('forbidden'), say('gave up')]);
      const tools = new ScriptedToolProvider({ allowed: () => 'ok', forbidden: () => 'SHOULD NOT RUN' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(tools.invocations).toEqual([]);   // never invoked
      expect(JSON.stringify(model.requests[1].messages)).toContain('not permitted');
    });

    it('reports a failing tool back to the model rather than killing the task', async () => {
      stores.agents.save(define({ id: 'resilient', version: '1.0.0', toolPermissions: ['flaky'] }));
      const runId = makeRun('resilient');
      const model = new ScriptedModelProvider([callTool('flaky'), say('recovered')]);
      const tools = new ScriptedToolProvider({
        flaky: () => { throw new Error('tool exploded'); }
      });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.state).toBe('SUCCEEDED');
      expect(JSON.stringify(model.requests[1].messages)).toContain('tool exploded');
    });

    it('reads and writes memory within the permitted namespace', async () => {
      stores.agents.save(define({ id: 'remembers', version: '1.0.0', memoryPermissions: ['notes'] }));
      const memory = new InMemoryMemoryProvider();
      const runId = makeRun('remembers');
      const model = new ScriptedModelProvider([say('remembered output')]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, memory, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(await memory.read({ runId, namespace: 'notes' }, 'T1')).toBe('remembered output');
    });

    it('stops at the iteration ceiling instead of looping forever', async () => {
      stores.agents.save(define({ id: 'looper', version: '1.0.0', toolPermissions: ['spin'] }));
      const runId = makeRun('looper');
      const model = new ScriptedModelProvider([callTool('spin')]);   // never stops
      const tools = new ScriptedToolProvider({ spin: () => 'again' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage, maxIterations: 4 }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.error).toContain('MAX_ITERATIONS_EXCEEDED');
      expect(model.callCount).toBe(4);
    });
  });

  // ---- budgets (declared with ZERO code references in v0.1) ---------------
  describe('budget enforcement', () => {
    it('maxModelCalls is enforced', async () => {
      stores.agents.save(define({ id: 'budget-model', version: '1.0.0', toolPermissions: ['t'] }));
      const runId = makeRun('budget-model', { maxModelCalls: 2 });
      const model = new ScriptedModelProvider([callTool('t')]);
      const tools = new ScriptedToolProvider({ t: () => 'again' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({
          model, tools, agents: stores.agents, usage: stores.usage,
          budgetFor: (r) => stores.runs.getMeta(r)?.budget
        }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.error).toContain('maxModelCalls');
      expect(model.callCount).toBe(2);
      expect(stores.usage.get(runId).modelCalls).toBe(2);
    });

    it('maxToolCalls is enforced', async () => {
      stores.agents.save(define({ id: 'budget-tool', version: '1.0.0', toolPermissions: ['t'] }));
      const runId = makeRun('budget-tool', { maxToolCalls: 1 });
      const model = new ScriptedModelProvider([callTool('t')]);
      const tools = new ScriptedToolProvider({ t: () => 'again' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({
          model, tools, agents: stores.agents, usage: stores.usage,
          budgetFor: (r) => stores.runs.getMeta(r)?.budget
        }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.error).toContain('maxToolCalls');
      expect(tools.invocations).toHaveLength(1);
      expect(stores.usage.get(runId).toolCalls).toBe(1);
    });

    it('maxCostUsd is enforced, and spend is recorded', async () => {
      stores.agents.save(define({ id: 'budget-cost', version: '1.0.0', toolPermissions: ['t'] }));
      const runId = makeRun('budget-cost', { maxCostUsd: 0.005 });
      const pricey = { inputTokens: 100, outputTokens: 50, costUsd: 0.004 };
      const model = new ScriptedModelProvider([callTool('t', {}, pricey)]);
      const tools = new ScriptedToolProvider({ t: () => 'again' });
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({
          model, tools, agents: stores.agents, usage: stores.usage,
          budgetFor: (r) => stores.runs.getMeta(r)?.budget
        }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      expect(stores.tasks.get({ runId, taskId: 'T1' })!.error).toContain('maxCostUsd');
      const usage = stores.usage.get(runId);
      expect(usage.costUsd).toBeGreaterThan(0.005);
      expect(usage.inputTokens).toBe(200);   // two calls before the ceiling bit
    });

    it('token usage is accumulated even without a ceiling', async () => {
      stores.agents.save(define({ id: 'budget-none', version: '1.0.0' }));
      const runId = makeRun('budget-none');
      const model = new ScriptedModelProvider([say('done', { inputTokens: 42, outputTokens: 7, costUsd: 0.002 })]);
      const sup = new Supervisor(
        new GenericLLMAgentExecutor({ model, agents: stores.agents, usage: stores.usage }),
        { stores, leaseMs: 60_000 }
      );
      await sup.startRun(runId);
      await settle(runId);
      sup.close();

      const usage = stores.usage.get(runId);
      expect(usage.modelCalls).toBe(1);
      expect(usage.inputTokens).toBe(42);
      expect(usage.outputTokens).toBe(7);
      expect(usage.costUsd).toBeCloseTo(0.002, 6);
    });

    it('a reservation is atomic: the ceiling cannot be exceeded by concurrent callers', () => {
      const runId = 'ATOMIC1';
      stores.runs.save({ id: runId, goal: 'atomic', state: 'CREATED', createdAt: new Date().toISOString() });
      // Same compare-and-set discipline as the Phase B claim: the limit lives in
      // the WHERE clause, so it holds across processes.
      const granted = Array.from({ length: 20 }, () => stores.usage.reserveModelCall(runId, 5));
      expect(granted.filter(Boolean)).toHaveLength(5);
      expect(stores.usage.get(runId).modelCalls).toBe(5);
    });
  });

  // ---- the Phase G success criterion --------------------------------------
  it('SUCCESS CRITERION: two agent types run from configuration alone', async () => {
    // Two genuinely different agents, differing ONLY by their rows in `agents`
    // and the providers handed to the runtime. No kernel change, no subclass,
    // no new executor.
    stores.agents.save(define({
      id: 'researcher', version: '1.0.0', role: 'a research agent',
      capabilities: ['research'], toolPermissions: ['search'],
      systemPrompt: 'You research topics and cite sources.'
    }));
    stores.agents.save(define({
      id: 'reviewer', version: '1.0.0', role: 'a code reviewer',
      capabilities: ['review'], toolPermissions: ['read_file'],
      systemPrompt: 'You review code and report defects.'
    }));

    const runId = `AGX_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    stores.runs.save({
      id: runId, goal: 'two agent types', state: 'CREATED', createdAt: now,
      taskGraph: {
        tasks: [
          { id: 'research', runId, name: 'research', description: 'find prior art', agentDefinitionId: 'researcher', state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0 },
          { id: 'review', runId, name: 'review', description: 'review the patch', agentDefinitionId: 'reviewer', state: 'PENDING', createdAt: now, retriesAllowed: 0, retriesAttempted: 0 }
        ],
        dependencies: [{ taskId: 'review', dependsOn: 'research' }]
      }
    });

    const model = new ScriptedModelProvider([
      callTool('search', { q: 'prior art' }),
      say('Found three relevant papers.'),
      callTool('read_file', { path: 'patch.diff' }),
      say('Two defects found.')
    ]);
    const tools = new ScriptedToolProvider({
      search: (a) => `results for ${a.q}`,
      read_file: (a) => `contents of ${a.path}`
    });

    const sup = new Supervisor(
      new GenericLLMAgentExecutor({ model, tools, agents: stores.agents, usage: stores.usage }),
      { stores, workerId: 'w-two-types', leaseMs: 60_000 }
    );
    await sup.startRun(runId);
    const run = await settle(runId);
    sup.close();

    expect(run.state).toBe('COMPLETED');

    const research = stores.tasks.get({ runId, taskId: 'research' })!;
    const review = stores.tasks.get({ runId, taskId: 'review' })!;
    expect((research.output as { content: string }).content).toBe('Found three relevant papers.');
    expect((review.output as { content: string }).content).toBe('Two defects found.');

    // Each task ran as its OWN agent, with its own system prompt and its own tool.
    const instances = stores.instances.listByRun(runId);
    expect(instances.map((i) => i.definitionId).sort()).toEqual(['researcher', 'reviewer']);
    expect(instances.every((i) => i.state === 'TERMINATED')).toBe(true);

    const prompts = model.requests.map((r) => r.messages[0].content);
    expect(prompts).toContain('You research topics and cite sources.');
    expect(prompts).toContain('You review code and report defects.');

    // Tool permissions were honoured per agent.
    expect(tools.invocations.map((i) => i.name)).toEqual(['search', 'read_file']);
    expect(stores.usage.get(runId).modelCalls).toBe(4);
  });
});
