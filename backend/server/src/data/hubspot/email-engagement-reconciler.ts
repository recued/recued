/** D-139 Phase 1a.1 — HubSpot email engagement reconciler.
 *
 *  Implements the per-row reconciliation for `(hubspot, email)`. Unlike
 *  the deal/contact/company reconcilers (which write into
 *  `data_enrichment` via the harness's hash-diff path), the engagement
 *  reconciler writes through the dedicated `EngagementStore` because
 *  engagements live in a separate substrate per § A.3 (different shape,
 *  different query patterns, body-state machine, evidence-quality
 *  contracts).
 *
 *  Per cycle:
 *    1. Walk `listUpdatedSince` (paginated `/crm/v3/objects/emails/search`
 *       filtered by `hs_lastmodifieddate >= cursor`).
 *    2. For each raw record:
 *       a. Derive all Pass-4 evidence-quality fields (authorship,
 *          direction, lifecycle_state, vendor_modstamp, event_at +
 *          tz_hint + vendor_raw_timestamp). `body_state` is derived
 *          from the CRM body only (none / inline_body / truncated_inline)
 *          and `dedupe_confidence` is always `'none'`.
 *       b. `EngagementStore.upsert` (which enforces the
 *          `vendor_modstamp` stale-update drop).
 *       c. Emit `engagement_edges` rows for contact associations (each
 *          routed through D-138 `resolveContactIdentity` per § A.5) and
 *          owner. NO `mail_twin` edge is pre-bound.
 *    3. Advance cursor.
 *
 *  D-184 Decision 2 — the ingest no longer runs a mail-twin matcher.
 *  Exact RFC822 Message-ID twins (CRM-email ↔ `data.mail`) resolve LIVE
 *  in `resolveEngagementsForContact`, which flips `body_state` →
 *  `'mail_link'` + sets `mail_twin_id` when a local mail twin exists; the
 *  ingest just stores the CRM row + its `meta.message_id`. Probable
 *  (from+to+sent_at) twin materialization is deferred.
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.2, § A.3.3, § A.3.5,
 *  § A.3.6, § A.3.7, § A.3.8, § A.4, § A.5. */

import {
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_EMAIL_PROPERTIES,
  PLATFORM_REFERENCE_BATCH_SIZE,
  type Authorship,
  type AttachmentMeta,
  type BodyState,
  type ConnectionRecord,
  type DedupeConfidence,
  type Direction,
  type EngagementRow,
  type EngagementLifecycleState,
} from '@recued/contracts';

