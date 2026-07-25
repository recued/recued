/** D-117 Phase 9 — calendar-adapter composition helper.
 *
 *  Parallel to `composeFileStack`: assembles the adapter registry,
 *  instance store, live-collection map, watcher cursor store, and
 *  enrollment hooks. bin.ts calls this once, spreads the kernel
 *  dispatchers into the executor config, wires `calendarEnroll` onto
 *  `collectionDeps`, and passes each `CalendarCollection` into the
 *  shared collection registry for heartbeat + retention plumbing.
 *
 *  Owns live-collection lifecycle:
 *    - `startAll()` reads every `platform='calendar'` row from the
 *      instance store and spins up a `CalendarCollection` per row
 *      (factory + provider + retention + emitter + watcher surface).
 *      Individual adapter failures log + skip so one broken row can't
 *      prevent the server from booting.
 *    - `enrollDeps.onEnrolled` / `onDeleted` flow enroll-rpc and
 *      delete-rpc through the same helpers so the live map stays
 *      consistent with the instance store.
 *    - `disposeAll()` closes every live collection during the
 *      lifecycle drain.
 *
 *  D-117 Phase 6 + Phase 8 integration points:
 *    - Calendar-* kernel dispatchers (`calendarList`, `calendarGet`,
 *      …) resolve slugs against the internal `live` map directly —
 *      same-process pointer avoids a registry re-walk on every call.
 *    - `calendar-watcher` routes through the shared
 *      `createWatcherDispatcher` (watchers/index.ts) against the
 *      `CollectionRegistry` mirror populated by
 *      `registerCalendarCollections` + this stack's `watcherCursors`.
 */

import type Database from 'better-sqlite3';
import type { KernelDispatchers } from '@recued/ingredients';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';

import type { BlobStore } from '../../storage/blob-store.js';
import {
  createInstanceStore,
  type CollectionInstanceRecord,
  type CollectionInstanceStore,
} from '../instance-store.js';
import type { CollectionRegistry } from '../registry.js';
import {
  pauseCollectionSync,
  resumeCollectionSync,
  syncDeferredWhileLocked,
} from '../vault-gated-sync.js';

import {
  createCalendarAdapterRegistry,
  type CalendarAdapterRegistry,
} from './adapter-registry.js';
import {
  createCalendarCollection,
  type CalendarCollection,
  type CalendarCollectionConfig,
} from './calendar-collection.js';
import {
  handleCalendarCreate,
  handleCalendarDelete,
  handleCalendarGet,
  handleCalendarList as handleCalendarListKernel,
  handleCalendarRsvp,
  handleCalendarSearch,
  handleCalendarStat,
  handleCalendarUpdate,
  type CalendarDispatcherDeps,
} from './calendar-dispatcher.js';
import {
  createCalendarWatcherCursorStore,
  type CalendarWatcherCursorStore,
} from './watcher-cursor-store.js';
import type {
  CalendarProvider,
  CalendarProviderKind,
} from './provider.js';
import type { CalendarAdapterFactory } from './adapter-registry.js';
import type { CalendarEnrollDeps } from './enroll.js';
import type { OAuthAccountStore } from '../mail/oauth.js';

export type CalendarKernelDispatchers = Required<
  Pick<
    KernelDispatchers,
    | 'calendarList'
    | 'calendarGet'
    | 'calendarSearch'
    | 'calendarCreate'
    | 'calendarUpdate'
    | 'calendarDelete'
    | 'calendarRsvp'
    | 'calendarStat'
  >
>;

export type CalendarStackLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: unknown,
) => void;

