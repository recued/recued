import {
  wrapStoreWithPeer,
  type CacheEntry,
  type CacheStore,
  type PeerCacheTransport,
} from '@recued/cache';

import type { ServerExecutorConfig } from '../server-executor.js';
import type { WsServerHandle } from '../ws-server.js';

export interface WrapServePeerCacheOptions {
  readonly cacheStore: CacheStore | undefined;
  readonly wsServer: WsServerHandle | undefined;
  readonly executorConfig: Pick<ServerExecutorConfig, 'cacheStore'>;
}

export const wrapServePeerCache = (
  options: WrapServePeerCacheOptions,
): void => {
  const {
    cacheStore,
    wsServer,
    executorConfig,
  } = options;

  if (!cacheStore || !wsServer) return;

  const transport: PeerCacheTransport = {
    connected: () => wsServer.clientCount() > 0,
    // The wrapper's peerQueryBudgetMs (default 50ms) MUST reach the wire
    // call: dropping it here left peerCacheGet on its own 8_000ms default,
    // so every cold step-cache miss stalled a recipe run 8s-per-step
    // whenever any registered client was connected (a mute peer never
    // answers; the timeout WAS the miss). A peer peek is an opportunistic
    // optimization — it must never cost more than its budget.
    getEntry: (key, budgetMs) => wsServer.peerCacheGet(key, budgetMs),
    putEntries: async (entries: CacheEntry[]) => {
      wsServer.peerCachePut(entries);
    },
    // Server-originated cache sync is push-on-write plus peer lookup on
    // miss; ext->srv catch-up still goes through cache.since.
    getSince: async () => ({ entries: [], next_cursor: null }),
  };

  executorConfig.cacheStore = wrapStoreWithPeer(cacheStore, { transport });
};
