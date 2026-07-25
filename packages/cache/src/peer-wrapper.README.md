# Peer Cache Wrapper — Integration Guide

Wraps a local `CacheStore` with peer-cache behaviors: peer-query on local miss,
broadcast eligible writes, and reconnect-time pull via `cache.since(cursor)`.

The wrapper is transport-agnostic. You provide a `PeerCacheTransport` that
bridges to your rpc layer (the extension's `ws-client.ts` for Recued).

## Extension integration sketch

```ts
// apps/extension/src/runtime/peer-transport.ts
import type { PeerCacheTransport, CacheEntry } from '@recued/cache';
import type { WsClientHandle } from '../sync/ws-client.js';

export const createWsPeerTransport = (ws: WsClientHandle): PeerCacheTransport => ({
  connected: () => ws.connected(),
  async getEntry(key, budgetMs) {
    const res = await ws.rpc<{ entry: CacheEntry | null }>('cache.get', { key }, budgetMs);
    return res?.entry ?? null;
  },
  async putEntries(entries) {
    await ws.rpc('cache.put', { entries });
  },
  async getSince(cursor, limit) {
    const res = await ws.rpc<{ entries: CacheEntry[]; next_cursor: number | null }>(
      'cache.since', { cursor, limit }
    );
    return res ?? { entries: [], next_cursor: null };
  },
  async invalidatePrefix(prefix) {
    await ws.rpc('cache.invalidate', { prefix });
  },
});
```

```ts
// apps/extension/src/runtime/runtime.ts (diff)
import { wrapStoreWithPeer } from '@recued/cache';
import { createWsPeerTransport } from './peer-transport.js';

const cacheStore = config.cacheStore ?? createInMemoryStore();

// NEW — wrap the local store with peer behaviors when WS client is present.
const maybePeerStore = config.wsClient
  ? wrapStoreWithPeer(cacheStore, {
      transport: createWsPeerTransport(config.wsClient),
      cursorStore: config.cacheCursorStore, // IDB-backed for persistence
    })
  : cacheStore;

// Then use maybePeerStore wherever withIngredientCache / other callers
// previously took cacheStore. The CacheStore contract is unchanged —
// the wrapper is a drop-in.
```

## Reconnect hook

On every WS reconnect, call `syncFromPeer()` once to pull the delta:

```ts
config.wsClient.onStateChange((connected) => {
  if (connected) {
    void maybePeerStore.syncFromPeer().catch(() => { /* best-effort */ });
  }
});
```

## Cursor persistence

The default `createInMemoryCursorStore()` resets on every extension reload,
which means a full resync every session. For production, back the cursor
with IndexedDB:

```ts
// apps/extension/src/runtime/idb-cursor-store.ts
import type { CursorStore } from '@recued/cache';

const KEY = 'peer-cache-cursor';

export const createIDBCursorStore = (db: IDBDatabase): CursorStore => ({
  async get() {
    // ...read from your existing IDB infra
    return cursorFromDb ?? 0;
  },
  async set(cursor) {
    // ...persist
  },
});
```

## Behavior under failure modes

| Situation | Behavior |
|---|---|
| WS disconnected | `.get()` falls back to local only; `.set()` queues broadcasts locally |
| Reconnect | `flushBroadcast()` ships queued writes; `syncFromPeer()` pulls peer delta |
| Peer throws on rpc | Swallowed; local result stands; cache is advisory |
| Repeated writes to same key within the debounce window | Coalesced (last wins) |
| Batch cap reached | Flushes immediately, reschedules remainder |

## Not handled by the wrapper

- **Server push** — if the server pushes `cache.put` messages to the extension
  (rather than ext pulling via `cache.since`), that's a separate subscription
  on the extension's WS message handler. The wrapper's `syncFromPeer()` handles
  the pull side; push handling would call `inner.set(entry)` directly on
  incoming messages.
- **Conflict resolution beyond last-writer-wins** — if your use case needs
  merges (e.g., append-only lists), wrap the inner store with a merging
  layer before passing to `wrapStoreWithPeer`.
- **Encryption of broadcast payloads** — transport layer concern; use an
  authenticated WS channel (which Recued's ws-server already provides).
