/** D-120 Phase 5 — `data.timeline()` MCP primitive implementation.
 *
 *  Server-side cross-source merge: D-120 memory entries (links →
 *  audit_entries join) + D-119 typed annotations + D-119 typed links
 *  + raw collection record snapshot. All filtered by the same
 *  `(entity_id, since, until)` window, sorted globally by `(ts DESC,
 *  key DESC)`, and paginated with the opaque cursor codec defined in
 *  `packages/contracts/src/mcp.ts`.
 *
 *  Per-source fetch caps at `limit + 1` rows so the merge never
 *  blows up on entities with thousands of touches; the cursor
 *  guarantees the next page picks up where the previous left off.
 *  Indexed paths (`idx_links_entity_ts`, annotation
 *  `(target_collection, target_id)` index, link `from_*` / `to_*`
 *  indexes) carry every per-source filter; the merge is the only
 *  in-memory work.
 *
 *  Spec: D-120 (`data.timeline()` MCP primitive +
 *  Phase 5 deliverables).
 */

import type Database from 'better-sqlite3';
import {
  RpcError,
  clampTimelineLimit,
  decodeTimelineCursor,
  encodeTimelineCursor,
  isEnrichmentScope,
  isEnrichmentTopic,
  isGrantedReadAdmissible,
  isTimelineSource,
  originActorPassesTimelineFilter,
  parseTimelineEntityId,
  renderProvenanceAttribution,
  agentIdFromSource,
  sanitizeTimelineOriginFilter,
  timelineEntryKey,
  type Actor,
  type EnrichmentScope,
  type EnrichmentTopic,
  type TimelineCursor,
  type TimelineEntry,
  type TimelineRequest,
  type TimelineResponse,
  type TimelineSource,
  type TimelineRollup,
} from '@recued/contracts';
import type { AuditEntry, AuditLogStore } from '@recued/storage';
import type { AnnotationStore } from '../storage/annotation-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import { contactAddressSet } from '../storage/contact-merge-graph.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

/** D-187 slice-3 read gate — the VERB-OP that gates the `dataTimeline` native tool
 *  ("may this contract use the timeline read tool at all"). Reuses the EXISTING
 *  `core.memory.timeline.read` kernel op (the recipe-channel timeline-read op) rather
 *  than minting a new id — the same grant gates both surfaces. Composed with the
 *  per-entity collection grant (whole-tool gate, at the entry fence) and the per-row
 *  enrichment-topic grant (defense-in-depth on the sensitive `value`s) via
 *  `isGrantedReadAdmissible`: a collection / topic grant does NOT imply the verb. */
const TIMELINE_VERB_OP = 'core.memory.timeline.read';

/** Loader signature for raw collection records. The composition root
 *  wires this to walk the registered collections that match the
 *  parsed `collection` name. Returns `null` when no record matches —
 *  callers should treat that as "raw record source contributes
 *  nothing for this entity" and not as an error. */
export type LoadCollectionRecord = (
  collection: string,
  id: string,
) => Promise<TimelineEntry | null>;

/** Everything `handleTimelineRequest` needs. Each field is optional —
 *  missing stores degrade gracefully (empty entries from that
 *  source). Wiring through the MCP server keeps test setup minimal:
 *  pass only the stores under test, leave the rest unset. */
export interface TimelineDeps {
  /** Raw SQLite handle for the `links` table query. When absent,
   *  memory entries skip. */
  db?: Database.Database;
  /** Audit log store for the run-id → AuditEntry lookup that
   *  populates each memory entry's payload. When absent, memory
   *  entries skip even if `db` is wired. */
  auditLog?: AuditLogStore;
  /** D-119 annotation + link store. When absent, both
   *  `'annotation'` and `'link'` sources skip. */
  annotationStore?: AnnotationStore;
  /** Optional callback resolving the raw collection record. When
   *  absent, the `'mail'` / `'calendar'` / etc. sources skip. */
  loadCollectionRecord?: LoadCollectionRecord;
  /** D-128 Phase 5 — enrichment store for the `'enrichment'` source.
   *  When absent, enrichment entries skip. The loader keys on
   *  `(scope, target_id)` derived from the parsed entity_id; closed
   *  warehouse scopes (`mail` / `contact` / `calendar` / `file`) flow
   *  the same as platform-reference scopes (`connection.api.<vendor>.
   *  <entity>`) — the SQL filter handles both shapes uniformly. */
  enrichmentStore?: EnrichmentStore;
  /** D-187 AMENDMENT — the bound contract's per-dispatch read-grant checker, resolved
   *  at the dispatch boundary (the native `recued_dataTimeline` tool's door contract, or
   *  the recipe-channel `timeline-read`'s enclosing-recipe contract). Gates BOTH planes
   *  of the feed: the raw-collection fence (`isCollectionReadGranted`, the former
   *  `readableCollections`) and the per-enrichment-row fence (`isTopicReadGranted`,
   *  folding the former `enrichmentScopeRestrictions` scope-fence AND the `mcp_exposed`
   *  visibility into one grant lookup). Applied only when `gateMcpPrivate` is set —
   *  internal / paired-client recipes (contract-free) pass none / leave it off. */
  readGrantChecker?: ReadGrantChecker;
  /** D-136 §A.13.5 P7.G — when true, the timeline applies the read-grant gate
   *  (`readGrantChecker`) to BOTH the raw-collection fence and the enrichment-row
   *  filter. The MCP-channel `recued_dataTimeline` tool always sets this; the
   *  recipe-channel `timeline-read` ingredient sets it iff the enclosing recipe was
   *  MCP-triggered (`trigger_source === 'mcp'`). Default false — internal / paired-client
   *  recipes are contract-free and see the full feed. Mirrors
   *  `EnrichmentReaderPolicy.gate_mcp_private` from the `enrichment-or-fetch` path. */
  gateMcpPrivate?: boolean;
  /** D-226 — every installed pack's declared projection onto this identity.
   *  Absent ⇒ the response carries no `rollups` at all, which is how a
   *  collection with no declared roots reads. Wired ONLY after the whole-tool
   *  read gate above, so a rollup can never be seen by a caller who was
   *  refused the feed itself: the aggregate is derived from the same records
   *  the entries come from, and must not become a side door around them. */
  rollupsForEntity?(collection: string, id: string): TimelineRollup[];
}

