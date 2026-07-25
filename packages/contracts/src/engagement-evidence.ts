/** D-139 P1a.1 — Engagement evidence-quality contracts.
 *
 *  Closed-list types declaring the substrate-level shape of every
 *  engagement row's evidence-quality columns. Producers consume these
 *  as registry-typed values; never re-derive on their own.
 *
 *  The Pass-4 reframe of D-139 elevated nine producer-side
 *  interpretations into substrate contracts:
 *
 *    - `Authorship` (§ A.3.2) — who created the row
 *    - `Direction` (§ A.3.3) — touch flow direction
 *    - `DedupeConfidence` (§ A.3.5) — twin-match strength
 *    - `LifecycleState` (§ A.3.6) — activity vs evidence
 *    - `BodyState` (§ A.3) — body-content location machine
 *    - `EdgeType` (§ A.4) — engagement edge taxonomy
 *    - `SourceDegradationReason` (§ A.9.3) — coverage degradation
 *    - `DedupeAcceptance` (§ A.3.5) — per-producer collapse policy
 *    - `EngagementVendor` — OPEN vendor id (D-192; membership via the registry)
 *
 *  Spec: D-139 § A.3.2 + § A.3.3 + § A.3.4 + § A.3.5 +
 *  § A.3.6 + § A.3.7 + § A.3.8 + § A.4 + § A.9.3 + § A.9.5. */

// ────────────────────────────────────────────────────────────────
// Authorship — who created the engagement record (§ A.3.2)
// ────────────────────────────────────────────────────────────────

/** Closed list of seven authorship classifications. Per-vendor +
 *  per-entity derivation lives in the reconciler; producers consume
 *  this enum directly without re-classifying. The enum spans the full
 *  signal-strength spectrum, from `'user'` (the Recued account holder
 *  themselves) through `'system_process'` (HubSpot tracking pixel,
 *  bounce handler) — producer defaults skip the weakest values for
 *  evidence-bearing aggregates (last_meaningful_touch / sentiment /
 *  commitment_tracker) and weight or include them for trajectory
 *  aggregates (engagement_velocity_signal). */
export const AUTHORSHIP_VALUES = [
  'user',
  'crm_user',
  'crm_automation',
  'integration',
  'import',
  'system_process',
  'unknown',
] as const;
export type Authorship = (typeof AUTHORSHIP_VALUES)[number];
export const AUTHORSHIP_SET: ReadonlySet<string> = new Set(AUTHORSHIP_VALUES);
export const isAuthorship = (raw: unknown): raw is Authorship =>
  typeof raw === 'string' && AUTHORSHIP_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Direction — touch flow direction (§ A.3.3)
// ────────────────────────────────────────────────────────────────

/** Closed direction enum. Per-vendor + per-entity derivation per spec
 *  table at § A.3.3. `'unknown'` covers entities without intrinsic
 *  direction (HubSpot notes always carry `'unknown'`) and ambiguous
 *  cases. Producer-side override allowed only at the producer's
 *  consumption defaults; substrate value is canonical. */
export const DIRECTION_VALUES = [
  'inbound',
  'outbound',
  'internal',
  'unknown',
] as const;
export type Direction = (typeof DIRECTION_VALUES)[number];
export const DIRECTION_SET: ReadonlySet<string> = new Set(DIRECTION_VALUES);
export const isDirection = (raw: unknown): raw is Direction =>
  typeof raw === 'string' && DIRECTION_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Dedupe confidence — twin-match strength (§ A.3.5)
// ────────────────────────────────────────────────────────────────

/** Twin-match confidence enum. `'exact'` collapses two rows into one
 *  with `vendor_twins[]`; `'probable'` surfaces both rows with
 *  `dedupe_candidates[]` cross-references; `'none'` means no twin
 *  candidate found. Resolver default surfaces probable-confidence
 *  twins as separate rows — over-counts rather than mis-merges. */
