/** D-131 A.13 — `related_threads` enrichment producer tests.
 *
 *  Second calendar-scope AI producer + first aggregate-with-AI-tie-
 *  break producer. Covers:
 *
 *    - Surface contract (topic / scope / ai_surface / token estimate /
 *      scope_read_declaration / registry trust + pool defaults +
 *      emits_confidence + sidecar='none' + policy='dependent')
 *    - Pure helpers: `extractAttendeeEmails` (organizer filtered;
 *      handles string + object attendees), `findCandidateThreads`
 *      (groups by thread_id; sender/recipient filter; recency cap),
 *      `partitionDeterministic` (full-overlap + ≥2-messages → 'high'
 *      deterministic; rest → AI),
 *      `composeTieBreakCorpus` (header + per-thread block)
 *    - Empty / null cases: missing `start_at`, past event > 24h,
 *      no attendees, only organizer, no candidate threads, AI grades
 *      everything `'unrelated'`
 *    - AI-surface contract: throws on missing `ctx.llm`
 *    - Happy path: deterministic-only (full-overlap), AI-only
 *      (partial-overlap), mixed deterministic + AI
 *    - Multi-table aggregation: candidates from multiple
 *      `collection_mail_*` tables fold together
 *    - AI thread_id sanitisation — fabricated ids dropped silently
 *    - MAX_RELATED_THREADS cap enforced
 *    - Closed-shape rejection: malformed ai-extract output throws
 *      `related_threads_output_invalid`
 *    - Registry value_schema accepts the produced shape, rejects
 *      malformed input */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type CollectionRecord,
  type IngredientManifest,
  type RelatedThreadsValue,
} from '@recued/contracts';

import {
  relatedThreadsProducer,
  extractRelatedThreadsAttendeeEmails,
  findRelatedThreadCandidates,
  partitionRelatedThreadCandidates,
  composeRelatedThreadsTieBreakCorpus,
  RELATED_THREADS_PAST_GRACE_MS,
  RELATED_THREADS_MAIL_LOOKBACK_MS,
  RELATED_THREADS_MAX_CANDIDATES,
  MAX_RELATED_THREADS,
  RELATED_THREADS_MIN_DETERMINISTIC_MESSAGES,
} from '../housekeeping/index.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

const MAIL_TABLE = 'collection_mail_11111111aa';
const MAIL_TABLE_2 = 'collection_mail_22222222bb';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-related-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [MAIL_TABLE, MAIL_TABLE_2]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
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
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedMail {
  table?: string;
  record_id: string;
  thread_id: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  received_at?: number;
}

const insertMail = (m: InsertedMail): void => {
  const table = m.table ?? MAIL_TABLE;
  const hot = {
    from: m.from,
    to: m.to ?? [],
    cc: m.cc ?? [],
    subject: m.subject ?? `Subject ${m.record_id}`,
    thread_id: m.thread_id,
  };
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.record_id,
    m.received_at ?? NOW,
    m.received_at ?? NOW,
    JSON.stringify(hot),
    100,
    m.record_id,
    null,
    null,
  );
};

const fakeCalendarRecord = (
  record_id: string,
  hot: Record<string, unknown> = {},
): CollectionRecord => ({
  record_id,
  source_id: record_id,
  received_at: NOW,
  modified_at: NOW,
  size_bytes: 200,
  hot_fields: {
    summary: 'Q3 strategy review',
    start_at: NOW + 2 * ONE_HOUR,
    end_at: NOW + 3 * ONE_HOUR,
    status: 'confirmed',
    organizer: 'alice@example.com',
    location: '',
    attendees: [
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ],
    timezone: 'America/New_York',
    ...hot,
  },
});

const sourceFor = (
  record_id: string,
  hot: Record<string, unknown> = {},
): SourceRecord<CollectionRecord> => ({
  target_id: record_id,
  data: fakeCalendarRecord(record_id, hot),
  cursor_token: `slug ${record_id}`,
});

interface StubLlm {
  fn: ReturnType<typeof vi.fn>;
  capturedManifest: IngredientManifest | null;
  capturedInput: Record<string, unknown> | null;
}