/** Entry assembled internally during the merge — carries the stable
 *  per-row id alongside the `TimelineEntry` so the cursor codec has
 *  a deterministic tiebreaker. The id never leaks to callers (it's
 *  source-internal); the published cursor encodes it via
 *  `timelineEntryKey`. */
interface MergeEntry {
  entry: TimelineEntry;
  /** Stable per-row id for cursor + sort tiebreaker. Source-specific
   *  shape — memory uses `<run_id>:<kind>:<ts>`, annotation uses the
   *  annotation `_id`, link uses the link `_id`, raw record uses
   *  `<collection>:<id>`. Only the first colon-delimited segment
   *  matters for cursor stability; the rest exists so multi-emit
   *  per-row sources don't collide on the merge key. */
  rowId: string;
}

/** Each per-source loader returns the merge entries it found PLUS a
 *  signal of whether the source fully drained or hit the fetch cap.
 *  The orchestrator combines `hadMore` flags into the response's
 *  next-cursor decision so pagination keeps advancing even when the
 *  cursor's same-ts boundary tiebreaker shrinks the merged set down
 *  to exactly `limit`. */
interface LoaderResult {
  entries: MergeEntry[];
  /** True when the underlying SQL / store query hit its `LIMIT`
   *  argument exactly — there may be more rows beyond what we
   *  fetched. */
  hadMore: boolean;
}

const mergeKey = (m: MergeEntry): string =>
  timelineEntryKey(m.entry.source, m.entry.kind, m.rowId);

/** DESC by ts; tie-broken DESC by mergeKey. Pure comparator; passed
 *  to `Array.prototype.sort`. */
const compareDesc = (a: MergeEntry, b: MergeEntry): number => {
  if (a.entry.ts !== b.entry.ts) return b.entry.ts - a.entry.ts;
  const ka = mergeKey(a);
  const kb = mergeKey(b);
  if (ka === kb) return 0;
  return ka < kb ? 1 : -1; // DESC
};

/** Cursor predicate: keep entry iff it falls strictly after the
 *  cursor anchor in the DESC sort (= older or same-ts-but-smaller-
 *  key). When cursor is null, every entry passes. */
const passesCursor = (
  m: MergeEntry,
  cursor: TimelineCursor | null,
): boolean => {
  if (cursor === null) return true;
  if (m.entry.ts < cursor.last_ts) return true;
  if (m.entry.ts > cursor.last_ts) return false;
  return mergeKey(m) < cursor.last_key;
};

// ────────────────────────────────────────────────────────────────
// Memory entries — D-120 links → audit_entries join
// ────────────────────────────────────────────────────────────────

/** SQL fragment for the indexed range scan on the `links` table.
 *  Composed at call time to fold optional `since` / `until` clauses
 *  + the cursor filter into a single prepared statement.
 *
 *  D-120 Phase 7.5 — bistemporal axis. When `axis === 'event'` (the
 *  default), the query orders by `COALESCE(event_at, ts) DESC` and
 *  uses the `idx_links_entity_event` covering index landed by the
 *  bistemporal migration; range/cursor filters apply against the
 *  same expression so a backfill recipe's link surfaces at the
 *  underlying source record's date rather than today. When
 *  `axis === 'ingestion'`, the original `(entity_id, ts DESC)` index
 *  serves — same path as pre-7.5. */
/** Expand a qualified `contact:<email>` entity id across the contact's merge
 *  group, returning one qualified id per address. Any other collection (and any
 *  unparseable id) round-trips unchanged as a single-element list — this is a
 *  CONTACT identity concern, not a general one.
 *
 *  Returns the survivor's own id first-or-somewhere in a deterministic order
 *  (`contactAddressSet` sorts), so the query is reproducible. */
const expandContactEntityIds = (
  deps: TimelineDeps,
  qualifiedEntityId: string,
): string[] => {
  if (!deps.db) return [qualifiedEntityId];
  const parsed = parseTimelineEntityId(qualifiedEntityId);
  if (!parsed || parsed.collection !== 'contact' || parsed.id === '') {
    return [qualifiedEntityId];
  }
  const addresses = contactAddressSet(deps.db, parsed.id);
  if (addresses.length <= 1) return [qualifiedEntityId];
  return addresses.map((email) => `contact:${email}`);
};