export const DEDUPE_CONFIDENCE_VALUES = ['exact', 'probable', 'none'] as const;
export type DedupeConfidence = (typeof DEDUPE_CONFIDENCE_VALUES)[number];
export const DEDUPE_CONFIDENCE_SET: ReadonlySet<string> = new Set(
  DEDUPE_CONFIDENCE_VALUES,
);
export const isDedupeConfidence = (raw: unknown): raw is DedupeConfidence =>
  typeof raw === 'string' && DEDUPE_CONFIDENCE_SET.has(raw);

/** Per-producer dedupe acceptance policy. `'exact_only'` (default)
 *  treats probable-confidence pairs as separate engagements —
 *  over-counts but never undercounts. `'probable'` collapses
 *  probable-confidence pairs (uses higher `vendor_modstamp` row as
 *  canonical). `'all'` always collapses regardless of confidence. */
export const DEDUPE_ACCEPTANCE_VALUES = ['exact_only', 'probable', 'all'] as const;
export type DedupeAcceptance = (typeof DEDUPE_ACCEPTANCE_VALUES)[number];
export const DEDUPE_ACCEPTANCE_SET: ReadonlySet<string> = new Set(
  DEDUPE_ACCEPTANCE_VALUES,
);
export const isDedupeAcceptance = (raw: unknown): raw is DedupeAcceptance =>
  typeof raw === 'string' && DEDUPE_ACCEPTANCE_SET.has(raw);

/** Match-key types persisted on `engagement_dedupe_candidates` rows.
 *  Spec § A.3.5 enumerates the three first-class keys; the validator
 *  accepts any non-empty string for forward-compat with producer-
 *  declared match keys, but the closed list is the recommended
 *  vocabulary. */
export const DEDUPE_MATCH_KEY_VALUES = [
  'message_id',
  'from_to_sent_at_triple',
  'from_to_sent_at_subject_hash_quadruple',
  'vendor_native_id',
] as const;
export type DedupeMatchKey = (typeof DEDUPE_MATCH_KEY_VALUES)[number];

// ────────────────────────────────────────────────────────────────
// Lifecycle state — activity vs evidence (§ A.3.6)
// ────────────────────────────────────────────────────────────────

/** Per-engagement-type lifecycle state machine. Producers default to
 *  `lifecycle_state IN ('point_in_time', 'completed')` for "is this
 *  engagement evidence." Pending tasks + scheduled meetings + cancelled
 *  rows + failed sends + queued calls are activity records but NOT
 *  signals.
 *
 *  Pass-5 R5.4 added `'failed'` and `'no_answer'` for HubSpot email
 *  send failures + call outcome separation respectively. */
export const ENGAGEMENT_LIFECYCLE_STATE_VALUES = [
  'pending',
  'scheduled',
  'completed',
  'cancelled',
  'rescheduled',
  'failed',
  'no_answer',
  'point_in_time',
] as const;
export type EngagementLifecycleState =
  (typeof ENGAGEMENT_LIFECYCLE_STATE_VALUES)[number];
export const ENGAGEMENT_LIFECYCLE_STATE_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_LIFECYCLE_STATE_VALUES,
);
export const isEngagementLifecycleState = (raw: unknown): raw is EngagementLifecycleState =>
  typeof raw === 'string' && ENGAGEMENT_LIFECYCLE_STATE_SET.has(raw);

/** Default producer-side lifecycle filter — engagement evidence only.
 *  Resolver also defaults to this set when caller omits the
 *  `lifecycle_state` arg. */
export const DEFAULT_ENGAGEMENT_LIFECYCLE_EVIDENCE_STATES: ReadonlyArray<EngagementLifecycleState> =
  ['point_in_time', 'completed'] as const;

// ────────────────────────────────────────────────────────────────
// Body state — content location machine (§ A.3)
// ────────────────────────────────────────────────────────────────

