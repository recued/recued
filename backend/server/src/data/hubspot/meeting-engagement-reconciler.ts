/** D-139 Phase 1a.2 — HubSpot meeting-engagement reconciler.
 *
 *  Lifecycle per § A.3.6: `'scheduled'` (start_time future) →
 *  `'completed'` (start_time past + outcome populated) | `'cancelled'`
 *  (hs_meeting_outcome=CANCELED) | `'rescheduled'` (start_time pushed
 *  forward; flips back to `'scheduled'` with new start_time). State is
 *  engagement evidence ONLY in `'completed'` state — `event_at` is
 *  NULL while upcoming and populates to `start_time` once past per
 *  § A.3.1.
 *
 *  Direction per § A.3.3 — attendee-set internal-domain analysis:
 *    - all attendees internal → 'internal'
 *    - any external attendee + meeting created by internal user →
 *      'outbound' (rep scheduled it)
 *    - meeting created by external attendee → 'inbound' (prospect-
 *      initiated)
 *    - attendee classification incomplete → 'unknown'
 *
 *  Calendar-twin matcher: when the user has a calendar adapter wired
 *  AND the meeting matches a local calendar event (URL-based or
 *  attendee-set + start-time match), the row's `body_state` flips to
 *  `'calendar_link'` and an `engagement_edges` row of type
 *  `calendar_twin` is emitted pointing at `data.calendar.<id>`. The
 *  matcher's TZ field populates `event_at_tz_hint` per § A.3.7.
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.2, § A.3.3, § A.3.6,
 *  § A.3.7, § A.4. */