const buildLinksQuery = (
  hasSince: boolean,
  hasUntil: boolean,
  hasCursor: boolean,
  axis: 'event' | 'ingestion',
  entityIdCount = 1,
): string => {
  const tsExpr = axis === 'event' ? 'COALESCE(event_at, ts)' : 'ts';
  // D-161 P4 — select the link row's OWN origin facet (P1-stamped). It is
  // the prune-robust, authoritative lane + attribution source for the
  // memory entry (the audit row may be pruned; the link survives — N.8).
  //
  // 🔑 **D-205 #3.5 — `entity_id` may be a SET.** ⚠ `links` (plural — the D-120
  // memory / recipe-run provenance trail) is NOT the `link` table (singular —
  // D-119's typed relationships). The merge rewrites `link` and `annotation`
  // via `annotationStore.rewriteRecordId`; it has never touched `links`. So a
  // contact's memory rows stay keyed on whichever address was current when the
  // recipe ran, and asking for the survivor alone loses every touch recorded
  // before the merge — permanently invisible on the one surface whose whole job
  // is "everything Recued knows about this person". The caller passes the
  // contact's whole address set; `(entity_id, ts DESC)` still serves each term.
  const idList = new Array(Math.max(entityIdCount, 1)).fill('?').join(', ');
  let sql = `
    SELECT entity_id, memory_id, recipe_insight_id, kind, ts, event_at,
           origin_actor, origin_contract_id
      FROM links
     WHERE entity_id IN (${idList})
  `;
  if (hasSince) sql += ` AND ${tsExpr} >= ?`;
  if (hasUntil) sql += ` AND ${tsExpr} < ?`;
  if (hasCursor) sql += ` AND ${tsExpr} <= ?`;
  sql += ` ORDER BY ${tsExpr} DESC LIMIT ?`;
  return sql;
};

interface LinkRow {
  entity_id: string;
  memory_id: string;
  recipe_insight_id: number;
  kind: string;
  ts: number;
  /** D-120 Phase 7.5 — bistemporal stamp; null pre-7.5 or when the
   *  emitting step had no underlying event date. */
  event_at: number | null;
  /** D-161 P1/P4 — the link row's own write-actor stamp (NOT NULL DEFAULT
   *  'system'). The authoritative, prune-robust lane for the memory entry. */
  origin_actor: Actor;
  /** D-161 P1/P4 — the contract in force on the writing run, when
   *  contracted; null otherwise. */
  origin_contract_id: string | null;
}

/** Load memory entries for `entity_id` within the window. Each row
 *  is paired with its AuditEntry for payload + recipe_slug. Audit
 *  rows that have been pruned (retention, manual purge) yield a
 *  `audit_pruned: true` payload — the link is the proof the touch
 *  happened even if the audit body is gone. */
const loadMemoryEntries = async (
  deps: TimelineDeps,
  qualifiedEntityId: string,
  since: number | undefined,
  until: number | undefined,
  cursor: TimelineCursor | null,
  fetchLimit: number,
  axis: 'event' | 'ingestion',
): Promise<LoaderResult> => {
  if (!deps.db || !deps.auditLog) return { entries: [], hadMore: false };
  // D-205 #3.5 — a contact's memory rows are keyed on the address that was
  // current when each recipe ran, so read across the merge group. Expansion
  // stays INSIDE the `contact` collection, so it crosses no read-grant boundary
  // (the fence above gates the collection, not the id).
  const entityIds = expandContactEntityIds(deps, qualifiedEntityId);
  const sql = buildLinksQuery(
    since !== undefined,
    until !== undefined,
    cursor !== null,
    axis,
    entityIds.length,
  );
  const params: unknown[] = [...entityIds];
  if (since !== undefined) params.push(since);
  if (until !== undefined) params.push(until);
  if (cursor !== null) params.push(cursor.last_ts);
  params.push(fetchLimit);
  const rows = deps.db.prepare(sql).all(...params) as LinkRow[];
  if (rows.length === 0) return { entries: [], hadMore: false };

  // De-duplicate audit lookups across multiple link rows pointing at
  // the same run_id. Common: a single recipe-run touches the same
  // entity through several steps and emits multiple links — they all
  // resolve to one AuditEntry.
  const audits = new Map<string, AuditEntry | null>();
  const entries: MergeEntry[] = [];
  for (const row of rows) {
    let audit = audits.get(row.memory_id);
    if (audit === undefined) {
      audit = await deps.auditLog.get(row.memory_id);
      audits.set(row.memory_id, audit);
    }
    // D-120 Phase 7.5 — under the event axis, the entry's `ts` reflects
    // the underlying event date (`COALESCE(event_at, ts)`) so consumers
    // see the right historical date. Under the ingestion axis, the
    // raw `ts` flows through unchanged.
    const effectiveTs = axis === 'event' ? (row.event_at ?? row.ts) : row.ts;
    // D-161 P4 — the LINK row's own P1 stamp (`row.origin_actor` /
    // `row.origin_contract_id`) is the SOLE source of truth for the memory
    // entry's actor + contract_id — NOT re-derived from the audit row — so
    // it SURVIVES audit prune (N.8 names "D-120 links" as the substrate; the
    // retained link IS the memory timeline row). The audit row, WHEN
    // PRESENT, only ENRICHES with facts it can PROVE belong to the same
    // contracted run: the agent identity (`execution_source`) only when its
    // actor matches the link's, the contract version (`contract_snapshot`)
    // only when the snapshot is for the link's OWN contract_id. So a pruned —
    // or a (theoretical) divergent — audit can never relabel the link-sourced
    // attribution; at worst it degrades the agent label to "an agent, under
    // contract Y" (Codex P4 re-review HIGH). Each enriching field is spread
    // only when resolvable, so none lands as `undefined` under
    // exactOptionalPropertyTypes.
    const auditSource = audit?.execution_source;
    const snapshot = audit?.contract_snapshot;
    const memoryContractId = row.origin_contract_id ?? undefined;
    const enrichAgentId =
      auditSource !== undefined && auditSource.actor === row.origin_actor
        ? agentIdFromSource(auditSource)
        : undefined;
    // D-209 #1 W3 — the channel enriches under the SAME proof as the agent
    // identity (audit actor matches the link's stamp): it selects the honest
    // `anonymous` label (reception visitor vs webhook vendor event). A pruned
    // / divergent audit leaves it absent → the channel-neutral phrasing.
    const enrichChannel =
      auditSource !== undefined && auditSource.actor === row.origin_actor
        ? auditSource.channel
        : undefined;
    const enrichContractVersion =
      snapshot !== undefined
      && memoryContractId !== undefined
      && snapshot.contract_id === memoryContractId
        ? snapshot.contract_version
        : undefined;
    const memoryAttribution = renderProvenanceAttribution({
      origin_actor: row.origin_actor,
      ...(enrichChannel !== undefined ? { channel: enrichChannel } : {}),
      ...(enrichAgentId !== undefined ? { agent_id: enrichAgentId } : {}),
      ...(memoryContractId !== undefined ? { contract_id: memoryContractId } : {}),
      ...(enrichContractVersion !== undefined
        ? { contract_version: enrichContractVersion }
        : {}),
    });
    const entry: TimelineEntry = {
      ts: effectiveTs,
      source: 'memory',
      kind: row.kind,
      payload: audit
        ? {
            run_id: audit.run_id,
            recipe_id: audit.recipe_id,
            recipe_hash: audit.recipe_hash,
            commit_status: audit.commit_status,
            duration_ms: audit.duration_ms,
            ...(audit.output_string !== undefined
              ? { output_string: audit.output_string }
              : {}),
            ...(audit.trigger_source !== undefined
              ? { trigger_source: audit.trigger_source }
              : {}),
          }
        : { run_id: row.memory_id, audit_pruned: true },
      recipe_insight_id: row.recipe_insight_id,
      ...(audit?.recipe_id ? { recipe_slug: audit.recipe_id } : {}),
      // D-161 P3/P4 — the memory entry's lane is the LINK row's OWN P1
      // `origin_actor` stamp (prune-robust — the audit row may be gone),
      // not re-derived from the audit. A sync / legacy link defaults to
      // `'system'` (the column's NOT NULL DEFAULT) — the gold-path lane.
      origin_actor: row.origin_actor,
      // D-161 P4 — present ONLY for an outside actor; a first-person row →
      // `undefined` → field omitted, so the gold path stays byte-identical
      // (I-9) and an agent's assertion never surfaces unattributed (I-10),
      // even after its audit row is pruned.
      ...(memoryAttribution ? { attribution: memoryAttribution } : {}),
    };
    entries.push({
      entry,
      // Multiple links can share (memory_id, kind) when the same
      // step touches the same entity twice with the same kind at
      // different timestamps — fold ts into rowId for uniqueness.
      rowId: `${row.memory_id}:${row.kind}:${row.ts}`,
    });
  }
  return { entries, hadMore: rows.length >= fetchLimit };
};

