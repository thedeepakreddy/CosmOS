import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/EventBus';

describe('EventBus', () => {
  it('should register a subscriber and receive correct event', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    
    bus.subscribe('eval.run.started', handler);
    bus.publish('eval.run.started', { runId: 'run-123' });
    
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'eval.run.started',
      payload: { runId: 'run-123' }
    }));
  });

  it('should not trigger subscriber for unrelated events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    
    bus.subscribe('eval.run.started', handler);
    bus.publish('eval.case.completed', { caseId: 'case-abc' });
    
    expect(handler).not.toHaveBeenCalled();
  });
});
