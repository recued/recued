/** D-139 P4 — `champion_deal_count` deterministic producer.
 *
 *  Contact-scoped (perspective) — counts distinct deals the contact
 *  has touched, segmented by closed status. Folds across HubSpot
 *  deal `close_state` ∈ `'won' | 'lost' | 'open'` + Salesforce
 *  opportunity `IsWon` / `IsClosed`. Surfaces champions vs blockers.
 *
 *  Producer surface is intentionally pure-compute over a per-deal
 *  tally (`ChampionDealRow[]`); the caller's substrate-side walker
 *  is responsible for enforcing Pass-4 evidence-quality filters at
 *  edge-walk time before tally construction. Codex P4 P2 #1 design
 *  note — the producer cannot enforce the filters itself because the
 *  champion/blocker computation needs deal-status info (won / lost /
 *  open) that lives on CRM deal records, not on EngagementRow rows.
 *  The substrate-side caller MUST gate engagements at edge-walk time
 *  per spec § P4 line 1506 acceptance:
 *    - `authorship IN ('user', 'crm_user', 'unknown')` — exclude
 *      `'crm_automation'` + `'system_process'` (workflow / pixel
 *      events don't constitute champion-quality touches).
 *    - `lifecycle_state IN ('point_in_time', 'completed')` — exclude
 *      pending / scheduled / cancelled / failed / no_answer rows.
 *    - `direction != 'internal'` — exclude rep-internal sync.
 *    - `dedupe_acceptance: 'exact_only'` — feed probable-twin pairs
 *      as separate engagements; caller dedupes per-deal at the
 *      engagement_edges fan-out stage.
 *  After this gate, the caller emits one `ChampionDealRow` per
 *  distinct deal that has at least one qualifying engagement
 *  edged-back-to-the-contact. Production wiring (engagement-edges
 *  fan-out + per-deal CRM meta read + tally builder) deferred per
 *  the P3-substrate-canary pattern.
 *
 *  Algorithm:
 *    1. Iterate the per-deal tally; partition by closed status.
 *    2. Compute total_deals + won_deals + lost_deals + open_deals.
 *    3. win_rate = won / (won + lost) — `0` when no closed sample.
 *    4. Bucket: champion / mixed / blocker / unknown per thresholds.
 *
 *  Spec: `docs/d-139-spec.md` § A.9.2b + § P4 acceptance line 1506. */

import {
  type ChampionDealBucket,
  type ChampionDealCountValue,
  type CoverageMetadata,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Champion bucket — ≥ 2 wins AND win_rate ≥ 0.6. Doesn't catch
 *  one-win champions (could be lucky); doesn't admit champions
 *  with majority-loss patterns. */
export const CHAMPION_MIN_WINS = 2;
export const CHAMPION_MIN_WIN_RATE = 0.6;

/** Blocker bucket — ≥ 2 losses AND win_rate ≤ 0.2. Catches
 *  contacts whose deals systematically end in losses. */
export const CHAMPION_BLOCKER_MIN_LOSSES = 2;
export const CHAMPION_BLOCKER_MAX_WIN_RATE = 0.2;

/** Unknown bucket fallback — fewer than 2 closed deals total. */
export const CHAMPION_UNKNOWN_MIN_CLOSED = 2;

// ────────────────────────────────────────────────────────────────
// Producer-supplied evidence shapes
// ────────────────────────────────────────────────────────────────

/** Per-deal tally the producer consumes. Caller resolves
 *  contact-touched-deal via engagement_edges → deal-edge fan-out
 *  with the qualifying-engagement gate; producer is pure compute
 *  on the resulting shape. */
export interface ChampionDealRow {
  /** Vendor-prefixed deal id (e.g. `hubspot_deal_47291`). Producer
   *  doesn't parse this; caller is responsible for vendor
   *  attribution. */
  deal_id: string;
  /** Closed status — derived from CRM record meta:
   *    HubSpot: `'won'` when `meta.close_state === 'won'`;
   *             `'lost'` when `meta.close_state === 'lost'`;
   *             `'open'` otherwise.
   *    Salesforce: `'won'` when `IsWon === true`;
   *                `'lost'` when `IsClosed && !IsWon`;
   *                `'open'` otherwise.
   *  `'unknown'` when status can't be derived (no meta,
   *  pre-D-128 row). Counted toward `total_deals` but not
   *  toward win/loss buckets. */
  status: 'won' | 'lost' | 'open' | 'unknown';
  /** Latest deal vendor_modified_at. Producer folds the max into
   *  cursor_at. */
  vendor_modified_at: number;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Bucket the contact's deal pattern into the closed enum.
 *  Insufficient closed sample → 'unknown'. */
export const decideChampionBucket = (
  won_deals: number,
  lost_deals: number,
  win_rate: number,
): ChampionDealBucket => {
  const closed_total = won_deals + lost_deals;
  if (closed_total < CHAMPION_UNKNOWN_MIN_CLOSED) return 'unknown';
  if (won_deals >= CHAMPION_MIN_WINS && win_rate >= CHAMPION_MIN_WIN_RATE) return 'champion';
  if (lost_deals >= CHAMPION_BLOCKER_MIN_LOSSES && win_rate <= CHAMPION_BLOCKER_MAX_WIN_RATE) return 'blocker';
  return 'mixed';
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface ChampionDealCountProducerInput {
  /** Per-deal tally for the contact — DISTINCT deals where the
   *  contact has at least one qualifying engagement, with each
   *  deal's closed status. Caller computes via engagement_edges
   *  fan-out + per-deal CRM meta read. */
  rows: ReadonlyArray<ChampionDealRow>;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. (Unused at v1; reserved for
   *  future window-clamp on closed_at — not yet on the row shape.) */
  now: number;
}

export interface ChampionDealCountProducerOutput {
  value: ChampionDealCountValue;
  coverage: CoverageMetadata;
}

export const computeChampionDealCount = (
  input: ChampionDealCountProducerInput,
): ChampionDealCountProducerOutput => {
  // Dedupe by deal_id — caller is expected to dedupe but we
  // defensively unique-by-id to avoid double-counting if a deal
  // appears twice (e.g. multi-recipient surface).
  const seen = new Set<string>();
  let won_deals = 0;
  let lost_deals = 0;
  let open_deals = 0;
  let total_deals = 0;
  let cursor_at = 0;

  for (const row of input.rows) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (seen.has(row.deal_id)) continue;
    seen.add(row.deal_id);
    total_deals += 1;
    if (row.status === 'won') won_deals += 1;
    else if (row.status === 'lost') lost_deals += 1;
    else if (row.status === 'open') open_deals += 1;
    // 'unknown' counted toward total_deals only.
  }

  const closed_total = won_deals + lost_deals;
  const win_rate = closed_total > 0 ? won_deals / closed_total : 0;
  const bucket = decideChampionBucket(won_deals, lost_deals, win_rate);

  const value: ChampionDealCountValue = {
    total_deals,
    won_deals,
    lost_deals,
    open_deals,
    win_rate,
    bucket,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