// ────────────────────────────────────────────────────────────────
// Annotations — D-119 sidecar
// ────────────────────────────────────────────────────────────────

const loadAnnotations = async (
  deps: TimelineDeps,
  collection: string,
  id: string,
  since: number | undefined,
  until: number | undefined,
  cursor: TimelineCursor | null,
  fetchLimit: number,
  axis: 'event' | 'ingestion',
): Promise<LoaderResult> => {
  if (!deps.annotationStore) return { entries: [], hadMore: false };
  const upper = (() => {
    if (cursor === null) return until;
    // Cursor's last_ts is INCLUSIVE upper bound; the cursor predicate
    // applies the strict-less-than on the merge side.
    if (until === undefined) return cursor.last_ts + 1;
    return Math.min(until, cursor.last_ts + 1);
  })();
  const filter: Parameters<AnnotationStore['listAnnotations']>[0] = {
    target_collection: collection,
    target_id: id,
    limit: fetchLimit,
  };
  if (since !== undefined) filter.since = since;
  if (upper !== undefined) filter.until = upper;
  const annotations = await deps.annotationStore.listAnnotations(filter);
  const entries: MergeEntry[] = annotations.map((ann) => {
    // D-120 Phase 7.5 — event-axis: use the source record's date when
    // present; ingestion-axis: stay on `authored_at` (when Recued
    // wrote the row).
    const effectiveTs = axis === 'event' ? (ann.event_at ?? ann.authored_at) : ann.authored_at;
    // D-161 P4 — attribution from the P2 annotation origin columns. A
    // sidecar row carries no `execution_source`, so there is no agent_id /
    // contract_version; the `origin_contract_id` still names "contract Y".
    const attribution = renderProvenanceAttribution({
      origin_actor: ann.origin_actor,
      ...(ann.origin_contract_id !== undefined
        ? { contract_id: ann.origin_contract_id }
        : {}),
    });
    return {
      entry: {
        ts: effectiveTs,
        source: 'annotation',
        kind: ann.key,
        payload: {
          annotation_id: ann._id,
          key: ann.key,
          value: ann.value,
          target_collection: ann.target_collection,
          target_id: ann.target_id,
          recipe_hash: ann.recipe_hash,
          ...(ann.model_used !== undefined ? { model_used: ann.model_used } : {}),
        },
        recipe_slug: ann.authored_by_recipe_id,
        // D-161 P3 — read the P2 annotation `origin_actor` stamp directly
        // (absent on a row P2 didn't stamp → `'system'`).
        origin_actor: ann.origin_actor ?? 'system',
        // D-161 P4 — outside-actor rows only; omitted for the gold path.
        ...(attribution ? { attribution } : {}),
      } satisfies TimelineEntry,
      rowId: ann._id,
    };
  });
  return { entries, hadMore: annotations.length >= fetchLimit };
};

