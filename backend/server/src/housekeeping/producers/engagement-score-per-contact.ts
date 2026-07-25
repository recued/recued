/** D-129 P6 + D-130 P6 — `engagement_score_per_contact` enrichment producer.
 *
 *  Cross-source 0-100 engagement signal per CRM contact, joining
 *  vendor-side activity (`meta.recent_activity_at` — HubSpot's
 *  `notes_last_contacted` or Salesforce's `LastActivityDate`) with
 *  Recued local mail + calendar (`data.contact.<email>` activity,
 *  queried directly via the per-collection mail/calendar tables on
 *  the canonical email join key). Decomposes the score into three
 *  components — `<vendor>` / `local` / `recency` — and surfaces a
 *  `'rising' | 'flat' | 'falling'` trajectory by comparing the last
 *  30d activity rate against the 30-90d baseline.
 *
 *  Cross-vendor + registry-driven (D-130 P6 → D-192 S3): walks every
 *  `connection.api.<vendor>.contact` scope the vendor-entity registry declares
 *  with `crm_alias: 'contact'` (HubSpot + Salesforce + Pipedrive built in; any
 *  pack-declared CRM when the live merged registry reaches the cycle via
 *  `ctx.resolveVendorRegistry`). Producer logic is identical across vendors —
 *  every reconciler projects `meta.email` (canonical) + `meta.recent_activity_at`
 *  (parsed ms) — only the `signal_breakdown` key changes per row scope (the
 *  owning vendor id). `local` and `recency` are vendor-agnostic; `score` is
 *  the sum.
 *
 *  Substrate: same DISTINCT-target_id walk pattern as
 *  `attribution_signal`. The producer reads from `data_enrichment`
 *  rows already present for the source scope; first-row
 *  materialisation is a separate substrate concern (cascade engine +
 *  bus subscriber path). Tests seed rows.
 *
 *  Algorithm (per scope iteration):
 *
 *    1. `SELECT DISTINCT target_id` for the scope.
 *    2. For each contact, parse `meta` to extract canonical `email` +
 *       `recent_activity_at`.
 *    3. Tally local mail/calendar activity over `[now-30d, now]` and
 *       `[now-90d, now-30d]` keyed on the canonical email substring
 *       match against `data.mail.hot_fields` + co-attendance on
 *       `data.calendar` rows.
 *    4. Compute three components:
 *       - vendor    — vendor `recent_activity_at` recency, decayed
 *                     over a 30d half-life.
 *       - local     — local mail+calendar volume in last 30d, capped.
 *       - recency   — the most-recent meaningful touch from any
 *                     source, decayed over a 7d window.
 *    5. Total `score` = sum, clamped to [0, 100].
 *    6. `trajectory`: rising when `events_last_30d >= 1.5 * (events_30_90d/2)`;
 *       falling when `events_last_30d <= 0.5 * (events_30_90d/2)`;
 *       otherwise flat.
 *    7. Upsert at the source scope with meta passthrough; the value's
 *       `signal_breakdown` carries the vendor-specific key (`hubspot`
 *       or `salesforce`) but never both — empty key implies no signal,
 *       distinguishable from zero.
 *
 *  Cross-source join (load-bearing, per spec decision §3): the contact's
 *  `meta.email` is the canonical join key — recipes that combine CRM
 *  context with Recued local mail/calendar all hang off this same
 *  join, whichever vendor the contact came from.
 *
 *  Token cost: 0. Pure SQL aggregation.
 *
 *  Spec: D-129 §A.6 + §Phase 6 + load-bearing decision §3;
 *  D-130 §A.6 cross-vendor widening. */

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type ConnectionVendorEntity,
  type EngagementScorePerContactValue,
  type EnrichmentMeta,
  type EnrichmentScope,
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

/** Recent window — 30 days. Aligns with `behavioral_signature`'s 30d
 *  rolling window so cross-topic recipes reason about the same
 *  horizon. */
export const ENGAGEMENT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Baseline window — 30-90d ago. Wider half-life smooths weekly
 *  variance so the trajectory signal isn't whipsawed by single
 *  busy weeks. */
export const ENGAGEMENT_BASELINE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/** HubSpot recency half-life — 30 days. After 30d, the HubSpot
 *  component decays to half; after 60d to a quarter; etc. */
export const ENGAGEMENT_HUBSPOT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Recency component decay window — 7 days. Tighter than the HubSpot
 *  decay since "recency" is supposed to capture "how stale is this
 *  relationship right now"; 7d half-life makes a 14-day-old touch
 *  worth half a same-week touch. */