import type {
  ContactIdentityExpansion,
  ContactRedirectLookup,
  EngagementStore,
} from '../../storage/engagement-store.js';
import type {
  ReconciliationCadence,
  SlimRecord,
  WebhookProcessor,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  ENGAGEMENT_BODY_INLINE_MAX_BYTES,
  byteSizeOf,
  canonicalizeEmail,
  fetchHubSpotEngagementAssociations,
  hubSpotEngagementTargetIdFor,
  isInternalDomain,
  parseEmailList,
  parseUnixMs,
  pickBodyPreview as pickBodyPreviewShared,
  resolveEngagementTzHint,
  type EngagementCrmAssociations,
} from './engagement-shared.js';
import {
  searchHubSpotObjects,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

// D-184 Decision 2 — the ingest-time mail-twin matcher (`MailTwinMatch` /
// `MailTwinMatcherInput` / `MailTwinFinder` / `mailTwinFinder` dep) was
// REMOVED. Exact RFC822 Message-ID twins now resolve LIVE at read time in
// the `data.contact.engagements` resolver (against `data.mail`'s
// `rfc_message_id` hot field), so the ingest no longer pre-binds a
// `mail_twin` edge or stamps `body_state: 'mail_link'` — it stores the CRM
// row + its `meta.message_id` only, and the resolver flips to `mail_link`
// when a local mail twin exists. Probable (`from + to + sent_at`) twin
// materialization into `engagement_dedupe_candidates` is deferred (owner
// 2026-06-18); when revived it will re-introduce a matcher here.

export interface HubSpotEmailEngagementReconcilerDeps {
  search: HubSpotSearchDeps;
  /** Engagement store — write target for both rows and edges. */
  engagementStore: EngagementStore;
  /** D-138 redirect lookup — engagement→contact edges route through
   *  this BEFORE insert per § A.5 load-bearing wiring. Test fixtures
   *  pass an empty Map; production passes the contact-store's
   *  `merged_into` lookup. */
  resolveContactRedirect?: ContactRedirectLookup;
  /** D-138 identity-expansion — used by the resolver path; not wired
   *  through the reconciler write transaction. Reserved here so the
   *  caller has a single place to wire both halves. */
  expandContactIdentity?: ContactIdentityExpansion;
  /** The `hubspot_owner_id` value matching the user's connection
   *  identity (resolved via `/crm/v3/owners/` lookup at enrollment).
   *  Drives the `'user'` vs `'crm_user'` branch in the authorship
   *  derivation. */
  connectionUserOwnerId?: string;
  /** Closed list of internal email-domains (per-connection config)
   *  driving the `'internal'` direction classification. Default
   *  empty — substrate stamps `'unknown'` when no internal-domain
   *  set is wired. */
  internalEmailDomains?: ReadonlyArray<string>;
  /** D-139 § A.3.7 fallback timezone — populated into
   *  `EngagementRow.event_at_tz_hint` when HubSpot doesn't supply one
   *  (HubSpot serializes engagement timestamps as UTC unix-ms; the
   *  user's local TZ is the substrate's interpretive default).
   *  Defaults to `'UTC'` with a `'tz_inferred'` coverage hint per
   *  § A.9.3. (Codex review fold #7.) */
  defaultTzHint?: string;
  /** D-139 P1a.1.2 — per-pair `prefs.timezone` reader. Returns the
   *  user's account-default IANA tz, or `null`/`undefined` when prefs
   *  is empty / Settings → Profile → Time Zone hasn't been touched.
   *  Sits between the calendar-twin tz hint and the UTC sentinel in
   *  the § A.3.7 fallback chain (vendor → calendar adapter →
   *  `prefs.timezone` → UTC). Carry-forward closure for the P1a.1.1
   *  Codex P2 #4 finding — the reconciler's prior `defaultTzHint`
   *  string captured "vendor / adapter hint" without giving the
   *  prefs reader a wiring slot. When supplied, the resolver walks
   *  the chain: vendor → `defaultTzHint` (calendar twin) → `prefsTimezone()`
   *  → UTC (final fallback flagged via `event_at_tz_inferred = true`). */
  prefsTimezone?: () => string | null | undefined;
  /** Wall-clock — defaults to `Date.now`. Tests pin it. */
  now?: () => number;
  /** Optional webhook processor — same shape as deal/contact/company
   *  reconcilers (D-129 P5 widened) for `*.creation` /
   *  `*.propertyChange` / `*.deletion` webhook acceleration. */
  webhookProcessor?: WebhookProcessor;
}

/** Slim record carrying the raw HubSpot payload alongside the harness-
 *  read fields. The reconciler's `step()` consumes `_raw` to derive
 *  the full Pass-4 evidence-quality contract surface + the
 *  body-state machine + the canonical-field hash. */
export interface HubSpotEmailEngagementSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

// ────────────────────────────────────────────────────────────────
// Constants — body inline cap (re-exported from engagement-shared
// for stable consumer imports per the P1a.1.1 helper unification)
// ────────────────────────────────────────────────────────────────

export { ENGAGEMENT_BODY_INLINE_MAX_BYTES };

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class HubSpotEmailEngagementReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'email' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotEmailEngagementReconcilerDeps;

  constructor(deps: HubSpotEmailEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotEmailEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'emails',
        properties: HUBSPOT_EMAIL_PROPERTIES as unknown as ReadonlyArray<string>,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: `hubspot_email_${raw.id}`,
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  /** Main per-record write path. Idempotent under the
   *  `vendor_modstamp` stale-update drop. Codex review fold-back:
   *    - Single mail-twin lookup per ingest (#5)
   *    - Atomic row + edges + dedupe candidates via
   *      `engagementStore.ingestEngagementWithEdges` (#2 + #3) —
   *      crash between row write and edge writes is impossible
   *    - Edge tombstone-on-disassociate via the diff handled inside
   *      `ingestEngagementWithEdges` (#2)
   *    - D-138 resolver required for contact edges (#11) — supplied
   *      via `this.deps.resolveContactRedirect` or the explicit
   *      identity-callback `() => null` for tests.
   *
   *  P1a.1.1 — optional `crmAssociations` parameter carries the CRM-side
   *  association set fetched via `fetchHubSpotEngagementAssociations`
   *  (kept synchronous here so the harness's per-row write path stays
   *  on the main loop; callers async-fetch upstream). When supplied,
   *  the substrate emits `engagement_edges` of type `'deal'` +
   *  `'account'` per § A.4. When omitted, the reconciler falls back
   *  to the P1a.1 behavior (header-derived contact edges only). */
  ingest(
    connection_id: string,
    slim: HubSpotEmailEngagementSlimRecord,
    crmAssociations?: EngagementCrmAssociations,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    // D-184 Decision 2 — no ingest-time mail-twin matching. body_state is
    // derived from the CRM body only (none / inline_body / truncated_inline);
    // dedupe_confidence stays 'none'. Exact RFC822 Message-ID twins resolve
    // LIVE in the engagements resolver, which flips body_state → 'mail_link'
    // when a local data.mail twin exists.
    const row = projectEmailEngagementRow(connection_id, slim._raw, {
      now: this.now(),
      connectionUserOwnerId: this.deps.connectionUserOwnerId,
      internalEmailDomains: this.deps.internalEmailDomains,
      defaultTzHint: this.deps.defaultTzHint,
      prefsTimezone: this.deps.prefsTimezone,
    });

    // Codex review fold #11 — D-138 redirect lookup is required for
    // contact edges. Tests that don't exercise the redirect chain
    // pass the identity callback `() => null`.
    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const edges: Array<Parameters<EngagementStore['upsertEdge']>[0]> = [];
    const contactEmails = collectContactEmailsFromRaw(slim._raw);
    for (const email of contactEmails) {
      edges.push({
        connection_id,
        engagement_target_id: row.target_id,
        edge_type: 'contact',
        target_kind: 'data.contact',
        target_id: email,
        vendor: 'hubspot',
        created_at: this.now(),
        resolveContactRedirect,
      });
    }
    const owner = slim._raw.properties.hubspot_owner_id;
    if (typeof owner === 'string' && owner.length > 0) {
      edges.push({
        connection_id,
        engagement_target_id: row.target_id,
        edge_type: 'owner',
        target_kind: 'user',
        target_id: `hubspot_owner_id:${owner}`,
        vendor: 'hubspot',
        created_at: this.now(),
      });
    }
    // P1a.1.1 — emit deal + account edges from the CRM-side
    // associations (§ A.4). Header parsing only surfaces contact
    // emails; deal + account edges require the associations API.
    if (crmAssociations !== undefined) {
      for (const dealId of crmAssociations.deals) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'deal',
          target_kind: 'connection.api',
          target_id: hubSpotEngagementTargetIdFor('hubspot', 'deal', connection_id, dealId),
          vendor: 'hubspot',
          created_at: this.now(),
        });
      }
      for (const companyId of crmAssociations.companies) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'account',
          target_kind: 'connection.api',
          target_id: hubSpotEngagementTargetIdFor(
            'hubspot',
            'company',
            connection_id,
            companyId,
          ),
          vendor: 'hubspot',
          created_at: this.now(),
        });
      }
    }
    // D-184 Decision 2 — no mail_twin edge or dedupe candidate emitted at
    // ingest (exact twins resolve live; probable materialization deferred).
    const result = this.deps.engagementStore.ingestEngagementWithEdges({
      row,
      edges,
      dedupe_candidates: [],
      now: this.now(),
    });

    return {
      row: result.row,
      emittedEdgeCount: result.edges_upserted,
      edgesTombstoned: result.edges_tombstoned,
      staleModstamp: result.stale_modstamp,
    };
  }

  /** Codex P1 #3 fold-back — async wrapper that fetches the CRM-side
   *  association set FIRST, then delegates to the synchronous
   *  `ingest()` with `crmAssociations` populated. This satisfies the
   *  spec § A.4 row+edge transactional write requirement: deal +
   *  account edges land in the same `ingestEngagementWithEdges`
   *  transaction as the row itself.
   *
   *  Harness wiring uses this method on the changed-record path. The
   *  synchronous `ingest()` stays available for unit tests + for
   *  callers that already have associations precomputed (e.g. the
   *  edge-only webhook path). */
  async ingestWithAssociations(
    connection: ConnectionRecord,
    connection_id: string,
    slim: HubSpotEmailEngagementSlimRecord,
  ): Promise<{
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
    associations_fetched: boolean;
  }> {
    let crmAssociations: EngagementCrmAssociations | undefined;
    try {
      const fetched = await fetchHubSpotEngagementAssociations({
        connection,
        entity: 'email',
        raw_id: slim._raw.id,
        search: this.deps.search,
      });
      // Don't write a row whose associations we couldn't read — the
      // record is mid-deletion (deletion event will follow).
      if (fetched.source_record_missing) {
        return {
          row: undefined as never,
          emittedEdgeCount: 0,
          edgesTombstoned: 0,
          staleModstamp: false,
          associations_fetched: false,
        };
      }
      crmAssociations = fetched.associations;
    } catch {
      // Fetch failed (transient / 429) — fall back to header-only
      // edges so the row still lands. The next reconciler-cycle's
      // association-rescan sweep picks up the missing deal/account
      // edges. Caller may also choose to retry the whole record.
      crmAssociations = undefined;
    }
    const result = this.ingest(connection_id, slim, crmAssociations);
    return {
      ...result,
      associations_fetched: crmAssociations !== undefined,
    };
  }

  /** D-184 — harness self-ingest hook. The reconciliation harness calls
   *  this per record INSTEAD of its default plain-enrichment write, so
   *  engagement reconcile rides the same connection-enroll + cursor +
   *  rate-gate machinery as the deal/contact/company reconcilers. Delegates
   *  to the existing `ingestWithAssociations` (row + edges + dedupe in one
   *  transaction; the engagement store fires its own internal cascade). The
   *  harness yields the concrete slim type from `listUpdatedSince`, so the
   *  cast is sound. */
  async selfIngest(
    connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): Promise<void> {
    await this.ingestWithAssociations(
      connection,
      connection_name,
      record as HubSpotEmailEngagementSlimRecord,
    );
  }

  /** D-184 — HubSpot engagement ingest makes a per-record associations
   *  GET on top of the search page, so the rate-gate budget counts
   *  `pages + processed` (mirrors the retired runonce runner's
   *  `api_calls_consumed`), not the harness default `pages`. */
  apiCallsFor(processed: number, pages: number): number {
    return pages + processed;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// Pure projection functions (exported for unit testing)
// ────────────────────────────────────────────────────────────────

export interface ProjectEmailEngagementRowInput {
  now: number;
  connectionUserOwnerId?: string;
  internalEmailDomains?: ReadonlyArray<string>;
  /** Codex review fold #7 — fallback timezone hint per § A.3.7. */
  defaultTzHint?: string;
  /** D-139 P1a.1.2 — see `HubSpotEmailEngagementReconcilerDeps.prefsTimezone`. */
  prefsTimezone?: () => string | null | undefined;
}

/** Project a raw HubSpot email-engagement record into the substrate's
 *  canonical `EngagementRow` shape with all Pass-4 evidence-quality
 *  fields populated. Pure function — no IO. The reconciler `ingest()`
 *  call wraps this with the engagement-store + edge-table writes. */
export const projectEmailEngagementRow = (
  connection_id: string,
  raw: RawHubSpotRecord,
  input: ProjectEmailEngagementRowInput,
): EngagementRow => {
  const status = (raw.properties.hs_email_status ?? '').toUpperCase();
  const lifecycle_state = deriveEmailLifecycleState(status);
  const event_at = deriveEmailEventAt(raw, lifecycle_state);
  const vendor_created_at = parseUnixMs(raw.properties.hs_createdate) ?? input.now;
  const vendor_modified_at = parseUnixMs(raw.properties.hs_lastmodifieddate)
    ?? vendor_created_at;
  const direction = deriveEmailDirection(raw, input.internalEmailDomains ?? []);
  const authorship = deriveEmailAuthorship(raw, input.connectionUserOwnerId);
  // D-184 Decision 2 — exact/probable twin matching no longer runs at
  // ingest, so dedupe_confidence is always 'none' here. Exact twins flip
  // to 'mail_link' / `mail_twin_id` live in the engagements resolver.
  const dedupe_confidence: DedupeConfidence = 'none';

  const { body_state, body_inline, body_truncation_offset } = pickBodyState(raw);

  const meta: Record<string, unknown> = {};
  if (raw.properties.hs_email_subject)
    meta.subject = raw.properties.hs_email_subject;
  if (raw.properties.hs_email_direction)
    meta.direction = raw.properties.hs_email_direction;
  const fromEmail = canonicalizeEmail(raw.properties.hs_email_from_email);
  if (fromEmail) meta.from_email = fromEmail;
  const toEmails = parseEmailList(raw.properties.hs_email_to_email);
  if (toEmails.length > 0) meta.to_emails = toEmails;
  const ccEmails = parseEmailList(raw.properties.hs_email_cc_email);
  if (ccEmails.length > 0) meta.cc_emails = ccEmails;
  const tsParsed = parseUnixMs(raw.properties.hs_timestamp);
  if (tsParsed !== null) meta.timestamp = tsParsed;
  if (status) meta.status = status;
  if (raw.properties.hs_email_internet_message_id)
    meta.message_id = raw.properties.hs_email_internet_message_id;
  if (raw.properties.hs_email_thread_id)
    meta.thread_id = raw.properties.hs_email_thread_id;
  const bodyPreview = pickBodyPreview(raw);
  if (bodyPreview) meta.body_preview = bodyPreview;
  if (raw.properties.hubspot_owner_id)
    meta.owner = `hubspot_owner_id:${raw.properties.hubspot_owner_id}`;

  // Codex review fold #6 — bounce sub-reason persistence per Pass-5
  // R5.3. When the email is in `'failed'` lifecycle state with a
  // BOUNCED status, surface the bounce_detail fields under
  // meta.bounce_detail so producers / agents reading the row can
  // distinguish hard bounces / quota / mailbox-full / etc.
  if (
    lifecycle_state === 'failed' &&
    (raw.properties.hs_email_bounce_error_detail_message ||
      raw.properties.hs_email_bounce_error_detail_status_code)
  ) {
    const bounceDetail: Record<string, unknown> = {};
    if (raw.properties.hs_email_bounce_error_detail_message) {
      bounceDetail.message =
        raw.properties.hs_email_bounce_error_detail_message;
    }
    if (raw.properties.hs_email_bounce_error_detail_status_code) {
      bounceDetail.status_code =
        raw.properties.hs_email_bounce_error_detail_status_code;
    }
    if (status) bounceDetail.vendor_status = status;
    meta.bounce_detail = bounceDetail;
  }

  const row: EngagementRow = {
    connection_id,
    target_id: `hubspot_email_${raw.id}`,
    vendor: 'hubspot',
    entity: 'email',
    meta,
    mirror_blob_hash: null,
    authorship,
    direction,
    dedupe_confidence,
    lifecycle_state,
    event_at,
    vendor_created_at,
    vendor_modified_at,
    ingested_at: input.now,
    body_state,
  };

  // Optional bistemporal + content fields.
  if (raw.properties.hs_lastmodifieddate)
    row.vendor_modstamp = raw.properties.hs_lastmodifieddate;
  if (raw.properties.hs_timestamp) {
    row.vendor_raw_timestamp = raw.properties.hs_timestamp;
  }
  // P1a.1.2 — § A.3.7 fallback chain. HubSpot engagements never
  // supply a vendor-side IANA tz (timestamps are UTC unix-ms), so
  // the chain reduces to: defaultTzHint (calendar adapter — empty
  // for email) → prefsTimezone() → UTC. The resolver flags the
  // final UTC fallback so producers can surface the
  // `'tz_inferred'` coverage reason from § A.9.3.
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if (body_inline !== undefined) row.body_inline = body_inline;
  if (body_truncation_offset !== undefined)
    row.body_truncation_offset = body_truncation_offset;
  // Attachment metadata harvest is wired by the WebhookProcessor's
  // follow-up GET path + the per-cycle reconciler. P1a.1 ships the
  // shape; populating attachments via `/associations/{type}` lookups
  // lands at a P1a.1.1 follow-up sub-phase.
  return row;
};

// ────────────────────────────────────────────────────────────────
// Authorship derivation (§ A.3.2)
// ────────────────────────────────────────────────────────────────

const SYSTEM_PROCESS_STATUSES: ReadonlySet<string> = new Set([
  'OPENED',
  'BOUNCED',
  'UNSUBSCRIBED',
]);

export const deriveEmailAuthorship = (
  raw: RawHubSpotRecord,
  connectionUserOwnerId: string | undefined,
): Authorship => {
  const ownerId = raw.properties.hubspot_owner_id ?? null;
  if (
    typeof connectionUserOwnerId === 'string' &&
    connectionUserOwnerId.length > 0 &&
    ownerId === connectionUserOwnerId
  ) {
    return 'user';
  }
  if (
    raw.properties.hs_created_by_workflow_id !== undefined &&
    raw.properties.hs_created_by_workflow_id !== null &&
    raw.properties.hs_created_by_workflow_id !== ''
  ) {
    return 'crm_automation';
  }
  if (
    raw.properties.hs_created_via_workflow !== undefined &&
    raw.properties.hs_created_via_workflow !== null &&
    raw.properties.hs_created_via_workflow !== ''
  ) {
    return 'crm_automation';
  }
  if (
    raw.properties.hs_import_id !== undefined &&
    raw.properties.hs_import_id !== null &&
    raw.properties.hs_import_id !== ''
  ) {
    return 'import';
  }
  const status = (raw.properties.hs_email_status ?? '').toUpperCase();
  const subject = raw.properties.hs_email_subject ?? '';
  const text = raw.properties.hs_email_text ?? '';
  if (
    SYSTEM_PROCESS_STATUSES.has(status) &&
    subject.length === 0 &&
    text.length === 0
  ) {
    return 'system_process';
  }
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    return 'crm_user';
  }
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Direction derivation (§ A.3.3)
// ────────────────────────────────────────────────────────────────

export const deriveEmailDirection = (
  raw: RawHubSpotRecord,
  internalDomains: ReadonlyArray<string>,
): Direction => {
  const dir = (raw.properties.hs_email_direction ?? '').toUpperCase();
  if (dir === 'INCOMING_EMAIL') return 'inbound';
  // Outbound + forwarded: classify as 'internal' when ALL participants
  // share an internal domain, else 'outbound'.
  if (dir === 'EMAIL' || dir === 'FORWARDED_EMAIL') {
    if (internalDomains.length > 0) {
      const fromEmail = canonicalizeEmail(raw.properties.hs_email_from_email);
      const toEmails = parseEmailList(raw.properties.hs_email_to_email);
      if (fromEmail !== null && toEmails.length > 0) {
        const allInternal =
          isInternalDomain(fromEmail, internalDomains) &&
          toEmails.every((e) => isInternalDomain(e, internalDomains));
        if (allInternal) return 'internal';
      }
    }
    return 'outbound';
  }
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Lifecycle derivation (§ A.3.6 — Pass-5 R5.3)
// ────────────────────────────────────────────────────────────────

export const deriveEmailLifecycleState = (status: string): EngagementLifecycleState => {
  switch (status) {
    case 'SCHEDULED':
    case 'SENDING':
      return 'pending';
    case 'SENT':
      return 'point_in_time';
    case 'FAILED':
    case 'BOUNCED':
      return 'failed';
    default:
      // Empty / OPENED / UNSUBSCRIBED / unknown — best-effort.
      // OPENED is a tracking-pixel side-effect; the underlying SENT
      // event is the engagement evidence and lands separately. Default
      // 'point_in_time' reflects the row's existence as a logged event;
      // producers filter via `authorship: 'system_process'` per § A.3.2.
      return 'point_in_time';
  }
};

// ────────────────────────────────────────────────────────────────
// event_at derivation (§ A.3.1)
// ────────────────────────────────────────────────────────────────

export const deriveEmailEventAt = (
  raw: RawHubSpotRecord,
  lifecycle_state: EngagementLifecycleState,
): number | null => {
  if (lifecycle_state !== 'point_in_time') {
    // Pending / failed / cancelled — not yet engagement evidence.
    // Pass-4 R4.5 + Pass-5 R5.3.
    return null;
  }
  const ts = parseUnixMs(raw.properties.hs_timestamp);
  if (ts !== null) return ts;
  // Fallback to vendor_created_at if hs_timestamp is missing for
  // SENT-state rows (rare but observed in older portals).
  return parseUnixMs(raw.properties.hs_createdate);
};

// ────────────────────────────────────────────────────────────────
// Body-state machine (§ A.3)
// ────────────────────────────────────────────────────────────────

export const pickBodyState = (
  raw: RawHubSpotRecord,
): {
  body_state: BodyState;
  body_inline?: string;
  body_truncation_offset?: number;
} => {
  // D-184 Decision 2 — body_state from CRM body only at ingest; the
  // 'mail_link' state is applied live in the resolver on a Message-ID twin.
  const text = raw.properties.hs_email_text ?? '';
  const html = raw.properties.hs_email_html ?? '';
  const body = text.length > 0 ? text : html;

  if (body.length === 0) return { body_state: 'none' };

  const byteLength = byteSizeOf(body);
  if (byteLength <= ENGAGEMENT_BODY_INLINE_MAX_BYTES) {
    return { body_state: 'inline_body', body_inline: body };
  }
  // Truncate to ~6 KB (cuts at character boundary, byte-wise it may
  // be slightly under 6 KB which is fine for the cap).
  const truncated = body.slice(
    0,
    Math.floor(ENGAGEMENT_BODY_INLINE_MAX_BYTES / 2),
  );
  return {
    body_state: 'truncated_inline',
    body_inline: truncated,
    body_truncation_offset: byteLength,
  };
};

/** Email-specific body preview reader — picks `hs_email_text` first
 *  with `hs_email_html` fallback. Threads through engagement-shared's
 *  generic `pickBodyPreview(string)` for the actual truncation. */
const pickBodyPreview = (raw: RawHubSpotRecord): string | null => {
  const text = raw.properties.hs_email_text ?? '';
  const html = raw.properties.hs_email_html ?? '';
  const body = text.length > 0 ? text : html;
  return pickBodyPreviewShared(body);
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const collectContactEmailsFromRaw = (
  raw: RawHubSpotRecord,
): ReadonlyArray<string> => {
  const out = new Set<string>();
  const from = canonicalizeEmail(raw.properties.hs_email_from_email);
  if (from !== null) out.add(from);
  for (const e of parseEmailList(raw.properties.hs_email_to_email)) {
    out.add(e);
  }
  for (const e of parseEmailList(raw.properties.hs_email_cc_email)) {
    out.add(e);
  }
  return Array.from(out);
};