// ────────────────────────────────────────────────────────────────
// D-119 typed links — inbound + outbound
// ────────────────────────────────────────────────────────────────

const loadTypedLinks = async (
  deps: TimelineDeps,
  collection: string,
  id: string,
  since: number | undefined,
  until: number | undefined,
  cursor: TimelineCursor | null,
  fetchLimit: number,
  axis: 'event' | 'ingestion',
): Promise<LoaderResult> => {
  if (!deps.annotationStore) return { entries: [], hadMore: false };
  const upper = (() => {
    if (cursor === null) return until;
    if (until === undefined) return cursor.last_ts + 1;
    return Math.min(until, cursor.last_ts + 1);
  })();
  const baseFilter = {
    limit: fetchLimit,
    ...(since !== undefined ? { since } : {}),
    ...(upper !== undefined ? { until: upper } : {}),
  };

  const inbound = await deps.annotationStore.listLinks({
    ...baseFilter,
    to_collection: collection,
    to_id: id,
  });
  const outbound = await deps.annotationStore.listLinks({
    ...baseFilter,
    from_collection: collection,
    from_id: id,
  });

  const entries: MergeEntry[] = [];
  for (const link of inbound) {
    // D-120 Phase 7.5 — same axis policy as memory + annotations.
    const effectiveTs = axis === 'event' ? (link.event_at ?? link.created_at) : link.created_at;
    // D-161 P4 — attribution from the P2 link origin columns. A D-119 link
    // row has no `execution_source`, so no agent_id / contract_version; the
    // `origin_contract_id` still names "contract Y".
    const attribution = renderProvenanceAttribution({
      origin_actor: link.origin_actor,
      ...(link.origin_contract_id !== undefined
        ? { contract_id: link.origin_contract_id }
        : {}),
    });
    entries.push({
      entry: {
        ts: effectiveTs,
        source: 'link',
        kind: `inbound:${link.role}`,
        payload: {
          link_id: link._id,
          role: link.role,
          direction: 'inbound',
          other_collection: link.from_collection,
          other_id: link.from_id,
        },
        recipe_slug: link.authored_by_recipe_id,
        origin_actor: link.origin_actor ?? 'system',
        ...(attribution ? { attribution } : {}),
      } satisfies TimelineEntry,
      rowId: link._id,
    });
  }
  for (const link of outbound) {
    const effectiveTs = axis === 'event' ? (link.event_at ?? link.created_at) : link.created_at;
    // D-161 P4 — attribution from the P2 link origin columns (see inbound).
    const attribution = renderProvenanceAttribution({
      origin_actor: link.origin_actor,
      ...(link.origin_contract_id !== undefined
        ? { contract_id: link.origin_contract_id }
        : {}),
    });
    entries.push({
      entry: {
        ts: effectiveTs,
        source: 'link',
        kind: `outbound:${link.role}`,
        payload: {
          link_id: link._id,
          role: link.role,
          direction: 'outbound',
          other_collection: link.to_collection,
          other_id: link.to_id,
        },
        recipe_slug: link.authored_by_recipe_id,
        origin_actor: link.origin_actor ?? 'system',
        ...(attribution ? { attribution } : {}),
      } satisfies TimelineEntry,
      rowId: link._id,
    });
  }
  return {
    entries,
    hadMore:
      inbound.length >= fetchLimit || outbound.length >= fetchLimit,
  };
};

// ────────────────────────────────────────────────────────────────
// Raw collection record — single snapshot, lifecycle-event-shaped
// ────────────────────────────────────────────────────────────────

const loadRawRecord = async (
  deps: TimelineDeps,
  collection: string,
  id: string,
  since: number | undefined,
  until: number | undefined,
  cursor: TimelineCursor | null,
): Promise<LoaderResult> => {
  const empty: LoaderResult = { entries: [], hadMore: false };
  if (!deps.loadCollectionRecord) return empty;
  const entry = await deps.loadCollectionRecord(collection, id);
  if (!entry) return empty;
  if (since !== undefined && entry.ts < since) return empty;
  if (until !== undefined && entry.ts >= until) return empty;
  if (cursor !== null) {
    const k = timelineEntryKey(entry.source, entry.kind, `${collection}:${id}`);
    if (entry.ts > cursor.last_ts) return empty;
    if (entry.ts === cursor.last_ts && k >= cursor.last_key) return empty;
  }
  if (!isTimelineSource(entry.source)) {
    // Defensive: the loader must return one of the contract sources.
    // Skip silently rather than returning a bogus shape.
    return empty;
  }
  // D-161 P4 — attribute the raw record from its origin facet, uniformly
  // with the other sources. Collection records are system-sync writes by
  // construction (`origin_actor` 'system' → `undefined` → no field), so
  // this is dormant today; it stays uniform for any future non-system
  // collection writer. A `TimelineEntry` carries no contract_id, so a
  // (hypothetical) outside-actor record names the lane without a contract.
  const attribution = renderProvenanceAttribution({ origin_actor: entry.origin_actor });
  if (attribution) entry.attribution = attribution;
  return {
    entries: [{ entry, rowId: `${collection}:${id}` }],
    hadMore: false, // single-snapshot source — never has "more"
  };
};

// ────────────────────────────────────────────────────────────────
// D-128 Phase 5 — enrichment rows
// ────────────────────────────────────────────────────────────────

