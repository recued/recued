/** Failover scenario tests for the peer cache wrapper.
 *
 *  Simulates WS disconnect + reconnect cycles and verifies the wrapper
 *  degrades gracefully + recovers correctly:
 *
 *   1. Disconnect mid-sequence → writes during the gap queue locally,
 *      don't crash, don't break local .get().
 *   2. Reconnect → queued writes flush to peer; syncFromPeer pulls
 *      anything peer wrote during the gap.
 *   3. Cursor advances monotonically across reconnect storms.
 *   4. Concurrent writes from both sides resolve last-writer-wins.
 *
 *  These are the tests that catch race conditions, queue leaks, and
 *  stuck-disconnect bugs that unit tests of the happy path would miss.
 */

import { describe, it, expect } from 'vitest';
import { wrapStoreWithPeer, type PeerCacheTransport } from '../peer-wrapper.js';
import { createInMemoryStore } from '../in-memory.js';
import { createInMemoryCursorStore } from '../cursor-store.js';
import type { CacheEntry } from '../types.js';

const mkEntry = (overrides: Partial<CacheEntry> = {}): CacheEntry => {
  const now = overrides.created_at ?? Date.now();
  return {
    key: `v1:pair:x@1:${Math.random().toString(36).slice(2)}`,
    value: { x: 1 },
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

/** Transport that simulates a flaky connection. */
const mkFlakyTransport = () => {
  const peerStore = new Map<string, CacheEntry>();
  const receivedBatches: CacheEntry[][] = [];
  let connected = true;

  const transport: PeerCacheTransport = {
    connected: () => connected,
    async getEntry(key) {
      if (!connected) throw new Error('disconnected');
      return peerStore.get(key) ?? null;
    },
    async putEntries(entries) {
      if (!connected) throw new Error('disconnected');
      receivedBatches.push(entries);
      for (const e of entries) peerStore.set(e.key, e);
    },
    async getSince(cursor) {
      if (!connected) throw new Error('disconnected');
      const sorted = [...peerStore.values()]
        .filter(e => e.created_at > cursor)
        .sort((a, b) => a.created_at - b.created_at);
      return { entries: sorted, next_cursor: null };
    },
  };

  return {
    transport,
    peerStore,
    receivedBatches,
    disconnect: () => { connected = false; },
    reconnect: () => { connected = true; },
    isConnected: () => connected,
  };
};

const flush = async () => new Promise(r => setTimeout(r, 0));

describe('failover — disconnect mid-sequence', () => {
  it('writes during disconnect do not throw, stay queued', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, {
      transport: f.transport,
      broadcastDebounceMs: 10,
    });

    f.disconnect();
    await peer.set(mkEntry({ key: 'k1' }));
    await peer.set(mkEntry({ key: 'k2' }));
    await peer.flushBroadcast();

    // Peer received nothing during outage
    expect(f.receivedBatches.length).toBe(0);
    // Local store still has everything
    expect(await inner.get('k1')).not.toBeNull();
    expect(await inner.get('k2')).not.toBeNull();
  });

  it('get during disconnect falls back to local-only (no peer query)', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport });

    await inner.set(mkEntry({ key: 'local-only' }));
    f.disconnect();

    const local = await peer.get('local-only');
    expect(local).not.toBeNull();
    const missing = await peer.get('nowhere');
    expect(missing).toBeNull();
  });

  it('syncFromPeer returns received=0 when disconnected', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport });

    f.disconnect();
    const { received } = await peer.syncFromPeer();
    expect(received).toBe(0);
  });
});

