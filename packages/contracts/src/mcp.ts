/** D-120 Phase 5 — `data.timeline()` MCP primitive shapes.
 *
 *  Public wire types for the seventh tool on the server's MCP surface.
 *  External AI agents call `recued_dataTimeline(entity_id)` to fetch a
 *  chronological feed across raw collections + annotations + memory
 *  for one entity. Server-side merge happens in
 *  `backend/server/src/mcp/timeline.ts`; this module owns only the
 *  wire-format types + opaque cursor codec + entity-id parser, so
 *  contracts stays pure (no Node-only APIs beyond the standard
 *  `atob`/`btoa` already used in `bundle.ts`).
 *
 *  Spec: docs/d-120-spec.md (`data.timeline()` MCP primitive).
 */

/** Default cap on returned timeline entries when the caller omits
 *  `limit`. Tuned for AI agents that summarise a screenful of recent
 *  activity per call — large enough to capture a working window,
 *  small enough that the merge stays cheap. */
export const TIMELINE_DEFAULT_LIMIT = 100;

/** Hard ceiling — server clamps `limit` down to this value when a
 *  caller asks for more. Bounds the worst-case scan + merge cost on
 *  power-user warehouses (~100K rows is a realistic upper end). */
export const TIMELINE_MAX_LIMIT = 1000;

/** Closed enumeration of `TimelineEntry.source` values. Membership
 *  is fixed at the contract layer so consumers can switch on it
 *  exhaustively. New collections widen the union as they ship. */
export const TIMELINE_SOURCES = [
  // Raw warehouse collections (D-106/D-117/D-118 — emit per-record
  // create/update events; payload carries `hot_fields` + size).
  'mail',
  'calendar',
  'file',
  'webhook',
  'service',
  // Sidecar collections (D-119 Phase 13 — recipe-authored facts +
  // typed cross-collection links).
  'annotation',
  'link',
  // D-120 — memory entries linked to the entity via the `links`
  // table. One per recipe-run touch; payload carries the run's
  // recipe id + outcome.
  'memory',
  // D-128 Phase 5 — every `data_enrichment` row whose `(scope,
  // target_id)` matches the entity. One feed entry per row; payload
  // carries `{ topic, value, meta?, ingredient_slug?, model_id?,
  // staleness_class, authored_by }`. The `meta` slot lets a Memory-tab
  // feed render the platform-resident record's name / status / amount
  // without round-tripping the vendor (D-128 §A.4 + §A.9). D-136 P2
  // renamed `model_used` → `ingredient_slug` and added `model_id`;
  // `stale: boolean` widened to `staleness_class: 'fresh' | 'stale' | 'expired'`.
  'enrichment',
] as const;

/** String-literal union derived from `TIMELINE_SOURCES`. */
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** Predicate — true when `value` is one of the defined sources. */
export const isTimelineSource = (value: unknown): value is TimelineSource =>
  typeof value === 'string'
  && (TIMELINE_SOURCES as readonly string[]).includes(value);

/** Inbound shape for `recued_dataTimeline`. The colon-delimited
 *  `entity_id` is the single "what is this about" anchor — every
 *  source filters against it. `since` / `until` apply the same range
 *  to every source so the merge stays consistent.
 *
 *  Pagination is opaque: callers pass back the previous response's
 *  `next_cursor` verbatim. The cursor encodes the (ts, key) of the
 *  last entry returned; the next page resumes strictly older / lex-
 *  smaller. Stable across repeated calls as long as no new entries
 *  land at the boundary (which would shift the page break — same
 *  caveat as every offset-style cursor). */
export interface TimelineRequest {
  /** Entity reference in `<collection>:<id>` format
   *  (e.g. `'mail:msg-abc123'`, `'deal:hubspot-42'`). The colon
   *  separates the collection from the collection-specific stable
   *  identifier; the right-hand side itself MAY contain colons (e.g.
   *  RFC-822 message-ids) — the split is on the FIRST colon. */
  entity_id: string;
  /** Optional epoch-ms lower bound (inclusive). Filters every source. */
  since?: number;
  /** Optional epoch-ms upper bound (exclusive). Filters every source. */
  until?: number;
  /** Hard cap on returned entries. Server clamps to
   *  `TIMELINE_MAX_LIMIT` when exceeded; default
   *  `TIMELINE_DEFAULT_LIMIT` when omitted. */
  limit?: number;
  /** Opaque pagination token returned by the previous call's
   *  `next_cursor`. */
  cursor?: string;
  /** D-120 Phase 7.5 — chronology axis selector. `'event'` (default)
   *  orders by real-world time via `COALESCE(event_at, ts)`; `'ingestion'`
   *  orders by Recued-discovery time via `ts` alone. Most consumers
   *  want event-time so a backfill recipe surfaces 3-year-old emails
   *  on the right historical date instead of phantom-recent. The
   *  Memory tab dual-axis UI lands in D-121. */
  axis?: import('./memory.js').TimelineAxis;
  /** D-161 P3 — actor-lane filter. When present, only entries whose
   *  `origin_actor` (the P1 write-actor stamp; memory derives it from
   *  `execution_source.actor`) is in this set surface. Outside-actor lanes
   *  (`contracted_user` / `anonymous`) are reached by naming them here —
   *  they are filtered, never dropped from the warehouse (I-7). Omitted →
   *  NO narrowing: full per-entity history, preserving the I-9 gold-path-
   *  unchanged default for callers that don't opt into a lane. Coerce
   *  untyped rpc input via `sanitizeTimelineOriginFilter`. */
  origin_actors?: ReadonlyArray<import('./commits.js').Actor>;
}

