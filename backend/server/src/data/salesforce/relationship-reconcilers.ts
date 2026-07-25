/** D-139 Phase 1b — Salesforce relationship-object reconcilers.
 *
 *  Three junction objects per § A.2.1:
 *    - **TaskRelation** — Task → multiple Contacts / Leads / Accounts
 *      / Opportunities. `RelationId` is the joined record;
 *      `IsWhat = false` for who-relations (Contact / Lead),
 *      `true` for what-relations (Account / Opportunity / etc.).
 *    - **EventRelation** — Event → multiple attendees + linked
 *      records. Same shape as TaskRelation; adds `Status` /
 *      `Response` for attendee invitations.
 *    - **EmailMessageRelation** — EmailMessage → recipients + linked
 *      records. `RelationType` is `'FromAddress'` /
 *      `'ToAddress'` / `'CcAddress'` / `'BccAddress'` /
 *      `'OtherAddress'`; `RelationAddress` is the email; `RelationId`
 *      is a Contact / Lead Id when matched by Salesforce.
 *
 *  Each reconciler joins through to the parent SObject's id + emits
 *  one `engagement_edges` row per junction record. The composite
 *  UNIQUE on `(connection_id, engagement_target_id, edge_type,
 *  target_id)` ensures idempotent re-ingest. When a relation row
 *  is deleted (`IsDeleted = true`), the next reconciler cycle's
 *  diff against `engagement_edges` flips the row's `deleted_at`
 *  via `tombstoneEdge` — the substrate's per-cycle association-
 *  rescan substrate (§ A.6.3) drives the diff.
 *
 *  These reconcilers do NOT write `EngagementRow` records — they
 *  only fan out `engagement_edges`. The parent reconciler is
 *  authoritative for the row.
 *
 *  Spec: D-139 § A.2.1, § A.4. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_TASK_RELATION_FIELDS,
  SALESFORCE_EVENT_RELATION_FIELDS,
  SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS,
  composePlatformRecordTargetId,
  type ConnectionRecord,
} from '@recued/contracts';

import type {
  ContactRedirectLookup,
  EngagementStore,
  UpsertEdgeInput,
} from '../../storage/engagement-store.js';
import type {
  ReconciliationCadence,
  SlimRecord,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  canonicalizeEmail,
  parseIsoMs,
  readSalesforceBoolean,
  readSalesforceId,
  salesforceEngagementTargetIdFor,
} from './engagement-shared.js';
import {
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Common types
// ────────────────────────────────────────────────────────────────

export interface RelationSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

export interface RelationReconcilerDeps {
  search: SalesforceSearchDeps;
  engagementStore: EngagementStore;
  resolveContactRedirect?: ContactRedirectLookup;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// TaskRelation reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceTaskRelationReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'task_relation' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;

  private readonly deps: RelationReconcilerDeps;

  constructor(deps: RelationReconcilerDeps) {
    this.deps = deps;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<RelationSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildTaskRelationSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      const id = readSalesforceId(raw.Id);
      if (id === null) continue;
      yield { id, modified_at: modifiedAt, _raw: raw };
    }
  }

  /** Emit one `engagement_edges` row per junction record. The parent
   *  Task reconciler must have ingested the parent row first; the
   *  edge insert SQL ON CONFLICT path makes re-ingest idempotent. */
  ingest(
    connection_id: string,
    slim: RelationSlimRecord,
  ): { edge_emitted: boolean; tombstoned: boolean } {
    const taskId = readSalesforceId(slim._raw.TaskId);
    const relationId = readSalesforceId(slim._raw.RelationId);
    if (taskId === null || relationId === null) {
      return { edge_emitted: false, tombstoned: false };
    }
    const isWhat = readSalesforceBoolean(slim._raw.IsWhat) === true;
    const isDeleted = readSalesforceBoolean(slim._raw.IsDeleted) === true;
    const engagement_target_id = salesforceEngagementTargetIdFor('task', taskId);

    if (isDeleted) {
      const edge_type = isWhat
        ? relationId.startsWith('006')
          ? ('deal' as const)
          : ('account' as const)
        : ('contact' as const);
      const target_kind = isWhat
        ? 'connection.api'
        : 'connection.api';
      const target_id = isWhat
        ? composePlatformRecordTargetId(
            'salesforce',
            relationId.startsWith('006') ? 'opportunity' : 'account',
            connection_id,
            relationId,
          )
        : `salesforce_who_${relationId}`;
      const tombstoned = this.deps.engagementStore.tombstoneEdge({
        connection_id,
        engagement_target_id,
        edge_type,
        target_id,
        deleted_at: this.now(),
      });
      void target_kind;
      return { edge_emitted: false, tombstoned };
    }

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const upsert: UpsertEdgeInput = isWhat
      ? {
          connection_id,
          engagement_target_id,
          edge_type: relationId.startsWith('006') ? 'deal' : 'account',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId(
            'salesforce',
            relationId.startsWith('006') ? 'opportunity' : 'account',
            connection_id,
            relationId,
          ),
          vendor: 'salesforce',
          created_at: this.now(),
        }
      : {
          connection_id,
          engagement_target_id,
          edge_type: 'contact',
          target_kind: 'connection.api',
          target_id: `salesforce_who_${relationId}`,
          vendor: 'salesforce',
          created_at: this.now(),
          resolveContactRedirect,
        };
    this.deps.engagementStore.upsertEdge(upsert);
    return { edge_emitted: true, tombstoned: false };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

export const buildTaskRelationSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_TASK_RELATION_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM TaskRelation`];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// EventRelation reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceEventRelationReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'event_relation' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;

  private readonly deps: RelationReconcilerDeps;

  constructor(deps: RelationReconcilerDeps) {
    this.deps = deps;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<RelationSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildEventRelationSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      const id = readSalesforceId(raw.Id);
      if (id === null) continue;
      yield { id, modified_at: modifiedAt, _raw: raw };
    }
  }

  ingest(
    connection_id: string,
    slim: RelationSlimRecord,
  ): { edge_emitted: boolean; tombstoned: boolean } {
    const eventId = readSalesforceId(slim._raw.EventId);
    const relationId = readSalesforceId(slim._raw.RelationId);
    if (eventId === null || relationId === null) {
      return { edge_emitted: false, tombstoned: false };
    }
    const isWhat = readSalesforceBoolean(slim._raw.IsWhat) === true;
    const isDeleted = readSalesforceBoolean(slim._raw.IsDeleted) === true;
    const engagement_target_id = salesforceEngagementTargetIdFor(
      'event',
      eventId,
    );

    if (isDeleted) {
      const edge_type = isWhat
        ? relationId.startsWith('006')
          ? ('deal' as const)
          : ('account' as const)
        : ('contact' as const);
      const target_id = isWhat
        ? composePlatformRecordTargetId(
            'salesforce',
            relationId.startsWith('006') ? 'opportunity' : 'account',
            connection_id,
            relationId,
          )
        : `salesforce_who_${relationId}`;
      const tombstoned = this.deps.engagementStore.tombstoneEdge({
        connection_id,
        engagement_target_id,
        edge_type,
        target_id,
        deleted_at: this.now(),
      });
      return { edge_emitted: false, tombstoned };
    }

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const upsert: UpsertEdgeInput = isWhat
      ? {
          connection_id,
          engagement_target_id,
          edge_type: relationId.startsWith('006') ? 'deal' : 'account',
          target_kind: 'connection.api',
          target_id: composePlatformRecordTargetId(
            'salesforce',
            relationId.startsWith('006') ? 'opportunity' : 'account',
            connection_id,
            relationId,
          ),
          vendor: 'salesforce',
          created_at: this.now(),
        }
      : {
          connection_id,
          engagement_target_id,
          edge_type: 'contact',
          target_kind: 'connection.api',
          target_id: `salesforce_who_${relationId}`,
          vendor: 'salesforce',
          created_at: this.now(),
          resolveContactRedirect,
        };
    this.deps.engagementStore.upsertEdge(upsert);
    return { edge_emitted: true, tombstoned: false };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

export const buildEventRelationSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_EVENT_RELATION_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM EventRelation`];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// EmailMessageRelation reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceEmailMessageRelationReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'email_message_relation' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;

  private readonly deps: RelationReconcilerDeps;

  constructor(deps: RelationReconcilerDeps) {
    this.deps = deps;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<RelationSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildEmailMessageRelationSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      // EmailMessageRelation uses SystemModstamp not LastModifiedDate
      // (it's an audit-only object — fields don't change after
      // create), but include a fallback to LastModifiedDate where
      // present.
      const modifiedAt =
        parseIsoMs(slim_raw_value(raw, 'SystemModstamp')) ??
        parseIsoMs(slim_raw_value(raw, 'LastModifiedDate')) ??
        parseIsoMs(slim_raw_value(raw, 'CreatedDate'));
      if (modifiedAt === null) continue;
      const id = readSalesforceId(raw.Id);
      if (id === null) continue;
      yield { id, modified_at: modifiedAt, _raw: raw };
    }
  }

  ingest(
    connection_id: string,
    slim: RelationSlimRecord,
  ): { edge_emitted: boolean; tombstoned: boolean } {
    const emailMessageId = readSalesforceId(slim._raw.EmailMessageId);
    const relationAddress =
      typeof slim._raw.RelationAddress === 'string'
        ? slim._raw.RelationAddress
        : null;
    if (emailMessageId === null || relationAddress === null) {
      return { edge_emitted: false, tombstoned: false };
    }
    const email = canonicalizeEmail(relationAddress);
    if (email === null) return { edge_emitted: false, tombstoned: false };

    const isDeleted = readSalesforceBoolean(slim._raw.IsDeleted) === true;
    const engagement_target_id = salesforceEngagementTargetIdFor(
      'email_message',
      emailMessageId,
    );

    if (isDeleted) {
      const tombstoned = this.deps.engagementStore.tombstoneEdge({
        connection_id,
        engagement_target_id,
        edge_type: 'contact',
        target_id: email,
        deleted_at: this.now(),
      });
      return { edge_emitted: false, tombstoned };
    }

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    this.deps.engagementStore.upsertEdge({
      connection_id,
      engagement_target_id,
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: email,
      vendor: 'salesforce',
      created_at: this.now(),
      resolveContactRedirect,
    });
    return { edge_emitted: true, tombstoned: false };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

export const buildEmailMessageRelationSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM EmailMessageRelation`];
  if (cursor > 0) {
    baseClauses.push(`WHERE SystemModstamp >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY SystemModstamp ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const slim_raw_value = (raw: RawSalesforceRecord, key: string): unknown =>
  (raw as Record<string, unknown>)[key];
