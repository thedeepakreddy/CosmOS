import { TaskGraph } from '../domain/types';

export class DAGValidator {
  /**
   * Validate a task graph. Throws on the first problem found.
   *
   * Error codes are deterministic and stable, so callers (and the API layer)
   * can map them without string-sniffing free text:
   *   DUPLICATE_TASK_ID:<id>
   *   UNKNOWN_TASK_ID:<id>
   *   UNKNOWN_DEPENDS_ON:<id>
   *   CYCLE_DETECTED
   */
  static validate(graph: TaskGraph): void {
    // --- A1: duplicate task IDs -------------------------------------------
    // Task IDs are the primary key. Two tasks sharing an ID collapse into one
    // row on upsert, so the graph the caller submitted is not the graph that
    // runs -- and the run still reports COMPLETED. Reject before anything is
    // persisted.
    const taskIds = new Set<string>();
    for (const task of graph.tasks) {
      if (taskIds.has(task.id)) {
        throw new Error(`DUPLICATE_TASK_ID: ${task.id}`);
      }
      taskIds.add(task.id);
    }

    // --- dependency references must resolve --------------------------------
    for (const dep of graph.dependencies) {
      if (!taskIds.has(dep.taskId)) {
        throw new Error(`UNKNOWN_TASK_ID: ${dep.taskId}`);
      }
      if (!taskIds.has(dep.dependsOn)) {
        throw new Error(`UNKNOWN_DEPENDS_ON: ${dep.dependsOn}`);
      }
    }

    // --- cycle detection ----------------------------------------------------
    // Iterative depth-first search with an explicit stack. The previous
    // implementation recursed and overflowed the call stack at ~10k depth,
    // surfacing a V8 RangeError as a domain error. Self-dependencies are caught
    // here too, as a cycle of length one.
    const adj = new Map<string, string[]>();
    for (const id of taskIds) adj.set(id, []);
    for (const dep of graph.dependencies) {
      adj.get(dep.dependsOn)!.push(dep.taskId);
    }

    const UNVISITED = 0;
    const IN_PROGRESS = 1;
    const DONE = 2;
    const state = new Map<string, number>();
    for (const id of taskIds) state.set(id, UNVISITED);

    for (const root of taskIds) {
      if (state.get(root) !== UNVISITED) continue;

      // Each frame is [node, indexOfNextNeighbourToVisit].
      const stack: Array<[string, number]> = [[root, 0]];
      state.set(root, IN_PROGRESS);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const [node, next] = frame;
        const neighbours = adj.get(node)!;

        if (next >= neighbours.length) {
          state.set(node, DONE);
          stack.pop();
          continue;
        }

        frame[1]++;
        const neighbour = neighbours[next];
        const neighbourState = state.get(neighbour);

        if (neighbourState === IN_PROGRESS) {
          throw new Error('CYCLE_DETECTED');
        }
        if (neighbourState === UNVISITED) {
          state.set(neighbour, IN_PROGRESS);
          stack.push([neighbour, 0]);
        }
      }
    }
  }
}
