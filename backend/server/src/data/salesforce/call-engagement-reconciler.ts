/** D-139 Phase 1b — Salesforce VoiceCall / CallHistory reconciler.
 *
 *  Polymorphic across Service Cloud Voice (`VoiceCall` SObject) and
 *  legacy Service Cloud (`CallHistory` SObject) per Pass-5 R5.11.
 *  The describe-probe at enrollment picks the available variant; the
 *  reconciler dispatches on `entity` ('voice_call' | 'call_history')
 *  and projects the appropriate field set.
 *
 *  Lifecycle is always `'point_in_time'` per § A.3.6 — calls record
 *  what happened, not what's scheduled. `event_at = CallStartDateTime`
 *  per § A.3.1.
 *
 *  Direction from `CallType` (`'INBOUND'` / `'OUTBOUND'` / `'INTERNAL'`)
 *  per § A.3.3.
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7, Pass-5 R5.11. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_VOICE_CALL_FIELDS,
  SALESFORCE_CALL_HISTORY_FIELDS,
  type ConnectionRecord,
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
  deriveSalesforceCallDirection,
  deriveSalesforceCallLifecycleState,
  extractIsoOffsetTzHint,
  parseIsoMs,
  pickInlineBodyState,
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

export type SalesforceCallEntity = 'voice_call' | 'call_history';

export interface SalesforceCallEngagementSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

export interface SalesforceCallEngagementReconcilerDeps {
  search: SalesforceSearchDeps;
  engagementStore: EngagementStore;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  authorship: SalesforceAuthorshipDeps;
  prefsTimezone?: () => string | null | undefined;
  defaultTzHint?: string;
  /** Which call entity this reconciler instance handles — picked at
   *  enrollment by the dual-schema probe per Pass-5 R5.11. The boot
   *  wire constructs one instance with `entity: 'voice_call'` when
   *  the probe winning entity is voice_call; otherwise
   *  `'call_history'`. */
  callEntity: SalesforceCallEntity;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceCallEngagementReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity: SalesforceCallEntity;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceCallEngagementReconcilerDeps;

  constructor(deps: SalesforceCallEngagementReconcilerDeps) {
    this.deps = deps;
    this.entity = deps.callEntity;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceCallEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildCallEngagementSoql(this.entity, cursor, pageLimit);
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
        id: salesforceEngagementTargetIdFor(this.entity, id),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: SalesforceCallEngagementSlimRecord,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const row = projectCallEngagementRow(this.entity, connection_id, slim._raw, {
      now: this.now(),
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
    // VoiceCall has direct ContactId / AccountId / OpportunityId
    // pointers (Service Cloud Voice's data model is richer than
    // legacy CallHistory). When present, emit edges directly without
    // going through WhoId/WhatId polymorphism.
    if (this.entity === 'voice_call') {
      const contactId = readSalesforceId(slim._raw.ContactId);
      if (contactId !== null) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'contact',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId('salesforce', 'contact', connection_id, contactId),
          vendor: 'salesforce',
          created_at: this.now(),
          resolveContactRedirect,
        });
      }
      const accountId = readSalesforceId(slim._raw.AccountId);
      if (accountId !== null) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'account',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId('salesforce', 'account', connection_id, accountId),
          vendor: 'salesforce',
          created_at: this.now(),
        });
      }
      const opportunityId = readSalesforceId(slim._raw.OpportunityId);
      if (opportunityId !== null) {
        edges.push({
          connection_id,
          engagement_target_id: row.target_id,
          edge_type: 'deal',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId('salesforce', 'opportunity', connection_id, opportunityId),
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
    this.ingest(connection_name, record as SalesforceCallEngagementSlimRecord);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition
// ────────────────────────────────────────────────────────────────

export const buildCallEngagementSoql = (
  entity: SalesforceCallEntity,
  cursor: number,
  limit: number,
): string => {
  const fields =
    entity === 'voice_call'
      ? SALESFORCE_VOICE_CALL_FIELDS.join(', ')
      : SALESFORCE_CALL_HISTORY_FIELDS.join(', ');
  const sobjectName = entity === 'voice_call' ? 'VoiceCall' : 'CallHistory';
  const baseClauses = [`SELECT ${fields}`, `FROM ${sobjectName}`];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// Pure projection
// ────────────────────────────────────────────────────────────────

export interface ProjectCallEngagementRowInput {
  now: number;
  authorship: SalesforceAuthorshipDeps;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectCallEngagementRow = (
  entity: SalesforceCallEntity,
  connection_id: string,
  raw: RawSalesforceRecord,
  input: ProjectCallEngagementRowInput,
): EngagementRow => {
  const lifecycle_state = deriveSalesforceCallLifecycleState();
  const startTime = parseIsoMs(raw.CallStartDateTime);
  const event_at = startTime;
  const vendor_created_at = parseIsoMs(raw.CreatedDate) ?? input.now;
  const vendor_modified_at =
    parseIsoMs(raw.LastModifiedDate) ?? vendor_created_at;
  const vendorTzHint =
    extractIsoOffsetTzHint(raw.CallStartDateTime) ??
    extractIsoOffsetTzHint(raw.LastModifiedDate);

  const direction: Direction = deriveSalesforceCallDirection(raw.CallType);
  const authorship = deriveSalesforceAuthorship({
    ownerId: raw.OwnerId,
    createdById: raw.CreatedById,
    deps: input.authorship,
  });

  const meta: Record<string, unknown> = {};
  if (typeof raw.CallType === 'string' && raw.CallType.length > 0) {
    meta.call_type = raw.CallType;
  }
  const duration = readSalesforceNumber(raw.CallDurationInSeconds);
  if (duration !== null) meta.duration_seconds = duration;
  if (startTime !== null) meta.start_at = startTime;
  if (entity === 'voice_call') {
    if (typeof raw.CallSubject === 'string' && raw.CallSubject.length > 0) {
      meta.call_subject = raw.CallSubject;
    }
    if (typeof raw.CallDisposition === 'string' && raw.CallDisposition.length > 0) {
      meta.call_disposition = raw.CallDisposition;
    }
    if (typeof raw.CallObject === 'string' && raw.CallObject.length > 0) {
      meta.call_object = raw.CallObject;
    }
    if (typeof raw.CallerNumber === 'string' && raw.CallerNumber.length > 0) {
      meta.caller_number = raw.CallerNumber;
    }
    const endTime = parseIsoMs(raw.CallEndDateTime);
    if (endTime !== null) meta.end_at = endTime;
    const contactId = readSalesforceId(raw.ContactId);
    if (contactId !== null) meta.contact_id = contactId;
    const accountId = readSalesforceId(raw.AccountId);
    if (accountId !== null) meta.account_id = accountId;
    const opportunityId = readSalesforceId(raw.OpportunityId);
    if (opportunityId !== null) meta.opportunity_id = opportunityId;
  }
  const owner = readSalesforceId(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;

  // Calls have no body field.
  const bodyState = pickInlineBodyState('');

  const row: EngagementRow = {
    connection_id,
    target_id: salesforceEngagementTargetIdFor(
      entity,
      readSalesforceId(raw.Id) ?? '',
    ),
    vendor: 'salesforce',
    entity,
    meta,
    mirror_blob_hash: null,
    authorship,
    direction,
    dedupe_confidence: 'none',
    lifecycle_state,
    event_at,
    vendor_created_at,
    vendor_modified_at,
    ingested_at: input.now,
    body_state: bodyState.body_state,
  };
  if (typeof raw.SystemModstamp === 'string')
    row.vendor_modstamp = raw.SystemModstamp;
  else if (typeof raw.LastModifiedDate === 'string')
    row.vendor_modstamp = raw.LastModifiedDate;
  if (typeof raw.CallStartDateTime === 'string') {
    row.vendor_raw_timestamp = raw.CallStartDateTime;
  }

  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  return row;
};
