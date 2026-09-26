/** D-119 Phase 12 — Canonical record system fields.
 *
 *  Every record returned from a `data.*` adapter (mail / calendar /
 *  file / service / shared) carries two underscore-prefixed system
 *  fields that identify the record across collection boundaries:
 *
 *    - `_id`         — collection-specific stable identifier (msg-id,
 *                      event-uid, file-hash, key, slug, …). Stable
 *                      across re-syncs so dedupe + annotation refs
 *                      work without per-collection routing.
 *    - `_collection` — the collection name (`'mail'`, `'calendar'`,
 *                      `'file'`, `'webhook'`, `'service'`, `'shared'`).
 *
 *  Mongo / CouchDB convention: underscore-prefixed names mark system
 *  fields that transforms preserve by default. Authors who want to
 *  strip them list them explicitly in `omit`.
 *
 *  The pair names any record uniformly, so a recipe can address one
 *  without per-collection knowledge: `annotation-create` / `link-create`
 *  take it as `"{{item._collection}}:{{item._id}}"`. (Phase 13's
 *  `data-annotate` / `data-link`, which took `{{item}}` itself, were
 *  retired 2026-09-23 — never wired on the server.) */

import type { WorkEntityKind } from './work-entities.js';

/** Base shape every canonical record extends. Adapters add their own
 *  fields below the system pair; transforms preserve `_*` by default. */
export interface CanonicalRecord {
  /** Collection-specific stable identifier (mail message-id, calendar
   *  ical_uid, file path-hash, shared key, service slug, …). */
  _id: string;
  /** Collection name — one of the closed set the runtime knows. New
   *  collections widen this string union as they ship. */
  _collection: CanonicalCollectionName;
}

/** Closed enumeration of collection names. New collections widen the
 *  union; recipes / kernel ingredients narrow with `===` comparisons.
 *  D-119 Phase 13 added `'annotation'` and `'link'` — first-class
 *  warehouse collections recipes write back to source records via the
 *  `annotation-create` / `link-create` kernel ops. D-145 PA3 added
 *  `'task'` / `'note'` / `'commitment'` / `'project'` — the canonical
 *  work-entity collections written by the PA3 kernel CRUD ingredients
 *  (recipes consume the stamped `_collection` to dispatch on kind). */
export type CanonicalCollectionName =
  | 'mail'
  | 'calendar'
  | 'file'
  | 'webhook'
  | 'service'
  | 'shared'
  | 'annotation'
  | 'link'
  | 'contact'
  // ⚠ DERIVED, never re-spelled — every work entity is a canonical
  // collection by construction. This was a hand-copy of the four kinds,
  // and because a SUBSET typechecks, a fifth kind stayed silently
  // absent: no `READABLE_COLLECTIONS` entry (so outside the door read
  // fence entirely) and no `COLLECTION_DISPLAY_SCHEMAS` row, while that
  // registry's own comment still claimed to be "exhaustive over
  // `CanonicalCollectionName`" — true, but only against the stale copy.
  | WorkEntityKind
  | 'form_response';

/** Tuple of system field names. Transforms (`pick`, `map.expression`)
 *  iterate this list to preserve underscore fields by default. Single
 *  source of truth so adding a new system field (`_version`, etc.) is
 *  one edit. */
export const CANONICAL_SYSTEM_FIELDS = ['_id', '_collection'] as const;

/** Type-guard string-literal union derived from `CANONICAL_SYSTEM_FIELDS`. */
export type CanonicalSystemField = (typeof CANONICAL_SYSTEM_FIELDS)[number];

/** Predicate — true when `key` is a known canonical system field.
 *  Used by transform logic that decides which fields to auto-preserve
 *  even when the caller's projection list omits them. */
export const isCanonicalSystemField = (key: string): key is CanonicalSystemField =>
  (CANONICAL_SYSTEM_FIELDS as readonly string[]).includes(key);

/** Extract `_id` + `_collection` from a value when present. Used by
 *  Phase 13 kernel ingredients `data-annotate` / `data-link` (retired
 *  2026-09-23), which accepted a canonical record reference (`{{item}}`);
 *  kept as the contract's own reader of the pair. Returns null when the
 *  value isn't a canonical record. */
export const extractCanonicalRef = (
  value: unknown,
): { collection: string; id: string } | null => {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const id = obj._id;
  const collection = obj._collection;
  if (typeof id !== 'string' || typeof collection !== 'string') return null;
  return { collection, id };
};

/** Stamp `_id` + `_collection` onto a record without overriding
 *  existing values. Adapters call this on every returned record so
 *  recipes see canonical refs uniformly. Idempotent — re-stamping a
 *  record that already carries the system fields is a no-op (the
 *  existing values win, since adapter-side ids are authoritative).
 *
 *  Generic over the input shape so the return type carries both the
 *  record's collection-specific fields AND the canonical pair —
 *  callers don't lose precision when stamping. */
export const stampCanonicalFields = <T extends Record<string, unknown>>(
  record: T,
  collection: CanonicalCollectionName,
  id: string,
): T & CanonicalRecord => {
  // Existing `_id` / `_collection` win — adapters that already stamp
  // (e.g. an upstream test fixture) shouldn't be overwritten by a
  // downstream wrapper. Mongo/CouchDB convention.
  return {
    _id: record._id ?? id,
    _collection: record._collection ?? collection,
    ...record,
  } as T & CanonicalRecord;
};
