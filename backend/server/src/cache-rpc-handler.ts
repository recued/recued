/** Cache rpc handlers — exposes the server's CacheStore over WS rpc.
 *
 *  Three methods (D-103 removed `cache.invalidate`):
 *    cache.get(key)                      → CacheEntry | null
 *    cache.put(entries: CacheEntry[])    → { accepted: number, skipped: number }
 *    cache.since(cursor, limit?)         → { entries, next_cursor }
 *
 *  Pure handlers: take deps + args, return the bare response. Failures
 *  throw `RpcError(code, message, status)` which the WS dispatcher
 *  serialises into the `{ok: false, error}` envelope; an HTTP caller
 *  (if we ever add one) would do the same translation.
 *
 *  Security:
 *  - Inbound cache.put entries are validated for shape and size before
 *    being applied. Peer cannot inject malformed rows.
 *  - Peer cannot read entries for another pair (pair-scoped realm
 *    boundary) and cannot nuke cache at all — no invalidate rpc.
 */

import type Database from 'better-sqlite3';
import type { CacheEntry, CacheStore } from '@recued/cache';
import {
  RpcError,
  getPref,
  type HandlerSlice,
  type InstancePrefs,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { BlobStore } from './storage/blob-store.js';
import type { WsClient } from './ws-server.js';
import { listCacheEntriesSince } from './storage/sqlite-cache-store.js';

export interface CacheRpcDeps {
  store: CacheStore;
  db: Database.Database;
  blobs: BlobStore;
  /** Live view of the CONNECTED peer's preferences (not the server's —
   *  the peer authors its own per-pair prefs via `prefs.set`). Resolved
   *  per request via the dispatcher's `ctx.instance_id`; callers pass
   *  a fresh getter on each rpc invocation so toggles take effect on
   *  the next message. Undefined → defaults apply (all sync on). */
  getPeerPrefs?: () => Partial<InstancePrefs> | undefined;
  /** Phase B gate — admission check for inbound `cache.put` batches.
   *  When the gate is in `pressure_managed`, writes still succeed and
   *  the eviction cascade reclaims; when `writes_blocked`, new entries
   *  are rejected with `storage_pressure`. Absent → gate enforcement
   *  off (legacy path + tests). */
  gate?: StorageGate;
  /** Audit log surface — when present, rejections emit a
   *  `storage_pressure` activity entry keyed to the surface so the
   *  user-facing status panel can show recent rejections. */
  auditLog?: AuditLogStore;
}

const DEFAULT_SINCE_LIMIT = 200;
const MAX_SINCE_LIMIT = 1000;
const MAX_PUT_BATCH = 200;

// ────────────────────────────────────────────────────────────────
// cache.get
// ────────────────────────────────────────────────────────────────

export const handleCacheGet = async (
  deps: CacheRpcDeps,
  args: { key?: unknown },
): Promise<{ entry: CacheEntry | null }> => {
  const key = args.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  const entry = await deps.store.get(key);
  return { entry };
};

// ────────────────────────────────────────────────────────────────
// cache.put
// ────────────────────────────────────────────────────────────────

const isValidEntry = (v: unknown): v is CacheEntry => {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.key === 'string' &&
    typeof e.expires_at === 'number' &&
    typeof e.recipe_id === 'string' &&
    typeof e.ingredient_slug === 'string' &&
    typeof e.size_bytes === 'number' &&
    typeof e.created_at === 'number' &&
    typeof e.last_accessed_at === 'number'
  );
};

