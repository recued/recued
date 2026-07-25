import { describe, it, expect, beforeEach } from 'vitest';
import { wrapStoreWithPeer, type PeerCacheTransport } from '../peer-wrapper.js';
import { createInMemoryStore } from '../in-memory.js';
import { createInMemoryCursorStore } from '../cursor-store.js';
import type { CacheEntry, CacheStore } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => {
  const now = Date.now();
  return {
    key: `v1:pair:x@1:${Math.random().toString(36).slice(2)}`,
    value: { payload: 'x' },
    expires_at: now + 60_000,
    recipe_id: 'r',
    ingredient_slug: 'x',
    size_bytes: 20,
    created_at: now,
    last_accessed_at: now,
    category: 'data',
    risk_tier: 'read',
    ...overrides,
  };
};

interface MockTransport extends PeerCacheTransport {
  peerStore: Map<string, CacheEntry>;
  putCalls: CacheEntry[][];
  getCalls: string[];
  sinceCalls: number[];
  setConnected(v: boolean): void;
}

const mkMockTransport = (): MockTransport => {
  const peerStore = new Map<string, CacheEntry>();
  const putCalls: CacheEntry[][] = [];
  const getCalls: string[] = [];
  const sinceCalls: number[] = [];
  let connected = true;

  return {
    peerStore, putCalls, getCalls, sinceCalls,
    connected() { return connected; },
    setConnected(v) { connected = v; },
    async getEntry(key) {
      getCalls.push(key);
      return peerStore.get(key) ?? null;
    },
    async putEntries(entries) {
      putCalls.push(entries);
      for (const e of entries) peerStore.set(e.key, e);
    },
    async getSince(cursor, limit = 100) {
      sinceCalls.push(cursor);
      const sorted = [...peerStore.values()]
        .filter(e => e.created_at > cursor)
        .sort((a, b) => a.created_at - b.created_at);
      const page = sorted.slice(0, limit);
      const next_cursor = page.length === limit && sorted.length > limit
        ? page[page.length - 1].created_at
        : null;
      return { entries: page, next_cursor };
    },
  };
};

/** Synchronous-flush timer stub: invokes the callback immediately. Keeps
 *  batch-debounce tests deterministic without fake timers. */
const immediateTimer = (fn: () => void) => { fn(); return () => {}; };

// ────────────────────────────────────────────────────────────────
// Local hit / peer fallthrough
// ────────────────────────────────────────────────────────────────

let inner: CacheStore;
let transport: MockTransport;

beforeEach(() => {
  inner = createInMemoryStore();
  transport = mkMockTransport();
});

