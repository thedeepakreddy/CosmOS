export type AuditEvent = 
  | { type: "tool.registered", toolId: string }
  | { type: "tool.unregistered", toolId: string }
  | { type: "executor.online", executorId: string }
  | { type: "executor.offline", executorId: string }
  | { type: "execution.requested", executionId: string, caller: string, request: unknown }
  | { type: "execution.authorized", executionId: string }
  | { type: "execution.denied", executionId: string, reason: string }
  | { type: "execution.started", executionId: string, executorId: string }
  | { type: "execution.succeeded", executionId: string, durationMs: number }
  | { type: "execution.failed", executionId: string, errorCategory: string }
  | { type: "execution.timed_out", executionId: string }
  | { type: "execution.cancelled", executionId: string };

export class EventBus {
  private listeners: Array<(event: AuditEvent) => void> = [];

  public subscribe(listener: (event: AuditEvent) => void) {
    this.listeners.push(listener);
  }

  public emit(event: AuditEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in event listener", err);
      }
    }
  }
}
