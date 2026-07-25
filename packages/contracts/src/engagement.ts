/** D-139 P1a.1 — `EngagementRow` + `EngagementEdge` schemas.
 *
 *  Per spec § A.3 + § A.4. These are the substrate's canonical row
 *  shapes — every engagement (HubSpot email at P1a.1; HubSpot meeting/
 *  note/call/task at P1a.2; Salesforce SObjects at P1b) lands in this
 *  shape; every engagement→contact / deal / account / mail-twin /
 *  calendar-twin association lands as one `EngagementEdge` row.
 *
 *  Composite primary key `(connection_id, target_id)` per Pass-3 R3.2:
 *  HubSpot platform-native ids are unique within a portal but not
 *  globally — two HubSpot connections can both carry email-id `47291`.
 *  Edge UNIQUE composite is `(connection_id, engagement_target_id,
 *  edge_type, target_id)` — many-to-many supported by construction.
 *
 *  Spec: D-139 § A.3, § A.4, § A.5.1, § A.9.5. */

import type {
  AttachmentMeta,
  Authorship,
  BodyState,
  CoverageMetadata,
  DedupeAcceptance,
  DedupeConfidence,
  DedupeMatchKey,
  Direction,
  EngagementEdgeType,
  EngagementVendor,
  EngagementLifecycleState,
} from './engagement-evidence.js';

// ────────────────────────────────────────────────────────────────
// Row shape (§ A.3)
// ────────────────────────────────────────────────────────────────

/** D-139 P1a.1 — engagement-row provenance for tombstoned rows. */
export interface EngagementDeletionProvenance {
  actor: string;
  vendor_event_id: string;
}

/** Persisted engagement row. The composite primary key
 *  `(connection_id, target_id)` namespaces vendor-native ids across
 *  multiple connections of the same vendor.
 *
 *  P1a.1 lands the full Pass-4 evidence-quality contract surface — the
 *  remaining four HubSpot entities (P1a.2) + Salesforce SObjects
 *  (P1b) just populate the same fields. */
export interface EngagementRow {
  // ── D-128 base + connection isolation (Pass-3 R3.2) ──────────
  connection_id: string;
  target_id: string;
  vendor: EngagementVendor;
  /** Vendor-segment of the platform-reference entity name —
   *  `'email'` / `'meeting'` / `'note'` / `'call'` / `'task'` for
   *  HubSpot; `'task'` / `'event'` / `'email_message'` /
   *  `'voice_call'` / `'call_history'` for Salesforce. */
  entity: string;
  /** ≤ 8 KB canonical snapshot — per-vendor projector. Same shape
   *  D-128 ships for deal / contact / company / account meta. */
  meta: Record<string, unknown>;
  /** Forward-compat slot per D-128. Always-NULL at D-139 v1. */
  mirror_blob_hash: string | null;

  // ── Evidence-quality contracts (Pass-4 reframe) ──────────────
  authorship: Authorship;
  direction: Direction;
  dedupe_confidence: DedupeConfidence;
  lifecycle_state: EngagementLifecycleState;
  /** Metadata-only attachment list per § A.3.4. Optional — many
   *  engagements have no attachments. */
  attachments?: ReadonlyArray<AttachmentMeta>;

