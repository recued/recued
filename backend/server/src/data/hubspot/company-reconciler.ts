/** D-129 Phase 4 — HubSpot company reconciler.
 *
 *  Implements `VendorReconciler` for `(hubspot, company)`. The
 *  simplest of the three Sales Hub reconcilers — no canonicalization,
 *  no multi-field name reconstitution, every canonical field
 *  participates in the hash.
 *
 *  Notes:
 *
 *    - HubSpot one-word property names project to snake_case meta
 *      keys: `numberofemployees` → `meta.num_employees`,
 *      `annualrevenue` → `meta.annual_revenue`.
 *    - `domain` is already normalized by HubSpot (lowercase, no
 *      trailing slash, primary website only); no canonicalization
 *      pass needed at projection time.
 *    - All 6 canonical fields participate in the hash. Unlike contact's
 *      `recent_activity_at`, there's no "activity" field that bumps
 *      independently of identity — `num_employees` + `annual_revenue`
 *      changes ARE meaningful identity events for our purposes (e.g.
 *      a 50→500 employee transition).
 *
 *  Spec: D-129 § A.3, § Phase 4. */

import {
  HUBSPOT_COMPANY_PROPERTIES,
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
export interface HubSpotCompanySlimRecord extends SlimRecord {
  _raw: RawHubSpotRecord;
}

/** Construction-time deps. The boot wire injects the search helper
 *  deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface HubSpotCompanyReconcilerDeps {
  search: HubSpotSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-129 P5 — optional webhook processor (entity='company'). */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-129 P4 — `(hubspot, company)` reconciler. One instance per server
 *  registered into the default `ReconcilerRegistry` at boot; per-
 *  connection task wiring lives in the `bin.ts` connection-upsert
 *  hook (P2.5). */
export class HubSpotCompanyReconciler implements VendorReconciler {
  readonly vendor = 'hubspot' as const;
  readonly entity = 'company' as const;
  readonly default_cadence: ReconciliationCadence = HUBSPOT_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: HubSpotCompanyReconcilerDeps;

  constructor(deps: HubSpotCompanyReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<HubSpotCompanySlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    for await (const raw of searchHubSpotObjects(
      connection,
      {
        objectType: 'companies',
        properties: HUBSPOT_COMPANY_PROPERTIES,
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

  hashOf(record: HubSpotCompanySlimRecord): string {
    return computeCompanyHash(record._raw);
  }

  toMeta(record: HubSpotCompanySlimRecord): EnrichmentMeta {
    return projectCompanyMeta(record._raw, computeCompanyHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// Hash + meta projection (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-129 P4 — canonical-field hash for a HubSpot company record.
 *  Tuple matches spec § A.2 meta_fields: name / domain / industry /
 *  owner / annual_revenue / num_employees. Joined by the unit
 *  separator (`\x1f`) so re-orderings always change the hash. */
export const computeCompanyHash = (raw: RawHubSpotRecord): string => {
  const fields = [
    raw.properties.name ?? '',
    raw.properties.domain ?? '',
    raw.properties.industry ?? '',
    raw.properties.hubspot_owner_id ?? '',
    raw.properties.annualrevenue ?? '',
    raw.properties.numberofemployees ?? '',
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

/** D-129 P4 — project a raw HubSpot company into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  6 canonical fields declared on the `hubspot.company` entity. */
export const projectCompanyMeta = (
  raw: RawHubSpotRecord,
  snapshotHash: string,
  snapshotAt: number,
): EnrichmentMeta => {
  const meta: EnrichmentMeta = {
    snapshot_at: snapshotAt,
    snapshot_hash: snapshotHash,
  };

  const name = raw.properties.name;
  if (typeof name === 'string' && name.length > 0) meta.name = name;

  const domain = raw.properties.domain;
  if (typeof domain === 'string' && domain.length > 0) meta.domain = domain;

  const industry = raw.properties.industry;
  if (typeof industry === 'string' && industry.length > 0) meta.industry = industry;

  const numEmployees = parseFloatStrict(raw.properties.numberofemployees);
  if (numEmployees !== null) meta.num_employees = numEmployees;

  const owner = raw.properties.hubspot_owner_id;
  if (typeof owner === 'string' && owner.length > 0) {
    meta.owner = `hubspot_owner_id:${owner}`;
  }

  const annualRevenue = parseFloatStrict(raw.properties.annualrevenue);
  if (annualRevenue !== null) meta.annual_revenue = annualRevenue;

  return meta;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseFloatStrict = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const parseUnixMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  // HubSpot emits ms epoch as a numeric string for native date fields
  // (`hs_lastmodifieddate`); ISO strings appear on `createdAt` /
  // `updatedAt` envelope fields. Try numeric first, then fall through
  // to ISO parsing.
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt > 0) return Math.trunc(asInt);
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
};
