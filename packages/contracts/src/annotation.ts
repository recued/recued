/** D-119 Phase 13 — Annotation + Link warehouse collections.
 *
 *  Annotations are recipe-derived facts written back to source records
 *  (e.g. `summary`, `risk_score`, `category`). Links are typed
 *  cross-collection relationships (e.g. `attachment`, `scheduled-from`).
 *  Both ride on the same SQLite/IDB layer as `data.shared` and the L2
 *  cache, are first-class warehouse collections in their own right
 *  (`data.annotation.*`, `data.link.*`), and back the per-record refs
 *  `{{data.<col>.<id>.annotations.<key>}}` /
 *  `{{data.<col>.<id>.links.<role>}}`.
 *
 *  Recipes write through the kernel ingredients `data-annotate` /
 *  `data-link`; the per-record refs are populated by the engine's
 *  prefetch resolver. Staleness is engine-internal: the engine renders
 *  a `⚠ stale` badge when `(source_record_hash, model_used)` no longer
 *  matches, and NEVER auto-deletes.
 *
 *  ⛔ `annotation_policy: "evict_on_stale"` was RETIRED. It was declared on
 *  `RecipeMetadata`, documented in five places as a working opt-in, and read
 *  by NOTHING — `grep annotation_policy packages/engine/src` = 0, the
 *  validator never knew the field, and no corpus recipe ever set it.
 *
 *  It was also the wrong shape, not merely unbuilt. Deleting a parent record
 *  already drops its annotations transactionally
 *  (`AnnotationStore.cascadeDelete`, wired at three call sites), and a manual
 *  `annotation.delete` works regardless. What remained — the parent still
 *  exists but the input it was derived from moved — is IDLE MAINTENANCE, so it
 *  belongs to housekeeping, not to a per-recipe opt-in evaluated on a READ
 *  path. The neighbouring substrate already agrees: enrichments carry a
 *  `staleness_class` flipped by a cascade engine, never a read-time evict. */

import type { CanonicalRecord } from './canonical-record.js';
import type { Actor } from './commits.js';
import type { OriginSurface } from './origin-provenance.js';

/** One annotation row. `_id` is the row's own opaque id (UUID); the
 *  pair `(target_collection, target_id, key)` is the user-facing
 *  identity, but a recipe is allowed to write multiple values under the
 *  same triple over time — older rows just get superseded by newer
 *  reads (last-write-wins on the per-record ref path). The bulk
 *  `annotation-list` ingredient surfaces every row, so admins can
 *  garbage-collect duplicates. */