/** Body-state machine resolves the email-vs-mail case split + the
 *  truncation case + the forward-compat mirror_blob slot at runtime.
 *  Producers declare `body_state_acceptance: BodyState[]` to gate
 *  their compute path; resolver strips `body_inline` from MCP
 *  responses by default per § A.9.5. */
export const BODY_STATE_VALUES = [
  'none',
  'mail_link',
  'calendar_link',
  'inline_body',
  'truncated_inline',
  'mirror_blob_pending',
  'mirror_blob',
] as const;
export type BodyState = (typeof BODY_STATE_VALUES)[number];
export const BODY_STATE_SET: ReadonlySet<string> = new Set(BODY_STATE_VALUES);
export const isBodyState = (raw: unknown): raw is BodyState =>
  typeof raw === 'string' && BODY_STATE_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Edge type — engagement edge taxonomy (§ A.4)
// ────────────────────────────────────────────────────────────────

/** Closed list of engagement-edge types. New types land via registry
 *  edit when post-launch demand surfaces. The resolver's evidence-
 *  quality filters scope on `edge_type = 'contact'` for identity-
 *  expansion. `'mail_twin'` is retained as a closed-list value but is
 *  no longer written at ingest — D-184 Decision 2 resolves CRM-email ↔
 *  `data.mail` twins LIVE at read time (the resolver sets `mail_twin_id`
 *  / `body_state: 'mail_link'`), so no `target_kind='data.mail'` edge is
 *  pre-bound. `'calendar_twin'` (meeting engagements) is unaffected. */
export const ENGAGEMENT_EDGE_TYPE_VALUES = [
  'contact',
  'deal',
  'account',
  'owner',
  'mail_twin',
  'calendar_twin',
] as const;
export type EngagementEdgeType = (typeof ENGAGEMENT_EDGE_TYPE_VALUES)[number];
export const ENGAGEMENT_EDGE_TYPE_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_EDGE_TYPE_VALUES,
);
export const isEngagementEdgeType = (raw: unknown): raw is EngagementEdgeType =>
  typeof raw === 'string' && ENGAGEMENT_EDGE_TYPE_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Source-degradation reason — coverage metadata (§ A.9.3)
// ────────────────────────────────────────────────────────────────

/** Closed list of source-degradation reasons. Producers populate
 *  `coverage.sources_degraded` with these reasons when the substrate
 *  detects partial-availability at compute time. Distinguishes
 *  "we got most" (full coverage) from "we got all we have"
 *  (sources_unavailable) from "we got partial because the source is
 *  degraded" (sources_degraded). Substrate populates directly from
 *  current rate-control / replay-ledger / body-content-gate state.
 *
 *  D-145 PA9 widening — `'sample_floor_unmet'` covers the
 *  per-declaration sample-floor abstain path (spec § A.7.5):
 *  PSI-eligible producers refuse to compute when source-row count
 *  is below the declared floor; the row carries the reason so
 *  consumers see "abstained, not absent". */
export const SOURCE_DEGRADATION_REASON_VALUES = [
  'quota_suspended',
  'rate_limit_active',
  'permission_revoked',
  'partial_api_failure',
  'body_redacted',
  'association_rescan_pending',
  'webhook_delivery_degraded',
  'tz_inferred',
  'authorship_unknown',
  'attachment_metadata_only',
  'sample_floor_unmet',
] as const;
export type SourceDegradationReason =
  (typeof SOURCE_DEGRADATION_REASON_VALUES)[number];
export const SOURCE_DEGRADATION_REASON_SET: ReadonlySet<string> = new Set(
  SOURCE_DEGRADATION_REASON_VALUES,
);
export const isSourceDegradationReason = (
  raw: unknown,
): raw is SourceDegradationReason =>
  typeof raw === 'string' && SOURCE_DEGRADATION_REASON_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Vendor — closed list of supported engagement vendors
// ────────────────────────────────────────────────────────────────

