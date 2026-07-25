/** Grant-foundation slice 3a (D-187 AMENDMENT `693b7d03`) — the unified
 *  grant-entry id taxonomy.
 *
 *  The amendment collapses the read-scope sprawl into the op-admission grant
 *  matrix: a contract's permissions are ONE consolidated set of grant entries,
 *  each keyed by a typed entry id. There are exactly three entry kinds, and a
 *  well-formed entry key is classifiable by prefix alone — no per-kind tag is
 *  stored:
 *
 *    - **op**         — `<operation_id>` (the verb a contract may invoke). The
 *                       canonical declared `operation_id` the grant substrate
 *                       already binds (slices 1/2a/2b — `resolution.operation_id`):
 *                       `core.mail.send` (kernel) or `recued-core/hubspot.deal.read`
 *                       (pack `<publisher>/<entity>.<verb>`). NEVER starts with a
 *                       reserved prefix below (kernel ops start `core.`, pack ops
 *                       carry a `/` before any dot), so it is the syntactic
 *                       fall-through.
 *    - **collection** — `data.<collection>` (a raw warehouse-collection read).
 *    - **topic**      — `enrichment.<topic>` (an enrichment-topic read).
 *
 *  Read gate (amendment §3) = **verb-op grant ∧ topic grant** (∧ collection grant
 *  where the read touches a raw collection): the cross-topic verbs (`timeline`,
 *  `vector_search`, `enrichment.read`, `registry.describe`) are gated by their
 *  verb-op entry; the per-topic / per-collection entries filter what those verbs
 *  return. A topic/collection grant does NOT imply the verb — they are separate
 *  entries in the one set (see {@link ../read-collection-grant.ts} for the gate).
 *
 *  This module is the SHARED id vocabulary the physical grant store keys on
 *  (`contract.grant.<contract_id>.<entryKey>`) and both D-174 R22 transpose UIs
 *  read (contract-detail = a contract's row of entries; topic-detail = a topic
 *  entry's column across contracts). Pure: format helpers are typed at the
 *  source id space, `classifyGrantEntry` is syntactic (prefix), and validation
 *  against the live registry (is this a REAL op/collection/topic) stays with the
 *  caller that has the registry in hand — this module never throws on a read.
 *
 *  Spec: D-187 AMENDMENT block; handover
 *  `handover_grant_foundation_slice3_amended.md`. */

import type { CanonicalCollectionName } from './canonical-record.js';
import type { EnrichmentTopic } from './enrichment-registry.js';

// ────────────────────────────────────────────────────────────────
// GrantEntryKind — the three entry kinds in the one grant namespace
// ────────────────────────────────────────────────────────────────

/** The closed set of grant-entry kinds. `op` = the verb a contract may invoke;
 *  `collection` = a raw warehouse-collection read; `topic` = an enrichment-topic
 *  read. All three live in ONE per-contract grant set (amendment §2). */
export const GRANT_ENTRY_KINDS = ['op', 'collection', 'topic'] as const;

/** String-literal union derived from {@link GRANT_ENTRY_KINDS}. */
export type GrantEntryKind = (typeof GRANT_ENTRY_KINDS)[number];

// ────────────────────────────────────────────────────────────────
// Reserved entry-key prefixes — the syntactic discriminants
// ────────────────────────────────────────────────────────────────

/** The `collection`-kind entry-key prefix. A key `data.<collection>` is a
 *  raw-collection read grant. */
export const COLLECTION_GRANT_PREFIX = 'data.';

/** The `topic`-kind entry-key prefix. A key `enrichment.<topic>` is an
 *  enrichment-topic read grant. (Distinct from the dispatch SCOPE path
 *  `data.enrichment.<topic>` used by the retiring `scope_restrictions` fence —
 *  the grant entry-key is the bare `enrichment.<topic>` form, so it can never
 *  collide with a `data.<collection>` collection key.) */
export const TOPIC_GRANT_PREFIX = 'enrichment.';

/** The reserved prefixes an `op`-kind entry-key (an `operation_id`) must NOT
 *  start with — the invariant that lets `classifyGrantEntry` treat "neither
 *  reserved prefix" as `op`. Kernel ops start `core.`; pack ops carry a `/`
 *  before any `.`; neither leads with `data.` / `enrichment.`. */
export const RESERVED_GRANT_ENTRY_PREFIXES: readonly string[] = Object.freeze([
  COLLECTION_GRANT_PREFIX,
  TOPIC_GRANT_PREFIX,
]);

// ────────────────────────────────────────────────────────────────
// Format helpers — typed at the source id space (the authoring path)
// ────────────────────────────────────────────────────────────────