const buildStubLlm = (
  result: unknown | (() => unknown) | (() => Promise<unknown>),
): StubLlm => {
  const stub: StubLlm = {
    capturedManifest: null,
    capturedInput: null,
    fn: vi.fn(),
  };
  stub.fn = vi.fn(async (manifest: IngredientManifest, input: Record<string, unknown>) => {
    stub.capturedManifest = manifest;
    stub.capturedInput = input;
    if (typeof result === 'function') return (result as () => unknown)();
    return result;
  });
  return stub;
};

const buildBlobs = (overrides: Partial<BlobStore> = {}): BlobStore => ({
  put: vi.fn(async () => 'unused'),
  get: vi.fn(async () => null),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/test',
  ...overrides,
});

const stubCtx = (
  options: {
    llm?: ReturnType<typeof vi.fn>;
    blobs?: BlobStore;
    now?: number;
  } = {},
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => options.now ?? NOW,
  emitAuditRow: () => undefined,
  ...(options.llm ? { llm: options.llm as unknown as HousekeepingLlmExecute } : {}),
  // D-136 P3 — relatedThreadsProducer reads `ctx.llmWithMeta`.
  ...(options.llm
    ? {
        llmWithMeta: (async (manifest: unknown, input: unknown) => ({
          result: await (options.llm as unknown as (
            m: unknown,
            i: unknown,
          ) => Promise<unknown>)(manifest, input),
          model_id: 'openai:gpt-4o-mini',
        })) as unknown as HousekeepingContext['llmWithMeta'],
      }
    : {}),
  ...(options.blobs ? { blobs: options.blobs } : {}),
});

