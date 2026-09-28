import { RunState, TaskState } from './types';

/**
 * Phase C: the state machines, in one place.
 *
 * Before this, transitions were scattered through Supervisor as ad-hoc
 * assignments (`run.state = 'FAILED'`). Nothing declared which moves were legal,
 * so "terminal" was a convention rather than a rule -- and the audit found
 * cancelled work transitioning to SUCCEEDED, and 27.5% of terminal runs leaving
 * live tasks behind.
 *
 * The vocabulary is unchanged. Only the guards are new.
 */

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT'
] as const;

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'SKIPPED'
] as const;

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** Legal run transitions. A terminal state has no outgoing edges, by construction. */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED:   ['PLANNING', 'READY', 'RUNNING', 'CANCELLED'],
  PLANNING:  ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  READY:     ['RUNNING', 'CANCELLED', 'FAILED'],
  // PAUSING is reachable back to RUNNING: a crash mid-pause must not strand the
  // run, which it did in v0.1.
  RUNNING:   ['PAUSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  PAUSING:   ['PAUSED', 'RUNNING', 'CANCELLED', 'FAILED', 'COMPLETED', 'TIMED_OUT'],
  PAUSED:    ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED:    [],
  CANCELLED: [],
  TIMED_OUT: []
};

/** Legal task transitions. */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  PENDING:   ['BLOCKED', 'READY', 'SKIPPED', 'CANCELLED'],
  BLOCKED:   ['READY', 'SKIPPED', 'CANCELLED'],
  // READY -> RUNNING happens only by winning an atomic claim (Phase B).
  READY:     ['RUNNING', 'CANCELLED', 'SKIPPED'],
  // RUNNING -> READY is a retry requeue or a lease reclaim, both guarded.
  RUNNING:   ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'READY'],
  SUCCEEDED: [],
  FAILED:    [],
  CANCELLED: [],
  TIMED_OUT: [],
  SKIPPED:   []
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`INVALID_RUN_TRANSITION: ${from} -> ${to}`);
  }
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`INVALID_TASK_TRANSITION: ${from} -> ${to}`);
  }
}

/** Every run state that is NOT terminal -- the set a terminal transition may come from. */
export const NON_TERMINAL_RUN_STATES: readonly RunState[] =
  (Object.keys(RUN_TRANSITIONS) as RunState[]).filter((s) => !isTerminalRunState(s));
