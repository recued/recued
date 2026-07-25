/** D-139 Phase 1b — Salesforce Task engagement reconciler.
 *
 *  Mirror-shape with the HubSpot Task reconciler — same lifecycle
 *  state machine ('pending' → 'completed' | 'cancelled') driven by
 *  the vendor-native Status field; same `event_at = NULL while
 *  pending → CompletedDateTime when completed` semantics per § A.3.1;
 *  same date-only `due_at` interpretation per § A.3.7 (Salesforce
 *  ActivityDate arrives as `'YYYY-MM-DD'` and lands as
 *  `due_at_is_date_only: true` with the local-day interval start).
 *
 *  Edges: when TaskRelation is available + the TaskRelationReconciler
 *  has populated junction rows, the per-row contact / account fan-out
 *  is many-to-many. When TaskRelation is unavailable (older orgs +
 *  schema-probe shows it not queryable), the reconciler falls back to
 *  single-WhoId/single-WhatId with `coverage.sources_unavailable:
 *  ['salesforce.task_relation']` flagged on every downstream row.
 *
 *  Spec: D-139 § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_TASK_FIELDS,
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
  deriveSalesforceTaskLifecycleState,
  extractIsoOffsetTzHint,
  parseIsoMs,
  pickInlineBodyState,
  readSalesforceId,
  salesforceEngagementTargetIdFor,
  type SalesforceAuthorshipDeps,
} from './engagement-shared.js';
import {
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';
import {
  deriveTaskDirectionFromSubject,
  resolveEngagementTzHint,
} from '../hubspot/engagement-shared.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface SalesforceTaskEngagementSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

export interface SalesforceTaskEngagementReconcilerDeps {
  search: SalesforceSearchDeps;
  engagementStore: EngagementStore;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  authorship: SalesforceAuthorshipDeps;
  /** Per-pair `prefs.timezone` reader for the § A.3.7 fallback chain. */
  prefsTimezone?: () => string | null | undefined;
  /** Default tz hint when vendor offset + prefs both fall through. */
  defaultTzHint?: string;
  /** When false, the reconciler skips emitting WhoId / WhatId
   *  fallback edges. Set when TaskRelation is queryable AND the
   *  TaskRelationReconciler runs separately — the relationship
   *  reconciler emits per-junction rows; the fallback would
   *  duplicate edges. Defaults to true (TaskRelation unavailable). */
  taskRelationFallbackEdges?: boolean;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class SalesforceTaskEngagementReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'task' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceTaskEngagementReconcilerDeps;

  constructor(deps: SalesforceTaskEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceTaskEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildTaskEngagementSoql(cursor, pageLimit);
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
        id: salesforceEngagementTargetIdFor('task', id),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: SalesforceTaskEngagementSlimRecord,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const row = projectTaskEngagementRow(connection_id, slim._raw, {
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
    // TaskRelation-fallback edge emission. When TaskRelation isn't
    // queryable for this org, the parent reconciler emits a single
    // `engagement_edges` row from WhoId (Contact / Lead) + a separate
    // row from WhatId (Account / Opportunity / etc.) using the
    // 'connection.api' target_kind for non-contact references.
    const fallbackEnabled = this.deps.taskRelationFallbackEdges !== false;
    if (fallbackEnabled) {
      const whoId = readSalesforceId(slim._raw.WhoId);
      if (whoId !== null) {
        // WhoId is Contact (003) or Lead (00Q) — both flow through
        // the connection.api target_kind so the substrate can route
        // through D-138 contact identity resolution post-D-138 P3.
        // For now use connection.api (route at edge-emit time).
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
        // WhatId routes to deal/account based on prefix. Salesforce
        // SObject prefixes: '006' = Opportunity (deal); '001' =
        // Account; everything else flows as 'account' (best-effort —
        // user can fix via Settings).
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

  /** D-184 — harness self-ingest hook. The reconciliation harness calls
   *  this per record INSTEAD of its default plain-enrichment write so
   *  engagement reconcile rides the same connection-enroll + cursor +
   *  rate-gate machinery as the record reconcilers. Delegates to the
   *  synchronous `ingest` (the SOQL walk already carries every field — no
   *  per-record fetch, so SF keeps the harness default `pages` api-call
   *  accounting and supplies no `apiCallsFor`). The `connection` arg is
   *  unused; the SOQL fields come off the slim. The cast to the concrete
   *  slim type is sound — the harness only feeds back what
   *  `listUpdatedSince` yielded. */
  selfIngest(
    _connection: ConnectionRecord,
    connection_name: string,
    record: SlimRecord,
  ): void {
    this.ingest(connection_name, record as SalesforceTaskEngagementSlimRecord);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition
// ────────────────────────────────────────────────────────────────

export const buildTaskEngagementSoql = (
  cursor: number,
  limit: number,
): string => {
  const fields = SALESFORCE_TASK_FIELDS.join(', ');
  const baseClauses = [`SELECT ${fields}`, `FROM Task`];
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

export interface ProjectTaskEngagementRowInput {
  now: number;
  authorship: SalesforceAuthorshipDeps;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectTaskEngagementRow = (
  connection_id: string,
  raw: RawSalesforceRecord,
  input: ProjectTaskEngagementRowInput,
): EngagementRow => {
  const status = typeof raw.Status === 'string' ? raw.Status : null;
  const lifecycle_state = deriveSalesforceTaskLifecycleState(status);
  const completedAt = parseIsoMs(raw.CompletedDateTime);
  const event_at = lifecycle_state === 'completed' ? completedAt : null;
  const dueAtRaw = raw.ActivityDate;
  const dueAtIsDateOnly =
    typeof dueAtRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueAtRaw);
  const dueAt = parseIsoMs(dueAtRaw);
  const vendor_created_at = parseIsoMs(raw.CreatedDate) ?? input.now;
  const vendor_modified_at =
    parseIsoMs(raw.LastModifiedDate) ?? vendor_created_at;
  const vendorTzHint =
    extractIsoOffsetTzHint(raw.LastModifiedDate) ??
    extractIsoOffsetTzHint(raw.CreatedDate);

  const authorship = deriveSalesforceAuthorship({
    ownerId: raw.OwnerId,
    createdById: raw.CreatedById,
    deps: input.authorship,
  });
  const direction: Direction = deriveTaskDirectionFromSubject(
    typeof raw.Subject === 'string' ? raw.Subject : undefined,
  );

  const meta: Record<string, unknown> = {};
  if (typeof raw.Subject === 'string' && raw.Subject.length > 0) {
    meta.subject = raw.Subject;
  }
  if (status !== null) meta.status = status;
  if (typeof raw.Priority === 'string' && raw.Priority.length > 0) {
    meta.priority = raw.Priority;
  }
  if (typeof raw.TaskSubtype === 'string' && raw.TaskSubtype.length > 0) {
    meta.task_type = raw.TaskSubtype;
  }
  if (dueAt !== null) meta.due_at = dueAt;
  if (completedAt !== null) meta.completed_at = completedAt;
  const owner = readSalesforceId(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;
  const whoId = readSalesforceId(raw.WhoId);
  if (whoId !== null) meta.who_id = whoId;
  const whatId = readSalesforceId(raw.WhatId);
  if (whatId !== null) meta.what_id = whatId;

  const body = ''; // Tasks have no body field; description lives in Description on Event but not Task
  const bodyState = pickInlineBodyState(body);

  const row: EngagementRow = {
    connection_id,
    target_id: salesforceEngagementTargetIdFor(
      'task',
      readSalesforceId(raw.Id) ?? '',
    ),
    vendor: 'salesforce',
    entity: 'task',
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
  if (dueAt !== null) {
    row.due_at = dueAt;
    if (dueAtIsDateOnly) row.due_at_is_date_only = true;
  }
  if (completedAt !== null) row.completed_at = completedAt;
  if (typeof raw.LastModifiedDate === 'string')
    row.vendor_modstamp = raw.LastModifiedDate;
  if (typeof raw.SystemModstamp === 'string') {
    // Salesforce surfaces both LastModifiedDate (user-action stamp) +
    // SystemModstamp (any system change including triggers / workflow
    // bumps); SystemModstamp is the canonical "newer wins" gate.
    row.vendor_modstamp = raw.SystemModstamp;
  }
  if (typeof raw.LastModifiedDate === 'string') {
    row.vendor_raw_timestamp = raw.LastModifiedDate;
  }

  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint,
    calendarAdapterTzHint: input.defaultTzHint,
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