/** The SHIPPED builtin engagement vendors — NOT a closed universe. Since D-192
 *  the engagement plane is open to pack-declared vendors via the vendor-entity
 *  registry's `engagement` facet; membership is decided by the live registry
 *  (`vendorHasEngagement` + the S1 helpers in `connection-vendors.ts`), not this
 *  list. Retained as the built-in set the MCP input schema enumerates + tests
 *  pin — deliberately decoupled from the (now open) `EngagementVendor` type. */
export const ENGAGEMENT_VENDOR_VALUES = ['hubspot', 'salesforce'] as const;

/** A vendor id carrying engagement/activity data. OPEN (`string`) since D-192:
 *  the closed `'hubspot' | 'salesforce'` union was a de-hardcode seam — a pack-
 *  declared CRM's engagement plane now works with no code edit. Shared logic
 *  reads the registry predicate `vendorHasEngagement(vendor, liveRegistry)`
 *  instead of narrowing to this type. The built-in set survives as
 *  `ENGAGEMENT_VENDOR_VALUES`. Design: D-192. */
export type EngagementVendor = string;

// ────────────────────────────────────────────────────────────────
// Attachment metadata (§ A.3.4 — metadata-only at v1)
// ────────────────────────────────────────────────────────────────

/** Per-attachment metadata. v1 storage is metadata-only — blobs are
 *  NOT mirrored locally; producers needing attachment text fetch via
 *  the existing `connection` adapter at compute time. Forward-compat
 *  slot lives on the engagement row's `mirror_blob_hash` field
 *  (always-NULL at v1) for when D-128's CAS layer extends to
 *  attachments in a future D. */
export interface AttachmentMeta {
  /** Vendor-native attachment id. Opaque at substrate layer. */
  vendor_attachment_id: string;
  /** Canonical filename — vendor-supplied. */
  filename: string;
  /** MIME type from vendor. Defaults to `'application/octet-stream'`
   *  when vendor doesn't report. */
  content_type: string;
  /** Byte size from vendor. `0` when vendor doesn't report. */
  size_bytes: number;
  /** Vendor download URL when available. Access still requires the
   *  user's vendor auth token at fetch time (substrate stores no
   *  blob; the URL is for routing). */
  vendor_url?: string;
  /** Upload time — unix-ms UTC. Falls back to engagement's
   *  `vendor_created_at` when vendor doesn't expose. */
  uploaded_at: number;
}

// ────────────────────────────────────────────────────────────────
// Coverage metadata (§ A.9.3)
// ────────────────────────────────────────────────────────────────

/** Per-output coverage metadata. Every D-139 enrichment topic ships
 *  with this field at registry-load; existing pre-D-139 topics treat
 *  it as optional + absent (Pass-4 substrate widening — D-139 drives
 *  the field, doesn't retrofit other Ds at v1). */
export interface CoverageStaleEntry {
  source: string;
  last_event_at: number;
  staleness_threshold_ms: number;
}

export interface CoverageDegradedEntry {
  source: string;
  reason: SourceDegradationReason;
  since: number;
  detail?: string;
}

