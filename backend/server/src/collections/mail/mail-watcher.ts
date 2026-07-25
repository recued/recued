/** D-115 Phase 6B — mail-watcher backend handler.
 *
 *  Reads the server's `data.mail.<slug>` warehouse and fires when new
 *  messages (received after the caller's `since` cursor) match
 *  optional from / subject / label filters.
 *
 *  Cursor semantics:
 *    - `since` bounds `received_at` (when the warehouse first saw
 *      the message). Matches the manifest's "messages newer than
 *      since" description — mail adapters write received_at from
 *      the upstream `Date:` header.
 *    - Advancement is the author's responsibility: `last_seen_at`
 *      is the returned envelope field; the author pairs a
 *      `shared-write` step with `{{trigger.<step_id>.last_seen_at}}`
 *      to persist the cursor.
 *
 *  Filter strategy:
 *    - `from` ⇒ exact equality filter pushed into the SQL path via
 *      `hot_fields.from`. Adapters store the bare address (no
 *      display name); callers should normalize before matching.
 *    - `subject` ⇒ case-insensitive substring matched in JS after
 *      fetch (hot-field filters in CollectionListQuery are equality-
 *      only). Over-fetch is bounded by SUBJECT_OVERFETCH_FACTOR.
 *    - `label` ⇒ exact membership in the record's `labels[]` hot
 *      field, matched in JS after fetch (same reason — no array-
 *      contains on CollectionListQuery).
 *
 *  Metadata-only: `body_inline` + `blob_hash` are stripped before
 *  surfacing items into the downstream trigger context so message
 *  bodies never leave the warehouse.
 *
 *  Missing collection: returns a no-fire envelope. Matches calendar-
 *  watcher precedent — a restarting / unreachable adapter should
 *  not trip the reactive scheduler's circuit breaker.
 */

import { IngredientError } from '@recued/ingredients';
import type { CollectionRecord } from '@recued/contracts';

import type { Collection } from '../types.js';

/** Over-fetch factor for the subject/label in-JS filter pass. Keeps
 *  the post-filter result close to `limit` even when most rows
 *  don't match the substring / label predicate. Hard ceiling at
 *  MAX_FETCH_LIMIT so a pathological filter can't pull the whole
 *  table. */
const SUBJECT_OVERFETCH_FACTOR = 4;
const MAX_FETCH_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export interface MailWatcherArgs {
  slug: string;
  since?: number;
  from?: string;
  subject?: string;
  label?: string;
  limit?: number;
}

/** Narrow item shape returned to the downstream recipe. `hot_fields`
 *  carries mail's `{from, subject, thread_id, folder, is_read,
 *  labels?}` per the adapter contract. */
export interface MailWatcherItem {
  record_id: string;
  received_at: number;
  modified_at: number;
  source_id: string;
  size_bytes: number;
  hot_fields: Record<string, unknown>;
}

export interface MailWatcherOutput {
  should_run: boolean;
  items: MailWatcherItem[];
  last_seen_at: number;
  [field: string]: unknown;
}

export interface MailWatcherDeps {
  /** Registry-backed lookup by slug. `undefined` ⇒ no such
   *  collection enrolled; the handler emits a no-fire envelope. */
  getCollection: (slug: string) => Collection | undefined;
  /** `Date.now()` injection for deterministic tests. */
  now?: () => number;
}

const parseArgs = (input: Record<string, unknown>): MailWatcherArgs => {
  const slug = input.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'mail-watcher: `slug` is required',
      { got: slug },
    );
  }
  const out: MailWatcherArgs = { slug };
  if (typeof input.since === 'number' && Number.isFinite(input.since)) {
    out.since = input.since;
  }
  if (typeof input.from === 'string' && input.from !== '') {
    out.from = input.from;
  }
  if (typeof input.subject === 'string' && input.subject !== '') {
    out.subject = input.subject;
  }
  if (typeof input.label === 'string' && input.label !== '') {
    out.label = input.label;
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    out.limit = input.limit;
  }
  return out;
};

const resolveLimit = (raw: number | undefined): number => {
  const n = raw ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(n, MAX_FETCH_LIMIT));
};

const toItem = (record: CollectionRecord): MailWatcherItem => ({
  record_id: record.record_id,
  received_at: record.received_at,
  modified_at: record.modified_at,
  source_id: record.source_id,
  size_bytes: record.size_bytes,
  hot_fields: { ...record.hot_fields },
});

const matchesSubject = (
  record: CollectionRecord,
  subject: string,
): boolean => {
  const field = record.hot_fields.subject;
  if (typeof field !== 'string') return false;
  return field.toLowerCase().includes(subject.toLowerCase());
};

const matchesLabel = (record: CollectionRecord, label: string): boolean => {
  const labels = record.hot_fields.labels;
  if (!Array.isArray(labels)) return false;
  return labels.includes(label);
};

export const handleMailWatcher = async (
  deps: MailWatcherDeps,
  input: Record<string, unknown>,
): Promise<MailWatcherOutput> => {
  const args = parseArgs(input);
  const now = (deps.now ?? Date.now)();

  const collection = deps.getCollection(args.slug);
  if (!collection || collection.platform !== 'mail') {
    return { should_run: false, items: [], last_seen_at: now };
  }

  const outputLimit = resolveLimit(args.limit);
  const needsJsFilter = args.subject !== undefined || args.label !== undefined;
  const fetchLimit = needsJsFilter
    ? Math.min(outputLimit * SUBJECT_OVERFETCH_FACTOR, MAX_FETCH_LIMIT)
    : outputLimit;

  const filters: Record<string, unknown> = {};
  if (args.from !== undefined) filters.from = args.from;

  const records = collection.list({
    platform: 'mail',
    slug: args.slug,
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    limit: fetchLimit,
  });

  const matches: CollectionRecord[] = [];
  for (const record of records) {
    if (args.subject !== undefined && !matchesSubject(record, args.subject)) continue;
    if (args.label !== undefined && !matchesLabel(record, args.label)) continue;
    matches.push(record);
    if (matches.length >= outputLimit) break;
  }

  // `collection.list` returns newest-first by received_at; re-sort
  // ascending so the consumer's cursor advances monotonically.
  matches.sort((a, b) => a.received_at - b.received_at);

  let maxSeen = args.since ?? 0;
  const items: MailWatcherItem[] = [];
  for (const record of matches) {
    items.push(toItem(record));
    if (record.received_at > maxSeen) maxSeen = record.received_at;
  }

  // Quiet window ⇒ roll cursor forward to `now` so a silent inbox
  // doesn't force re-scans from the same point forever.
  const lastSeenAt = items.length > 0 ? maxSeen : now;

  return {
    should_run: items.length > 0,
    items,
    last_seen_at: lastSeenAt,
  };
};
