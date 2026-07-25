/** D-130 Phase 4 — Salesforce account reconciler.
 *
 *  Implements `VendorReconciler` for `(salesforce, account)`. The
 *  simplest of the Sales Cloud trio — no canonicalization, no multi-
 *  field name reconstitution, every canonical field participates in
 *  the hash.
 *
 *  Notes:
 *
 *    - `Website` is freeform on Salesforce (`https://example.com`,
 *      `example.com`, `www.example.com`, with/without trailing slash —
 *      all valid org input). The reconciler stores it verbatim under the
 *      canonical `meta.domain` key (cross-vendor with `hubspot.company.domain`)
 *      per D-129's HubSpot company precedent (`domain` stored as-is). If a
 *      future cross-vendor join wants canonical domain matching, the
 *      normalization pass lives at the join site, not here.
 *    - All 6 canonical fields participate in the hash. Unlike contact's
 *      `recent_activity_at`, there's no "activity" field that bumps
 *      independently of identity — `NumberOfEmployees` + `AnnualRevenue`
 *      changes ARE meaningful identity events for our purposes (e.g.
 *      a 50→500 employee transition). Symmetric with HubSpot's company
 *      reconciler hash decision (D-129 P4).
 *    - Salesforce account ids start with `001` (e.g. `001A0000005ACMECO`).
 *      The slim record id prefix `salesforce_account_<Id>` keeps the
 *      platform-reference target_id shape uniform with HubSpot's
 *      `hubspot_company_<numeric>` (and matches the cross-vendor
 *      `crm.account.*` lens dispatching at P7).
 *
 *  Spec: D-130 § A.3, § Phase 4. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_ACCOUNT_FIELDS,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
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
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the raw Salesforce account payload.
 *  The harness reads only `id` + `modified_at`; `hashOf` + `toMeta`
 *  consume `_raw` to compute their outputs. */
export interface SalesforceAccountSlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

/** Construction-time deps. The boot wire injects the search helper
 *  deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface SalesforceAccountReconcilerDeps {
  search: SalesforceSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-130 P5 — optional CometD webhook processor (PushTopic stream
   *  events on the `/topic/RecuedAccountFeed` channel). Wired in
   *  `bin.ts` once P5 lands. */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-130 P4 — `(salesforce, account)` reconciler. One instance per
 *  server registered into the default `ReconcilerRegistry` at boot;
 *  per-connection task wiring lives in the `bin.ts` connection-upsert
 *  hook (shared with opportunity + contact). */
export class SalesforceAccountReconciler implements VendorReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'account' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceAccountReconcilerDeps;

  constructor(deps: SalesforceAccountReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceAccountSlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildAccountSoql(cursor, pageLimit);
    for await (const raw of searchSalesforceObjects(
      connection,
      { soql },
      this.deps.search,
    )) {
      const modifiedAt = parseIsoMs(raw.LastModifiedDate);
      if (modifiedAt === null) continue;
      yield {
        id: composePlatformRecordTargetId(this.vendor, this.entity, connection.name, String(raw.Id)),
        modified_at: modifiedAt,
        _raw: raw,
      };
    }
  }

  hashOf(record: SalesforceAccountSlimRecord): string {
    return computeAccountHash(record._raw);
  }

  toMeta(record: SalesforceAccountSlimRecord): EnrichmentMeta {
    return projectAccountMeta(record._raw, computeAccountHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-130 P4 — compose the SOQL string for an account reconciliation
 *  page. First-run (`cursor === 0`) omits the `WHERE` clause to walk
 *  every record; subsequent runs filter by `LastModifiedDate >= <iso>`.
 *  The `ORDER BY LastModifiedDate ASC` sort matches the cursor-advance
 *  invariant — the harness records `max(modified_at)` seen so the next
 *  run picks up where this one left off. */
export const buildAccountSoql = (cursor: number, limit: number): string => {
  const fields = SALESFORCE_ACCOUNT_FIELDS.join(', ');
  const baseClauses = [
    `SELECT ${fields}`,
    `FROM Account`,
  ];
  if (cursor > 0) {
    baseClauses.push(`WHERE LastModifiedDate >= ${new Date(cursor).toISOString()}`);
  }
  baseClauses.push(`ORDER BY LastModifiedDate ASC`);
  baseClauses.push(`LIMIT ${limit}`);
  return baseClauses.join(' ');
};

// ────────────────────────────────────────────────────────────────
// Hash + meta projection (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-130 P4 — canonical-field hash for a Salesforce account record.
 *  Tuple matches spec § A.2 meta_fields: name / domain / industry /
 *  owner / annual_revenue / num_employees. All 6 canonical fields
 *  participate per the file-header rationale. Joined by the unit
 *  separator (`\x1f`) so re-orderings always change the hash. */
export const computeAccountHash = (raw: RawSalesforceRecord): string => {
  const fields = [
    stringify(raw.Name),
    stringify(raw.Website),
    stringify(raw.Industry),
    stringify(raw.OwnerId),
    stringify(raw.AnnualRevenue),
    stringify(raw.NumberOfEmployees),
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

/** D-130 P4 — project a raw Salesforce account into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  6 canonical fields declared on the `salesforce.account` entity. */
export const projectAccountMeta = (
  raw: RawSalesforceRecord,
  snapshotHash: string,
  snapshotAt: number,
): EnrichmentMeta => {
  const meta: EnrichmentMeta = {
    snapshot_at: snapshotAt,
    snapshot_hash: snapshotHash,
  };

  const name = readString(raw.Name);
  if (name !== null) meta.name = name;

  const domain = readString(raw.Website);
  if (domain !== null) meta.domain = domain;

  const industry = readString(raw.Industry);
  if (industry !== null) meta.industry = industry;

  const numEmployees = readNumber(raw.NumberOfEmployees);
  if (numEmployees !== null) meta.num_employees = numEmployees;

  const owner = readString(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;

  const annualRevenue = readNumber(raw.AnnualRevenue);
  if (annualRevenue !== null) meta.annual_revenue = annualRevenue;

  return meta;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const readString = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  return raw;
};

const readNumber = (raw: unknown): number | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Stringify a SOQL-returned value into a hash-stable token. Booleans
 *  + numbers stringify natively; null / undefined collapse to empty
 *  string. Symmetric with the opportunity + contact reconciler helpers. */
const stringify = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : '';
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return '';
};

/** Parse a Salesforce ISO-8601 timestamp into unix-ms. Returns null on
 *  missing / unparseable input. */
const parseIsoMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};
