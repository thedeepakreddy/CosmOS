import { TaskGraph } from '../domain/types';

export interface Planner {
  plan(goal: string, context?: unknown): Promise<TaskGraph>;
}
