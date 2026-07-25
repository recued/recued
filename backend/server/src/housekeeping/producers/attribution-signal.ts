/** D-129 P6 + D-130 P6 — `attribution_signal` enrichment producer.
 *
 *  First-touch attribution per CRM deal — deterministic SQL
 *  aggregation over `data.mail` + `data.calendar` rows in the rolling
 *  window before each deal's create timestamp. Surfaces the channel
 *  and source bucket without per-deal AI cost. Cross-vendor at D-130:
 *  walks both `connection.api.hubspot.deal` and
 *  `connection.api.salesforce.opportunity` scopes per spec § A.6
 *  widening; producer logic is vendor-agnostic (meta projection
 *  carries `key_dates.created_at` + `owner` uniformly across both
 *  reconcilers).
 *
 *  Substrate fit (chicken-and-egg note): the reconciler in D-129 P2 /
 *  D-130 P2 refreshes meta on existing rows but does NOT materialise
 *  rows for first-sighted deals (`refreshMetaForTarget` short-circuits
 *  when `existing.length === 0`). Producers therefore walk DISTINCT
 *  `target_id`s already present in `data_enrichment` for the source
 *  scope — once any topic has a row for the deal, every subsequent
 *  producer can pick it up. The very first row gets seeded by tests
 *  in unit tests; in production the cascade-engine + bus subscriber
 *  path (out of P6 scope) wires the first-sighting flow.
 *
 *  Algorithm (per scope iteration):
 *
 *    1. `SELECT DISTINCT target_id` for the scope.
 *    2. For each `target_id`, fetch one row via `listByTarget` to read
 *       the `meta` snapshot. Skip when `meta` is null or missing
 *       `key_dates.created_at` (substrate guarantees them but be
 *       defensive).
 *    3. Window = `[created_at - WINDOW_MS, created_at]`. Tally:
 *       - `inbound_count`  — `data.mail` rows whose `received_at`
 *                            falls in window AND whose direction is
 *                            inbound (`hot_fields.from` ≠ user mailbox).
 *       - `outbound_count` — same window AND outbound direction.
 *       - `meeting_count`  — `data.calendar` rows whose `start_at`
 *                            falls in window.
 *    4. Pick the bucket:
 *       - any inbound mail        → `'inbound_inquiry'` / `'email'`
 *       - any meeting             → `'event'` / `'meeting'`
 *       - only outbound mail      → `'cold_outbound'` / `'email'`
 *       - none                    → `'unknown'` / `'unknown'`
 *    5. `first_touch_at` is the earliest qualifying activity timestamp
 *       found in step 3, or falls back to `meta.key_dates.created_at`
 *       when none exist (paired with `'unknown'`).
 *    6. Upsert `attribution_signal` row at the source scope, passing
 *       meta through so memory-tab reads stay coherent.
 *
 *  Owner-mailbox resolution is vendor-aware: HubSpot meta uses the
 *  `'hubspot_owner_id:<id>'` literal when no User-list resolution was
 *  available, Salesforce meta uses `'salesforce_user:<id>'`. Either
 *  literal short-circuits the inbound/outbound classification (treat
 *  every mail as inbound) since we can't disambiguate without a
 *  resolved mailbox. Resolved owners (canonical email) take the
 *  outbound path.
 *
 *  v1 limitation: deal records don't carry linked-contact ids in
 *  canonical meta yet on either vendor. The window-only heuristic
 *  surfaces direction signal without requiring the contact-association
 *  API hop. A future revision can tighten this by joining through
 *  associations.
 *
 *  Token cost: 0. Pure SQL aggregation.
 *
 *  Spec: D-129 §A.6 + D-130 §A.6 cross-
 *  vendor widening. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type AttributionSignalValue,
  type AttributionSource,
  type EnrichmentMeta,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import { canonicalOne } from './_email-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Look-back window before each deal's create timestamp. 30 days
 *  matches `behavioral_signature`'s rolling window — the same horizon
 *  recipes already reason about for "recent" engagement. Wider
 *  windows pick up more signal but pollute the bucket with stale
 *  pre-relationship activity. */
export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on deals walked per cycle. Defensive — typical user has
 *  hundreds of deals, not tens of thousands. Cycle finishes well
 *  inside the housekeeping budget; the cap exists so a fat HubSpot
 *  portal can't starve the rest of the housekeeping queue. */
