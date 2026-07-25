/** D-123 Phase 4 — Source-collection walker registry.
 *
 *  The enrichment-producer harness walks source collections via a
 *  small adapter table: one `SourceCollectionWalker` per
 *  `EnrichmentScope`. Each walker abstracts away the per-platform
 *  storage layout (mail collections are per-`(platform, slug)` SQLite
 *  tables, contact collections live in a single SQLite table, etc.)
 *  so the harness can iterate records monotonically without knowing
 *  which collection family it's looking at.
 *
 *  P4 ships only the `mail` walker (the canary `thread_signals`
 *  producer is mail-scoped). `contact` / `calendar` / `file` walkers
 *  + the three `connection.*` walkers ship with their respective
 *  housekeeping producers in subsequent Ds — adding a new scope is
 *  one entry on `createSourceWalkerRegistry`.
 *
 *  Spec: `docs/d-123-spec.md` §4.2. */

import type { ContactRecord, EnrichmentScope, Note, Project, Task } from '@recued/contracts';

import type { CollectionRecord } from '@recued/contracts';
import type { CollectionRegistry } from '../collections/registry.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { Collection } from '../collections/types.js';
import type {
  CalendarCollectionTable,
  CalendarRowSnapshot,
} from '../collections/calendar/calendar-table.js';

/** One source-collection record handed to a producer. `target_id` is
 *  the record's primary key inside its scope (mail `record_id`,
 *  contact email, calendar event id, etc.); `data` is the raw record
 *  the producer reads to derive its enrichment value; `cursor_token`
 *  is the opaque string the harness persists for resume — walker-
 *  defined format. */
export interface SourceRecord<TData = CollectionRecord> {
  target_id: string;
  data: TData;
  /** Where this record sits in the walker's monotonic order. The
   *  harness stores this back on the topic cursor's
   *  `max_target_id_seen` field so the next walk resumes from the
   *  right place. Walkers compose this however they want — the
   *  harness treats it as opaque. The mail walker uses
   *  `<slug>\0<record_id>` so multiple mail accounts walk
   *  predictably. */
  cursor_token: string;
}

export interface SourceCollectionWalker<TData = CollectionRecord> {
  /** Iterate records of the source collection in monotonic order
   *  starting AFTER `cursor_token`. Yields synchronously up to
   *  `batch_size` records — the harness calls `walkAfter` again to
   *  pick up where the prior batch ended, advancing through
   *  `cursor_token`. Returns an empty iterable when no records
   *  remain (the harness flips `status: 'complete'`). */
  walkAfter(cursor_token: string, batch_size: number): Iterable<SourceRecord<TData>>;
  /** Hash of canonical fields used to detect "source unchanged since
   *  last enrichment." The harness compares this to the persisted
   *  `data_enrichment.source_record_hash` to skip no-work records.
   *  Walkers MUST hash only fields that affect producer output —
   *  hashing `received_at` would make every re-sync look like a
   *  source change. */
  hashOf(record: SourceRecord<TData>): string;
  /** Re-fetch a record by its target_id. Used by the harness when
   *  the cascade engine marks a row stale (`stale=1`) and the
   *  producer needs the current source data without walking. Returns
   *  `null` when the record has been deleted from the source. */
  fetchOne(target_id: string): SourceRecord<TData> | null;
}

// ────────────────────────────────────────────────────────────────
// Mail walker
// ────────────────────────────────────────────────────────────────

/** Separator character for the mail walker's composite cursor token.
 *  NUL is the right pick: it can't appear in slugs (TOML-validated
 *  identifiers) and SQLite preserves it through prepared-statement
 *  binding. */
const MAIL_CURSOR_SEP = '\0';

/** 32-bit FNV-1a — same algorithm the recipe-hash machinery uses;
 *  good enough for change detection at adapter-call latency. Shared
 *  by every mail-record hasher below. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** Hash the mail fields that drive producer output. Recipients,
 *  subject, thread_id, folder, is_read, message_id all matter for
 *  the canary `thread_signals` producer; receipt time + size do not.
 *  Body content is excluded because thread_signals doesn't read it
 *  — producers that DO read body pass `hashMailRecordWithBody` to
 *  `createMailSourceWalker` instead. */
