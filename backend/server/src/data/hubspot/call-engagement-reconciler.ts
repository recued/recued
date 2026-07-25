/** D-139 Phase 1a.2 — HubSpot call-engagement reconciler.
 *
 *  Lifecycle per § A.3.6 Pass-5 R5.4 — `hs_call_status` drives state:
 *    - QUEUED / IN_PROGRESS → 'pending'
 *    - COMPLETED → 'point_in_time' (engagement evidence)
 *    - NO_ANSWER → 'no_answer' (attempt happened, no connection)
 *    - FAILED → 'failed'
 *    - CANCELED / CANCELLED → 'cancelled'
 *
 *  `event_at` per § A.3.1: populated from `hs_timestamp` ONLY for
 *  states where the attempt occurred. The substrate maps NO_ANSWER's
 *  attempt timestamp into `event_at` (per § A.3.1 — "the attempt
 *  happened, just didn't connect — producer policy decides whether to
 *  count it"); producers gate via `call_outcome_acceptance` per
 *  § A.3.6.
 *
 *  Direction per § A.3.3 — `hs_call_direction` field:
 *    - INBOUND → 'inbound'
 *    - OUTBOUND → 'outbound'
 *    - empty → 'unknown'
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.2, § A.3.3, § A.3.6,
 *  § A.4. */

import {
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_CALL_PROPERTIES,
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
  deriveAuthorshipBase,
  deriveCallLifecycleState,
  fetchHubSpotEngagementAssociations,
  hubSpotEngagementTargetIdFor,
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

export interface HubSpotCallEngagementReconcilerDeps {
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

export interface HubSpotCallEngagementSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class HubSpotCallEngagementReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'call' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotCallEngagementReconcilerDeps;

  constructor(deps: HubSpotCallEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotCallEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'calls',
        properties: HUBSPOT_CALL_PROPERTIES as unknown as ReadonlyArray<string>,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: `hubspot_call_${raw.id}`,
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  ingest(
    connection_id: string,
    slim: HubSpotCallEngagementSlimRecord,
    crmAssociations?: EngagementCrmAssociations,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const row = projectCallEngagementRow(connection_id, slim._raw, {
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
    // associations (§ A.4). Calls don't carry header / attendee email
    // metadata; CRM associations are the only deal/account path.
    // Contact-edge emission for calls is OUT OF SCOPE at P1a.1.1 (see
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
    slim: HubSpotCallEngagementSlimRecord,
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
        entity: 'call',
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
      record as HubSpotCallEngagementSlimRecord,
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

export interface ProjectCallEngagementRowInput {
  now: number;
  connectionUserOwnerId?: string;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectCallEngagementRow = (
  connection_id: string,
  raw: RawHubSpotRecord,
  input: ProjectCallEngagementRowInput,
): EngagementRow => {
  const status = (raw.properties.hs_call_status ?? '').toUpperCase();
  const lifecycle_state = deriveCallLifecycleState(status);
  const event_at = deriveCallEventAt(raw, lifecycle_state);
  const vendor_created_at =
    parseUnixMs(raw.properties.hs_createdate) ?? input.now;
  const vendor_modified_at =
    parseUnixMs(raw.properties.hs_lastmodifieddate) ?? vendor_created_at;
  const direction = deriveCallDirection(raw);
  const authorship = deriveAuthorshipBase(raw, input.connectionUserOwnerId);

  const meta: Record<string, unknown> = {};
  if (raw.properties.hs_call_title) meta.title = raw.properties.hs_call_title;
  if (raw.properties.hs_call_direction)
    meta.direction = raw.properties.hs_call_direction;
  if (status) meta.status = status;
  const duration = parseDurationMs(raw.properties.hs_call_duration);
  if (duration !== null) meta.duration_ms = duration;
  if (raw.properties.hs_call_disposition)
    meta.disposition = raw.properties.hs_call_disposition;
  if (raw.properties.hs_call_recording_url)
    meta.recording_url = raw.properties.hs_call_recording_url;
  const ts = parseUnixMs(raw.properties.hs_timestamp);
  if (ts !== null) meta.timestamp = ts;
  const body = raw.properties.hs_call_body ?? '';
  const bodyPreview = pickBodyPreview(body);
  if (bodyPreview) meta.body_preview = bodyPreview;
  if (raw.properties.hubspot_owner_id) {
    meta.owner = `hubspot_owner_id:${raw.properties.hubspot_owner_id}`;
  }

  const bodyState = pickInlineBodyState(body);
  const dedupe_confidence: DedupeConfidence = 'none';

  const row: EngagementRow = {
    connection_id,
    target_id: `hubspot_call_${raw.id}`,
    vendor: 'hubspot',
    entity: 'call',
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
  if (raw.properties.hs_lastmodifieddate)
    row.vendor_modstamp = raw.properties.hs_lastmodifieddate;
  if (raw.properties.hs_timestamp) {
    row.vendor_raw_timestamp = raw.properties.hs_timestamp;
  }
  // P1a.1.2 — § A.3.7 fallback chain. Calls have no calendar context;
  // chain reduces to defaultTzHint → prefsTimezone() → UTC.
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if (bodyState.body_inline !== undefined) row.body_inline = bodyState.body_inline;
  if (bodyState.body_truncation_offset !== undefined) {
    row.body_truncation_offset = bodyState.body_truncation_offset;
  }
  return row;
};

// ────────────────────────────────────────────────────────────────
// event_at derivation (§ A.3.1 — Pass-5 R5.4)
// ────────────────────────────────────────────────────────────────

export const deriveCallEventAt = (
  raw: RawHubSpotRecord,
  lifecycle_state: EngagementLifecycleState,
): number | null => {
  // 'point_in_time' (COMPLETED) + 'no_answer' (NO_ANSWER) — the attempt
  // occurred; populate event_at from hs_timestamp. Producers filter
  // via call_outcome_acceptance per § A.3.6.
  //
  // Codex review fold (P2 #6) — § A.3.1 specifies `hs_timestamp` as
  // the sole source for call event_at. The earlier `hs_createdate`
  // fallback risked turning record-creation time into call-attempt
  // time when `hs_timestamp` was missing; drop it and let event_at
  // stay NULL (producers filter via lifecycle_state instead).
  if (lifecycle_state !== 'point_in_time' && lifecycle_state !== 'no_answer') {
    return null;
  }
  return parseUnixMs(raw.properties.hs_timestamp);
};

// ────────────────────────────────────────────────────────────────
// Direction derivation (§ A.3.3)
// ────────────────────────────────────────────────────────────────

export const deriveCallDirection = (raw: RawHubSpotRecord): Direction => {
  const dir = (raw.properties.hs_call_direction ?? '').toUpperCase();
  if (dir === 'INBOUND') return 'inbound';
  if (dir === 'OUTBOUND') return 'outbound';
  return 'unknown';
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseDurationMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
};
