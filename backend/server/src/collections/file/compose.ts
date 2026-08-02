/** Phase 7 (D-110) — file-adapter composition helper.
 *
 *  Assembles the adapter registry, instance store, live-adapter map,
 *  and kernel dispatcher slots for the five file-* ingredients.
 *  bin.ts calls this once, spreads the kernel dispatchers into the
 *  engine config, wires `fileEnroll` onto `collectionDeps`, and passes
 *  `instances` to the heartbeat enrichment step.
 *
 *  Kept out of bin.ts so the composition root stays a narrative — the
 *  registry wiring + dispatcher plumbing are a single logical unit
 *  and belong next to the adapters they compose.
 *
 *  Owns live-adapter lifecycle: `startAll()` rehydrates adapters for
 *  every row already in the instance store (boot path); `enrollDeps`
 *  carries `onEnrolled` / `onDeleted` / `onResync` hooks so enroll,
 *  delete, and manual refresh rpcs flow through the same serialized
 *  helpers. `disposeAll()` stops every live adapter during the lifecycle drain.
 */

import type Database from 'better-sqlite3';
import type { CollectionInstanceRow, FileCollectionCaps } from '@recued/contracts';
import type { KernelDispatchers } from '@recued/ingredients';
import type { AuditLogStore } from '@recued/storage';
import { createBackfillAuditRecorder } from '../../triggers/backfill-audit.js';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../instance-store.js';
import {
  createAdapterRegistry,
  type FileAdapterEvent,
  type FileAdapterInstance,
  type FileAdapterRegistry,
  validateD110FileCaps,
} from './adapter-registry.js';
import { fsAdapterFactory } from './adapters/fs/index.js';
import { createS3AdapterFactory } from './adapters/s3/index.js';
import {
  createExtDownloadsAdapterFactory,
  createExtDownloadsRegistry,
  type ExtDownloadsRegistry,
} from './adapters/ext-downloads/index.js';
import {
  handleFileDelete as handleFileDeleteRecord,
  handleFileMove,
  handleFileRead,
  handleFileStat,
  handleFileWrite,
  type FileDispatcherDeps,
} from './dispatcher.js';
import type { EnrollDeps } from './enroll.js';

export type FileKernelDispatchers = Required<
  Pick<
    KernelDispatchers,
    'fileStat' | 'fileRead' | 'fileWrite' | 'fileDelete' | 'fileMove'
  >
>;

export type FileStackLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: unknown,
) => void;

export interface ComposeFileStackOptions {
  /** Forwarded to every adapter context via `ctx.log`. Defaults to a
   *  no-op so tests that don't care stay quiet. */
  log?: FileStackLogger;
  /** Event sink for adapter-emitted events (present / change / remove).
   *  The Phase 7 v1 composition treats events as advisory — the
   *  mutation dispatcher reads the live adapter directly, so a no-op
   *  is acceptable. Wired up when Phase D file collections are
   *  re-attached to this surface. */
  onEvent?: (slug: string, event: FileAdapterEvent) => Promise<void> | void;
  /** D-124 Phase 2.4 — when supplied, every adapter drain emits a
   *  single `collection_backfill` activity row at completion. Carrying
   *  status / duration / placeholder counts. Optional so test
   *  harnesses that exercise the stack without a live audit-log store
   *  stay simple. */
  auditLog?: AuditLogStore;
}

export interface FileStack {
  instances: CollectionInstanceStore;
  adapters: FileAdapterRegistry;
  extDownloads: ExtDownloadsRegistry;
  kernelDispatchers: FileKernelDispatchers;
  /** Feed to `collectionDeps.fileEnroll`. Carries `onEnrolled` /
   *  `onDeleted` / `onResync` hooks that maintain the internal live-adapter map
   *  so enroll-rpc and delete-rpc flow through the same lifecycle
   *  helpers `startAll()` uses at boot. */
  enrollDeps: EnrollDeps;
  /** Rehydrate live adapters for every row currently in the instance
   *  store. Call once at boot after `autopromoteCollections` has run
   *  so TOML-migrated rows are included. Individual adapter failures
   *  log + skip; startAll resolves when all reachable adapters have
   *  been attempted. */
  startAll(): Promise<void>;
  /** Stop every live adapter and clear the map. Called from the
   *  lifecycle drain's `pause_collections` step. Idempotent. */
  disposeAll(): Promise<void>;
}