/** Load `data_enrichment` rows for the parsed `(scope, target_id)`
 *  pair. Each row emits as one timeline entry tagged
 *  `source: 'enrichment'`, `kind: <topic>`. Payload carries the value
 *  + (when populated) the platform-reference meta snapshot, so a
 *  Memory-tab feed renders the canonical entity facts inline without
 *  round-tripping the vendor (D-128 §A.2 + §A.4).
 *
 *  Skips silently when:
 *    - `enrichmentStore` is absent (dbless harness, MCP path with
 *      no enrichment substrate wired);
 *    - the parsed `collection` doesn't validate as an
 *      `EnrichmentScope` — closed mail/contact/calendar/file scopes
 *      and the four-segment platform-reference scopes pass through;
 *      anything else (e.g. `connection.api` without a vendor +
 *      entity, deal/issue collection roots from non-warehouse
 *      surfaces) returns no entries. */
const loadEnrichmentEntries = async (
  deps: TimelineDeps,
  collection: string,
  id: string,
  since: number | undefined,
  until: number | undefined,
  cursor: TimelineCursor | null,
  fetchLimit: number,
  axis: 'event' | 'ingestion',
): Promise<LoaderResult> => {
  if (!deps.enrichmentStore) return { entries: [], hadMore: false };
  if (!isEnrichmentScope(collection)) {
    return { entries: [], hadMore: false };
  }
  // The cursor's last_ts is the inclusive upper boundary the SQL
  // honours; the strict-less-than tiebreaker happens in the merge
  // layer so we don't leak `(ts, key)` semantics into store SQL.
  const upper = (() => {
    if (cursor === null) return until;
    if (until === undefined) return cursor.last_ts + 1;
    return Math.min(until, cursor.last_ts + 1);
  })();
  const rows = deps.enrichmentStore.listByTarget(
    collection as EnrichmentScope,
    id,
    {
      axis,
      ...(since !== undefined ? { since } : {}),
      ...(upper !== undefined ? { until: upper } : {}),
      limit: fetchLimit,
    },
  );
  if (rows.length === 0) return { entries: [], hadMore: false };
  // P7.E §A.13.5 — gate on `mcp_exposed`. Filter rows whose topic is
  // declared `'private'` BEFORE mapping payloads so the agent never
  // sees the topic name, value, or meta. `hadMore` is computed off the
  // unfiltered length so pagination cursor stability is preserved —
  // future pages resume past the filtered window. P7.G threads the
  // user-override snapshot AND a `gateMcpPrivate` flag so the filter
  // only applies when the caller has opted in (MCP-channel always; the
  // recipe-channel only when `trigger_source === 'mcp'`). Paired-client
  // recipes see private rows by construction.
  // D-187 AMENDMENT — when the read-grant gate applies (`gateMcpPrivate`: the MCP
  // channel always; the recipe channel iff mcp-triggered — internal / paired-client
  // recipes are contract-free and leave it off), drop enrichment rows the bound
  // contract is NOT read-granted. The checker's `isTopicReadGranted` folds the former
  // per-topic door-scope fence AND the `mcp_exposed: 'private'` visibility into one
  // grant lookup — so a door reads an enrichment topic's `value` through the timeline
  // ONLY if its contract is granted that topic, the SAME `enrichment.<topic>` grant
  // `recued_enrichmentRead` enforces. A `row.topic` that is not a registered enrichment
  // topic is not an enrichment-plane row this gate governs (and the checker would throw
  // on it), so gate `isEnrichmentTopic` first — it passes through. `hadMore` stays
  // computed off the UNFILTERED `rows.length` so the cursor resumes past the window.
  //
  // FAIL-CLOSED (codex HIGH fold) — when `gateMcpPrivate` is set but no checker was
  // wired (Producer B's recipe path can request gating while `readGrantResolver` is
  // unwired), fall back to {@link AUTHOR_DEFAULT_READ_GRANT_CHECKER} — every topic at
  // its registry author default (`mcp_exposed`), exactly the old
  // `isTopicMcpPrivate(.., undefined)` behavior. Never admit-all on a missing checker.
  const checker = deps.gateMcpPrivate
    ? (deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER)
    : undefined;
  // D-187 slice 3 — the read gate for the sensitive enrichment `value`s the timeline
  // surfaces is `verb-op grant ∧ topic grant` (`isGrantedReadAdmissible`), the SAME gate
  // `recued_enrichmentRead` applies. The verb-op is the whole-tool gate already enforced
  // at the entry fence in `handleTimelineRequest`, so it is granted here in practice;
  // re-composing it is defense-in-depth (an enrichment row never leaks its `value` on a
  // denied verb-op even if a future caller reaches this loader without the fence). Constant
  // per call — resolved once.
  const verbOpGranted = checker ? checker.isVerbOpGranted(TIMELINE_VERB_OP) : true;
  const visibleRows = rows.filter((row) => {
    if (
      checker
      && isEnrichmentTopic(row.topic)
      && !isGrantedReadAdmissible(verbOpGranted, checker.isTopicReadGranted(row.topic as EnrichmentTopic))
    ) {
      return false;
    }
    return true;
  });
  if (visibleRows.length === 0) {
    return { entries: [], hadMore: rows.length >= fetchLimit };
  }
  const entries: MergeEntry[] = visibleRows.map((row) => {
    // Effective ts mirrors the per-source axis policy: event-axis
    // surfaces the underlying source-record date so a backfill
    // producer's row appears at the historical date, not the write
    // date. Ingestion-axis falls back to ingested_at uniformly.
    const effectiveTs =
      axis === 'event' ? (row.event_at ?? row.ingested_at) : row.ingested_at;
    // D-161 P4 — attribution from the P1 enrichment origin columns
    // (origin_actor NOT NULL; origin_contract_id nullable → "contract Y").
    // No execution_source on an enrichment row → no agent_id / version.
    const attribution = renderProvenanceAttribution({
      origin_actor: row.origin_actor,
      ...(row.origin_contract_id != null
        ? { contract_id: row.origin_contract_id }
        : {}),
    });
    return {
      entry: {
        ts: effectiveTs,
        source: 'enrichment',
        kind: row.topic,
        payload: {
          enrichment_id: row._id,
          topic: row.topic,
          scope: row.scope,
          target_id: row.target_id,
          value: row.value,
          staleness_class: row.staleness_class,
          authored_at: row.authored_at,
          ingested_at: row.ingested_at,
          ...(row.meta !== null ? { meta: row.meta } : {}),
          ...(row.ingredient_slug !== null ? { ingredient_slug: row.ingredient_slug } : {}),
          ...(row.model_id !== null ? { model_id: row.model_id } : {}),
          ...(row.event_at !== null ? { event_at: row.event_at } : {}),
        },
        recipe_slug: row.authored_by,
        // D-161 P3 — read the P1 enrichment `origin_actor` column (NOT NULL
        // DEFAULT 'system'; the `??` is belt-and-suspenders for legacy rows).
        origin_actor: row.origin_actor ?? 'system',
        // D-161 P4 — outside-actor rows only; omitted for the gold path.
        ...(attribution ? { attribution } : {}),
      } satisfies TimelineEntry,
      // _id alone is unique across the table — no kind/ts suffix
      // needed for tiebreaking the way memory's run-id needs it.
      rowId: row._id,
    };
  });
  return { entries, hadMore: rows.length >= fetchLimit };
};