import {
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_MEETING_PROPERTIES,
  PLATFORM_REFERENCE_BATCH_SIZE,
  type ConnectionRecord,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementRow,
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
  byteSizeOf,
  canonicalizeEmail,
  deriveAuthorshipBase,
  deriveMeetingLifecycleState,
  fetchHubSpotEngagementAssociations,
  hubSpotEngagementTargetIdFor,
  isInternalDomain,
  parseEmailList,
  parseUnixMs,
  pickInlineBodyState,
  resolveEngagementTzHint,
  ENGAGEMENT_BODY_INLINE_MAX_BYTES,
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

/** Calendar-twin lookup callback. Returns the matched calendar row id
 *  + the match key + an optional IANA tz from the calendar adapter
 *  (§ A.3.7 — populates `event_at_tz_hint`). */
export interface CalendarTwinMatch {
  calendar_id: string;
  calendar_connection_id?: string;
  match_key: string;
  /** IANA tz from the calendar adapter. Populates
   *  `EngagementRow.event_at_tz_hint` per § A.3.7. */
  tz_hint?: string;
}

export interface CalendarTwinMatcherInput {
  /** `hs_meeting_external_url` when present — primary match key. */
  external_url?: string;
  /** Meeting title — fallback match. */
  title?: string;
  /** Canonical attendee emails. */
  attendee_emails: ReadonlyArray<string>;
  /** Meeting start time — unix-ms UTC. */
  start_time: number | null;
}

export type CalendarTwinFinder = (
  input: CalendarTwinMatcherInput,
) => CalendarTwinMatch | null;

export interface HubSpotMeetingEngagementReconcilerDeps {
  search: HubSpotSearchDeps;
  engagementStore: EngagementStore;
  /** Calendar-twin lookup. Default: returns null (no calendar adapter
   *  → every row lands as inline_body / none per body length). */
  calendarTwinFinder?: CalendarTwinFinder;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  connectionUserOwnerId?: string;
  internalEmailDomains?: ReadonlyArray<string>;
  defaultTzHint?: string;
  /** D-139 P1a.1.2 — `prefs.timezone` reader for the § A.3.7 fallback
   *  chain. See `engagement-shared.ts#resolveEngagementTzHint`. */
  prefsTimezone?: () => string | null | undefined;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

export interface HubSpotMeetingEngagementSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class HubSpotMeetingEngagementReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'meeting' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotMeetingEngagementReconcilerDeps;

  constructor(deps: HubSpotMeetingEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotMeetingEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'meetings',
        properties: HUBSPOT_MEETING_PROPERTIES as unknown as ReadonlyArray<string>,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: `hubspot_meeting_${raw.id}`,
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: HubSpotMeetingEngagementSlimRecord,
    crmAssociations?: EngagementCrmAssociations,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const matchInput = buildCalendarTwinMatcherInput(slim._raw);
    const match =
      this.deps.calendarTwinFinder !== undefined && matchInput !== null
        ? this.deps.calendarTwinFinder(matchInput)
        : null;

    const row = projectMeetingEngagementRow(connection_id, slim._raw, {
      now: this.now(),
      calendarTwinMatch: match,
      connectionUserOwnerId: this.deps.connectionUserOwnerId,
      internalEmailDomains: this.deps.internalEmailDomains,
      defaultTzHint: this.deps.defaultTzHint,
      prefsTimezone: this.deps.prefsTimezone,
    });

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const edges: Array<Parameters<EngagementStore['upsertEdge']>[0]> = [];
    const attendees = parseEmailList(slim._raw.properties.attendee_emails);
    for (const email of attendees) {
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
    if (match) {
      edges.push({
        connection_id,
        engagement_target_id: row.target_id,
        edge_type: 'calendar_twin',
        target_kind: 'data.calendar',
        target_id: match.calendar_id,
        vendor: 'hubspot',
        created_at: this.now(),
      });
    }
    // P1a.1.1 — emit deal + account edges from the CRM-side
    // associations (§ A.4). HubSpot meetings expose deals/companies
    // through the same `/associations/` endpoint as emails.
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

    const result = this.deps.engagementStore.ingestEngagementWithEdges({
      row,
      edges,
      now: this.now(),
    });

    return {
      row: result.row,
      emittedEdgeCount: result.edges_upserted,
      edgesTombstoned: result.edges_tombstoned,
      staleModstamp: result.stale_modstamp,
    };
  }

  /** D-139 P1a.1.2 — async wrapper mirroring the email reconciler's
   *  Codex P1 #3 fold-back shape. See `note-engagement-reconciler.ts`
   *  for the rationale + retry semantics. The calendar-twin matcher
   *  runs INSIDE the synchronous `ingest()` against the supplied
   *  finder dep — the wrapper only handles the CRM associations leg. */
  async ingestWithAssociations(
    connection: ConnectionRecord,
    connection_id: string,
    slim: HubSpotMeetingEngagementSlimRecord,
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
        entity: 'meeting',
        raw_id: slim._raw.id,
        search: this.deps.search,
      });
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
      crmAssociations = undefined;
    }
    const result = this.ingest(connection_id, slim, crmAssociations);
    return {
      ...result,
      associations_fetched: crmAssociations !== undefined,
    };
  }

  /** D-184 — harness self-ingest hook (see email reconciler). Delegates to
   *  `ingestWithAssociations`; the cast to the concrete slim type is sound
   *  because the harness only feeds back what `listUpdatedSince` yielded. */
  async selfIngest(
    connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): Promise<void> {
    await this.ingestWithAssociations(
      connection,
      connection_name,
      record as HubSpotMeetingEngagementSlimRecord,
    );
  }

  /** D-184 — per-record associations GET ⇒ `pages + processed` (see email). */
  apiCallsFor(processed: number, pages: number): number {
    return pages + processed;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

const buildCalendarTwinMatcherInput = (
  raw: RawHubSpotRecord,
): CalendarTwinMatcherInput | null => {
  const externalUrl = raw.properties.hs_meeting_external_url;
  const attendees = parseEmailList(raw.properties.attendee_emails);
  const startTime = parseUnixMs(raw.properties.hs_meeting_start_time);
  // Need at least one of: external_url, attendees, or start_time to
  // run the matcher. Empty all three → skip.
  if (
    (externalUrl === undefined || externalUrl === null || externalUrl === '') &&
    attendees.length === 0 &&
    startTime === null
  ) {
    return null;
  }
  const out: CalendarTwinMatcherInput = {
    attendee_emails: attendees,
    start_time: startTime,
  };
  if (externalUrl) out.external_url = externalUrl;
  if (raw.properties.hs_meeting_title) out.title = raw.properties.hs_meeting_title;
  return out;
};

// ────────────────────────────────────────────────────────────────
// Pure projection functions (exported for unit testing)
// ────────────────────────────────────────────────────────────────

export interface ProjectMeetingEngagementRowInput {
  now: number;
  calendarTwinMatch: CalendarTwinMatch | null;
  connectionUserOwnerId?: string;
  internalEmailDomains?: ReadonlyArray<string>;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectMeetingEngagementRow = (
  connection_id: string,
  raw: RawHubSpotRecord,
  input: ProjectMeetingEngagementRowInput,
): EngagementRow => {
  const startTime = parseUnixMs(raw.properties.hs_meeting_start_time);
  const lifecycle_state = deriveMeetingLifecycleState(
    raw.properties.hs_meeting_outcome,
    startTime,
    input.now,
  );
  const event_at = deriveMeetingEventAt(lifecycle_state, startTime);
  const vendor_created_at =
    parseUnixMs(raw.properties.hs_createdate) ?? input.now;
  const vendor_modified_at =
    parseUnixMs(raw.properties.hs_lastmodifieddate) ?? vendor_created_at;
  const direction = deriveMeetingDirection(
    raw,
    input.connectionUserOwnerId,
    input.internalEmailDomains ?? [],
  );
  const authorship = deriveAuthorshipBase(raw, input.connectionUserOwnerId);

  const meta: Record<string, unknown> = {};
  if (raw.properties.hs_meeting_title) meta.title = raw.properties.hs_meeting_title;
  if (startTime !== null) meta.start_time = startTime;
  const endTime = parseUnixMs(raw.properties.hs_meeting_end_time);
  if (endTime !== null) meta.end_time = endTime;
  if (raw.properties.hs_meeting_outcome)
    meta.outcome = raw.properties.hs_meeting_outcome;
  if (raw.properties.hs_meeting_location)
    meta.location = raw.properties.hs_meeting_location;
  if (raw.properties.hs_meeting_external_url)
    meta.external_url = raw.properties.hs_meeting_external_url;
  const attendees = parseEmailList(raw.properties.attendee_emails);
  if (attendees.length > 0) meta.attendee_emails = attendees;
  if (raw.properties.hubspot_owner_id) {
    meta.owner = `hubspot_owner_id:${raw.properties.hubspot_owner_id}`;
  }

  // Body-state machine: calendar-twin first, then inline body fallback.
  const body = raw.properties.hs_meeting_body ?? '';
  const bodyState = input.calendarTwinMatch !== null
    ? { body_state: 'calendar_link' as const }
    : pickInlineBodyState(body);

  const dedupe_confidence: DedupeConfidence = 'none';

  const row: EngagementRow = {
    connection_id,
    target_id: `hubspot_meeting_${raw.id}`,
    vendor: 'hubspot',
    entity: 'meeting',
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
    body_state: bodyState.body_state,
  };
  if (startTime !== null) row.scheduled_start_at = startTime;
  if (raw.properties.hs_lastmodifieddate)
    row.vendor_modstamp = raw.properties.hs_lastmodifieddate;
  if (raw.properties.hs_meeting_start_time) {
    row.vendor_raw_timestamp = raw.properties.hs_meeting_start_time;
  }
  // § A.3.7 — calendar-twin TZ wins; fallback chain (P1a.1.2): vendor
  // → calendar adapter (twin) → prefs → UTC. The calendar twin's
  // `tz_hint` is the canonical "calendar adapter" step; defaultTzHint
  // is the prior-step legacy slot kept for callers that pre-resolve.
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint:
      input.calendarTwinMatch?.tz_hint ?? input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if ('body_inline' in bodyState && bodyState.body_inline !== undefined) {
    row.body_inline = bodyState.body_inline;
  }
  if (
    'body_truncation_offset' in bodyState &&
    bodyState.body_truncation_offset !== undefined
  ) {
    row.body_truncation_offset = bodyState.body_truncation_offset;
  }
  return row;
};

// ────────────────────────────────────────────────────────────────
// event_at derivation (§ A.3.1)
// ────────────────────────────────────────────────────────────────

export const deriveMeetingEventAt = (
  lifecycle_state: EngagementLifecycleState,
  startTime: number | null,
): number | null => {
  // 'completed' is the only state where the meeting is engagement
  // evidence; everything else (scheduled / rescheduled / cancelled)
  // → null.
  if (lifecycle_state !== 'completed') return null;
  return startTime;
};

// ────────────────────────────────────────────────────────────────
// Direction derivation (§ A.3.3)
// ────────────────────────────────────────────────────────────────

export const deriveMeetingDirection = (
  raw: RawHubSpotRecord,
  connectionUserOwnerId: string | undefined,
  internalDomains: ReadonlyArray<string>,
): Direction => {
  const attendees = parseEmailList(raw.properties.attendee_emails);
  if (attendees.length === 0) return 'unknown';

  const allInternal =
    internalDomains.length > 0 &&
    attendees.every((e) => isInternalDomain(e, internalDomains));
  if (allInternal) return 'internal';

  const anyExternal =
    internalDomains.length > 0 &&
    attendees.some((e) => !isInternalDomain(e, internalDomains));

  if (!anyExternal) return 'unknown';

  // Has external attendees — direction depends on who created the
  // meeting. Internal-user-owned → outbound (rep scheduled);
  // external-owned → inbound (prospect-initiated).
  const ownerId = raw.properties.hubspot_owner_id ?? '';
  if (
    typeof connectionUserOwnerId === 'string' &&
    connectionUserOwnerId.length > 0 &&
    ownerId === connectionUserOwnerId
  ) {
    return 'outbound';
  }
  // Owner-id present + external attendees: substrate can't tell from
  // owner_id alone whether the owner is internal vs external (HubSpot
  // doesn't expose owner email directly here). Default 'outbound'
  // when an internal owner-id is present (rep scheduled the meeting),
  // else 'unknown'. Producers may override.
  if (ownerId.length > 0) return 'outbound';
  return 'unknown';
};

// Re-export so consumers can see the byte-size cap.
export { ENGAGEMENT_BODY_INLINE_MAX_BYTES };
// Reference byteSizeOf so tooling doesn't drop the helper import.
void byteSizeOf;
