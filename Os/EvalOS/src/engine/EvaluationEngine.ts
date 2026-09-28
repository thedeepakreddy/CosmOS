import pLimit from 'p-limit';
import { Repositories } from '../repositories';
import { globalEventBus } from '../events/EventBus';
import { EvaluationRun, CaseExecution } from '../contracts/Domain';
import { CandidateAdapter } from '../contracts/Candidate';
import { Evaluator } from '../contracts/Evaluator';
import { validateRunTransition, validateCaseTransition } from '../domain/StateMachines';

export class EvaluationEngine {
  constructor(
    private repos: Repositories,
    private getCandidate: (id: string, version: string) => CandidateAdapter | null,
    private getEvaluator: (id: string) => Evaluator | null,
    private maxConcurrency: number = 4,
  ) {}

  async startRun(runId: string): Promise<void> {
    const run = this.repos.runs.getById(runId);
    if (!run) throw new Error('Run ' + runId + ' not found');

    validateRunTransition(run.status, 'RUNNING');
    run.status = 'RUNNING';
    run.startTime = new Date();
    this.repos.runs.updateStatus(run.id, 'RUNNING');
    globalEventBus.publish('eval.run.started', { runId });

    const suite = this.repos.suites.getById(run.suiteId);
    if (!suite) throw new Error('Suite ' + run.suiteId + ' not found');

    const candidate = this.getCandidate(run.candidateId, run.candidateVersion);
    if (!candidate) {
      this.failRun(run, 'CANDIDATE_NOT_FOUND', 'Candidate ' + run.candidateId + ' not found');
      return;
    }

    try {
      const health = await candidate.health();
      if (health.status !== 'healthy') {
        this.failRun(run, 'CANDIDATE_UNAVAILABLE', 'Candidate is ' + health.status + ': ' + health.reason);
        return;
      }

      const limit = pLimit(this.maxConcurrency);
      const caseExecutions = this.repos.caseExecutions.getByRunId(runId);

      const tasks = caseExecutions.map((exec) => limit(() => this.executeCase(run, exec, candidate)));
      await Promise.all(tasks);

      validateRunTransition(run.status, 'COMPLETED');
      this.repos.runs.updateStatus(run.id, 'COMPLETED', new Date());
      globalEventBus.publish('eval.run.completed', { runId });
    } catch (err: any) {
      this.failRun(run, 'EVALUATION_FAILED', err.message);
    }
  }

  private failRun(run: EvaluationRun, code: string, message: string) {
    try {
      validateRunTransition(run.status, 'FAILED');
    } catch {
      // already in terminal state
      return;
    }
    this.repos.runs.updateStatus(run.id, 'FAILED', new Date());
    globalEventBus.publish('eval.run.failed', { runId: run.id, error: { code, message } });
  }

  private async executeCase(run: EvaluationRun, exec: CaseExecution, candidate: CandidateAdapter) {
    validateCaseTransition(exec.status, 'RUNNING');
    exec.status = 'RUNNING';
    exec.startTime = new Date();
    this.repos.caseExecutions.update(exec.id, { status: 'RUNNING' });
    globalEventBus.publish('eval.case.started', { runId: run.id, caseId: exec.caseId, executionId: exec.id });

    const evalCase = this.repos.cases.getById(exec.caseId);
    if (!evalCase) {
      validateCaseTransition(exec.status, 'FAILED');
      this.repos.caseExecutions.update(exec.id, {
        status: 'FAILED',
        error: { code: 'CASE_NOT_FOUND', message: 'Case not found' },
        endTime: new Date(),
      });
      return;
    }

    let isTimeout = false;
    let candidateResult: any;

    try {
      const startMs = Date.now();
      const executePromise = candidate.execute(evalCase.input, { runId: run.id, caseId: exec.caseId });

      if (evalCase.timeoutMs) {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => {
              isTimeout = true;
              reject(new Error('TIMEOUT'));
            },
            evalCase.timeoutMs,
          ),
        );
        candidateResult = await Promise.race([executePromise, timeoutPromise]);
      } else {
        candidateResult = await executePromise;
      }

      if (candidateResult.latencyMs === undefined) {
        candidateResult.latencyMs = Date.now() - startMs;
      }

      if (candidateResult.error) {
        throw new Error(candidateResult.error.message || 'Candidate failed');
      }

      // Run Evaluators
      for (const evalRef of evalCase.evaluators) {
        const evaluator = this.getEvaluator(evalRef);
        if (!evaluator) {
          throw new Error('Evaluator ' + evalRef + ' not found');
        }

        const scores = await evaluator.evaluate(candidateResult, {
          runId: run.id,
          caseId: exec.caseId,
          expectedBehavior: evalCase.expectedBehavior,
        });

        for (const score of scores) {
          this.repos.scores.create(exec.id, run.id, score);
          globalEventBus.publish('eval.score.recorded', { runId: run.id, executionId: exec.id, score });
        }
      }

      validateCaseTransition(exec.status, 'SUCCEEDED');
      this.repos.caseExecutions.update(exec.id, { status: 'SUCCEEDED', result: candidateResult, endTime: new Date() });
      globalEventBus.publish('eval.case.completed', { runId: run.id, executionId: exec.id });
    } catch (err: any) {
      if (isTimeout) {
        validateCaseTransition(exec.status, 'TIMED_OUT');
        this.repos.caseExecutions.update(exec.id, {
          status: 'TIMED_OUT',
          error: { code: 'EVALUATION_TIMEOUT', message: 'Candidate execution timed out' },
          endTime: new Date(),
        });
        globalEventBus.publish('eval.case.timed_out', { runId: run.id, executionId: exec.id });
      } else {
        validateCaseTransition(exec.status, 'FAILED');
        this.repos.caseExecutions.update(exec.id, {
          status: 'FAILED',
          error: { code: 'CANDIDATE_FAILED', message: err.message },
          endTime: new Date(),
        });
        globalEventBus.publish('eval.case.failed', { runId: run.id, executionId: exec.id, error: err.message });
      }
    }
  }
}