/** One row in the merged feed. Sorted DESC by `ts` across the whole
 *  page. `payload` shape varies by `source`:
 *
 *  - `mail`/`calendar`/`file`/`webhook`/`service` — `{ record_id,
 *    hot_fields, size_bytes }`. The full body lives in the source
 *    collection; the timeline carries the index summary.
 *  - `annotation` — `{ key, value, authored_by_recipe_id }`. The
 *    annotation row itself.
 *  - `link` — `{ role, direction: 'inbound'|'outbound', other_collection,
 *    other_id }`. D-119 typed cross-collection link from this entity's
 *    perspective.
 *  - `memory` — `{ run_id, recipe_id, commit_status, output_string?,
 *    duration_ms }`. One row per recipe-run touch, joined to the
 *    entity via the D-120 links table. `commit_status` is the D-153
 *    P1 lifecycle enum (replaces pre-D-153 boolean `success`).
 *  - `enrichment` (D-128 Phase 5) — `{ enrichment_id, topic, scope,
 *    target_id, value, meta?, ingredient_slug?, model_id?,
 *    staleness_class, authored_by }`. One `data_enrichment` row for
 *    the (scope, target_id) pair; `meta` is populated only on
 *    platform-reference scopes per D-128 §A.2. D-136 P2 renamed
 *    `model_used` → `ingredient_slug` and added `model_id`; the
 *    binary `stale` widened to `staleness_class`. */
export interface TimelineEntry {
  /** Epoch ms — when this event occurred. Newer first. */
  ts: number;
  source: TimelineSource;
  /** Source-specific event kind. Free string at the contract layer
   *  to keep new sub-kinds additive; consumers MAY narrow. */
  kind: string;
  /** Source-specific shape — see `TimelineEntry` JSDoc above. */
  payload: unknown;
  /** Set on `source === 'memory'` only — surrogate FK pointing at
   *  the `recipe_insights` row that captured the recipe shape at
   *  run time. Lets callers chase L3+ pattern queries without
   *  re-fetching the audit row. */
  recipe_insight_id?: number;
  /** Human-readable hint — `recipe_id` for memory + annotation +
   *  link entries, undefined for raw collection records. The slug
   *  isn't authoritative (callers should join via
   *  `recipe_insight_id`); it exists so an AI summarising the
   *  timeline can render "ran <slug>" without a second round-trip. */
  recipe_slug?: string;
  /** D-161 P3 — the entry's write-actor lane (the P1 `origin_actor` stamp;
   *  `'system'` when the source row carried none — engine-internal by
   *  construction, never an outside injection surface). Lets a Memory feed
   *  render / group by lane (agents = `contracted_user`, reception =
   *  `anonymous`) without re-reading the source. Additive + optional —
   *  gold-path consumers ignore it. */
  origin_actor?: import('./commits.js').Actor;
  /** D-161 P4 — provenance-honesty attribution. Present ONLY on an
   *  outside-actor entry (`contracted_user` → "agent X, under contract Y,
   *  asserted this"; `anonymous` → "visitor-derived"); a derived descriptor
   *  rendered at read time from this entry's origin facet plus — for
   *  `memory` entries — the audit row's `execution_source` (the agent id)
   *  and `contract_snapshot` (the contract version). NOT a stored column
   *  (O-3). Absent on the gold path (`user_self` / `system`): a first-
   *  person entry carries no attribution and renders as the user's own
   *  knowledge, exactly as today (I-9 / I-10). */
  attribution?: import('./provenance-attribution.js').ProvenanceAttribution;
}

/** Outbound shape for `recued_dataTimeline`. `next_cursor` is
 *  present iff the merge identified at least one entry strictly
 *  beyond the page boundary — callers should keep paginating until
 *  it goes undefined. */
export interface TimelineResponse {
  entries: TimelineEntry[];
  next_cursor?: string;
}

/** D-174 #22 — the Data warehouse-explorer mirror kinds a keyword search
 *  can resolve a NAME → a `data.timeline` entity_id over. Matches the
 *  webclient `MirrorDataKind`. `'files'` (the UI label) maps to the
 *  `'file'` warehouse platform server-side. `'crm'` has NO local
 *  searchable record store — it is the D-130 read alias over remote
 *  `connection.api.<vendor>.<entity>` enrichments — so a crm search
 *  resolves to an empty result rather than an error. */
