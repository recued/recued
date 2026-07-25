/** D-139 Phase 1a.2 — HubSpot task-engagement reconciler.
 *
 *  Lifecycle per § A.3.6 — `hs_task_status` drives state machine:
 *    - NOT_STARTED / IN_PROGRESS / WAITING / empty → 'pending'
 *    - COMPLETED → 'completed'
 *    - DEFERRED / CANCELED → 'cancelled'
 *
 *  `event_at` per § A.3.1: NULL while `'pending'` (a pending task is
 *  not engagement evidence); populates to `completed_at` when status
 *  flips to COMPLETED. The transition (pending → completed) fires
 *  cascade so aggregating producers re-evaluate.
 *
 *  `hs_task_completion_date` per HubSpot legacy: while task is
 *  incomplete it carries the *due-date*; once completed the same
 *  field carries the *completion timestamp*. The reconciler reads it
 *  both ways:
 *    - status not COMPLETED → `due_at = hs_task_completion_date`
 *    - status COMPLETED → `completed_at = hs_task_completion_date`,
 *      `event_at = completed_at`
 *
 *  § A.3.7 — date-only due dates (HubSpot ISO date strings like
 *  `'2026-05-04'`) canonicalize to UTC midnight + flip
 *  `due_at_is_date_only: true` so producers know NOT to compare
 *  against intra-day timestamps. Producers comparing "is this task
 *  overdue right now" against `due_at_is_date_only: true` rows must
 *  compare against the full local-day interval.
 *
 *  Direction per § A.3.3 — subject-verb heuristic:
 *    - subject starts with outbound-action verb (`'Email '`, `'Call '`,
 *      `'Send '`, `'Follow up'`, etc.) → 'outbound'
 *    - otherwise → 'unknown'
 *
 *  Spec: D-139 § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7, § A.4. */

