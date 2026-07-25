/** D-123 Phase 4 — `thread_signals` canary enrichment producer.
 *
 *  Cheapest housekeeping topic by design: pure aggregation over the
 *  walker's source records grouped by `thread_id`. No AI, no
 *  external calls, zero per-record token cost. Ships in P4 to
 *  validate the harness end-to-end — if the harness can't drive
 *  this, no other producer will work.
 *
 *  The producer's contract is per-mail-record: each call computes
 *  the thread-level rollup that the input mail belongs to. Multiple
 *  mails in the same thread carry identical rollup values; that
 *  redundancy matches the registry's per-record shape (`scope: mail`,
 *  `target_id: <mail record_id>`).
 *
 *  Spec: D-123 §4.3 + `ENRICHMENT_REGISTRY.thread_signals`. */

import type { CollectionRecord, ThreadSignalsValue } from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { resolvedContactPairs } from './_contact-names.js';

/** Aggregated value shape persisted under `data.enrichment.mail.<id>.thread_signals`.
 *  Re-exported from `@recued/contracts` so existing backend importers
 *  keep working. The value carries no `window_ms`: thread_signals
 *  folds every mail sharing `thread_id` (per-thread aggregate, not
 *  per-time-window). The registry's `recompute_cadence: '24h'` is the
 *  refresh interval, not a signal aperture. The §A.10 retrofit list
 *  excludes thread_signals for this reason (D-136 P3 follow-up —
 *  Codex review fix). */
export type { ThreadSignalsValue } from '@recued/contracts';

/** Hot-field key the producer reads from each mail record.
 *  Hand-specified per `mail-collection.ts` D-106 #2 schema. */
const THREAD_ID_KEY = 'thread_id';
const FROM_KEY = 'from';
const TO_KEY = 'to';
const CC_KEY = 'cc';
const IS_READ_KEY = 'is_read';

/** Lower-case + trimmed local-part-of-mailbox extractor, mirrors
 *  the `extractAddress` helper in `mail-collection.ts:209`. We only
 *  need uniqueness for the participant count, so case-folding +
 *  trimming is sufficient. */
const normaliseAddress = (mailbox: string): string => {
  const m = mailbox.match(/<([^>]+@[^>]+)>/);
  return (m ? m[1] : mailbox).trim().toLowerCase();
};

const collectAddresses = (value: unknown, into: Set<string>): void => {
  if (value == null) return;
  if (typeof value === 'string' && value.length > 0) {
    into.add(normaliseAddress(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) into.add(normaliseAddress(v));
    }
  }
};

/** Pull the thread_id from a mail hot_fields blob. Returns `''` when
 *  the message lacks a thread_id (rare for IMAP / Gmail; can happen
 *  for raw-imported messages with no server-assigned thread). The
 *  empty-string thread is treated as a degenerate one-message
 *  thread by the producer below. */
const threadIdOf = (record: CollectionRecord): string => {
  const raw = record.hot_fields[THREAD_ID_KEY];
  return typeof raw === 'string' ? raw : '';
};

const isUnread = (record: CollectionRecord): boolean => {
  const raw = record.hot_fields[IS_READ_KEY];
  // is_read flips: true means already-read; the rollup wants
  // has_unread, so the producer negates here.
  if (typeof raw === 'boolean') return !raw;
  return false;
};

const dayOf = (epoch_ms: number): number => Math.floor(epoch_ms / 86_400_000);

const SUBJECT_KEY = 'subject';

/** `Re:` / `Fw:` / `Fwd:` (optionally `[N]`-numbered) reply-chain prefix.
 *  Display variant of `topic_cluster`'s token-bag normalisation — this
 *  one PRESERVES casing + punctuation because the value is shown to a
 *  consumer, not compared. */
const REPLY_PREFIX_RE = /^\s*(?:re|fwd?|fw)\s*(?:\[\d+\])?\s*:\s*/i;

/** Canonical display subject: reply-prefix chain stripped, original
 *  casing kept. `undefined` for a missing / empty subject so the
 *  optional field is omitted rather than emitted as `''`. */
const displaySubject = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(REPLY_PREFIX_RE, '');
    if (next === s) break;
    s = next.trimStart();
  }
  return s.length > 0 ? s : undefined;
};

/** Bench harvest (P1 v6/v9) — the optional denormalized surface shared
 *  by all three emit paths: display subject, resolved participant
 *  `{ entity, name }` pairs, and thread recency. The bench measured
 *  ~9.8K tokens + mean 4 hops per thread question when the agent had to
 *  follow up with entity.query for exactly these facts. Every field is
 *  OMITTED (never fabricated) when the source carries nothing. */
const harvestExtras = (
  ctx: HousekeepingContext,
  participants: ReadonlySet<string>,
  subjectRaw: unknown,
  latest_received_at: number | undefined,
): Partial<
  Pick<ThreadSignalsValue, 'subject' | 'participant_contacts' | 'latest_received_at'>
> => {
  const subject = displaySubject(subjectRaw);
  const participant_contacts = resolvedContactPairs(ctx, participants);
  return {
    ...(subject !== undefined ? { subject } : {}),
    ...(participant_contacts.length > 0 ? { participant_contacts } : {}),
    ...(typeof latest_received_at === 'number' && Number.isFinite(latest_received_at)
      ? { latest_received_at }
      : {}),
  };
};

