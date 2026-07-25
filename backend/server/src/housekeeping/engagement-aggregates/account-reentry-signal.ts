/** D-139 P4 — `account_reentry_signal` deterministic producer.
 *
 *  Account-scoped boolean state-at-observation. The signal flips
 *  `true` when:
 *    1. The account had ≥ `ACCOUNT_DORMANCY_DAYS` (60d) of zero
 *       qualifying engagement immediately before
 *    2. A qualifying engagement landed in the recent window
 *       (`ACCOUNT_REENTRY_RECENT_DAYS` = 14d).
 *
 *  Pass-4 evidence-quality consumption defaults baked in:
 *    - direction `'internal'` excluded — internal sync isn't
 *      account reentry.
 *    - lifecycle filter: `'point_in_time' | 'completed'` only.
 *    - authorship `'crm_automation'` + `'system_process'` excluded
 *      — workflow opens / tracking-pixel events don't constitute
 *      reentry.
 *
 *  Algorithm:
 *    1. Iterate engagement rows; partition into recent-window and
 *       pre-recent-window qualifying engagements.
 *    2. Find the latest pre-recent qualifying engagement → "the
 *       last touch before reentry."
 *    3. Find the freshest recent-window engagement → "the reentry
 *       event."
 *    4. Compute dormancy = recent.event_at - pre.event_at.
 *    5. `reentered = true` iff dormancy_days >= 60 AND a recent
 *       engagement exists.
 *
 *  Producer is intentionally simple — D-133 PSI-style drift
 *  detection over engagement volume is the optional richer follow-
 *  up; v1 ships boolean reentry only.
 *
 *  Spec: `docs/d-139-spec.md` § A.9.2b + § P4 acceptance. */

import {
  type AccountReentrySignalValue,
  type CoverageMetadata,
  type EngagementRow,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Dormancy threshold — 60 days of zero qualifying engagement
 *  before the recent window. Below this the account is "active,"
 *  not "dormant," and reentry doesn't apply. */
export const ACCOUNT_DORMANCY_DAYS = 60;
export const ACCOUNT_DORMANCY_MS = ACCOUNT_DORMANCY_DAYS * 24 * 60 * 60 * 1000;

/** Recent window — 14d. A qualifying engagement within this window
 *  can trigger reentry (when paired with prior dormancy). */
export const ACCOUNT_REENTRY_RECENT_DAYS = 14;
export const ACCOUNT_REENTRY_RECENT_MS = ACCOUNT_REENTRY_RECENT_DAYS * 24 * 60 * 60 * 1000;

/** Pre-window lookback — 365d. Beyond this we don't try to detect
 *  reentry (the signal is "dormant for a while" — not "dormant
 *  forever"). Bounds compute time; outside this window the
 *  producer reports `reentered = false` even if no prior
 *  engagement exists at all. */
export const ACCOUNT_REENTRY_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Same gate as breadth — qualifying account-side engagement. */
export const isQualifyingAccountEvent = (row: EngagementRow): boolean => {
  if (row.event_at === null) return false;
  if (row.direction === 'internal') return false;
  if (row.authorship === 'crm_automation' || row.authorship === 'system_process') return false;
  if (row.lifecycle_state !== 'point_in_time' && row.lifecycle_state !== 'completed') return false;
  return true;
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface AccountReentrySignalProducerInput {
  /** Engagement rows scoped to the account (via engagement_edges
   *  → account-affiliation walk). */
  rows: ReadonlyArray<EngagementRow>;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface AccountReentrySignalProducerOutput {
  value: AccountReentrySignalValue;
  coverage: CoverageMetadata;
}

export const computeAccountReentrySignal = (
  input: AccountReentrySignalProducerInput,
): AccountReentrySignalProducerOutput => {
  const recent_cutoff = input.now - ACCOUNT_REENTRY_RECENT_MS;
  const lookback_cutoff = input.now - ACCOUNT_REENTRY_LOOKBACK_MS;

  // Codex P1 #4 fold — collect ALL qualifying recent events sorted
  // by event_at ascending so we can pick the EARLIEST recent
  // engagement that broke dormancy as the reentry event. Pre-fold
  // the producer compared the freshest recent against the latest
  // pre-recent, ignoring any earlier recent engagements that
  // already broke dormancy. Example bug pre-fold:
  //   90d ago: E1 (pre-recent)
  //   13d ago: E2 (recent — actual reentry moment)
  //   3d ago : E3 (freshest recent)
  // Pre-fold reported `last_reentry_at = E3`; correct semantic is
  // `last_reentry_at = E2` (the moment dormancy ended).
  const recent_events: number[] = [];
  let latest_pre_recent_event_at = 0;
  let cursor_at = 0;

  for (const row of input.rows) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (!isQualifyingAccountEvent(row)) continue;
    if (row.event_at === null) continue; // re-asserted for type narrowing
    if (row.event_at < lookback_cutoff) continue;

    if (row.event_at >= recent_cutoff) {
      recent_events.push(row.event_at);
    } else {
      if (row.event_at > latest_pre_recent_event_at) {
        latest_pre_recent_event_at = row.event_at;
      }
    }
  }

  // Reentry requires:
  //   - At least one recent qualifying engagement.
  //   - Either no prior engagement in the lookback window OR a prior
  //     engagement that's at least ACCOUNT_DORMANCY_DAYS before the
  //     EARLIEST recent engagement.
  // Pick the earliest recent engagement; if it followed ≥60d of
  // dormancy, that's the reentry moment.
  let reentered = false;
  let dormancy_ms = 0;
  let last_reentry_at = 0;

  if (recent_events.length > 0) {
    // Sort ascending so [0] is the earliest — the candidate reentry
    // event that comes immediately after the dormancy gap.
    recent_events.sort((a, b) => a - b);
    const earliest_recent = recent_events[0]!;

    if (latest_pre_recent_event_at === 0) {
      // No prior engagement in lookback — treat the gap as
      // dormancy = full lookback. Handles "first time ever
      // engaging" and "dormant for years" identically (both are
      // valid reentry shapes; the producer doesn't distinguish at
      // v1).
      dormancy_ms = ACCOUNT_REENTRY_LOOKBACK_MS;
      reentered = true;
      last_reentry_at = earliest_recent;
    } else {
      const gap_ms = earliest_recent - latest_pre_recent_event_at;
      if (gap_ms >= ACCOUNT_DORMANCY_MS) {
        dormancy_ms = gap_ms;
        reentered = true;
        last_reentry_at = earliest_recent;
      }
    }
  }

  const dormancy_days = Math.floor(dormancy_ms / (24 * 60 * 60 * 1000));

  const value: AccountReentrySignalValue = {
    reentered,
    dormancy_days,
    last_reentry_at,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