export interface Annotation extends CanonicalRecord {
  _collection: 'annotation';
  /** Collection name of the record this annotation is attached to.
   *  One of the canonical collection names (`'mail'`, `'calendar'`,
   *  …). New collections widen the union as they ship; the field is
   *  stored as a free string so future collection types don't break
   *  older rows. */
  target_collection: string;
  /** Stable id of the record within `target_collection`. Matches the
   *  `_id` system field on canonical records returned from `data.*`
   *  adapters. */
  target_id: string;
  /** Semantic key — `'summary'`, `'risk_score'`, `'category'`. Free
   *  string by convention; the bulk `annotation-list` ingredient
   *  dedupes on `(target_collection, target_id, key)` for the
   *  per-record ref path. */
  key: string;
  /** Stored value. Scalars + small JSON objects are first-class;
   *  values larger than 64 KB go through the same inline/CAS split
   *  the cache + shared store use. */
  value: unknown;
  /** Recipe id that authored this annotation. Drives the staleness
   *  computation (the recipe's hash is stamped at write) + the
   *  Warehouse explorer's per-recipe filter. */
  authored_by_recipe_id: string;
  /** Hash of the source record at write time. Engine compares this
   *  to the live source record's hash on read; mismatch flips the
   *  rendered `⚠ stale` badge. */
  source_record_hash: string;
  /** Hash of the recipe definition at write time. Edits to the
   *  recipe (prompt, model_hint, transform pipeline) flip this and
   *  invalidate downstream annotations the same way a source-record
  /** Optional — model identifier used for AI-generated values. Only
   *  set when the annotation was produced by an `ai-*` ingredient.
   *  Model rotation flips staleness on its own. */
  model_used?: string;
  /** Unix-ms write time. Authored ordering is the conflict-resolver
   *  for duplicate `(target_collection, target_id, key)` rows. */
  authored_at: number;
  /** D-120 Phase 7.5 — bistemporal stamping. When the annotation
   *  describes a real-world event whose date predates Recued's
   *  recording (a backfill recipe summarising a 3-year-old email),
   *  set this to the event's wall-clock time so `data.timeline()`
   *  surfaces the actual chronology. Null = no underlying event;
   *  consumers fall back to `authored_at`. */
  event_at?: number;
  /** D-161 P2 — origin provenance facet: the write-actor of the
   *  execution that wrote this annotation (`'system'` default for
   *  unstamped / sync writes; the run's actor for recipe writes — an MCP
   *  `contracted_user` annotation surfaces here; `'user_self'` for a
   *  direct paired-client `annotation.write`). Server-derived, never
   *  client-supplied (I-6 / A.5). */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution, present iff
   *  the source carried a `contract_id` (N.4). */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — the write SURFACE (`'client_rpc'` for the
   *  direct paired-client `annotation.write`; `'engine'` for recipe-run
   *  `data-annotate` writes; `'system'` default). Together with
   *  `origin_actor` this decides the stored-cleanliness gate
   *  (`isUserCleanStoredRow` — see `origin-provenance.ts`).
   *  Server-derived, never client-supplied. */
  origin_surface?: OriginSurface;
  /** D-138 § A.8 — absorbed-loser values from contact-merge key
   *  collisions. When a merge migrates the loser's annotations onto the
   *  survivor and a `(target_collection, target_id, key)` collision
   *  occurs, the survivor's canonical `value` wins and the loser's value
   *  is preserved here, keyed by the loser's canonical id (the merged-away
   *  `target_id` — the loser email for `data.contact`). Multi-way merges
   *  accumulate one entry per absorbed loser. Audit-readable; never
   *  surfaced as the primary `value` — available for direct inspection of
   *  what a merge absorbed. Absent when no merge has absorbed anything into
   *  this row. */
  extras?: Record<string, unknown>;
}

/** Filter shape for `annotation-list` / `annotation-delete`. All
 *  filters AND together; absent fields don't restrict. The
 *  `(target_collection, target_id)` index covers the common per-
 *  record case; `(key)` covers the bulk admin case ("rename
 *  `summary` → `tldr`"). */
export interface AnnotationFilter {
  target_collection?: string;
  target_id?: string;
  key?: string;
  authored_by_recipe_id?: string;
  /** Lower bound on `authored_at` (inclusive). */
  since?: number;
  /** Upper bound on `authored_at` (exclusive). */
  until?: number;
  /** Hard cap on returned rows — the server clamps to an internal
   *  ceiling (1000) when omitted or above the ceiling. */
  limit?: number;
}

/** Search query for `annotation-search`. Freeform text matched
 *  against the JSON-serialized value via SQLite FTS5. CAS-stored
 *  rows (>64 KB) are not indexed — same documented limit as the
 *  shared store. */
export interface AnnotationSearchQuery {
  /** Freeform FTS5 expression. Caller responsible for sanitizing
   *  user input. */
  query: string;
  /** Optional — narrow to a single key across the warehouse. */
  key?: string;
  /** Optional — narrow to a single source collection. */
  target_collection?: string;
  limit?: number;
}

/** One match row from `annotation-search`. `rank` is FTS5 BM25 —
 *  smaller is better. */
export interface AnnotationSearchMatch {
  annotation_id: string;
  target_collection: string;
  target_id: string;
  key: string;
  value: unknown;
  rank: number;
}

/** One link row. Links are directional — `from` describes the source
 *  side, `to` the destination side. The `role` field gives the link
 *  semantic meaning (`'attachment'`, `'scheduled-from'`, …). Both
 *  endpoints are indexed so inbound + outbound queries are O(1). */
