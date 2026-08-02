/** D-117 Phase 6 — calendar collection composition root.
 *
 *  Composes `CalendarCollectionTable` + `CalendarProvider` + retention
 *  emitter + a `Collection`-shaped wrapper into the surface bin.ts
 *  hands to the registry and the dispatcher consumes.
 *
 *  Differences from `mail-collection.ts`:
 *
 *  - Storage is `CalendarCollectionTable` (per-event hot columns +
 *    `prior_payload` rotation) rather than the generic
 *    `CollectionTable`. Reads in the dispatcher hit the calendar table
 *    directly; the `Collection` surface emits empty for legacy
 *    `collection.list` rpc against calendar slugs (recipes use the
 *    new `calendar-list` kernel ingredient instead).
 *  - The provider's mutate methods feed verified canonical events
 *    back into the warehouse — the dispatcher calls
 *    `applyVerifiedUpsert`/`applyVerifiedDelete` so the same
 *    inline-vs-CAS split applies to write-back as it does to sync.
 *  - `event_count` + `upcoming_count_24h` come from the table; the
 *    rest of `CollectionHealth` is the standard sync envelope.
 *
 *  The `Collection` surface returned here is **read-only** — `upsert`,
 *  `delete`, `list`, `search`, `get` emit empty results / no-ops.
 *  Calendar bypasses those legacy entry points; recipes use the
 *  calendar-* kernel ingredients which route through the dispatcher
 *  directly to the table. We still register the calendar `Collection`
 *  with the shared registry so heartbeat enrichment + retention runs
 *  through the same orchestration.
 */

