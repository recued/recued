/** D-131 A.7 — `reply_patterns` enrichment producer.
 *
 *  Second contact-scope housekeeping producer (after A.6
 *  `behavioral_signature`); first to expand from a single mean
 *  latency to the full distribution. `aggregate` policy reading
 *  `data.mail` only, keyed on canonical email — calendar context lives
 *  on adjacent topics (`meeting_frequency`, `attendee_patterns`).
 *
 *  Output shape (`ReplyPatternsValue`):
 *    - `inbound_count_window`        — volume context for the rate
 *                                      (D-136 P3 follow-up rename of
 *                                      `inbound_count_30d`).
 *    - `reply_sample_count_window`   — replied inbounds in the window
 *                                      (D-136 rename of
 *                                      `reply_sample_count_30d`).
 *    - `reply_rate_window`           — `replied / inbound`, null when
 *                                      no inbound (D-136 rename of
 *                                      `reply_rate_30d`).
 *    - `reply_sample_count`          — all-time pair count (drives confidence)
 *    - `mean_reply_latency_ms`       — averages across all-time samples
 *    - `p50_reply_latency_ms`        — median latency
 *    - `p95_reply_latency_ms`        — tail latency (null below 5 samples)
 *    - `computed_at`                 — `ctx.now()` of this run
 *    - `window_ms`                   — window aperture in ms (D-136 §A.10)
 *
 *  Distinct from `behavioral_signature` (A.6):
 *    - A.6 carries one mean + sample count; A.7 carries the full
 *      distribution + windowed reply rate.
 *    - A.6 reads mail + calendar; A.7 reads mail only — keeps the
 *      producer cheap and aligned with the registry's
 *      `aggregates_from: ['mail']`.
 *    - Same contact walker (`sourceWalkers.get('contact')`), same
 *      `parseAddress` canonicalization, same JSON-LIKE pre-narrow +
 *      JS canonical match. The thread-pairing primitive is duplicated
 *      verbatim for now — codebase convention is to extract at the
 *      third caller (per `_mail-body.ts` precedent at A.1); A.7 is the
 *      second caller.
 *
 *  Percentile method: nearest-rank — `rank = ceil(p * n)`,
 *  `index = rank - 1` over the sorted samples. Avoids interpolation
 *  ambiguity (e.g. p50 of `[100, 200]` returns 200 unambiguously
 *  rather than 150) and matches what most "did response time exceed
 *  X" recipe gates expect.
 *
 *  Failure modes:
 *    - Contact has no inbound mail and no thread context → `produce`
 *      returns `null`; harness skips.
 *    - Mail tables absent on a fresh server → SQL scan returns empty;
 *      producer treats as no signal.
 *    - Malformed `hot_fields` JSON in a single row → row skipped,
 *      aggregation continues.
 *
 *  Spec: `docs/launch-sequence-2026-04-30.md` line 45 +
 *        `ENRICHMENT_REGISTRY.reply_patterns`. */

import { type ContactRecord } from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { canonicalOne, collectAddresses } from './_email-addresses.js';
import {
  contactAddresses,
  likeAnyParams,
  matchesAnyAddress,
  sqlLikeAny,
} from './_contact-addresses.js';
import { percentile } from './_stats.js';

/** Rolling window for the 30-day rate. Forward-looking from `ctx.now()`,
 *  same convention `behavioral_signature` uses. */
const REPLY_PATTERNS_WINDOW_MS = 30 * 86_400_000;

/** Minimum sample size below which p95 stays null. Below 5 the tail
 *  is dominated by sampling noise and recipes shouldn't be alarmed by
 *  a single 3-week outlier. p50 has no such floor — even a single
 *  sample's p50 is well-defined and useful. */
const P95_MIN_SAMPLE_COUNT = 5;

/** Mail hot-field keys. Mirror the canonical mail schema referenced
 *  by `behavioral_signature` and `thread_signals`. */
const MAIL_FROM_KEY = 'from';
const MAIL_TO_KEY = 'to';
const MAIL_CC_KEY = 'cc';
const MAIL_THREAD_ID_KEY = 'thread_id';

const senderOf = (hot: Record<string, unknown>): string => {
  const from = hot[MAIL_FROM_KEY];
  if (typeof from !== 'string') return '';
  return canonicalOne(from);
};

