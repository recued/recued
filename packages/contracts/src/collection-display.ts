/** D-119 Phase 14 — Per-collection display schema for the Warehouse
 *  explorer.
 *
 *  Each `data.<collection>` adapter declares how the explorer should
 *  render its records: a primary "title" field, a small set of summary
 *  fields shown in list / table columns, and an optional structured
 *  detail renderer (`'mail'` / `'calendar'` / `'file'` / `'json'`).
 *
 *  The explorer is generic over this schema — adding a future
 *  `data.<thing>` collection gets explorer UI for free by registering
 *  its display schema in `COLLECTION_DISPLAY_SCHEMAS`. No bespoke UI
 *  per collection.
 *
 *  Field names refer to keys on the displayed record. The renderer
 *  resolves a field by checking the top-level record first and then
 *  falling back to `record.hot_fields` (Phase D `CollectionRecord`
 *  shape) — this keeps the schema authoring simple regardless of
 *  whether the collection stores fields at the top level
 *  (`CanonicalEvent`, `Annotation`, `Link`) or under `hot_fields`
 *  (mail / file / webhook). */

import type { CanonicalCollectionName } from './canonical-record.js';

/** Detail-renderer discriminator. New renderers widen this union as
 *  they ship; unknown values fall back to `'json'` at the renderer. */
export type CollectionDetailRenderer = 'mail' | 'calendar' | 'file' | 'json';

/** Per-collection display schema — drives Warehouse explorer rendering. */
export interface CollectionDisplaySchema {
  /** Field name shown as the row "title" in the list view. */
  primary_field: string;
  /** Tried in order when `primary_field` is absent from the record, BEFORE the
   *  renderer's last-resort `record_id`. Exists because one canonical
   *  collection can hold more than one record SHAPE: `file` covers both a
   *  watched-folder entry (which has `path`) and an inbound upload / tool
   *  output (`DataFileHotFields` — filename/mime_type/size, no `path`). Without
   *  a chain the second shape titles every row with its 32-hex `record_id`,
   *  which reads as an id column rather than a missing field. Ordered
   *  most-specific first; an entry that is absent everywhere is inert, not an
   *  error. */
  primary_field_fallbacks?: readonly string[];
  /** Additional fields shown as small columns / sub-text in the list
   *  view. Order matters — first entry is rendered nearest to the
   *  primary field. Length kept short (≤4) so rows stay readable in
   *  the sidebar's narrow column. */
  summary_fields: readonly string[];
  /** Structured detail renderer for the per-record "open" view.
   *  `'json'` (default) renders the full record as a syntax-highlighted
   *  JSON tree; the named renderers project the canonical shape into
   *  a domain-specific layout (mail header + body, calendar
   *  when/where/attendees, file path + size + content). */
  detail_renderer?: CollectionDetailRenderer;
}

/** The closed registry — one schema per canonical collection. New
 *  collections widen `CanonicalCollectionName` and add a row here.
 *
 *  Field names follow the canonical record shape per collection:
 *    - `mail`        → `CollectionRecord.hot_fields.{from,subject,…}`
 *                      + `received_at` at the top level
 *    - `calendar`    → `CanonicalEvent.{summary,start_at,location,…}`
 *    - `file`        → `CollectionRecord.hot_fields.{path,size,mime_type,mtime}`
 *    - `webhook`     → `CollectionRecord.hot_fields.{method,remote_ip,…}`
 *                      + `received_at`
 *    - `service`     → `ServiceInstanceListRow.{template_slug,status,version,…}`
 *    - `shared`      → `{ key, value, _id, _collection }`
 *    - `annotation`  → `Annotation.{key,target_collection,target_id,…}`
 *    - `link`        → `Link.{role,from_collection,to_collection,…}`
 *    - `contact`     → `ContactRecord.{name,email,last_interaction,…}`
 *    - `form_response` → accepted free-form intake response */
export const COLLECTION_DISPLAY_SCHEMAS: Readonly<
  Record<CanonicalCollectionName, CollectionDisplaySchema>
