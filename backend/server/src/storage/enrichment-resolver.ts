/** D-122 Phase 4.5 — `data.enrichment.*` ref resolver.
 *  D-125 Phase 6.1 — widened to resolve compound `connection.<kind>`
 *  scopes alongside the four `data.*` collection scopes.
 *
 *  The recipe ref-resolution path looks up `{{data.enrichment.<…>}}`
 *  templates by walking the path against this resolver. Two shapes
 *  share one path namespace, so we demux per registry lookup:
 *
 *  Shape A — per-record fact:
 *    `data.enrichment.<scope>.<target_id>.<topic_or_*>`
 *      <scope> is one of:
 *        `mail | contact | calendar | file`
 *          (data.* collections; one path segment)
 *        `connection.api | connection.mcp | connection.notification`
 *          (D-125 connection.* records; two path segments — `connection`
 *           then the kind, consumed pairwise to compose the scope)
 *      <target_id> is the record id (mail message-id, contact email,
 *                    connection name, …)
 *      <topic_or_*> is a registered topic name OR the literal `*` for
 *                    "every shape-A topic on this record"
 *
 *  Shape B — derived entity:
 *    `data.enrichment.<topic>.<id>`
 *    `data.enrichment.<topic>.*` (listing)
 *
 *  Resolver returns:
 *    - the row's `value` field for a fully-qualified ref
 *    - the row record (incl. `_id`, `event_at`, etc.) for `data.enrichment.<scope>.<id>` (shape A bag)
 *    - an array of records for `*` listings
 *    - `null` when the topic / scope / id doesn't match
 *
 *  Spec: `docs/d-122-spec.md` §"Enrichment substrate" — Unified namespace.
 *  Spec: `docs/d-125-spec.md` §"Phase 6: Enrichment substrate convention". */

import {
  CONNECTION_ENRICHMENT_SCOPES,
  ENRICHMENT_REGISTRY,
  isEnrichmentTopic,
  type EnrichmentDefinition,
  type EnrichmentScope,
  type EnrichmentTopic,
} from '@recued/contracts';
import type { EnrichmentRowSnapshot } from '@recued/transforms';
import type { EnrichmentStore, EnrichmentRecord } from './enrichment-store.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

const DATA_SCOPES: ReadonlySet<EnrichmentScope> = new Set([
  'mail',
  'contact',
  'calendar',
  'file',
]);

/** Map from `connection.<kind>`-encoded scope to the kind segment that
 *  follows the `connection` literal in a recipe ref. Used to compose
 *  the dotted scope when walking a connection.* path. */
const CONNECTION_KIND_BY_SUFFIX: ReadonlyMap<string, EnrichmentScope> = new Map(
  CONNECTION_ENRICHMENT_SCOPES.map((s) => [s.substring('connection.'.length), s]),
);

/** Result of a path resolution. `kind` discriminates the shape so the
 *  ref-walker (which calls `walkPath`) can plug into the right branch. */
export type EnrichmentResolveResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'record'; record: EnrichmentRecord }
  | { kind: 'list'; records: EnrichmentRecord[] }
  | { kind: 'null' };

export interface EnrichmentResolver {
  /** Resolve `data.enrichment.<segments…>` against the store. The
   *  caller supplies `segments` (already split on `.`); resolver
   *  inspects shape per topic. */
  resolve(segments: ReadonlyArray<string>): EnrichmentResolveResult;
  /** Quick registry lookup — surface the topic definition for callers
   *  that want to know the policy / shape without committing to a
   *  full path resolution. Returns null for unknown topics. */
  lookup(topic: string): EnrichmentDefinition | null;
}