const threadIdOf = (hot: Record<string, unknown>): string => {
  const t = hot[MAIL_THREAD_ID_KEY];
  return typeof t === 'string' ? t : '';
};

interface MailScanRow {
  received_at: number;
  hot_fields: Record<string, unknown>;
}

/** Find every `collection_mail_*` table on the live database. Same
 *  prefix-scan approach `thread_signals` and `behavioral_signature`
 *  use. */
const listMailCollectionTables = (ctx: HousekeepingContext): string[] => {
  const rows = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

/** Pull every mail row whose canonical addresses involve ANY of the contact's
 *  addresses. JSON-LIKE pre-narrow + JS canonical match — same approach
 *  `behavioral_signature` uses.
 *
 *  D-205 #3.5 — `addresses` is the contact's whole merge group, so mail sent to
 *  or from an address the contact later merged away from still counts as theirs. */
const collectMailRows = (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): MailScanRow[] => {
  if (addresses.length === 0) return [];
  const out: MailScanRow[] = [];
  for (const table of listMailCollectionTables(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields FROM "${table}"
          WHERE ${sqlLikeAny('hot_fields', addresses.length)}`,
      )
      .all(...likeAnyParams(addresses)) as Array<{
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
      if (matchesAnyAddress(all, addresses)) {
        out.push({ received_at: row.received_at, hot_fields: parsed });
      }
    }
  }
  return out;
};

/** One reply pair the producer derives. `inbound_at` keys the 30-day
 *  windowing decision (we count an inbound as "replied within window"
 *  when the inbound itself was sent in the window — the reply may
 *  arrive later); `latency_ms` is the all-time distribution input. */
interface ReplyPair {
  inbound_at: number;
  latency_ms: number;
}

/** Pair each inbound mail (sender IS the contact) with the earliest later
 *  in-thread reply that addresses the contact in to/cc and was sent by anyone
 *  other than the contact. Same pairing logic `behavioral_signature` uses;
 *  lifted to a helper inside this file rather than shared because A.7 is the
 *  second caller and the codebase convention is to wait for the third.
 *
 *  🔑 **D-205 #3.5 — "is the contact" is a set test, and BOTH sides of it must
 *  move together.** Widening only the row collection while leaving the sender
 *  comparison keyed on the single address would be worse than leaving this
 *  alone: mail the contact sent from an address they later merged away would
 *  stop being recognised as *theirs* and start counting as **someone replying
 *  to them** — the contact's own follow-up, scored as their correspondent's
 *  response time. */
const computeReplyPairs = (
  rows: ReadonlyArray<MailScanRow>,
  addresses: readonly string[],
): ReplyPair[] => {
  const isContact = (addr: string): boolean =>
    addr !== '' && addresses.includes(addr);
  const inbounds = rows.filter((r) => isContact(senderOf(r.hot_fields)));
  if (inbounds.length === 0) return [];

  const byThread = new Map<string, MailScanRow[]>();
  for (const row of rows) {
    const tid = threadIdOf(row.hot_fields);
    if (tid === '') continue;
    const list = byThread.get(tid);
    if (list) list.push(row);
    else byThread.set(tid, [row]);
  }

  const pairs: ReplyPair[] = [];
  for (const inbound of inbounds) {
    const tid = threadIdOf(inbound.hot_fields);
    if (tid === '') continue;
    const siblings = byThread.get(tid);
    if (!siblings) continue;
    let earliestReplyAt = Number.POSITIVE_INFINITY;
    for (const sibling of siblings) {
      if (sibling === inbound) continue;
      if (sibling.received_at <= inbound.received_at) continue;
      const sender = senderOf(sibling.hot_fields);
      // Any address the contact answers to — a follow-up they sent themselves
      // from an absorbed address is not a reply TO them.
      if (isContact(sender)) continue;
      const toCc = new Set<string>();
      collectAddresses(sibling.hot_fields[MAIL_TO_KEY], toCc);
      collectAddresses(sibling.hot_fields[MAIL_CC_KEY], toCc);
      if (!matchesAnyAddress(toCc, addresses)) continue;
      if (sibling.received_at < earliestReplyAt) {
        earliestReplyAt = sibling.received_at;
      }
    }
    if (earliestReplyAt !== Number.POSITIVE_INFINITY) {
      pairs.push({
        inbound_at: inbound.received_at,
        latency_ms: earliestReplyAt - inbound.received_at,
      });
    }
  }
  return pairs;
};

// Nearest-rank `percentile` lives in the shared `_stats.ts` (extracted
// at A.20's third caller per the codebase convention). Imported above.

/** Mean over a number array. Returns null on empty so the
 *  null-or-finite contract on `mean_reply_latency_ms` is enforced at
 *  one site. */
const meanOf = (xs: ReadonlyArray<number>): number | null => {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return Math.round(sum / xs.length);
};

/** Per-record token estimate. Reply patterns is fully deterministic
 *  (SQL aggregation + sorted percentile). Zero-token, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

export const replyPatternsProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'reply_patterns',
  source_scope: 'contact',
  scope_read_declaration: [
    {
      collection: 'data.contact',
      // `merged_into`: the mail scan reads the merge graph to widen itself
      // across the contact's absorbed addresses (D-205 #3.5).
      sample_field_paths: ['email', 'merged_into'],
    },
    {
      collection: 'data.mail',
      sample_field_paths: ['from', 'to', 'date', 'in_reply_to', 'thread_id'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '7d',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    // D-205 #3.5 — every address this contact answers to, not just the one it is
    // keyed on today.
    const addresses = contactAddresses(ctx, email);
    if (addresses.length === 0) return null;
    const now = ctx.now();
    const thirtyDaysAgo = now - REPLY_PATTERNS_WINDOW_MS;

    const mail_rows = collectMailRows(ctx, addresses);
    if (mail_rows.length === 0) {
      // No mail involves the contact — nothing meaningful to record.
      // Manual contact ahead of any source row, or contact who has
      // only ever appeared on calendar invites without a mail trail.
      return null;
    }

    const inbounds = mail_rows.filter((r) =>
      addresses.includes(senderOf(r.hot_fields)),
    );
    if (inbounds.length === 0) {
      // Contact appears only as recipient — never sent inbound. No
      // reply signal to record. Returning null keeps the enrichment
      // table free of recipient-only rows; `behavioral_signature`
      // captures the recipient-only flow in `mail_count_total`.
      return null;
    }

    // 30-day inbound count + per-pair window membership use the
    // inbound's `received_at`. A reply that lands AFTER the window
    // still counts toward the 30d rate so long as the inbound was in
    // the window (recipes want to know "the user had a chance to
    // reply, did they?"). When no inbound is in the window the
    // 30d-rate fields stay zero / null but the all-time distribution
    // still emits — recipes reading "this contact has been quiet
    // historically" benefit from the row.
    const inbound_count_window = inbounds
      .filter((r) => r.received_at >= thirtyDaysAgo)
      .length;

    const pairs = computeReplyPairs(mail_rows, addresses);
    const reply_sample_count_window = pairs
      .filter((p) => p.inbound_at >= thirtyDaysAgo)
      .length;
    const reply_rate_window = inbound_count_window > 0
      ? reply_sample_count_window / inbound_count_window
      : null;

    const latencies = pairs.map((p) => p.latency_ms).sort((a, b) => a - b);
    const reply_sample_count = latencies.length;

    const mean_reply_latency_ms = meanOf(latencies);
    const p50_reply_latency_ms = percentile(latencies, 0.5);
    const p95_reply_latency_ms = reply_sample_count >= P95_MIN_SAMPLE_COUNT
      ? percentile(latencies, 0.95)
      : null;

    // Bench harvest (P1 v12a) — subject identity denormalized onto the
    // value; the bench's "Tess And Daniel" shared-mailbox case showed
    // consumers misattribute reply stats without it. `name` omitted when
    // the directory has none (never fabricated).
    const subjectName = source_record.data.name;
    const value = {
      ...(typeof subjectName === 'string' && subjectName.length > 0
        ? { name: subjectName }
        : {}),
      entity: email,
      inbound_count_window,
      reply_sample_count_window,
      reply_rate_window,
      reply_sample_count,
      mean_reply_latency_ms,
      p50_reply_latency_ms,
      p95_reply_latency_ms,
      computed_at: now,
      window_ms: REPLY_PATTERNS_WINDOW_MS,
    };
    return { value };
  },
};

export {
  REPLY_PATTERNS_WINDOW_MS,
  P95_MIN_SAMPLE_COUNT,
  percentile,
};
