import { RunStatus, CaseExecutionStatus } from '../contracts/Domain';

const runTransitions: Record<RunStatus, RunStatus[]> = {
  CREATED: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

const caseTransitions: Record<CaseExecutionStatus, CaseExecutionStatus[]> = {
  PENDING: ['RUNNING', 'SKIPPED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
  SKIPPED: [],
};

export class InvalidStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`INVALID_STATE_TRANSITION: Cannot transition ${entity} from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export function validateRunTransition(current: RunStatus, next: RunStatus) {
  if (!runTransitions[current].includes(next)) {
    throw new InvalidStateTransitionError('EvaluationRun', current, next);
  }
}

export function validateCaseTransition(current: CaseExecutionStatus, next: CaseExecutionStatus) {
  if (!caseTransitions[current].includes(next)) {
    throw new InvalidStateTransitionError('CaseExecution', current, next);
  }
}