describe('peer wrapper — get path', () => {
  it('local hit returns without peer query', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    const entry = mkEntry();
    await inner.set(entry);

    const got = await wrapped.get(entry.key);
    expect(got?.key).toBe(entry.key);
    expect(transport.getCalls.length).toBe(0);
  });

  it('local miss + peer hit pulls from peer and writes local', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    const entry = mkEntry({ key: 'v1:pair:x@1:peer-only' });
    transport.peerStore.set(entry.key, entry);

    const got = await wrapped.get(entry.key);
    expect(got?.key).toBe(entry.key);
    expect(transport.getCalls.length).toBe(1);
    // Subsequent calls hit local, not peer
    await wrapped.get(entry.key);
    expect(transport.getCalls.length).toBe(1);
  });

  it('local miss + peer miss returns null', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    const got = await wrapped.get('v1:pair:x@1:nowhere');
    expect(got).toBeNull();
    expect(transport.getCalls.length).toBe(1);
  });

  it('disconnected peer → skip peer query on miss', async () => {
    transport.setConnected(false);
    const wrapped = wrapStoreWithPeer(inner, { transport });
    const got = await wrapped.get('anywhere');
    expect(got).toBeNull();
    expect(transport.getCalls.length).toBe(0);
  });

  it('peer throw does not break the wrapper', async () => {
    const flakyTransport: PeerCacheTransport = {
      ...transport,
      getEntry: async () => { throw new Error('network'); },
    };
    const wrapped = wrapStoreWithPeer(inner, { transport: flakyTransport });
    const got = await wrapped.get('k');
    expect(got).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Broadcast on set
// ────────────────────────────────────────────────────────────────

describe('peer wrapper — set path / broadcast', () => {
  it('eligible entries are broadcast', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({ key: 'k1', category: 'data' }));
    await wrapped.flushBroadcast();
    expect(transport.putCalls.length).toBeGreaterThanOrEqual(1);
    expect(transport.putCalls.flat().map(e => e.key)).toContain('k1');
  });

  it('ineligible entries (action category) are NOT broadcast', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({ key: 'k-action', category: 'action' }));
    await wrapped.flushBroadcast();
    expect(transport.putCalls.flat().map(e => e.key)).not.toContain('k-action');
  });

  it('ineligible entries (missing category) are NOT broadcast', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({ key: 'k-legacy', category: undefined }));
    await wrapped.flushBroadcast();
    expect(transport.putCalls.flat().map(e => e.key)).not.toContain('k-legacy');
  });

  it('touch() updates LRU + optionally slides TTL without broadcasting', async () => {
    // Write once → broadcasts. Then touch the SAME key many times.
    // No additional broadcasts should fire: refresh-only updates
    // (same content, new access timestamp) never leave the wire.
    const wrapped = wrapStoreWithPeer(inner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({
      key: 'k-touched', category: 'data',
      last_accessed_at: 1_000, expires_at: 2_000,
    }));
    await wrapped.flushBroadcast();
    const initialPutCount = transport.putCalls.length;

    // 50 cache hits in quick succession — each bumps LRU.
    for (let i = 0; i < 50; i++) {
      await wrapped.touch!('k-touched', {
        last_accessed_at: 1_000 + i * 10,
        expires_at: 2_000 + i * 10,
      });
    }
    await wrapped.flushBroadcast();

    // Still the same number of outbound put calls.
    expect(transport.putCalls.length).toBe(initialPutCount);

    // But the local entry has the latest access time + refreshed TTL.
    const after = await wrapped.get('k-touched');
    expect(after?.last_accessed_at).toBe(1_000 + 49 * 10);
    expect(after?.expires_at).toBe(2_000 + 49 * 10);
  });

  it('touch() on a store without native touch() uses a direct fallback that still skips broadcast', async () => {
    // Wrap a bare inner store that lacks touch(). The peer-wrapper's
    // own touch() falls back to inner.get() + inner.set() — note: it
    // calls `inner.set`, NOT the wrapped `set`, so the broadcast path
    // is still bypassed. This is deliberate: LRU metadata is local
    // state; peer computes its own.
    const untouchableInner: CacheStore = {
      get: inner.get.bind(inner),
      set: inner.set.bind(inner),
      delete: inner.delete.bind(inner),
      deleteByRecipe: inner.deleteByRecipe.bind(inner),
      size: inner.size.bind(inner),
      evictLRU: inner.evictLRU.bind(inner),
      clear: inner.clear.bind(inner),
      // No `touch` field.
    };
    const wrapped = wrapStoreWithPeer(untouchableInner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({ key: 'k-fb', category: 'data' }));
    await wrapped.flushBroadcast();
    const writesBeforeTouch = transport.putCalls.length;

    await wrapped.touch!('k-fb', { last_accessed_at: 5_000, expires_at: 9_999 });
    await wrapped.flushBroadcast();

    // Fallback wrote locally — confirmed by inspecting the entry —
    // but did NOT add a broadcast.
    expect(transport.putCalls.length).toBe(writesBeforeTouch);
    const after = await wrapped.get('k-fb');
    expect(after?.last_accessed_at).toBe(5_000);
    expect(after?.expires_at).toBe(9_999);
  });

  it('disconnected peer queues broadcast; reconnect delivery is best-effort', async () => {
    transport.setConnected(false);
    const wrapped = wrapStoreWithPeer(inner, { transport, setTimer: immediateTimer });
    await wrapped.set(mkEntry({ key: 'k-queued' }));
    await wrapped.flushBroadcast();
    expect(transport.putCalls.length).toBe(0);

    transport.setConnected(true);
    await wrapped.flushBroadcast();
    expect(transport.putCalls.flat().map(e => e.key)).toContain('k-queued');
  });

  it('coalesces repeated writes to same key (last wins)', async () => {
    // Manual timer: we schedule but control when the flush fires.
    let pending: (() => void) | null = null;
    const wrapped = wrapStoreWithPeer(inner, {
      transport,
      setTimer: (fn) => { pending = fn; return () => { pending = null; }; },
    });
    await wrapped.set(mkEntry({ key: 'k', value: 'v1' }));
    await wrapped.set(mkEntry({ key: 'k', value: 'v2' }));
    await wrapped.set(mkEntry({ key: 'k', value: 'v3' }));

    expect(pending).not.toBeNull();
    pending!();
    // The batch flush runs asynchronously; let the microtask settle.
    await new Promise(r => setTimeout(r, 0));

    const all = transport.putCalls.flat();
    const forK = all.filter(e => e.key === 'k');
    expect(forK.length).toBe(1); // coalesced
    expect(forK[0].value).toBe('v3');
  });

  it('flushes immediately when batch size cap is reached', async () => {
    const wrapped = wrapStoreWithPeer(inner, {
      transport,
      broadcastBatchSize: 3,
      setTimer: () => () => {},
    });
    for (let i = 0; i < 3; i++) {
      await wrapped.set(mkEntry({ key: `k${i}` }));
    }
    await new Promise(r => setTimeout(r, 0));
    const allKeys = transport.putCalls.flat().map(e => e.key);
    expect(allKeys).toEqual(expect.arrayContaining(['k0', 'k1', 'k2']));
  });
});