export const createEnrichmentResolver = (store: EnrichmentStore): EnrichmentResolver => {
  const resolveDerivedEntity = (
    topic: EnrichmentTopic,
    rest: ReadonlyArray<string>,
  ): EnrichmentResolveResult => {
    if (rest.length === 0) {
      // `data.enrichment.<topic>` — convenience listing.
      // D-136 §A.13 P7.C — surface stale + expired rows alongside fresh
      // so recipes can read `staleness_class` off the envelope and
      // decide. Recipes that want fresh-only narrow with the bag form +
      // filter, or pass `fresh_only: true` via `enrichment-list`.
      return { kind: 'list', records: store.list({ topic, limit: 50, fresh_only: false }) };
    }
    const [head, ...tail] = rest;
    if (head === '*') {
      return { kind: 'list', records: store.list({ topic, limit: 50, fresh_only: false }) };
    }
    if (typeof head !== 'string' || head.length === 0) return { kind: 'null' };
    const record = store.getDerived(topic, head);
    if (!record) return { kind: 'null' };
    if (tail.length === 0) {
      return { kind: 'record', record };
    }
    // Drill into the value JSON — `data.enrichment.topic_cluster.foo.members`
    return { kind: 'value', value: drill(record.value, tail) };
  };

  const resolvePerRecord = (
    scope: EnrichmentScope,
    rest: ReadonlyArray<string>,
  ): EnrichmentResolveResult => {
    if (rest.length === 0) return { kind: 'null' };
    const [target_id, ...tail] = rest;
    if (typeof target_id !== 'string' || target_id.length === 0) return { kind: 'null' };
    if (tail.length === 0) {
      // Bag of every shape-A row on this record across all topics.
      // Useful for AI-side "give me everything Recued knows about this
      // mail row". D-136 §A.13 P7.C — `fresh_only: false` so the bag
      // surfaces stale + expired rows with their `staleness_class`
      // intact for the consumer to interpret.
      const out: EnrichmentRecord[] = [];
      for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
        const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
        if (def.shape !== 'per_record') continue;
        if (!def.valid_scopes!.includes(scope)) continue;
        const rows = store.list({ topic, scope, target_id, limit: 16, fresh_only: false });
        out.push(...rows);
      }
      return { kind: 'list', records: out };
    }
    const [topicOrStar, ...drillPath] = tail;
    if (topicOrStar === '*') {
      // Same as no-topic — every shape-A row on the record.
      const out: EnrichmentRecord[] = [];
      for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
        const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
        if (def.shape !== 'per_record') continue;
        if (!def.valid_scopes!.includes(scope)) continue;
        const rows = store.list({ topic, scope, target_id, limit: 16, fresh_only: false });
        out.push(...rows);
      }
      return { kind: 'list', records: out };
    }
    if (typeof topicOrStar !== 'string' || !isEnrichmentTopic(topicOrStar)) {
      return { kind: 'null' };
    }
    const def = ENRICHMENT_REGISTRY[topicOrStar] as EnrichmentDefinition;
    if (def.shape !== 'per_record') return { kind: 'null' };
    if (!def.valid_scopes!.includes(scope)) return { kind: 'null' };
    // Shape A is keyed on (topic, scope, target_id, authored_by). Recipe
    // refs don't carry authored_by — the resolver returns the latest
    // ingested row when multiple authors exist. Most topics have a
    // single canonical producer; multi-producer topics resolve to the
    // freshest snapshot.
    //
    // D-136 §A.13 P7.C — `fresh_only: false` widens the read surface so
    // recipes see the row even after the cascade engine has marked it
    // `'stale'` (queued for recompute) or `'expired'` (TTL / tombstone).
    // The bag form (`data.enrichment.<scope>.<id>`) carries
    // `staleness_class` per record envelope; the convenience form here
    // returns the value as-is — a tombstoned row's value is NULL, which
    // the recipe surfaces as a missing ref via downstream null-safety.
    const rows = store.list({
      topic: topicOrStar,
      scope,
      target_id,
      limit: 1,
      fresh_only: false,
    });
    if (rows.length === 0) return { kind: 'null' };
    const row = rows[0]!;
    if (drillPath.length === 0) {
      // Convenience — return the value directly so refs read cleanly:
      //   {{data.enrichment.contact.bob@x.com.timeline_rollup}}
      // resolves to the rollup value (not the row envelope).
      return { kind: 'value', value: row.value };
    }
    // D-128 — `meta` is a reserved sibling of `value`. Refs to
    // `<topic>.meta.<field.path>` drill into the row's meta JSON
    // (snapshot of canonical fields on the platform-resident record)
    // rather than the value JSON. NULL meta returns undefined per
    // drill's null-safety contract.
    if (drillPath[0] === 'meta') {
      return { kind: 'value', value: drill(row.meta, drillPath.slice(1)) };
    }
    return { kind: 'value', value: drill(row.value, drillPath) };
  };

  const resolve = (segments: ReadonlyArray<string>): EnrichmentResolveResult => {
    if (segments.length === 0) return { kind: 'null' };
    const [first, ...rest] = segments;
    if (typeof first !== 'string' || first.length === 0) return { kind: 'null' };
    if (DATA_SCOPES.has(first as EnrichmentScope)) {
      return resolvePerRecord(first as EnrichmentScope, rest);
    }
    // D-125 P6.1 — connection.<kind> compound scope. The `connection`
    // literal consumes the next segment as the kind so the rest of the
    // walk reads as `<target_id>.<topic_or_*>` like every other
    // per-record path.
    if (first === 'connection') {
      if (rest.length === 0) return { kind: 'null' };
      const [kindSeg, ...connRest] = rest;
      if (typeof kindSeg !== 'string' || kindSeg.length === 0) return { kind: 'null' };
      const compound = CONNECTION_KIND_BY_SUFFIX.get(kindSeg);
      if (compound === undefined) return { kind: 'null' };
      return resolvePerRecord(compound, connRest);
    }
    if (isEnrichmentTopic(first)) {
      const def = ENRICHMENT_REGISTRY[first] as EnrichmentDefinition;
      if (def.shape === 'derived_entity') {
        return resolveDerivedEntity(first, rest);
      }
      // Per-record topic at the top level — invalid (topic comes after
      // scope + target_id). Return null so the recipe surface sees
      // a missing ref rather than an unrelated row.
      return { kind: 'null' };
    }
    return { kind: 'null' };
  };

  const lookup = (topic: string): EnrichmentDefinition | null => {
    if (!isEnrichmentTopic(topic)) return null;
    return ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  };

  return { resolve, lookup };
};

