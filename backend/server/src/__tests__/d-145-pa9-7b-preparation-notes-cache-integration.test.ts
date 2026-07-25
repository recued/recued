/** D-145 PA9.7b — `preparation_notes` producer × LLM result cache
 *  integration.
 *
 *  Sibling of d-145-pa9-7b-{summary,purpose,action-items}-cache-
 *  integration.test.ts. Unlike the mail-body trio, prep notes assembles
 *  a multi-source corpus (event metadata + per-attendee mail snippets)
 *  before the LLM call. The cache wiring is still correct — identical
 *  assembled corpora hit — but the hit surface is narrower in practice
 *  because the corpus header encodes start_at + summary + attendees.
 *
 *  Two-event cache hits require those three plus the per-attendee mail
 *  corpus to align. The fixtures construct two distinct calendar
 *  record_ids that share an identical assembled corpus to exercise the
 *  positive path.
 *
 *  Spec: D-145 § A.7.10. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectionRecord,
  IngredientManifest,
  PreparationNotesValue,
} from '@recued/contracts';

import { preparationNotesProducer } from '../housekeeping/producers/preparation_notes.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import {
  createLlmResultCacheStore,
  hashLlmInput,
  type LlmResultCacheStore,
} from '../housekeeping/llm-result-cache-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecuteWithMeta,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

const MAIL_TABLE = 'collection_mail_test';

const ATTENDEES = ['alice@example.com', 'bob@example.com'];
const ORGANIZER = 'me@example.com';
const SUMMARY_TEXT = 'Q3 review prep';
const START_AT = NOW + 6 * ONE_HOUR;

const PREP_VALUE: PreparationNotesValue = {
  summary: 'Prep brief: align on Q3 revenue, confirm expansion plan with Alice + Bob.',
  key_points: [
    'Alice owns the regional forecast — confirm latest numbers',
    'Bob has open question on the customer expansion narrative',
    'Decision pending on segment split before EOQ',
  ],
  attendees_considered: [...ATTENDEES].sort(),
  corpus_size: 1234,
  computed_at: NOW,
};

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let llmResultCache: LlmResultCacheStore;

const buildCalendarRecord = (
  record_id: string,
  overrides: Partial<{
    summary: string;
    start_at: number;
    attendees: ReadonlyArray<string>;
    organizer: string;
  }> = {},
): CollectionRecord => ({
  record_id,
  received_at: NOW,
  modified_at: NOW,
  hot_fields: {
    summary: overrides.summary ?? SUMMARY_TEXT,
    start_at: overrides.start_at ?? START_AT,
    attendees: overrides.attendees ?? ATTENDEES,
    organizer: overrides.organizer ?? ORGANIZER,
    location: 'Zoom',
  },
  size_bytes: 0,
  source_id: `cal-${record_id}`,
});

const buildSourceRecord = (record: CollectionRecord): SourceRecord => ({
  target_id: record.record_id,
  data: record,
  cursor_token: record.record_id,
});

const insertMailRow = (params: {
  record_id: string;
  from: string;
  to: ReadonlyArray<string>;
  subject: string;
  received_at: number;
  body: string;
}): void => {
  db.prepare(
    `INSERT INTO ${MAIL_TABLE} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (
       @record_id, @received_at, @modified_at, @hot_fields,
       @size_bytes, @source_id, @body_inline, @blob_hash
     )`,
  ).run({
    record_id: params.record_id,
    received_at: params.received_at,
    modified_at: params.received_at,
    hot_fields: JSON.stringify({
      from: params.from,
      to: params.to,
      subject: params.subject,
    }),
    size_bytes: params.body.length,
    source_id: `msg-${params.record_id}`,
    body_inline: params.body,
    blob_hash: null,
  });
};

const seedSharedCorpus = (): void => {
  insertMailRow({
    record_id: 'msg-alice-1',
    from: ATTENDEES[0]!,
    to: [ORGANIZER],
    subject: 'Q3 numbers',
    received_at: NOW - 2 * ONE_DAY,
    body:
      'Hi — the latest regional forecast lands the southwest at 1.2M and the ' +
      'northeast at 980K. I want to confirm those before Friday. Let me know ' +
      'if anything stands out before the review meeting. Thanks, Alice.',
  });
  insertMailRow({
    record_id: 'msg-bob-1',
    from: ATTENDEES[1]!,
    to: [ORGANIZER],
    subject: 'Customer expansion narrative',
    received_at: NOW - 3 * ONE_DAY,
    body:
      'I think we should sharpen the expansion narrative before the review. ' +
      'The plan as written treats the SMB and mid-market segments the same, ' +
      'but their renewal curves are very different. Open question I want to ' +
      'raise on the call: do we split the segment in reporting going forward?',
  });
};

const buildBlobs = (): BlobStore => ({
  put: vi.fn(async () => 'unused'),
  get: vi.fn(async () => null),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/test',
});

const stubLlmWithMeta = (
  output: unknown = {
    summary: PREP_VALUE.summary,
    key_points: PREP_VALUE.key_points,
  },
  model_id = 'openai:gpt-4o-mini',
): {
  fn: ReturnType<typeof vi.fn>;
  lastInput: () => Record<string, unknown> | undefined;
  calls: () => number;
} => {
  let lastInput: Record<string, unknown> | undefined;
  const fn = vi.fn(
    async (_m: IngredientManifest, input: Record<string, unknown>) => {
      lastInput = input;
      return { result: output, model_id };
    },
  );
  return { fn, lastInput: () => lastInput, calls: () => fn.mock.calls.length };
};

const buildCtx = (
  llmWithMeta: ReturnType<typeof vi.fn>,
  cache: LlmResultCacheStore | undefined,
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
  llmWithMeta: llmWithMeta as unknown as HousekeepingLlmExecuteWithMeta,
  blobs: buildBlobs(),
  ...(cache ? { llmResultCache: cache } : {}),
});

const produceAndPersist = async (
  ctx: HousekeepingContext,
  record: CollectionRecord,
): Promise<NonNullable<Awaited<ReturnType<typeof preparationNotesProducer.produce>>>> => {
  const out = await preparationNotesProducer.produce(ctx, buildSourceRecord(record));
  if (out === null) throw new Error('preparation_notes returned null in fixture');
  enrichmentStore.upsert({
    topic: 'preparation_notes',
    scope: 'calendar',
    target_id: record.record_id,
    authored_by: 'system.housekeeping.preparation_notes',
    value: out.value,
    source_record_hash: `src_${record.record_id}`,
    ...(out.model_id !== undefined ? { model_id: out.model_id } : {}),
    ...(out.event_at !== undefined ? { event_at: out.event_at } : {}),
    ...(out.ingredient_slug !== undefined ? { ingredient_slug: out.ingredient_slug } : {}),
    ...(out.producer_version_hash !== undefined
      ? { producer_version_hash: out.producer_version_hash }
      : {}),
    ...(typeof out.sidecar_text === 'string'
      ? { sidecar_text: out.sidecar_text }
      : {}),
  });
  return out;
};

const llmInputFor = (truncated: string): Record<string, unknown> => ({
  'llm.data': truncated,
  'llm.max_length': 250,
  'llm.focus':
    'Distill prep notes for an upcoming meeting. Surface key context per ' +
    'participant, prior decisions or asks already on the table, open ' +
    'questions worth raising, and one or two suggested talking points. ' +
    "Be concrete — name people, decisions, and dates from the corpus; don't " +
    'paraphrase generically.',
  'llm.model_hint': 'fast',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-7b-prep-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureHousekeepingSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MAIL_TABLE} (
      record_id   TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      hot_fields  TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      source_id   TEXT NOT NULL,
      body_inline TEXT,
      blob_hash   TEXT
    );
  `);
  seedSharedCorpus();
  enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  llmResultCache = createLlmResultCacheStore(db);
});

afterEach(() => {
  enrichmentStore.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('preparationNotesProducer × cache — miss', () => {
  it('first call hits the LLM + inserts a cache entry pointing to the row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));

    expect(llm.calls()).toBe(1);
    const input = llm.lastInput();
    expect(input).toBeDefined();
    const inputHash = hashLlmInput(input!);
    const entry = llmResultCache.lookup(inputHash);
    expect(entry).not.toBeNull();
    expect(entry?.result_path).toBe(
      'data.enrichment.preparation_notes.calendar.event-1',
    );
  });
});

describe('preparationNotesProducer × cache — hit', () => {
  it('second event with identical start_at + attendees + corpus reuses extraction', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    const first = await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    expect(llm.calls()).toBe(1);
    const inputHash = hashLlmInput(llm.lastInput()!);

    const second = await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-2')),
    );
    expect(llm.calls()).toBe(1);
    expect(second).not.toBeNull();
    if (!second) throw new Error();
    expect(second.value).toEqual(first.value);
    expect(second.model_id).toBe(first.model_id);
    expect(second.producer_version_hash).toBe(first.producer_version_hash);
    expect(second.sidecar_text).toBe(PREP_VALUE.summary);
    expect(second.event_at).toBe(START_AT);

    const row = llmResultCache.getRow(inputHash);
    expect(row?.hit_count).toBe(1);
  });

  it('three events with identical corpus produce one LLM call + two hit_count bumps', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-2')),
    );
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-3')),
    );

    expect(llm.calls()).toBe(1);
    const row = llmResultCache.getRow(hashLlmInput(llm.lastInput()!));
    expect(row?.hit_count).toBe(2);
  });
});

describe('preparationNotesProducer × cache — opt-out', () => {
  it('ctx without llmResultCache → producer falls back to compute-every-time', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, undefined);
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-1')),
    );
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-2')),
    );
    expect(llm.calls()).toBe(2);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM llm_result_cache')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe('preparationNotesProducer × cache — self-healing dangling pointer', () => {
  it('cached row deleted → lazy delete + LLM call + re-insert pointing to new row', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    expect(llm.calls()).toBe(1);
    const inputHash = hashLlmInput(llm.lastInput()!);

    const firstRow = enrichmentStore.list({
      topic: 'preparation_notes',
      scope: 'calendar',
      target_id: 'event-1',
    })[0]!;
    enrichmentStore.deleteById(firstRow._id);

    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-2')),
    );
    expect(llm.calls()).toBe(2);
    const entry = llmResultCache.lookup(inputHash);
    expect(entry?.result_path).toBe(
      'data.enrichment.preparation_notes.calendar.event-2',
    );
  });
});

describe('preparationNotesProducer × cache — self-healing hash drift', () => {
  it('mutated value at cached path → lazy delete + LLM call', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    expect(llm.calls()).toBe(1);

    db.prepare(
      `UPDATE data_enrichment SET value = ? WHERE target_id = 'event-1'`,
    ).run(
      JSON.stringify({
        summary: 'drifted',
        key_points: ['drifted'],
        attendees_considered: ATTENDEES,
        corpus_size: 1,
        computed_at: NOW,
      }),
    );

    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(buildCalendarRecord('event-2')),
    );
    expect(llm.calls()).toBe(2);
  });
});

describe('preparationNotesProducer × cache — disjoint inputs', () => {
  it('different start_at yields different input_hashes; no false cache hits', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(
        buildCalendarRecord('event-2', { start_at: START_AT + ONE_DAY }),
      ),
    );

    expect(llm.calls()).toBe(2);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM llm_result_cache')
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });

  it('different attendee sets yield different input_hashes', async () => {
    const llm = stubLlmWithMeta();
    const ctx = buildCtx(llm.fn, llmResultCache);
    await produceAndPersist(ctx, buildCalendarRecord('event-1'));
    insertMailRow({
      record_id: 'msg-carol-1',
      from: 'carol@example.com',
      to: [ORGANIZER],
      subject: 'New initiative briefing',
      received_at: NOW - ONE_DAY,
      body:
        'Wanted to flag a new initiative that intersects with what you are ' +
        "covering on Friday. Happy to share more context — there are a few " +
        'open questions worth pulling into the prep brief.',
    });
    await preparationNotesProducer.produce(
      ctx,
      buildSourceRecord(
        buildCalendarRecord('event-2', {
          attendees: [...ATTENDEES, 'carol@example.com'],
        }),
      ),
    );

    expect(llm.calls()).toBe(2);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM llm_result_cache')
      .get() as { n: number };
    expect(rows.n).toBe(2);
  });
});
