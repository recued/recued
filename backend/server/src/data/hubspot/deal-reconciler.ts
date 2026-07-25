/** D-129 Phase 2 — HubSpot deal reconciler.
 *
 *  Implements `VendorReconciler` for `(hubspot, deal)`. The harness
 *  in `housekeeping/reconciliation/vendor-reconciler.ts` drives the
 *  cycle — this reconciler implements the three vendor-specific
 *  pieces:
 *
 *    1. `listUpdatedSince` — paginated `/crm/v3/objects/deals/search`
 *       walk filtered by `hs_lastmodifieddate >= cursor` and projecting
 *       the canonical property set (`HUBSPOT_DEAL_PROPERTIES`).
 *    2. `hashOf` — FNV-1a over the unit-separator-joined canonical
 *       field tuple. The harness short-circuits on hash match so
 *       re-runs are idempotent.
 *    3. `toMeta` — projects the raw HubSpot record into the
 *       `EnrichmentMeta` snapshot the cascade engine + Memory tab
 *       both read.
 *
 *  Spec: D-129 § A.3. */

import {
  HUBSPOT_DEAL_PROPERTIES,
  HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
  PLATFORM_REFERENCE_BATCH_SIZE,
  composePlatformRecordTargetId,
  type ConnectionRecord,
  type EnrichmentMeta,
} from '@recued/contracts';