// ────────────────────────────────────────────────────────────────
// syncFromPeer — reconnect pull
// ────────────────────────────────────────────────────────────────

describe('peer wrapper — syncFromPeer', () => {
  it('pulls peer-new entries and advances cursor', async () => {
    transport.peerStore.set('p1', mkEntry({ key: 'p1', created_at: 1000 }));
    transport.peerStore.set('p2', mkEntry({ key: 'p2', created_at: 2000 }));

    const wrapped = wrapStoreWithPeer(inner, { transport });
    const { received, cursor } = await wrapped.syncFromPeer();

    expect(received).toBe(2);
    expect(cursor).toBe(2000);
    expect(await inner.get('p1')).not.toBeNull();
    expect(await inner.get('p2')).not.toBeNull();
  });

  it('cursor survives across calls (only delta pulled)', async () => {
    const cursorStore = createInMemoryCursorStore();
    transport.peerStore.set('p1', mkEntry({ key: 'p1', created_at: 1000 }));

    const wrapped = wrapStoreWithPeer(inner, { transport, cursorStore });
    await wrapped.syncFromPeer();

    // Add a newer entry on peer side
    transport.peerStore.set('p2', mkEntry({ key: 'p2', created_at: 2000 }));
    const { received } = await wrapped.syncFromPeer();
    expect(received).toBe(1); // only the new one
  });

  it('disconnected peer returns received=0 without throwing', async () => {
    transport.setConnected(false);
    const wrapped = wrapStoreWithPeer(inner, { transport });
    const { received } = await wrapped.syncFromPeer();
    expect(received).toBe(0);
  });

  it('last-writer-wins: local newer than peer is preserved', async () => {
    const localEntry = mkEntry({ key: 'k', created_at: 3000, value: 'local-newer' });
    await inner.set(localEntry);
    transport.peerStore.set('k', mkEntry({ key: 'k', created_at: 2000, value: 'peer-stale' }));

    const wrapped = wrapStoreWithPeer(inner, { transport });
    await wrapped.syncFromPeer();

    const after = await inner.get('k');
    expect(after?.value).toBe('local-newer');
  });

  it('breaks out of the pagination loop when getSince throws', async () => {
    const flakyTransport: PeerCacheTransport = {
      ...transport,
      getSince: async () => { throw new Error('peer down'); },
    };
    const wrapped = wrapStoreWithPeer(inner, { transport: flakyTransport });
    const { received } = await wrapped.syncFromPeer();
    expect(received).toBe(0);
  });

  it('follows next_cursor across multiple pages', async () => {
    // Build a transport that returns paged results with non-null next_cursor.
    const pages = [
      { entries: [mkEntry({ key: 'a', created_at: 100 })], next_cursor: 150 },
      { entries: [mkEntry({ key: 'b', created_at: 200 })], next_cursor: 250 },
      { entries: [mkEntry({ key: 'c', created_at: 300 })], next_cursor: null },
    ];
    let i = 0;
    const pagedTransport: PeerCacheTransport = {
      ...transport,
      async getSince() { return pages[i++]; },
    };
    const wrapped = wrapStoreWithPeer(inner, { transport: pagedTransport });
    const { received, cursor } = await wrapped.syncFromPeer();
    expect(received).toBe(3);
    expect(cursor).toBe(300);
    expect(await inner.get('a')).not.toBeNull();
    expect(await inner.get('c')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Delegating methods + broadcast error handling + lifecycle
// ────────────────────────────────────────────────────────────────

describe('peer wrapper — delegating methods', () => {
  it('delete delegates to inner', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await inner.set(mkEntry({ key: 'd1' }));
    await wrapped.delete('d1');
    expect(await inner.get('d1')).toBeNull();
  });

  it('deleteByRecipe delegates to inner', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await inner.set(mkEntry({ key: 'r1', recipe_id: 'recipe-a' }));
    await inner.set(mkEntry({ key: 'r2', recipe_id: 'recipe-b' }));
    await wrapped.deleteByRecipe('recipe-a');
    expect(await inner.get('r1')).toBeNull();
    expect(await inner.get('r2')).not.toBeNull();
  });

  it('deleteByPrefix delegates when inner supports it', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await inner.set(mkEntry({ key: 'prefix-a' }));
    await inner.set(mkEntry({ key: 'prefix-b' }));
    await inner.set(mkEntry({ key: 'unrelated' }));
    const count = await wrapped.deleteByPrefix!('prefix-');
    expect(count).toBe(2);
    expect(await inner.get('unrelated')).not.toBeNull();
  });

  it('deleteByPrefix returns 0 when inner lacks the method', async () => {
    const barebones: CacheStore = {
      get: inner.get.bind(inner),
      set: inner.set.bind(inner),
      delete: inner.delete.bind(inner),
      deleteByRecipe: inner.deleteByRecipe.bind(inner),
      size: inner.size.bind(inner),
      evictLRU: inner.evictLRU.bind(inner),
      clear: inner.clear.bind(inner),
      // No deleteByPrefix.
    };
    const wrapped = wrapStoreWithPeer(barebones, { transport });
    const count = await wrapped.deleteByPrefix!('anything-');
    expect(count).toBe(0);
  });

  it('size delegates to inner', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await inner.set(mkEntry({ key: 's1', size_bytes: 100 }));
    await inner.set(mkEntry({ key: 's2', size_bytes: 200 }));
    expect(await wrapped.size()).toBe(300);
  });

  it('evictLRU delegates to inner', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await inner.set(mkEntry({ key: 'e1', size_bytes: 100, last_accessed_at: 1 }));
    await inner.set(mkEntry({ key: 'e2', size_bytes: 100, last_accessed_at: 2 }));
    await wrapped.evictLRU(100);
    expect(await inner.get('e1')).toBeNull();
    expect(await inner.get('e2')).not.toBeNull();
  });

  it('clear wipes both inner state and pending broadcast queue', async () => {
    // Manual timer so pending broadcasts never actually flush.
    const wrapped = wrapStoreWithPeer(inner, {
      transport,
      setTimer: () => () => {},
    });
    await wrapped.set(mkEntry({ key: 'c1', category: 'data' }));
    await wrapped.set(mkEntry({ key: 'c2', category: 'data' }));
    await wrapped.clear();
    expect(await wrapped.size()).toBe(0);
    await wrapped.flushBroadcast();
    expect(transport.putCalls.flat()).toEqual([]);
  });
});