export const ENGAGEMENT_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Local-volume cap. The local component scales linearly with mail +
 *  calendar count up to this cap; beyond it, additional volume saturates.
 *  Caps the influence of high-volume communicators so a chatty contact
 *  doesn't max out the score on volume alone. */
export const ENGAGEMENT_LOCAL_VOLUME_CAP = 20;

/** Trajectory ratios. `'rising'` when the recent rate is ≥ this much
 *  higher than the baseline rate; `'falling'` when ≤ the inverse.
 *  Mirrors `meeting_frequency`'s 1.5× / 0.5× thresholds for
 *  cross-topic legibility. */
export const ENGAGEMENT_TRAJECTORY_RISING_RATIO = 1.5;
export const ENGAGEMENT_TRAJECTORY_FALLING_RATIO = 0.5;

/** Minimum combined sample (recent + baseline) before we report a
 *  trajectory other than `'flat'`. With fewer events the comparison
 *  is statistical noise. Mirrors `meeting_frequency`'s "small sample
 *  → flat" floor. */
export const ENGAGEMENT_TRAJECTORY_MIN_SAMPLE = 2;

/** Component caps. Sum to 100 — the score is the sum after clamping
 *  each component to its cap. */
export const ENGAGEMENT_HUBSPOT_CAP = 40;
export const ENGAGEMENT_LOCAL_CAP = 40;
export const ENGAGEMENT_RECENCY_CAP = 20;

/** Hard cap on contacts walked per cycle. */
export const ENGAGEMENT_MAX_CONTACTS_PER_CYCLE = 5000;

export const ENGAGEMENT_SCORE_AUTHORED_BY = 'system.housekeeping.engagement_score_per_contact';
export const ENGAGEMENT_SCORE_TOPIC: EnrichmentTopic = 'engagement_score_per_contact';

/** Default source scope. Retained for backwards compatibility with
 *  single-scope callers + D-129 P6 tests; the cycle derives its scopes from
 *  the vendor-entity registry (`engagementScoreSourceScopes`) and routes
 *  per-row by scope. */
export const ENGAGEMENT_SCORE_SOURCE_SCOPE = 'connection.api.hubspot.contact' as const;

/** D-192 S3 — the `(scope, vendor)` pairs the cycle walks, derived from the
 *  vendor-entity registry: every vendor declaring `crm_alias: 'contact'`
 *  (HubSpot + Salesforce + Pipedrive built in; any pack-declared CRM when the
 *  LIVE merged registry is passed via `ctx.resolveVendorRegistry`). The
 *  declaration-driven replacement for the old closed hubspot+salesforce scope
 *  list + vendor-key map — the vendor-carrying analog of
 *  `scopesForCrmAlias('contact')`. Producer logic is uniform: every CRM
 *  reconciler projects canonical `meta.email` + ms-parsed
 *  `meta.recent_activity_at`; `vendor` is the `signal_breakdown` key for the
 *  rows under `scope`. */
export const engagementScoreSourceScopes = (
  registry: ReadonlyArray<ConnectionVendorEntity> = CONNECTION_VENDOR_ENTITIES,
): ReadonlyArray<{ scope: EnrichmentScope; vendor: string }> =>
  registry
    .filter((e) => e.crm_alias === 'contact')
    .map((e) => ({ scope: e.scope, vendor: e.vendor }));

export const ENGAGEMENT_SCORE_TOKEN_ESTIMATE = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

export interface EngagementWindowTally {
  /** Mail rows where the canonical contact email appears in From / To /
   *  Cc within the recent (last 30d) window. */
  mail_recent: number;
  /** Same shape, baseline window (30-90d ago). */
  mail_baseline: number;
  /** Calendar rows where the canonical contact email appears in
   *  attendees within the recent window. */
  calendar_recent: number;
  /** Same shape, baseline window. */
  calendar_baseline: number;
  /** Most-recent activity timestamp across all four buckets, or null
   *  when the contact has no local activity within ±90d. */
  last_local_touch: number | null;
}

const EMPTY_TALLY = (): EngagementWindowTally => ({
  mail_recent: 0,
  mail_baseline: 0,
  calendar_recent: 0,
  calendar_baseline: 0,
  last_local_touch: null,
});

/** Exponential decay scoring — `score(elapsed) = cap * 2^(-elapsed/half_life)`.
 *  Returns 0 when `last_at` is null (no signal). */
