/** Phase D (D-106) — per-collection warehouse event wrapper.
 *
 *  Thin ergonomics layer over `@recued/warehouse-events`: each
 *  collection adapter builds a `CollectionEventEmitter` bound to its
 *  `(platform, slug, entity_type)` triple. The emitter exposes
 *  `created` / `updated` / `deleted` / `synced` helpers that stamp
 *  `at: now()` and hand the event off to the shared bus.
 *
 *  The goal is to keep adapter code free of the bus plumbing so
 *  concrete modules (mail / file / webhook) focus on source-specific
 *  fetch + canonicalization. Subscribers (recipe triggers — Phase G)
 *  attach to the same bus and don't care which emitter produced an
 *  event. Listener failures never reach the emitter — `bus.emit`
 *  swallows listener exceptions (see `@recued/warehouse-events/bus`).
 */

import { isDeepStrictEqual } from 'node:util';

import type {
  WarehouseEvent,
  WarehouseEventBus,
  WarehouseEventKind,
} from '@recued/warehouse-events';

/** D-124 — the hot fields that differ between a record's stored row and the
 *  row it becomes, by name. Empty for a record listed again as it was: a
 *  restart's scan re-reads what it stored, and that is no update. */
export const changedHotFields = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((key) => !isDeepStrictEqual(before[key], after[key]));
import type { CollectionPlatform } from '@recued/contracts';

/** What each concrete adapter calls when a record or sync tick
 *  changes. Record-level methods (`created` / `updated` / `deleted`)
 *  take the affected `record_id`; `synced` is a batch signal that
 *  accepts an optional id — adapters pass a fold key (e.g. a folder
 *  id) when they want subscribers to distinguish partial syncs, or
 *  nothing for a whole-collection tick.
 *
 *  D-124 Phase 1 — `updated` and `deleted` carry a `prev` snapshot of
 *  the record's prior canonical hot-fields. Triggers fire
 *  `{{context.event.payload.prev.<field>}}` against this. `created`
 *  takes no `prev` (no prior state by definition). The shape is
 *  adapter-defined; each collection's emit site documents which
 *  fields it populates. */
/** How a record event came about, beyond its kind. */
export interface CollectionEmitOptions {
  /** Published while another collection drained its initial backfill
   *  (`WarehouseEvent.in_drain`). */
  readonly in_drain?: boolean;
  /** The record as written (`WarehouseEvent.record`), for a collection whose
   *  rows are small enough to ride the event: a trigger's `filter` reads it
   *  before a run is queued. */
  readonly record?: Readonly<Record<string, unknown>>;
}

export interface CollectionEventEmitter {
  created(record_id: string, options?: CollectionEmitOptions): void;
  /** `changed_fields` names what changed, where the adapter knows it: a
   *  trigger's `fields` wakes only on those. */
  updated(record_id: string, prev: Record<string, unknown>, changed_fields?: readonly string[], options?: CollectionEmitOptions): void;
  deleted(record_id: string, prev: Record<string, unknown>): void;
  /** Sync-cycle completion. `record_id` defaults to `''` — subscribers
   *  that need a specific scope can key on the empty string as "whole
   *  collection tick" or pass a folder / batch identifier. */
  synced(record_id?: string): void;
  /** Escape hatch for events that don't fit the four common shapes
   *  (custom entity_type overrides, partial payload patches in the
   *  future). Keeps the wrapper's surface complete without forcing
   *  callers back to the raw bus when they need one extra field. */
  raw(event: Omit<WarehouseEvent, 'at'> & { at?: number }): void;
}

export interface CreateCollectionEmitterOptions {
  bus: WarehouseEventBus;
  platform: CollectionPlatform;
  slug: string;
  /** Emitter-authored vocabulary for what changed. Mail uses
   *  `'message'`, file uses `'file'`, webhook uses
   *  `'webhook_delivery'`. Kept free-form so adapters can add
   *  sub-entities later (e.g. `'mail.attachment'`) without a union
   *  widening. */
  entityType: string;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
}

export const createCollectionEmitter = (
  opts: CreateCollectionEmitterOptions,
): CollectionEventEmitter => {
  const { bus, platform, slug, entityType } = opts;
  const now = opts.now ?? Date.now;

  const fire = (
    record_id: string,
    kind: WarehouseEventKind,
    prev?: Record<string, unknown>,
    changed_fields?: readonly string[],
    options?: CollectionEmitOptions,
  ): void => {
    bus.emit({
      platform,
      slug,
      entity_type: entityType,
      event_kind: kind,
      record_id,
      at: now(),
      ...(prev !== undefined ? { prev } : {}),
      ...(changed_fields !== undefined ? { changed_fields: [...changed_fields] } : {}),
      ...(options?.in_drain === true ? { in_drain: true as const } : {}),
      ...(options?.record !== undefined ? { record: { ...options.record } } : {}),
    });
  };

  return {
    created(id, options) { fire(id, 'created', undefined, undefined, options); },
    updated(id, prev, changed_fields, options) { fire(id, 'updated', prev, changed_fields, options); },
    deleted(id, prev) { fire(id, 'deleted', prev); },
    synced(id) { fire(id ?? '', 'synced'); },
    raw(event) {
      bus.emit({
        at: now(),
        ...event,
      });
    },
  };
};
