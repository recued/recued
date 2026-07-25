/** D-139 Phase 1b — Salesforce Event engagement reconciler.
 *
 *  Mirror-shape with the HubSpot meeting reconciler — same lifecycle
 *  state machine driven by `StartDateTime` vs now: future →
 *  'scheduled', past → 'completed' per § A.3.6.
 *
 *  Direction per § A.3.3 — attendee-set internal-domain analysis. The
 *  primary attendee surface is EventRelation (junction object) when
 *  available + queryable; the WhoId fallback is single-attendee.
 *  When EventRelation isn't queryable, the substrate flags
 *  `coverage.sources_unavailable: ['salesforce.event_relation']` on
 *  every downstream enrichment depending on multi-attendee fan-out.
 *
 *  Calendar-twin matcher: optional. Salesforce events with a calendar
 *  adapter wired (Google Calendar / Outlook / etc.) match on
 *  start-time + attendee-overlap; sets `body_state = 'calendar_link'`
 *  + emits `engagement_edges` row of type `calendar_twin`. The
 *  calendar adapter's `timeZone` populates `event_at_tz_hint` per
 *  § A.3.7.
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_EVENT_FIELDS,
  type ConnectionRecord,
  type DedupeConfidence,
  composePlatformRecordTargetId,
  type Direction,
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
  deriveSalesforceAuthorship,
  deriveSalesforceEventLifecycleState,
  extractIsoOffsetTzHint,
  parseIsoMs,
  pickInlineBodyState,
  readSalesforceBoolean,
  readSalesforceId,
  readSalesforceNumber,
  salesforceEngagementTargetIdFor,
  type SalesforceAuthorshipDeps,
} from './engagement-shared.js';
import {
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';
import { resolveEngagementTzHint } from '../hubspot/engagement-shared.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface CalendarTwinMatch {
  calendar_id: string;
  calendar_connection_id?: string;
  match_key: string;
  tz_hint?: string;
}

export interface CalendarTwinMatcherInput {
  subject?: string;
  attendee_emails: ReadonlyArray<string>;
  start_time: number | null;
}

export type CalendarTwinFinder = (
  input: CalendarTwinMatcherInput,
) => CalendarTwinMatch | null;

export interface SalesforceEventEngagementSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

export interface SalesforceEventEngagementReconcilerDeps {
  search: SalesforceSearchDeps;
  engagementStore: EngagementStore;
  calendarTwinFinder?: CalendarTwinFinder;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  authorship: SalesforceAuthorshipDeps;
  internalEmailDomains?: ReadonlyArray<string>;
  prefsTimezone?: () => string | null | undefined;
  defaultTzHint?: string;
  /** When EventRelation is unavailable, the parent reconciler emits
   *  WhoId/WhatId-fallback edges. Defaults to true (EventRelation
   *  unavailable). When false, the EventRelationReconciler runs
   *  separately + emits per-junction rows. */
  eventRelationFallbackEdges?: boolean;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceEventEngagementReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'event' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceEventEngagementReconcilerDeps;

  constructor(deps: SalesforceEventEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceEventEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildEventEngagementSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      const id = readSalesforceId(raw.Id);
      if (id === null) continue;
      yield {
        id: salesforceEngagementTargetIdFor('event', id),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: SalesforceEventEngagementSlimRecord,
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

    const row = projectEventEngagementRow(connection_id, slim._raw, {
      now: this.now(),
      calendarTwinMatch: match,
      authorship: this.deps.authorship,
      defaultTzHint: this.deps.defaultTzHint,
      prefsTimezone: this.deps.prefsTimezone,
    });

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const edges: Array<Parameters<EngagementStore['upsertEdge']>[0]> = [];
    const owner = readSalesforceId(slim._raw.OwnerId);
    if (owner !== null) {
      edges.push({
        connection_id,
        engagement_target_id: row.target_id,
        edge_type: 'owner',
        target_kind: 'user',
        target_id: `salesforce_user:${owner}`,
        vendor: 'salesforce',
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
        vendor: 'salesforce',
        created_at: this.now(),
      });
    }
    const fallbackEnabled = this.deps.eventRelationFallbackEdges !== false;
    if (fallbackEnabled) {
      const whoId = readSalesforceId(slim._raw.WhoId);
      if (whoId !== null) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'contact',
          target_kind: 'connection.api',
          target_id: `salesforce_who_${whoId}`,
          vendor: 'salesforce',
          created_at: this.now(),
          resolveContactRedirect,
        });
      }
      const whatId = readSalesforceId(slim._raw.WhatId);
      if (whatId !== null) {
        const isOpportunity = whatId.startsWith('006');
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: isOpportunity ? 'deal' : 'account',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId(
            'salesforce',
            isOpportunity ? 'opportunity' : 'account',
            connection_id,
            whatId,
          ),
          vendor: 'salesforce',
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

  /** D-184 — harness self-ingest hook (see task reconciler). SF SOQL walk
   *  carries every field (no per-record fetch), so it keeps the harness
   *  default `pages` api-call accounting. The cast to the concrete slim
   *  type is sound — the harness only feeds back what `listUpdatedSince`
   *  yielded. */
  selfIngest(
    _connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): void {
    this.ingest(connection_name, record as SalesforceEventEngagementSlimRecord);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition
// ────────────────────────────────────────────────────────────────

export const buildEventEngagementSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_EVENT_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM Event`];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

const buildCalendarTwinMatcherInput = (
  raw: RawSalesforceRecord,
): CalendarTwinMatcherInput | null => {
  const subject = typeof raw.Subject === 'string' ? raw.Subject : undefined;
  const startTime = parseIsoMs(raw.StartDateTime);
  if (subject === undefined && startTime === null) return null;
  const out: CalendarTwinMatcherInput = {
    attendee_emails: [], // Filled in by EventRelationReconciler; substrate v1 has no attendee list at parent level.
    start_time: startTime,
  };
  if (subject !== undefined) out.subject = subject;
  return out;
};

// ────────────────────────────────────────────────────────────────
// Pure projection
// ────────────────────────────────────────────────────────────────

export interface ProjectEventEngagementRowInput {
  now: number;
  calendarTwinMatch: CalendarTwinMatch | null;
  authorship: SalesforceAuthorshipDeps;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectEventEngagementRow = (
  connection_id: string,
  raw: RawSalesforceRecord,
  input: ProjectEventEngagementRowInput,
): EngagementRow => {
  const startTime = parseIsoMs(raw.StartDateTime);
  const lifecycle_state = deriveSalesforceEventLifecycleState(startTime, input.now);
  const event_at = lifecycle_state === 'completed' ? startTime : null;
  const vendor_created_at = parseIsoMs(raw.CreatedDate) ?? input.now;
  const vendor_modified_at =
    parseIsoMs(raw.LastModifiedDate) ?? vendor_created_at;
  const vendorTzHint =
    extractIsoOffsetTzHint(raw.StartDateTime) ??
    extractIsoOffsetTzHint(raw.LastModifiedDate);

  const authorship = deriveSalesforceAuthorship({
    ownerId: raw.OwnerId,
    createdById: raw.CreatedById,
    deps: input.authorship,
  });
  // Direction is 'unknown' by default at the parent reconciler — the
  // EventRelationReconciler refines it via attendee-set internal-
  // domain analysis once it lands. P1b parent-only path stamps
  // 'unknown' for events without explicit attendee data.
  const direction: Direction = 'unknown';

  const meta: Record<string, unknown> = {};
  if (typeof raw.Subject === 'string' && raw.Subject.length > 0) {
    meta.subject = raw.Subject;
  }
  const description =
    typeof raw.Description === 'string' ? raw.Description : '';
  if (description.length > 0) {
    meta.description = description.slice(0, 256);
  }
  if (startTime !== null) meta.start_at = startTime;
  const endTime = parseIsoMs(raw.EndDateTime);
  if (endTime !== null) meta.end_at = endTime;
  const duration = readSalesforceNumber(raw.DurationInMinutes);
  if (duration !== null) meta.duration_minutes = duration;
  if (typeof raw.Location === 'string' && raw.Location.length > 0) {
    meta.location = raw.Location;
  }
  const isAllDay = readSalesforceBoolean(raw.IsAllDayEvent);
  if (isAllDay !== null) meta.is_all_day = isAllDay ? 'true' : 'false';
  const owner = readSalesforceId(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;
  const whoId = readSalesforceId(raw.WhoId);
  if (whoId !== null) meta.who_id = whoId;
  const whatId = readSalesforceId(raw.WhatId);
  if (whatId !== null) meta.what_id = whatId;

  // Body-state machine: calendar-twin > inline body > none.
  const bodyState = input.calendarTwinMatch !== null
    ? { body_state: 'calendar_link' as const }
    : pickInlineBodyState(description);

  const dedupe_confidence: DedupeConfidence = 'none';

  const row: EngagementRow = {
    connection_id,
    target_id: salesforceEngagementTargetIdFor(
      'event',
      readSalesforceId(raw.Id) ?? '',
    ),
    vendor: 'salesforce',
    entity: 'event',
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
  if (typeof raw.SystemModstamp === 'string')
    row.vendor_modstamp = raw.SystemModstamp;
  else if (typeof raw.LastModifiedDate === 'string')
    row.vendor_modstamp = raw.LastModifiedDate;
  if (typeof raw.StartDateTime === 'string') {
    row.vendor_raw_timestamp = raw.StartDateTime;
  }
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint,
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
