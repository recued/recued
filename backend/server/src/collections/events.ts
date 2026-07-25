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

import type {
  WarehouseEvent,
  WarehouseEventBus,
  WarehouseEventKind,
} from '@recued/warehouse-events';
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
export interface CollectionEventEmitter {
  created(record_id: string): void;
  updated(record_id: string, prev: Record<string, unknown>): void;
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
  ): void => {
    bus.emit({
      platform,
      slug,
      entity_type: entityType,
      event_kind: kind,
      record_id,
      at: now(),
      ...(prev !== undefined ? { prev } : {}),
    });
  };

  return {
    created(id) { fire(id, 'created'); },
    updated(id, prev) { fire(id, 'updated', prev); },
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
