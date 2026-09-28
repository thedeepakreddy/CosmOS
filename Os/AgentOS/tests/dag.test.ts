import { describe, it, expect } from 'vitest';
import { DAGValidator } from '../src/engine/DAGValidator';
import { TaskGraph, Task } from '../src/domain/types';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  runId: 'run',
  name: id,
  description: '',
  agentDefinitionId: 'a',
  state: 'PENDING',
  retriesAllowed: 0,
  retriesAttempted: 0,
  ...extra
});

describe('DAGValidator', () => {
  it('should allow a valid linear DAG', () => {
    const graph: TaskGraph = {
      tasks: [task('1'), task('2')],
      dependencies: [{ taskId: '2', dependsOn: '1' }]
    };
    expect(() => DAGValidator.validate(graph)).not.toThrow();
  });

  it('should detect self-cycle', () => {
    const graph: TaskGraph = {
      tasks: [task('1')],
      dependencies: [{ taskId: '1', dependsOn: '1' }]
    };
    expect(() => DAGValidator.validate(graph)).toThrow('CYCLE_DETECTED');
  });

  it('should detect multi-node cycle', () => {
    const graph: TaskGraph = {
      tasks: [task('1'), task('2')],
      dependencies: [
        { taskId: '2', dependsOn: '1' },
        { taskId: '1', dependsOn: '2' }
      ]
    };
    expect(() => DAGValidator.validate(graph)).toThrow('CYCLE_DETECTED');
  });

  it('should reject missing dependency', () => {
    const graph: TaskGraph = {
      tasks: [task('1')],
      dependencies: [{ taskId: '1', dependsOn: 'UNKNOWN' }]
    };
    expect(() => DAGValidator.validate(graph)).toThrow('UNKNOWN_DEPENDS_ON: UNKNOWN');
  });

  it('should reject a dependency whose dependent task is unknown', () => {
    const graph: TaskGraph = {
      tasks: [task('1')],
      dependencies: [{ taskId: 'GHOST', dependsOn: '1' }]
    };
    expect(() => DAGValidator.validate(graph)).toThrow('UNKNOWN_TASK_ID: GHOST');
  });

  // --- A1: duplicate task IDs ------------------------------------------------
  describe('duplicate task IDs (A1)', () => {
    it('rejects two tasks sharing an id', () => {
      const graph: TaskGraph = {
        tasks: [task('A'), task('A'), task('B')],
        dependencies: []
      };
      expect(() => DAGValidator.validate(graph)).toThrow('DUPLICATE_TASK_ID: A');
    });

    it('rejects duplicate ids even when their payloads differ', () => {
      const graph: TaskGraph = {
        tasks: [
          task('X', { name: 'first', input: { owner: 'first' } }),
          task('X', { name: 'second', input: { owner: 'second' } })
        ],
        dependencies: []
      };
      expect(() => DAGValidator.validate(graph)).toThrow('DUPLICATE_TASK_ID: X');
    });

    it('reports the first duplicate id deterministically', () => {
      const graph: TaskGraph = {
        tasks: [task('P'), task('Q'), task('Q'), task('P')],
        dependencies: []
      };
      expect(() => DAGValidator.validate(graph)).toThrow('DUPLICATE_TASK_ID: Q');
    });

    it('accepts a single unique task', () => {
      expect(() => DAGValidator.validate({ tasks: [task('only')], dependencies: [] })).not.toThrow();
    });

    it('accepts a large graph with unique ids', () => {
      const tasks = Array.from({ length: 5000 }, (_, i) => task(`t${i}`));
      const dependencies = Array.from({ length: 4999 }, (_, i) => ({
        taskId: `t${i + 1}`,
        dependsOn: `t${i}`
      }));
      expect(() => DAGValidator.validate({ tasks, dependencies })).not.toThrow();
    });

    it('detects a duplicate hidden inside a large graph', () => {
      const tasks = Array.from({ length: 2000 }, (_, i) => task(`t${i}`));
      tasks.push(task('t1337'));
      expect(() => DAGValidator.validate({ tasks, dependencies: [] })).toThrow(
        'DUPLICATE_TASK_ID: t1337'
      );
    });
  });

  // --- graph shape -----------------------------------------------------------
  describe('graph shapes', () => {
    it('accepts a diamond', () => {
      const graph: TaskGraph = {
        tasks: ['A', 'B', 'C', 'D'].map((id) => task(id)),
        dependencies: [
          { taskId: 'B', dependsOn: 'A' },
          { taskId: 'C', dependsOn: 'A' },
          { taskId: 'D', dependsOn: 'B' },
          { taskId: 'D', dependsOn: 'C' }
        ]
      };
      expect(() => DAGValidator.validate(graph)).not.toThrow();
    });

    it('accepts disconnected components', () => {
      const graph: TaskGraph = {
        tasks: ['A', 'B', 'C', 'D'].map((id) => task(id)),
        dependencies: [
          { taskId: 'B', dependsOn: 'A' },
          { taskId: 'D', dependsOn: 'C' }
        ]
      };
      expect(() => DAGValidator.validate(graph)).not.toThrow();
    });

    it('accepts a wide graph: one root, 5000 children', () => {
      const tasks = [task('root'), ...Array.from({ length: 5000 }, (_, i) => task(`w${i}`))];
      const dependencies = Array.from({ length: 5000 }, (_, i) => ({
        taskId: `w${i}`,
        dependsOn: 'root'
      }));
      expect(() => DAGValidator.validate({ tasks, dependencies })).not.toThrow();
    });

    it('accepts a deep chain that previously overflowed the call stack', () => {
      // The old recursive DFS threw RangeError: Maximum call stack size exceeded
      // at ~10k depth, surfacing a V8 error as a domain error. The traversal is
      // now iterative.
      const n = 25_000;
      const tasks = Array.from({ length: n }, (_, i) => task(`d${i}`));
      const dependencies = Array.from({ length: n - 1 }, (_, i) => ({
        taskId: `d${i + 1}`,
        dependsOn: `d${i}`
      }));
      expect(() => DAGValidator.validate({ tasks, dependencies })).not.toThrow();
    });

    it('still detects a cycle at the end of a deep chain', () => {
      const n = 25_000;
      const tasks = Array.from({ length: n }, (_, i) => task(`d${i}`));
      const dependencies = Array.from({ length: n - 1 }, (_, i) => ({
        taskId: `d${i + 1}`,
        dependsOn: `d${i}`
      }));
      dependencies.push({ taskId: 'd0', dependsOn: `d${n - 1}` });
      expect(() => DAGValidator.validate({ tasks, dependencies })).toThrow('CYCLE_DETECTED');
    });
  });
});