export const handleCachePut = async (
  deps: CacheRpcDeps,
  args: { entries?: unknown },
): Promise<{ accepted: number; skipped: number }> => {
  const entries = args.entries;
  if (!Array.isArray(entries)) {
    throw new RpcError('bad_request', 'entries must be an array', 400);
  }
  if (entries.length > MAX_PUT_BATCH) {
    throw new RpcError('bad_request', `entries batch exceeds ${MAX_PUT_BATCH}`, 400);
  }

  // Per-peer L2 gate: if the ext has toggled `cache.sync_l2=false` on
  // this pair, drop step-category entries from the ext before
  // persisting. Other categories (data / ai) still land — the pref
  // is deliberately narrow. Peer's own ext-side broadcast-policy
  // already drops these; the server repeats the check to stay
  // authoritative regardless of client version.
  const peerPrefs = deps.getPeerPrefs?.();
  const syncL2 = getPref(peerPrefs, 'cache.sync_l2');

  let accepted = 0;
  let skipped = 0;
  for (const raw of entries) {
    if (!isValidEntry(raw)) { skipped++; continue; }
    if (!syncL2 && raw.category === 'step') { skipped++; continue; }
    // Last-writer-wins by timestamp: if a local entry exists with a newer
    // created_at, keep the local one. This is cheap — we get() before set().
    const existing = await deps.store.get(raw.key);
    if (existing && existing.created_at > raw.created_at) {
      skipped++;
      continue;
    }
    // Phase B admission check. Cache is fully evictable — a
    // `writes_blocked` state only fires if the user manually lowered
    // quota mid-flight; the eviction cascade normally reclaims before
    // we get there. Rejections audit as `storage_pressure`.
    if (deps.gate) {
      const priorBytes = existing?.size_bytes ?? 0;
      const projectedDelta = Math.max(0, raw.size_bytes - priorBytes);
      const check = deps.gate.canWrite(projectedDelta);
      if (!check.ok) {
        if (deps.auditLog) {
          void deps.auditLog.logActivity({
            activity_id: '',
            timestamp: Date.now(),
            action: 'quota_exceeded',
            target: 'cache',
            detail: check.reason ?? 'storage_pressure',
          }).catch(() => { /* best-effort */ });
        }
        skipped++;
        continue;
      }
    }
    await deps.store.set(raw);
    accepted++;
  }
  return { accepted, skipped };
};

// ────────────────────────────────────────────────────────────────
// cache.since
// ────────────────────────────────────────────────────────────────

export const handleCacheSince = async (
  deps: CacheRpcDeps,
  args: { cursor?: unknown; limit?: unknown },
): Promise<{ entries: CacheEntry[]; next_cursor: number | null }> => {
  const cursor = typeof args.cursor === 'number' && Number.isFinite(args.cursor) ? args.cursor : 0;
  const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : DEFAULT_SINCE_LIMIT;
  const limit = Math.max(1, Math.min(requestedLimit, MAX_SINCE_LIMIT));

  const page = await listCacheEntriesSince(deps.db, deps.blobs, cursor, limit);

  // Peer-side L2 gate on the outbound delta: when the ext has L2 sync
  // off, strip step-category entries before shipping. The cursor
  // advances past those rows anyway so the ext doesn't re-request
  // them — consistent with "skip silently" semantics. The ext's
  // peer-wrapper also filters inbound, but server-side stripping
  // saves the bandwidth the pref was turned off to save in the first
  // place.
  if (!getPref(deps.getPeerPrefs?.(), 'cache.sync_l2')) {
    return { ...page, entries: page.entries.filter((e) => e.category !== 'step') };
  }
  return page;
};

// D-103 removed cache.invalidate. If a future phase reintroduces
// explicit invalidation semantics, it should do so without depending on
// `instance_id` being part of the cache key.

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type CacheMethods = 'cache.get' | 'cache.put' | 'cache.since';

/** Factory for the `cache.*` handler slice. Returns `undefined` when
 *  `cacheDeps` isn't wired — the dispatcher's sparse-map fallback then
 *  surfaces `not_configured` for these methods. */
export const makeCacheHandlers = (
  deps: CacheRpcDeps | undefined,
  peerPrefsFor: (client: WsClient) => Partial<InstancePrefs> | undefined,
): HandlerSlice<ServerRpcRegistry, CacheMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['cache.get', 'cache.put', 'cache.since'],
    handlers: {
      'cache.get': async (args, client) =>
        handleCacheGet({ ...deps, getPeerPrefs: () => peerPrefsFor(client) }, args),
      'cache.put': async (args, client) =>
        handleCachePut({ ...deps, getPeerPrefs: () => peerPrefsFor(client) }, args),
      'cache.since': async (args, client) =>
        handleCacheSince({ ...deps, getPeerPrefs: () => peerPrefsFor(client) }, args),
    },
  };
};