export const ATTRIBUTION_MAX_DEALS_PER_CYCLE = 5000;

/** Authored-by stamp. Mirrors the convention every other harness-driven
 *  producer follows; surfaces in the Memory tab as the row attribution. */
export const ATTRIBUTION_SIGNAL_AUTHORED_BY = 'system.housekeeping.attribution_signal';

/** Topic key for this producer's emitted rows. */
export const ATTRIBUTION_SIGNAL_TOPIC: EnrichmentTopic = 'attribution_signal';

/** Default source scope the producer reads from. Retained for
 *  backwards compatibility with single-scope callers + D-129 P6
 *  tests; the cycle iterates `ATTRIBUTION_SIGNAL_SOURCE_SCOPES` and
 *  routes per-row by scope from D-130 onward. */
export const ATTRIBUTION_SIGNAL_SOURCE_SCOPE = 'connection.api.hubspot.deal' as const;

/** D-130 P6 — closed list of source scopes the cycle walks. Each
 *  entry produces rows under its own scope (per spec § A.6 widening:
 *  `attribution_signal` is per-record on either HubSpot deal or
 *  Salesforce opportunity, never derived). The cycle iterates this
 *  list per run; producer logic per-scope is identical (meta
 *  projection guarantees `key_dates.created_at` + `owner` on both
 *  vendors). */
export const ATTRIBUTION_SIGNAL_SOURCE_SCOPES = [
  'connection.api.hubspot.deal',
  'connection.api.salesforce.opportunity',
] as const;

export type AttributionSignalSourceScope = (typeof ATTRIBUTION_SIGNAL_SOURCE_SCOPES)[number];

/** Per-cycle token estimate for the Run-Now cost preview. Pure SQL. */
export const ATTRIBUTION_SIGNAL_TOKEN_ESTIMATE = 0;

/** Cap on the `signals` array — keep payloads small. */
const MAX_SIGNAL_TOKENS = 5;

// ────────────────────────────────────────────────────────────────
// Pure helpers (testable in isolation)
// ────────────────────────────────────────────────────────────────

/** Tally shape returned by `tallyWindowActivity`. Pure data — the
 *  bucket selection lives in `decideAttribution`. */
export interface AttributionWindowTally {
  inbound_count: number;
  outbound_count: number;
  meeting_count: number;
  /** Earliest activity timestamp seen across all three categories.
   *  `null` when nothing fell in the window. */
  earliest_at: number | null;
}

/** Decide the attribution bucket from a tally. Priority:
 *  inbound > meeting > outbound > unknown. Returns the canonical
 *  source bucket + a coarse channel string. */
export const decideAttribution = (tally: AttributionWindowTally): {
  first_touch_source: AttributionSource;
  first_touch_channel: string;
} => {
  if (tally.inbound_count > 0) {
    return { first_touch_source: 'inbound_inquiry', first_touch_channel: 'email' };
  }
  if (tally.meeting_count > 0) {
    return { first_touch_source: 'event', first_touch_channel: 'meeting' };
  }
  if (tally.outbound_count > 0) {
    return { first_touch_source: 'cold_outbound', first_touch_channel: 'email' };
  }
  return { first_touch_source: 'unknown', first_touch_channel: 'unknown' };
};

/** Build the short signal-token list. Order matches the bucket
 *  priority so callers reading just the first token get the
 *  load-bearing fact. Token suffixes use `_window` per D-136 P3
 *  follow-up — the underlying tally is computed against the deal
 *  attribution window (default 30d trailing). */
export const buildSignalTokens = (tally: AttributionWindowTally): string[] => {
  const out: string[] = [];
  if (tally.inbound_count > 0) out.push(`inbound_count_window:${tally.inbound_count}`);
  if (tally.meeting_count > 0) out.push(`meeting_count_window:${tally.meeting_count}`);
  if (tally.outbound_count > 0) out.push(`outbound_count_window:${tally.outbound_count}`);
  if (out.length === 0) out.push('no_window_activity');
  return out.slice(0, MAX_SIGNAL_TOKENS);
};