  // ── Bistemporal time fields (Pass-3 R3.3 + Pass-4 R4.6) ──────
  /** When the touch HAPPENED — unix-ms UTC. NULL for not-yet-
   *  occurred touches (pending tasks before completion; scheduled
   *  meetings before start). Sort key for engagement analytics. */
  event_at: number | null;
  /** IANA timezone identifier from vendor when available
   *  (e.g. `'America/New_York'`). For date-only fields like task
   *  due dates, the local-day interval the vendor's date string
   *  referred to. */
  event_at_tz_hint?: string;
  /** D-139 P1a.1.2 — true when the substrate fell through every
   *  step of the § A.3.7 fallback chain (vendor → calendar adapter
   *  → `prefs.timezone` → UTC) and landed at the UTC sentinel.
   *  Producers populating `coverage.sources_degraded` use this
   *  flag to surface the `'tz_inferred'` reason — the spec calls
   *  this "interpolation flagging" because the canonical
   *  `event_at` is still UTC unix-ms but the wall-clock
   *  representation a producer renders is approximate. */
  event_at_tz_inferred?: boolean;
  /** Verbatim vendor timestamp string — ISO 8601 with offset for
   *  Salesforce; unix-ms-as-string for HubSpot. Preserves original
   *  format for forensic diff. STRIPPED from MCP responses by
   *  default per § A.9.5 (debug/forensic only). */
  vendor_raw_timestamp?: string;
  /** Task due date — unix-ms UTC. For date-only vendor fields this
   *  represents the START of the local-day interval (00:00 in
   *  `event_at_tz_hint`), with `due_at_is_date_only: true` flag. */
  due_at?: number;
  due_at_is_date_only?: boolean;
  /** Task completion — unix-ms UTC. Producers gate "completed
   *  engagement touch" on `completed_at IS NOT NULL`. */
  completed_at?: number;
  /** Meeting/event start — unix-ms UTC. `event_at = scheduled_start_at`
   *  when meeting is in the past; NULL while still upcoming. */
  scheduled_start_at?: number;
  /** When CRM logged it — unix-ms UTC. Always populated. */
  vendor_created_at: number;
  /** Cursor field for delta scan — unix-ms UTC. Always populated. */
  vendor_modified_at: number;
  /** Vendor-supplied opaque last-modified token (Pass-4 R4.7).
   *  HubSpot `hs_lastmodifieddate`; Salesforce `LastModifiedDate` +
   *  `SystemModstamp`. Substrate persists the most recent value seen
   *  + drops stale updates (incoming ≤ stored = drop without write). */
  vendor_modstamp?: string;
  /** When Recued ingested — unix-ms UTC. */
  ingested_at: number;

  // ── Body location state machine (§ A.3) ──────────────────────
  body_state: BodyState;
  /** Populated only when `body_state IN ('inline_body',
   *  'truncated_inline')`. STRIPPED from MCP responses by default
   *  per § A.9.5 — body-content visibility requires separate
   *  per-token grant via the `mcp_body_visibility` registry key. */
  body_inline?: string;
  /** Populated only when `body_state = 'truncated_inline'`. Byte
   *  count of full body. Visible in MCP responses (it's a count, not
   *  content). */
  body_truncation_offset?: number;

  // ── Deletion handling — tombstone, not hard-delete ──────────
  deleted_at?: number;
  deletion_provenance?: EngagementDeletionProvenance;
}

// ────────────────────────────────────────────────────────────────
// Edge shape (§ A.4)
// ────────────────────────────────────────────────────────────────

/** Engagement edge target-kind closed list. Same composite-key model
 *  as `EngagementRow` — `target_kind` namespaces the `target_id`
 *  segment. */
export const ENGAGEMENT_EDGE_TARGET_KIND_VALUES = [
  'data.contact',
  'connection.api',
  'data.mail',
  'data.calendar',
  'user',
] as const;
export type EngagementEdgeTargetKind =
  (typeof ENGAGEMENT_EDGE_TARGET_KIND_VALUES)[number];
const TARGET_KIND_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_EDGE_TARGET_KIND_VALUES,
);
export const isEngagementEdgeTargetKind = (
  raw: unknown,
): raw is EngagementEdgeTargetKind =>
  typeof raw === 'string' && TARGET_KIND_SET.has(raw);

/** D-139 P1a.1 — engagement edge row. Many-to-many supported by
 *  the composite UNIQUE on `(connection_id, engagement_target_id,
 *  edge_type, target_id)`. Tombstones (`deleted_at`) preserve history
 *  through CRM-side disassociation. */
export interface EngagementEdge {
  connection_id: string;
  engagement_target_id: string;
  edge_type: EngagementEdgeType;
  /** `'data.contact'` for contact edges (canonical email);
   *  `'connection.api'` for deal/account/owner edges (full
   *  platform-reference target_id like `hubspot_deal_47291`);
   *  `'data.mail'` / `'data.calendar'` for mail-twin / calendar-twin
   *  edges (mail / calendar adapter id). */
  target_kind: EngagementEdgeTargetKind;
  target_id: string;
  /** Source vendor — informational mirror of the parent engagement's
   *  vendor. Populated for debugging + connection-isolated queries. */
  vendor?: EngagementVendor;
  created_at: number;
  /** Tombstone — set when CRM-side disassociation is observed. Aggregates
   *  filter `deleted_at IS NULL`; timeline rendering surfaces
   *  "(removed on …)" markers. */
  deleted_at?: number;
}

// ────────────────────────────────────────────────────────────────
// Inbound-event ledger (§ A.3.8)
// ────────────────────────────────────────────────────────────────

