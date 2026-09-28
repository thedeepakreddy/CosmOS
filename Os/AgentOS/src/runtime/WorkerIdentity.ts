import os from 'os';
import { v4 as uuidv4 } from 'uuid';

/**
 * B3: worker identity.
 *
 * Every AgentOS process that executes tasks owns a stable `workerId` for its
 * lifetime. It is the durable ownership identity recorded on a claimed task.
 *
 * Shape: `<hostname>-<pid>-<uuid>`
 *   - hostname + pid make it diagnosable (you can find the machine and process)
 *   - the uuid makes it unique even when a PID is recycled after a crash, which
 *     matters because a reclaim can happen after the original process is gone
 *
 * Deliberately NOT derived from the task, the run, or anything a client sends.
 * It is generated inside the process and is never accepted from an API caller,
 * so an external client cannot impersonate a worker and steal ownership.
 */
export function createWorkerId(): string {
  return `${os.hostname()}-${process.pid}-${uuidv4()}`;
}

/** The workerId for this process. Stable for the process lifetime. */
export const CURRENT_WORKER_ID: string = createWorkerId();

/** Extract the PID embedded in a workerId, for diagnostics only. */
export function pidOf(workerId: string): number | null {
  const parts = workerId.split('-');
  const pid = Number(parts[parts.length - 6]);
  return Number.isFinite(pid) ? pid : null;
}
