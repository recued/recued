/** D-139 Phase 1a.2 — HubSpot note-engagement reconciler.
 *
 *  Notes are the simplest engagement type: always `'point_in_time'`
 *  lifecycle (notes are timestamped at creation; no scheduled-vs-
 *  completed distinction); always `'unknown'` direction (notes don't
 *  carry a direction field in HubSpot's data model). The body lives on
 *  `hs_note_body`. Authorship derivation matches the shared
 *  `deriveAuthorshipBase` order.
 *
 *  Spec: `docs/d-139-spec.md` § A.1, § A.3, § A.3.2, § A.3.3, § A.3.6,
 *  § A.4. */

import {
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  HUBSPOT_NOTE_PROPERTIES,
  PLATFORM_REFERENCE_BATCH_SIZE,
  type ConnectionRecord,
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
  deriveNoteLifecycleState,
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

export interface HubSpotNoteEngagementReconcilerDeps {
  search: HubSpotSearchDeps;
  engagementStore: EngagementStore;
  /** D-138 redirect lookup — engagement→contact edges route through
   *  this BEFORE insert per § A.5 load-bearing wiring. Tests pass
   *  identity callback `() => null`. */
  resolveContactRedirect?: ContactRedirectLookup;
  /** D-138 identity-expansion — used by the resolver path; reserved
   *  here so the caller wires both halves at the same construction
   *  site. */
  expandContactIdentity?: ContactIdentityExpansion;
  /** `hubspot_owner_id` matching the user's connection identity. */
  connectionUserOwnerId?: string;
  /** § A.3.7 fallback timezone hint. */
  defaultTzHint?: string;
  /** D-139 P1a.1.2 — `prefs.timezone` reader for the § A.3.7 fallback
   *  chain. See `engagement-shared.ts#resolveEngagementTzHint`. */
  prefsTimezone?: () => string | null | undefined;
  now?: () => number;
  webhookProcessor?: WebhookProcessor;
}

export interface HubSpotNoteEngagementSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

export class HubSpotNoteEngagementReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'note' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotNoteEngagementReconcilerDeps;

  constructor(deps: HubSpotNoteEngagementReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotNoteEngagementSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'notes',
        properties: HUBSPOT_NOTE_PROPERTIES as unknown as ReadonlyArray<string>,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: `hubspot_note_${raw.id}`,
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  /** Per-record write path. Atomic ingest via
   *  `EngagementStore.ingestEngagementWithEdges` so the row + owner
   *  edge land in one transaction. */
  ingest(
    connection_id: string,
    slim: HubSpotNoteEngagementSlimRecord,
    crmAssociations?: EngagementCrmAssociations,
  ): {
    row: EngagementRow;
    emittedEdgeCount: number;
    edgesTombstoned: number;
    staleModstamp: boolean;
  } {
    const row = projectNoteEngagementRow(connection_id, slim._raw, {
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
    // associations (§ A.4). Notes don't carry email headers / attendee
    // metadata, so the CRM associations list is the only path to deal
    // + account edges. Contact-edge emission for notes / calls / tasks
    // is OUT OF SCOPE at P1a.1.1: the substrate's `'contact'` edge_type
    // keys on canonical email, not on HubSpot's raw contact id; resolving
    // raw id → primary_email requires the contact reconciler's lookup
    // (lands at a future sub-phase). Email + meeting reconcilers
    // continue to derive contact edges from email headers / attendee
    // emails which are already canonical emails.
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

    // Type satisfaction — `resolveContactRedirect` is wired through
    // for the per-cycle association-rescan substrate (P1a.2 § A.6.3),
    // which extends the contact-edge set after the initial ingest.
    void resolveContactRedirect;

    return {
      row: result.row,
      emittedEdgeCount: result.edges_upserted,
      edgesTombstoned: result.edges_tombstoned,
      staleModstamp: result.stale_modstamp,
    };
  }

  /** D-139 P1a.1.2 — async wrapper that fetches CRM associations
   *  FIRST then delegates to the synchronous `ingest()` with
   *  `crmAssociations` populated. Mirrors the email reconciler's
   *  shape (Codex P1 #3 fold-back from P1a.1.1) so harness wiring
   *  for the changed-record path uses one uniform method across all
   *  five engagement reconcilers. Sync `ingest()` stays available
   *  for unit tests + the edge-only webhook write path which already
   *  has associations precomputed.
   *
   *  On fetcher throw, falls back to `ingest()` without
   *  `crmAssociations` so the row still lands; the rescan substrate
   *  picks up the missing deal/account edges on the next cycle. */
  async ingestWithAssociations(
    connection: ConnectionRecord,
    connection_id: string,
    slim: HubSpotNoteEngagementSlimRecord,
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
        entity: 'note',
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
      record as HubSpotNoteEngagementSlimRecord,
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

export interface ProjectNoteEngagementRowInput {
  now: number;
  connectionUserOwnerId?: string;
  defaultTzHint?: string;
  prefsTimezone?: () => string | null | undefined;
}

export const projectNoteEngagementRow = (
  connection_id: string,
  raw: RawHubSpotRecord,
  input: ProjectNoteEngagementRowInput,
): EngagementRow => {
  const lifecycle_state = deriveNoteLifecycleState();
  const vendor_created_at =
    parseUnixMs(raw.properties.hs_createdate) ?? input.now;
  const vendor_modified_at =
    parseUnixMs(raw.properties.hs_lastmodifieddate) ?? vendor_created_at;
  // event_at = createdate per § A.3.1 (notes are point-in-time;
  // created = happened).
  const event_at =
    parseUnixMs(raw.properties.hs_createdate) ?? vendor_created_at;

  const authorship = deriveAuthorshipBase(raw, input.connectionUserOwnerId);

  const body = raw.properties.hs_note_body ?? '';
  const bodyState = pickInlineBodyState(body);

  const meta: Record<string, unknown> = {};
  const bodyPreview = pickBodyPreview(body);
  if (bodyPreview) meta.body_preview = bodyPreview;
  if (raw.properties.hs_createdate) {
    const cd = parseUnixMs(raw.properties.hs_createdate);
    if (cd !== null) meta.created_at = cd;
  }
  if (raw.properties.hubspot_owner_id) {
    meta.owner = `hubspot_owner_id:${raw.properties.hubspot_owner_id}`;
  }

  const row: EngagementRow = {
    connection_id,
    target_id: `hubspot_note_${raw.id}`,
    vendor: 'hubspot',
    entity: 'note',
    meta,
    mirror_blob_hash: null,
    authorship,
    direction: 'unknown',
    dedupe_confidence: 'none',
    lifecycle_state,
    event_at,
    vendor_created_at,
    vendor_modified_at,
    ingested_at: input.now,
    body_state: bodyState.body_state,
  };
  if (raw.properties.hs_lastmodifieddate) {
    row.vendor_modstamp = raw.properties.hs_lastmodifieddate;
  }
  if (raw.properties.hs_timestamp) {
    row.vendor_raw_timestamp = raw.properties.hs_timestamp;
  }
  // P1a.1.2 — § A.3.7 fallback chain. Notes have no calendar context;
  // chain reduces to defaultTzHint → prefsTimezone() → UTC.
  const resolvedTz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint: input.defaultTzHint,
    prefsTimezone: input.prefsTimezone,
  });
  row.event_at_tz_hint = resolvedTz.tz;
  if (resolvedTz.inferred) row.event_at_tz_inferred = true;
  if (bodyState.body_inline !== undefined) {
    row.body_inline = bodyState.body_inline;
  }
  if (bodyState.body_truncation_offset !== undefined) {
    row.body_truncation_offset = bodyState.body_truncation_offset;
  }
  return row;
};