import {
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_TASK_PROPERTIES,
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
  computeLocalDayMidnightUtc,
  deriveAuthorshipBase,
  deriveTaskDirectionFromSubject,
  deriveTaskLifecycleState,
  fetchHubSpotEngagementAssociations,
  hubSpotEngagementTargetIdFor,
  isDateOnlyHubSpotTimestamp,
  parseUnixMs,
  pickBodyPreview,
  pickInlineBodyState,
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

export interface HubSpotTaskEngagementReconcilerDeps {
  search: HubSpotSearchDeps;
  engagementStore: EngagementStore;
  resolveContactRedirect?: ContactRedirectLookup;
  expandContactIdentity?: ContactIdentityExpansion;
  connectionUserOwnerId?: string;
  defaultTzHint?: string;
  /** D-139 P1a.1.2 — `prefs.timezone` reader for the § A.3.7 fallback
   *  chain. See `engagement-shared.ts#resolveEngagementTzHint`. */
  prefsTimezone?: () => string | null | undefined;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

export interface HubSpotTaskEngagementSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class HubSpotTaskEngagementReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'task' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotTaskEngagementReconcilerDeps;

  constructor(deps: HubSpotTaskEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotTaskEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'tasks',
        properties: HUBSPOT_TASK_PROPERTIES as unknown as ReadonlyArray<string>,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: `hubspot_task_${raw.id}`,
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: HubSpotTaskEngagementSlimRecord,
    crmAssociations?: EngagementCrmAssociations,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const row = projectTaskEngagementRow(connection_id, slim._raw, {
      now: this.now(),
      connectionUserOwnerId: this.deps.connectionUserOwnerId,
      defaultTzHint: this.deps.defaultTzHint,
      prefsTimezone: this.deps.prefsTimezone,
    });

    const resolveContactRedirect: ContactRedirectLookup =
      this.deps.resolveContactRedirect ?? (() => null);

    const edges: Array<Parameters<EngagementStore['upsertEdge']>[0]> = [];
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
    // associations (§ A.4). Tasks don't carry header / attendee email
    // metadata; CRM associations are the only deal/account path.
    // Contact-edge emission for tasks is OUT OF SCOPE at P1a.1.1 (see
    // note-engagement-reconciler.ts for rationale).
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

    void resolveContactRedirect;

    return {
      row: result.row,
      emittedEdgeCount: result.edges_upserted,
      edgesTombstoned: result.edges_tombstoned,
      staleModstamp: result.stale_modstamp,
    };
  }

  /** D-139 P1a.1.2 — async wrapper mirroring the email reconciler's
   *  Codex P1 #3 fold-back shape. See `note-engagement-reconciler.ts`
   *  for the rationale + retry semantics. */
  async ingestWithAssociations(
    connection: ConnectionRecord,
    connection_id: string,
    slim: HubSpotTaskEngagementSlimRecord,
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
        entity: 'task',
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
      record as HubSpotTaskEngagementSlimRecord,
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

// ────────────────────────────────────────────────────────────────
// Pure projection functions (exported for unit testing)
// ────────────────────────────────────────────────────────────────

export interface ProjectTaskEngagementRowInput {
  now: number;
  connectionUserOwnerId?: string;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectTaskEngagementRow = (
  connection_id: string,
  raw: RawHubSpotRecord,
  input: ProjectTaskEngagementRowInput,
): EngagementRow => {
  const status = (raw.properties.hs_task_status ?? '').toUpperCase();
  const lifecycle_state = deriveTaskLifecycleState(status);
  // Codex review fold (P2 #5) — § A.3.1 declares
  // `hs_task_completion_date OR hs_timestamp per Developer-Portal
  // mapping per-portal` as the due-date source. Fall back to
  // `hs_timestamp` when `hs_task_completion_date` is empty so portals
  // surfacing the alternate field still populate `due_at`.
  const completionRaw =
    raw.properties.hs_task_completion_date &&
    raw.properties.hs_task_completion_date !== ''
      ? raw.properties.hs_task_completion_date
      : raw.properties.hs_timestamp;
  const completionDateOnly = isDateOnlyHubSpotTimestamp(completionRaw);
  // P1a.1.1 (carry-forward from P1a.2 Codex P2 #2) — date-only HubSpot
  // due-dates canonicalize to wall-clock midnight in the user's local
  // tz, NOT UTC midnight. For users east of UTC the difference matters:
  // Berlin user with a task due `'2026-05-04'` has it overdue starting
  // at 2026-05-03T22:00:00Z, not 2026-05-04T00:00:00Z. UTC midnight
  // misses the entire local-tz day for east-of-UTC users.
  // `parseUnixMs` falls back to `Date.parse` which lands at UTC
  // midnight; the helper below corrects that for date-only strings.
  //
  // P1a.1.2 — § A.3.7 fallback chain widening (Codex P2 #4 carry-
  // forward). The completion tz pivots through the same chain as
  // `event_at_tz_hint` (vendor → calendar adapter → prefs → UTC) so
  // a user with `prefs.timezone = 'Europe/Berlin'` sees their tasks
  // computed against Berlin midnight even when no `defaultTzHint`
  // is supplied. The resolver's `inferred` flag flips
  // `event_at_tz_inferred = true` when the entire chain falls
  // through to UTC.
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  const completionTz = resolvedTz.tz;
  const completionMs = completionDateOnly
    ? computeLocalDayMidnightUtc(completionRaw, completionTz)
    : parseUnixMs(completionRaw);

  // hs_task_completion_date carries either due-date (incomplete tasks)
  // or completed-at (completed tasks). Branch on lifecycle_state.
  const completed_at =
    lifecycle_state === 'completed' ? completionMs : null;
  const due_at =
    lifecycle_state === 'completed' ? null : completionMs;
  const due_at_is_date_only =
    lifecycle_state === 'completed' ? false : completionDateOnly;

  // event_at = completed_at when 'completed', else NULL per § A.3.1.
  const event_at = lifecycle_state === 'completed' ? completed_at : null;

  const vendor_created_at =
    parseUnixMs(raw.properties.hs_createdate) ?? input.now;
  const vendor_modified_at =
    parseUnixMs(raw.properties.hs_lastmodifieddate) ?? vendor_created_at;
  const direction = deriveTaskDirectionFromSubject(
    raw.properties.hs_task_subject,
  );
  const authorship = deriveAuthorshipBase(raw, input.connectionUserOwnerId);

  const meta: Record<string, unknown> = {};
  if (raw.properties.hs_task_subject)
    meta.subject = raw.properties.hs_task_subject;
  if (status) meta.status = status;
  if (raw.properties.hs_task_priority)
    meta.priority = raw.properties.hs_task_priority;
  if (raw.properties.hs_task_type) meta.type = raw.properties.hs_task_type;
  if (due_at !== null) meta.due_at = due_at;
  if (completed_at !== null) meta.completed_at = completed_at;
  const body = raw.properties.hs_task_body ?? '';
  const bodyPreview = pickBodyPreview(body);
  if (bodyPreview) meta.body_preview = bodyPreview;
  if (raw.properties.hubspot_owner_id) {
    meta.owner = `hubspot_owner_id:${raw.properties.hubspot_owner_id}`;
  }

  const bodyState = pickInlineBodyState(body);
  const dedupe_confidence: DedupeConfidence = 'none';

  const row: EngagementRow = {
    connection_id,
    target_id: `hubspot_task_${raw.id}`,
    vendor: 'hubspot',
    entity: 'task',
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
  if (due_at !== null) row.due_at = due_at;
  if (due_at !== null) row.due_at_is_date_only = due_at_is_date_only;
  if (completed_at !== null) row.completed_at = completed_at;
  if (raw.properties.hs_lastmodifieddate)
    row.vendor_modstamp = raw.properties.hs_lastmodifieddate;
  if (raw.properties.hs_task_completion_date) {
    row.vendor_raw_timestamp = raw.properties.hs_task_completion_date;
  }
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if (bodyState.body_inline !== undefined) row.body_inline = bodyState.body_inline;
  if (bodyState.body_truncation_offset !== undefined) {
    row.body_truncation_offset = bodyState.body_truncation_offset;
  }
  return row;
};

// Re-export so consumers reading direction logic see the type.
export type { Direction };
// Reference helper so import doesn't drop on tooling.
void deriveTaskLifecycleState;
