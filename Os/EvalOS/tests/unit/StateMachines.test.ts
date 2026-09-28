import { describe, it, expect } from 'vitest';
import { validateRunTransition, validateCaseTransition, InvalidStateTransitionError } from '../../src/domain/StateMachines';

describe('StateMachines', () => {
  describe('EvaluationRun', () => {
    it('allows valid transitions', () => {
      expect(() => validateRunTransition('CREATED', 'READY')).not.toThrow();
      expect(() => validateRunTransition('READY', 'RUNNING')).not.toThrow();
      expect(() => validateRunTransition('RUNNING', 'COMPLETED')).not.toThrow();
    });

    it('rejects invalid transitions', () => {
      expect(() => validateRunTransition('COMPLETED', 'RUNNING')).toThrow(InvalidStateTransitionError);
      expect(() => validateRunTransition('CANCELLED', 'RUNNING')).toThrow(InvalidStateTransitionError);
      expect(() => validateRunTransition('FAILED', 'READY')).toThrow(InvalidStateTransitionError);
    });
  });

  describe('CaseExecution', () => {
    it('allows valid transitions', () => {
      expect(() => validateCaseTransition('PENDING', 'RUNNING')).not.toThrow();
      expect(() => validateCaseTransition('RUNNING', 'SUCCEEDED')).not.toThrow();
      expect(() => validateCaseTransition('RUNNING', 'FAILED')).not.toThrow();
    });

    it('rejects invalid transitions', () => {
      expect(() => validateCaseTransition('SUCCEEDED', 'RUNNING')).toThrow(InvalidStateTransitionError);
      expect(() => validateCaseTransition('FAILED', 'PENDING')).toThrow(InvalidStateTransitionError);
    });
  });
});