/** Closed list of delivery paths the inbound-event ledger observes.
 *  Same idempotency-key namespace per `(connection_id, vendor)`
 *  regardless of path — a webhook delivery for the same
 *  `<eventId>-<subscriptionType>` arriving twice processes only
 *  once even if one arrival is via the reconciler-page path. D-184
 *  retired the `'runonce'` path (the reconciler-runonce stopgap is
 *  gone); engagement now arrives via webhook / cometd / the
 *  `'reconciler'` housekeeping cycle. */
export const ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES = [
  'webhook',
  'cometd',
  'reconciler',
] as const;
export type EngagementInboundDeliveryPath =
  (typeof ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES)[number];
const DELIVERY_PATH_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_INBOUND_DELIVERY_PATH_VALUES,
);
export const isEngagementInboundDeliveryPath = (
  raw: unknown,
): raw is EngagementInboundDeliveryPath =>
  typeof raw === 'string' && DELIVERY_PATH_SET.has(raw);

/** Inbound-event ledger row — server-internal substrate. Composite
 *  UNIQUE on `(connection_id, vendor, idempotency_key)`. D-123
 *  housekeeping compacts entries older than the replay window. */
export interface EngagementInboundEventLedgerRow {
  connection_id: string;
  vendor: EngagementVendor;
  /** Vendor-derived per-event unique id — derivation rules per
   *  § A.3.8 (HubSpot webhook: `<eventId>-<subscriptionType>`;
   *  HubSpot reconciler page: SHA256 of (target_id, modstamp,
   *  page_token); Salesforce CometD: `<channel>:<replayId>`;
   *  Salesforce reconciler page: SHA256 of (target_id, SystemModstamp,
   *  page_token)). */
  idempotency_key: string;
  /** Last-seen vendor modstamp at write time (informational).
   *  Engagement-row `vendor_modstamp` separately gates writes for
   *  stale-update drop. */
  vendor_modstamp?: string;
  delivery_path: EngagementInboundDeliveryPath;
  observed_at: number;
}

// ────────────────────────────────────────────────────────────────
// Dedupe candidates (§ A.3.5 — Pass-5 R5.6)
// ────────────────────────────────────────────────────────────────

/** Dedupe-candidate resolution state. `'pending'` → resolver surfaces
 *  the candidate as a possible-duplicate; `'confirmed_merge'` collapses
 *  the pair on next read; `'marked_distinct'` writes the pair into the
 *  rejection set so future re-detection skips. */
export const DEDUPE_RESOLUTION_STATE_VALUES = [
  'pending',
  'confirmed_merge',
  'marked_distinct',
] as const;
export type DedupeResolutionState =
  (typeof DEDUPE_RESOLUTION_STATE_VALUES)[number];

/** Dedupe-candidate row — server-internal table. The candidate-
 *  detection writer ensures both directional rows exist for a
 *  discovered match (source→candidate AND candidate→source); on user
 *  resolution the substrate writes both directions atomically. */
export interface EngagementDedupeCandidateRow {
  source_connection_id: string;
  source_target_id: string;
  candidate_connection_id: string;
  candidate_target_id: string;
  /** Match-key vocabulary — see `DEDUPE_MATCH_KEY_VALUES`. Forward-
   *  compat: any non-empty string is accepted at storage; closed list
   *  is the recommended vocabulary. */
  match_key: string;
  confidence: DedupeConfidence;
  resolution_state: DedupeResolutionState;
  detected_at: number;
  resolved_at?: number;
  /** Canonical email of user who resolved (or system actor for
   *  auto-resolved confirms). */
  resolved_by?: string;
}

/** Per-row dedupe-candidate projection — surfaces in
 *  `data.contact.engagements.list` resolver responses for rows with
 *  `dedupe_confidence: 'probable'` (or `'exact'` when multi-candidate
 *  collapse). Capped at `ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP`
 *  per row. */
export interface EngagementDedupeCandidateProjection {
  candidate_connection_id: string;
  candidate_target_id: string;
  match_key: string;
  confidence: DedupeConfidence;
}

// ────────────────────────────────────────────────────────────────
// Resolver contracts (§ A.5.1)
// ────────────────────────────────────────────────────────────────