/** Shared storage dependencies passed to each `CalendarCollection`. */
export interface CalendarStackStorageDeps {
  blobs: BlobStore;
  /** Per-collection storage gate factory. Returns the gate for
   *  `(platform='calendar', slug)`. Mirrors the mail/file pattern —
   *  bin.ts threads the live gate registry through, tests pass a
   *  no-op gate. */
  getGate: (slug: string) => StorageGate;
  /** Warehouse event bus — every verified upsert/delete fires a
   *  warehouse event through the emitter. Shared with mail + file so
   *  the event-trigger dispatcher has a single source of truth. */
  bus: WarehouseEventBus;
  auditLog?: AuditLogStore;
  /** D-121 Phase 1 — derivation hook fired after a successful upsert.
   *  Threaded into every live `CalendarCollection` so contact rows
   *  materialize as calendar events arrive. Optional — production
   *  bin.ts wires this; test harnesses without contact storage can
   *  omit it and the collections run unchanged. */
  onEventUpserted?: (payload: import('./provider.js').ProviderEventPayload) => void;
}

export interface ComposeCalendarStackOptions {
  log?: CalendarStackLogger;
  /** When true, auto-start live collections immediately after
   *  construction. Defaults to false — bin.ts calls `startAll()`
   *  explicitly after the lifecycle manager is ready. */
  autoStart?: boolean;
}

export interface CalendarStack {
  instances: CollectionInstanceStore;
  adapters: CalendarAdapterRegistry;
  /** Read-only snapshot of every live calendar collection — used by
   *  the Phase 10 dashboard UI when listing collections. bin.ts can
   *  pass `listLive()` into heartbeat enrichment if finer-grained
   *  per-collection metadata is needed. */
  listLive(): CalendarCollection[];
  /** Kernel dispatcher slots for the eight calendar-* ingredients. */
  kernelDispatchers: CalendarKernelDispatchers;
  /** Feed to `collectionDeps.calendarEnroll`. Carries `onEnrolled`/
   *  `onDeleted` hooks that maintain the live-collection map. */
  enrollDeps: CalendarEnrollDeps;
  /** Per-recipe `changed_since` cursor store. Threaded into the
   *  shared watcher dispatcher (`createWatcherDispatcher`) as
   *  `calendarWatcherCursors` — calendar-watcher resolves live
   *  collections through the shared `CollectionRegistry` the same
   *  way mail + file do. */
  watcherCursors: CalendarWatcherCursorStore;
  /** Rehydrate every live `CalendarCollection` from the instance
   *  store. Call once at boot before `startServer`. */
  startAll(): Promise<void>;
  /** Stop every live collection. Called from the lifecycle drain's
   *  `pause_collections` step. Idempotent. */
  disposeAll(): Promise<void>;
  /** Start the poll loop for every live collection whose sync is deferred /
   *  stopped — the vault→unlocked edge. Idempotent; collections stay
   *  registered/readable throughout. */
  resumeSync(): Promise<void>;
  /** Stop the poll loop for every live collection without closing it (reads
   *  stay) — the vault→locked edge. Idempotent. */
  pauseSync(): Promise<void>;
}

/** Dependencies the composition root needs to wire the three
 *  first-wave adapters. Optional in test harnesses that don't need
 *  live network — the adapters simply won't register, and any enroll
 *  attempt against that kind surfaces a `bad_request`.
 *
 *  bin.ts threads `accountStore`, `oauthConfig`, and `etagStore`
 *  through to this builder; tests with no network inject
 *  in-memory doubles or skip the optional entries entirely. */
export interface CalendarAdapterBundle {
  /** Factory list. Registered in order; the caller can reuse this
   *  point to inject stubbed factories from tests. */
  factories: CalendarAdapterFactory[];
  /** OAuth config resolver for the enroll rpc path. Each adapter
   *  that needs OAuth (gcal/graph) reads this; return null to
   *  surface `not_configured` on the rpc. */
  oauthConfig?: (adapter: 'gcal' | 'graph') => import('../mail/oauth.js').OAuthProviderConfig | null;
  /** OAuth / account store shared with mail. When absent the enroll
   *  rpc surfaces `not_configured`. */
  accountStore?: OAuthAccountStore;
  /** Test-friendly HTTP fetcher hook. */
  fetcher?: import('../mail/oauth.js').HttpFetcher;
  now?: () => number;
  /** Vault-lock predicate — when it returns false (server vault LOCKED), a live
   *  collection's poll loop is deferred (`sync.start()` skipped) so no provider
   *  fetch happens while sealed. Mirrors the mail stack; `resumeSync()` starts
   *  the deferred loops on the vault→unlocked edge. Absent (dbless / harness —
   *  no vault) ⇒ sync always starts. */
  isVaultUnlocked?: () => boolean;
}