import type {
  ReconciliationCadence,
  SlimRecord,
  VendorReconciler,
  WebhookProcessor,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';

import { fnv1aHex } from './_fnv1a.js';
import {
  searchHubSpotObjects,
  type HubSpotSearchDeps,
  type RawHubSpotRecord,
} from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the raw HubSpot payload. The harness
 *  reads only `id` + `modified_at`; `hashOf` + `toMeta` consume `_raw`
 *  to compute their outputs. */
export interface HubSpotDealSlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

/** Construction-time deps. The boot wire (P2.5) injects the search
 *  helper deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface HubSpotDealReconcilerDeps {
  search: HubSpotSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-129 P5 — optional webhook processor for `*.creation` /
   *  `*.propertyChange` / `*.deletion` acceleration. Wired in bin.ts
   *  via `buildHubSpotWebhookProcessor({ entity: 'deal', ... })`. */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-129 P2 — `(hubspot, deal)` reconciler. One instance per server
 *  registered into the default `ReconcilerRegistry` at boot; per-
 *  connection task wiring lives in the `bin.ts` connection-upsert
 *  hook (P2.5). */
export class HubSpotDealReconciler implements VendorReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'deal' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotDealReconcilerDeps;

  constructor(deps: HubSpotDealReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotDealSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'deals',
        properties: HUBSPOT_DEAL_PROPERTIES,
        modifiedSince: cursor,
        limit: pageLimit,
      },
      this.deps.search,
    )) {
      const modifiedAt = parseUnixMs(raw.properties.hs_lastmodifieddate);
      if (modifiedAt === null) continue;
      yield {
        id: composePlatformRecordTargetId(this.vendor, this.entity, connection.name, String(raw.id)),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  hashOf(record: HubSpotDealSlimRecord): string {
    return computeDealHash(record._raw);
  }

  toMeta(record: HubSpotDealSlimRecord): EnrichmentMeta {
    return projectDealMeta(record._raw, computeDealHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// Hash + meta projection (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-129 P2 — canonical-field hash for a HubSpot deal record. Tuple
 *  matches spec § A.3: name / stage / amount / closedate / owner /
 *  pipeline. Joined by the unit separator (`\x1f`) so re-orderings
 *  always change the hash.
 *
 *  The D5 deal-fold widens the tuple with `description` / `hs_next_step`
 *  / `hs_priority` — rep-authored semantic fields whose changes should
 *  refresh `meta` + fire a cascade. The two activity timestamps
 *  (`notes_next_activity_date` / `notes_last_contacted`) are
 *  deliberately *excluded*: HubSpot bumps them on any logged activity
 *  (call / meeting / email open), and including them would force a meta
 *  refresh + cascade on every touch — the same rationale that keeps
 *  `recent_activity_at` out of the contact reconciler's hash. They are
 *  still projected into `meta` (refreshed whenever a hashed field
 *  changes), just not load-bearing for skip-on-match. Widening the
 *  tuple churns the hash once on the next reconciliation cycle (every
 *  existing deal re-stamps a fresh `meta`); idempotent thereafter. */
export const computeDealHash = (raw: RawHubSpotRecord): string => {
  const fields = [
    raw.properties.dealname ?? '',
    raw.properties.dealstage ?? '',
    raw.properties.amount ?? '',
    raw.properties.closedate ?? '',
    raw.properties.hubspot_owner_id ?? '',
    raw.properties.pipeline ?? '',
    raw.properties.description ?? '',
    raw.properties.hs_next_step ?? '',
    raw.properties.hs_priority ?? '',
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

/** D-129 P2 — project a raw HubSpot deal into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  canonical fields declared on the `hubspot.deal` entity. The D5
 *  deal-fold adds five: `key_dates.next_activity_at` /
 *  `key_dates.last_activity_at` (activity timestamps, also surfaced on
 *  the op-step read paths) + `description` / `next_step` / `priority`
 *  (rep-authored free text). Only the latter three are hashed — see
 *  `computeDealHash`. */
export const projectDealMeta = (
  raw: RawHubSpotRecord,
  snapshotHash: string,
  snapshotAt: number,
): EnrichmentMeta => {
  const meta: EnrichmentMeta = {
    snapshot_at: snapshotAt,
    snapshot_hash: snapshotHash,
  };

  const name = raw.properties.dealname;
  if (typeof name === 'string' && name.length > 0) meta.name = name;

  const stage = raw.properties.dealstage;
  if (typeof stage === 'string' && stage.length > 0) meta.stage = stage;

  const amount = parseFloatStrict(raw.properties.amount);
  if (amount !== null) meta.amount = amount;

  const owner = raw.properties.hubspot_owner_id;
  if (typeof owner === 'string' && owner.length > 0) {
    meta.owner = `hubspot_owner_id:${owner}`;
  }

  const pipeline = raw.properties.pipeline;
  if (typeof pipeline === 'string' && pipeline.length > 0) meta.pipeline = pipeline;

  const keyDates: Record<string, number> = {};
  const closeDate = parseUnixMs(raw.properties.closedate);
  if (closeDate !== null) keyDates.close_date = closeDate;
  const createdAt = parseUnixMs(raw.properties.createdate);
  if (createdAt !== null) keyDates.created_at = createdAt;
  // D5 deal-fold — activity timestamps live in the same key-date family
  // as close_date / created_at. Projected here but excluded from the
  // hash (see computeDealHash); meta refreshes whenever a hashed field
  // changes rather than on every logged-activity bump.
  const nextActivityAt = parseUnixMs(raw.properties.notes_next_activity_date);
  if (nextActivityAt !== null) keyDates.next_activity_at = nextActivityAt;
  const lastActivityAt = parseUnixMs(raw.properties.notes_last_contacted);
  if (lastActivityAt !== null) keyDates.last_activity_at = lastActivityAt;
  if (Object.keys(keyDates).length > 0) meta.key_dates = keyDates;

  const forecast = parseFloatStrict(raw.properties.hs_forecast_amount);
  if (forecast !== null) meta.forecast_amount = forecast;

  // D5 deal-fold — rep-authored free-text fields (hashed; semantic
  // changes refresh meta + fire a cascade). `description` is a HubSpot
  // textarea (unbounded) so it's clamped into the meta snapshot — see
  // clampDealDescription.
  const description = raw.properties.description;
  if (typeof description === 'string' && description.length > 0) {
    meta.description = clampDealDescription(description);
  }

  const nextStep = raw.properties.hs_next_step;
  if (typeof nextStep === 'string' && nextStep.length > 0) meta.next_step = nextStep;

  const priority = raw.properties.hs_priority;
  if (typeof priority === 'string' && priority.length > 0) meta.priority = priority;

  meta.close_state = deriveCloseState(raw);

  return meta;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** D5 deal-fold — char cap on the free-text `description` projected
 *  into the `meta` snapshot. HubSpot's deal `description` is a textarea
 *  (unbounded); the snapshot is hard-capped at
 *  `PLATFORM_REFERENCE_META_MAX_BYTES` (8 KB) and `refreshMetaForTarget`
 *  *throws* `MetaSnapshotTooLargeError` on overflow with no per-record
 *  catch in the harness — a single verbose deal would abort the cycle
 *  and wedge the cursor on it. 1024 chars (≤ 4 KB worst-case UTF-8)
 *  keeps realistic descriptions whole while leaving headroom for the
 *  rest of the snapshot. The hash uses the FULL value
 *  (`computeDealHash`) so an edit past the cap still re-stamps; the
 *  op-step read path (deal.read / deal.search) is unaffected — it
 *  projects the full description live. */
const DEAL_DESCRIPTION_META_MAX_CHARS = 1024;

/** Clamp `description` for the meta snapshot, appending an ellipsis when
 *  truncated so a human browsing meta sees the value is clipped. */
const clampDealDescription = (raw: string): string =>
  raw.length <= DEAL_DESCRIPTION_META_MAX_CHARS
    ? raw
    : `${raw.slice(0, DEAL_DESCRIPTION_META_MAX_CHARS)}…`;

/** Three-state lifecycle: `'open' | 'won' | 'lost'`. Derived from
 *  HubSpot's overlapping `hs_is_closed*` flags — `won` and `lost` set
 *  `hs_is_closed`, but `hs_is_closed_won` + `hs_is_closed_lost` are
 *  the discriminators. */
const deriveCloseState = (raw: RawHubSpotRecord): string => {
  if (truthy(raw.properties.hs_is_closed_won)) return 'won';
  if (truthy(raw.properties.hs_is_closed_lost)) return 'lost';
  if (truthy(raw.properties.hs_is_closed)) return 'won';
  return 'open';
};

const truthy = (raw: string | null | undefined): boolean => {
  if (raw === null || raw === undefined) return false;
  const lower = raw.toLowerCase();
  return lower === 'true' || lower === '1';
};

const parseFloatStrict = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const parseUnixMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  // HubSpot emits ms epoch as a numeric string for native date fields
  // (`hs_lastmodifieddate`, `closedate`, `createdate`); ISO strings
  // appear on `createdAt` / `updatedAt` envelope fields. Try numeric
  // first, then fall through to ISO parsing.
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};