/** D-139 § A.5.1 — `data.contact.<email>.engagements` resolver args. */
export interface EngagementsResolverArgs {
  /** Canonical email — `resolveContactIdentity` runs by construction;
   *  identity-expansion to member set per § A.5.0. Loser-email
   *  queries transparently return the survivor's full union. */
  email: string;
  /** Unix-ms `event_at` lower bound. Default
   *  `now() - ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS`. */
  since?: number;
  /** Unix-ms `event_at` upper bound. Default `now()`. */
  until?: number;
  /** Vendor filter — omit for union across every vendor hanging off
   *  the contact's `platform_ids`. */
  vendor?: EngagementVendor;
  /** Per-connection filter — paired with `vendor` typically. Recipes
   *  that need "engagements through MY portal but not THEIR portal"
   *  use this slot. */
  connection_id?: string;
  /** Authorship whitelist (optional) — e.g. `['user', 'crm_user']`
   *  excludes automation + system_process per § A.3.2 producer
   *  consumption defaults. */
  authorship?: ReadonlyArray<Authorship>;
  /** Direction whitelist (optional) — e.g. `['inbound', 'outbound']`
   *  excludes internal-only chatter per § A.3.3. */
  direction?: ReadonlyArray<Direction>;
  /** Lifecycle whitelist (optional). Default
   *  `DEFAULT_LIFECYCLE_EVIDENCE_STATES` (engagement evidence only —
   *  point_in_time + completed). Set to `['scheduled']` for
   *  upcoming-meeting briefs. */
  lifecycle_state?: ReadonlyArray<EngagementLifecycleState>;
  /** Override the default collapse-only-when-exact behavior. Default
   *  `'exact_only'` surfaces both rows of a probable pair as separate
   *  engagements with `dedupe_candidates: Array<...>` joined from
   *  `engagement_dedupe_candidates`. */
  dedupe_acceptance?: DedupeAcceptance;
  /** Default `ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE`; max
   *  `ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE`. */
  page_size?: number;
  /** Opaque cursor — encodes `(event_at_cursor,
   *  engagement_id_tiebreaker, connection_id_tiebreaker)`. */
  cursor?: string;
  /** Default false; tombstones surface only when explicitly set. */
  include_deleted?: boolean;
}

/** Resolver response row — per-row dedupe-candidate projection
 *  joined; vendor_twins[] populated for `'exact'`-confidence
 *  collapse. */
export interface EngagementsResolverRow extends EngagementRow {
  /** Twin vendor target ids when `'exact'`-confidence collapse
   *  applied at resolver layer. Empty / omitted on rows without twin
   *  collapse. */
  vendor_twins?: ReadonlyArray<string>;
  /** D-184 Decision 2 — the matched `data.mail` record_id when this
   *  email engagement's RFC822 Message-ID joined a local mail row at
   *  read time (the CRM-email ↔ `data.mail` twin). Resolved LIVE in the
   *  resolver (not pre-bound at ingest) so add/remove-mailbox-later is
   *  correct by construction. When set, `body_state` is forced to
   *  `'mail_link'` and the CRM-side `body_inline` / `body_truncation_offset`
   *  are dropped from the projection — the local mail row holds the
   *  authoritative body. Distinct from `vendor_twins` (cross-CRM-vendor
   *  engagement twins); a mail row is not a vendor engagement id. */
  mail_twin_id?: string;
  /** Multi-candidate dedupe surface for `'probable'`-confidence
   *  twins (and oversized `'exact'` candidate sets). */
  dedupe_candidates?: ReadonlyArray<EngagementDedupeCandidateProjection>;
  /** True when `dedupe_candidates` was capped at the per-row limit. */
  dedupe_candidates_truncated?: boolean;
}

export interface EngagementsResolverResult {
  engagements: ReadonlyArray<EngagementsResolverRow>;
  /** Null when no more pages. */
  next_cursor?: string;
  coverage: CoverageMetadata;
}

// ────────────────────────────────────────────────────────────────
// MCP body-content projection rule (§ A.9.5)
// ────────────────────────────────────────────────────────────────

/** MCP-facing engagement projection. STRIPS `body_inline` +
 *  `vendor_raw_timestamp` from MCP responses by default regardless of
 *  the topic's MCP visibility flag. `body_truncation_offset` (a byte
 *  count, not content) IS exposed.
 *
 *  Body-content access requires a separate per-token grant via
 *  the `mcp_body_visibility` table with registry key
 *  `ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY`. The post-substrate-canary
 *  `crm-commitment-tracker` pack (P6.B) carries an implicit grant.
 *
 *  The MCP-catalog ratchet test asserts that no MCP-exposed engagement
 *  read path leaks `body_inline` or `vendor_raw_timestamp` without an
 *  explicit registry-recorded permission grant. */
