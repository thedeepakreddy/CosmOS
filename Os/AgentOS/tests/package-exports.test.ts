import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A9: AgentOS must be consumable as a package.
 *
 * Before Phase A, package.json declared `main: "index.js"` -- a file that did
 * not exist -- with no `exports`, `types` or `files`. A platform whose stated
 * purpose is reuse had no working import path.
 *
 * This test builds the package and imports it from a consumer project OUTSIDE
 * the repository, resolving through the real `exports` map (bare specifier
 * resolution), not by reaching into `dist/` by relative path.
 */
const REPO = path.join(__dirname, '..');

describe('Package entry point (A9)', () => {
  let consumerDir: string;

  beforeAll(() => {
    // Build so the test always exercises the current source, never a stale dist.
    execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'pipe' });

    consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-consumer-'));
    fs.mkdirSync(path.join(consumerDir, 'node_modules'), { recursive: true });
    // Symlink rather than copy: bare-specifier resolution still goes through
    // the package's own `exports` / `main` / `types` fields.
    fs.symlinkSync(REPO, path.join(consumerDir, 'node_modules', 'agentos'), 'dir');
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'agentos-consumer', version: '1.0.0', private: true }, null, 2)
    );
  });

  afterAll(() => {
    if (consumerDir) fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  it('declares a main and types entry point that exist on disk', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(fs.existsSync(path.join(REPO, pkg.main))).toBe(true);
    expect(fs.existsSync(path.join(REPO, pkg.types))).toBe(true);
  });

  it('can be required by an external consumer and exposes the public API', () => {
    const script = `
      const AgentOS = require('agentos');
      const expected = [
        'Supervisor', 'DAGValidator', 'buildServer', 'AgentOSClient',
        'DEFAULT_MAX_CONCURRENCY',
        'AgentDefinitionSchema', 'TaskSchema', 'TaskGraphSchema',
        'AgentRunSchema', 'ExecutionBudgetSchema'
      ];
      const missing = expected.filter((k) => AgentOS[k] === undefined);
      console.log(JSON.stringify({ missing, keys: Object.keys(AgentOS).sort() }));
    `;
    fs.writeFileSync(path.join(consumerDir, 'consume.js'), script);
    const out = execFileSync('node', ['consume.js'], { cwd: consumerDir, encoding: 'utf-8' });
    const result = JSON.parse(out);

    expect(result.missing).toEqual([]);
    expect(result.keys).toContain('Supervisor');
    expect(result.keys).toContain('AgentOSClient');
  });

  it('does NOT leak internal persistence implementation', () => {
    const script = `
      const AgentOS = require('agentos');
      const leaked = ['RunRepository','TaskRepository','AgentRepository','EventRepository',
                      'getDb','closeDb','runMigrations'].filter((k) => AgentOS[k] !== undefined);
      console.log(JSON.stringify({ leaked }));
    `;
    fs.writeFileSync(path.join(consumerDir, 'leak.js'), script);
    const out = execFileSync('node', ['leak.js'], { cwd: consumerDir, encoding: 'utf-8' });
    expect(JSON.parse(out).leaked).toEqual([]);
  });

  it('is usable at runtime, not merely importable', () => {
    const script = `
      const { DAGValidator } = require('agentos');
      let duplicateRejected = false;
      try {
        DAGValidator.validate({
          tasks: [
            { id: 'A', name: 'a', description: '', agentDefinitionId: 'x', state: 'PENDING', retriesAllowed: 0, retriesAttempted: 0 },
            { id: 'A', name: 'b', description: '', agentDefinitionId: 'x', state: 'PENDING', retriesAllowed: 0, retriesAttempted: 0 }
          ],
          dependencies: []
        });
      } catch (e) { duplicateRejected = /DUPLICATE_TASK_ID/.test(e.message); }
      console.log(JSON.stringify({ duplicateRejected }));
    `;
    fs.writeFileSync(path.join(consumerDir, 'use.js'), script);
    const out = execFileSync('node', ['use.js'], { cwd: consumerDir, encoding: 'utf-8' });
    expect(JSON.parse(out).duplicateRejected).toBe(true);
  });

  it('ships type declarations that a TypeScript consumer can compile against', () => {
    fs.writeFileSync(
      path.join(consumerDir, 'consume.ts'),
      [
        "import { Supervisor, DAGValidator, AgentOSClient } from 'agentos';",
        "import type { AgentExecutor, Task, TaskGraph, ExecutionBudget } from 'agentos';",
        '',
        'const executor: AgentExecutor = {',
        '  async execute(_agent, _task, _ctx) { return { status: "SUCCEEDED", output: 1 }; }',
        '};',
        'const supervisor = new Supervisor(executor);',
        'const client = new AgentOSClient("http://127.0.0.1:1");',
        'const budget: ExecutionBudget = { maxTasks: 1 };',
        'const graph: TaskGraph = { tasks: [] as Task[], dependencies: [] };',
        'DAGValidator.validate(graph);',
        'void supervisor; void client; void budget;'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(consumerDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'es2022',
            module: 'commonjs',
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
            moduleResolution: 'node',
            types: []
          },
          files: ['consume.ts']
        },
        null,
        2
      )
    );

    // Compiles against the published .d.ts via bare-specifier resolution.
    // Throws (non-zero exit) if the declarations are missing or wrong.
    const tsc = path.join(REPO, 'node_modules', '.bin', 'tsc');
    expect(() =>
      execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: consumerDir, stdio: 'pipe' })
    ).not.toThrow();
  });
});