export interface CoverageMetadata {
  /** Collection-level paths actually queryable at compute time. */
  sources_connected: ReadonlyArray<string>;
  /** Sources declared in `aggregates_from` but not connected /
   *  installed at compute time. */
  sources_unavailable: ReadonlyArray<string>;
  /** Sources whose freshest event is older than the staleness
   *  threshold. */
  sources_stale: ReadonlyArray<CoverageStaleEntry>;
  /** Sources connected but partially failing at evidence-quality
   *  (rate-limited, body-redacted, permission-revoked, etc.). */
  sources_degraded: ReadonlyArray<CoverageDegradedEntry>;
  /** Per-source row counts that contributed to the compute. */
  row_counts: Readonly<Record<string, number>>;
  /** Freshest source event_at across all queried sources. `0` when
   *  no source had any events. */
  last_source_event_at: number;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

// D-192 — `HUBSPOT_ENGAGEMENT_ENTITY_NAMES` (+ its `HubSpotEngagementEntityName`
// type / set / guard) was deleted here: the vendor-entity registry's `engagement`
// facet is the single source of truth for a vendor's engagement entities, read via
// `engagementEntitiesForVendor('hubspot', registry)` (`connection-vendors.ts`). The
// Salesforce sibling constant survives (its `SalesforceEngagementEntityName` type is
// load-bearing across the Salesforce streaming leaf — a legit per-vendor leaf).

/** D-139 § A.3.5 — cap on candidates surfaced per row in the
 *  resolver response. When more candidates exist, the row carries a
 *  `dedupe_candidates_truncated: true` flag pointing at the
 *  `engagement_dedupe_candidates` table for full enumeration via
 *  Settings → Engagements → "Possible duplicates". */
export const ENGAGEMENT_DEDUPE_CANDIDATES_PER_ROW_CAP = 8;

/** D-139 § A.3.8 — replay-window cap. Inbound-event ledger entries
 *  older than this are compacted by D-123 housekeeping. Reuses the
 *  same constant D-128 already exposes for vendor webhook replay
 *  defense. */
export const ENGAGEMENT_INBOUND_EVENT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** D-139 § A.6.3 — association-rescan window. Engagements within this
 *  window are eligible for the per-cycle association-rescan sweep
 *  (when `association_rescan_required = true` for the (connection,
 *  vendor, entity) tuple). Configurable per-pack via
 *  `housekeeping_config.engagement_association_rescan_window_days`. */
export const ENGAGEMENT_ASSOCIATION_RESCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** D-139 § A.6.2 — per-invocation page cap for the reconciler-only
 *  fallback path. Tail resumes next cycle. Prevents one cycle from
 *  monopolizing the per-connection daily token budget. */
export const RECONCILER_PAGE_CAP_PER_INVOCATION = 10;

/** D-139 § A.5.1 — default time-window for the contact-rooted
 *  engagements view (90 days). Recipes that need the full timeline
 *  pass `since: 0`. */
export const ENGAGEMENT_RESOLVER_DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** D-139 § A.5.1 — default page size for the contact-rooted resolver. */
export const ENGAGEMENT_RESOLVER_DEFAULT_PAGE_SIZE = 50;

/** D-139 § A.5.1 — max page size for the contact-rooted resolver. */
export const ENGAGEMENT_RESOLVER_MAX_PAGE_SIZE = 200;

/** D-139 § A.9.5 — registry key for the per-token MCP body-content
 *  permission grant. Surfaces in the `mcp_body_visibility` table (the
 *  per-token body-content grant; topic-level read-visibility moved to the
 *  per-(bound contract, topic) `contract.enrichment.*` toggle, D-187). */
export const ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY =
  'data.contact.engagements.body_content';

/** D-139 § A.5.1 — registry key for the MCP topic visibility opt-in for
 *  the contact-rooted engagements resolver. Default OFF; user opts in per
 *  (bound contract, topic) via the `contract.enrichment.*` read-visibility
 *  toggle (D-187). */
export const ENGAGEMENT_LIST_REGISTRY_KEY = 'data.contact.engagements';

/** D-139 § P6.B — launch-flag key the marketplace listing layer
 *  consults to decide whether to surface the `crm-commitment-tracker`
 *  pack. Default `false` at first ship; flips to `true` after P6.A
 *  has been in production for ≥ 30d (telemetry window confirming
 *  substrate stability). Substrate code lands at P6 implementation
 *  (registry entry + producer code + pack manifest); only the
 *  marketplace listing path consults the flag. The launch flag does
 *  NOT gate enrichment writes — the upsert path stays open at P6
 *  (recipes can land via portable bundle / direct install when the
 *  flag is off; only marketplace browse / install hides). */
export const CRM_COMMITMENT_TRACKER_LAUNCH_FLAG =
  'packs.crm_commitment_tracker.enabled';
