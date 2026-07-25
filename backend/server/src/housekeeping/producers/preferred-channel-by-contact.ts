/** D-145 PA9 — `preferred_channel_by_contact` enrichment producer.
 *
 *  Per-contact behavioural derivation: which channel does this contact
 *  actually respond on? Counts mail messages + calendar events that
 *  involve the contact's canonical email over a rolling 90-day window;
 *  if one channel carries the strict majority of touches the producer
 *  emits the matching `<channel>_preferred` value, otherwise
 *  `mixed_no_clear_preference`.
 *
 *  Behavioural, not sentiment — spec § A.1.5 narrow taxonomy explicitly
 *  forbids "sentiment" framing. Counts are pure observation; the value
 *  exposes the breakdown so consumers can show "you mailed 12× and
 *  met 0× in the last 90 days" rather than guessing intent.
 *
 *  Sample floor: 5 combined touches over the window. Below that the
 *  producer abstains (returns `null`) and the harness leaves the
 *  prior row (if any) standing — same convention as the other
 *  contact-scope aggregate producers.
 *
 *  Channels covered today: `email` (via `data.mail`) + `meeting`
 *  (via `data.calendar`). The closed-list output also names
 *  `call_preferred` + `text_preferred`; those land when the
 *  engagement edges substrate (D-139) starts feeding call / SMS
 *  signals into the producer. Spec § A.7.6 #3 enumerates engagements
 *  as a third source (per § A.7.3 the registry's `aggregates_from` is
 *  scoped to cascade walkers only; the engagements path is read-time
 *  and ships in a follow-on slice).
 *
 *  Cascade invalidation: triggers on `data.mail.received` +
 *  `data.calendar.event_completed` per the declaration. The registry's
 *  `aggregates_from: ['mail', 'calendar']` walks both source scopes —
 *  any source-record change re-stages this producer for the affected
 *  contact via the standard harness skip-rule path.
 *
 *  Spec: D-145 §§ A.7.2 + A.7.6 #3 +
 *        `ENRICHMENT_REGISTRY.preferred_channel_by_contact` +
 *        `packages/contracts/src/enrichment-declarations/preferred-channel-by-contact.ts`. */