const hashMailRecord = (record: CollectionRecord): string => {
  const hot = record.hot_fields;
  const fields = [
    String(hot.from ?? ''),
    Array.isArray(hot.to) ? hot.to.join(',') : String(hot.to ?? ''),
    Array.isArray(hot.cc) ? hot.cc.join(',') : String(hot.cc ?? ''),
    String(hot.subject ?? ''),
    String(hot.thread_id ?? ''),
    String(hot.folder ?? ''),
    String(hot.is_read ?? ''),
    String(hot.message_id ?? record.source_id),
  ].join(MAIL_CURSOR_SEP);
  return fnv1a(fields);
};

/** Body-aware mail hash. Producers that read body content (`summary`,
 *  `purpose`, `action_items`, `embedding`, ...) pass this to
 *  `createMailSourceWalker` so a body change re-runs them.
 *
 *  Cost trick: when the body lives in CAS (>64 KB), we hash the
 *  `blob_hash` directly — the CAS hash is already a SHA-256 of the
 *  bytes, so adding it to the digest is O(1) regardless of body
 *  size. Inline bodies (≤64 KB) FNV-1a as usual. */
export const hashMailRecordWithBody = (record: CollectionRecord): string => {
  const baseFields = hashMailRecord(record);
  const inline = typeof record.body_inline === 'string' ? record.body_inline : '';
  const blob = typeof record.blob_hash === 'string' ? record.blob_hash : '';
  return fnv1a(`${baseFields}${MAIL_CURSOR_SEP}${blob}${MAIL_CURSOR_SEP}${inline}`);
};

const splitMailCursor = (token: string): { slug: string; record_id: string } => {
  if (token === '') return { slug: '', record_id: '' };
  const idx = token.indexOf(MAIL_CURSOR_SEP);
  if (idx < 0) return { slug: token, record_id: '' };
  return {
    slug: token.slice(0, idx),
    record_id: token.slice(idx + 1),
  };
};

const composeMailCursor = (slug: string, record_id: string): string =>
  `${slug}${MAIL_CURSOR_SEP}${record_id}`;

export interface CreateMailSourceWalkerOptions {
  /** Per-walker hash function. Defaults to the canonical
   *  thread_signals hash (`hashMailRecord`) which excludes body
   *  content. AI-driven producers reading body content pass
   *  `hashMailRecordWithBody` (or a custom variant) so a body
   *  change marks the source row dirty for re-derivation. */
  hashRecord?: (record: CollectionRecord) => string;
}

/** Build a `mail` walker over a `CollectionRegistry`. Iterates every
 *  registered mail collection in slug order; within each, walks
 *  records by `record_id` ASC. The composite cursor token (`<slug>\0
 *  <record_id>`) lets the harness resume mid-account after a yield
 *  without skipping records or duplicating work.
 *
 *  Slug ordering is locale-naive `<` comparison — stable across
 *  process restarts because slugs are TOML-validated identifiers.
 *  New mail accounts enrolled mid-walk land at the end of the slug
 *  order, picked up after the harness's current cursor exhausts.
 *  Removed accounts disappear silently — the harness's hash-skip
 *  rule keeps any pre-existing enrichment rows in place; the
 *  cascade engine handles deletion through its own delete-on-source
 *  hook. */