describe('failover — reconnect behavior', () => {
  it('queued writes flush after reconnect', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, {
      transport: f.transport,
      broadcastDebounceMs: 10,
    });

    f.disconnect();
    await peer.set(mkEntry({ key: 'queued-1' }));
    await peer.set(mkEntry({ key: 'queued-2' }));
    await peer.flushBroadcast();
    expect(f.receivedBatches.length).toBe(0);

    f.reconnect();
    await peer.flushBroadcast();
    await flush();

    const keys = f.receivedBatches.flat().map(e => e.key);
    expect(keys).toContain('queued-1');
    expect(keys).toContain('queued-2');
  });

  it('syncFromPeer after reconnect pulls peer delta', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport });

    // Peer gets new writes while we're disconnected
    f.disconnect();
    f.peerStore.set('peer-new-1', mkEntry({ key: 'peer-new-1', created_at: 5000 }));
    f.peerStore.set('peer-new-2', mkEntry({ key: 'peer-new-2', created_at: 6000 }));

    f.reconnect();
    const { received } = await peer.syncFromPeer();
    expect(received).toBe(2);
    expect(await inner.get('peer-new-1')).not.toBeNull();
    expect(await inner.get('peer-new-2')).not.toBeNull();
  });

  it('cursor advances monotonically across reconnect cycles', async () => {
    const f = mkFlakyTransport();
    const cursorStore = createInMemoryCursorStore();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport, cursorStore });

    f.peerStore.set('e1', mkEntry({ key: 'e1', created_at: 1000 }));
    let res = await peer.syncFromPeer();
    expect(res.cursor).toBe(1000);

    // Disconnect, peer writes more, reconnect, sync
    f.disconnect();
    f.peerStore.set('e2', mkEntry({ key: 'e2', created_at: 2000 }));
    f.peerStore.set('e3', mkEntry({ key: 'e3', created_at: 3000 }));
    f.reconnect();

    res = await peer.syncFromPeer();
    expect(res.cursor).toBe(3000);
    expect(res.received).toBe(2); // only delta, not the earlier e1
  });
});

describe('failover — concurrent writes', () => {
  it('last-writer-wins on reconnect: local newer than peer stays local', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport });

    const localNewer = mkEntry({ key: 'contested', created_at: 9000, value: 'local' });
    await inner.set(localNewer);

    const peerOlder = mkEntry({ key: 'contested', created_at: 5000, value: 'peer-stale' });
    f.peerStore.set('contested', peerOlder);

    await peer.syncFromPeer();

    const after = await inner.get('contested');
    expect(after?.value).toBe('local');
  });

  it('last-writer-wins: peer newer than local overwrites', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, { transport: f.transport });

    const localOlder = mkEntry({ key: 'contested', created_at: 5000, value: 'local-stale' });
    await inner.set(localOlder);

    const peerNewer = mkEntry({ key: 'contested', created_at: 9000, value: 'peer-fresh' });
    f.peerStore.set('contested', peerNewer);

    await peer.syncFromPeer();

    const after = await inner.get('contested');
    expect(after?.value).toBe('peer-fresh');
  });
});

describe('failover — repeated reconnects', () => {
  it('three disconnect-reconnect cycles, no state corruption', async () => {
    const f = mkFlakyTransport();
    const inner = createInMemoryStore();
    const peer = wrapStoreWithPeer(inner, {
      transport: f.transport,
      broadcastDebounceMs: 5,
    });

    let nextTs = 1000;
    for (let cycle = 0; cycle < 3; cycle++) {
      // Local write during connected
      await peer.set(mkEntry({ key: `local-${cycle}`, created_at: nextTs++ }));
      await peer.flushBroadcast();
      await flush();

      // Disconnect + peer side also writes
      f.disconnect();
      const peerKey = `peer-${cycle}`;
      f.peerStore.set(peerKey, mkEntry({ key: peerKey, created_at: nextTs++ }));

      // Local writes during outage, queued
      await peer.set(mkEntry({ key: `offline-${cycle}`, created_at: nextTs++ }));

      f.reconnect();
      await peer.flushBroadcast();
      await flush();
      await peer.syncFromPeer();
    }

    // Everything landed both ways
    for (let i = 0; i < 3; i++) {
      expect(await inner.get(`local-${i}`)).not.toBeNull();
      expect(await inner.get(`offline-${i}`)).not.toBeNull();
      expect(await inner.get(`peer-${i}`)).not.toBeNull();
      expect(f.peerStore.has(`local-${i}`)).toBe(true);
      expect(f.peerStore.has(`offline-${i}`)).toBe(true);
    }
  });
});