export interface MCPEngagementRowProjection {
  connection_id: string;
  target_id: string;
  vendor: EngagementVendor;
  entity: string;
  meta: Record<string, unknown>;
  authorship: Authorship;
  direction: Direction;
  dedupe_confidence: DedupeConfidence;
  lifecycle_state: EngagementLifecycleState;
  attachments?: ReadonlyArray<AttachmentMeta>;
  event_at: number | null;
  event_at_tz_hint?: string;
  due_at?: number;
  due_at_is_date_only?: boolean;
  completed_at?: number;
  scheduled_start_at?: number;
  vendor_created_at: number;
  vendor_modified_at: number;
  ingested_at: number;
  body_state: BodyState;
  /** Visible — byte count, not content (Pass-5 R5.9). */
  body_truncation_offset?: number;
  vendor_twins?: ReadonlyArray<string>;
  /** D-184 Decision 2 — matched `data.mail` record_id for a live
   *  mail-twin (a record id, not body content — safe to expose). */
  mail_twin_id?: string;
  dedupe_candidates?: ReadonlyArray<EngagementDedupeCandidateProjection>;
  dedupe_candidates_truncated?: boolean;
  // ── STRIPPED by default ──────────────────────────────────────
  // body_inline + vendor_raw_timestamp omitted unless body-content
  // permission granted.
}

/** Project a stored engagement row to the MCP-facing shape. Strips
 *  `body_inline` + `vendor_raw_timestamp` by default. When
 *  `body_content_granted = true`, the projection inlines both fields
 *  alongside the MCP-default fields.
 *
 *  Accepts an `EngagementsResolverRow` (which is just an `EngagementRow`
 *  with optional resolver-added fields) so the resolver-layer
 *  `vendor_twins` / `mail_twin_id` / `dedupe_candidates` /
 *  `dedupe_candidates_truncated` project through when present. These are
 *  safe to expose: `mail_twin_id` is a local `data.mail` record id (not
 *  body content), `vendor_twins` are vendor engagement ids, and the
 *  dedupe-candidate projection carries only ids + match-key + confidence.
 *  A plain `EngagementRow` (no resolver fields) projects exactly as
 *  before.
 *
 *  Used by the MCP read path (the `recued_contactEngagementsList` tool,
 *  default-off per the per-token tool checklist). The internal
 *  `data.contact.engagements.list` WS-rpc surface returns the full
 *  `EngagementsResolverRow` shape (body included for the owner's own
 *  paired clients); only the MCP read projects through this rule. */
export const projectEngagementRowForMCP = (
  row: EngagementsResolverRow,
  options: { body_content_granted?: boolean } = {},
): MCPEngagementRowProjection & {
  body_inline?: string;
  vendor_raw_timestamp?: string;
} => {
  const projection: MCPEngagementRowProjection & {
    body_inline?: string;
    vendor_raw_timestamp?: string;
  } = {
    connection_id: row.connection_id,
    target_id: row.target_id,
    vendor: row.vendor,
    entity: row.entity,
    meta: row.meta,
    authorship: row.authorship,
    direction: row.direction,
    dedupe_confidence: row.dedupe_confidence,
    lifecycle_state: row.lifecycle_state,
    event_at: row.event_at,
    vendor_created_at: row.vendor_created_at,
    vendor_modified_at: row.vendor_modified_at,
    ingested_at: row.ingested_at,
    body_state: row.body_state,
  };
  if (row.attachments !== undefined) projection.attachments = row.attachments;
  if (row.event_at_tz_hint !== undefined)
    projection.event_at_tz_hint = row.event_at_tz_hint;
  if (row.due_at !== undefined) projection.due_at = row.due_at;
  if (row.due_at_is_date_only !== undefined)
    projection.due_at_is_date_only = row.due_at_is_date_only;
  if (row.completed_at !== undefined) projection.completed_at = row.completed_at;
  if (row.scheduled_start_at !== undefined)
    projection.scheduled_start_at = row.scheduled_start_at;
  if (row.body_truncation_offset !== undefined)
    projection.body_truncation_offset = row.body_truncation_offset;
  // Resolver-layer fields (absent on a plain EngagementRow). Safe to
  // expose to MCP — ids + match metadata, never body content.
  if (row.vendor_twins !== undefined) projection.vendor_twins = row.vendor_twins;
  if (row.mail_twin_id !== undefined) projection.mail_twin_id = row.mail_twin_id;
  if (row.dedupe_candidates !== undefined)
    projection.dedupe_candidates = row.dedupe_candidates;
  if (row.dedupe_candidates_truncated !== undefined)
    projection.dedupe_candidates_truncated = row.dedupe_candidates_truncated;
  if (options.body_content_granted === true) {
    if (row.body_inline !== undefined) projection.body_inline = row.body_inline;
    if (row.vendor_raw_timestamp !== undefined)
      projection.vendor_raw_timestamp = row.vendor_raw_timestamp;
  }
  return projection;
};

