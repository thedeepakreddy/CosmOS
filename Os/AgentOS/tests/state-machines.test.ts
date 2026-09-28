import { describe, it, expect } from 'vitest';
import {
  RUN_TRANSITIONS, TASK_TRANSITIONS,
  TERMINAL_RUN_STATES, TERMINAL_TASK_STATES,
  isTerminalRunState, isTerminalTaskState,
  canTransitionRun, canTransitionTask,
  assertRunTransition, assertTaskTransition
} from '../src/domain/stateMachines';
import { RunStateSchema, TaskStateSchema, RunState, TaskState } from '../src/domain/types';

/**
 * Phase C: the transition tables themselves.
 *
 * The audit's hostile-transition list is asserted directly here, so a future
 * edit that re-opens a terminal state fails immediately rather than being
 * discovered by a fuzz run months later.
 */
describe('State machine tables (Phase C)', () => {
  const ALL_RUN = RunStateSchema.options as RunState[];
  const ALL_TASK = TaskStateSchema.options as TaskState[];

  it('the tables cover every declared state, and no others', () => {
    expect(Object.keys(RUN_TRANSITIONS).sort()).toEqual([...ALL_RUN].sort());
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...ALL_TASK].sort());
  });

  it('every transition target is itself a declared state', () => {
    for (const [from, tos] of Object.entries(RUN_TRANSITIONS)) {
      for (const to of tos) expect(ALL_RUN, `run ${from} -> ${to}`).toContain(to);
    }
    for (const [from, tos] of Object.entries(TASK_TRANSITIONS)) {
      for (const to of tos) expect(ALL_TASK, `task ${from} -> ${to}`).toContain(to);
    }
  });

  it('terminal states have NO outgoing transitions', () => {
    for (const s of TERMINAL_RUN_STATES) expect(RUN_TRANSITIONS[s]).toEqual([]);
    for (const s of TERMINAL_TASK_STATES) expect(TASK_TRANSITIONS[s]).toEqual([]);
  });

  it('a state is terminal exactly when it has no outgoing transitions', () => {
    for (const s of ALL_RUN) expect(isTerminalRunState(s)).toBe(RUN_TRANSITIONS[s].length === 0);
    for (const s of ALL_TASK) expect(isTerminalTaskState(s)).toBe(TASK_TRANSITIONS[s].length === 0);
  });

  // ---- the audit's hostile sequences --------------------------------------
  describe('hostile transitions are refused', () => {
    const forbiddenRuns: Array<[RunState, RunState]> = [
      ['COMPLETED', 'RUNNING'],
      ['FAILED', 'RUNNING'],
      ['CANCELLED', 'RUNNING'],
      ['TIMED_OUT', 'RUNNING'],
      ['COMPLETED', 'CANCELLED'],
      ['COMPLETED', 'PAUSING'],
      ['CANCELLED', 'COMPLETED'],
      ['PAUSED', 'COMPLETED']
    ];
    for (const [from, to] of forbiddenRuns) {
      it(`run ${from} -> ${to}`, () => {
        expect(canTransitionRun(from, to)).toBe(false);
        expect(() => assertRunTransition(from, to)).toThrow('INVALID_RUN_TRANSITION');
      });
    }

    const forbiddenTasks: Array<[TaskState, TaskState]> = [
      ['SUCCEEDED', 'RUNNING'],
      ['FAILED', 'RUNNING'],
      ['CANCELLED', 'RUNNING'],
      ['TIMED_OUT', 'RUNNING'],
      ['SKIPPED', 'READY'],
      ['SUCCEEDED', 'FAILED'],
      ['CANCELLED', 'SUCCEEDED'],
      ['PENDING', 'RUNNING']   // RUNNING is reachable only by winning a claim
    ];
    for (const [from, to] of forbiddenTasks) {
      it(`task ${from} -> ${to}`, () => {
        expect(canTransitionTask(from, to)).toBe(false);
        expect(() => assertTaskTransition(from, to)).toThrow('INVALID_TASK_TRANSITION');
      });
    }
  });

  describe('legal transitions are allowed', () => {
    it('the normal run lifecycle', () => {
      expect(canTransitionRun('CREATED', 'RUNNING')).toBe(true);
      expect(canTransitionRun('RUNNING', 'COMPLETED')).toBe(true);
      expect(canTransitionRun('RUNNING', 'PAUSING')).toBe(true);
      expect(canTransitionRun('PAUSING', 'PAUSED')).toBe(true);
      expect(canTransitionRun('PAUSED', 'RUNNING')).toBe(true);
    });

    it('PAUSING -> RUNNING, so a crash mid-pause is recoverable', () => {
      // v0.1 had no path out of PAUSING: a crash there stranded the run for good.
      expect(canTransitionRun('PAUSING', 'RUNNING')).toBe(true);
    });

    it('the normal task lifecycle, including requeue and drain', () => {
      expect(canTransitionTask('PENDING', 'READY')).toBe(true);
      expect(canTransitionTask('READY', 'RUNNING')).toBe(true);
      expect(canTransitionTask('RUNNING', 'SUCCEEDED')).toBe(true);
      expect(canTransitionTask('RUNNING', 'READY')).toBe(true);      // retry / reclaim
      expect(canTransitionTask('RUNNING', 'CANCELLED')).toBe(true);  // terminal drain
      expect(canTransitionTask('READY', 'CANCELLED')).toBe(true);    // terminal drain
      expect(canTransitionTask('PENDING', 'SKIPPED')).toBe(true);
    });

    it('every non-terminal state can reach a terminal one', () => {
      const reaches = (start: TaskState): boolean => {
        const seen = new Set<TaskState>();
        const stack: TaskState[] = [start];
        while (stack.length) {
          const s = stack.pop()!;
          if (seen.has(s)) continue;
          seen.add(s);
          if (isTerminalTaskState(s)) return true;
          stack.push(...TASK_TRANSITIONS[s]);
        }
        return false;
      };
      for (const s of ALL_TASK) expect(reaches(s), `${s} cannot reach a terminal state`).toBe(true);
    });
  });
});
