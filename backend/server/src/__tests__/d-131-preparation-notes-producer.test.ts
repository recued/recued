/** D-131 A.12 — `preparation_notes` enrichment producer tests.
 *
 *  First calendar-scope AI producer + first multi-source-corpus
 *  housekeeping producer. Covers:
 *
 *    - Surface contract (topic / scope / ai_surface / token estimate /
 *      scope_read_declaration / registry trust + pool defaults +
 *      emits_confidence + sidecar='fts')
 *    - Pure helper coverage: `extractAttendeeEmails` (organizer
 *      filtered out, mixed string + object attendees, dedupe + sort),
 *      `composeCorpus` (header layout, snippet grouping, attendee
 *      ordering preserved)
 *    - Empty / null cases: missing start_at, past event > 24h,
 *      no attendees, only organizer attended, no mail corpus, corpus
 *      below `MIN_CORPUS_CHARS`
 *    - AI-surface contract: throws on missing `ctx.llm` / `ctx.blobs`
 *    - Happy path: corpus assembly + AI summarisation produces
 *      `{summary, key_points, attendees_considered, corpus_size,
 *        confidence, computed_at}` value + `sidecar_text`
 *    - Body resolution: inline preferred, blob_hash fallback,
 *      missing blob skipped
 *    - Sender/recipient filter: rows whose participant string only
 *      appears as a substring (e.g. inside subject) are not folded
 *      into the corpus; rows where the participant is in `from`,
 *      `to`, or `cc` ARE.
 *    - Multi-table aggregation: rows from multiple
 *      `collection_mail_*` tables fold together
 *    - Long-snippet truncation at `MAX_CHARS_PER_SNIPPET`
 *    - Per-participant cap at `MAX_SNIPPETS_PER_PARTICIPANT`
 *    - Mail older than `MAIL_LOOKBACK_MS` is excluded
 *    - Closed-shape rejection: malformed ai-summarize output throws
 *      `preparation_notes_output_invalid`
 *    - Registry value_schema accepts the produced shape
 *
 *  Mirrors the SQLite mail-table fixture shape used by `company` /
 *  `role` producer tests since the corpus query reads the same
 *  `collection_mail_*` table family. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type CollectionRecord,
  type IngredientManifest,
  type PreparationNotesValue,
} from '@recued/contracts';

import {
  preparationNotesProducer,
  composePreparationNotesCorpus,
  extractPreparationNotesAttendeeEmails,
  PREPARATION_NOTES_MIN_CORPUS_CHARS,
  PREPARATION_NOTES_PAST_GRACE_MS,
  PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT,
  PREPARATION_NOTES_MAX_CHARS_PER_SNIPPET,
  PREPARATION_NOTES_MAIL_LOOKBACK_MS,
} from '../housekeeping/index.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure (mirrors company / role test shape)
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

const MAIL_TABLE = 'collection_mail_11111111aa';
const MAIL_TABLE_2 = 'collection_mail_22222222bb';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-prep-'));
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
  table: string;
  record_id: string;
  hot: Record<string, unknown>;
  body?: { inline?: string; blob_hash?: string };
  received_at?: number;
}

const insertMail = (m: InsertedMail): void => {
  db.prepare(
    `INSERT INTO ${m.table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.record_id,
    m.received_at ?? NOW,
    m.received_at ?? NOW,
    JSON.stringify(m.hot),
    m.body?.inline ? m.body.inline.length : 100,
    m.record_id,
    m.body?.inline ?? null,
    m.body?.blob_hash ?? null,
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
  // D-136 P3 — preparationNotesProducer reads `ctx.llmWithMeta`. Wrap.
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

const okSummarizeOutput = {
  summary:
    'Bob has been driving the budget overrun discussion for two weeks; Carol is waiting on the new pricing model from the sales team.',
  key_points: [
    'Open: budget signoff for Q3 contractor work',
    'Open: Carol awaiting updated pricing from Sales',
    'Decision pending: hire vs. reallocate engineering capacity',
  ],
};

// Long body fragment used in corpus assembly tests; shaped to ensure
// it pushes the corpus over the MIN_CORPUS_CHARS floor for any single-
// participant event.
const longBodyFor = (participant: string): string =>
  `Hi ${participant.split('@')[0]},\n\n` +
  `Following up on the strategy doc — wanted to flag two open ` +
  `questions before we sync. First, the Q3 budget split between ` +
  `engineering hires and contractor spend; second, the pricing ` +
  `model deliverable Carol mentioned in the last all-hands. ` +
  `Let me know what you think before tomorrow.\n\nBest, sender`;

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('preparationNotesProducer surface contract', () => {
  it('targets the preparation_notes registry topic', () => {
    expect(preparationNotesProducer.topic).toBe('preparation_notes');
  });

  it('targets the calendar source scope', () => {
    expect(preparationNotesProducer.source_scope).toBe('calendar');
  });

  it('declares ai_surface=chat (ai-summarize via executeLLM)', () => {
    expect(preparationNotesProducer.ai_surface).toBe('chat');
  });

  it('declares positive token estimate (AI-surface gate)', () => {
    expect(preparationNotesProducer.estimate_per_record_tokens()).toBeGreaterThan(0);
  });

  it('declares both data.calendar and data.mail in scope_read_declaration', () => {
    const collections = preparationNotesProducer.scope_read_declaration.map(
      (d) => d.collection,
    );
    expect(collections).toContain('data.calendar');
    expect(collections).toContain('data.mail');
  });

  it('declares attendees + start_at + summary as calendar sample fields', () => {
    const calendarDecl = preparationNotesProducer.scope_read_declaration.find(
      (d) => d.collection === 'data.calendar',
    );
    expect(calendarDecl).toBeDefined();
    expect(calendarDecl!.sample_field_paths).toContain('attendees');
    expect(calendarDecl!.sample_field_paths).toContain('start_at');
    expect(calendarDecl!.sample_field_paths).toContain('summary');
  });

  it('preparation_notes is time_bound — not PSI-eligible (D-136 P1 revoked emits_confidence)', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('registry default_trust_state is manual (AI producer)', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    expect(def.default_trust_state).toBe('manual');
  });

  it('registry default_pool_policy is free_only (cheap-and-noisy class)', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    expect(def.default_pool_policy).toBe('free_only');
  });

  it('registry sidecar is fts (summary text is FTS-indexed)', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    expect(def.sidecar).toBe('fts');
  });

  it('registry policy is dependent (1:1 cascade with the calendar event)', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    expect(def.policy).toBe('dependent');
  });
});

// ────────────────────────────────────────────────────────────────
// extractAttendeeEmails — pure helper
// ────────────────────────────────────────────────────────────────

describe('extractPreparationNotesAttendeeEmails', () => {
  it('returns canonical emails sorted ASC for a string-array attendees field', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['Carol <carol@example.com>', 'bob@example.com', 'alice@example.com'],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('handles {email, ...}[] attendee shape from gcal/graph adapters', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: [
        { email: 'bob@example.com', display_name: 'Bob' },
        { email: 'alice@example.com', display_name: 'Alice', is_self: true },
        { email: 'carol@example.com' },
      ],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('filters the organizer out so they are not double-counted', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com', 'bob@example.com'],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([
      'bob@example.com',
    ]);
  });

  it('dedupes attendees that appear under multiple wrappers', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: [
        'Bob Smith <bob@example.com>',
        'bob@example.com',
        { email: 'bob@example.com' },
      ],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([
      'bob@example.com',
    ]);
  });

  it('returns an empty list when only the organizer is present', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['alice@example.com'],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([]);
  });

  it('returns an empty list for a missing attendees field', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: undefined,
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([]);
  });

  it('drops unparseable attendee strings silently', () => {
    const record = fakeCalendarRecord('e1', {
      attendees: ['not-an-email', 'bob@example.com', ''],
      organizer: 'alice@example.com',
    });
    expect(extractPreparationNotesAttendeeEmails(record)).toEqual([
      'bob@example.com',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// composeCorpus — pure helper
// ────────────────────────────────────────────────────────────────

describe('composePreparationNotesCorpus', () => {
  it('emits a header with summary / start / attendees', () => {
    const corpus = composePreparationNotesCorpus(
      'Q3 strategy review',
      ['bob@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          participant: 'bob@example.com',
          from: 'bob@example.com',
          subject: 'Budget',
          received_at: NOW,
          body: 'Recent thread body.',
        },
      ],
    );
    expect(corpus).toContain('Meeting: Q3 strategy review');
    expect(corpus).toContain('Starts: 2026-04-30T15:00:00.000Z');
    expect(corpus).toContain('Attendees: bob@example.com');
  });

  it('groups multiple snippets under the same participant header', () => {
    const corpus = composePreparationNotesCorpus(
      'Sync',
      ['bob@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          participant: 'bob@example.com',
          from: 'bob@example.com',
          subject: 'First',
          received_at: NOW - 2 * ONE_DAY,
          body: 'first body',
        },
        {
          participant: 'bob@example.com',
          from: 'bob@example.com',
          subject: 'Second',
          received_at: NOW - ONE_DAY,
          body: 'second body',
        },
      ],
    );
    const headerIndex = corpus.indexOf(
      '# Recent mail involving bob@example.com',
    );
    const dividerCount = (corpus.match(/--- next message ---/g) ?? []).length;
    expect(headerIndex).toBeGreaterThan(-1);
    expect(dividerCount).toBe(1);
  });

  it('emits one section per attendee and preserves attendee order', () => {
    const corpus = composePreparationNotesCorpus(
      'Sync',
      ['bob@example.com', 'carol@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          participant: 'carol@example.com',
          from: 'carol@example.com',
          subject: 'Pricing',
          received_at: NOW,
          body: 'pricing thread',
        },
        {
          participant: 'bob@example.com',
          from: 'bob@example.com',
          subject: 'Budget',
          received_at: NOW,
          body: 'budget thread',
        },
      ],
    );
    const bobIdx = corpus.indexOf('# Recent mail involving bob@example.com');
    const carolIdx = corpus.indexOf('# Recent mail involving carol@example.com');
    expect(bobIdx).toBeGreaterThan(-1);
    expect(carolIdx).toBeGreaterThan(bobIdx);
  });

  it('omits sections for attendees with no snippets', () => {
    const corpus = composePreparationNotesCorpus(
      'Sync',
      ['bob@example.com', 'carol@example.com'],
      '2026-04-30T15:00:00.000Z',
      [
        {
          participant: 'bob@example.com',
          from: 'bob@example.com',
          subject: 'Budget',
          received_at: NOW,
          body: 'budget thread',
        },
      ],
    );
    expect(corpus).toContain('bob@example.com');
    expect(corpus).not.toContain('# Recent mail involving carol@example.com');
  });
});

// ────────────────────────────────────────────────────────────────
// Empty / null cases
// ────────────────────────────────────────────────────────────────

describe('preparationNotesProducer.produce — null returns', () => {
  it('returns null when start_at is missing or non-numeric', async () => {
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', { start_at: 'tomorrow', attendees: ['bob@example.com'] }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null for events more than 24h in the past', async () => {
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        start_at: NOW - PREPARATION_NOTES_PAST_GRACE_MS - ONE_HOUR,
        attendees: ['bob@example.com'],
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('accepts events within the past 24h grace window', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm1',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Budget',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        start_at: NOW - 12 * ONE_HOUR, // 12h ago — well inside grace
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).not.toBeNull();
    expect(stubLlm.fn).toHaveBeenCalledOnce();
  });

  it('returns null when no attendees besides the organizer', async () => {
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null when no mail corpus exists for any attendee', async () => {
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('returns null when corpus is below MIN_CORPUS_CHARS', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm1',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'k',
      },
      body: { inline: 'k' },
      received_at: NOW,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).toBeNull();
    expect(stubLlm.fn).not.toHaveBeenCalled();
  });

  it('respects the 90d MAIL_LOOKBACK_MS — older mail is excluded', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-old',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Old thread',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - PREPARATION_NOTES_MAIL_LOOKBACK_MS - 7 * ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    // Mail too old → excluded → corpus empty → null.
    expect(out).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// AI-surface contract — misconfiguration throws
// ────────────────────────────────────────────────────────────────

describe('preparationNotesProducer.produce — misconfiguration', () => {
  it('throws when ctx.llm is missing', async () => {
    const ctx = stubCtx({ blobs: buildBlobs() });
    await expect(
      preparationNotesProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/preparation_notes_producer_misconfigured.*ctx\.llm/);
  });

  it('throws when ctx.blobs is missing', async () => {
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn });
    await expect(
      preparationNotesProducer.produce(ctx, sourceFor('e1')),
    ).rejects.toThrow(/preparation_notes_producer_misconfigured.*ctx\.blobs/);
  });
});

// ────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────

describe('preparationNotesProducer.produce — happy path', () => {
  it('assembles corpus and returns the expected value shape', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm1',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        cc: ['carol@example.com'],
        subject: 'Budget thread',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - 2 * ONE_DAY,
    });
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm2',
      hot: {
        from: 'carol@example.com',
        to: ['user@example.com'],
        subject: 'Pricing model',
      },
      body: { inline: longBodyFor('carol@example.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1'),
    );
    expect(out).not.toBeNull();
    const value = out!.value as PreparationNotesValue;
    expect(value.summary).toBe(okSummarizeOutput.summary);
    expect(value.key_points).toEqual(okSummarizeOutput.key_points);
    expect(value.attendees_considered).toEqual([
      'bob@example.com',
      'carol@example.com',
    ]);
    // D-136 P1: confidence stripped from PreparationNotesValue (time_bound topic)
    expect(value.computed_at).toBe(NOW);
    expect(value.corpus_size).toBeGreaterThanOrEqual(
      PREPARATION_NOTES_MIN_CORPUS_CHARS,
    );
    expect(out!.sidecar_text).toBe(okSummarizeOutput.summary);
  });

  it('passes the corpus + focus prompt to ai-summarize', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm1',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Budget thread',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(stubLlm.capturedManifest!.slug).toBe('ai-summarize');
    expect(typeof stubLlm.capturedInput!['llm.data']).toBe('string');
    expect(stubLlm.capturedInput!['llm.focus']).toMatch(/prep notes/i);
    expect(stubLlm.capturedInput!['llm.model_hint']).toBe('fast');
  });

  it('reads body from blob_hash when body_inline is missing', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-blob',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Budget',
      },
      body: { blob_hash: 'sha256-cafebabe' },
      received_at: NOW - ONE_DAY,
    });
    const blobBody = longBodyFor('bob@example.com');
    const blobs = buildBlobs({
      get: vi.fn(async (h: string) => {
        if (h === 'sha256-cafebabe') return Buffer.from(blobBody, 'utf8');
        return null;
      }),
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).not.toBeNull();
    expect(stubLlm.capturedInput!['llm.data']).toContain(
      'Following up on the strategy doc',
    );
  });

  it('skips a mail row when blob_hash points to a missing blob', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-blob-miss',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Lost',
      },
      body: { blob_hash: 'sha256-missing' },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({
      llm: stubLlm.fn,
      blobs: buildBlobs({ get: vi.fn(async () => null) }),
    });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    // No other mail → corpus empty → null.
    expect(out).toBeNull();
  });

  it('aggregates rows from multiple collection_mail_* tables', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-A',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'From account A',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - 2 * ONE_DAY,
    });
    insertMail({
      table: MAIL_TABLE_2,
      record_id: 'm-B',
      hot: {
        from: 'carol@example.com',
        to: ['user@example.com'],
        subject: 'From account B',
      },
      body: { inline: longBodyFor('carol@example.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1'),
    );
    expect(out).not.toBeNull();
    const corpus = stubLlm.capturedInput!['llm.data'] as string;
    expect(corpus).toContain('bob@example.com');
    expect(corpus).toContain('carol@example.com');
  });

  it('respects the per-participant snippet cap', async () => {
    for (let i = 0; i < PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT + 3; i++) {
      insertMail({
        table: MAIL_TABLE,
        record_id: `m-bob-${i}`,
        hot: {
          from: 'bob@example.com',
          to: ['user@example.com'],
          subject: `Bob thread ${i}`,
        },
        body: { inline: longBodyFor('bob@example.com') + ` marker-${i}` },
        received_at: NOW - (i + 1) * ONE_HOUR,
      });
    }
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    const corpus = stubLlm.capturedInput!['llm.data'] as string;
    let kept = 0;
    for (let i = 0; i < PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT + 3; i++) {
      if (corpus.includes(`marker-${i}`)) kept += 1;
    }
    expect(kept).toBe(PREPARATION_NOTES_MAX_SNIPPETS_PER_PARTICIPANT);
  });

  it('truncates a single oversized body to MAX_CHARS_PER_SNIPPET', async () => {
    const huge = 'X'.repeat(PREPARATION_NOTES_MAX_CHARS_PER_SNIPPET * 3);
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-huge',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Wall of text',
      },
      body: { inline: huge },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    const corpus = stubLlm.capturedInput!['llm.data'] as string;
    // Find the X-block by counting trailing X runs; corpus also has
    // the participant header preceding it.
    const xRun = corpus.match(/X+/g)?.reduce(
      (max, run) => (run.length > max ? run.length : max),
      0,
    );
    expect(xRun).toBeLessThanOrEqual(PREPARATION_NOTES_MAX_CHARS_PER_SNIPPET);
  });

  it('excludes mail where the participant only appears in subject (not from/to/cc)', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-irrelevant',
      hot: {
        from: 'spammer@spam.com',
        to: ['user@example.com'],
        subject: 'Re: Discussion with bob@example.com (unrelated)',
      },
      body: { inline: longBodyFor('spammer@spam.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    // The participant is mentioned in subject but never in
    // from/to/cc — the post-filter rejects it. No other corpus → null.
    expect(out).toBeNull();
  });

  it('includes mail where the participant is in cc (not just from/to)', async () => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm-cc',
      hot: {
        from: 'someone@example.com',
        to: ['user@example.com'],
        cc: ['Bob Smith <bob@example.com>'],
        subject: 'CC thread',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - ONE_DAY,
    });
    const stubLlm = buildStubLlm(okSummarizeOutput);
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    const out = await preparationNotesProducer.produce(
      ctx,
      sourceFor('e1', {
        attendees: ['bob@example.com', 'alice@example.com'],
        organizer: 'alice@example.com',
      }),
    );
    expect(out).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Closed-shape rejection on malformed AI output
// ────────────────────────────────────────────────────────────────

describe('preparationNotesProducer.produce — output validation', () => {
  beforeEach(() => {
    insertMail({
      table: MAIL_TABLE,
      record_id: 'm1',
      hot: {
        from: 'bob@example.com',
        to: ['user@example.com'],
        subject: 'Budget',
      },
      body: { inline: longBodyFor('bob@example.com') },
      received_at: NOW - ONE_DAY,
    });
  });

  it('throws preparation_notes_output_invalid when summary is missing', async () => {
    const stubLlm = buildStubLlm({ key_points: ['x'] });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      preparationNotesProducer.produce(
        ctx,
        sourceFor('e1', {
          attendees: ['bob@example.com', 'alice@example.com'],
          organizer: 'alice@example.com',
        }),
      ),
    ).rejects.toThrow(/preparation_notes_output_invalid/);
  });

  it('throws when key_points is not an array of strings', async () => {
    const stubLlm = buildStubLlm({
      summary: 's',
      key_points: ['ok', 42 as unknown as string],
    });
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      preparationNotesProducer.produce(
        ctx,
        sourceFor('e1', {
          attendees: ['bob@example.com', 'alice@example.com'],
          organizer: 'alice@example.com',
        }),
      ),
    ).rejects.toThrow(/preparation_notes_output_invalid/);
  });

  it('throws on a primitive (non-object) AI return', async () => {
    const stubLlm = buildStubLlm('a string');
    const ctx = stubCtx({ llm: stubLlm.fn, blobs: buildBlobs() });
    await expect(
      preparationNotesProducer.produce(
        ctx,
        sourceFor('e1', {
          attendees: ['bob@example.com', 'alice@example.com'],
          organizer: 'alice@example.com',
        }),
      ),
    ).rejects.toThrow(/preparation_notes_output_invalid/);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_REGISTRY.preparation_notes value_schema', () => {
  it('accepts the producer-emitted shape', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    const result = def.value_schema({
      summary: 'Brief.',
      key_points: ['Point 1', 'Point 2'],
      attendees_considered: ['bob@example.com'],
      corpus_size: 1234,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    const result = def.value_schema('not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects when key_points contains a non-string', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    const result = def.value_schema({
      summary: 'Brief.',
      key_points: ['ok', 42],
      attendees_considered: ['bob@example.com'],
      corpus_size: 1234,
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when corpus_size is missing', () => {
    const def = ENRICHMENT_REGISTRY.preparation_notes;
    const result = def.value_schema({
      summary: 'Brief.',
      key_points: ['x'],
      attendees_considered: ['bob@example.com'],
      confidence: 0.85,
      computed_at: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
