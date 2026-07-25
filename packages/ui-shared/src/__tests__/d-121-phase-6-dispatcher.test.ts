/** D-121 Phase 6 — client-side EventDispatcher unit tests.
 *
 *  Wire envelope filtering (`type === 'server_event'`), per-kind
 *  fan-out, cursor tracking, storage hydration + persistence,
 *  listener isolation, dispose semantics. */

import { describe, expect, it, vi } from 'vitest';
import { createEventDispatcher } from '../events/dispatcher.js';
import type {
  RpcAdapter,
  StorageAdapter,
} from '../runtime/adapters.js';
import type { ServerEvent } from '@recued/contracts';

interface MockRpc extends RpcAdapter {
  /** Emit a wire payload to subscribed listeners. */
  push(msg: unknown): void;
}

const createMockRpc = (): MockRpc => {
  const listeners = new Set<(m: unknown) => void>();
  return {
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    send: async () => {},
    push: (m) => {
      for (const l of listeners) l(m);
    },
  };
};

const createMockStorage = (): StorageAdapter & { snapshot: () => Map<string, unknown> } => {
  const store = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key, value) => { store.set(key, value); },
    remove: async (key) => { store.delete(key); },
    snapshot: () => new Map(store),
  };
};

const wrap = (event: ServerEvent): { type: 'server_event'; event: ServerEvent } => ({
  type: 'server_event',
  event,
});

describe('EventDispatcher.on + push fanout', () => {
  it('fires per-kind listeners on matching events', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const memSeen: ServerEvent[] = [];
    const wareSeen: ServerEvent[] = [];
    dispatcher.on('memory', (e) => memSeen.push(e));
    dispatcher.on('warehouse', (e) => wareSeen.push(e));

    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'r1', cursor: 1 }));
    rpc.push(wrap({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1', cursor: 2 }));

    expect(memSeen).toHaveLength(1);
    expect(wareSeen).toHaveLength(1);
  });

  it('ignores envelopes without type=server_event', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const seen: ServerEvent[] = [];
    dispatcher.on('memory', (e) => seen.push(e));

    rpc.push({ type: 'unrelated', payload: { kind: 'memory' } });
    rpc.push({ type: 'pong' });
    rpc.push({ type: 'server_event' }); // no event field
    rpc.push({ type: 'server_event', event: { kind: 'memory' } }); // missing cursor
    rpc.push({ type: 'server_event', event: { cursor: 1 } }); // missing kind

    expect(seen).toHaveLength(0);
    expect(dispatcher.cursor()).toBe(0);
  });

  it('returns unsubscribe handle that removes the listener', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const seen: ServerEvent[] = [];
    const off = dispatcher.on('memory', (e) => seen.push(e));
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'a', cursor: 1 }));
    expect(seen).toHaveLength(1);
    off();
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'b', cursor: 2 }));
    expect(seen).toHaveLength(1);
  });

  it('multiple listeners on the same kind all fire in order', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const order: number[] = [];
    dispatcher.on('memory', () => order.push(1));
    dispatcher.on('memory', () => order.push(2));
    dispatcher.on('memory', () => order.push(3));
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'r', cursor: 1 }));
    expect(order).toEqual([1, 2, 3]);
  });

  it('throwing listener does not stop other listeners on the same kind', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const ok = vi.fn();
    dispatcher.on('memory', () => { throw new Error('boom'); });
    dispatcher.on('memory', ok);
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'r', cursor: 1 }));
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('EventDispatcher cursor tracking', () => {
  it('updates cursor monotonically (max wins)', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'a', cursor: 5 }));
    expect(dispatcher.cursor()).toBe(5);
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'b', cursor: 3 }));
    expect(dispatcher.cursor()).toBe(5);
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'c', cursor: 7 }));
    expect(dispatcher.cursor()).toBe(7);
  });

  it('persists cursor to storage on update', async () => {
    const rpc = createMockRpc();
    const storage = createMockStorage();
    const dispatcher = createEventDispatcher({ rpc, storage });
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'a', cursor: 42 }));
    // storage.set is async; allow microtask to flush
    await new Promise((r) => setImmediate(r));
    expect(storage.snapshot().get('events.cursor')).toBe(42);
    expect(dispatcher.cursor()).toBe(42);
  });

  it('hydrates cursor from storage on construction', async () => {
    const rpc = createMockRpc();
    const storage = createMockStorage();
    await storage.set('events.cursor', 100);
    const dispatcher = createEventDispatcher({ rpc, storage });
    // Hydrate is async; allow microtask
    await new Promise((r) => setImmediate(r));
    expect(dispatcher.cursor()).toBe(100);
  });

  it('honors a custom cursorKey', async () => {
    const rpc = createMockRpc();
    const storage = createMockStorage();
    const dispatcher = createEventDispatcher({ rpc, storage, cursorKey: 'srv1.cursor' });
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'a', cursor: 9 }));
    await new Promise((r) => setImmediate(r));
    expect(storage.snapshot().get('srv1.cursor')).toBe(9);
    expect(storage.snapshot().has('events.cursor')).toBe(false);
    expect(dispatcher).toBeDefined();
  });
});

describe('EventDispatcher.dispose', () => {
  it('detaches the rpc subscription + clears listeners', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    const seen: ServerEvent[] = [];
    dispatcher.on('memory', (e) => seen.push(e));
    dispatcher.dispose();
    rpc.push(wrap({ kind: 'memory', subkind: 'audit', id: 'r', cursor: 1 }));
    expect(seen).toHaveLength(0);
  });

  it('on() after dispose returns a no-op unsubscribe', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    dispatcher.dispose();
    const off = dispatcher.on('memory', () => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('dispose is idempotent', () => {
    const rpc = createMockRpc();
    const dispatcher = createEventDispatcher({ rpc });
    dispatcher.dispose();
    expect(() => dispatcher.dispose()).not.toThrow();
  });
});