/** D-125 P6.2 — `readEnrichmentRow` adapter for the engine's
 *  TransformContext. Wraps `store.list` to pull the freshest row and
 *  projects it into the `EnrichmentRowSnapshot` shape the
 *  `enrichment-or-fetch` transform expects. Returns null when no row
 *  matches the (topic, scope, target_id) triple. Multi-author topics
 *  use ingestion order to pick "freshest" — ENRICHMENT_REGISTRY topics
 *  with multi-author support narrow on a single canonical producer in
 *  practice, so this is a safe default.
 *
 *  D-136 P7.E §A.13.5 — `policy.gate_mcp_private: true` makes the reader
 *  short-circuit `null` for any topic declared `mcp_exposed: 'private'`
 *  before touching the store. Used by `execute-handler.ts` when the
 *  recipe's `trigger_source === 'mcp'` so MCP-invoked recipes can't
 *  fetch private-topic values via `enrichment-or-fetch`. Default
 *  `false` preserves the user-permissive read path for paired-client
 *  triggers. */
export interface EnrichmentReaderPolicy {
  gate_mcp_private?: boolean;
  /** D-187 AMENDMENT — the enclosing recipe's bound-contract read-grant checker,
   *  resolved ONCE at the execute boundary (via the overlay) when the recipe is
   *  MCP-triggered. The reader short-circuits a topic the contract isn't read-granted
   *  (the unified `enrichment.<topic>` grant — folding the former scope-fence +
   *  `mcp_exposed` visibility). Optional; absent ⇒ {@link AUTHOR_DEFAULT_READ_GRANT_CHECKER}
   *  (every topic at its registry author default). */
  readGrantChecker?: ReadGrantChecker;
}

export const createEnrichmentReader = (
  store: EnrichmentStore,
  policy: EnrichmentReaderPolicy = {},
) => {
  const checker = policy.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  return (topic: string, scope: EnrichmentScope, target_id: string): EnrichmentRowSnapshot | null => {
    if (
      policy.gate_mcp_private === true
      && isEnrichmentTopic(topic)
      && !checker.isTopicReadGranted(topic as EnrichmentTopic)
    ) {
      // D-187 AMENDMENT — short-circuit BEFORE any store read so timing doesn't leak
      // whether matching rows exist on a topic the contract isn't read-granted. The
      // transform sees this as a `'miss'` (same shape as a never-written row) and falls
      // through to its declared fallback step. The MCP-triggered recipe gets a
      // normal-shaped null, never the row's value.
      return null;
    }
    const rows = store.list({
      topic,
      scope,
      target_id,
      fresh_only: false,
      limit: 1,
    });
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      value: row.value,
      event_at: row.event_at,
      ingested_at: row.ingested_at,
      // D-136 P2 — project the three-state `staleness_class` to the
      // transform-layer's binary `stale: boolean`. Anything off
      // `'fresh'` is stale to the freshness gate; the gate doesn't
      // distinguish `'stale'` (cascade-marked) from `'expired'`
      // (TTL/tombstone). P3+ may widen the transform contract.
      stale: row.staleness_class !== 'fresh',
      // The schema has no top-level confidence column — the transform
      // sources it from `value.confidence` when the producer wrote it.
      confidence: null,
    };
  };
};

/** Walk into a JSON value with the remaining path segments. Mirrors
 *  the engine's `walkPath` semantics — undefined-safe, returns
 *  undefined for any missing intermediate. */
const drill = (value: unknown, path: ReadonlyArray<string>): unknown => {
  let cursor: unknown = value;
  for (const segment of path) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};
