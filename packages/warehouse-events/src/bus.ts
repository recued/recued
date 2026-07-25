import { eventPath, matchesPattern } from './glob.js';
import type {
  WarehouseEvent,
  WarehouseEventBus,
  WarehouseEventListener,
} from './types.js';

interface Subscription {
  pattern: string;
  listener: WarehouseEventListener;
}

export const createWarehouseEventBus = (): WarehouseEventBus => {
  const subs = new Set<Subscription>();

  const emit = (event: WarehouseEvent): void => {
    const path = eventPath(event.platform, event.slug, event.entity_type, event.event_kind);
    for (const sub of subs) {
      if (!matchesPattern(sub.pattern, path)) continue;
      try { sub.listener(event); } catch { /* listener never crashes the bus */ }
    }
  };

  const subscribe = (pattern: string, listener: WarehouseEventListener): (() => void) => {
    const sub: Subscription = { pattern, listener };
    subs.add(sub);
    return () => { subs.delete(sub); };
  };

  const dispose = (): void => { subs.clear(); };

  return { emit, subscribe, dispose };
};