export type MirrorSearchKind = 'mail' | 'calendar' | 'crm' | 'files';

export const MIRROR_SEARCH_KINDS: readonly MirrorSearchKind[] = [
  'mail',
  'calendar',
  'crm',
  'files',
];

export const isMirrorSearchKind = (value: unknown): value is MirrorSearchKind =>
  typeof value === 'string'
  && (MIRROR_SEARCH_KINDS as readonly string[]).includes(value);

/** Inbound for `data.mirror.search`: a free-text keyword query over ONE
 *  mirror kind, fanned out server-side across every `(platform, slug)`
 *  collection of that kind (e.g. all mail accounts). The query is
 *  free-text — the server sanitizes it for FTS5. */
export interface MirrorSearchRequest {
  kind: MirrorSearchKind;
  query: string;
  /** Hard cap on returned results. Server clamps to its own ceiling. */
  limit?: number;
}

/** One mirror-search hit. `entity_id` is the resolvable
 *  `<collection>:<record_id>` form ready to hand to `data.timeline`
 *  (note the warehouse `record_id` already self-prefixes, so e.g. a mail
 *  hit is `mail:mail:<hash>`). `label` is the human name (subject /
 *  event title / file name); `sublabel` disambiguates (sender / start
 *  time / path) — important because a fan-out can surface same-named
 *  records across accounts. */
export interface MirrorSearchResult {
  entity_id: string;
  label: string;
  sublabel?: string;
}

export interface MirrorSearchResponse {
  results: MirrorSearchResult[];
}

/** Parse the MCP-facing `<collection>:<id>` entity_id format.
 *  Returns null when the format is malformed (no colon, empty
 *  collection, empty id). Splits on the FIRST colon — the id portion
 *  may itself contain colons (RFC-822 message-ids).
 *
 *  D-128 — `<collection>` may be a four-segment platform-reference
 *  scope (`connection.api.<vendor>.<entity>`). The dotted shape lives
 *  entirely on the left side of the first colon, so the existing
 *  split-on-first-colon contract already accommodates it without a
 *  shape change.
 *
 *  Examples:
 *    parseTimelineEntityId('mail:msg-abc123')
 *      → { collection: 'mail', id: 'msg-abc123' }
 *    parseTimelineEntityId('mail:<abc@example.com>')
 *      → { collection: 'mail', id: '<abc@example.com>' }
 *    parseTimelineEntityId('connection.api.hubspot.deal:hubspot_deal_47291')
 *      → { collection: 'connection.api.hubspot.deal', id: 'hubspot_deal_47291' }
 *    parseTimelineEntityId('msg-abc123')      → null
 *    parseTimelineEntityId(':msg-abc')         → null
 *    parseTimelineEntityId('mail:')            → null */
export const parseTimelineEntityId = (
  entity_id: string,
): { collection: string; id: string } | null => {
  if (typeof entity_id !== 'string') return null;
  const idx = entity_id.indexOf(':');
  if (idx <= 0) return null;
  if (idx === entity_id.length - 1) return null;
  return { collection: entity_id.slice(0, idx), id: entity_id.slice(idx + 1) };
};

/** Format a `(collection, id)` pair as the MCP-facing entity_id.
 *  Inverse of `parseTimelineEntityId`. */
export const formatTimelineEntityId = (
  collection: string,
  id: string,
): string => `${collection}:${id}`;

/** Decoded cursor shape — the timeline impl uses this internally
 *  to resume; callers see only the opaque base64 envelope returned
 *  on the wire. Persisted as JSON inside the `encodeTimelineCursor`
 *  output. */
export interface TimelineCursor {
  /** `ts` of the LAST entry on the previous page. The next page
   *  contains entries with `ts < last_ts`, plus any entries with
   *  `ts === last_ts` whose tiebreaker key is strictly less than
   *  `last_key`. */
  last_ts: number;
  /** Stable per-entry tiebreaker — `<source>:<kind>:<id>`. Keeps
   *  the page boundary deterministic when multiple entries share
   *  a `ts`. */
  last_key: string;
}

/** Schema-version sentinel embedded in the cursor envelope. Bumping
 *  this lets a future cursor format reject old tokens at decode
 *  time. */
const CURSOR_VERSION = 'v1';

/** Wire-format cross-platform base64 encoder. `btoa` is available in
 *  every modern browser + Node.js (since 16); no Node `Buffer`
 *  required. UTF-8 safe via `encodeURIComponent` round-trip — same
 *  pattern as `bundle.ts`. */