export interface Link extends CanonicalRecord {
  _collection: 'link';
  from_collection: string;
  from_id: string;
  to_collection: string;
  to_id: string;
  /** Semantic role — `'attachment'`, `'scheduled-from'`, `'reply-to'`,
   *  `'derived-from'`. Free string by convention; per-record refs
   *  group by role (`{{data.mail.<id>.links.attachment}}` returns the
   *  array of linked records under that role). */
  role: string;
  created_at: number;
  authored_by_recipe_id: string;
  /** D-120 Phase 7.5 — bistemporal stamping (same semantics as
   *  `Annotation.event_at`). When the link captures a real-world
   *  relationship dated earlier than Recued's discovery (a backfill
   *  recipe linking an old calendar event to its source mail), set
   *  this to the event's wall-clock time. Null = inherit `created_at`
   *  via `COALESCE(event_at, created_at)`. */
  event_at?: number;
  /** D-122 Phase 2 — recipe-emitted probabilistic confidence in the
   *  link's truthfulness, [0, 1]. Engine-emitted links (kind prefix
   *  `execution.*`) leave this null because the engine reasons by
   *  derivation, not inference. Recipe-emitted links (`extraction.*`,
   *  `link-create` ingredient) populate it when an AI extractor or
   *  heuristic returned a graded score. */
  confidence?: number;
  /** D-122 Phase 2 — short human-readable rationale shown alongside the
   *  link in the Memory tab provenance block (`"matched on subject
   *  date + attendee overlap"`). Free-form, capped at 1 KB by the
   *  store. Recipes typically pass back the reasoning blurb the AI
   *  extractor returned — useful for debugging false positives. */
  evidence?: string;
  /** D-161 P2 — origin provenance facet (same semantics as
   *  `Annotation.origin_actor`): the write-actor of the execution that
   *  wrote this link. Server-derived, never client-supplied (I-6 / A.5). */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution, present iff
   *  the source carried a `contract_id` (N.4). */
  origin_contract_id?: string;
}

/** Filter shape for `link-list` / `link-delete`. All filters AND
 *  together. Either of the two index sides (`from_*`, `to_*`) is
 *  enough to serve a list call — supplying both narrows further. */
export interface LinkFilter {
  from_collection?: string;
  from_id?: string;
  to_collection?: string;
  to_id?: string;
  role?: string;
  authored_by_recipe_id?: string;
  /** Lower bound on `created_at` (inclusive). */
  since?: number;
  /** Upper bound on `created_at` (exclusive). */
  until?: number;
  limit?: number;
}

/** Hard ceiling on a single annotation `value`'s serialized size, in
 *  bytes. Larger values are rejected with `value_too_large` — same as
 *  the shared store's MAX_VALUE_BYTES. */
export const MAX_ANNOTATION_VALUE_BYTES = 10 * 1024 * 1024;

/** Inline/CAS split for annotation values. Values ≤ this byte count
 *  go inline in the `value_inline` column; larger values spill into
 *  the CAS blob store. Matches the shared store's INLINE_CUTOFF_BYTES. */
export const ANNOTATION_INLINE_CUTOFF_BYTES = 64 * 1024;

/** Internal helper — true when a record carries the staleness stamp
 *  fields populated. A row missing any of the three indicates a
 *  legacy write (none currently exist; helper kept for callers that
 *  want to distinguish stamped vs unstamped). */
export const isStalenessStamped = (
  ann: Pick<Annotation, 'source_record_hash'>,
): boolean =>
  typeof ann.source_record_hash === 'string' &&
  ann.source_record_hash.length > 0 &&
  ann.source_record_hash.length > 0;

/** Compute whether a stamped annotation is stale against the current
 *  source record + recipe. Returns `true` iff any of the three stamp
 *  fields no longer matches. `currentModel` is optional — when the
 *  annotation has no `model_used` stamp (transform-only path), the
 *  caller's `currentModel` is ignored. */
export const isAnnotationStale = (
  ann: Pick<Annotation, 'source_record_hash' | 'model_used'>,
  current: { source_record_hash: string; model_used?: string },
): boolean => {
  if (ann.source_record_hash !== current.source_record_hash) return true;
  if (ann.model_used !== undefined && ann.model_used !== current.model_used) return true;
  return false;
};

/** Stable key used for per-record annotation deduplication. The bulk
 *  `annotation-list` ingredient may surface multiple rows with the
 *  same triple (recipes that re-write under the same key over time);
 *  the engine's prefetch resolver picks the latest by `authored_at`
 *  for the per-record ref path. */
export const annotationDedupeKey = (
  ann: Pick<Annotation, 'target_collection' | 'target_id' | 'key'>,
): string => [ann.target_collection, ann.target_id, ann.key].join(' ');

/** Stable key for per-record link grouping by role. Inbound queries
 *  use `(to_collection, to_id, role)`; outbound use `(from_collection,
 *  from_id, role)`. Helper kept for the engine's prefetch resolver. */
export const linkRoleKey = (
  side: 'from' | 'to',
  collection: string,
  id: string,
  role: string,
): string => [side, collection, id, role].join(' ');
