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
import { KERNEL_OP_PREFIX } from './op-model.js';

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

/** D-228 slice 5 — the namespace for a Tier-1 chat PRIMITIVE's op id:
 *  `primitive.<tool>`, e.g. `primitive.enrichment.search`.
 *
 *  ⛔⛔ WHY NOT THE BARE TOOL NAME. Ten of the eleven Tier-1 names classify as
 *  `op` unchanged, but `enrichment.search` — a live chat primitive — collides
 *  head-on with {@link TOPIC_GRANT_PREFIX}, so `opGrantEntry` THROWS
 *  `grant_entry_op_id_reserved_prefix` on it. Any scheme using bare tool names
 *  is dead on that one, and special-casing a single primitive is how a
 *  vocabulary starts growing exceptions.
 *
 *  ⛔⛔ AND WHY NOT `core.` — the obvious choice, which is the dangerous one.
 *  `core.*` is the kernel op namespace (`core.mail.send`, `core.ai.*`,
 *  `core.acct.*`), and this codebase already documents the confusion twice:
 *  *"`mail.search` is a fenced fan-out over every mailbox and
 *  `core.mail.email.search` is one mailbox by slug, so the 'obvious' mapping
 *  silently narrows the work and drops a read fence"*
 *  (`execution-case-recipe-draft.ts`). Minting the primitive as
 *  `core.mail.search` would put a FENCED FAN-OUT one segment from a
 *  single-mailbox read, in the one namespace where readers already mix them up
 *  — and a grant reviewer would have no way to tell which they were approving.
 *
 *  ⚠ `primitive.` rather than `tier1.`: a tier number reads as a PRIORITY to
 *  anyone who has not memorised the catalog's three tiers.
 *
 *  ⚠ NO DESCRIPTOR HASH, unlike `ingredient.<slug>_<hash8>`. That hash exists
 *  because an installed manifest can be MUTATED IN PLACE under a live grant. A
 *  Tier-1 primitive is a hard-coded engine handler shipped in the binary — it
 *  cannot change without a release, and a release is not a silent mutation. If
 *  primitives ever gain authored schemas, revisit this before granting them. */
export const PRIMITIVE_GRANT_PREFIX = 'primitive.';

/** Compose the `op`-kind entry-key for a Tier-1 chat primitive. Typed at
 *  `string` rather than a union because the primitive table lives server-side;
 *  the caller derives the names from the handler table so they cannot drift. */
export const primitiveGrantEntry = (toolName: string): string =>
  `${PRIMITIVE_GRANT_PREFIX}${toolName}`;

/** D-228 — the namespace for a manifest-backed ingredient tool's synthetic op
 *  id. The identity is minted by `@recued/ingredient-authoring`; the prefix
 *  lives here because declared catalog ids must not be allowed to impersonate
 *  it once that grant path is wired. Like `primitive.`, it is a valid OP grant
 *  prefix and therefore must NOT join {@link RESERVED_GRANT_ENTRY_PREFIXES}. */
export const INGREDIENT_GRANT_PREFIX = 'ingredient.';

/** The leading form of the Tier-K namespace. `KERNEL_OP_PREFIX` deliberately
 *  omits the separator because `parseOpId` reasons in segments; grant ids are
 *  strings, so declaration collision checks need the exact `core.` form. */
export const KERNEL_GRANT_PREFIX = `${KERNEL_OP_PREFIX}.`;

/** The reserved prefixes an `op`-kind entry-key (an `operation_id`) must NOT
 *  start with — the invariant that lets `classifyGrantEntry` treat "neither
 *  reserved prefix" as `op`. Kernel ops start `core.`; pack ops carry a `/`
 *  before any `.`; neither leads with `data.` / `enrichment.`. */
export const RESERVED_GRANT_ENTRY_PREFIXES: readonly string[] = Object.freeze([
  COLLECTION_GRANT_PREFIX,
  TOPIC_GRANT_PREFIX,
]);

/** Prefixes a catalog/manifest-declared operation id may not claim.
 *
 *  This is deliberately broader than {@link RESERVED_GRANT_ENTRY_PREFIXES}:
 *  `core.*`, `primitive.*`, and `ingredient.*` are all legitimate OP grant
 *  keys, but their implementations are server-owned. Letting a downloaded
 *  catalog declare one would make an existing grant for the server operation
 *  authorize the catalog operation too. `data.*` / `enrichment.*` are included
 *  because they are not op keys at all and would be misclassified by the grant
 *  store.
 *
 *  Do not feed this list to `opGrantEntry`: doing so would disable the genuine
 *  kernel/primitive/synthetic operations it protects. It is for authoring and
 *  manifest validation only. */
export const DECLARED_OPERATION_ID_RESERVED_PREFIXES: readonly string[] = Object.freeze([
  ...RESERVED_GRANT_ENTRY_PREFIXES,
  KERNEL_GRANT_PREFIX,
  PRIMITIVE_GRANT_PREFIX,
  INGREDIENT_GRANT_PREFIX,
]);

/** Return the reserved namespace a declared operation id attempts to claim. */
export const declaredOperationIdReservedPrefix = (operationId: string): string | undefined =>
  DECLARED_OPERATION_ID_RESERVED_PREFIXES.find((prefix) => operationId.startsWith(prefix));

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
 *  `operation_id` verbatim.
 *
 *  ⚠ **There is no single pack form, and this comment used to claim there
 *  was.** Three shapes reach here today and all are legitimate:
 *    - kernel — `core.mail.send`
 *    - decomposed pack — `recued-core/hubspot.deal.read`, the SLASH form
 *      `decomposeComposition` emits with its unconditional `DEFAULT_AUTHOR`
 *      (so the publisher segment reads `recued-core` whoever shipped the pack)
 *    - STAMPED pack — `<publisher>.<pack>.<key>`, the DOTTED form
 *      `stampRecordsCatalog` (D-221) and `stampGeneratedMcpCatalog` (D-225)
 *      emit, which is also the Tier-P shape `parseOpId` reads
 *
 *  ⛔ Do NOT "canonicalize" these to one form to tidy it up. This value is a
 *  STORED GRANT KEY: rewriting it changes which entry an existing grant row
 *  matches, so a normalization pass would silently re-point or orphan live
 *  authorizations. The mixture is a wart, not a bug — see D-225
 *  § 9.9, which walks the paths that consume it and finds none that parse it.
 *
 *  Fail-LOUD if `operationId` starts with a reserved prefix: such an id would
 *  be mis-classified as a collection/topic at the gate (silently un-matching
 *  its op grant — a fail-closed admission bug). No real `operation_id` leads
 *  with `data.` / `enrichment.`, so this only fires on a malformed/hostile id,
 *  where throwing is correct. */
export const opGrantEntry = (operationId: string): string => {
  for (const prefix of RESERVED_GRANT_ENTRY_PREFIXES) {
    if (operationId.startsWith(prefix)) {
      throw new Error(
        `grant_entry_op_id_reserved_prefix: operation_id '${operationId}' starts with the reserved grant-entry prefix '${prefix}' — an op grant entry-key must be a plain operation_id (kernel 'core.*', decomposed pack '<author>/<entity>.<verb>', or stamped pack '<publisher>.<pack>.<key>').`,
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