const toBase64Url = (s: string): string => {
  // Map each byte of the UTF-8 encoding to a Latin-1 char so `btoa`
  // sees only single-byte code points.
  const utf8 = encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (_m, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  return btoa(utf8)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/** Inverse of `toBase64Url`. Returns `null` when the input is not
 *  valid base64-url so callers can short-circuit on malformed
 *  cursors without try/catch. */
const fromBase64Url = (s: string): string | null => {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized + '='.repeat(padding);
  let raw: string;
  try {
    raw = atob(padded);
  } catch {
    return null;
  }
  // Reverse the Latin-1 round-trip from `toBase64Url`.
  const utf8 = raw
    .split('')
    .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  try {
    return decodeURIComponent(utf8);
  } catch {
    return null;
  }
};

/** Encode a decoded cursor as the opaque wire token. Round-trips
 *  through `decodeTimelineCursor`. */
export const encodeTimelineCursor = (cursor: TimelineCursor): string =>
  toBase64Url(
    JSON.stringify({
      v: CURSOR_VERSION,
      last_ts: cursor.last_ts,
      last_key: cursor.last_key,
    }),
  );

/** Decode the opaque wire token. Returns `null` on malformed input,
 *  unknown version, or shape mismatch — callers should treat null
 *  as "ignore the cursor and serve from the head". Never throws. */
export const decodeTimelineCursor = (
  raw: string,
): TimelineCursor | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const json = fromBase64Url(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== CURSOR_VERSION) return null;
  if (typeof obj.last_ts !== 'number' || !Number.isFinite(obj.last_ts)) {
    return null;
  }
  if (typeof obj.last_key !== 'string') return null;
  return { last_ts: obj.last_ts, last_key: obj.last_key };
};

/** Build the per-entry tiebreaker key. Composed from
 *  `(source, kind, payload-derived id)` — same field set the timeline
 *  impl uses to sort entries with the same `ts`. Exposed so callers
 *  that build cursors out-of-band (test harnesses, debug tooling)
 *  stay aligned with the production sort. */
export const timelineEntryKey = (
  source: TimelineSource,
  kind: string,
  id: string,
): string => `${source}:${kind}:${id}`;

/** Clamp a caller-supplied `limit` against the contract's bounds.
 *  Negative / zero / NaN / undefined falls back to the default;
 *  values above the ceiling clamp down. Pure helper — exported so
 *  the timeline impl + tests share one source of truth. */
export const clampTimelineLimit = (limit: number | undefined): number => {
  if (limit === undefined) return TIMELINE_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return TIMELINE_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), TIMELINE_MAX_LIMIT);
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.13 P7.D — MCP consumer surface (swarm-agent affordances)
// ────────────────────────────────────────────────────────────────

/** §A.13.2 P7.D — bistemporal-metadata bundle returned on every MCP
 *  enrichment read. Shape is stable across `mcp.enrichment.read`
 *  result rows + `mcp.vector.similarity_search` per-result `metadata`.
 *  The bundle is what makes citations real — agents quoting an
 *  enrichment value can attach the full provenance package without
 *  fabricating fields.
 *
 *  Field meanings mirror the storage `EnrichmentRecord` shape:
 *    - `value` / `_id` / `topic` / `scope` / `target_id` are the
 *      identity tuple (Shape A — `scope` + `target_id`; Shape B —
 *      `scope` and `target_id` are null and `_id` is the
 *      derived-entity id).
 *    - `event_at` is the underlying real-world event time (mail Date,
 *      calendar start, file mtime). NULL on rows pre-D-120 P7.5 or
 *      producers that don't stamp event time.
 *    - `as_of` is the snapshot timestamp the producer captured
 *      (`time_bound` / `aggregate_window` topics). NULL on
 *      `stable_truth` topics by definition.
 *    - `ingested_at` is the warehouse write time; `computed_at` is
 *      the producer's compute time (today derived from `authored_at`
 *      until P3 retrofit threads `last_evaluated_at` correctly —
 *      the bundle exposes the field name the spec promises).
 *    - `source_record_hash` / `producer_version_hash` are the dedup
 *      hashes; either may be NULL on legacy rows.
 *    - `staleness_class` is the three-state freshness flag (default
 *      `'fresh'` at insert; cascade flips to `'stale'` / `'expired'`).
 *    - `staleness_reason` is the explanation when the row is not
 *      fresh — surfaces to agents reasoning about trustworthiness.
 *    - `confidence` is populated only on D-133 emits_confidence
 *      topics; `drift_severity` only when the topic is participating
 *      in PSI drift detection.
 *    - `user_pinned` is true iff the row was authored via P7.A's
 *      `vote.write` correction path (`authored_by` matches
 *      `ENRICHMENT_PINNED_AUTHOR_PREFIX`).
 *
 *  P7.E will gate per-row exposure on the topic's `mcp_exposed`
 *  annotation; P7.F will widen the result envelope with
 *  `freshness_budget_ms` + `fall_through_hint`. P7.D ships the bundle
 *  shape so those phases layer additively. */
