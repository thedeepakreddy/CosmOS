import { EventEmitter } from 'events';

export interface EvalEvent {
  eventType: string;
  payload: any;
  timestamp: Date;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Prevent MaxListenersExceededWarning
    this.emitter.setMaxListeners(100);
  }

  publish(eventType: string, payload: any) {
    const event: EvalEvent = {
      eventType,
      payload,
      timestamp: new Date(),
    };
    this.emitter.emit(eventType, event);
    this.emitter.emit('*', event); // Wildcard for logging/persistence
  }

  subscribe(eventType: string, handler: (event: EvalEvent) => void) {
    this.emitter.on(eventType, handler);
  }
}

export const globalEventBus = new EventBus();