> = Object.freeze({
  mail: {
    primary_field: 'subject',
    summary_fields: ['from', 'received_at'],
    detail_renderer: 'mail',
  },
  calendar: {
    primary_field: 'summary',
    summary_fields: ['start_at', 'end_at', 'location'],
    detail_renderer: 'calendar',
  },
  file: {
    primary_field: 'path',
    // A watched-folder entry has `path`; an inbound upload / captured tool
    // output does not — it carries `filename`. Both are `data.file`.
    primary_field_fallbacks: ['filename'],
    summary_fields: ['size', 'mime_type', 'mtime'],
    detail_renderer: 'file',
  },
  webhook: {
    primary_field: 'method',
    summary_fields: ['remote_ip', 'received_at'],
    detail_renderer: 'json',
  },
  service: {
    primary_field: 'template_slug',
    summary_fields: ['status', 'version'],
    detail_renderer: 'json',
  },
  shared: {
    // D-198 Phase 3 — the durable KV browse. `SharedListEntry` is `{ key, value }`
    // (no `_id`), so the row is key → a compact value; the detail's raw-JSON
    // shows the full value.
    primary_field: 'key',
    summary_fields: ['value'],
    detail_renderer: 'json',
  },
  annotation: {
    primary_field: 'key',
    summary_fields: ['target_collection', 'target_id'],
    detail_renderer: 'json',
  },
  link: {
    primary_field: 'role',
    summary_fields: ['from_collection', 'to_collection'],
    detail_renderer: 'json',
  },
  contact: {
    primary_field: 'name',
    summary_fields: ['email', 'last_interaction', 'interaction_count'],
    detail_renderer: 'json',
  },
  // D-145 PA3 — work-entity collections. PA6 will refine these as the
  // explorer surface lands; PA3 ships defaults so the registry stays
  // exhaustive over `CanonicalCollectionName` and the explorer doesn't
  // regress when work-entity refs land in `data.timeline()` feeds.
  task: {
    primary_field: 'title',
    summary_fields: ['done', 'due_at', 'priority'],
    detail_renderer: 'json',
  },
  note: {
    primary_field: 'title',
    summary_fields: ['updated_at', 'last_user_action_at'],
    detail_renderer: 'json',
  },
  commitment: {
    primary_field: 'statement',
    summary_fields: ['lifecycle_state', 'due_status', 'promised_for_at'],
    detail_renderer: 'json',
  },
  project: {
    primary_field: 'title',
    summary_fields: ['state', 'last_activity_at', 'target_completion_at'],
    detail_renderer: 'json',
  },
  booking: {
    primary_field: 'title',
    summary_fields: ['lifecycle_state', 'slot_start_at', 'monetary_amount', 'created_at'],
    detail_renderer: 'json',
  },
  form_response: {
    primary_field: 'form_definition_id',
    summary_fields: ['submitted_at', 'accepted_at', 'endpoint_id'],
    detail_renderer: 'json',
  },
});

/** True when `name` is a known canonical collection — narrows from
 *  any string to `CanonicalCollectionName` at the type level. The
 *  warehouse explorer routes through here when the user picks a tab. */
export function isCanonicalCollection(name: string): name is CanonicalCollectionName {
  return Object.prototype.hasOwnProperty.call(COLLECTION_DISPLAY_SCHEMAS, name);
}

/** Lookup helper — returns the schema for `name` or `null` for
 *  unknown collections. Pure / synchronous. The renderer pairs this
 *  with a `'json'` fallback when the lookup fails (defensive — should
 *  only happen if a caller passes a string the type system already
 *  rejects, e.g. user input from a deep link). */
export function getCollectionDisplaySchema(
  name: string,
): CollectionDisplaySchema | null {
  if (!isCanonicalCollection(name)) return null;
  return COLLECTION_DISPLAY_SCHEMAS[name];
}

/** Resolve a single display field on a record. Looks up `field`
 *  on the record's top level first, then falls back to
 *  `record.hot_fields[field]` (Phase D `CollectionRecord` shape).
 *  Returns `undefined` when the field is missing on both sides; the
 *  renderer surfaces the missing value as an empty string so a
 *  missing `subject` line on a mail record degrades gracefully. */
export function readDisplayField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): unknown {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, field)) {
    return record[field];
  }
  const hot = record['hot_fields'];
  if (hot && typeof hot === 'object' && !Array.isArray(hot)) {
    const hotMap = hot as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(hotMap, field)) {
      return hotMap[field];
    }
  }
  return undefined;
}