export interface MCPEnrichmentReadResult {
  value: unknown;
  _id: string;
  topic: string;
  /** Shape A scope; null for shape-B (derived-entity) rows. */
  scope: string | null;
  /** Shape A target_id; null for shape-B (derived-entity) rows. */
  target_id: string | null;
  /** Real-world event time. Null pre-D-120 P7.5 + on rows whose
   *  producer doesn't stamp event_at. */
  event_at: number | null;
  /** Snapshot timestamp captured by the producer. Null on
   *  stable_truth topics. */
  as_of: number | null;
  ingested_at: number;
  /** Producer compute time. P3 retrofit threads `last_evaluated_at`;
   *  the bundle uses that when populated, falling back to
   *  `authored_at` for legacy rows. */
  computed_at: number;
  source_record_hash: string | null;
  producer_version_hash: string | null;
  staleness_class: 'fresh' | 'stale' | 'expired';
  /** Why staleness_class is what it is — surfaces to agents reasoning
   *  about trustworthiness. Closed list per spec; producer hooks fill
   *  the field as cascade engines tag rows. */
  staleness_reason?:
    | 'cadence_due'
    | 'cascade_pending'
    | 'producer_failed'
    | 'trust_gated'
    | 'vote_pending';
  /** D-133 — only populated on emits_confidence topics. */
  confidence?: number;
  /** D-133 — only populated when PSI drift detection observed the row's
   *  source topic. Surfaces from the substrate-internal drift signal. */
  drift_severity?: 'none' | 'moderate' | 'significant';
  /** True when authored_by carries the `system.user_correction`
   *  prefix (P7.A pinned-row path). */
  user_pinned?: boolean;
}

/** §A.13.3 P7.D — input shape for `mcp.enrichment.read`.
 *
 *  Three orthogonal time-axis filters layer on top of the identity
 *  triple (`topic` + `scope` + `target_id` for Shape A; `topic` +
 *  `derived_entity_id` for Shape B):
 *    - `as_of` — point-in-time read. Resolves through P7.C's
 *      `getRowAsOf` so the chain row whose `[event_at,
 *      superseded_event_at)` interval covers `as_of` surfaces.
 *      Returns `result: null` when no row covers the timestamp.
 *    - `coherent_at` — multi-topic coherent read (spec promises
 *      this is "the load-bearing one for swarm-agent multi-step
 *      plans"). With it, the substrate guarantees the returned row's
 *      `computed_at <= coherent_at`. P7.D ships the single-topic
 *      contract via `getRowAsOf` semantics; cross-topic fan-out
 *      comes via the future `mcp.coherent.read` rpc when consumers
 *      need it.
 *    - `include_historical` — return the full supersede chain
 *      (DESC by effective time, head first) instead of one row.
 *      Composes with `as_of` (chain truncated at `as_of`) but not
 *      with `coherent_at` (cross-topic walks don't make sense over
 *      a chain). Mutually exclusive with `coherent_at`.
 *
 *  `include_stale` widens the gate — by default both stale + expired
 *  rows surface alongside fresh (matching P7.C's resolver flip on
 *  recipe reads). Pass `include_stale: false` to narrow to fresh-only
 *  when an agent needs the strictest projection.
 *
 *  P7.F adds `freshness_budget_ms` — when present, the substrate
 *  short-circuits with a `fall_through_hint` instead of throwing on
 *  private topics or returning a bare `null` on missing / over-budget
 *  rows. The agent declares "I'd rather be told to fall through to raw
 *  than receive a stale value"; the substrate dispatches the staleness
 *  measure by the topic's `temporal_class` (stable_truth → computed_at;
 *  time_bound → as_of; aggregate_window → as_of + window_drift axis
 *  when `recompute_cadence` exceeded). P7.E gates on `mcp_exposed`. */
export interface EnrichmentReadRpcInput {
  topic: string;
  /** Shape A — `scope` + `target_id`. */
  scope?: string;
  target_id?: string;
  /** Shape B — `derived_entity_id`. */
  derived_entity_id?: string;
  /** Optional author narrowing for shape-A multi-author chains. */
  authored_by?: string;
  /** Walk supersede chain to find the row whose `[event_at,
   *  superseded_event_at)` covers this timestamp. Mutually exclusive
   *  with `coherent_at`. */
  as_of?: number;
  /** Returned row must have `computed_at <= coherent_at`. P7.D ships
   *  the single-topic contract; multi-topic fan-out lands later. */
  coherent_at?: number;
  /** Return the full supersede chain ordered by effective time DESC.
   *  Mutually exclusive with `coherent_at`. */
  include_historical?: boolean;
  /** Default `true` (matches P7.C resolver default). Set `false` to
   *  narrow to fresh-only rows. */
  include_stale?: boolean;
  /** D-136 §A.14.5 — agent-declared maximum acceptable staleness, in
   *  milliseconds. Substrate dispatches the staleness axis by the
   *  topic's `temporal_class` (stable_truth → `computed_at`;
   *  time_bound → `as_of`; aggregate_window → `as_of` + `window_drift`
   *  when `recompute_cadence` exceeded). When the resolved row is over
   *  budget — OR no row exists — the response carries
   *  `result: null` plus a `fall_through_hint` describing where to read
   *  raw instead of the warehouse value. Setting this opts into
   *  graceful degradation: private-topic reads (which would normally
   *  throw at the rpc boundary per §A.13.5) also fall through with
   *  `reason: 'topic_private'` so out-of-band agent plans stay
   *  composable. Omit the field to use the default behavior (no
   *  fall-through hint; private throws; stale is permitted). */
  freshness_budget_ms?: number;
}

