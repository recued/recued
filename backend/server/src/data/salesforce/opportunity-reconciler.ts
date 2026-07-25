/** D-130 Phase 2 — Salesforce opportunity reconciler.
 *
 *  Implements `VendorReconciler` for `(salesforce, opportunity)`. The
 *  harness in `housekeeping/reconciliation/vendor-reconciler.ts`
 *  drives the cycle — this reconciler implements the three
 *  vendor-specific pieces:
 *
 *    1. `listUpdatedSince` — paginated SOQL query against
 *       `Opportunity` filtered by `LastModifiedDate >= <iso_cursor>`,
 *       projecting the canonical field set
 *       (`SALESFORCE_OPPORTUNITY_FIELDS`).
 *    2. `hashOf` — FNV-1a over the unit-separator-joined canonical
 *       field tuple. The harness short-circuits on hash match so
 *       re-runs are idempotent.
 *    3. `toMeta` — projects the raw Salesforce record into the
 *       `EnrichmentMeta` snapshot the cascade engine + Memory tab
 *       both read.
 *
 *  Spec: `docs/d-130-spec.md` § A.3. */

import {
  PLATFORM_REFERENCE_BATCH_SIZE,
  SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
  SALESFORCE_OPPORTUNITY_FIELDS,
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

/** SlimRecord variant carrying the raw Salesforce payload. The
 *  harness reads only `id` + `modified_at`; `hashOf` + `toMeta`
 *  consume `_raw` to compute their outputs. */
export interface SalesforceOpportunitySlimRecord extends SlimRecord {
  _raw: RawSalesforceRecord;
}

/** Construction-time deps. The boot wire (P2.5) injects the search
 *  helper deps; tests pass a deterministic `now()` and a fake fetcher. */
export interface SalesforceOpportunityReconcilerDeps {
  search: SalesforceSearchDeps;
  /** Wall-clock used to stamp `meta.snapshot_at`. Defaults to
   *  `Date.now`. Tests pin this so snapshots round-trip exactly. */
  now?: () => number;
  /** D-130 P5 — optional CometD webhook processor (PushTopic stream
   *  events). Wired in bin.ts via `buildSalesforceWebhookProcessor`
   *  once P5 lands. Reserved here so the reconciler shape stays
   *  uniform with HubSpot's. */
  webhookProcessor?: WebhookProcessor;
}

// ────────────────────────────────────────────────────────────────
// Reconciler
// ────────────────────────────────────────────────────────────────

/** D-130 P2 — `(salesforce, opportunity)` reconciler. One instance
 *  per server registered into the default `ReconcilerRegistry` at
 *  boot; per-connection task wiring lives in the `bin.ts`
 *  connection-upsert hook (P2.5). */
export class SalesforceOpportunityReconciler implements VendorReconciler {
  readonly vendor = 'salesforce' as const;
  readonly entity = 'opportunity' as const;
  readonly default_cadence: ReconciliationCadence = SALESFORCE_DEFAULT_RECONCILIATION_CADENCE;
  readonly webhookProcessor?: WebhookProcessor;

  private readonly deps: SalesforceOpportunityReconcilerDeps;

  constructor(deps: SalesforceOpportunityReconcilerDeps) {
    this.deps = deps;
    if (deps.webhookProcessor) this.webhookProcessor = deps.webhookProcessor;
  }

  async *listUpdatedSince(
    connection: ConnectionRecord,
    cursor: number,
    limit: number,
  ): AsyncIterable<SalesforceOpportunitySlimRecord> {
    const pageLimit = Math.min(limit, PLATFORM_REFERENCE_BATCH_SIZE);
    const soql = buildOpportunitySoql(cursor, pageLimit);
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

  hashOf(record: SalesforceOpportunitySlimRecord): string {
    return computeOpportunityHash(record._raw);
  }

  toMeta(record: SalesforceOpportunitySlimRecord): EnrichmentMeta {
    return projectOpportunityMeta(record._raw, computeOpportunityHash(record._raw), this.now());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

// ────────────────────────────────────────────────────────────────
// SOQL composition (exported for direct unit testing)
// ────────────────────────────────────────────────────────────────

/** D-130 P2 — compose the SOQL string for an opportunity reconciliation
 *  page. First-run (`cursor === 0`) omits the `WHERE` clause to walk
 *  every record; subsequent runs filter by `LastModifiedDate >= <iso>`.
 *  The `ORDER BY LastModifiedDate ASC` sort matches the cursor-advance
 *  invariant — the harness records `max(modified_at)` seen so the next
 *  run picks up where this one left off. */
export const buildOpportunitySoql = (cursor: number, limit: number): string => {
  const fields = SALESFORCE_OPPORTUNITY_FIELDS.join(', ');
  const baseClauses = [
    `SELECT ${fields}`,
    `FROM Opportunity`,
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

/** D-130 P2 — canonical-field hash for a Salesforce opportunity
 *  record. Tuple per spec § A.3: Name / StageName / Amount / CloseDate
 *  / OwnerId / IsClosed / IsWon — plus NextStep (D-192 F1, the hb
 *  hs_next_step parity: a rep-authored next-step edit is a semantic
 *  change that must re-fold the deal so the commitment-evidence
 *  capture producer sees it on the cascade). Joined by the unit
 *  separator (`\x1f`) so re-orderings always change the hash.
 *  `LastModifiedDate` / `CreatedDate` / `Probability` /
 *  `ForecastCategory` are intentionally excluded — bumps to those
 *  fields shouldn't trigger a meta refresh. */
export const computeOpportunityHash = (raw: RawSalesforceRecord): string => {
  const fields = [
    stringify(raw.Name),
    stringify(raw.StageName),
    stringify(raw.Amount),
    stringify(raw.CloseDate),
    stringify(raw.OwnerId),
    stringify(raw.IsClosed),
    stringify(raw.IsWon),
    stringify(raw.NextStep),
  ];
  return `fnv1a:${fnv1aHex(fields.join('\x1f'))}`;
};

/** D-130 P2 — project a raw Salesforce opportunity into the canonical
 *  `EnrichmentMeta` snapshot. `snapshot_hash` + `snapshot_at` are the
 *  two stamping fields the cascade engine reads; the rest are the
 *  canonical fields declared on the `salesforce.opportunity` entity. */
export const projectOpportunityMeta = (
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

  const stage = readString(raw.StageName);
  if (stage !== null) meta.stage = stage;

  const amount = readNumber(raw.Amount);
  if (amount !== null) meta.amount = amount;

  const owner = readString(raw.OwnerId);
  if (owner !== null) meta.owner = `salesforce_user:${owner}`;

  const keyDates: Record<string, number> = {};
  const closeDate = parseIsoMs(raw.CloseDate);
  if (closeDate !== null) keyDates.close_date = closeDate;
  const createdAt = parseIsoMs(raw.CreatedDate);
  if (createdAt !== null) keyDates.created_at = createdAt;
  if (Object.keys(keyDates).length > 0) meta.key_dates = keyDates;

  // Salesforce's Opportunity SObject doesn't surface a forecast amount
  // field on the standard SOQL projection — Forecasting lives in
  // separate objects. Project `meta.forecast_amount` only when an org's
  // SOQL response happens to surface a `ForecastAmount` value (custom
  // field carry-through or future per-org probe). Don't synthesize from
  // Amount × Probability.
  const forecast = readNumber(raw.ForecastAmount);
  if (forecast !== null) meta.forecast_amount = forecast;

  const probability = readNumber(raw.Probability);
  if (probability !== null) meta.probability = probability;

  // D-192 F1 — canonical next_step (standard `NextStep`, Text 255; no
  // clamp needed under the 8 KB meta cap). Hash-participating above.
  const nextStep = readString(raw.NextStep);
  if (nextStep !== null) meta.next_step = nextStep;

  meta.close_state = deriveCloseState(raw);

  return meta;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Three-state lifecycle: `'open' | 'won' | 'lost'`. Salesforce's
 *  `IsClosed` boolean is true for both won and lost; `IsWon` is the
 *  discriminator. An IsClosed=true + IsWon=false means lost. */
const deriveCloseState = (raw: RawSalesforceRecord): string => {
  const isClosed = readBoolean(raw.IsClosed);
  const isWon = readBoolean(raw.IsWon);
  if (isClosed === true && isWon === true) return 'won';
  if (isClosed === true && isWon === false) return 'lost';
  return 'open';
};

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

const readBoolean = (raw: unknown): boolean | null => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
};

/** Stringify a SOQL-returned value into a hash-stable token. Booleans
 *  + numbers stringify natively; null / undefined collapse to empty
 *  string so `IsWon: undefined` and `IsWon: false` don't hash the
 *  same as `IsWon: true`. */
const stringify = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : '';
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return '';
};

/** Parse a Salesforce ISO-8601 timestamp (e.g. `2026-05-01T14:32:18.000Z`)
 *  into unix-ms. Returns null on missing / unparseable input. Salesforce
 *  emits dates as ISO strings throughout the SOQL response — both
 *  `LastModifiedDate` (datetime) and `CloseDate` (date — midnight UTC)
 *  parse correctly via `Date.parse`. */
const parseIsoMs = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};
