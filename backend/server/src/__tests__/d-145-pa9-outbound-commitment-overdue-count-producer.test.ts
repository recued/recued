/** D-145 PA9 — `outbound_commitment_overdue_count` producer tests.
 *
 *  Second D-145 PA9 producer impl. Covers:
 *    - Producer surface contract (topic / scope / token estimate / cadence /
 *      scope_read_declaration)
 *    - countOutboundCommitmentsForContact pure SQL helper (direction
 *      filter, lifecycle_state filter, due_status filter,
 *      counterparty_contact_id filter, deleted_at filter,
 *      oldest_overdue_at math)
 *    - produce() integration: sample-floor abstention (no outbound
 *      pending), zero-overdue-but-pending emission, single-overdue,
 *      multi-overdue with oldest_overdue_at, direction crosstalk,
 *      lifecycle crosstalk, counterparty crosstalk, tombstone exclusion
 *    - Registry value_schema acceptance round-trip
 *    - Registry shape / cadence / scope alignment */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ContactRecord,
  type OutboundCommitmentOverdueCountValue,
} from '@recued/contracts';

import {
  countOutboundCommitmentsForContact,
  outboundCommitmentOverdueCountProducer,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { COMMITMENT_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-ococ-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal commitment table — mirrors the columns the producer reads.
  // The full schema (source_row identity columns, indices, etc.) lives
  // in `ensureWorkEntitySchema`; tests pull only what the producer
  // queries so the fixture stays focused.
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                          TEXT PRIMARY KEY,
      direction                   TEXT NOT NULL,
      statement                   TEXT NOT NULL,
      promised_at                 INTEGER NOT NULL,
      promised_for_at             INTEGER,
      lifecycle_state             TEXT NOT NULL DEFAULT 'pending',
      due_status                  TEXT NOT NULL DEFAULT 'no_deadline',
      counterparty_contact_id     TEXT,
      deleted_at                  INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CommitmentRow {
  id: string;
  direction: 'outbound' | 'inbound' | 'internal';
  lifecycle_state?: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  due_status?: 'not_due' | 'due_soon' | 'overdue' | 'no_deadline';
  counterparty_contact_id?: string | null;
  promised_for_at?: number | null;
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE} (
       id, direction, statement, promised_at, promised_for_at,
       lifecycle_state, due_status, counterparty_contact_id, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.direction,
    `Statement for ${row.id}`,
    NOW - 10 * ONE_DAY,
    row.promised_for_at ?? null,
    row.lifecycle_state ?? 'pending',
    row.due_status ?? 'overdue',
    row.counterparty_contact_id ?? null,
    row.deleted_at ?? null,
  );
};

const stubCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

const fakeContact = (email: string, overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  _id: email,
  _collection: 'contact',
  email,
  first_seen: NOW - 180 * ONE_DAY,
  last_interaction: NOW,
  interaction_count: 1,
  source: 'email_from',
  created_at: NOW - 180 * ONE_DAY,
  updated_at: NOW,
  ...overrides,
});

const sourceFor = (
  email: string,
  overrides: Partial<ContactRecord> = {},
): SourceRecord<ContactRecord> => ({
  target_id: email,
  data: fakeContact(email, overrides),
  cursor_token: email,
});