/** §A.13.3 / §A.14.5 — `mcp.enrichment.read` response envelope. P7.D
 *  shipped the base shape; P7.F widens with
 *  `fall_through_hint?: { reason, suggested_raw_adapter,
 *  suggested_filter, staleness_axis? }` populated when
 *  `freshness_budget_ms` was passed AND the warehouse can't satisfy
 *  the read within budget. The envelope-as-record stays additive so
 *  later phases can layer on without a contract bump. */
export interface EnrichmentReadRpcOutput {
  /** The row. `null` when no row matches (for `include_historical`
   *  the chain itself is on `chain` instead). */
  result: MCPEnrichmentReadResult | null;
  /** Set when `include_historical` was true. Always sorted DESC by
   *  effective time (head first → oldest ancestor last). Tombstoned
   *  rows surface with `value: null` per the bundle's `value: unknown`
   *  shape — consumers gate on `staleness_class === 'expired'` +
   *  null-checking value. */
  chain?: ReadonlyArray<MCPEnrichmentReadResult>;
  /** D-136 §A.14.5 — populated only when `freshness_budget_ms` was
   *  supplied AND the warehouse can't satisfy the read within budget
   *  (no row exists, the row is staler than the budget, or the topic
   *  is private). The agent reads `result: null` + this hint and
   *  dispatches to the suggested raw adapter. Always co-occurs with
   *  `result: null` — when the substrate can satisfy the read in
   *  budget, this field is absent and the row surfaces normally. */
  fall_through_hint?: EnrichmentReadFallThroughHint;
}

/** §A.14.5 P7.F — fall-through hint shape. The closed-list `reason`
 *  discriminates the path the agent should take; `suggested_raw_adapter`
 *  + `suggested_filter` give the agent enough to fan out to raw without
 *  reasoning about adapter naming conventions. `staleness_axis` is
 *  populated when the rejection was on staleness — surfaces which axis
 *  triggered (computed_at / as_of / window_drift) so the agent can
 *  reason about whether the staleness is recoverable via re-fetch
 *  (window_drift = re-fold) vs underlying-source-changed (event time
 *  via raw). */
export interface EnrichmentReadFallThroughHint {
  /** Discriminator. `'no_row'` — the warehouse doesn't carry a row
   *  for this identity. `'freshness_budget_exceeded'` — the row is
   *  older than the agent's declared budget on the topic's dispatched
   *  staleness axis. `'topic_private'` — the topic is declared
   *  `mcp_exposed: 'private'` and the agent passed `freshness_budget_ms`
   *  (without the budget, this case throws at the rpc boundary per
   *  §A.13.5). */
  reason: 'no_row' | 'freshness_budget_exceeded' | 'topic_private';
  /** Which staleness axis triggered the rejection — populated only
   *  when `reason === 'freshness_budget_exceeded'`. The substrate
   *  picks per topic's `temporal_class`:
   *    - stable_truth → `'computed_at'`
   *    - time_bound → `'as_of'`
   *    - aggregate_window → `'as_of'`, OR `'window_drift'` when the
   *      `recompute_cadence` was also exceeded
   *  Agents reasoning about whether the staleness is recoverable use
   *  this to decide the raw fallback shape. */
  staleness_axis?: 'computed_at' | 'as_of' | 'window_drift';
  /** Substrate-suggested adapter name for the raw fall-through path.
   *  Per-scope mapping per spec example — `'mail.search'`,
   *  `'calendar.list'`, `'contact.list'`, `'file.list'`,
   *  `'connection.api.<vendor>.<entity>.fetch'` for platform-reference
   *  topics, `'enrichment.list'` for derived-entity topics whose
   *  warehouse path is the only fall-through (no raw analogue). */
  suggested_raw_adapter: string;
  /** Substrate-suggested filter shape the agent passes to the
   *  adapter. Fields vary by scope: `since` for time-anchored raw
   *  adapters, `id`/`email`/`path`/`event_id` for identity-scoped
   *  reads, `topic` + identity for the derived-entity fall-through. */
  suggested_filter: Record<string, unknown>;
}

