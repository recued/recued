/** Peer-aware CacheStore wrapper.
 *
 *  Wraps a local CacheStore with peer-cache behaviors:
 *    - .get(key): try local first. On miss, try peer via rpc with a short
 *      budget. If peer has the entry, write it locally and return it.
 *    - .set(entry): write locally always. If the entry is broadcast-eligible
 *      (category + size + risk_tier per broadcast-policy.ts), enqueue for
 *      the next outbound cache.put batch. Batch flushes on debounce or
 *      when the batch size cap is hit.
 *    - .syncFromPeer(): pull all entries peer wrote since our last-seen
 *      cursor. Call on WS reconnect. Paginated — follows next_cursor
 *      until peer reports null.
 *
 *  Transport abstraction keeps the wrapper agnostic of WS/HTTP/anything;
 *  callers pass a PeerCacheTransport that bridges to their rpc layer.
 *
 *  Errors from peer are swallowed — the wrapper degrades gracefully to
 *  "local only" when peer is unreachable, slow, or misbehaving. Local
 *  correctness never depends on peer behavior.
 */

import type { CacheStore, CacheEntry } from './types.js';
import { isBroadcastEligible, DEFAULT_BROADCAST_POLICY, type BroadcastPolicy } from './broadcast-policy.js';
import type { CursorStore } from './cursor-store.js';
import { createInMemoryCursorStore } from './cursor-store.js';
import type { InstancePrefs } from '@recued/contracts';

export interface PeerCacheTransport {
  /** True when the peer is reachable right now. Checked before every
   *  peer op so callers don't pay latency when WS is down. */
  connected(): boolean;
  /** Request a single entry by key. Returns null on miss, timeout, or
   *  transport error — caller decides what to do with the null. */
  getEntry(key: string, budgetMs: number): Promise<CacheEntry | null>;
  /** Send a batch of entries. Fire-and-forget from the caller's POV;
   *  implementation may retry or drop as appropriate. */
  putEntries(entries: CacheEntry[]): Promise<void>;
  /** Pull entries created after cursor. */
  getSince(cursor: number, limit?: number): Promise<{ entries: CacheEntry[]; next_cursor: number | null }>;
  // D-103: prefix invalidation removed. TTL + LRU handle all cache
  // expiry; explicit invalidation added cross-peer coordination
  // complexity without load-bearing security benefit once instance_id
  // left the cache key.
}

