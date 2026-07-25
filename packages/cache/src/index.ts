export type { CacheEntry, CacheStore, WithCacheOptions } from './types.js';
export { computeCacheKey, estimateSize } from './key.js';
export { createInMemoryStore } from './in-memory.js';
export { createIDBStore, type IDBCacheStore, type IDBStoreOptions } from './idb.js';
export { tieredStore } from './tiered.js';
export { withCache } from './with-cache.js';
export {
  canonicalize,
  CanonicalizationError,
  canonicalHash,
  cacheKey,
  type CacheKeyInput,
} from './canonical/index.js';
export { derivePolicy, type CachePolicy } from './policy.js';
export {
  isBroadcastEligible,
  DEFAULT_BROADCAST_POLICY,
  type BroadcastPolicy,
} from './broadcast-policy.js';
export {
  wrapStoreWithPeer,
  type PeerCacheTransport,
  type PeerWrapperOptions,
  type PeerCacheStore,
} from './peer-wrapper.js';
export {
  createInMemoryCursorStore,
  type CursorStore,
} from './cursor-store.js';
export {
  createCacheMetrics,
  type CacheMetrics,
  type MetricsSnapshot,
  type StatusBucket,
  type CacheEventStatus,
  type CacheEventContext,
} from './metrics.js';
export {
  createEventBus,
  type EventBus,
  type DataEvent,
  type DataEventVerb,
  type DataEventListener,
} from './event-bus.js';
// D-103 removed the cache-invalidator. TTL + LRU handle cache expiry;
// warehouse events (future phase) drive recipe triggers, not cache
// invalidation.