export const decayScore = (
  last_at: number | null,
  now: number,
  half_life_ms: number,
  cap: number,
): number => {
  if (last_at === null) return 0;
  const elapsed = Math.max(0, now - last_at);
  const decay = Math.pow(2, -elapsed / half_life_ms);
  return cap * decay;
};

/** Linear-with-saturation scoring — `score(volume) = cap * min(1, volume/saturation)`.
 *  Returns 0 for zero volume. */
export const volumeScore = (
  volume: number,
  saturation: number,
  cap: number,
): number => {
  if (volume <= 0 || saturation <= 0) return 0;
  return cap * Math.min(1, volume / saturation);
};

/** Decide the trajectory bucket from recent vs baseline event counts.
 *  Baseline is halved before comparison to convert from 60d total to
 *  30d-equivalent rate (apples-to-apples with the recent window's 30d). */
export const decideTrajectory = (
  events_recent: number,
  events_baseline: number,
): 'rising' | 'flat' | 'falling' => {
  const total = events_recent + events_baseline;
  if (total < ENGAGEMENT_TRAJECTORY_MIN_SAMPLE) return 'flat';
  const baseline_rate = events_baseline / 2; // 60d → 30d-equiv
  if (baseline_rate === 0) {
    // No baseline → any recent activity is rising.
    return events_recent > 0 ? 'rising' : 'flat';
  }
  const ratio = events_recent / baseline_rate;
  if (ratio >= ENGAGEMENT_TRAJECTORY_RISING_RATIO) return 'rising';
  if (ratio <= ENGAGEMENT_TRAJECTORY_FALLING_RATIO) return 'falling';
  return 'flat';
};

/** Compose the full engagement value from a tally + the vendor's
 *  `recent_activity_at` field. Pure function — exposed for direct unit
 *  testing without the SQL plumbing. The `vendor_key` parameter controls
 *  which `signal_breakdown` field carries the vendor component — the id of
 *  the owning CRM vendor (`'hubspot'` / `'salesforce'` / `'pipedrive'` / any
 *  pack CRM). Open (`string`) since D-192, when the engagement plane went
 *  registry-driven. Defaults to `'hubspot'` for back-compat with the D-129
 *  single-vendor signature; cycle callers pass the scope-derived vendor. */
export const composeEngagementValue = (
  tally: EngagementWindowTally,
  vendor_recent_activity_at: number | null,
  now: number,
  vendor_key: string = 'hubspot',
): EngagementScorePerContactValue => {
  const vendor_component = Math.round(
    decayScore(vendor_recent_activity_at, now, ENGAGEMENT_HUBSPOT_HALF_LIFE_MS, ENGAGEMENT_HUBSPOT_CAP),
  );
  const local_volume = tally.mail_recent + tally.calendar_recent;
  const local_component = Math.round(
    volumeScore(local_volume, ENGAGEMENT_LOCAL_VOLUME_CAP, ENGAGEMENT_LOCAL_CAP),
  );
  const recency_component = Math.round(
    decayScore(tally.last_local_touch, now, ENGAGEMENT_RECENCY_HALF_LIFE_MS, ENGAGEMENT_RECENCY_CAP),
  );

  const sum = vendor_component + local_component + recency_component;
  const score = Math.max(0, Math.min(100, sum));
  const last_meaningful_touch = pickLastTouch(tally.last_local_touch, vendor_recent_activity_at);
  const trajectory = decideTrajectory(
    tally.mail_recent + tally.calendar_recent,
    tally.mail_baseline + tally.calendar_baseline,
  );

  // Per-vendor field on `signal_breakdown`, keyed by the owning CRM vendor
  // (`hubspot` / `salesforce` / `pipedrive` / any pack CRM). The non-owning
  // vendors' keys are omitted (not zeroed) so consumers can distinguish "no
  // signal recorded" from "vendor not enrolled".
  const signal_breakdown: EngagementScorePerContactValue['signal_breakdown'] = {
    local: local_component,
    recency: recency_component,
  };
  signal_breakdown[vendor_key] = vendor_component;

  return {
    score,
    last_meaningful_touch,
    signal_breakdown,
    trajectory,
    cursor_at: now,
  };
};

const pickLastTouch = (a: number | null, b: number | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return b!;
  if (b === null) return a;
  return Math.max(a, b);
};