/** §A.13.1 P7.D — per-topic entry in `housekeeping.registry.describe`.
 *  Surfaces every field a consuming swarm agent needs to plan its
 *  reads + reason about trust:
 *    - `topic` / `temporal_class` / `identity_aggregation` /
 *      `lifecycle_policy` / `valid_scopes` / `aggregate_window_ms` /
 *      `aggregate_window_axis` from the registry definition.
 *    - `description` is the author-declared description.
 *    - `coverage` is computed at rpc-call time from the warehouse
 *      state (no caching — the response is small and queried infrequently).
 *    - `compression_class` (D-136 §A.14.2) + `prompt_bias_hints`
 *      (§A.14.3) bubble through unchanged from the registry.
 *
 *  P7.E adds `mcp_exposed` per-topic + filters private topics from
 *  the response array; P7.F adds `coverage_quality` derivation. P7.D
 *  shipped the base shape so those phases extend additively without a
 *  contract bump. P7.E narrows the `mcp_exposed` slot to the closed
 *  list `'public' | 'private'`; the response always carries
 *  `'public'` (private topics are filtered out before serialization,
 *  so an agent never receives `'private'` for any topic in the
 *  array — but the field name + the filter are part of the contract). */
export interface RegistryDescribeTopicEntry {
  topic: string;
  temporal_class: 'stable_truth' | 'time_bound' | 'aggregate_window';
  identity_aggregation: 'scenario' | 'perspective';
  lifecycle_policy: 'forward_only' | 'recompute_on_drift' | 'ttl' | 'historical';
  valid_scopes: ReadonlyArray<string>;
  /** D-136 §A.10 — signal aperture. Set on aggregate_window topics. */
  aggregate_window_ms?: number;
  /** D-136 §A.10 — clock anchoring the trailing window. Set on
   *  aggregate_window topics. */
  aggregate_window_axis?: 'event_time' | 'ingestion_time';
  /** D-136 §A.14.2 — author-declared compression class (advisory). */
  compression_class: 'lossless' | 'lossy' | 'derived';
  /** D-136 §A.14.3 — open-vocabulary prompt-bias indicators
   *  (advisory). Empty array on non-AI-surface or topics without
   *  declared bias hints. */
  prompt_bias_hints: ReadonlyArray<string>;
  /** Author-declared description. Mirrors `EnrichmentDefinition.description`. */
  description: string;
  /** True iff the topic is AI-surface — declared via
   *  `default_trust_state: 'manual'` or producer_kind: 'reactive' that
   *  routes through `runAIProducer`. Derived from registry shape; agents
   *  use this to apply skeptical priors. */
  ai_surface: boolean;
  /** D-136 §A.13.5 — author-declared MCP read-exposure policy.
   *  `'private'` topics are filtered out of the response array entirely
   *  (the agent never sees them), so this field is always `'public'`
   *  for entries that DO appear. Surfaced for forward-compat / test-
   *  ratchet coverage; consumers can ignore it under today's spec. */
  mcp_exposed: 'public' | 'private';
  coverage: {
    row_count: number;
    /** Latest `COALESCE(event_at, ingested_at)` across all rows for
     *  the topic. Null when `row_count === 0`. */
    latest_event_at: number | null;
    /** Latest housekeeping-cycle `last_run_at` for the producer task
     *  driving this topic. Null when the task has never run (or for
     *  reactive producers — they don't run on cycles). */
    producer_last_run_at: number | null;
    /** 24-hour rolling failure rate `[0, 1]` for the producer task.
     *  `0` when the task has run successfully; `1` when every recent
     *  attempt failed; computed from `last_status` + `consecutive_errors`
     *  on the `housekeeping_state` row. Derived heuristically until P6's
     *  per-row failure_attempt_count threading lands a precise count. */
    producer_failure_rate_24h: number;
    ai_surface: boolean;
  };
  /** D-136 §A.14.4 — derived quality band. Closed list — agents
   *  pre-flight a query against the warehouse by reading this and
   *  decide whether to fall through to raw. `'high'` = trust the
   *  warehouse; `'low'` / `'novel_query_likely_uncovered'` = go direct
   *  to raw. Computed at rpc-call time from `coverage` + the topic's
   *  `recompute_cadence` + `coverage_quality_threshold`; not stored. */
  coverage_quality: 'high' | 'medium' | 'low' | 'novel_query_likely_uncovered';
  /** D-136 §A.14.4 — human-readable reasoning string explaining the
   *  band derivation (e.g. "5K+ rows, latest event 2h ago, producer
   *  success rate 98% over 24h"). Surfaces in agent reasoning prompts
   *  + Settings UI. Not machine-parseable; the structured `coverage`
   *  fields remain authoritative. */
  coverage_quality_reasoning: string;
}