export interface PeerWrapperOptions {
  transport: PeerCacheTransport;
  /** Broadcast policy for outbound cache.put. Defaults to {data, ai, step} ≤ 64KB. */
  broadcastPolicy?: BroadcastPolicy;
  /** Batch debounce window in ms. Default 100. */
  broadcastDebounceMs?: number;
  /** Max entries per outbound batch. Default 50. */
  broadcastBatchSize?: number;
  /** Per-call budget for peer .get on local miss. Default 50ms. */
  peerQueryBudgetMs?: number;
  /** Persistent cursor store for syncFromPeer. Defaults to in-memory. */
  cursorStore?: CursorStore;
  /** Live view of this pair's InstancePrefs. Called on every broadcast
   *  eligibility check + syncFromPeer pass, so toggling
   *  `cache.sync_l2=false` stops future L2 traffic immediately
   *  without a reconnect. Returns `undefined` to use registry defaults
   *  (= everything eligible). */
  getPrefs?: () => Partial<InstancePrefs> | undefined;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Optional scheduler — setTimeout by default; override for tests. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface PeerCacheStore extends CacheStore {
  /** Pull peer's writes since our last-seen cursor. Paginated. Returns
   *  total received + the new cursor. Safe to call repeatedly. */
  syncFromPeer(): Promise<{ received: number; cursor: number }>;
  /** Flush any pending outbound batch immediately. Called from tests or
   *  from orderly-shutdown handlers. */
  flushBroadcast(): Promise<void>;
  /** Stop the batch timer. Call on teardown. */
  stop(): void;
}

const DEFAULTS = {
  broadcastDebounceMs: 100,
  broadcastBatchSize: 50,
  peerQueryBudgetMs: 50,
  sincePageLimit: 200,
};

export const wrapStoreWithPeer = (
  inner: CacheStore,
  options: PeerWrapperOptions,
): PeerCacheStore => {
  const broadcastPolicy = options.broadcastPolicy ?? DEFAULT_BROADCAST_POLICY;
  const debounceMs = options.broadcastDebounceMs ?? DEFAULTS.broadcastDebounceMs;
  const batchSize = options.broadcastBatchSize ?? DEFAULTS.broadcastBatchSize;
  const budgetMs = options.peerQueryBudgetMs ?? DEFAULTS.peerQueryBudgetMs;
  const cursorStore = options.cursorStore ?? createInMemoryCursorStore();
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  });

  /** Outbound batch queue. Keyed by entry.key so re-writes of the same
   *  key coalesce to one broadcast — peer doesn't care about intermediate
   *  states. */
  const pending = new Map<string, CacheEntry>();
  let cancelTimer: (() => void) | null = null;

  const scheduleFlush = () => {
    if (cancelTimer) return;
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void flushBroadcast();
    }, debounceMs);
  };

  const flushBroadcast = async (): Promise<void> => {
    if (pending.size === 0) return;
    if (!options.transport.connected()) {
      // Not connected — keep the pending set. On reconnect, either syncFromPeer
      // pulls peer's recent writes (pull side) or the next flush catches up
      // the local writes (push side). If pending grows unbounded, the last
      // write per key wins (Map semantics).
      return;
    }
    // Slice off up to batchSize entries per frame; caller can call again.
    const batch: CacheEntry[] = [];
    for (const entry of pending.values()) {
      batch.push(entry);
      if (batch.length >= batchSize) break;
    }
    for (const e of batch) pending.delete(e.key);

    try {
      await options.transport.putEntries(batch);
    } catch {
      // Peer rejected — drop batch rather than re-enqueue. Cache is
      // advisory; the next warm path or syncFromPeer reconciles.
    }

    // If more remain, schedule another flush immediately (but still on
    // a timer so we don't starve the event loop).
    if (pending.size > 0) scheduleFlush();
  };

  const wrapped: PeerCacheStore = {
    async get(key) {
      const local = await inner.get(key);
      if (local) return local;

      if (!options.transport.connected()) return null;

      try {
        const peerEntry = await options.transport.getEntry(key, budgetMs);
        if (!peerEntry) return null;

        // Write peer's answer locally so future .get() hits without round-trip.
        await inner.set(peerEntry);
        return peerEntry;
      } catch {
        return null;
      }
    },

    async set(entry) {
      await inner.set(entry);

      if (isBroadcastEligible(entry, broadcastPolicy, options.getPrefs?.())) {
        pending.set(entry.key, entry);
        if (pending.size >= batchSize) {
          if (cancelTimer) { cancelTimer(); cancelTimer = null; }
          void flushBroadcast();
        } else {
          scheduleFlush();
        }
      }
    },

    async touch(key, at) {
      // LRU bump / sliding TTL refresh. Never broadcasts — by design:
      // the entry's VALUE hasn't changed, only its access metadata.
      // Peer can compute its own LRU locally. Cuts cache-hit sync
      // traffic to zero, which matters when a popular key is re-read
      // thousands of times between writes.
      if (inner.touch) {
        await inner.touch(key, at);
        return;
      }
      // Fallback: write through `inner.set` directly (NOT this
      // wrapper's set), so the broadcast path is still bypassed.
      // Correct behavior for stores that lack a native touch — just a
      // bit slower (read + re-serialize + write).
      const entry = await inner.get(key);
      if (!entry) return;
      entry.last_accessed_at = at.last_accessed_at;
      if (at.expires_at !== undefined) entry.expires_at = at.expires_at;
      await inner.set(entry);
    },

    async delete(key) {
      await inner.delete(key);
    },

    async deleteByRecipe(recipe_id) {
      await inner.deleteByRecipe(recipe_id);
    },

    async deleteByPrefix(prefix) {
      // Local-only — D-103 removed the cross-peer invalidation path.
      // Callers that need to purge entries rely on TTL + LRU instead.
      if (inner.deleteByPrefix) return inner.deleteByPrefix(prefix);
      return 0;
    },

    async size() {
      return inner.size();
    },

    async evictLRU(target_bytes) {
      await inner.evictLRU(target_bytes);
    },

    async clear() {
      await inner.clear();
      pending.clear();
    },

    async syncFromPeer() {
      if (!options.transport.connected()) return { received: 0, cursor: await cursorStore.get() };

      let cursor = await cursorStore.get();
      let received = 0;

      // Paginate until peer returns null next_cursor.
      // Bounded by a safety cap so a misbehaving peer can't loop forever.
      for (let i = 0; i < 100; i++) {
        let page;
        try {
          page = await options.transport.getSince(cursor, DEFAULTS.sincePageLimit);
        } catch {
          break;
        }
        for (const entry of page.entries) {
          // Honor the sync pref on inbound too: when the user has
          // toggled off L2 on this device, discard step entries the
          // peer still emits rather than writing them locally. Keeps
          // roaming-mode genuinely zero-traffic in both directions
          // (server-side peer filter is belt; this is the ext belt).
          if (!isBroadcastEligible(entry, broadcastPolicy, options.getPrefs?.())) continue;
          // Last-writer-wins: keep local if it's newer than peer's version.
          const existing = await inner.get(entry.key);
          if (existing && existing.created_at > entry.created_at) continue;
          await inner.set(entry);
          if (entry.created_at > cursor) cursor = entry.created_at;
          received++;
        }
        await cursorStore.set(cursor);
        if (page.next_cursor === null) break;
        cursor = page.next_cursor;
      }

      return { received, cursor };
    },

    async flushBroadcast() {
      if (cancelTimer) { cancelTimer(); cancelTimer = null; }
      await flushBroadcast();
    },

    stop() {
      if (cancelTimer) { cancelTimer(); cancelTimer = null; }
      pending.clear();
    },
  };

  return wrapped;
};