import type Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type {
  CalendarCollectionHealth,
  CollectionHealth,
  CollectionListQuery,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { BlobStore } from '../../storage/blob-store.js';
import type { CollectionInstanceStore } from '../instance-store.js';
import { createBackfillAuditRecorder } from '../../triggers/backfill-audit.js';
import {
  createCollectionRetention,
  type CollectionRetention,
} from '../retention.js';
import {
  createCollectionEmitter,
  type CollectionEventEmitter,
} from '../events.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../types.js';
import {
  CALENDAR_INLINE_CUTOFF_BYTES,
  createCalendarTable,
  type CalendarCollectionTable,
  type CalendarListQuery,
  type CalendarRowSnapshot,
} from './calendar-table.js';
import type {
  CalendarProvider,
  CalendarSyncEvent,
  ProviderEventPayload,
} from './provider.js';

/** Default upcoming-window for the heartbeat counter. */
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CalendarCollectionConfig {
  backfill_days: number;
  retention_days: number;
  quota_bytes: number;
  expansion_past_days: number;
  expansion_future_days: number;
}

export interface CreateCalendarCollectionOptions {
  db: Database.Database;
  blobs: BlobStore;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: string;
  /** Pre-constructed provider — phase 3/4/5 factories build this from
   *  adapter config + account-store readers. The collection only
   *  touches the narrow surface so the dispatcher stays
   *  provider-agnostic. */
  provider: CalendarProvider;
  config: () => CalendarCollectionConfig;
  auditLog?: AuditLogStore;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** D-121 Phase 1 — derivation hook fired after a successful upsert.
   *  The contact-derive integration uses this to materialize
   *  `data.contact` rows from organizer + attendees; left undefined
   *  the collection runs unchanged. Errors thrown by the hook are
   *  swallowed via `bumpError` so a contact write failure never
   *  rolls back a verified calendar ingest. */
  onEventUpserted?: (payload: ProviderEventPayload) => void;
  /** D-124 Phase 2.1 — instance store reference used to flip
   *  `collection_instances.backfill_complete` to true after the
   *  provider's `initialScan` resolves successfully. Optional so test
   *  harnesses that exercise upsert / sync paths without a live
   *  enrollment row don't have to thread one in. Production stacks
   *  always supply it via `composeCalendarStack`. */
  instances?: CollectionInstanceStore;
}

/** Public surface — the Collection registered with the registry plus
 *  the calendar table + provider so the dispatcher can hit them
 *  directly without re-walking the registry. */
export interface CalendarCollection extends Collection {
  /** Calendar warehouse table backing the dispatcher's read path. */
  readonly table: CalendarCollectionTable;
  /** Live provider used for write-back. The dispatcher calls
   *  `provider.<mutate>` and on verified success hands the returned
   *  `ProviderEventPayload` back to `applyVerifiedUpsert`. */
  readonly provider: CalendarProvider;
  /** Apply a verified upsert to the warehouse — runs the same body-
   *  split (inline vs CAS) as the sync tick. The dispatcher uses this
   *  on `create`/`update`/`rsvp` to keep "remote-wins, verified-then-
   *  reflected" intact. */
  applyVerifiedUpsert(payload: ProviderEventPayload): Promise<void>;
  /** Apply a verified delete — drops the row + emits warehouse
   *  events. Used by the dispatcher on `delete`. */
  applyVerifiedDelete(source_id: string): void;
}

const stateName = (s: CollectionState): CollectionState => s;

/** Decide inline vs CAS for an event description and persist + return
 *  the body-split fields the table accepts. Mirrors the inline-vs-CAS
 *  branching used by mail-collection.ts. */
const splitDescriptionForStorage = async (
  payload: ProviderEventPayload,
  blobs: BlobStore,
): Promise<{ body_inline?: string; blob_hash?: string; size_bytes: number }> => {
  const description = payload.event.description ?? '';
  const size_bytes = payload.description_bytes;
  if (size_bytes === 0 || description === '') {
    return { size_bytes };
  }
  if (size_bytes <= CALENDAR_INLINE_CUTOFF_BYTES) {
    return { body_inline: description, size_bytes };
  }
  const blob_hash = await blobs.put(Buffer.from(description, 'utf8'));
  return { blob_hash, size_bytes };
};

/** D-198 Slice 5 — project a calendar warehouse snapshot into the generic
 *  `CollectionRecord` the `collection.list` / `collection.get` rpc return. The
 *  snapshot's `hot` set already carries the D-119 display fields (summary /
 *  start_at / end_at / location), so the schema-driven explorer renders it with
 *  no bespoke code. Body follows the same inline-vs-CAS split as mail. */
const snapshotToCollectionRecord = (snap: CalendarRowSnapshot): CollectionRecord => {
  const record: CollectionRecord = {
    record_id: snap.record_id,
    received_at: snap.received_at,
    modified_at: snap.modified_at,
    size_bytes: snap.size_bytes,
    source_id: snap.source_id,
    hot_fields: { ...snap.hot },
  };
  if (snap.body_inline !== null) record.body_inline = snap.body_inline;
  if (snap.blob_hash !== null) record.blob_hash = snap.blob_hash;
  return record;
};

/** Map the generic list query onto the calendar warehouse query. Only the
 *  fields the calendar table can filter on are carried (limit / modified_since /
 *  calendar_id / status); browse order = most-recent events first.
 *
 *  Generic `since`/`until` are `received_at` bounds. The calendar warehouse list
 *  filters on `start_at` / `modified_at`, NOT a `received_at` range, so it can't
 *  honor them — and a forward cursor walk over them would silently MISS rows
 *  (limit applied on the wrong axis). Rather than return quietly-wrong data we
 *  fail loud: the only callers today (the Data explorer + the calendar
 *  source-walker) never send `since`/`until`. Add real `received_at` filtering +
 *  ordering here if a consumer ever needs it. */
const toCalendarListQuery = (query: CollectionListQuery): CalendarListQuery => {
  if (query.since !== undefined || query.until !== undefined) {
    throw new Error(
      'calendar collection.list does not support since/until (received_at) filtering',
    );
  }
  const out: CalendarListQuery = { order_by: 'start_at', direction: 'desc' };
  if (query.limit !== undefined) out.limit = query.limit;
  if (query.modified_since !== undefined) out.modified_since = query.modified_since;
  const calendarId = query.filters?.calendar_id;
  if (typeof calendarId === 'string') out.calendar_id = calendarId;
  const status = query.filters?.status;
  if (typeof status === 'string') out.status = status as CalendarListQuery['status'];
  return out;
};

export const createCalendarCollection = (
  opts: CreateCalendarCollectionOptions,
): CalendarCollection => {
  const { db, blobs, gate, bus, slug, provider, log } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  const table: CalendarCollectionTable = createCalendarTable({
    db,
    slug,
    onBytesChanged: (delta) => { gate.addUsed(delta); },
  });

  const emitter: CollectionEventEmitter = createCollectionEmitter({
    bus,
    platform: 'calendar',
    slug,
    entityType: 'calendar_event',
    now: () => nowOf(),
  });

  const retention: CollectionRetention = createCollectionRetention({
    table,
    platform: 'calendar',
    slug,
    auditLog: opts.auditLog,
    now: () => nowOf(),
    config: () => ({ retentionDays: opts.config().retention_days }),
  });

  let state: CollectionState = stateName('idle');
  let lastIndexedAt = 0;
  let localErrorCount = 0;
  let stopSync: (() => Promise<void>) | undefined;
  let startInFlight: Promise<void> | null = null;
  let syncGeneration = 0;
  let closed = false;

  const bumpError = (msg: string, err: unknown): void => {
    localErrorCount++;
    log?.('warn', msg, { err: err instanceof Error ? err.message : String(err) });
  };

  const upsertPayload = async (payload: ProviderEventPayload): Promise<void> => {
    const split = await splitDescriptionForStorage(payload, blobs);
    const prev = table.upsert({
      event: payload.event,
      size_bytes: split.size_bytes,
      ...(split.body_inline !== undefined ? { body_inline: split.body_inline } : {}),
      ...(split.blob_hash !== undefined ? { blob_hash: split.blob_hash } : {}),
      ...(payload.etag !== undefined ? { etag: payload.etag } : {}),
      now: nowOf(),
    });
    const recordId = `cal:${slug}:${payload.event.source_id}`;
    if (prev) emitter.updated(recordId, prev.hot as unknown as Record<string, unknown>);
    else emitter.created(recordId);
    lastIndexedAt = nowOf();
    if (opts.onEventUpserted) {
      try { opts.onEventUpserted(payload); }
      catch (err) { bumpError(`calendar onEventUpserted hook failed for ${payload.event.source_id}`, err); }
    }
  };

  const deleteSource = (source_id: string): void => {
    const result = table.delete(source_id);
    if (!result.deleted || !result.prior) return;
    const recordId = `cal:${slug}:${source_id}`;
    emitter.deleted(recordId, result.prior.hot as unknown as Record<string, unknown>);
  };

  const onSyncEvent = async (event: CalendarSyncEvent): Promise<void> => {
    try {
      if (event.kind === 'deleted') {
        deleteSource(event.source_id);
        return;
      }
      if (!event.payload) {
        bumpError(`calendar sync ${event.kind} event missing payload`, null);
        return;
      }
      await upsertPayload(event.payload);
    } catch (err) {
      bumpError(`calendar sync ingest failed for ${event.source_id}`, err);
    }
  };

  const isCurrentGeneration = (generation: number): boolean =>
    !closed && syncGeneration === generation;

  const runSyncStart = async (generation: number): Promise<void> => {
    state = stateName('syncing');
    try {
      await provider.connect();
    } catch (err) {
      if (!isCurrentGeneration(generation)) return;
      state = stateName('error');
      bumpError('calendar provider connect failed', err);
      throw err;
    }
    if (!isCurrentGeneration(generation)) return;

    // D-124 Phase 2.4 — record one sync-level `collection_backfill`
    // activity row at drain completion. `recordImport(start_at)`
    // tags the underlying calendar event date so `data.timeline()`
    // event-axis queries can later show the imported window
    // (e.g. earliest → latest event of the user's 5-year history).
    // `recordFailure()` captures per-event ingest failures (the
    // provider's payload was malformed, retention rejected the
    // body, etc.) without aborting the drain.
    const backfillRecorder = createBackfillAuditRecorder({
      auditLog: opts.auditLog,
      platform: 'calendar',
      slug,
      now: nowOf,
      log,
    });
    try {
      await provider.initialScan({
        backfill_days: opts.config().backfill_days,
        expansion_future_days: opts.config().expansion_future_days,
        expansion_past_days: opts.config().expansion_past_days,
        onEvent: async (payload) => {
          if (!isCurrentGeneration(generation)) return false;
          const before = localErrorCount;
          try { await upsertPayload(payload); } catch (err) {
            bumpError(`calendar initialScan ingest failed`, err);
          }
          if (!isCurrentGeneration(generation)) return false;
          if (localErrorCount > before) backfillRecorder.recordFailure();
          else backfillRecorder.recordImport(payload.event.start_at);
          return true;
        },
      });
      if (!isCurrentGeneration(generation)) return;
      // D-124 Phase 2.1 — flip the denormalized backfill bool
      // exactly once when the provider's initial drain resolves.
      // The provider's cursor (gcal nextSyncToken / graph
      // calendarView range / caldav etagStore) is now stable;
      // future restarts re-enter this code path but the write is
      // idempotent. Threaded as optional so legacy in-memory test
      // harnesses keep working without an instance row.
      try { opts.instances?.markBackfillComplete('calendar', slug); }
      catch (err) { bumpError('calendar markBackfillComplete failed', err); }
      await backfillRecorder.finish();
    } catch (err) {
      if (!isCurrentGeneration(generation)) return;
      bumpError('calendar initialScan failed', err);
      await backfillRecorder.finish('failed');
    }
    if (!isCurrentGeneration(generation)) return;
    try {
      const stop = await provider.startSync(async (event) => {
        if (!isCurrentGeneration(generation)) return;
        await onSyncEvent(event);
      });
      if (!isCurrentGeneration(generation)) {
        try { await stop(); } catch { /* stale start teardown */ }
        return;
      }
      stopSync = stop;
      state = stateName('connected');
      lastIndexedAt = nowOf();
    } catch (err) {
      if (!isCurrentGeneration(generation)) return;
      state = stateName('error');
      bumpError('calendar startSync failed', err);
    }
  };

  const sync: CollectionSyncAdapter = {
    start() {
      if (closed || stopSync) return Promise.resolve();
      if (startInFlight) return startInFlight;
      const generation = syncGeneration;
      let active: Promise<void>;
      active = runSyncStart(generation).finally(() => {
        if (startInFlight === active) startInFlight = null;
      });
      startInFlight = active;
      return active;
    },
    async stop() {
      // Invalidate initial-scan and live-sync callbacks before the first await.
      syncGeneration += 1;
      state = stateName('disconnected');
      const activeStart = startInFlight;
      const stops: Promise<void>[] = [];
      const failures: unknown[] = [];
      if (stopSync) {
        const s = stopSync;
        stopSync = undefined;
        try {
          stops.push(Promise.resolve(s()).catch((err) => {
            bumpError('calendar stopSync failed', err);
            failures.push(err);
          }));
        } catch (err) {
          bumpError('calendar stopSync failed', err);
          failures.push(err);
        }
      }
      const closeProvider = async (): Promise<void> => {
        try {
          await provider.close();
        } catch (err) {
          bumpError('calendar close failed', err);
          failures.push(err);
        }
      };
      stops.push(closeProvider());
      if (activeStart) stops.push(activeStart.catch(() => undefined));
      await Promise.all(stops);
      // `close()` is also the cancellation signal for a slow provider connect
      // or initial scan. If that operation acquired a socket after the first
      // close raced past it, seal the late-open window once the owned start has
      // settled (mail's collection lifecycle has the same final fence).
      if (activeStart) await closeProvider();
      if (failures.length > 0) {
        throw new AggregateError(failures, 'calendar collection failed to stop');
      }
    },
  };

  const health = (): CollectionHealth => {
    let providerHealth = {
      last_successful_sync_at: 0,
      error_count_24h: 0,
      pending_queue_size: 0,
      pending_series_expansions: 0,
    };
    try { providerHealth = provider.health(); } catch { /* never bubble */ }
    const now = nowOf();
    const calendarHealth: CalendarCollectionHealth = {
      platform: 'calendar',
      slug,
      last_indexed_at: Math.max(lastIndexedAt, providerHealth.last_successful_sync_at),
      pending_queue_size:
        providerHealth.pending_queue_size + providerHealth.pending_series_expansions,
      error_count_24h: providerHealth.error_count_24h + localErrorCount,
      state,
      event_count: table.eventCount(),
      upcoming_count_24h: table.upcomingCount(now, UPCOMING_WINDOW_MS),
    };
    return calendarHealth;
  };

  const runRetention = async (): Promise<CollectionPruneResult> => retention.run();

  const applyVerifiedUpsert = async (payload: ProviderEventPayload): Promise<void> => {
    await upsertPayload(payload);
  };
  const applyVerifiedDelete = (source_id: string): void => {
    deleteSource(source_id);
  };

  // The Collection surface — calendar exposes its own kernel
  // ingredients, so the legacy `collection.list/get/search` rpc
  // against calendar slugs returns empty + no-ops on writes. The
  // table is the canonical source the dispatcher reads from.
  return {
    platform: 'calendar',
    slug,
    gate,
    sync,
    upsert: (_record: CollectionRecord) => { /* legacy surface — dispatcher writes via applyVerifiedUpsert */ },
    delete: (_record_id: string) => false,
    // D-198 Slice 5 — real read surface (the dispatcher still owns writes). The
    // warehouse table backs `collection.get` / `collection.list` so the Data
    // explorer can browse calendar events like mail / files.
    get: (record_id: string): CollectionRecord | null => {
      const snap = table.getByRecordId(record_id);
      return snap === null ? null : snapshotToCollectionRecord(snap);
    },
    list: (query: CollectionListQuery): CollectionRecord[] =>
      table.listSnapshots(toCalendarListQuery(query)).map(snapshotToCollectionRecord),
    search: (_query: CollectionSearchQuery): CollectionSearchMatch[] => [],
    health,
    runRetention,
    async close() {
      closed = true;
      await sync.stop();
    },
    table,
    provider,
    applyVerifiedUpsert,
    applyVerifiedDelete,
  };
};