describe('peer wrapper — broadcast error handling', () => {
  it('swallows putEntries rejections (cache is advisory)', async () => {
    const angryTransport: PeerCacheTransport = {
      ...transport,
      putEntries: async () => { throw new Error('peer angry'); },
    };
    const wrapped = wrapStoreWithPeer(inner, {
      transport: angryTransport,
      setTimer: immediateTimer,
    });
    await wrapped.set(mkEntry({ key: 'k-angry', category: 'data' }));
    // flushBroadcast must not reject even though putEntries throws.
    await expect(wrapped.flushBroadcast()).resolves.toBeUndefined();
  });

  it('reschedules another flush when a batch leaves entries pending', async () => {
    // Drive the "pending.size > 0 after batch → scheduleFlush" branch.
    // Strategy: queue entries while disconnected (flushBroadcast is a no-op
    // on disconnected peer), then reconnect and flush manually. First batch
    // clears exactly `batchSize` entries; the remainder triggers a re-schedule.
    let scheduleCount = 0;
    transport.setConnected(false);
    const wrapped = wrapStoreWithPeer(inner, {
      transport,
      broadcastBatchSize: 2,
      setTimer: (fn) => { scheduleCount++; void fn; return () => {}; },
    });
    for (let i = 0; i < 5; i++) {
      await wrapped.set(mkEntry({ key: `k${i}`, category: 'data' }));
    }
    const beforeReconnect = scheduleCount;
    transport.setConnected(true);
    await wrapped.flushBroadcast();
    // After slicing batchSize=2, 3 entries remain → scheduleFlush fires.
    expect(scheduleCount).toBeGreaterThan(beforeReconnect);
  });
});

describe('peer wrapper — lifecycle', () => {
  it('stop() cancels a pending flush timer and clears the queue', async () => {
    let pending: (() => void) | null = null;
    let cancelled = false;
    const wrapped = wrapStoreWithPeer(inner, {
      transport,
      setTimer: (fn) => {
        pending = fn;
        return () => { pending = null; cancelled = true; };
      },
    });
    await wrapped.set(mkEntry({ key: 'stop-k', category: 'data' }));
    expect(pending).not.toBeNull();
    wrapped.stop();
    expect(cancelled).toBe(true);
    // Draining now shouldn't produce anything (queue cleared).
    await wrapped.flushBroadcast();
    expect(transport.putCalls.flat()).toEqual([]);
  });

  it('flushBroadcast is a no-op when the pending queue is empty', async () => {
    const wrapped = wrapStoreWithPeer(inner, { transport });
    await wrapped.flushBroadcast();
    expect(transport.putCalls).toEqual([]);
  });
});