// ────────────────────────────────────────────────────────────────
// Top-level orchestrator
// ────────────────────────────────────────────────────────────────

/** Validate + parse the request, fan out to per-source loaders,
 *  merge globally, slice to `limit`, encode `next_cursor` when the
 *  fetch suggests more rows are pending.
 *
 *  Throws `RpcError(bad_request)` for malformed `entity_id` (no
 *  colon, empty side) so callers get a clear 400 instead of an
 *  empty-but-valid response. Other failures (DB / store errors)
 *  bubble unchanged — `handleToolCall` wraps them as MCP errors. */
export const handleTimelineRequest = async (
  deps: TimelineDeps,
  request: TimelineRequest,
): Promise<TimelineResponse> => {
  const parsed = parseTimelineEntityId(request.entity_id);
  if (!parsed) {
    throw new RpcError(
      'bad_request',
      `entity_id must be in '<collection>:<id>' format (got: ${JSON.stringify(request.entity_id)})`,
      400,
    );
  }
  const { collection, id } = parsed;
  // D-187 AMENDMENT — per-door read-collection fence, now a unified `data.<collection>`
  // grant lookup via the read-grant checker (the former `deps.readableCollections`
  // enum). The timeline is single-entity, so gating the entity's own collection is the
  // enforcement: a governed collection the door isn't read-granted yields an EMPTY feed
  // (read nothing), BEFORE any DB / store access (no existence leak, no wasted query).
  // Applied only under the read-grant gate (`gateMcpPrivate`) — internal / paired-client
  // recipes are contract-free and impose no fence (the owner / stdio path reads all). A
  // collection outside the grant's jurisdiction (enrichment scope, …) is deferred by the
  // checker's author-default (a non-`READABLE_COLLECTIONS` key admits-all) to its own
  // gate. FAIL-CLOSED
  // (codex HIGH fold): a requested gate with no wired checker falls back to the
  // author-default checker (admit-all collections — matching the old recipe path's
  // absent `readableCollections`), never a silent admit-all bypass of a real grant.
  const collectionChecker = deps.gateMcpPrivate
    ? (deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER)
    : undefined;
  // D-187 slice 3 — the whole-tool read gate: `verb-op grant ∧ collection grant`
  // (`isGrantedReadAdmissible`). A contract not granted the `core.memory.timeline.read`
  // verb-op yields an EMPTY feed before any fetch (a collection grant does not imply the
  // verb); the collection fence still applies on top. This is the tool's single entry
  // point — all loaders run after it — so the verb-op need not be re-checked per loader
  // (the enrichment loader composes it again anyway as defense-in-depth on `value`s).
  if (
    collectionChecker
    && !isGrantedReadAdmissible(
      collectionChecker.isVerbOpGranted(TIMELINE_VERB_OP),
      collectionChecker.isCollectionReadGranted(collection),
    )
  ) {
    return { entries: [] };
  }
  const limit = clampTimelineLimit(request.limit);
  const cursor = request.cursor ? decodeTimelineCursor(request.cursor) : null;
  const since = request.since;
  const until = request.until;
  // D-120 Phase 7.5 — bistemporal axis. `'event'` (default) sorts by
  // the underlying real-world date via `COALESCE(event_at, ts)` so
  // backfill recipes don't pollute "Recent activity" with phantom-
  // recent timestamps; `'ingestion'` falls back to the original `ts`
  // ordering for "Recently discovered" surfaces.
  const axis: 'event' | 'ingestion' = request.axis === 'ingestion' ? 'ingestion' : 'event';
  // D-161 P3 — actor-lane filter. Sanitized defensively (typed callers pass a
  // clean `Actor[]`; the untyped MCP / recipe paths pass raw args). Undefined
  // → NO narrowing: full per-entity history, preserving the I-9 gold-path
  // default for callers that don't opt into a lane. Applied in the merge
  // beside the cursor predicate (below) so outside-actor rows are filtered
  // from the page but never dropped from the warehouse (I-7); `hadMore` stays
  // off the unfiltered per-source counts, so pagination keeps advancing —
  // the same post-fetch-filter shape as the P7.E `mcp_exposed` gate.
  const originFilter = sanitizeTimelineOriginFilter(request.origin_actors);

  // Per-source fetch cap = `limit * 2 + 1`. Two factors drive the
  // headroom over `limit`:
  //   - the merge picks the global top-`limit` across sources, so
  //     each source needs to surface enough rows to compete (a
  //     dense memory source can't crowd out an annotation that
  //     belongs in the page);
  //   - the cursor's same-ts boundary tiebreaker can drop up to
  //     N rows at `cursor.last_ts`, where N is the count of co-
  //     timestamped entries; over-fetching keeps merged length
  //     above `limit` even after the drop so the merge-overflow
  //     signal stays accurate.
  // For typical entities (handful of touches per ts), this is plenty;
  // pathological cases (thousands of rows at one ts) fall back onto
  // the per-source `hadMore` signal below.
  const perSourceLimit = limit * 2 + 1;

  const [memory, annotations, typedLinks, rawRecord, enrichments] = await Promise.all([
    loadMemoryEntries(deps, request.entity_id, since, until, cursor, perSourceLimit, axis),
    loadAnnotations(deps, collection, id, since, until, cursor, perSourceLimit, axis),
    loadTypedLinks(deps, collection, id, since, until, cursor, perSourceLimit, axis),
    loadRawRecord(deps, collection, id, since, until, cursor),
    loadEnrichmentEntries(deps, collection, id, since, until, cursor, perSourceLimit, axis),
  ]);

  // Cursor filter applies after fetch: the SQL paths apply
  // `ts <= cursor.last_ts`; the strict-less-than tiebreaker happens
  // here so we don't leak `(ts, key)` semantics into the SQL layer. The
  // D-161 P3 actor-lane filter is a SECOND pass (below) — kept separate from
  // the cursor filter so pagination can still advance past a window that is
  // entirely outside the requested lane (the empty-page anchor, below).
  const cursorPassed = [
    ...memory.entries,
    ...annotations.entries,
    ...typedLinks.entries,
    ...rawRecord.entries,
    ...enrichments.entries,
  ]
    .filter((m) => passesCursor(m, cursor))
    .sort(compareDesc);

  // D-161 P3 — narrow to the requested actor lane(s). Undefined filter →
  // pass-through (no narrowing; the I-9 gold-path default).
  const laneMatched =
    originFilter === undefined
      ? cursorPassed
      : cursorPassed.filter((m) =>
          originActorPassesTimelineFilter(m.entry.origin_actor, originFilter),
        );

  // Pagination decision combines two signals:
  //   - any source returned its full LIMIT rows (the SQL filter
  //     can't tell us if there are more beyond the cap, so we
  //     assume yes — the next page either confirms or returns
  //     empty)
  //   - the lane-matched set itself overflows `limit` after slicing
  // Either is sufficient to require another page; the cursor
  // anchors at the slice boundary so the next call advances.
  const sourcesHadMore =
    memory.hadMore
    || annotations.hadMore
    || typedLinks.hadMore
    || rawRecord.hadMore
    || enrichments.hadMore;
  const page = laneMatched.slice(0, limit);
  const hasMore = sourcesHadMore || laneMatched.length > limit;
  // Cursor anchor. Normally the last RETURNED row, so the next page resumes
  // strictly older with no skip/dupe. But under an actor-lane filter a whole
  // fetched window can be non-matching → `page` is empty while `hasMore` is
  // true; with no page entry to anchor on, the old `page.length > 0` guard
  // emitted NO cursor and stranded deeper matching rows (the I-7 reachability
  // bug — Codex P3 review HIGH). Fall back to the UNFILTERED top-`limit`
  // boundary (`cursorPassed`): it is within every source's over-fetched window
  // (`perSourceLimit = limit*2+1`), so it never skips a source, and it strictly
  // advances the scan — so a follow-up page reaches the deeper lane rows,
  // iterating one `limit`-window per call until a match surfaces or the feed
  // drains. For the no-filter path `laneMatched === cursorPassed`, so an empty
  // page means `cursorPassed` is empty too → anchor `undefined` → behavior is
  // byte-identical to pre-P3.
  const anchor =
    page.length > 0
      ? page[page.length - 1]
      : cursorPassed.length > 0
        ? cursorPassed[Math.min(limit, cursorPassed.length) - 1]
        : undefined;
  // Emission still gates on `hasMore` (NOT merely "anchor exists") — a
  // fully-returned final page has a non-empty `page` but `hasMore === false`,
  // and must terminate with no cursor exactly as pre-P3.
  const next_cursor =
    hasMore && anchor !== undefined
      ? encodeTimelineCursor({
          last_ts: anchor.entry.ts,
          last_key: mergeKey(anchor),
        })
      : undefined;

  const entries = page.map((m) => m.entry);
  // ⚠ Computed AFTER the grant fence and independently of the page window:
  // `since` / `until` / `limit` bound the CHRONOLOGY, and a standing aggregate
  // is not in that chronology. Clipping it to the page would silently answer
  // "what have I not billed Bob for" with "…in the last 30 days", which is a
  // different question wearing the same words.
  const rollups = deps.rollupsForEntity?.(collection, parsed.id);
  const base = next_cursor !== undefined ? { entries, next_cursor } : { entries };
  return rollups === undefined ? base : { ...base, rollups };
};

/** Re-export so consumers (mcp-server.ts) can name the supplier
 *  callback type without reaching into the contracts package twice. */
export type { TimelineSource };
