/** D-145 PA9 — `note_relevance_decay` producer tests.
 *
 *  Fourth D-145 PA9 producer impl + first per-record producer on a
 *  work-entity scope (novel `walker_kind: 'note'`). Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration)
 *    - computeNoteDecayScore pure-function cases (just-accessed /
 *      midpoint / edge / past-window / future / non-finite defensive)
 *    - readLatestUserAccessForNote pure SQL helper (kind filter excludes
 *      AI / recipe / MCP reads; MAX selection across multiple user
 *      entries; empty note_id short-circuit)
 *    - produce() integration: bootstrap from `last_user_action_at` when
 *      ledger empty, ledger-max preferred when newer than last_user_action_at,
 *      last_user_action_at preferred when newer than stale ledger entry,
 *      decay=0 still emits (distinct from row-absent), feedback-loop
 *      guard (ai/recipe/mcp kinds don't bump freshness)
 *    - Registry value_schema acceptance round-trip
 *    - Registry shape + cadence + scope alignment */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type Note,
  type NoteRelevanceDecayValue,
} from '@recued/contracts';

import {
  NOTE_RELEVANCE_DECAY_WINDOW_MS,
  NOTE_RELEVANCE_USER_ACCESS_KINDS,
  computeNoteDecayScore,
  noteRelevanceDecayProducer,
  readLatestUserAccessForNote,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { NOTE_ACCESS_LEDGER_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-decay-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal ledger table — mirrors the columns the producer reads.
  db.exec(`
    CREATE TABLE ${NOTE_ACCESS_LEDGER_TABLE} (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL,
      accessed_at     INTEGER NOT NULL,
      access_kind     TEXT NOT NULL,
      access_actor    TEXT,
      metadata_blob   TEXT
    );
    CREATE INDEX idx_nal_note_time
      ON ${NOTE_ACCESS_LEDGER_TABLE} (note_id, accessed_at DESC);
    CREATE INDEX idx_nal_kind_time
      ON ${NOTE_ACCESS_LEDGER_TABLE} (access_kind, accessed_at DESC);
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface LedgerRow {
  id?: string;
  note_id: string;
  accessed_at: number;
  access_kind:
    | 'user_open'
    | 'user_edit'
    | 'recipe_query'
    | 'ai_packet_inclusion'
    | 'mcp_read';
}

let ledgerRowCount = 0;
const insertLedgerEntry = (row: LedgerRow): void => {
  ledgerRowCount += 1;
  db.prepare(
    `INSERT INTO ${NOTE_ACCESS_LEDGER_TABLE} (id, note_id, accessed_at, access_kind)
     VALUES (?, ?, ?, ?)`,
  ).run(row.id ?? `nal_${ledgerRowCount}`, row.note_id, row.accessed_at, row.access_kind);
};

const stubCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const fakeNote = (overrides: Partial<Note> & { id: string }): Note => ({
  id: overrides.id,
  body: overrides.body ?? `Body for ${overrides.id}`,
  created_at: overrides.created_at ?? NOW - 30 * ONE_DAY,
  updated_at: overrides.updated_at ?? NOW - 30 * ONE_DAY,
  last_user_action_at: overrides.last_user_action_at ?? NOW - 30 * ONE_DAY,
  related_contact_ids: overrides.related_contact_ids ?? [],
  related_calendar_event_ids: overrides.related_calendar_event_ids ?? [],
  related_mail_thread_ids: overrides.related_mail_thread_ids ?? [],
  related_project_ids: overrides.related_project_ids ?? [],
  source_id: overrides.source_id ?? 'src_test',
  source_record_id: overrides.source_record_id ?? overrides.id,
  source_updated_at: overrides.source_updated_at ?? NOW - 30 * ONE_DAY,
  last_seen_at: overrides.last_seen_at ?? NOW - 30 * ONE_DAY,
  sync_state: overrides.sync_state ?? 'live',
  conflict_policy: overrides.conflict_policy ?? 'source_wins',
  source_record_hash: overrides.source_record_hash ?? 'h_test',
  ...(overrides.connection_id !== undefined ? { connection_id: overrides.connection_id } : {}),
  ...(overrides.deleted_at !== undefined ? { deleted_at: overrides.deleted_at } : {}),
  ...(overrides.title !== undefined ? { title: overrides.title } : {}),
  ...(overrides.source_extension_blob !== undefined
    ? { source_extension_blob: overrides.source_extension_blob }
    : {}),
});

const sourceFor = (note: Note): SourceRecord<Note> => ({
  target_id: note.id,
  data: note,
  cursor_token: note.id,
});

const expectValue = async (
  ctx: HousekeepingContext,
  note: Note,
): Promise<NoteRelevanceDecayValue> => {
  const out = await noteRelevanceDecayProducer.produce(ctx, sourceFor(note));
  if (out === null) throw new Error(`expected producer output for ${note.id}, got null`);
  return out.value as NoteRelevanceDecayValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('noteRelevanceDecayProducer surface contract', () => {
  it('targets the note_relevance_decay registry topic', () => {
    expect(noteRelevanceDecayProducer.topic).toBe('note_relevance_decay');
  });

  it('targets the note source scope (novel walker_kind: "note")', () => {
    expect(noteRelevanceDecayProducer.source_scope).toBe('note');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(noteRelevanceDecayProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 7d recompute cadence matching the registry', () => {
    expect(noteRelevanceDecayProducer.recompute_cadence).toBe('7d');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(noteRelevanceDecayProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for data.note + note_access_ledger with the load-bearing fields', () => {
    const decls = noteRelevanceDecayProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual(['data.note', 'note_access_ledger']);
    const noteEntry = decls.find((e) => e.collection === 'data.note')!;
    expect(noteEntry.sample_field_paths).toEqual(['id', 'last_user_action_at']);
    const ledgerEntry = decls.find((e) => e.collection === 'note_access_ledger')!;
    expect(ledgerEntry.sample_field_paths).toEqual(['note_id', 'accessed_at', 'access_kind']);
  });

  it('window constant matches the registry aggregate_window_ms (180d)', () => {
    expect(NOTE_RELEVANCE_DECAY_WINDOW_MS).toBe(180 * ONE_DAY);
    const def = ENRICHMENT_REGISTRY.note_relevance_decay as { aggregate_window_ms?: number };
    expect(def.aggregate_window_ms).toBe(NOTE_RELEVANCE_DECAY_WINDOW_MS);
  });

  it('user-driven access kinds exclude AI / recipe / MCP read paths', () => {
    expect([...NOTE_RELEVANCE_USER_ACCESS_KINDS]).toEqual(['user_open', 'user_edit']);
    // The feedback-loop guard is the load-bearing reason — see § A.1.2.
    expect((NOTE_RELEVANCE_USER_ACCESS_KINDS as ReadonlyArray<string>)).not.toContain(
      'ai_packet_inclusion',
    );
    expect((NOTE_RELEVANCE_USER_ACCESS_KINDS as ReadonlyArray<string>)).not.toContain('recipe_query');
    expect((NOTE_RELEVANCE_USER_ACCESS_KINDS as ReadonlyArray<string>)).not.toContain('mcp_read');
  });
});

// ────────────────────────────────────────────────────────────────
// computeNoteDecayScore pure-function cases
// ────────────────────────────────────────────────────────────────

describe('computeNoteDecayScore', () => {
  it('returns 1.0 when accessed at the same moment as now', () => {
    expect(computeNoteDecayScore(NOW, NOW)).toBe(1);
  });

  it('returns 1.0 for a future access (defensive clock-skew guard)', () => {
    expect(computeNoteDecayScore(NOW + ONE_DAY, NOW)).toBe(1);
  });

  it('returns 0.0 at exactly the window edge', () => {
    expect(computeNoteDecayScore(NOW - NOTE_RELEVANCE_DECAY_WINDOW_MS, NOW)).toBe(0);
  });

  it('returns 0.0 past the window edge', () => {
    expect(computeNoteDecayScore(NOW - NOTE_RELEVANCE_DECAY_WINDOW_MS - ONE_DAY, NOW)).toBe(0);
  });

  it('returns 0.5 at the window midpoint (90 days for the 180d window)', () => {
    expect(computeNoteDecayScore(NOW - 90 * ONE_DAY, NOW)).toBe(0.5);
  });

  it('interpolates linearly inside the window', () => {
    // 45d elapsed → 1 - 45/180 = 0.75
    expect(computeNoteDecayScore(NOW - 45 * ONE_DAY, NOW)).toBe(0.75);
    // 135d elapsed → 1 - 135/180 = 0.25
    expect(computeNoteDecayScore(NOW - 135 * ONE_DAY, NOW)).toBe(0.25);
  });

  it('respects caller-supplied window override', () => {
    const customWindow = 30 * ONE_DAY;
    // 15d elapsed → 1 - 15/30 = 0.5
    expect(computeNoteDecayScore(NOW - 15 * ONE_DAY, NOW, customWindow)).toBe(0.5);
    // 30d elapsed → 0
    expect(computeNoteDecayScore(NOW - 30 * ONE_DAY, NOW, customWindow)).toBe(0);
  });

  it('returns 0 defensively for non-finite inputs', () => {
    expect(computeNoteDecayScore(Number.NaN, NOW)).toBe(0);
    expect(computeNoteDecayScore(NOW, Number.NaN)).toBe(0);
    expect(computeNoteDecayScore(Number.NEGATIVE_INFINITY, NOW)).toBe(0);
    expect(computeNoteDecayScore(NOW, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('returns 0 defensively when window_ms is non-positive', () => {
    expect(computeNoteDecayScore(NOW - ONE_DAY, NOW, 0)).toBe(0);
    expect(computeNoteDecayScore(NOW - ONE_DAY, NOW, -1)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// readLatestUserAccessForNote — pure SQL helper
// ────────────────────────────────────────────────────────────────

describe('readLatestUserAccessForNote', () => {
  it('returns null for an empty database', () => {
    expect(readLatestUserAccessForNote(stubCtx(), 'note_1')).toBeNull();
  });

  it('returns null for an empty note_id argument', () => {
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW, access_kind: 'user_open' });
    expect(readLatestUserAccessForNote(stubCtx(), '')).toBeNull();
  });

  it('returns the MAX accessed_at across user-driven kinds', () => {
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 10 * ONE_DAY, access_kind: 'user_open' });
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 3 * ONE_DAY, access_kind: 'user_edit' });
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 7 * ONE_DAY, access_kind: 'user_open' });
    expect(readLatestUserAccessForNote(stubCtx(), 'note_1')).toBe(NOW - 3 * ONE_DAY);
  });

  it('excludes non-user kinds (ai_packet_inclusion / recipe_query / mcp_read)', () => {
    // 10 AI / recipe / MCP reads at NOW — all excluded.
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW, access_kind: 'ai_packet_inclusion' });
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW, access_kind: 'recipe_query' });
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW, access_kind: 'mcp_read' });
    expect(readLatestUserAccessForNote(stubCtx(), 'note_1')).toBeNull();
  });

  it('returns the user-driven max even when AI reads are newer (feedback-loop guard)', () => {
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 30 * ONE_DAY, access_kind: 'user_open' });
    // AI surfaced this note 5 days ago — must NOT count as freshness.
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 5 * ONE_DAY, access_kind: 'ai_packet_inclusion' });
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 2 * ONE_DAY, access_kind: 'mcp_read' });
    expect(readLatestUserAccessForNote(stubCtx(), 'note_1')).toBe(NOW - 30 * ONE_DAY);
  });

  it('strict note_id filter — note_1 + note_2 entries stay independent', () => {
    insertLedgerEntry({ note_id: 'note_1', accessed_at: NOW - 10 * ONE_DAY, access_kind: 'user_open' });
    insertLedgerEntry({ note_id: 'note_2', accessed_at: NOW - 1 * ONE_DAY, access_kind: 'user_open' });
    expect(readLatestUserAccessForNote(stubCtx(), 'note_1')).toBe(NOW - 10 * ONE_DAY);
    expect(readLatestUserAccessForNote(stubCtx(), 'note_2')).toBe(NOW - ONE_DAY);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — emission paths
// ────────────────────────────────────────────────────────────────

describe('noteRelevanceDecayProducer.produce', () => {
  it('returns null when source_record.id is empty', async () => {
    const out = await noteRelevanceDecayProducer.produce(
      stubCtx(),
      sourceFor(fakeNote({ id: '' })),
    );
    expect(out).toBeNull();
  });

  it('bootstraps from last_user_action_at when the ledger has no user-driven entries', async () => {
    // Fresh note created 30 days ago, never opened via the ledger.
    const note = fakeNote({ id: 'note_fresh', last_user_action_at: NOW - 30 * ONE_DAY });
    const value = await expectValue(stubCtx(), note);
    // 30d elapsed on a 180d window → 1 - 30/180 ≈ 0.8333
    expect(value.decay_score).toBeCloseTo(1 - 30 / 180, 10);
    // last_access_at preserves the "never accessed via ledger" signal.
    expect(value.last_access_at).toBeNull();
    expect(value.computed_at).toBe(NOW);
  });

  it('uses ledger entries when newer than last_user_action_at', async () => {
    // Note created 90d ago + opened via ledger 10d ago.
    const note = fakeNote({ id: 'note_open', last_user_action_at: NOW - 90 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_open', accessed_at: NOW - 10 * ONE_DAY, access_kind: 'user_open' });
    const value = await expectValue(stubCtx(), note);
    // 10d elapsed → 1 - 10/180 ≈ 0.9444
    expect(value.decay_score).toBeCloseTo(1 - 10 / 180, 10);
    expect(value.last_access_at).toBe(NOW - 10 * ONE_DAY);
  });

  it('uses last_user_action_at when newer than a stale ledger entry', async () => {
    // Ledger entry from 100d ago; user explicitly edited 5d ago (bumps
    // canonical row but not necessarily ledger if the edit didn't write
    // a ledger entry — defensive against future write-path divergence).
    const note = fakeNote({ id: 'note_edit', last_user_action_at: NOW - 5 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_edit', accessed_at: NOW - 100 * ONE_DAY, access_kind: 'user_open' });
    const value = await expectValue(stubCtx(), note);
    // Score uses MAX(ledger, last_user_action_at) = 5d ago → ≈ 0.9722
    expect(value.decay_score).toBeCloseTo(1 - 5 / 180, 10);
    // last_access_at still reflects the actual ledger MAX (not the bootstrap fallback).
    expect(value.last_access_at).toBe(NOW - 100 * ONE_DAY);
  });

  it('feedback-loop guard: AI/recipe/MCP access does NOT bump freshness', async () => {
    // Note last opened by the user 100d ago, then surfaced via AI / MCP
    // many times in the last 10d. Decay must reflect the user-driven
    // freshness only — § A.1.2 explicitly warns about the runaway-
    // personalization loop.
    const note = fakeNote({ id: 'note_ai', last_user_action_at: NOW - 100 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_ai', accessed_at: NOW - 100 * ONE_DAY, access_kind: 'user_open' });
    for (let i = 0; i < 20; i += 1) {
      insertLedgerEntry({
        note_id: 'note_ai',
        accessed_at: NOW - i * 60_000,
        access_kind: i % 2 === 0 ? 'ai_packet_inclusion' : 'mcp_read',
      });
    }
    const value = await expectValue(stubCtx(), note);
    // 100d elapsed on a 180d window → 1 - 100/180 ≈ 0.4444
    expect(value.decay_score).toBeCloseTo(1 - 100 / 180, 10);
    expect(value.last_access_at).toBe(NOW - 100 * ONE_DAY);
  });

  it('emits decay_score = 0 when both signals are past the window edge (still records the row)', async () => {
    // Note created 200d ago, no ledger entries — past the 180d window.
    const note = fakeNote({
      id: 'note_stale',
      last_user_action_at: NOW - 200 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), note);
    expect(value.decay_score).toBe(0);
    expect(value.last_access_at).toBeNull();
    // Row is emitted (not null) so consumers see "computed, fully decayed"
    // distinct from "never computed" (row absent).
  });

  it('emits decay_score = 1 for a just-created note (last_user_action_at = now)', async () => {
    const note = fakeNote({ id: 'note_new', last_user_action_at: NOW });
    const value = await expectValue(stubCtx(), note);
    expect(value.decay_score).toBe(1);
    expect(value.last_access_at).toBeNull();
  });

  it('emits decay_score = 1 for a fresh user_open ledger entry', async () => {
    const note = fakeNote({ id: 'note_hot', last_user_action_at: NOW - 30 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_hot', accessed_at: NOW, access_kind: 'user_open' });
    const value = await expectValue(stubCtx(), note);
    expect(value.decay_score).toBe(1);
    expect(value.last_access_at).toBe(NOW);
  });

  it('uses ctx.now() for computed_at so the harness clock determines staleness', async () => {
    const note = fakeNote({ id: 'note_clock', last_user_action_at: NOW - 10 * ONE_DAY });
    const later = NOW + 12 * 3_600_000;
    const value = await expectValue(stubCtx(later), note);
    expect(value.computed_at).toBe(later);
  });

  it('per-note scope — note_a + note_b get independent scores off the same warehouse', async () => {
    const noteA = fakeNote({ id: 'note_a', last_user_action_at: NOW - 30 * ONE_DAY });
    const noteB = fakeNote({ id: 'note_b', last_user_action_at: NOW - 150 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_a', accessed_at: NOW - 5 * ONE_DAY, access_kind: 'user_open' });
    // note_b has no ledger entries.
    const valueA = await expectValue(stubCtx(), noteA);
    const valueB = await expectValue(stubCtx(), noteB);
    expect(valueA.decay_score).toBeCloseTo(1 - 5 / 180, 10);
    expect(valueA.last_access_at).toBe(NOW - 5 * ONE_DAY);
    expect(valueB.decay_score).toBeCloseTo(1 - 150 / 180, 10);
    expect(valueB.last_access_at).toBeNull();
  });

  it('user_edit entry counts the same as user_open (both are user-driven)', async () => {
    const note = fakeNote({ id: 'note_edit_only', last_user_action_at: NOW - 30 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_edit_only', accessed_at: NOW - ONE_DAY, access_kind: 'user_edit' });
    const value = await expectValue(stubCtx(), note);
    expect(value.decay_score).toBeCloseTo(1 - 1 / 180, 10);
    expect(value.last_access_at).toBe(NOW - ONE_DAY);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('note_relevance_decay registry round-trip', () => {
  it('registry topic exists with per_record shape + note scope + housekeeping producer_kind', () => {
    const def = ENRICHMENT_REGISTRY.note_relevance_decay;
    expect(def).toBeDefined();
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['note']);
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.recompute_cadence).toBe('7d');
  });

  it('registry aggregates_from includes note so cascade fires on data.note row updates', () => {
    const def = ENRICHMENT_REGISTRY.note_relevance_decay;
    // `aggregates_from` carries the cascade-walker scope (`note`) only;
    // the declaration's `operates_on` widens to include the server-
    // internal `note_access_ledger` — see registry comment at 5970-5976.
    expect(def.aggregates_from).toEqual(['note']);
  });

  it('value_schema accepts a producer-emitted decided payload (last_access_at populated)', async () => {
    const note = fakeNote({ id: 'note_x', last_user_action_at: NOW - 30 * ONE_DAY });
    insertLedgerEntry({ note_id: 'note_x', accessed_at: NOW - 10 * ONE_DAY, access_kind: 'user_open' });
    const value = await expectValue(stubCtx(), note);
    const def = ENRICHMENT_REGISTRY.note_relevance_decay as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(value).ok).toBe(true);
  });

  it('value_schema accepts a producer-emitted bootstrap payload (last_access_at null)', async () => {
    const note = fakeNote({ id: 'note_y', last_user_action_at: NOW - 30 * ONE_DAY });
    const value = await expectValue(stubCtx(), note);
    expect(value.last_access_at).toBeNull();
    const def = ENRICHMENT_REGISTRY.note_relevance_decay as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    expect(def.value_schema(value).ok).toBe(true);
  });
});