export const composeCalendarStack = (
  db: Database.Database,
  storage: CalendarStackStorageDeps,
  bundle: CalendarAdapterBundle,
  options: ComposeCalendarStackOptions = {},
): CalendarStack => {
  const log: CalendarStackLogger = options.log ?? (() => {});

  const instances = createInstanceStore({ db });
  const adapters = createCalendarAdapterRegistry();
  for (const factory of bundle.factories) {
    adapters.register(factory);
  }
  const watcherCursors = createCalendarWatcherCursorStore(db);

  const live = new Map<string, CalendarCollection>();

  const buildCollectionConfig = (
    row: CollectionInstanceRecord,
  ): CalendarCollectionConfig => {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const num = (key: string, fallback: number): number => {
      const v = cfg[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    };
    return {
      backfill_days: num('backfill_days', 30),
      retention_days: num('retention_days', 365),
      quota_bytes: num('quota_bytes', 512 * 1024 * 1024),
      expansion_past_days: num('expansion_past_days', 30),
      expansion_future_days: num('expansion_future_days', 90),
    };
  };

  const startLive = async (row: CollectionInstanceRecord): Promise<void> => {
    if (live.has(row.slug)) return;
    const factory = adapters.get(row.adapter_type);
    if (!factory) {
      log(
        'warn',
        `calendar-stack: unknown adapter_type '${row.adapter_type}' for slug '${row.slug}' — skipping`,
      );
      return;
    }
    let provider: CalendarProvider;
    try {
      provider = factory.create({
        slug: row.slug,
        config: (row.config ?? {}) as Record<string, unknown>,
        getAccountValue: async (key) =>
          bundle.accountStore
            ? bundle.accountStore.get(`${row.adapter_type}.${row.slug}.${key}`)
            : null,
        log,
      });
    } catch (err) {
      log('error', `calendar-stack: factory.create failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let collection: CalendarCollection;
    try {
      collection = createCalendarCollection({
        db,
        blobs: storage.blobs,
        gate: storage.getGate(row.slug),
        bus: storage.bus,
        slug: row.slug,
        provider,
        config: () => buildCollectionConfig(row),
        ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
        ...(bundle.now ? { now: bundle.now } : {}),
        ...(storage.onEventUpserted ? { onEventUpserted: storage.onEventUpserted } : {}),
        instances,
        log,
      });
    } catch (err) {
      log('error', `calendar-stack: createCalendarCollection failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      try { await provider.close(); } catch { /* ignore */ }
      return;
    }

    live.set(row.slug, collection);

    if (syncDeferredWhileLocked(bundle.isVaultUnlocked)) {
      // Vault LOCKED → defer the poll loop. The collection stays live (its
      // dispatcher reads the plaintext warehouse), but we do NOT start the
      // provider fetch while sealed. `resumeSync()` starts it on unlock.
      log('info', `calendar-stack: sync deferred for '${row.slug}' — vault locked`);
      return;
    }

    try {
      await collection.sync.start();
    } catch (err) {
      log('warn', `calendar-stack: sync.start failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      // The collection still lives in the map — its dispatcher reads
      // continue to work against the warehouse, and a future resync
      // can restart the sync loop.
    }
  };

  const stopLive = async (slug: string): Promise<void> => {
    const collection = live.get(slug);
    if (!collection) return;
    live.delete(slug);
    try {
      await collection.close();
    } catch (err) {
      log('warn', `calendar-stack: close failed for '${slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const dispatchDeps: CalendarDispatcherDeps = {
    instances,
    getCollection: (slug) => live.get(slug),
  };

  // Kernel slots type events as `Record<string, unknown>` (the loose
  // transport shape); server-side handlers use the strict
  // `CanonicalEvent` / `CreateEventInput` / `Partial<CanonicalEvent>`.
  // The boundary casts below bridge the two — runtime values are
  // CanonicalEvent shapes either way, TS just needs the nudge.
  const kernelDispatchers: CalendarKernelDispatchers = {
    calendarList: (input) => handleCalendarListKernel(dispatchDeps, input),
    calendarGet: (input) =>
      handleCalendarGet(dispatchDeps, input) as ReturnType<
        NonNullable<CalendarKernelDispatchers['calendarGet']>
      >,
    calendarSearch: (input) => handleCalendarSearch(dispatchDeps, input),
    calendarStat: (input) => handleCalendarStat(dispatchDeps, input),
    calendarCreate: (input) =>
      handleCalendarCreate(
        dispatchDeps,
        input as Parameters<typeof handleCalendarCreate>[1],
      ),
    calendarUpdate: (input) =>
      handleCalendarUpdate(
        dispatchDeps,
        input as Parameters<typeof handleCalendarUpdate>[1],
      ),
    calendarDelete: (input) => handleCalendarDelete(dispatchDeps, input),
    calendarRsvp: (input) => handleCalendarRsvp(dispatchDeps, input),
  };

  const enrollDeps: CalendarEnrollDeps = {
    instances,
    adapters,
    accountStore: bundle.accountStore ?? {
      // Safe null-route for test harnesses that skip the account
      // store — every enroll that needs credentials throws
      // `not_configured` before reaching this stub.
      async get() { return null; },
      async set() { /* ignored */ },
      async delete() { /* ignored */ },
    },
    ...(bundle.oauthConfig ? { oauthConfig: bundle.oauthConfig } : {}),
    ...(bundle.fetcher ? { fetcher: bundle.fetcher } : {}),
    ...(bundle.now ? { now: bundle.now } : {}),
    onEnrolled: async (row) => {
      // enroll rpc hands us the public `CollectionInstanceRow` (no
      // `config`); pull the full record out of the store to reach
      // the adapter config.
      const full = instances.get('calendar', row.slug);
      if (full) await startLive(full);
    },
    onDeleted: (slug) => stopLive(slug),
  };

  const startAll = async (): Promise<void> => {
    const rows = instances.list('calendar');
    for (const row of rows) {
      try { await startLive(row); }
      catch {
        // startLive logs inline — keep booting.
      }
    }
  };

  const disposeAll = async (): Promise<void> => {
    const slugs = [...live.keys()];
    for (const slug of slugs) {
      await stopLive(slug);
    }
  };

  // R21.1 parity — vault-gated pause/resume of the live poll loops (driven by
  // the vault-state edges in compose-collection-context). Shared with the mail
  // stack via `vault-gated-sync`.
  const onSyncEdgeError = (message: string, err: unknown): void =>
    log('warn', `calendar-stack: ${message}`, {
      err: err instanceof Error ? err.message : String(err),
    });
  const resumeSync = (): Promise<void> =>
    resumeCollectionSync(live.values(), onSyncEdgeError);
  const pauseSync = (): Promise<void> =>
    pauseCollectionSync(live.values(), onSyncEdgeError);

  if (options.autoStart) {
    // Fire-and-forget — constructor callers that opt into autoStart
    // are responsible for logging the returned promise.
    void startAll();
  }

  return {
    instances,
    adapters,
    listLive: () => [...live.values()],
    kernelDispatchers,
    enrollDeps,
    watcherCursors,
    startAll,
    disposeAll,
    resumeSync,
    pauseSync,
  };
};

/** Register every live `CalendarCollection` with the shared
 *  collection registry so heartbeat enrichment + retention sweeps
 *  find them via `registry.list()` the same way they do mail / file
 *  collections. Safe to call after every enroll — dedupes on the
 *  `(platform, slug)` key. */
export const registerCalendarCollections = (
  stack: CalendarStack,
  registry: CollectionRegistry,
): void => {
  for (const collection of stack.listLive()) {
    if (!registry.get('calendar', collection.slug)) {
      registry.register(collection);
    }
  }
};

// Re-export for bin.ts consumers.
export type { CalendarProviderKind };
