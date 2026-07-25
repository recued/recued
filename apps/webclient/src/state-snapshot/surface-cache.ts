/** D-148 § A.4.2 — per-surface state-snapshot cache.
 *
 *  Webclient asks the server for `state.snapshot('inbox')` (or any
 *  other registered surface) on connect; the snapshot becomes the
 *  truth + broadcast events apply edits on top. On reload within the
 *  TTL window (`WEBCLIENT_STATE_SNAPSHOT_TTL_MS`) the webclient
 *  re-uses the cached snapshot to avoid the round-trip.
 *
 *  No client-side merge logic. The cache is a typed dictionary keyed
 *  on `WebclientSnapshotSurface`; eviction is by TTL or explicit
 *  invalidation (e.g. when a server-initiated `state.invalidate.<surface>`
 *  event arrives).
 */

import {
  WEBCLIENT_STATE_SNAPSHOT_TTL_MS,
  isWebclientSnapshotSurface,
  type WebclientSnapshotSurface,
  type WebclientStateSnapshot,
} from '@recued/contracts';

export interface SurfaceSnapshotEntry {
  surface: WebclientSnapshotSurface;
  snapshot: WebclientStateSnapshot;
  /** Unix-ms when the snapshot was fetched. */
  fetched_at: number;
  /** Unix-ms after which the entry is considered stale. */
  expires_at: number;
}

export interface SurfaceSnapshotCache {
  /** Read a cached snapshot. Returns null when the surface has no
   *  entry OR the entry is past its TTL. Past-TTL entries are
   *  evicted lazily on read. */
  get(surface: WebclientSnapshotSurface, now?: number): SurfaceSnapshotEntry | null;
  /** Write a freshly-fetched snapshot. Stamps `fetched_at` + computes
   *  `expires_at` from the TTL constant. */
  set(snapshot: WebclientStateSnapshot, now?: number): SurfaceSnapshotEntry;
  /** Invalidate a single surface (e.g. on `state.invalidate.<surface>`
   *  broadcast). */
  invalidate(surface: WebclientSnapshotSurface): void;
  /** Wipe every cached entry — used by "Clear this browser" + by the
   *  reconnect-after-drop-cursor fallback. */
  clear(): void;
  /** Snapshot the cache as a list — used by Settings → Privacy +
   *  diagnostic surfaces. */
  list(now?: number): SurfaceSnapshotEntry[];
}

export const createSurfaceSnapshotCache = (
  options: { ttl_ms?: number; now?: () => number } = {},
): SurfaceSnapshotCache => {
  const ttl = options.ttl_ms ?? WEBCLIENT_STATE_SNAPSHOT_TTL_MS;
  const clock = options.now ?? Date.now;
  const store = new Map<WebclientSnapshotSurface, SurfaceSnapshotEntry>();

  const isExpired = (entry: SurfaceSnapshotEntry, now: number): boolean =>
    now >= entry.expires_at;

  return {
    get(surface, now) {
      if (!isWebclientSnapshotSurface(surface)) return null;
      const entry = store.get(surface);
      if (!entry) return null;
      const t = now ?? clock();
      if (isExpired(entry, t)) {
        store.delete(surface);
        return null;
      }
      return entry;
    },
    set(snapshot, now) {
      const t = now ?? clock();
      const entry: SurfaceSnapshotEntry = {
        surface: snapshot.surface,
        snapshot,
        fetched_at: t,
        expires_at: t + ttl,
      };
      store.set(snapshot.surface, entry);
      return entry;
    },
    invalidate(surface) {
      store.delete(surface);
    },
    clear() {
      store.clear();
    },
    list(now) {
      const t = now ?? clock();
      const out: SurfaceSnapshotEntry[] = [];
      for (const entry of store.values()) {
        if (!isExpired(entry, t)) out.push(entry);
      }
      return out;
    },
  };
};