const okAiOutput = {
  grades: [
    {
      thread_id: 'thread-bob-only',
      relevance: 'medium',
      reasoning: 'Bob has been driving the budget topic.',
    },
    {
      thread_id: 'thread-carol-only',
      relevance: 'low',
      reasoning: 'Carol mentioned pricing in passing.',
    },
  ],
};

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('relatedThreadsProducer surface contract', () => {
  it('targets the related_threads registry topic', () => {
    expect(relatedThreadsProducer.topic).toBe('related_threads');
  });

  it('targets the calendar source scope', () => {
    expect(relatedThreadsProducer.source_scope).toBe('calendar');
  });

  it('declares ai_surface=chat', () => {
    expect(relatedThreadsProducer.ai_surface).toBe('chat');
  });

  it('declares positive token estimate (AI-surface gate)', () => {
    expect(relatedThreadsProducer.estimate_per_record_tokens()).toBeGreaterThan(0);
  });

  it('declares both data.calendar and data.mail in scope_read_declaration', () => {
    const collections = relatedThreadsProducer.scope_read_declaration.map(
      (d) => d.collection,
    );
    expect(collections).toContain('data.calendar');
    expect(collections).toContain('data.mail');
  });

  it('declares thread_id + attendees in scope_read', () => {
    const decls = relatedThreadsProducer.scope_read_declaration;
    const mail = decls.find((d) => d.collection === 'data.mail');
    const calendar = decls.find((d) => d.collection === 'data.calendar');
    expect(mail!.sample_field_paths).toContain('thread_id');
    expect(calendar!.sample_field_paths).toContain('attendees');
  });

  it('related_threads is time_bound — not PSI-eligible (D-136 P1 revoked emits_confidence)', () => {
    const def = ENRICHMENT_REGISTRY.related_threads as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('registry default_trust_state is manual (AI producer)', () => {
    expect(ENRICHMENT_REGISTRY.related_threads.default_trust_state).toBe('manual');
  });

  it('registry default_pool_policy is free_only', () => {
    expect(ENRICHMENT_REGISTRY.related_threads.default_pool_policy).toBe('free_only');
  });

  it('registry sidecar is none (output is structured ids, not searchable text)', () => {
    expect(ENRICHMENT_REGISTRY.related_threads.sidecar).toBe('none');
  });

  it('registry policy is dependent', () => {
    expect(ENRICHMENT_REGISTRY.related_threads.policy).toBe('dependent');
  });
});

// ────────────────────────────────────────────────────────────────
// extractAttendeeEmails — pure helper
// ────────────────────────────────────────────────────────────────

describe('extractRelatedThreadsAttendeeEmails', () => {
  it('returns canonical emails sorted ASC, excluding the organizer', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['Carol <carol@example.com>', 'bob@example.com', 'alice@example.com'],
      organizer: 'alice@example.com',
    });
    expect(extractRelatedThreadsAttendeeEmails(record)).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('handles {email, ...}[] attendees from gcal/graph adapters', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: [
        { email: 'bob@example.com', display_name: 'Bob' },
        { email: 'alice@example.com', is_self: true },
      ],
      organizer: 'alice@example.com',
    });
    expect(extractRelatedThreadsAttendeeEmails(record)).toEqual([
      'bob@example.com',
    ]);
  });

  it('returns empty when only the organizer is present', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com'],
      organizer: 'alice@example.com',
    });
    expect(extractRelatedThreadsAttendeeEmails(record)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// findCandidateThreads — pure helper
// ────────────────────────────────────────────────────────────────

describe('findRelatedThreadCandidates', () => {
  it('returns empty for empty attendees list', () => {
    const ctx = stubCtx();
    expect(findRelatedThreadCandidates(ctx, [], NOW)).toEqual([]);
  });

  it('groups multiple messages on the same thread_id', () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-A',
      from: 'bob@example.com',
      to: ['user@example.com'],
      subject: 'First',
      received_at: NOW - 5 * ONE_HOUR,
    });
    insertMail({
      record_id: 'm2',
      thread_id: 'thread-A',
      from: 'bob@example.com',
      to: ['user@example.com'],
      subject: 'Second',
      received_at: NOW - 2 * ONE_HOUR,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.thread_id).toBe('thread-A');
    // most-recent subject takes priority
    expect(candidates[0]!.subject).toBe('Second');
    expect(candidates[0]!.last_message_at).toBe(NOW - 2 * ONE_HOUR);
  });

  it('counts attendee overlap correctly across multi-attendee threads', () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-multi',
      from: 'bob@example.com',
      to: ['carol@example.com', 'user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(
      ctx,
      ['bob@example.com', 'carol@example.com'],
      NOW,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.overlap_count).toBe(2);
  });

  it('drops messages whose participant only appears in subject (not from/to/cc)', () => {
    insertMail({
      record_id: 'm-irrelevant',
      thread_id: 'thread-irrelevant',
      from: 'spammer@spam.com',
      to: ['user@example.com'],
      subject: 'Re: Discussion with bob@example.com',
      received_at: NOW - ONE_DAY,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toEqual([]);
  });

  it('drops messages older than MAIL_LOOKBACK_MS', () => {
    insertMail({
      record_id: 'm-old',
      thread_id: 'thread-old',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - RELATED_THREADS_MAIL_LOOKBACK_MS - ONE_DAY,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toEqual([]);
  });

  it('caps results at RELATED_THREADS_MAX_CANDIDATES, sorted by recency', () => {
    for (let i = 0; i < RELATED_THREADS_MAX_CANDIDATES + 5; i++) {
      insertMail({
        record_id: `m-${i}`,
        thread_id: `thread-${i}`,
        from: 'bob@example.com',
        to: ['user@example.com'],
        received_at: NOW - i * ONE_HOUR,
      });
    }
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toHaveLength(RELATED_THREADS_MAX_CANDIDATES);
    // newest threads first
    expect(candidates[0]!.thread_id).toBe('thread-0');
  });

  it('includes mail where the attendee is in cc', () => {
    insertMail({
      record_id: 'm-cc',
      thread_id: 'thread-cc',
      from: 'someone@example.com',
      to: ['user@example.com'],
      cc: ['Bob Smith <bob@example.com>'],
      received_at: NOW - ONE_DAY,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.thread_id).toBe('thread-cc');
  });

  it('aggregates across multiple collection_mail_* tables', () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-A',
      thread_id: 'thread-A',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    insertMail({
      table: MAIL_TABLE_2,
      record_id: 'm-B',
      thread_id: 'thread-B',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - 2 * ONE_DAY,
    });
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates.map((c) => c.thread_id).sort()).toEqual(['thread-A', 'thread-B']);
  });

  it('drops messages without a thread_id (would fail to group meaningfully)', () => {
    db.prepare(
      `INSERT INTO ${MAIL_TABLE} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'm-bare',
      NOW - ONE_DAY,
      NOW - ONE_DAY,
      JSON.stringify({ from: 'bob@example.com', to: ['user@example.com'] }),
      100,
      'm-bare',
      null,
      null,
    );
    const ctx = stubCtx();
    const candidates = findRelatedThreadCandidates(ctx, ['bob@example.com'], NOW);
    expect(candidates).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// partitionDeterministic — pure helper
// ────────────────────────────────────────────────────────────────

describe('partitionRelatedThreadCandidates', () => {
  const candidate = (
    overrides: Partial<{
      thread_id: string;
      subject: string;
      last_message_at: number;
      overlap_count: number;
      message_count: number;
    }> = {},
  ) => ({
    thread_id: 't',
    subject: 'S',
    last_message_at: NOW,
    overlap_count: 1,
    message_count: 1,
    ...overrides,
  });

  it('classifies a full-overlap, ≥2-message thread as deterministic high', () => {
    const result = partitionRelatedThreadCandidates(
      [candidate({ overlap_count: 2, message_count: 3 })],
      2,
    );
    expect(result.deterministic).toHaveLength(1);
    expect(result.deterministic[0]!.relevance).toBe('high');
    expect(result.deterministic[0]!.source).toBe('deterministic');
    expect(result.remaining).toHaveLength(0);
  });

  it('forwards a full-overlap thread with too few messages to AI', () => {
    const result = partitionRelatedThreadCandidates(
      [
        candidate({
          overlap_count: 2,
          message_count: RELATED_THREADS_MIN_DETERMINISTIC_MESSAGES - 1,
        }),
      ],
      2,
    );
    expect(result.deterministic).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });

  it('forwards a partial-overlap thread to AI even with many messages', () => {
    const result = partitionRelatedThreadCandidates(
      [candidate({ overlap_count: 1, message_count: 10 })],
      3,
    );
    expect(result.deterministic).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });

  it('partitions a mixed batch correctly', () => {
    const result = partitionRelatedThreadCandidates(
      [
        candidate({ thread_id: 'full', overlap_count: 2, message_count: 5 }),
        candidate({ thread_id: 'partial', overlap_count: 1, message_count: 5 }),
      ],
      2,
    );
    expect(result.deterministic.map((d) => d.thread_id)).toEqual(['full']);
    expect(result.remaining.map((c) => c.thread_id)).toEqual(['partial']);
  });
});

// ────────────────────────────────────────────────────────────────
// composeTieBreakCorpus — pure helper
// ────────────────────────────────────────────────────────────────

describe('composeRelatedThreadsTieBreakCorpus', () => {
  it('emits header + per-thread block', () => {
    const corpus = composeRelatedThreadsTieBreakCorpus(
      'Q3 review',
      ['bob@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          thread_id: 'thread-A',
          subject: 'Budget',
          last_message_at: NOW,
          overlap_count: 1,
          message_count: 3,
        },
      ],
    );
    expect(corpus).toContain('Meeting: Q3 review');
    expect(corpus).toContain('Attendees: bob@example.com');
    expect(corpus).toContain('Thread: thread-A');
    expect(corpus).toContain('Subject: Budget');
    expect(corpus).toContain('Attendees overlapping: 1');
    expect(corpus).toContain('Message count: 3');
  });

  it('separates multiple threads with the next-thread divider', () => {
    const corpus = composeRelatedThreadsTieBreakCorpus(
      'Sync',
      ['bob@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          thread_id: 't1',
          subject: 'A',
          last_message_at: NOW,
          overlap_count: 1,
          message_count: 1,
        },
        {
          thread_id: 't2',
          subject: 'B',
          last_message_at: NOW,
          overlap_count: 1,
          message_count: 1,
        },
      ],
    );
    expect(corpus).toContain('--- next thread ---');
    expect((corpus.match(/--- next thread ---/g) ?? []).length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — null returns
// ────────────────────────────────────────────────────────────────

describe('relatedThreadsProducer.produce — null returns', () => {
  it('returns null when start_at is non-numeric', async () => {
    const stubLlm = buildStubLlm(okAiOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(
      ctx,
      sourceFor('e1', { start_at: 'tomorrow' }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null for events more than 24h in the past', async () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-1',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - 2 * ONE_DAY,
    });
    const stubLlm = buildStubLlm(okAiOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(
      ctx,
      sourceFor('e1', {
        start_at: NOW - RELATED_THREADS_PAST_GRACE_MS - ONE_HOUR,
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null when no attendees besides the organizer', async () => {
    const stubLlm = buildStubLlm(okAiOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null when no candidate threads exist', async () => {
    const stubLlm = buildStubLlm(okAiOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null when AI grades every candidate as unrelated', async () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-X',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm({
      grades: [
        { thread_id: 'thread-X', relevance: 'unrelated', reasoning: 'Not it.' },
      ],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).toBeNull();
    expect(stubLlm.fn).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────────
// AI-surface contract — misconfiguration
// ────────────────────────────────────────────────────────────────

describe('relatedThreadsProducer.produce — misconfiguration', () => {
  it('throws when ctx.llm is missing', async () => {
    const ctx = stubCtx();
    await expect(
      relatedThreadsProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/related_threads_producer_misconfigured.*ctx\.llm/);
  });
});

// ────────────────────────────────────────────────────────────────
// Happy paths
// ────────────────────────────────────────────────────────────────

describe('relatedThreadsProducer.produce — happy path', () => {
  it('emits deterministic-only result without invoking AI when every candidate has full-overlap + ≥2 messages', async () => {
    // Two attendees beyond organizer; thread has both attendees + 2 messages.
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-full',
      from: 'bob@example.com',
      to: ['carol@example.com'],
      received_at: NOW - 3 * ONE_HOUR,
    });
    insertMail({
      record_id: 'm2',
      thread_id: 'thread-full',
      from: 'carol@example.com',
      to: ['bob@example.com'],
      received_at: NOW - ONE_HOUR,
    });
    const stubLlm = buildStubLlm({ grades: [] });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).not.toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
    const value = out!.value as RelatedThreadsValue;
    expect(value.threads).toHaveLength(1);
    expect(value.threads[0]!.relevance).toBe('high');
    expect(value.threads[0]!.source).toBe('deterministic');
    expect(value.ai_invoked).toBe(false);
  });

  it('emits AI-only result and respects the AI grades', async () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-bob-only',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    insertMail({
      record_id: 'm2',
      thread_id: 'thread-carol-only',
      from: 'carol@example.com',
      to: ['user@example.com'],
      received_at: NOW - 2 * ONE_DAY,
    });
    const stubLlm = buildStubLlm(okAiOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).not.toBeNull();
    const value = out!.value as RelatedThreadsValue;
    expect(value.ai_invoked).toBe(true);
    expect(value.threads.map((t) => t.thread_id).sort()).toEqual([
      'thread-bob-only',
      'thread-carol-only',
    ]);
    expect(value.threads.every((t) => t.source === 'ai')).toBe(true);
    expect(value.threads.find((t) => t.thread_id === 'thread-bob-only')!.relevance).toBe(
      'medium',
    );
    // D-136 P1: confidence stripped from RelatedThreadsValue (time_bound topic)
    expect(value.computed_at).toBe(NOW);
  });

  it('emits a mixed deterministic + AI result and ranks by relevance desc', async () => {
    // Full-overlap → deterministic high
    insertMail({
      record_id: 'm-full-1',
      thread_id: 'thread-full',
      from: 'bob@example.com',
      to: ['carol@example.com'],
      received_at: NOW - 4 * ONE_HOUR,
    });
    insertMail({
      record_id: 'm-full-2',
      thread_id: 'thread-full',
      from: 'carol@example.com',
      to: ['bob@example.com'],
      received_at: NOW - 2 * ONE_HOUR,
    });
    // Partial-overlap → goes through AI; graded medium
    insertMail({
      record_id: 'm-partial',
      thread_id: 'thread-partial',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - 6 * ONE_HOUR,
    });
    const stubLlm = buildStubLlm({
      grades: [
        {
          thread_id: 'thread-partial',
          relevance: 'medium',
          reasoning: 'Likely related.',
        },
      ],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).not.toBeNull();
    const value = out!.value as RelatedThreadsValue;
    expect(value.threads.map((t) => t.thread_id)).toEqual([
      'thread-full', // high (deterministic) first
      'thread-partial', // medium (ai) second
    ]);
    expect(value.ai_invoked).toBe(true);
    expect(value.candidate_count).toBe(2);
  });

  it('drops fabricated thread_ids the AI returns that are not in the candidate set', async () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-real',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm({
      grades: [
        { thread_id: 'thread-real', relevance: 'high', reasoning: 'Yes.' },
        {
          thread_id: 'thread-fabricated',
          relevance: 'high',
          reasoning: 'Made up.',
        },
      ],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).not.toBeNull();
    const value = out!.value as RelatedThreadsValue;
    expect(value.threads.map((t) => t.thread_id)).toEqual(['thread-real']);
  });

  it('caps emit at MAX_RELATED_THREADS', async () => {
    for (let i = 0; i < MAX_RELATED_THREADS + 3; i++) {
      insertMail({
        record_id: `m-${i}`,
        thread_id: `thread-${i}`,
        from: 'bob@example.com',
        to: ['user@example.com'],
        received_at: NOW - i * ONE_HOUR,
      });
    }
    const stubLlm = buildStubLlm({
      grades: Array.from({ length: MAX_RELATED_THREADS + 3 }, (_, i) => ({
        thread_id: `thread-${i}`,
        relevance: 'medium',
        reasoning: 'sure',
      })),
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(out).not.toBeNull();
    const value = out!.value as RelatedThreadsValue;
    expect(value.threads).toHaveLength(MAX_RELATED_THREADS);
  });

  it('passes the candidate corpus + tie-break context to ai-extract', async () => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-X',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm({
      grades: [
        { thread_id: 'thread-X', relevance: 'high', reasoning: 'OK' },
      ],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await relatedThreadsProducer.produce(ctx, sourceFor('e1'));
    expect(stubLlm.capturedManifest!.slug).toBe('ai-extract');
    expect(stubLlm.capturedInput!['llm.fields']).toEqual(['grades']);
    expect(stubLlm.capturedInput!['llm.context']).toMatch(/topical relevance/i);
    expect(stubLlm.capturedInput!['llm.model_hint']).toBe('fast');
    expect(stubLlm.capturedInput!['llm.data']).toContain('Thread: thread-X');
  });
});

// ────────────────────────────────────────────────────────────────
// Closed-shape rejection on malformed AI output
// ────────────────────────────────────────────────────────────────

describe('relatedThreadsProducer.produce — output validation', () => {
  beforeEach(() => {
    insertMail({
      record_id: 'm1',
      thread_id: 'thread-X',
      from: 'bob@example.com',
      to: ['user@example.com'],
      received_at: NOW - ONE_DAY,
    });
  });

  it('throws when grades is missing', async () => {
    const stubLlm = buildStubLlm({ other: 'nope' });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      relatedThreadsProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/related_threads_output_invalid/);
  });

  it('throws when a grade has an invalid relevance value', async () => {
    const stubLlm = buildStubLlm({
      grades: [{ thread_id: 'thread-X', relevance: 'maybe' }],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      relatedThreadsProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/related_threads_output_invalid/);
  });

  it('throws on a primitive (non-object) AI return', async () => {
    const stubLlm = buildStubLlm('a string');
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      relatedThreadsProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/related_threads_output_invalid/);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_REGISTRY.related_threads value_schema', () => {
  it('accepts the producer-emitted shape', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    const result = def.value_schema({
      threads: [
        {
          thread_id: 'thread-1',
          subject: 'Subject',
          last_message_at: NOW,
          overlap_count: 2,
          relevance: 'high',
          source: 'deterministic',
        },
      ],
      candidate_count: 3,
      ai_invoked: false,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty threads array (still a valid row even though the producer never emits one)', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    const result = def.value_schema({
      threads: [],
      candidate_count: 0,
      ai_invoked: false,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    expect(def.value_schema('nope').ok).toBe(false);
  });

  it('rejects when ai_invoked is missing', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    const result = def.value_schema({
      threads: [],
      candidate_count: 0,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a thread entry with an invalid relevance value', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    const result = def.value_schema({
      threads: [
        {
          thread_id: 't1',
          subject: 'X',
          last_message_at: NOW,
          overlap_count: 1,
          relevance: 'maybe',
          source: 'ai',
        },
      ],
      candidate_count: 1,
      ai_invoked: true,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a thread entry with an invalid source', () => {
    const def = ENRICHMENT_REGISTRY.related_threads;
    const result = def.value_schema({
      threads: [
        {
          thread_id: 't1',
          subject: 'X',
          last_message_at: NOW,
          overlap_count: 1,
          relevance: 'high',
          source: 'guess',
        },
      ],
      candidate_count: 1,
      ai_invoked: true,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