export const createMailSourceWalker = (
  collections: CollectionRegistry,
  options?: CreateMailSourceWalkerOptions,
): SourceCollectionWalker => {
  const hashFn = options?.hashRecord ?? hashMailRecord;
  const liveMailCollections = () =>
    collections
      .list()
      .filter((c) => c.platform === 'mail')
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  return {
    *walkAfter(cursor_token: string, batch_size: number): Generator<SourceRecord> {
      const { slug: cursor_slug, record_id: cursor_record_id } = splitMailCursor(
        cursor_token,
      );
      let yielded = 0;
      for (const collection of liveMailCollections()) {
        // Skip slugs that come strictly before the cursor's slug.
        if (collection.slug < cursor_slug) continue;
        // For the cursor's slug, only walk records past cursor_record_id.
        // For later slugs, walk from the beginning.
        const records = collection
          .list({ platform: 'mail', slug: collection.slug, limit: 10_000 })
          .sort((a, b) =>
            a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0,
          );
        for (const record of records) {
          if (collection.slug === cursor_slug && record.record_id <= cursor_record_id) {
            continue;
          }
          if (yielded >= batch_size) return;
          yield {
            target_id: record.record_id,
            data: record,
            cursor_token: composeMailCursor(collection.slug, record.record_id),
          };
          yielded += 1;
        }
      }
    },

    hashOf(record: SourceRecord): string {
      return hashFn(record.data);
    },

    fetchOne(target_id: string): SourceRecord | null {
      // target_id is a mail record_id; we need to find which slug it
      // lives in. Scan the live collections — N is small (typical
      // user has 1-3 mail accounts) and `get` is O(1) per call.
      for (const collection of liveMailCollections()) {
        const record = collection.get(target_id);
        if (record !== null) {
          return {
            target_id,
            data: record,
            cursor_token: composeMailCursor(collection.slug, target_id),
          };
        }
      }
      return null;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Calendar walker
// ────────────────────────────────────────────────────────────────

/** Calendar walker mirrors the mail walker's shape exactly: calendar
 *  collections register one Collection instance per gcal / graph /
 *  caldav account, indexed by `(platform: 'calendar', slug)` on the
 *  same `CollectionRegistry`. The composite cursor token (`<slug>\0
 *  <record_id>`) lets the harness resume mid-account after a yield
 *  the same way it does for mail. */

const CALENDAR_CURSOR_SEP = ' ';

const splitCalendarCursor = (token: string): { slug: string; record_id: string } => {
  if (token === '') return { slug: '', record_id: '' };
  const idx = token.indexOf(CALENDAR_CURSOR_SEP);
  if (idx < 0) return { slug: token, record_id: '' };
  return {
    slug: token.slice(0, idx),
    record_id: token.slice(idx + 1),
  };
};

const composeCalendarCursor = (slug: string, record_id: string): string =>
  `${slug}${CALENDAR_CURSOR_SEP}${record_id}`;

/** Hash the calendar fields that drive producer output. Producers
 *  reading attendee composition (`attendee_patterns`,
 *  `behavioral_signature`), reschedule timing (`meeting_reschedule_pattern`),
 *  meeting cadence (`meeting_frequency`), or meeting prep
 *  (`preparation_notes`, `related_threads`) all care about
 *  start / end / status / attendees / summary / location / organizer.
 *  Things they don't care about: `received_at`, `modified_at`,
 *  `ical_uid` (stable across edits), `is_all_day` / `is_recurring`
 *  (derived). */
export const hashCalendarRecord = (record: CollectionRecord): string => {
  const hot = record.hot_fields;
  const attendees = Array.isArray(hot.attendees)
    ? (hot.attendees as unknown[])
        .map((a) => (typeof a === 'string' ? a : (a as { email?: unknown })?.email ?? ''))
        .filter((s): s is string => typeof s === 'string')
        .sort()
        .join(',')
    : String(hot.attendees ?? '');
  const fields = [
    String(hot.summary ?? ''),
    String(hot.start_at ?? ''),
    String(hot.end_at ?? ''),
    String(hot.status ?? ''),
    String(hot.organizer ?? ''),
    String(hot.location ?? ''),
    attendees,
  ].join(CALENDAR_CURSOR_SEP);
  return fnv1a(fields);
};

export interface CreateCalendarSourceWalkerOptions {
  /** Per-walker hash function. Defaults to the canonical
   *  `hashCalendarRecord` — covers the load-bearing fields for every
   *  calendar producer planned in the launch sequence. Producers that
   *  need a different hash (e.g. one including description body) pass
   *  a custom function here. */
  hashRecord?: (record: CollectionRecord) => string;
}

/** Calendar collections expose a richer `table` accessor than the
 *  legacy `Collection.list / get` rpc surface (which returns `[]` /
 *  `null` for calendar slugs by design — calendar's read path is the
 *  per-event kernel ingredients, not the legacy rpc). The walker
 *  prefers `table.listSnapshots` when a calendar `table` is wired,
 *  falling back to `Collection.list` for stub-collection unit tests
 *  that don't materialise a real `CalendarCollectionTable`. */
type CalendarTableSlice = Pick<CalendarCollectionTable, 'listSnapshots'>;

const calendarTableOf = (collection: Collection): CalendarTableSlice | null => {
  const table = (collection as unknown as { table?: unknown }).table;
  if (
    table !== null &&
    typeof table === 'object' &&
    typeof (table as CalendarTableSlice).listSnapshots === 'function'
  ) {
    return table as CalendarTableSlice;
  }
  return null;
};

/** Synthesize a `CollectionRecord` from a `CalendarRowSnapshot` so the
 *  walker's TData stays `CollectionRecord` (parallel to the mail
 *  walker). `attendees` / `organizer` (full email, not just hot-field
 *  string) / `description` / `timezone` get folded into `hot_fields`
 *  so producers reading `record.hot_fields.attendees` etc. work
 *  uniformly across stub + production collections. */
const calendarSnapshotToCollectionRecord = (
  snap: CalendarRowSnapshot,
): CollectionRecord => {
  const organizerEmail =
    snap.event.organizer?.email ?? snap.hot.organizer ?? '';
  const hotFields: Record<string, unknown> = {
    summary: snap.hot.summary,
    start_at: snap.hot.start_at,
    end_at: snap.hot.end_at,
    status: snap.hot.status,
    organizer: organizerEmail,
    location: snap.hot.location ?? '',
    is_all_day: snap.hot.is_all_day,
    is_recurring: snap.hot.is_recurring,
    calendar_id: snap.hot.calendar_id,
    ical_uid: snap.hot.ical_uid,
    attendees: snap.event.attendees ?? [],
    timezone: snap.event.timezone,
  };
  if (snap.event.description !== undefined) {
    hotFields.description = snap.event.description;
  }
  return {
    record_id: snap.record_id,
    source_id: snap.source_id,
    received_at: snap.received_at,
    modified_at: snap.modified_at,
    size_bytes: snap.size_bytes,
    hot_fields: hotFields,
    ...(snap.body_inline !== null ? { body_inline: snap.body_inline } : {}),
    ...(snap.blob_hash !== null ? { blob_hash: snap.blob_hash } : {}),
  };
};

/** Build a `calendar` walker over a `CollectionRegistry`. Iterates
 *  every registered calendar collection in slug order; within each,
 *  walks records by `record_id` ASC. Same composite cursor + slug
 *  ordering invariants as the mail walker.
 *
 *  Production calendar collections expose `table.listSnapshots` (full
 *  `CanonicalEvent` payload — attendees, description, timezone), so
 *  the walker prefers that path and synthesizes `CollectionRecord`
 *  with attendees + organizer + description folded into `hot_fields`.
 *  Stub collections used in walker unit tests fall back to
 *  `Collection.list({...})` returning pre-built `CollectionRecord[]`
 *  so the existing test layout keeps working. */
export const createCalendarSourceWalker = (
  collections: CollectionRegistry,
  options?: CreateCalendarSourceWalkerOptions,
): SourceCollectionWalker<CollectionRecord> => {
  const hashFn = options?.hashRecord ?? hashCalendarRecord;
  const liveCalendarCollections = () =>
    collections
      .list()
      .filter((c) => c.platform === 'calendar')
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const listForCollection = (collection: Collection): CollectionRecord[] => {
    const table = calendarTableOf(collection);
    if (table) {
      return table
        .listSnapshots({ limit: 10_000 })
        .map(calendarSnapshotToCollectionRecord);
    }
    // Fallback: the stub `Collection.list` shape used in walker unit
    // tests. Production calendar collections always expose a `table` (the
    // branch above), so this stays test-only at runtime — the walker never
    // routes calendar enrichment through the generic `list`.
    return collection.list({
      platform: 'calendar',
      slug: collection.slug,
      limit: 10_000,
    });
  };

  return {
    *walkAfter(
      cursor_token: string,
      batch_size: number,
    ): Generator<SourceRecord<CollectionRecord>> {
      const { slug: cursor_slug, record_id: cursor_record_id } = splitCalendarCursor(
        cursor_token,
      );
      let yielded = 0;
      for (const collection of liveCalendarCollections()) {
        if (collection.slug < cursor_slug) continue;
        const records = listForCollection(collection).sort((a, b) =>
          a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0,
        );
        for (const record of records) {
          if (collection.slug === cursor_slug && record.record_id <= cursor_record_id) {
            continue;
          }
          if (yielded >= batch_size) return;
          yield {
            target_id: record.record_id,
            data: record,
            cursor_token: composeCalendarCursor(collection.slug, record.record_id),
          };
          yielded += 1;
        }
      }
    },

    hashOf(record: SourceRecord<CollectionRecord>): string {
      return hashFn(record.data);
    },

    fetchOne(target_id: string): SourceRecord<CollectionRecord> | null {
      // target_id is a calendar record_id; scan live collections to
      // find the owning slug. Typical user has 1-2 calendar accounts
      // so the linear scan is cheap. Production calendars source the
      // full snapshot via the table accessor; stub collections fall
      // back to `Collection.get`.
      for (const collection of liveCalendarCollections()) {
        const table = calendarTableOf(collection);
        if (table) {
          const match = table
            .listSnapshots({ limit: 10_000 })
            .find((snap) => snap.record_id === target_id);
          if (match) {
            return {
              target_id,
              data: calendarSnapshotToCollectionRecord(match),
              cursor_token: composeCalendarCursor(collection.slug, target_id),
            };
          }
          continue;
        }
        const record = collection.get(target_id);
        if (record !== null) {
          return {
            target_id,
            data: record,
            cursor_token: composeCalendarCursor(collection.slug, target_id),
          };
        }
      }
      return null;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// File walker
// ────────────────────────────────────────────────────────────────

/** File walker mirrors the mail/calendar collection-registry shape:
 *  every live `data.file.<slug>` collection is walked in slug order,
 *  and records inside a slug are walked by `record_id` ASC. */
const FILE_CURSOR_SEP = '\0';

const splitFileCursor = (token: string): { slug: string; record_id: string } => {
  if (token === '') return { slug: '', record_id: '' };
  const idx = token.indexOf(FILE_CURSOR_SEP);
  if (idx < 0) return { slug: token, record_id: '' };
  return {
    slug: token.slice(0, idx),
    record_id: token.slice(idx + 1),
  };
};

const composeFileCursor = (slug: string, record_id: string): string =>
  `${slug}${FILE_CURSOR_SEP}${record_id}`;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return String(value ?? '');
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
};

/** Hash the file fields that drive media enrichment. Transcript /
 *  caption / extracted_text read raw CAS bytes plus MIME/media class;
 *  the CAS blob/content hash is the source-of-truth byte fingerprint,
 *  while filename is included because transcription providers receive
 *  it as multipart metadata. */
export const hashFileRecord = (record: CollectionRecord): string => {
  const hot = record.hot_fields ?? {};
  const storageRef = (record as { storage_ref?: unknown }).storage_ref;
  const fields = [
    String(hot.media_class ?? ''),
    String(hot.mime_type ?? ''),
    String(hot.content_hash ?? ''),
    String(hot.size ?? record.size_bytes ?? ''),
    String(hot.filename ?? hot.path ?? ''),
    typeof record.blob_hash === 'string' ? record.blob_hash : '',
    stableJson(storageRef),
  ].join(FILE_CURSOR_SEP);
  return fnv1a(fields);
};

export const createFileSourceWalker = (
  collections: CollectionRegistry,
): SourceCollectionWalker<CollectionRecord> => {
  const liveFileCollections = () =>
    collections
      .list()
      .filter((c) => c.platform === 'file')
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  return {
    *walkAfter(
      cursor_token: string,
      batch_size: number,
    ): Generator<SourceRecord<CollectionRecord>> {
      const { slug: cursor_slug, record_id: cursor_record_id } = splitFileCursor(
        cursor_token,
      );
      let yielded = 0;
      for (const collection of liveFileCollections()) {
        if (collection.slug < cursor_slug) continue;
        const records = collection
          .list({ platform: 'file', slug: collection.slug, limit: 10_000 })
          .sort((a, b) =>
            a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0,
          );
        for (const record of records) {
          if (collection.slug === cursor_slug && record.record_id <= cursor_record_id) {
            continue;
          }
          if (yielded >= batch_size) return;
          yield {
            target_id: record.record_id,
            data: record,
            cursor_token: composeFileCursor(collection.slug, record.record_id),
          };
          yielded += 1;
        }
      }
    },

    hashOf(record: SourceRecord<CollectionRecord>): string {
      return hashFileRecord(record.data);
    },

    fetchOne(target_id: string): SourceRecord<CollectionRecord> | null {
      for (const collection of liveFileCollections()) {
        const record = collection.get(target_id);
        if (record !== null) {
          return {
            target_id,
            data: record,
            cursor_token: composeFileCursor(collection.slug, target_id),
          };
        }
      }
      return null;
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Contact walker
// ────────────────────────────────────────────────────────────────

/** Contact walker reads the per-pair `contacts` SQLite table directly
 *  via `ContactStore.walkByEmail`. Distinct from mail / calendar
 *  because contacts are not registered on `CollectionRegistry` — they
 *  live in a single warehouse-wide table keyed on canonical email
 *  (D-121 P1). The cursor token is the email itself; lex-stable order
 *  on the primary key gives correct resume semantics across writes
 *  (which only touch `last_interaction` / `interaction_count` / `name`,
 *  never `email`).
 *
 *  Producers reading the contact-walker stream get `ContactRecord`
 *  shape directly (not `CollectionRecord`) — this is why the walker
 *  is `SourceCollectionWalker<ContactRecord>` rather than the default
 *  generic. */

/** Hash the contact fields that drive producer output. The signal
 *  fields are `email` (cursor key but also identity), `name`
 *  (signature parsing for `company` / `role`), `last_interaction` +
 *  `interaction_count` (every aggregate producer reads these to detect
 *  "freshness change"), and `source` (provenance). Skip
 *  `first_seen` / `created_at` / `updated_at` — those are bookkeeping,
 *  not producer signal. */
export const hashContactRecord = (record: ContactRecord): string => {
  const fields = [
    record.email,
    record.name ?? '',
    String(record.last_interaction),
    String(record.interaction_count),
    record.source,
  ].join(' ');
  return fnv1a(fields);
};

/** Build a `contact` walker over a `ContactStore`. Iterates rows in
 *  `email ASC` lex order using `walkByEmail`, batched by the harness's
 *  `batch_size`. Cursor token IS the email — the harness's
 *  `max_target_id_seen` resumes the next walk from the right place
 *  even if mail / calendar adapters are concurrently bumping
 *  `last_interaction` (the column we don't sort on). */
export const createContactSourceWalker = (
  contactStore: ContactStore,
): SourceCollectionWalker<ContactRecord> => {
  return {
    *walkAfter(
      cursor_token: string,
      batch_size: number,
    ): Generator<SourceRecord<ContactRecord>> {
      const records = contactStore.walkByEmail(cursor_token, batch_size);
      for (const record of records) {
        yield {
          target_id: record.email,
          data: record,
          cursor_token: record.email,
        };
      }
    },

    hashOf(record: SourceRecord<ContactRecord>): string {
      return hashContactRecord(record.data);
    },

    fetchOne(target_id: string): SourceRecord<ContactRecord> | null {
      const record = contactStore.get(target_id);
      if (record === null) return null;
      return {
        target_id: record.email,
        data: record,
        cursor_token: record.email,
      };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Note walker (D-145 PA9)
// ────────────────────────────────────────────────────────────────

/** Hash the note fields that drive `note_relevance_decay`. The
 *  producer's decay score is a pure function of two timestamps:
 *  `id` (cursor key + identity) and `last_user_action_at` (canonical
 *  freshness signal; bumped on user open / edit / save / pin / unpin
 *  per § A.1.2). Body / title / relationship arrays don't affect the
 *  decay value — re-hashing on a body edit that doesn't bump
 *  `last_user_action_at` would churn re-derivation pointlessly. The
 *  ledger contributes via per-note SQL inside `produce()`, not via the
 *  hash, so a new ledger row does NOT bump this hash; cascade fires
 *  through `note_access_ledger.created` → enrichment-row staleness
 *  instead. */
export const hashNoteRecord = (record: Note): string => {
  const fields = [record.id, String(record.last_user_action_at)].join(' ');
  return fnv1a(fields);
};

/** Build a `note` walker over a `WorkEntityStore`. Iterates `data_note`
 *  rows in `id ASC` lex order via `walkByNoteId`, batched by the
 *  harness's `batch_size`. Cursor token IS the note id — `id` is a
 *  ULID-shaped opaque string, lex-stable across writes (writes touch
 *  `updated_at` / `last_user_action_at` / `body` / `title`, never `id`).
 *  Tombstoned + orphan rows are excluded by the store-level filter. */
export const createNoteSourceWalker = (
  workEntityStore: WorkEntityStore,
): SourceCollectionWalker<Note> => {
  return {
    *walkAfter(cursor_token: string, batch_size: number): Generator<SourceRecord<Note>> {
      const records = workEntityStore.walkByNoteId(cursor_token, batch_size);
      for (const record of records) {
        yield {
          target_id: record.id,
          data: record,
          cursor_token: record.id,
        };
      }
    },

    hashOf(record: SourceRecord<Note>): string {
      return hashNoteRecord(record.data);
    },

    fetchOne(target_id: string): SourceRecord<Note> | null {
      const record = workEntityStore.readNote(target_id);
      if (record === null) return null;
      return {
        target_id: record.id,
        data: record,
        cursor_token: record.id,
      };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Task walker (D-145 PA9)
// ────────────────────────────────────────────────────────────────

/** Hash the task fields that drive `task_duplicate_candidate`. The
 *  producer's match math reads `title`, `due_at`, `assigned_contact_id`,
 *  `parent_project_id`, plus `source_id` (used for the cross-source
 *  candidate narrowing — not a "field that affects this row's output"
 *  but a field whose change rotates the candidate set, so include).
 *  `body` / `priority` / `done` / `created_at` / `updated_at` / blocks
 *  array don't affect dedup math — exclude to avoid spurious
 *  invalidation. */
export const hashTaskRecord = (record: Task): string => {
  const fields = [
    record.id,
    record.title,
    String(record.due_at ?? ''),
    record.assigned_contact_id ?? '',
    record.parent_project_id ?? '',
    record.source_id ?? '',
  ].join(' ');
  return fnv1a(fields);
};

/** Build a `task` walker over a `WorkEntityStore`. Iterates `data_task`
 *  rows in `id ASC` lex order via `walkByTaskId`, batched by the
 *  harness's `batch_size`. Cursor token IS the task id — `id` is a
 *  ULID-shaped opaque string, lex-stable across writes (writes touch
 *  most columns but never `id`). Tombstoned + orphan rows are excluded
 *  by the store-level filter. */
export const createTaskSourceWalker = (
  workEntityStore: WorkEntityStore,
): SourceCollectionWalker<Task> => {
  return {
    *walkAfter(cursor_token: string, batch_size: number): Generator<SourceRecord<Task>> {
      const records = workEntityStore.walkByTaskId(cursor_token, batch_size);
      for (const record of records) {
        yield {
          target_id: record.id,
          data: record,
          cursor_token: record.id,
        };
      }
    },

    hashOf(record: SourceRecord<Task>): string {
      return hashTaskRecord(record.data);
    },

    fetchOne(target_id: string): SourceRecord<Task> | null {
      const record = workEntityStore.readTask(target_id);
      if (record === null) return null;
      return {
        target_id: record.id,
        data: record,
        cursor_token: record.id,
      };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Project walker (D-145 PA9)
// ────────────────────────────────────────────────────────────────

/** Hash the project fields that drive `project_next_action_gap` +
 *  `project_stall_signal`. Both producers' outputs depend on `id`
 *  (identity), `state` (only active projects emit rows — same
 *  abstention rule), and `last_activity_at` (spec § A.1.4 bumps this
 *  on child task / note / commitment changes — so the signal hashes
 *  flow into producer re-runs on child mutations even before the
 *  cascade engine's invalidation_triggers fire on the child entity
 *  directly). Other project fields (`title`, `description`,
 *  `target_completion_at`, `related_contact_ids`, `parent_project_id`)
 *  don't affect gap or stall math — exclude to avoid spurious
 *  invalidation. */
export const hashProjectRecord = (record: Project): string => {
  const fields = [record.id, record.state, String(record.last_activity_at)].join(' ');
  return fnv1a(fields);
};

/** Build a `project` walker over a `WorkEntityStore`. Iterates
 *  `data_project` rows in `id ASC` lex order via `walkByProjectId`,
 *  batched by the harness's `batch_size`. Cursor token IS the project
 *  id — `id` is a ULID-shaped opaque string, lex-stable across writes
 *  (writes touch every other column but never `id`). Tombstoned +
 *  orphan rows are excluded by the store-level filter. */
export const createProjectSourceWalker = (
  workEntityStore: WorkEntityStore,
): SourceCollectionWalker<Project> => {
  return {
    *walkAfter(cursor_token: string, batch_size: number): Generator<SourceRecord<Project>> {
      const records = workEntityStore.walkByProjectId(cursor_token, batch_size);
      for (const record of records) {
        yield {
          target_id: record.id,
          data: record,
          cursor_token: record.id,
        };
      }
    },

    hashOf(record: SourceRecord<Project>): string {
      return hashProjectRecord(record.data);
    },

    fetchOne(target_id: string): SourceRecord<Project> | null {
      const record = workEntityStore.readProject(target_id);
      if (record === null) return null;
      return {
        target_id: record.id,
        data: record,
        cursor_token: record.id,
      };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

/** Either flavor of walker — mail / calendar / file walkers yield
 *  `CollectionRecord`, contact walker yields `ContactRecord`, note
 *  walker yields `Note`, task walker yields `Task`, project walker
 *  yields `Project`. The registry's typed lookup returns this union;
 *  consumers pair it with the matching producer at the call site (TS
 *  enforces the cross-scope pairing through
 *  `buildEnrichmentProducerTask`'s generic). */
export type AnySourceWalker =
  | SourceCollectionWalker<CollectionRecord>
  | SourceCollectionWalker<ContactRecord>
  | SourceCollectionWalker<Note>
  | SourceCollectionWalker<Task>
  | SourceCollectionWalker<Project>;

export interface SourceWalkerRegistry {
  /** D-131 A.4 — narrow overloads so `get('mail')` etc. return the
   *  CollectionRecord flavor and `get('contact')` returns the
   *  ContactRecord flavor without a cast. The wide `EnrichmentScope`
   *  signature stays as a fallback for callers that already hold an
   *  unknown-scope variable. */
  get(
    scope: 'mail' | 'calendar' | 'file' | 'connection.api' | 'connection.mcp' | 'connection.notification',
  ): SourceCollectionWalker<CollectionRecord> | undefined;
  get(scope: 'contact'): SourceCollectionWalker<ContactRecord> | undefined;
  get(scope: EnrichmentScope): AnySourceWalker | undefined;
}

export interface SourceWalkerDeps {
  collections: CollectionRegistry;
  /** Required to register the `contact` walker. When omitted (test
   *  paths, or boot before the contact store is constructed), the
   *  registry's `get('contact')` returns undefined. The mail,
   *  calendar, and file walkers register unconditionally because they
   *  only need the always-present `CollectionRegistry`. */
  contactStore?: ContactStore;
}

/** Build the registry mapping each `EnrichmentScope` to its walker.
 *  D-131 A.4/A.5 wires `mail`, `calendar`, and (when `contactStore`
 *  is supplied) `contact`. Additional scopes (`file`, the three
 *  `connection.*` flavors) register here as their housekeeping
 *  producers ship. Tests can pass a registry with stub walkers via
 *  `createTestSourceWalkerRegistry` to bypass live storage entirely. */
export const createSourceWalkerRegistry = (deps: SourceWalkerDeps): SourceWalkerRegistry => {
  const walkers = new Map<EnrichmentScope, AnySourceWalker>();
  walkers.set('mail', createMailSourceWalker(deps.collections));
  walkers.set('calendar', createCalendarSourceWalker(deps.collections));
  walkers.set('file', createFileSourceWalker(deps.collections));
  if (deps.contactStore) {
    walkers.set('contact', createContactSourceWalker(deps.contactStore));
  }
  return registryFromMap(walkers);
};

/** Test seam — directly populate the registry with stub walkers.
 *  Bypass live collection wiring so harness + producer tests can
 *  drive deterministic source-record streams without spinning up
 *  full mail-stack scaffolding. */
export const createTestSourceWalkerRegistry = (
  walkers: Partial<Record<EnrichmentScope, AnySourceWalker>>,
): SourceWalkerRegistry => {
  const map = new Map<EnrichmentScope, AnySourceWalker>();
  for (const [scope, walker] of Object.entries(walkers)) {
    if (walker) map.set(scope as EnrichmentScope, walker);
  }
  return registryFromMap(map);
};

/** Build a SourceWalkerRegistry from a typed map. The overload
 *  shape matches `SourceWalkerRegistry.get` — TS picks the right
 *  return type at every call site without runtime cost. */
function registryFromMap(
  walkers: Map<EnrichmentScope, AnySourceWalker>,
): SourceWalkerRegistry {
  function get(
    scope: 'mail' | 'calendar' | 'file' | 'connection.api' | 'connection.mcp' | 'connection.notification',
  ): SourceCollectionWalker<CollectionRecord> | undefined;
  function get(scope: 'contact'): SourceCollectionWalker<ContactRecord> | undefined;
  function get(scope: EnrichmentScope): AnySourceWalker | undefined;
  function get(scope: EnrichmentScope): AnySourceWalker | undefined {
    return walkers.get(scope);
  }
  return { get };
}
