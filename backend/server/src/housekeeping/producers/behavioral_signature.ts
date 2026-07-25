/** D-131 A.6 — `behavioral_signature` enrichment producer.
 *
 *  First contact-scope housekeeping topic on the harness shipped by
 *  D-123 P4. `aggregate` policy keyed on the contact's canonical
 *  email — folds many `data.mail` + `data.calendar` rows into a single
 *  `data.enrichment.contact.<email>.behavioral_signature` row that
 *  reactive recipes read to gate timing-sensitive alerts ("contact's
 *  reply latency drifted past their 7-day mean", "contact has gone
 *  quiet for 21 days") without paying per-recipe AI cost.
 *
 *  Distinct from the per-record AI producers (`summary`, `purpose`,
 *  `action_items`, `embedding`) in three ways:
 *
 *    1. **Deterministic** — zero token estimate, idle-eligible by
 *       construction. Pure SQL aggregation over the live mail +
 *       calendar collection tables.
 *    2. **Aggregate policy** — the harness skips the stale-row sweep
 *       and relies on the source-record-hash skip rule for forward
 *       walks. `hashContactRecord` (D-131 A.4) flips on
 *       `last_interaction` / `interaction_count` change so re-derivation
 *       fires the moment the contact gets new mail or calendar activity.
 *    3. **Contact source scope** — first producer to declare
 *       `HousekeepingEnrichmentProducer<ContactRecord>`. The walker
 *       paired in `bin.ts` is `createContactSourceWalker(contactStore)`
 *       (D-131 A.4); TS enforces the cross-scope pairing through
 *       `buildEnrichmentProducerTask`'s generic.
 *
 *  Failure modes:
 *    - Contact has no mail and no calendar yet (manual entry sitting
 *      ahead of any source row) → `produce` returns `null`; harness
 *      doesn't write a row.
 *    - Mail / calendar tables absent (fresh server) → SQL scan returns
 *      empty rows lists; producer treats as no-signal and returns null.
 *    - Malformed `hot_fields` JSON in a single row → row skipped, rest
 *      of aggregation continues. Same defense-in-depth pattern as
 *      `thread_signals`.
 *
 *  Spec: `docs/launch-sequence-2026-04-30.md` line 44 +
 *        `ENRICHMENT_REGISTRY.behavioral_signature`. */

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

/** Rolling window for the 30-day stats. The aggregate is computed
 *  forward-looking from `ctx.now()` — moves with the producer's
 *  perspective rather than the contact's `last_interaction`. */
const BEHAVIORAL_SIGNATURE_WINDOW_MS = 30 * 86_400_000;

/** Hot-field keys read off mail rows. Mirrors the canonical mail
 *  schema (`mail-collection.ts`) hand-specified hot fields. */
const MAIL_FROM_KEY = 'from';
const MAIL_TO_KEY = 'to';
const MAIL_CC_KEY = 'cc';
const MAIL_THREAD_ID_KEY = 'thread_id';

/** Hot-field keys read off calendar rows. Mirrors `hashCalendarRecord`
 *  in `source-walkers.ts` (the canonical calendar hash). */
const CAL_ORGANIZER_KEY = 'organizer';
const CAL_ATTENDEES_KEY = 'attendees';
const CAL_START_AT_KEY = 'start_at';

/** Pull the From-canonicalized email off a mail hot_fields blob. The
 *  hash extracts a single sender; reply-latency threading needs to
 *  decide whether a row was sent BY this contact (inbound) vs. a
 *  reply FROM the user (outbound). Empty string for malformed inputs. */
const senderOf = (hot: Record<string, unknown>): string => {
  const from = hot[MAIL_FROM_KEY];
  if (typeof from !== 'string') return '';
  return canonicalOne(from);
};

const threadIdOf = (hot: Record<string, unknown>): string => {
  const t = hot[MAIL_THREAD_ID_KEY];
  return typeof t === 'string' ? t : '';
};

/** Mail row shape returned by the SQL scan. `received_at` is the
 *  ingestion-time on the row (same column the canary uses); pulled out
 *  as a separate column rather than inside `hot_fields` to avoid
 *  re-parsing JSON. */