/** Compose the `collection`-kind entry-key for a canonical warehouse
 *  collection: `data.<collection>`. Typed at {@link CanonicalCollectionName}
 *  so an authoring caller can't fat-finger a non-collection. */
export const collectionGrantEntry = (collection: CanonicalCollectionName): string =>
  `${COLLECTION_GRANT_PREFIX}${collection}`;

/** Compose the `topic`-kind entry-key for an enrichment topic:
 *  `enrichment.<topic>`. Typed at {@link EnrichmentTopic}. */
export const topicGrantEntry = (topic: EnrichmentTopic): string =>
  `${TOPIC_GRANT_PREFIX}${topic}`;

/** Compose the `op`-kind entry-key for an operation: the declared
 *  `operation_id` verbatim (the form the grant substrate binds —
 *  `core.mail.send` / `recued-core/hubspot.deal.read`).
 *
 *  Fail-LOUD if `operationId` starts with a reserved prefix: such an id would
 *  be mis-classified as a collection/topic at the gate (silently un-matching
 *  its op grant — a fail-closed admission bug). No real `operation_id` leads
 *  with `data.` / `enrichment.` (kernel `core.*`, pack `<publisher>/…`), so
 *  this only fires on a malformed/hostile id, where throwing is correct. */
export const opGrantEntry = (operationId: string): string => {
  for (const prefix of RESERVED_GRANT_ENTRY_PREFIXES) {
    if (operationId.startsWith(prefix)) {
      throw new Error(
        `grant_entry_op_id_reserved_prefix: operation_id '${operationId}' starts with the reserved grant-entry prefix '${prefix}' — an op grant entry-key must be a plain operation_id (kernel 'core.*' or pack '<publisher>/<entity>.<verb>').`,
      );
    }
  }
  return operationId;
};

// ────────────────────────────────────────────────────────────────
// classifyGrantEntry / parseGrantEntry — the read path (syntactic)
// ────────────────────────────────────────────────────────────────

/** Classify a stored entry-key by prefix — the gate/UI read path. Total over
 *  every string: `data.` ⇒ `collection`, `enrichment.` ⇒ `topic`, anything
 *  else ⇒ `op` (an `operation_id`). Syntactic only — it does NOT verify the
 *  value names a live collection/topic/op (the caller validates against the
 *  registry if it cares). Never throws. */
export const classifyGrantEntry = (entryKey: string): GrantEntryKind => {
  if (entryKey.startsWith(COLLECTION_GRANT_PREFIX)) return 'collection';
  if (entryKey.startsWith(TOPIC_GRANT_PREFIX)) return 'topic';
  return 'op';
};

/** A parsed grant entry — the discriminated shape `classifyGrantEntry` implies.
 *  `value` is the kind-specific payload: the bare collection name / topic id
 *  (prefix stripped) for `collection` / `topic`, or the whole `operation_id`
 *  for `op`. Strings (not the branded `CanonicalCollectionName` /
 *  `EnrichmentTopic`) — the read path is registry-decoupled; a caller narrows
 *  via `isReadableCollection` / `isEnrichmentTopic` when it needs the type. */
export type ParsedGrantEntry =
  | { readonly kind: 'op'; readonly value: string }
  | { readonly kind: 'collection'; readonly value: string }
  | { readonly kind: 'topic'; readonly value: string };

/** Parse a stored entry-key into its kind + kind-specific value. Total +
 *  never-throws (the inverse of the `*GrantEntry` formatters). Use when a
 *  consumer needs the payload (e.g. the topic id to filter a verb's results,
 *  or the collection name for the read fence). */
export const parseGrantEntry = (entryKey: string): ParsedGrantEntry => {
  if (entryKey.startsWith(COLLECTION_GRANT_PREFIX)) {
    return { kind: 'collection', value: entryKey.slice(COLLECTION_GRANT_PREFIX.length) };
  }
  if (entryKey.startsWith(TOPIC_GRANT_PREFIX)) {
    return { kind: 'topic', value: entryKey.slice(TOPIC_GRANT_PREFIX.length) };
  }
  return { kind: 'op', value: entryKey };
};

/** Predicate — true iff `entryKey` classifies as `op`. */
export const isOpGrantEntry = (entryKey: string): boolean =>
  classifyGrantEntry(entryKey) === 'op';

/** Predicate — true iff `entryKey` classifies as `collection`. */
export const isCollectionGrantEntry = (entryKey: string): boolean =>
  classifyGrantEntry(entryKey) === 'collection';

/** Predicate — true iff `entryKey` classifies as `topic`. */
export const isTopicGrantEntry = (entryKey: string): boolean =>
  classifyGrantEntry(entryKey) === 'topic';