import {
  type ContactRecord,
  type PreferredChannel,
  type PreferredChannelByContactValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { collectAddresses } from './_email-addresses.js';
import {
  contactAddresses,
  likeAnyParams,
  matchesAnyAddress,
  sqlLikeAny,
} from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 90-day rolling window — matches the registry's
 *  `aggregate_window_ms` so cascade invalidation + producer
 *  computation agree on the same horizon. */
export const PREFERRED_CHANNEL_WINDOW_MS = 90 * 86_400_000;

/** Combined-touch sample floor. Below this the channel split is
 *  noise — one mail + zero meetings doesn't establish a preference.
 *  Matches the declaration's `sample_floor: 5`. */
export const PREFERRED_CHANNEL_SAMPLE_FLOOR = 5;

/** Strict-majority threshold. A channel must exceed this fraction of
 *  combined touches to be named `<channel>_preferred`; otherwise the
 *  producer returns `mixed_no_clear_preference`. Strictly greater so
 *  a 50/50 split is "mixed" rather than tiebreaking to a single
 *  channel. */
export const PREFERRED_CHANNEL_DOMINANT_THRESHOLD = 0.5;

/** Per-record token estimate. Deterministic — pure SQL aggregation +
 *  arithmetic. Zero-token, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

/** Hot-field keys read off mail rows. Mirrors `reply_patterns`'s
 *  canonical mail hash. */
const MAIL_FROM_KEY = 'from';
const MAIL_TO_KEY = 'to';
const MAIL_CC_KEY = 'cc';

/** Hot-field keys read off calendar rows. Mirrors `meeting_frequency`'s
 *  canonical calendar hash. */
const CAL_ORGANIZER_KEY = 'organizer';
const CAL_ATTENDEES_KEY = 'attendees';
const CAL_START_AT_KEY = 'start_at';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Closed-list channel keys the producer emits scores for. `call` +
 *  `text` are reserved (declaration carries them) but never produced
 *  by this slice — engagements substrate adds them later. */
export type ChannelKey = 'email' | 'meeting' | 'call' | 'text';

const PREFERENCE_FOR_CHANNEL: Record<
  ChannelKey,
  Exclude<PreferredChannel, 'mixed_no_clear_preference'>
> = {
  email: 'email_preferred',
  meeting: 'meeting_preferred',
  call: 'call_preferred',
  text: 'text_preferred',
};

/** Pick the preference label from a channel-keyed count breakdown.
 *  Pure function — exposed for direct unit testing without the SQL
 *  plumbing.
 *
 *  Algorithm:
 *    - Sum all counts; zero total → `'mixed_no_clear_preference'`
 *      (defensive — the producer skips below `sample_floor` first,
 *      but the pure helper still handles it).
 *    - Find the single channel with the highest count.
 *    - If that channel's count strictly exceeds `threshold * total`,
 *      return the matching `<channel>_preferred`. Otherwise return
 *      `'mixed_no_clear_preference'`.
 *
 *  Ties (two channels with the same highest count) yield mixed —
 *  the dominant-channel count fails the strict-majority test once
 *  another channel matches it. */
export const decidePreferredChannel = (
  score_breakdown: Readonly<Partial<Record<ChannelKey, number>>>,
  threshold: number = PREFERRED_CHANNEL_DOMINANT_THRESHOLD,
): PreferredChannel => {
  let total = 0;
  let topChannel: ChannelKey | null = null;
  let topCount = 0;
  let topIsTied = false;
  for (const [channel, raw] of Object.entries(score_breakdown) as Array<
    [ChannelKey, number | undefined]
  >) {
    const count = raw ?? 0;
    if (!Number.isFinite(count) || count < 0) continue;
    total += count;
    if (count > topCount) {
      topChannel = channel;
      topCount = count;
      topIsTied = false;
    } else if (count === topCount && count > 0) {
      topIsTied = true;
    }
  }
  if (total === 0 || topChannel === null) return 'mixed_no_clear_preference';
  if (topIsTied) return 'mixed_no_clear_preference';
  if (topCount / total > threshold) {
    return PREFERENCE_FOR_CHANNEL[topChannel];
  }
  return 'mixed_no_clear_preference';
};

// ────────────────────────────────────────────────────────────────
// Source-table walkers
// ────────────────────────────────────────────────────────────────

const listMailCollectionTables = (ctx: HousekeepingContext): string[] => {
  const rows = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

const listCalendarCollectionTables = (ctx: HousekeepingContext): string[] => {
  const rows = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_calendar_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

/** Count mail rows involving `email` whose `received_at` falls inside
 *  `[since, now)`. Same canonical From/To/Cc pre-narrow approach
 *  `reply_patterns` + `behavioral_signature` use — the substring
 *  `LIKE` is a cheap server-side filter; the JSON canonical check
 *  rejects false positives (an email substring inside a body fragment
 *  doesn't pass the canonical match). */
export const countMailMentionsInWindow = (
  ctx: HousekeepingContext,
  email: string,
  since: number,
  now: number,
): number => {
  if (email === '') return 0;
  // D-205 #3.5 — across the merge group. This producer picks a PREFERRED
  // channel by comparing mail volume against meeting volume, so a merge that
  // hides one channel's history behind an absorbed address doesn't just lower a
  // count — it can flip the recommendation.
  const addresses = contactAddresses(ctx, email);
  if (addresses.length === 0) return 0;
  let count = 0;
  for (const table of listMailCollectionTables(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields FROM "${table}"
          WHERE received_at >= ? AND received_at < ?
            AND (${sqlLikeAny('hot_fields', addresses.length)})`,
      )
      .all(since, now, ...likeAnyParams(addresses)) as Array<{
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
      const all = new Set<string>();
      collectAddresses(parsed[MAIL_FROM_KEY], all);
      collectAddresses(parsed[MAIL_TO_KEY], all);
      collectAddresses(parsed[MAIL_CC_KEY], all);
      if (matchesAnyAddress(all, addresses)) count += 1;
    }
  }
  return count;
};

/** Count calendar rows involving `email` whose `start_at` (parsed from
 *  `hot_fields` JSON) falls inside `[since, now)`. Same canonical
 *  organizer/attendees pre-narrow approach `meeting_frequency` +
 *  `attendee_patterns` use — calendar tables carry `start_at` inside
 *  the JSON, not as a SQL column (collections/table.ts:231-241), so
 *  windowing happens client-side. Rows whose `hot_fields` doesn't
 *  carry a numeric `start_at` are excluded (same convention
 *  `meeting_frequency` uses for events we can't place on a timeline). */
export const countCalendarMentionsInWindow = (
  ctx: HousekeepingContext,
  email: string,
  since: number,
  now: number,
): number => {
  if (email === '') return 0;
  // D-205 #3.5 — across the merge group (see `countMailMentionsInWindow`: the
  // two counts are compared against each other, so they must span the same
  // identity or the comparison is between a whole channel and half of another).
  const addresses = contactAddresses(ctx, email);
  if (addresses.length === 0) return 0;
  let count = 0;
  for (const table of listCalendarCollectionTables(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT hot_fields FROM "${table}"
          WHERE ${sqlLikeAny('hot_fields', addresses.length)}`,
      )
      .all(...likeAnyParams(addresses)) as Array<{ hot_fields: string }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      const startAtRaw = parsed[CAL_START_AT_KEY];
      if (typeof startAtRaw !== 'number' || !Number.isFinite(startAtRaw)) continue;
      if (startAtRaw < since || startAtRaw >= now) continue;
      const all = new Set<string>();
      collectAddresses(parsed[CAL_ORGANIZER_KEY], all);
      collectAddresses(parsed[CAL_ATTENDEES_KEY], all);
      if (matchesAnyAddress(all, addresses)) count += 1;
    }
  }
  return count;
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const preferredChannelByContactProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'preferred_channel_by_contact',
  source_scope: 'contact',
  scope_read_declaration: [
    // `merged_into`: both channel counts read the merge graph to widen
    // themselves across the contact's absorbed addresses (D-205 #3.5).
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.mail',
      sample_field_paths: ['from', 'to', 'cc', 'received_at'],
    },
    {
      collection: 'data.calendar',
      sample_field_paths: ['organizer', 'attendees', 'start_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '7d',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();
    const since = now - PREFERRED_CHANNEL_WINDOW_MS;

    const email_count = countMailMentionsInWindow(ctx, email, since, now);
    const meeting_count = countCalendarMentionsInWindow(ctx, email, since, now);

    if (email_count + meeting_count < PREFERRED_CHANNEL_SAMPLE_FLOOR) {
      // Sample floor unmet — declaration's `source_degradation_reasons`
      // names `'sample_floor_unmet'` for this path; the producer
      // abstains rather than emit a thin signal.
      return null;
    }

    // Only emit channels with positive counts. Recipes that read
    // `score_breakdown.call` get `undefined` and can render "no signal"
    // distinct from `0` ("observed and confirmed absence") if the
    // engagements path lights up later.
    const score_breakdown: Partial<Record<ChannelKey, number>> = {};
    if (email_count > 0) score_breakdown.email = email_count;
    if (meeting_count > 0) score_breakdown.meeting = meeting_count;

    const preference = decidePreferredChannel(score_breakdown);

    const value: PreferredChannelByContactValue = {
      preference,
      score_breakdown: score_breakdown as Record<string, number>,
      computed_at: now,
    };
    return { value };
  },
};