/** Identify the user's outbound mailbox from a deal's meta. Vendor
 *  reconcilers stamp the owner field as either:
 *    - `'hubspot_owner_id:<id>'` — unresolved HubSpot owner (D-129)
 *    - `'salesforce_user:<id>'` — unresolved Salesforce owner (D-130)
 *    - canonical email — resolved owner on either vendor
 *  Either unresolved literal short-circuits to `null` so the cycle
 *  falls back to "treat every mail as inbound" (spec decision: the
 *  conservative bucket choice when we can't disambiguate). Returns
 *  the canonical email or null. */
export const resolveOwnerMailbox = (owner: unknown): string | null => {
  if (typeof owner !== 'string' || owner.length === 0) return null;
  if (owner.startsWith('hubspot_owner_id:')) return null; // unresolved HubSpot id
  if (owner.startsWith('salesforce_user:')) return null;  // unresolved Salesforce id
  const canonical = canonicalOne(owner);
  if (canonical === '') return null;
  return canonical;
};

// ────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────

interface MailWindowRow {
  received_at: number;
  from_email: string | null;
}

interface CalendarWindowRow {
  start_at: number;
}

const collectMailInWindow = (
  ctx: HousekeepingContext,
  start_at: number,
  end_at: number,
): MailWindowRow[] => {
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  const out: MailWindowRow[] = [];
  for (const { name: table } of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields FROM "${table}"
          WHERE received_at >= ? AND received_at < ?`,
      )
      .all(start_at, end_at) as Array<{
        received_at: number;
        hot_fields: string;
      }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      const fromRaw = parsed.from;
      const from_email = typeof fromRaw === 'string' && fromRaw.length > 0
        ? canonicalOne(fromRaw)
        : null;
      out.push({ received_at: row.received_at, from_email });
    }
  }
  return out;
};

const collectMeetingsInWindow = (
  ctx: HousekeepingContext,
  start_at: number,
  end_at: number,
): CalendarWindowRow[] => {
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_calendar_%'`,
    )
    .all() as Array<{ name: string }>;
  const out: CalendarWindowRow[] = [];
  for (const { name: table } of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT start_at FROM "${table}"
          WHERE start_at >= ? AND start_at < ?`,
      )
      .all(start_at, end_at) as Array<{ start_at: number }>;
    for (const row of rows) {
      out.push({ start_at: row.start_at });
    }
  }
  return out;
};

/** Tally activity in the look-back window. `owner_mailbox` is the
 *  canonical email of the user's outbound mailbox when known; mail
 *  rows whose `from` matches it are outbound, otherwise inbound. When
 *  owner_mailbox is null, treat every mail as inbound — the
 *  conservative default for "we don't know which side is which" since
 *  it preserves the strong `inbound_inquiry` signal. */
export const tallyWindowActivity = (
  mail_rows: ReadonlyArray<MailWindowRow>,
  meeting_rows: ReadonlyArray<CalendarWindowRow>,
  owner_mailbox: string | null,
): AttributionWindowTally => {
  let inbound_count = 0;
  let outbound_count = 0;
  let earliest_at: number | null = null;

  const tally = (ts: number): void => {
    if (earliest_at === null || ts < earliest_at) earliest_at = ts;
  };

  for (const m of mail_rows) {
    const isOutbound =
      owner_mailbox !== null && m.from_email !== null && m.from_email === owner_mailbox;
    if (isOutbound) outbound_count += 1;
    else inbound_count += 1;
    tally(m.received_at);
  }
  for (const c of meeting_rows) {
    tally(c.start_at);
  }

  return {
    inbound_count,
    outbound_count,
    meeting_count: meeting_rows.length,
    earliest_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

interface DealWalkRow {
  target_id: string;
  meta_json: string | null;
}

const listDealTargetIds = (
  ctx: HousekeepingContext,
  scope: string,
): DealWalkRow[] => {
  const rows = ctx.db
    .prepare(
      `SELECT target_id, MAX(meta) AS meta_json
         FROM data_enrichment
        WHERE scope = ?
          AND target_id IS NOT NULL
          AND meta IS NOT NULL
        GROUP BY target_id
        LIMIT ?`,
    )
    .all(
      scope,
      ATTRIBUTION_MAX_DEALS_PER_CYCLE,
    ) as Array<{ target_id: string; meta_json: string | null }>;
  return rows;
};

interface DealMetaShape {
  snapshot_at: number;
  snapshot_hash: string;
  owner?: unknown;
  key_dates?: { created_at?: unknown; close_date?: unknown };
}

const parseDealMeta = (meta_json: string | null): DealMetaShape | null => {
  if (meta_json === null) return null;
  try {
    return JSON.parse(meta_json) as DealMetaShape;
  } catch {
    return null;
  }
};

const extractCreatedAt = (meta: DealMetaShape): number | null => {
  const ts = meta.key_dates?.created_at;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return ts;
};

/** Per-scope sub-cycle. Exposed for direct test access so callers can
 *  exercise one vendor's path in isolation without setting up the
 *  cross-vendor walker. Returns produced / skipped counts. */
export const runAttributionSignalCycleForScope = (
  ctx: HousekeepingContext,
  scope: AttributionSignalSourceScope,
): { produced: number; skipped: number } => {
  const now = ctx.now();
  const deals = listDealTargetIds(ctx, scope);
  let produced = 0;
  let skipped = 0;

  for (const deal of deals) {
    const meta = parseDealMeta(deal.meta_json);
    if (meta === null) {
      skipped += 1;
      continue;
    }
    const created_at = extractCreatedAt(meta);
    if (created_at === null) {
      skipped += 1;
      continue;
    }

    const window_start = created_at - ATTRIBUTION_WINDOW_MS;
    const owner_mailbox = resolveOwnerMailbox(meta.owner);
    const mail_rows = collectMailInWindow(ctx, window_start, created_at);
    const meeting_rows = collectMeetingsInWindow(ctx, window_start, created_at);
    const tally = tallyWindowActivity(mail_rows, meeting_rows, owner_mailbox);
    const decision = decideAttribution(tally);

    const value: AttributionSignalValue = {
      first_touch_source: decision.first_touch_source,
      first_touch_at: tally.earliest_at ?? created_at,
      first_touch_channel: decision.first_touch_channel,
      signals: buildSignalTokens(tally),
      computed_at: now,
    };

    // Pass meta through so memory-tab + drift reads stay coherent. The
    // reconciler is the meta source-of-truth; the producer just relays
    // what it already saw.
    ctx.enrichmentStore.upsert({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope,
      target_id: deal.target_id,
      value,
      authored_by: ATTRIBUTION_SIGNAL_AUTHORED_BY,
      event_at: now,
      meta: meta as EnrichmentMeta,
    });
    produced += 1;
  }

  return { produced, skipped };
};

/** One-shot cycle across all configured source scopes (HubSpot deal +
 *  Salesforce opportunity per D-130 P6). Returns aggregated produced /
 *  skipped counts. */
export const runAttributionSignalCycle = (
  ctx: HousekeepingContext,
): { produced: number; skipped: number } => {
  let produced = 0;
  let skipped = 0;
  for (const scope of ATTRIBUTION_SIGNAL_SOURCE_SCOPES) {
    const sub = runAttributionSignalCycleForScope(ctx, scope);
    produced += sub.produced;
    skipped += sub.skipped;
  }
  return { produced, skipped };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const attributionSignalTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.attribution_signal',
    description:
      'First-touch attribution per CRM deal — joins deal create time with mail / calendar within 30 days before. Cross-vendor across HubSpot deals and Salesforce opportunities (D-130 P6).',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.attribution_signal,
      isAiSurface: false,
    }),
  },
  topic: ATTRIBUTION_SIGNAL_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runAttributionSignalCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Token estimate exposed for the Run-Now preview. */
export const attributionSignalTokenEstimate = (): number => ATTRIBUTION_SIGNAL_TOKEN_ESTIMATE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog. */
export const attributionSignalScopeReadDeclaration = [
  {
    collection: 'data.enrichment.connection.api.hubspot.deal',
    sample_field_paths: ['meta.key_dates.created_at', 'meta.owner'],
  },
  {
    collection: 'data.enrichment.connection.api.salesforce.opportunity',
    sample_field_paths: ['meta.key_dates.created_at', 'meta.owner'],
  },
  {
    collection: 'data.mail',
    sample_field_paths: ['received_at', 'from'],
  },
  {
    collection: 'data.calendar',
    sample_field_paths: ['start_at'],
  },
] as const;