/** §A.13.1 P7.D — output shape for `housekeeping.registry.describe`. */
export interface RegistryDescribeRpcOutput {
  topics: ReadonlyArray<RegistryDescribeTopicEntry>;
  /** Total enrichment row count visible to this MCP session.
   *  Substrate-private rows (P7.A pinned authors prefixed with
   *  `system.user_correction`, vote-table contents) are always
   *  excluded; P7.E adds the topic-level `mcp_exposed: 'private'`
   *  filter on top. */
  total_rows_visible: number;
  /** D-135 dish catalog pointer for cross-topic composition (when
   *  implemented). Always undefined at D-136. */
  dish_catalog_url?: string;
}

/** §A.13.4 P7.D — input shape for `mcp.vector.similarity_search`.
 *
 *  Cohort enforcement (`model_id`) is mandatory in spirit: cross-model
 *  vectors aren't comparable. P7.D ships the parameter optional but
 *  the handler scans only the rows whose `model_id` matches when set.
 *  When omitted, the handler scans across all rows for the topic — fine
 *  for single-model deployments today; the spec promises tightening
 *  to mandatory + auto-pick the dominant cohort in a future hardening
 *  pass once mixed-model warehouses appear. */
export interface VectorSimilaritySearchRpcInput {
  query_vector: number[];
  topic: string;
  /** Bounded by `housekeeping_config.vector_search_max_results`
   *  (default 50). Caller-supplied values above the ceiling clamp
   *  down. */
  limit: number;
  /** Optional scope filter for narrowing (e.g., specific mail
   *  account). */
  scope_filter?: string;
  /** Same-cohort guarantee: only return vectors from the same model.
   *  Strongly recommended; see contract JSDoc above. */
  model_id?: string;
  /** Cosine similarity floor for results. Default 0.5. */
  similarity_threshold?: number;
}

export interface VectorSimilaritySearchRpcOutput {
  results: ReadonlyArray<{
    enrichment_row_id: string;
    target_id: string;
    similarity: number;
    /** Full bistemporal metadata bundle per A.13.2. */
    metadata: MCPEnrichmentReadResult;
  }>;
  /** Total candidates considered before threshold filter. Lets agents
   *  reason about whether their threshold pruned aggressively. */
  candidates_examined: number;
}

/** §A.13.6 P7.D — structured budget-exceeded response shape returned
 *  from token-spending MCP-triggered actions when the action would
 *  push estimated cost over remaining daily budget.
 *
 *  P7.D defines the shape; the actions that throw it are P7.B's
 *  `housekeeping.topic.reset`, P7.A's `vote.write` (when vote causes
 *  recompute), and the future P7.F fall-through-triggered AI path. The
 *  shape is centralised here so every emitter / consumer keys off one
 *  contract. Agents reading this know to either (a) wait for
 *  `budget_resets_at`, (b) prompt the user via `user_override_path`,
 *  or (c) drop the action. */
export interface MCPBudgetExceededError {
  error: 'daily_token_budget_exceeded';
  pool: 'free' | 'byok';
  budget_remaining_tokens: number;
  estimated_cost_tokens: number;
  /** Wall-clock epoch ms when the daily budget rolls over. Today
   *  midnight UTC; producers may surface a different anchor in the
   *  future. */
  budget_resets_at: number;
  /** Set when `housekeeping_config.pause_background_ai_until` is
   *  active + `now < pause_background_ai_until`. */
  pause_ai_until?: number;
  /** Settings deep-link the agent can prompt the user with —
   *  e.g., `'settings://housekeeping/topic-reset?token=...'` for
   *  explicit user-Run-Now-with-cost-acknowledgement. */
  user_override_path?: string;
}

/** Default cap on similarity-search `limit` when the caller omits a
 *  bounded value. Mirrors the spec's reference default; the runtime
 *  reads `housekeeping_config.vector_search_max_results` (when set)
 *  to override per-server. */
export const VECTOR_SEARCH_DEFAULT_LIMIT = 50;
export const VECTOR_SEARCH_MAX_LIMIT = 1000;

/** Default cosine similarity floor when the caller omits
 *  `similarity_threshold`. Below this, results are noise on most
 *  embedding models; surface only the meaningful neighbours. */
export const VECTOR_SEARCH_DEFAULT_THRESHOLD = 0.5;

/** Clamp helper for `mcp.vector.similarity_search.limit`. Mirrors
 *  `clampTimelineLimit`'s shape so the two share a debug story. */
export const clampVectorSearchLimit = (
  limit: number | undefined,
  max?: number,
): number => {
  const ceiling = max && Number.isFinite(max) && max > 0
    ? Math.min(Math.floor(max), VECTOR_SEARCH_MAX_LIMIT)
    : VECTOR_SEARCH_DEFAULT_LIMIT;
  if (limit === undefined) return ceiling;
  if (!Number.isFinite(limit) || limit <= 0) return ceiling;
  return Math.min(Math.floor(limit), ceiling);
};