interface MailScanRow {
  received_at: number;
  hot_fields: Record<string, unknown>;
}

/** Calendar row shape. `start_at` lives inside `hot_fields` (D-117).
 *  Producers reading meeting cadence read `start_at` (the event time)
 *  rather than `received_at` (the sync-ingest time). */
interface CalendarScanRow {
  hot_fields: Record<string, unknown>;
}

/** Find every `collection_<platform>_*` table on the live database and
 *  return their names. Same approach `thread_signals` uses for mail —
 *  scanning `sqlite_master` keeps the producer free of per-collection
 *  registry plumbing while remaining cheap (the prefix index makes the
 *  scan O(log N) over the schema). */
const listCollectionTables = (
  ctx: HousekeepingContext,
  platform: 'mail' | 'calendar',
): string[] => {
  const prefix = `collection_${platform}_`;
  const rows = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE ?`,
    )
    .all(`${prefix}%`) as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

/** Pull every mail row whose canonical addresses involve `email`.
 *  The JSON `LIKE` filter is a pre-narrow — the precise canonical
 *  match happens in JS to handle display-name variants
 *  (`Bob <bob@x.com>` vs `bob@x.com`) the LIKE can't disambiguate.
 *  The local-part of the canonicalized email is unique enough that
 *  LIKE narrows the scan dramatically before JS filtering kicks in. */
const collectMailRows = (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): MailScanRow[] => {
  if (addresses.length === 0) return [];
  const out: MailScanRow[] = [];
  const tables = listCollectionTables(ctx, 'mail');
  for (const table of tables) {
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
        // Defense in depth — collection writers always JSON-encode.
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

const collectCalendarRows = (
  ctx: HousekeepingContext,
  addresses: readonly string[],
): CalendarScanRow[] => {
  if (addresses.length === 0) return [];
  const out: CalendarScanRow[] = [];
  const tables = listCollectionTables(ctx, 'calendar');
  for (const table of tables) {
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
      const all = new Set<string>();
      collectAddresses(parsed[CAL_ORGANIZER_KEY], all);
      collectAddresses(parsed[CAL_ATTENDEES_KEY], all);
      if (matchesAnyAddress(all, addresses)) {
        out.push({ hot_fields: parsed });
      }
    }
  }
  return out;
};

/** Compute reply-latency samples for the contact. Pairs each inbound
 *  mail (sender == contact email) with the earliest later reply in the
 *  same thread sent by the user (sender != contact email; recipient
 *  list contains contact email). The user's mailbox set is inferred
 *  from the rest of the data — any `from` address other than the
 *  contact's, when the contact is among the to/cc, looks like a reply
 *  for our purposes. This is intentionally permissive: a third party
 *  CC-ing the contact on a follow-up is signal too (the user's
 *  perspective is "the conversation moved forward"). */
const computeReplyLatencies = (
  rows: ReadonlyArray<MailScanRow>,
  addresses: readonly string[],
): number[] => {
  // D-205 #3.5 — "is the contact" is a SET test, and every use of it below moves
  // together. Widening the row scan while leaving the sender comparison on one
  // address would make the contact's own mail (sent from an address they later
  // merged away) look like somebody REPLYING to them, and its timestamp would
  // enter the latency distribution as a response time.
  const isContact = (addr: string): boolean =>
    addr !== '' && addresses.includes(addr);
  const inbounds = rows.filter((r) => isContact(senderOf(r.hot_fields)));
  if (inbounds.length === 0) return [];

  // Group rows by thread for O(thread_size) lookup per inbound rather
  // than scanning every row per inbound (would be O(N*M)).
  const byThread = new Map<string, MailScanRow[]>();
  for (const row of rows) {
    const tid = threadIdOf(row.hot_fields);
    if (tid === '') continue;
    const list = byThread.get(tid);
    if (list) list.push(row);
    else byThread.set(tid, [row]);
  }

  const latencies: number[] = [];
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
      if (isContact(sender)) continue; // another inbound — not a reply
      // Sibling must address the contact — otherwise it's an unrelated
      // forward of the same thread. Cheap check on already-collected
      // addresses.
      const toCc = new Set<string>();
      collectAddresses(sibling.hot_fields[MAIL_TO_KEY], toCc);
      collectAddresses(sibling.hot_fields[MAIL_CC_KEY], toCc);
      if (!matchesAnyAddress(toCc, addresses)) continue;
      if (sibling.received_at < earliestReplyAt) {
        earliestReplyAt = sibling.received_at;
      }
    }
    if (earliestReplyAt !== Number.POSITIVE_INFINITY) {
      latencies.push(earliestReplyAt - inbound.received_at);
    }
  }
  return latencies;
};

/** Per-record token estimate. Behavioral signature is fully
 *  deterministic; zero token cost. The harness's
 *  `buildEnrichmentProducerTask` reads this to flip
 *  `meta.idle_eligible` to true so the topic runs on the idle
 *  scheduler without manual confirmation. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

export const behavioralSignatureProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'behavioral_signature',
  source_scope: 'contact',
  scope_read_declaration: [
    {
      collection: 'data.contact',
      // `merged_into`: the mail + calendar scans read the merge graph to widen
      // themselves across the contact's absorbed addresses (D-205 #3.5).
      sample_field_paths: ['email', 'merged_into'],
    },
    {
      collection: 'data.mail',
      sample_field_paths: ['from', 'date', 'in_reply_to', 'message_id'],
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
    // D-205 #3.5 — every address this contact answers to.
    const addresses = contactAddresses(ctx, email);
    if (addresses.length === 0) return null;
    const now = ctx.now();
    const thirtyDaysAgo = now - BEHAVIORAL_SIGNATURE_WINDOW_MS;

    const mail_rows = collectMailRows(ctx, addresses);
    const calendar_rows = collectCalendarRows(ctx, addresses);

    if (mail_rows.length === 0 && calendar_rows.length === 0) {
      // Manual contact ahead of any source — no signal to record.
      return null;
    }

    const mail_count_total = mail_rows.length;
    let mail_count_window = 0;
    let last_inbound_at: number | null = null;
    for (const row of mail_rows) {
      if (row.received_at >= thirtyDaysAgo) mail_count_window += 1;
      if (addresses.includes(senderOf(row.hot_fields))) {
        if (last_inbound_at === null || row.received_at > last_inbound_at) {
          last_inbound_at = row.received_at;
        }
      }
    }

    const meeting_count_total = calendar_rows.length;
    let meeting_count_window = 0;
    let last_meeting_at: number | null = null;
    for (const row of calendar_rows) {
      const startAtRaw = row.hot_fields[CAL_START_AT_KEY];
      const startAt = typeof startAtRaw === 'number' && Number.isFinite(startAtRaw)
        ? startAtRaw
        : null;
      if (startAt === null) continue;
      if (startAt >= thirtyDaysAgo) meeting_count_window += 1;
      if (last_meeting_at === null || startAt > last_meeting_at) {
        last_meeting_at = startAt;
      }
    }

    const latencies = computeReplyLatencies(mail_rows, addresses);
    const reply_sample_count = latencies.length;
    let mean_reply_latency_ms: number | null = null;
    if (reply_sample_count > 0) {
      let sum = 0;
      for (const ms of latencies) sum += ms;
      mean_reply_latency_ms = Math.round(sum / reply_sample_count);
    }

    // Bench harvest (P1 v10) — subject identity denormalized onto the
    // value: the bench showed the agent reached this producer but could
    // not tell WHOSE stats it held, so it answered generically. `name`
    // omitted when the directory has none (never fabricated).
    const subjectName = source_record.data.name;
    const value = {
      ...(typeof subjectName === 'string' && subjectName.length > 0
        ? { name: subjectName }
        : {}),
      entity: email,
      mail_count_window,
      mail_count_total,
      meeting_count_window,
      meeting_count_total,
      mean_reply_latency_ms,
      reply_sample_count,
      last_meeting_at,
      last_inbound_at,
      computed_at: now,
      window_ms: BEHAVIORAL_SIGNATURE_WINDOW_MS,
    };
    return { value };
  },
};

export { BEHAVIORAL_SIGNATURE_WINDOW_MS };