export const composeFileStack = (
  db: Database.Database,
  options: ComposeFileStackOptions = {},
): FileStack => {
  const log: FileStackLogger = options.log ?? (() => {});
  const onEvent = options.onEvent ?? (() => {});

  const instances = createInstanceStore({ db });
  const adapters = createAdapterRegistry();
  const extDownloads = createExtDownloadsRegistry();

  adapters.register(fsAdapterFactory);
  adapters.register(createS3AdapterFactory());
  adapters.register(createExtDownloadsAdapterFactory({ registry: extDownloads }));

  const liveAdapters = new Map<string, FileAdapterInstance>();
  const lifecycleTails = new Map<string, Promise<void>>();
  let closed = false;
  let disposePromise: Promise<void> | null = null;

  /** Enroll, delete, boot-start, and manual resync can arrive concurrently.
   *  Serialize lifecycle mutations per slug so two resyncs cannot both observe
   *  an empty live map and leave one untracked watcher running. Different
   *  slugs remain independent. */
  const serializeLifecycle = async <T>(
    slug: string,
    action: () => Promise<T>,
  ): Promise<T> => {
    const prior = lifecycleTails.get(slug) ?? Promise.resolve();
    const run = prior.then(action);
    const tail = run.then(() => undefined, () => undefined);
    lifecycleTails.set(slug, tail);
    try {
      return await run;
    } finally {
      if (lifecycleTails.get(slug) === tail) lifecycleTails.delete(slug);
    }
  };

  const startLiveAdapterUnlocked = async (
    row: Pick<CollectionInstanceRow, 'slug'>,
  ): Promise<void> => {
    if (closed) return;
    if (liveAdapters.has(row.slug)) return;

    // Lifecycle callbacks carry snapshots across awaits. Re-read the row so a
    // concurrent delete cannot start an orphan adapter and a config update
    // cannot start from stale callback data.
    const stored = instances.get('file', row.slug);
    if (!stored) {
      throw new Error(`file-stack: instance row missing for slug '${row.slug}'`);
    }

    const config = stored.config;

    const markStartDegraded = (): void => {
      if (closed) return;
      try {
        instances.updateAuthState('file', row.slug, { auth_state: 'degraded' });
      } catch (err) {
        log('warn', `file-stack: failed to mark '${row.slug}' degraded`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    let caps: FileCollectionCaps;
    try {
      // Fresh enroll/update/resync rows passed through probe already, but boot
      // rehydration reads persisted JSON directly. Re-assert the same closed
      // D-110 boundary so a legacy/corrupt OAuth row cannot start an adapter.
      caps = validateD110FileCaps(stored.adapter_type, stored.caps);
    } catch (err) {
      log('warn', `file-stack: invalid persisted caps for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      markStartDegraded();
      throw err;
    }

    const factory = adapters.get(stored.adapter_type);
    if (!factory) {
      const err = new Error(
        `file-stack: unknown adapter_type '${stored.adapter_type}' for slug '${row.slug}'`,
      );
      log('warn', err.message);
      markStartDegraded();
      throw err;
    }

    let instance: FileAdapterInstance;
    try {
      instance = factory.create({
        slug: row.slug,
        config,
        caps,
        onDegraded: (err) => {
          if (closed) return;
          log('error', `file-stack: adapter runtime degraded for '${row.slug}'`, {
            err: err instanceof Error ? err.message : String(err),
          });
          markStartDegraded();
        },
        onEvent: (event) => closed ? undefined : onEvent(row.slug, event),
        log,
      });
    } catch (err) {
      log('error', `file-stack: factory.create failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      markStartDegraded();
      throw err;
    }

    // D-124 Phase 2.4 — sync-level audit row at drain completion.
    // The compose stack doesn't observe per-record events here (those
    // flow via `options.onEvent` which production wires to a noop
    // logger), so the row carries `records_imported: 0` /
    // `records_failed: 0` / `event_at: null`. Still informative —
    // operators see "the s3 backfill drain for slug='photos'
    // completed in 4 minutes." If a future task threads a recording
    // adapter through `options.onEvent`, the per-record counts can
    // be wired without changing the audit shape.
    const backfillRecorder = createBackfillAuditRecorder({
      auditLog: options.auditLog,
      platform: 'file',
      slug: row.slug,
      log: (level, msg, data) => log(level, msg, data),
    });
    try {
      await instance.start();
    } catch (err) {
      if (closed) {
        try { await instance.stop(); } catch { /* shutdown containment */ }
        return;
      }
      log('error', `file-stack: adapter.start failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      markStartDegraded();
      await backfillRecorder.finish('failed');
      throw err;
    }

    if (closed) {
      // disposeAll may have closed admission while an initial scan was in
      // flight. Do not publish the adapter or write backfill state afterward.
      try { await instance.stop(); } catch { /* shutdown containment */ }
      return;
    }

    // D-124 Phase 2.1 — `instance.start()` resolves only after the
    // adapter's initial walk has fired `present` events for every
    // existing record (fs-adapter scanDir / s3 list-objects-v2 first
    // page / ext-downloads chrome.downloads enumeration). Flip the
    // denormalized backfill bool exactly once now; idempotent on
    // restart since the column write is idempotent UPDATE-by-key.
    try { instances.markBackfillComplete('file', row.slug); }
    catch (err) {
      log('warn', `file-stack: markBackfillComplete failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    await backfillRecorder.finish();

    liveAdapters.set(row.slug, instance);
  };

  const stopLiveAdapterUnlocked = async (
    slug: string,
    failOnError = false,
  ): Promise<void> => {
    const instance = liveAdapters.get(slug);
    if (!instance) return;
    // Delete/drain are terminal and remove the entry up front. Strict resync
    // keeps it registered until stop succeeds, so repeated retries cannot
    // forget an uncertain live adapter and create a duplicate.
    if (!failOnError) liveAdapters.delete(slug);
    try {
      await instance.stop();
      if (failOnError && liveAdapters.get(slug) === instance) {
        liveAdapters.delete(slug);
      }
    } catch (err) {
      // Delete/drain callers swallow stop failures because the row has already
      // left the live map. Resync opts into fail-closed propagation below.
      log('warn', `file-stack: adapter.stop failed for '${slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      // Delete/drain remain best-effort, but a resync keeps the uncertain
      // instance registered and must not start a second adapter.
      if (failOnError) throw err;
    }
  };

  const startLiveAdapter = (
    row: Parameters<typeof startLiveAdapterUnlocked>[0],
  ): Promise<void> => serializeLifecycle(
    row.slug,
    () => startLiveAdapterUnlocked(row),
  );

  const stopLiveAdapter = (slug: string): Promise<void> => serializeLifecycle(
    slug,
    () => stopLiveAdapterUnlocked(slug),
  );

  /** A user-requested resync is deliberately a one-shot restart, not a new
   *  timer. For `watch: none` fs instances, `start()` performs the recursive
   *  scan and stays idle; realtime instances rescan and reattach their watch.
   *  A failed stop aborts replacement, avoiding an untracked duplicate. */
  const resyncLiveAdapter = (row: CollectionInstanceRow): Promise<void> =>
    serializeLifecycle(row.slug, async () => {
      if (closed) return;
      await stopLiveAdapterUnlocked(row.slug, true);
      if (closed) return;
      await startLiveAdapterUnlocked({
        slug: row.slug,
      });
    });

  const dispatchDeps: FileDispatcherDeps = {
    instances,
    getAdapter: (slug) => liveAdapters.get(slug),
  };

  const kernelDispatchers: FileKernelDispatchers = {
    fileStat: (input) => handleFileStat(dispatchDeps, input),
    fileRead: (input) => handleFileRead(dispatchDeps, input),
    fileWrite: (input) => handleFileWrite(dispatchDeps, input),
    fileDelete: (input) => handleFileDeleteRecord(dispatchDeps, input),
    fileMove: (input) => handleFileMove(dispatchDeps, input),
  };

  const enrollDeps: EnrollDeps = {
    instances,
    adapters,
    onEnrolled: (row) => closed ? Promise.resolve() : startLiveAdapter(row),
    onDeleted: (slug) => closed ? Promise.resolve() : stopLiveAdapter(slug),
    onResync: (row) => closed ? Promise.resolve() : resyncLiveAdapter(row),
  };

  const startAll = async (): Promise<void> => {
    if (closed) return;
    const rows = instances.list('file');
    for (const row of rows) {
      try {
        await startLiveAdapter(row);
      } catch {
        // startLiveAdapter logs — continue with the next row so one
        // broken instance doesn't block the server from booting.
      }
    }
  };

  const disposeAll = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    // Close admission before taking either snapshot. Already-queued resyncs
    // remain in lifecycleTails and observe `closed` before replacement starts.
    closed = true;
    const slugs = new Set([...liveAdapters.keys(), ...lifecycleTails.keys()]);
    const drains = [...slugs].map((slug) => serializeLifecycle(
      slug,
      () => stopLiveAdapterUnlocked(slug, true),
    ));
    disposePromise = Promise.allSettled(drains).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'file-stack: one or more adapters failed to stop');
      }
    });
    return disposePromise;
  };

  return {
    instances,
    adapters,
    extDownloads,
    kernelDispatchers,
    enrollDeps,
    startAll,
    disposeAll,
  };
};
