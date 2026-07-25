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
 *  carries `onEnrolled` / `onDeleted` hooks so enroll/delete rpcs flow
 *  through the same helpers. `disposeAll()` stops every live adapter
 *  during the lifecycle drain.
 */

import type Database from 'better-sqlite3';
import type { CollectionInstanceRow } from '@recued/contracts';
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
   *  `onDeleted` hooks that maintain the internal live-adapter map
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

  const startLiveAdapter = async (
    row: Pick<CollectionInstanceRow, 'slug' | 'adapter_type'> & {
      config?: Record<string, unknown>;
    },
  ): Promise<void> => {
    if (liveAdapters.has(row.slug)) return;

    const factory = adapters.get(row.adapter_type);
    if (!factory) {
      log(
        'warn',
        `file-stack: unknown adapter_type '${row.adapter_type}' for slug '${row.slug}' — skipping`,
      );
      return;
    }

    const stored = instances.get('file', row.slug);
    const config = row.config ?? stored?.config ?? {};

    let instance: FileAdapterInstance;
    try {
      instance = factory.create({
        slug: row.slug,
        config,
        onEvent: (event) => onEvent(row.slug, event),
        log,
      });
    } catch (err) {
      log('error', `file-stack: factory.create failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
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
      log('error', `file-stack: adapter.start failed for '${row.slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
      await backfillRecorder.finish('failed');
      throw err;
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

  const stopLiveAdapter = async (slug: string): Promise<void> => {
    const instance = liveAdapters.get(slug);
    if (!instance) return;
    liveAdapters.delete(slug);
    try {
      await instance.stop();
    } catch (err) {
      // Failures during stop are logged but swallowed — the caller
      // (enroll rpc delete path or drain) has already removed the row
      // from our map, and blocking the delete on a misbehaving adapter
      // would leave the DB and the in-process map permanently out of
      // sync.
      log('warn', `file-stack: adapter.stop failed for '${slug}'`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

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
    onEnrolled: (row) => startLiveAdapter(row),
    onDeleted: (slug) => stopLiveAdapter(slug),
  };

  const startAll = async (): Promise<void> => {
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

  const disposeAll = async (): Promise<void> => {
    const slugs = [...liveAdapters.keys()];
    for (const slug of slugs) {
      await stopLiveAdapter(slug);
    }
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
