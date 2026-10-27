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
import { settleWithin, STOP_GRACE_MS } from '../../lifecycle/settle-within.js';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../instance-store.js';
import {
  createAdapterRegistry,
  isMutationCapable,
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
import {
  createWatchedFolders,
  type WatchedFolders,
  type WatchedFoldersAttachment,
} from './watched-folders.js';

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
  /** Event sink for adapter-emitted events (present / change / remove),
   *  beside the watched folders' collections (`attachWatchedFolders`), which
   *  get an `fs` folder's events whether or not this is set. */
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
  /** D-245 — the LIVE adapter for a slug, or undefined when it is not started.
   *  Exposed because `file-put-ref` is wired outside this module (it needs the
   *  CAS reader, which lives with the executor deps) but must go through the
   *  same live map — re-deriving one there could write through an adapter this
   *  stack considers stopped. */
  getLiveAdapter: (slug: string) => FileAdapterInstance | undefined;
  extDownloads: ExtDownloadsRegistry;
  kernelDispatchers: FileKernelDispatchers;
  /** Feed to `collectionDeps.fileEnroll`. Carries `onEnrolled` /
   *  `onDeleted` / `onResync` hooks that maintain the internal live-adapter map
   *  so enroll-rpc and delete-rpc flow through the same lifecycle
   *  helpers `startAll()` uses at boot. */
  enrollDeps: EnrollDeps;
  /** Rehydrate live adapters for every row currently in the instance
   *  store. Call once at boot. Individual adapter failures log + skip;
   *  startAll resolves when all reachable adapters have been
   *  attempted. */
  startAll(): Promise<void>;
  /** Stop every live adapter and clear the map. Called from the
   *  lifecycle drain's `pause_collections` step; resolves within
   *  `STOP_GRACE_MS`. Idempotent. */
  disposeAll(): Promise<void>;
  /** D-106 follow-up — give every `fs` folder a collection of its records
   *  (`watched-folders.ts`). Call once, before `startAll`, when the registry
   *  and the warehouse bus exist: a folder started before it gets its
   *  collection at its next start. */
  attachWatchedFolders(attachment: WatchedFoldersAttachment): void;
  /** The attached folders, for tests and diagnostics. */
  watchedFolders(): WatchedFolders | undefined;
  /** The folders the housekeeping walk covers (`watched-folder-walk`): every
   *  `fs` folder with records whose realtime watch runs now, and when its last
   *  walk ended. */
  watchedFolderWalks(): Array<{ slug: string; last_walk_at: number }>;
  /** Walk a folder again as a start does, behind its other lifecycle steps.
   *  Resolves once the walk is over; a failure is logged, not thrown. */
  walkFolderAgain(slug: string): Promise<void>;
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
  /** Adapters in their first walk: not live until it ends, but `disposeAll`
   *  stops them here rather than wait for a walk that only a stop ends. */
  const starting = new Map<string, FileAdapterInstance>();
  let watched: WatchedFolders | undefined;
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

  /** A folder's watch may have missed changes (`onRescanNeeded`), or the
   *  housekeeping walk is due (`walkFolderAgain`): walk it again as a start
   *  does, so what changed meanwhile lands and what went is taken out. Behind
   *  the folder's other lifecycle steps; a request while one is waiting joins
   *  it. Resolves once the walk is over; a failure is logged, not thrown. */
  const walksWaiting = new Map<string, Promise<void>>();
  const walkAgain = (slug: string): Promise<void> => {
    const waiting = walksWaiting.get(slug);
    if (waiting) return waiting;
    if (closed) return Promise.resolve();
    const walk = serializeLifecycle(slug, async () => {
      walksWaiting.delete(slug);
      const instance = liveAdapters.get(slug);
      const folder = watched?.get(slug);
      if (closed || !instance?.rescan || !folder) return;
      folder.beginWalk();
      let complete = false;
      try {
        ({ complete } = await instance.rescan());
      } finally {
        await folder.endWalk({ complete });
      }
    }).catch((err: unknown) => {
      log('warn', `file-stack: walking '${slug}' again failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    walksWaiting.set(slug, walk);
    return walk;
  };
  const requestRescan = (slug: string): void => { void walkAgain(slug); };

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

    // D-106 follow-up — an `fs` folder's events become its records. Opened
    // before the adapter starts, so the walk's `present` events land.
    const folder = stored.adapter_type === 'fs' ? watched?.open(row.slug) : undefined;
    let backfillRecorder: ReturnType<typeof createBackfillAuditRecorder> | undefined;
    const deliver = async (event: FileAdapterEvent): Promise<void> => {
      if (closed) return;
      if (folder) {
        const result = await folder.ingest(event);
        // Counts the walk's files; the recorder ignores anything after it.
        if (result.outcome === 'stored') backfillRecorder?.recordImport(result.mtime);
        else if (result.outcome === 'failed') backfillRecorder?.recordFailure();
      }
      await onEvent(row.slug, event);
    };

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
        onEvent: deliver,
        ...(folder ? { onRescanNeeded: () => requestRescan(row.slug) } : {}),
        log,
      });
    } catch (err) {
      log('error', `file-stack: factory.create failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      markStartDegraded();
      throw err;
    }

    // D-124 Phase 2.4 — sync-level audit row at drain completion. An `fs`
    // folder with a collection counts its walk's files through `deliver`;
    // any other adapter's row carries `records_imported: 0` /
    // `records_failed: 0` / `event_at: null`, which still says "the s3
    // backfill drain for slug='photos' completed in 4 minutes."
    const recorder = createBackfillAuditRecorder({
      auditLog: options.auditLog,
      platform: 'file',
      slug: row.slug,
      log: (level, msg, data) => log(level, msg, data),
    });
    backfillRecorder = recorder;
    folder?.beginWalk();
    // Reachable by `disposeAll` until this start ends (`startTrackedUnlocked`).
    starting.set(row.slug, instance);
    try {
      await instance.start();
    } catch (err) {
      // A walk a stop cut short throws too: it is not complete, so nothing it
      // did not reach is taken for removed.
      await folder?.endWalk({ complete: false });
      if (closed) {
        try { await instance.stop(); } catch { /* shutdown containment */ }
        return;
      }
      log('error', `file-stack: adapter.start failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      markStartDegraded();
      await recorder.finish('failed');
      throw err;
    }
    // `start()` resolved after the adapter's walk: a stored file it did not
    // see is gone, unless the walk could not read part of the folder.
    await folder?.endWalk({ complete: instance.walkErrors?.() === 0 });

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
    // A watched folder's walk is its sync, as a resync already records
    // (`handleFileResync`). Unstamped, Connections showed every folder as
    // "First sync pending" for good while its files were already in the Files
    // tab (live drive, 2026-10-10). Only a folder with records: an s3 or
    // ext-downloads source keeps none, so "Ready for Chat" would be untrue.
    if (folder) {
      try { instances.updateAuthState('file', row.slug, { auth_state: 'healthy', last_synced_at: Date.now() }); }
      catch (err) {
        log('warn', `file-stack: recording the sync time failed for '${row.slug}'`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await recorder.finish();
    // disposeAll may have closed admission while the audit row was written.
    if (closed) {
      try { await instance.stop(); } catch { /* shutdown containment */ }
      return;
    }

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

  /** A start, its adapter reachable by `disposeAll` (`starting`) until it ends.
   *  Lifecycle steps run one at a time per slug, so the slug names this start's
   *  adapter alone. */
  const startTrackedUnlocked = async (
    row: Parameters<typeof startLiveAdapterUnlocked>[0],
  ): Promise<void> => {
    try {
      await startLiveAdapterUnlocked(row);
    } finally {
      starting.delete(row.slug);
    }
  };

  const startLiveAdapter = (
    row: Parameters<typeof startLiveAdapterUnlocked>[0],
  ): Promise<void> => serializeLifecycle(
    row.slug,
    () => startTrackedUnlocked(row),
  );

  /** The enrollment was deleted: stop the adapter, then its records go. */
  const deleteLiveAdapter = (slug: string): Promise<void> => serializeLifecycle(
    slug,
    async () => {
      await stopLiveAdapterUnlocked(slug);
      watched?.drop(slug);
    },
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
      await startTrackedUnlocked({
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
    onDeleted: (slug) => closed ? Promise.resolve() : deleteLiveAdapter(slug),
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
    // Stop every adapter now — the live ones and those still in their first
    // walk — rather than queue each stop behind the lifecycle step running on
    // its folder: that step is often the walk itself (a start, a resync, a
    // rescan, an S3 listing), which only a stop ends. A walk cut short says so
    // (`walkErrors`, `rescan`'s `complete`), so its folder takes nothing it
    // did not reach for removed, and the next start walks again.
    const toStop = new Map<FileAdapterInstance, string>();
    for (const [slug, instance] of liveAdapters) toStop.set(instance, slug);
    for (const [slug, instance] of starting) toStop.set(instance, slug);
    liveAdapters.clear();
    const stops = [...toStop].map(async ([instance, slug]) => {
      try {
        await instance.stop();
      } catch (err) {
        log('warn', `file-stack: adapter.stop failed for '${slug}'`, {
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    // The lifecycle steps those stops cut short then unwind (their tails never
    // reject). Both waits are bounded: past `STOP_GRACE_MS`, what is still
    // running was told to stop, and the drain's exit ends it.
    const work = Promise.allSettled([...stops, ...lifecycleTails.values()]);
    disposePromise = settleWithin(work, STOP_GRACE_MS).then(async (waited) => {
      if (waited === 'timed_out') {
        log('warn', `file-stack: stopped waiting for folders to stop after ${STOP_GRACE_MS} ms`);
        return;
      }
      const errors = (await Promise.allSettled(stops))
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
    getLiveAdapter: (slug: string) => liveAdapters.get(slug),
    adapters,
    extDownloads,
    kernelDispatchers,
    enrollDeps,
    startAll,
    disposeAll,
    attachWatchedFolders(attachment) {
      if (watched) return;
      watched = createWatchedFolders({
        ...attachment,
        db,
        rootOf: (slug) => {
          const path = instances.get('file', slug)?.config.path;
          return typeof path === 'string' && path.length > 0 ? path : undefined;
        },
        status: (slug) => {
          const row = instances.get('file', slug);
          return {
            running: liveAdapters.has(slug),
            watching: liveAdapters.has(slug)
              && (row?.caps as FileCollectionCaps | undefined)?.watch === 'realtime',
            auth_state: row?.auth_state ?? 'degraded',
          };
        },
        adapter: (slug) => {
          const live = liveAdapters.get(slug);
          return live && isMutationCapable(live) ? live : undefined;
        },
        log,
      });
    },
    watchedFolders: () => watched,
    watchedFolderWalks: () => {
      const walks: Array<{ slug: string; last_walk_at: number }> = [];
      for (const slug of liveAdapters.keys()) {
        const folder = watched?.get(slug);
        const caps = instances.get('file', slug)?.caps as FileCollectionCaps | undefined;
        if (folder && caps?.watch === 'realtime') walks.push({ slug, last_walk_at: folder.lastWalkAt() });
      }
      return walks;
    },
    walkFolderAgain: walkAgain,
  };
};