// ────────────────────────────────────────────────────────────────
// Storage helpers
// ────────────────────────────────────────────────────────────────

interface ContactWalkRow {
  target_id: string;
  meta_json: string | null;
}

const listContactTargetIds = (
  ctx: HousekeepingContext,
  scope: string,
): ContactWalkRow[] => {
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
      ENGAGEMENT_MAX_CONTACTS_PER_CYCLE,
    ) as Array<{ target_id: string; meta_json: string | null }>;
  return rows;
};

interface ContactMetaShape {
  snapshot_at: number;
  snapshot_hash: string;
  email?: unknown;
  recent_activity_at?: unknown;
}

const parseContactMeta = (meta_json: string | null): ContactMetaShape | null => {
  if (meta_json === null) return null;
  try {
    return JSON.parse(meta_json) as ContactMetaShape;
  } catch {
    return null;
  }
};

const extractCanonicalEmail = (meta: ContactMetaShape): string | null => {
  if (typeof meta.email !== 'string' || meta.email.length === 0) return null;
  // Reconciler already canonicalized; trust it. canonicalOne is
  // idempotent so a re-canonicalize is a no-op on canonical input
  // (defense against a future reconciler revision dropping
  // canonicalization).
  return canonicalOne(meta.email);
};

const extractVendorRecentActivity = (meta: ContactMetaShape): number | null => {
  const ts = meta.recent_activity_at;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return ts;
};

/** Back-compat alias — D-129 P6 callers used the HubSpot-specific
 *  name. Renamed to vendor-agnostic `extractVendorRecentActivity`
 *  internally; the public export stays for existing tests. */
const extractHubspotRecentActivity = extractVendorRecentActivity;

/** Tally mail rows mentioning the contact email across both windows.
 *  Uses a substring `LIKE '%<email>%'` filter on `hot_fields` — same
 *  approach `behavioral_signature` uses, accepts that From/To/Cc are
 *  all in the JSON body. */
