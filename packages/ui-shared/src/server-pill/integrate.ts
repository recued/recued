/** Phase G (D-109) — pill integration glue for popup / sidebar hosts.
 *  D-121 Phase 3 — refactored to consume `StorageAdapter`,
 *  `RpcAdapter`, and `TabAdapter` instead of reaching into
 *  `globalThis.chrome`. The pure UI mount stays the same; the chrome-
 *  coupled wiring is now host-side (extension binds chrome adapters,
 *  webapp binds Web* adapters).
 *
 *  Behavior is identical to the pre-extraction shape:
 *    - Reads the latest snapshot from the storage adapter under the
 *      caller-supplied key (extension passes `SERVER_HEARTBEAT_STORAGE_KEY`).
 *    - Subscribes to broadcasts via the rpc adapter; messages with the
 *      matching `kind` trigger `update()`.
 *    - The default click handler opens Options at `#/server/home` via
 *      `openOptionsPage()` when available, otherwise falls back to
 *      `openUrl(...)` — both routed through the tab adapter. */

import type { ServerHeartbeatSnapshot } from '@recued/contracts';
import {
  mountServerPill,
  type ServerPillHandle,
  type ServerPillMountOptions,
} from './index.js';
import type {
  RpcAdapter,
  StorageAdapter,
  TabAdapter,
} from '../runtime/adapters.js';

/** Message kind the SW broadcasts when the cached snapshot changes. */
export const SERVER_HEARTBEAT_BROADCAST_KIND = 'server.heartbeat';

/** Wire shape of the runtime.onMessage broadcast payload. */
export interface ServerHeartbeatBroadcast {
  kind: typeof SERVER_HEARTBEAT_BROADCAST_KIND;
  snapshot: ServerHeartbeatSnapshot;
}

/** Deep-link path for the pill click. */
export const PILL_DEEP_LINK_HASH = '#/server/home';

/** Read a cached snapshot via the storage adapter. Returns `null`
 *  when the key is absent, storage is unavailable, or the value is
 *  the wrong shape. */
export const readCachedServerSnapshot = async (
  storage: StorageAdapter,
  storageKey: string,
): Promise<ServerHeartbeatSnapshot | null> => {
  const raw = await storage.get<ServerHeartbeatSnapshot>(storageKey);
  if (!raw || typeof raw !== 'object') return null;
  return raw;
};

/** Open Options at Server → Home through the tab adapter, with
 *  `openUrl` as the fallback when the surface lacks an Options page.
 *  The post-open `runtime.sendMessage` nudge keeps the deep-link
 *  hash in sync with what the Options router subscribes to. */
export const openOptionsAtServerHome = (
  tab: TabAdapter,
  rpc: RpcAdapter,
  fallbackUrl: string,
): void => {
  if (tab.openOptionsPage) {
    void tab
      .openOptionsPage()
      .then(async () => {
        // Defer the hash nudge a tick so the freshly-opened Options
        // page has loaded the listener. Fails silently on surfaces
        // that don't accept a follow-up message.
        await rpc
          .send({
            kind: 'options:navigate',
            hash: PILL_DEEP_LINK_HASH,
          })
          .catch(() => {
            /* options not ready yet */
          });
      })
      .catch(() => {
        // Fallback — open the options.html directly at the hash.
        void tab.openUrl(fallbackUrl);
      });
    return;
  }
  // No Options page on this surface — open the deep-linked URL
  // directly. (Webapp binds this branch.)
  void tab.openUrl(fallbackUrl);
};

export interface IntegrateServerPillOptions
  extends Omit<ServerPillMountOptions, 'getSnapshot' | 'onClick'> {
  /** Storage adapter used to seed the initial snapshot. */
  storage: StorageAdapter;
  /** Rpc adapter used to subscribe to broadcasts. */
  rpc: RpcAdapter;
  /** Storage key carrying the snapshot. Extension passes
   *  `SERVER_HEARTBEAT_STORAGE_KEY`. */
  storageKey: string;
  /** Override the snapshot source (tests). When absent the integration
   *  uses the cache primed by `storage` + broadcast updates. */
  getSnapshot?: () => ServerHeartbeatSnapshot | null;
  /** Override the click handler (tests + webapp surface). When absent
   *  no click handler is wired (the pill remains non-interactive). */
  onClick?: () => void;
}

export interface IntegratedServerPill extends ServerPillHandle {
  /** Latest cached snapshot. Refreshes after the initial storage
   *  read + every matching broadcast. */
  snapshot(): ServerHeartbeatSnapshot | null;
}

/** Mount the pill + wire it into broadcasts + storage via the
 *  injected adapters. Returns a handle that cleans up on `dispose()`. */
export const integrateServerPill = (
  options: IntegrateServerPillOptions,
): IntegratedServerPill => {
  let cached: ServerHeartbeatSnapshot | null = null;

  const getSnapshot = options.getSnapshot ?? (() => cached);
  const onClick = options.onClick;

  const handle = mountServerPill({
    ...options,
    getSnapshot,
    onClick,
  });

  // Seed the initial snapshot from the storage adapter.
  void readCachedServerSnapshot(options.storage, options.storageKey).then(
    (snap) => {
      if (snap) {
        cached = snap;
        handle.update();
      }
    },
  );

  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== 'object') return;
    const msg = message as Partial<ServerHeartbeatBroadcast>;
    if (msg.kind !== SERVER_HEARTBEAT_BROADCAST_KIND) return;
    if (!msg.snapshot || typeof msg.snapshot !== 'object') return;
    cached = msg.snapshot;
    handle.update();
  };
  const unsubscribe = options.rpc.subscribe(onMessage);

  return {
    update: handle.update,
    snapshot: () => cached,
    dispose() {
      handle.dispose();
      unsubscribe();
    },
  };
};