/** Enumerate every mail record in the same scope that shares
 *  `thread_id`. Uses the housekeeping context's `db` directly via
 *  the collection table layout (`collection_mail_<slugHash>`).
 *  Walker isn't strictly needed here — the producer reads its own
 *  thread siblings, not the harness's forward iteration — so we
 *  scan the live mail collection tables ourselves.
 *
 *  Returns one virtual record per mail in the thread (across all
 *  mail accounts; thread_ids are scoped per-account in IMAP/Gmail
 *  but we accept whatever the source provides). Drops messages
 *  whose hot_fields don't carry `thread_id` since they can't
 *  contribute to a meaningful rollup. */
const collectThreadSiblings = (
  ctx: HousekeepingContext,
  thread_id: string,
): Array<{ received_at: number; hot_fields: Record<string, unknown> }> => {
  if (thread_id === '') return [];
  // The collection-table naming convention is `collection_mail_<hash>`
  // (see `backend/server/src/collections/table.ts:227`); the housekeeping
  // task can find every live mail collection by querying sqlite_master
  // for the prefix. Using SQL directly keeps the producer free of
  // collection-registry plumbing — same approach the P3 link-discovery
  // task uses against the provenance links table.
  const tables = (ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_mail_%'`,
    )
    .all() as Array<{ name: string }>).map((r) => r.name);

  const siblings: Array<{ received_at: number; hot_fields: Record<string, unknown> }> = [];
  for (const table of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields FROM "${table}"
          WHERE json_extract(hot_fields, '$.thread_id') = ?`,
      )
      .all(thread_id) as Array<{ received_at: number; hot_fields: string }>;
    for (const row of rows) {
      try {
        const hot = JSON.parse(row.hot_fields) as Record<string, unknown>;
        siblings.push({ received_at: row.received_at, hot_fields: hot });
      } catch {
        // Malformed row — skip. The collection layer's invariant is
        // that hot_fields is always JSON-serialised; a parse failure
        // here is forensic but shouldn't kill the producer.
      }
    }
  }
  return siblings;
};

/** The canary producer. Deterministic + zero-token by construction. */
export const threadSignalsProducer: HousekeepingEnrichmentProducer = {
  topic: 'thread_signals',
  source_scope: 'mail',
  scope_read_declaration: [
    {
      collection: 'data.mail',
      sample_field_paths: ['thread_id', 'date', 'from', 'subject'],
    },
  ],
  estimate_per_record_tokens: () => 0,
  recompute_cadence: '24h',

  async produce(ctx, source_record: SourceRecord) {
    const thread_id = threadIdOf(source_record.data);
    if (thread_id === '') {
      // Degenerate "thread of one" — emit the trivial rollup so
      // recipes reading data.enrichment.mail.<id>.thread_signals
      // never see undefined for a real mail record.
      const participants = new Set<string>();
      collectAddresses(source_record.data.hot_fields[FROM_KEY], participants);
      collectAddresses(source_record.data.hot_fields[TO_KEY], participants);
      collectAddresses(source_record.data.hot_fields[CC_KEY], participants);
      const value: ThreadSignalsValue = {
        thread_id: '',
        message_count: 1,
        participant_count: participants.size,
        span_days: 0,
        has_unread: isUnread(source_record.data),
        ...harvestExtras(
          ctx,
          participants,
          source_record.data.hot_fields[SUBJECT_KEY],
          source_record.data.received_at,
        ),
      };
      return { value };
    }

    const siblings = collectThreadSiblings(ctx, thread_id);
    if (siblings.length === 0) {
      // Should not happen — the source record itself shares the
      // thread_id we just pulled — but if the SQL scan misses
      // (e.g. running against a stub registry), fall back to the
      // single-record view rather than throwing.
      const participants = new Set<string>();
      collectAddresses(source_record.data.hot_fields[FROM_KEY], participants);
      collectAddresses(source_record.data.hot_fields[TO_KEY], participants);
      collectAddresses(source_record.data.hot_fields[CC_KEY], participants);
      return {
        value: {
          thread_id,
          message_count: 1,
          participant_count: participants.size,
          span_days: 0,
          has_unread: isUnread(source_record.data),
          ...harvestExtras(
            ctx,
            participants,
            source_record.data.hot_fields[SUBJECT_KEY],
            source_record.data.received_at,
          ),
        } satisfies ThreadSignalsValue,
      };
    }

    const participants = new Set<string>();
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    let latestSubjectRaw: unknown;
    let has_unread = false;

    for (const sibling of siblings) {
      collectAddresses(sibling.hot_fields[FROM_KEY], participants);
      collectAddresses(sibling.hot_fields[TO_KEY], participants);
      collectAddresses(sibling.hot_fields[CC_KEY], participants);
      const ts = sibling.received_at;
      if (ts < earliest) earliest = ts;
      if (ts > latest) {
        latest = ts;
        latestSubjectRaw = sibling.hot_fields[SUBJECT_KEY];
      }
      const isReadVal = sibling.hot_fields[IS_READ_KEY];
      if (typeof isReadVal === 'boolean' && !isReadVal) has_unread = true;
    }

    const span_days =
      latest !== Number.NEGATIVE_INFINITY && earliest !== Number.POSITIVE_INFINITY
        ? dayOf(latest) - dayOf(earliest)
        : 0;

    const value: ThreadSignalsValue = {
      thread_id,
      message_count: siblings.length,
      participant_count: participants.size,
      span_days,
      has_unread,
      ...harvestExtras(
        ctx,
        participants,
        latestSubjectRaw,
        latest !== Number.NEGATIVE_INFINITY ? latest : undefined,
      ),
    };
    return { value };
  },
};