const expectValue = async (
  ctx: HousekeepingContext,
  email: string,
): Promise<OutboundCommitmentOverdueCountValue> => {
  const out = await outboundCommitmentOverdueCountProducer.produce(ctx, sourceFor(email));
  if (out === null) throw new Error(`expected producer output for ${email}, got null`);
  return out.value as OutboundCommitmentOverdueCountValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('outboundCommitmentOverdueCountProducer surface contract', () => {
  it('targets the outbound_commitment_overdue_count registry topic', () => {
    expect(outboundCommitmentOverdueCountProducer.topic).toBe(
      'outbound_commitment_overdue_count',
    );
  });

  it('targets the contact source scope', () => {
    expect(outboundCommitmentOverdueCountProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(outboundCommitmentOverdueCountProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(outboundCommitmentOverdueCountProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(outboundCommitmentOverdueCountProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for data.contact + data.commitment with the load-bearing fields', () => {
    const decls = outboundCommitmentOverdueCountProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual(['data.contact', 'data.commitment']);
    const commitmentEntry = decls.find((e) => e.collection === 'data.commitment')!;
    expect(commitmentEntry.sample_field_paths).toEqual([
      'direction',
      'lifecycle_state',
      'due_status',
      'counterparty_contact_id',
      'promised_for_at',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// countOutboundCommitmentsForContact — pure SQL helper
// ────────────────────────────────────────────────────────────────

describe('countOutboundCommitmentsForContact', () => {
  it('returns zero counts for an empty database', () => {
    const ctx = stubCtx();
    const row = countOutboundCommitmentsForContact(ctx, 'alice@example.com');
    expect(row).toEqual({
      outbound_pending_count: 0,
      overdue_count: 0,
      oldest_overdue_at: null,
    });
  });

  it('returns zero counts for an empty email argument', () => {
    insertCommitment({
      id: 'c1',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const row = countOutboundCommitmentsForContact(stubCtx(), '');
    expect(row.outbound_pending_count).toBe(0);
    expect(row.overdue_count).toBe(0);
    expect(row.oldest_overdue_at).toBeNull();
  });

  it('counts only outbound rows (inbound + internal excluded)', () => {
    insertCommitment({
      id: 'out',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'in',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'intern',
      direction: 'internal',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const row = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    expect(row.outbound_pending_count).toBe(1);
    expect(row.overdue_count).toBe(1);
  });

  it('counts only pending lifecycle rows (fulfilled / cancelled / expired excluded)', () => {
    for (const lifecycle of ['pending', 'fulfilled', 'cancelled', 'expired'] as const) {
      insertCommitment({
        id: `c_${lifecycle}`,
        direction: 'outbound',
        lifecycle_state: lifecycle,
        due_status: 'overdue',
        counterparty_contact_id: 'alice@example.com',
        promised_for_at: NOW - ONE_DAY,
      });
    }
    const row = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    expect(row.outbound_pending_count).toBe(1);
    expect(row.overdue_count).toBe(1);
  });

  it('counts only the matching counterparty (per-contact scope is strict)', () => {
    insertCommitment({
      id: 'a1',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'b1',
      direction: 'outbound',
      counterparty_contact_id: 'bob@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const aliceRow = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    const bobRow = countOutboundCommitmentsForContact(stubCtx(), 'bob@example.com');
    expect(aliceRow.outbound_pending_count).toBe(1);
    expect(aliceRow.overdue_count).toBe(1);
    expect(bobRow.outbound_pending_count).toBe(1);
    expect(bobRow.overdue_count).toBe(1);
  });

  it('separates the overdue subset from the sample population', () => {
    // 3 outbound pending: 1 overdue, 1 due_soon, 1 not_due.
    insertCommitment({
      id: 'overdue',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'due_soon',
      direction: 'outbound',
      due_status: 'due_soon',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW + 12 * 3_600_000,
    });
    insertCommitment({
      id: 'not_due',
      direction: 'outbound',
      due_status: 'not_due',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW + 5 * ONE_DAY,
    });
    const row = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    expect(row.outbound_pending_count).toBe(3);
    expect(row.overdue_count).toBe(1);
    expect(row.oldest_overdue_at).toBe(NOW - ONE_DAY);
  });

  it('returns oldest_overdue_at = min(promised_for_at) over the overdue rows', () => {
    insertCommitment({
      id: 'recent',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'oldest',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 30 * ONE_DAY,
    });
    insertCommitment({
      id: 'middle',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 10 * ONE_DAY,
    });
    const row = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    expect(row.overdue_count).toBe(3);
    expect(row.oldest_overdue_at).toBe(NOW - 30 * ONE_DAY);
  });

  it('excludes tombstoned rows (deleted_at IS NOT NULL)', () => {
    insertCommitment({
      id: 'live',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'tombstoned',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 2 * ONE_DAY,
      deleted_at: NOW - 100,
    });
    const row = countOutboundCommitmentsForContact(stubCtx(), 'alice@example.com');
    expect(row.outbound_pending_count).toBe(1);
    expect(row.overdue_count).toBe(1);
    expect(row.oldest_overdue_at).toBe(NOW - ONE_DAY);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — abstention paths
// ────────────────────────────────────────────────────────────────

describe('outboundCommitmentOverdueCountProducer.produce — abstention', () => {
  it('returns null when source_record.email is empty', async () => {
    const out = await outboundCommitmentOverdueCountProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when the contact has no outbound commitments at all', async () => {
    const out = await outboundCommitmentOverdueCountProducer.produce(
      stubCtx(),
      sourceFor('quiet@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when the only outbound commitments are inbound to this contact', async () => {
    // Direction crosstalk — `direction: 'inbound'` to alice doesn't count
    // as an outbound commitment to her.
    insertCommitment({
      id: 'in1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const out = await outboundCommitmentOverdueCountProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when the only outbound commitments have terminal lifecycle', async () => {
    // Lifecycle crosstalk — fulfilled / cancelled / expired commitments
    // don't anchor the signal.
    for (const lifecycle of ['fulfilled', 'cancelled', 'expired'] as const) {
      insertCommitment({
        id: `c_${lifecycle}`,
        direction: 'outbound',
        lifecycle_state: lifecycle,
        due_status: 'overdue',
        counterparty_contact_id: 'alice@example.com',
        promised_for_at: NOW - ONE_DAY,
      });
    }
    const out = await outboundCommitmentOverdueCountProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when outbound commitments target a different counterparty', async () => {
    insertCommitment({
      id: 'bob_only',
      direction: 'outbound',
      counterparty_contact_id: 'bob@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const out = await outboundCommitmentOverdueCountProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — emission outcomes
// ────────────────────────────────────────────────────────────────

describe('outboundCommitmentOverdueCountProducer.produce — emissions', () => {
  it('emits {count: 0, oldest_overdue_at: null} when outbound pending exist but none overdue', async () => {
    insertCommitment({
      id: 'not_due_only',
      direction: 'outbound',
      due_status: 'not_due',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW + 5 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.count).toBe(0);
    expect(value.oldest_overdue_at).toBeNull();
    expect(value.computed_at).toBe(NOW);
  });

  it('emits a single overdue count with its promised_for_at as oldest', async () => {
    insertCommitment({
      id: 'single',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 7 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.count).toBe(1);
    expect(value.oldest_overdue_at).toBe(NOW - 7 * ONE_DAY);
  });

  it('emits the full count + earliest oldest_overdue_at across multiple overdue rows', async () => {
    insertCommitment({
      id: 'overdue_recent',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 2 * ONE_DAY,
    });
    insertCommitment({
      id: 'overdue_old',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 60 * ONE_DAY,
    });
    insertCommitment({
      id: 'overdue_mid',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 20 * ONE_DAY,
    });
    // One non-overdue pending — counts toward sample floor but not the
    // overdue total.
    insertCommitment({
      id: 'still_due',
      direction: 'outbound',
      due_status: 'due_soon',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW + 12 * 3_600_000,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.count).toBe(3);
    expect(value.oldest_overdue_at).toBe(NOW - 60 * ONE_DAY);
  });

  it('uses ctx.now() for computed_at so the harness clock determines staleness', async () => {
    insertCommitment({
      id: 'single',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    const later = NOW + 12 * 3_600_000;
    const value = await expectValue(stubCtx(later), 'alice@example.com');
    expect(value.computed_at).toBe(later);
  });

  it('per-contact scope — alice + bob emit independent counts off the same warehouse', async () => {
    insertCommitment({
      id: 'a1',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'a2',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 3 * ONE_DAY,
    });
    insertCommitment({
      id: 'b1',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'bob@example.com',
      promised_for_at: NOW - 10 * ONE_DAY,
    });
    const alice = await expectValue(stubCtx(), 'alice@example.com');
    const bob = await expectValue(stubCtx(), 'bob@example.com');
    expect(alice.count).toBe(2);
    expect(alice.oldest_overdue_at).toBe(NOW - 3 * ONE_DAY);
    expect(bob.count).toBe(1);
    expect(bob.oldest_overdue_at).toBe(NOW - 10 * ONE_DAY);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('outbound_commitment_overdue_count registry round-trip', () => {
  it('registry topic exists with per_record shape + contact scope + housekeeping producer_kind', () => {
    const def = ENRICHMENT_REGISTRY.outbound_commitment_overdue_count;
    expect(def).toBeDefined();
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['contact']);
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.recompute_cadence).toBe('24h');
  });

  it('registry aggregates_from includes commitment so cascade fires on commitment.state_changed', () => {
    const def = ENRICHMENT_REGISTRY.outbound_commitment_overdue_count;
    expect(def.aggregates_from).toEqual(['commitment']);
  });

  it('value_schema accepts a producer-emitted payload (with overdue rows)', async () => {
    insertCommitment({
      id: 'single',
      direction: 'outbound',
      due_status: 'overdue',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW - 5 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    const def = ENRICHMENT_REGISTRY.outbound_commitment_overdue_count as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });

  it('value_schema accepts a producer-emitted payload (with zero overdue + non-overdue pending)', async () => {
    insertCommitment({
      id: 'pending_not_due',
      direction: 'outbound',
      due_status: 'not_due',
      counterparty_contact_id: 'alice@example.com',
      promised_for_at: NOW + 5 * ONE_DAY,
    });
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.count).toBe(0);
    expect(value.oldest_overdue_at).toBeNull();
    const def = ENRICHMENT_REGISTRY.outbound_commitment_overdue_count as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });
});