const tallyMailWindows = (
  ctx: HousekeepingContext,
  email: string,
  now: number,
): { recent: number; baseline: number; last_at: number | null } => {
  const recent_start = now - ENGAGEMENT_RECENT_WINDOW_MS;
  const baseline_start = now - ENGAGEMENT_RECENT_WINDOW_MS - ENGAGEMENT_BASELINE_WINDOW_MS;
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  let recent = 0;
  let baseline = 0;
  let last_at: number | null = null;
  for (const { name: table } of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at FROM "${table}"
          WHERE received_at >= ? AND received_at < ?
            AND hot_fields LIKE ?`,
      )
      .all(baseline_start, now, `%${email}%`) as Array<{ received_at: number }>;
    for (const row of rows) {
      if (row.received_at >= recent_start) recent += 1;
      else baseline += 1;
      if (last_at === null || row.received_at > last_at) last_at = row.received_at;
    }
  }
  return { recent, baseline, last_at };
};

/** Tally calendar attendance windows. Calendar `hot_fields` carries
 *  attendees as part of the JSON; substring match on the email is the
 *  same shape as `attendee_patterns`. */
const tallyCalendarWindows = (
  ctx: HousekeepingContext,
  email: string,
  now: number,
): { recent: number; baseline: number; last_at: number | null } => {
  const recent_start = now - ENGAGEMENT_RECENT_WINDOW_MS;
  const baseline_start = now - ENGAGEMENT_RECENT_WINDOW_MS - ENGAGEMENT_BASELINE_WINDOW_MS;
  const tables = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_calendar_%'`,
    )
    .all() as Array<{ name: string }>;
  let recent = 0;
  let baseline = 0;
  let last_at: number | null = null;
  for (const { name: table } of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT start_at, hot_fields FROM "${table}"
          WHERE start_at >= ? AND start_at < ?
            AND hot_fields LIKE ?`,
      )
      .all(baseline_start, now, `%${email}%`) as Array<{
        start_at: number;
        hot_fields: string;
      }>;
    for (const row of rows) {
      if (row.start_at >= recent_start) recent += 1;
      else baseline += 1;
      if (last_at === null || row.start_at > last_at) last_at = row.start_at;
    }
  }
  return { recent, baseline, last_at };
};

const buildTally = (
  ctx: HousekeepingContext,
  email: string,
  now: number,
): EngagementWindowTally => {
  const mail = tallyMailWindows(ctx, email, now);
  const cal = tallyCalendarWindows(ctx, email, now);
  const last_local_touch = pickLastTouch(mail.last_at, cal.last_at) || null;
  return {
    mail_recent: mail.recent,
    mail_baseline: mail.baseline,
    calendar_recent: cal.recent,
    calendar_baseline: cal.baseline,
    last_local_touch: last_local_touch === 0 ? null : last_local_touch,
  };
};

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

/** Per-scope sub-cycle. Exposed for direct test access so callers can
 *  exercise one vendor's path in isolation. Returns produced /
 *  skipped counts. */
export const runEngagementScoreCycleForScope = (
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  vendor_key: string,
): { produced: number; skipped: number } => {
  const now = ctx.now();
  const contacts = listContactTargetIds(ctx, scope);
  let produced = 0;
  let skipped = 0;

  for (const contact of contacts) {
    const meta = parseContactMeta(contact.meta_json);
    if (meta === null) {
      skipped += 1;
      continue;
    }
    const email = extractCanonicalEmail(meta);
    if (email === null) {
      // No usable join key; skip rather than emit a zero-signal row.
      skipped += 1;
      continue;
    }
    const vendor_recent = extractVendorRecentActivity(meta);
    const tally = email === '' ? EMPTY_TALLY() : buildTally(ctx, email, now);
    const value = composeEngagementValue(tally, vendor_recent, now, vendor_key);

    ctx.enrichmentStore.upsert({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope,
      target_id: contact.target_id,
      value,
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
      event_at: now,
      meta: meta as EnrichmentMeta,
    });
    produced += 1;
  }

  return { produced, skipped };
};

/** One-shot cycle across every CRM-contact source scope the registry declares
 *  (HubSpot + Salesforce + Pipedrive built in; pack CRMs when
 *  `ctx.resolveVendorRegistry` supplies the live merged registry — D-192 S3).
 *  Returns aggregated produced / skipped counts. */
export const runEngagementScoreCycle = (
  ctx: HousekeepingContext,
): { produced: number; skipped: number } => {
  const registry = ctx.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  let produced = 0;
  let skipped = 0;
  for (const { scope, vendor } of engagementScoreSourceScopes(registry)) {
    // Walk only scopes the store will actually WRITE — a candidate whose upsert
    // would reject is skipped, not walked-then-rejected. D-192 S4c3b relaxes the
    // prior STATIC `valid_scopes` intersection (which skipped every pack vendor) to
    // the store's `isScopeSupported`: it returns true for the static valid_scopes
    // AND for a pack `crm_alias:'contact'` scope now writable via the live registry
    // (S4b). So a Dynamics (or any pack) contact scope is scored, not skipped;
    // behavior-preserving for the built-ins (all already in valid_scopes).
    if (!ctx.enrichmentStore.isScopeSupported('engagement_score_per_contact', scope)) continue;
    const sub = runEngagementScoreCycleForScope(ctx, scope, vendor);
    produced += sub.produced;
    skipped += sub.skipped;
  }
  return { produced, skipped };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const engagementScorePerContactTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.engagement_score_per_contact',
    description:
      'Cross-source engagement score per CRM contact — joins vendor recent activity + Recued local mail/calendar via canonical email. Cross-vendor across HubSpot + Salesforce contacts (D-130 P6).',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.engagement_score_per_contact,
      isAiSurface: false,
    }),
  },
  topic: ENGAGEMENT_SCORE_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runEngagementScoreCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

export const engagementScorePerContactTokenEstimate = (): number =>
  ENGAGEMENT_SCORE_TOKEN_ESTIMATE;

export const engagementScorePerContactScopeReadDeclaration = [
  {
    collection: 'data.enrichment.connection.api.hubspot.contact',
    sample_field_paths: ['meta.email', 'meta.recent_activity_at'],
  },
  {
    collection: 'data.enrichment.connection.api.salesforce.contact',
    sample_field_paths: ['meta.email', 'meta.recent_activity_at'],
  },
  {
    // D-192 S3 — Pipedrive is the 3rd built-in crm_alias:'contact' vendor the
    // registry-driven cycle walks; disclose it in the Run-Now scope dialog too.
    collection: 'data.enrichment.connection.api.pipedrive.person',
    sample_field_paths: ['meta.email', 'meta.recent_activity_at'],
  },
  {
    collection: 'data.mail',
    sample_field_paths: ['received_at', 'from', 'to', 'cc'],
  },
  {
    collection: 'data.calendar',
    sample_field_paths: ['start_at', 'attendees'],
  },
] as const;
