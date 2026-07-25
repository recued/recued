import { describe, it, expect } from 'vitest';
import { createEventBus } from '../event-bus.js';

describe('event bus — pub/sub basics', () => {
  it('emits to subscribed listener', () => {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe((e) => { received.push(e); });
    bus.emit({ collection: 'emails', verb: 'arrived' });
    expect(received).toEqual([{ collection: 'emails', verb: 'arrived' }]);
  });

  it('emits to multiple listeners', () => {
    const bus = createEventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe((e) => { a.push(e); });
    bus.subscribe((e) => { b.push(e); });
    bus.emit({ collection: 'calendar', verb: 'upcoming' });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createEventBus();
    const received: unknown[] = [];
    const unsub = bus.subscribe((e) => { received.push(e); });
    bus.emit({ collection: 'emails', verb: 'arrived' });
    unsub();
    bus.emit({ collection: 'emails', verb: 'arrived' });
    expect(received.length).toBe(1);
  });

  it('size() reports active listeners', () => {
    const bus = createEventBus();
    expect(bus.size()).toBe(0);
    const unsub1 = bus.subscribe(() => {});
    const unsub2 = bus.subscribe(() => {});
    expect(bus.size()).toBe(2);
    unsub1();
    expect(bus.size()).toBe(1);
    unsub2();
    expect(bus.size()).toBe(0);
  });
});

describe('event bus — error isolation', () => {
  it('sync listener error does not stop other listeners', () => {
    const bus = createEventBus();
    const good: unknown[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    bus.subscribe((e) => { good.push(e); });
    bus.emit({ collection: 'emails', verb: 'arrived' });
    expect(good.length).toBe(1);
  });

  it('async listener rejection does not bubble to emitter', () => {
    const bus = createEventBus();
    bus.subscribe(async () => { throw new Error('async bad'); });
    // Should not throw synchronously
    expect(() => bus.emit({ collection: 'emails', verb: 'arrived' })).not.toThrow();
  });
});

describe('event bus — safe unsubscribe during emit', () => {
  it('listener that unsubscribes during emit does not skip other listeners', () => {
    const bus = createEventBus();
    const calls: string[] = [];
    const unsubA = bus.subscribe(() => {
      calls.push('a');
      unsubA();
    });
    bus.subscribe(() => { calls.push('b'); });
    bus.emit({ collection: 'emails', verb: 'arrived' });
    expect(calls).toEqual(['a', 'b']);
  });
});