// ────────────────────────────────────────────────────────────────
// Cursor encoding for pagination (§ A.5.1)
// ────────────────────────────────────────────────────────────────

/** Stable cursor — encodes `(event_at_cursor,
 *  engagement_id_tiebreaker, connection_id_tiebreaker)`. New ingests
 *  don't shift earlier pages; the sort key is immutable per row
 *  except via tombstone. */
export interface EngagementsResolverCursor {
  /** Unix-ms `event_at` of the last row in the previous page. NULL
   *  on the first page (caller passes no cursor). */
  event_at: number | null;
  engagement_id: string;
  connection_id: string;
}

/** Encode the cursor as a URL-safe base64 JSON blob. Opaque to
 *  callers; the resolver decodes on the next read. */
export const encodeEngagementsCursor = (
  cursor: EngagementsResolverCursor,
): string => {
  const json = JSON.stringify(cursor);
  // Use Buffer when present (Node), else atob/btoa (browser harness).
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64url');
  }
  // Browser fallback — base64url-encode via btoa with manual
  // url-safe substitution.
  const b64 = globalThis.btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Decode an opaque cursor. Throws on malformed input — the resolver
 *  surfaces as a `cursor_invalid` error to the caller. */
export const decodeEngagementsCursor = (
  encoded: string,
): EngagementsResolverCursor => {
  let json: string;
  if (typeof Buffer !== 'undefined') {
    json = Buffer.from(encoded, 'base64url').toString('utf8');
  } else {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    json = decodeURIComponent(escape(globalThis.atob(padded)));
  }
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('cursor_invalid: malformed cursor blob');
  }
  const c = parsed as Record<string, unknown>;
  if (
    !(typeof c.event_at === 'number' || c.event_at === null) ||
    typeof c.engagement_id !== 'string' ||
    typeof c.connection_id !== 'string'
  ) {
    throw new Error('cursor_invalid: missing required cursor fields');
  }
  return {
    event_at: c.event_at as number | null,
    engagement_id: c.engagement_id,
    connection_id: c.connection_id,
  };
};

// ────────────────────────────────────────────────────────────────
// Capability map (§ A.6 — per (connection, vendor, entity) tuple)
// ────────────────────────────────────────────────────────────────

/** Per-(connection, vendor, entity) capability flags — populated at
 *  enrollment + re-probed on connection edit / "Re-probe capabilities"
 *  click / detected probe-failure events.
 *
 *  P1a.1 ships the shape; per-entity probe-driven population for
 *  HubSpot lands at P1a.1 alongside `hubspot.email`; the remaining
 *  HubSpot entities populate at P1a.2; Salesforce SObject + relationship
 *  probes at P1b. */
export interface EngagementCapabilityFlags {
  connection_id: string;
  vendor: EngagementVendor;
  entity: string;
  /** Object-availability — `describeSObjects()` for Salesforce;
   *  Developer-Portal subscription-table lookup for HubSpot. */
  available: boolean;
  /** Salesforce CDC probe at enrollment succeeded for this object. */
  cdc_supported?: boolean;
  /** Salesforce PushTopic create attempt at enrollment succeeded for
   *  this object (preserved on re-enrollment per D-130 P5
   *  idempotency pattern). */
  push_topic_supported?: boolean;
  /** True iff `cdc_supported = false AND push_topic_supported =
   *  false` for Salesforce; substrate falls back to housekeeping
   *  cycle for this object. Always-true for HubSpot reconciler-only
   *  fallback. */
  reconciler_only?: boolean;
  /** HubSpot per-entity `associationChange` capability — Pass-5
   *  R5.5. When `false`, the per-cycle association-rescan sweep
   *  (§ A.6.3) becomes mandatory regardless of streaming health. */
  association_rescan_required: boolean;
  /** Last-probe time — unix-ms. Drives re-probe schedule. */
  last_probed_at: number;
  /** Populated when CDC selected-entity check or PushTopic create
   *  returned an error. Surfaces in
   *  `coverage.sources_degraded` with reason
   *  `'partial_api_failure'` until next successful probe. */
  last_probe_error?: string;
}
