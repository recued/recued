/** D-145 PA9 — `commitment_imbalance` producer tests.
 *
 *  Third D-145 PA9 producer impl. Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration)
 *    - decideCommitmentImbalanceSignal pure-function cases (sample
 *      floor, ratio thresholds at 1.5×, edge cases — one-side-zero /
 *      tie / negatives)
 *    - countCommitmentsByDirectionForContact pure SQL helper (direction
 *      filter excludes internal, 90d window on created_at, tombstone
 *      exclusion, lifecycle + due_status passed through unfiltered per
 *      spec line 285, counterparty filter is strict)
 *    - produce() integration: abstention on zero, insufficient_data
 *      below floor, inbound_heavy / outbound_heavy / aligned signal
 *      emissions, internal-direction exclusion, window edge
 *    - Registry value_schema acceptance round-trip
 *    - Registry shape + cadence + scope alignment */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type CommitmentImbalanceValue,
  type ContactRecord,
} from '@recued/contracts';

import {
  COMMITMENT_IMBALANCE_DOMINANT_RATIO,
  COMMITMENT_IMBALANCE_SAMPLE_FLOOR,
  COMMITMENT_IMBALANCE_WINDOW_MS,
  commitmentImbalanceProducer,
  countCommitmentsByDirectionForContact,
  decideCommitmentImbalanceSignal,
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
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-imb-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Minimal commitment table — mirrors the columns the producer reads.
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
      created_at                  INTEGER NOT NULL,
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
  created_at?: number;
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE} (
       id, direction, statement, promised_at, promised_for_at,
       lifecycle_state, due_status, counterparty_contact_id,
       created_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.direction,
    `Statement for ${row.id}`,
    NOW - 10 * ONE_DAY,
    null,
    row.lifecycle_state ?? 'pending',
    row.due_status ?? 'no_deadline',
    row.counterparty_contact_id ?? null,
    row.created_at ?? NOW - 30 * ONE_DAY,
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
): Promise<CommitmentImbalanceValue> => {
  const out = await commitmentImbalanceProducer.produce(ctx, sourceFor(email));
  if (out === null) throw new Error(`expected producer output for ${email}, got null`);
  return out.value as CommitmentImbalanceValue;
};

/** Helper: insert N commitments of one direction for a contact, all
 *  inside the 90d window (created_at within the last 30d). */
const seedDirection = (
  direction: 'inbound' | 'outbound' | 'internal',
  contact_email: string,
  n: number,
  prefix: string,
): void => {
  for (let i = 0; i < n; i += 1) {
    insertCommitment({
      id: `${prefix}${i}`,
      direction,
      counterparty_contact_id: contact_email,
      created_at: NOW - (i + 1) * ONE_DAY,
    });
  }
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('commitmentImbalanceProducer surface contract', () => {
  it('targets the commitment_imbalance registry topic', () => {
    expect(commitmentImbalanceProducer.topic).toBe('commitment_imbalance');
  });

  it('targets the contact source scope', () => {
    expect(commitmentImbalanceProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(commitmentImbalanceProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(commitmentImbalanceProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(commitmentImbalanceProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for data.contact + data.commitment with the load-bearing fields', () => {
    const decls = commitmentImbalanceProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual(['data.contact', 'data.commitment']);
    const commitmentEntry = decls.find((e) => e.collection === 'data.commitment')!;
    expect(commitmentEntry.sample_field_paths).toEqual([
      'direction',
      'counterparty_contact_id',
      'created_at',
    ]);
  });

  it('window constant matches the registry aggregate_window_ms (90d)', () => {
    expect(COMMITMENT_IMBALANCE_WINDOW_MS).toBe(90 * ONE_DAY);
    const def = ENRICHMENT_REGISTRY.commitment_imbalance as { aggregate_window_ms?: number };
    expect(def.aggregate_window_ms).toBe(COMMITMENT_IMBALANCE_WINDOW_MS);
  });

  it('sample floor constant matches the declaration (5)', () => {
    expect(COMMITMENT_IMBALANCE_SAMPLE_FLOOR).toBe(5);
  });

  it('dominant ratio mirrors D-139 inbound_outbound_ratio precedent (1.5×)', () => {
    expect(COMMITMENT_IMBALANCE_DOMINANT_RATIO).toBe(1.5);
  });
});

// ────────────────────────────────────────────────────────────────
// decideCommitmentImbalanceSignal pure-function cases
// ────────────────────────────────────────────────────────────────

describe('decideCommitmentImbalanceSignal', () => {
  it('returns insufficient_data when total is below the sample floor', () => {
    expect(decideCommitmentImbalanceSignal(0, 0)).toBe('insufficient_data');
    expect(decideCommitmentImbalanceSignal(1, 1)).toBe('insufficient_data');
    expect(decideCommitmentImbalanceSignal(2, 2)).toBe('insufficient_data'); // 4 < 5
    expect(decideCommitmentImbalanceSignal(4, 0)).toBe('insufficient_data'); // 4 < 5
  });

  it('clears the floor at exactly 5 combined commitments', () => {
    // 5/0 → outbound_heavy (5 > 1.5 × 0 = 0).
    expect(decideCommitmentImbalanceSignal(0, 5)).toBe('outbound_heavy');
    // 5/0 inbound → inbound_heavy.
    expect(decideCommitmentImbalanceSignal(5, 0)).toBe('inbound_heavy');
  });

  it('returns inbound_heavy when inbound exceeds 1.5× outbound', () => {
    expect(decideCommitmentImbalanceSignal(8, 3)).toBe('inbound_heavy'); // 8 > 4.5
    expect(decideCommitmentImbalanceSignal(12, 4)).toBe('inbound_heavy'); // 12 > 6
  });

  it('returns outbound_heavy when outbound exceeds 1.5× inbound', () => {
    expect(decideCommitmentImbalanceSignal(3, 8)).toBe('outbound_heavy');
    expect(decideCommitmentImbalanceSignal(4, 12)).toBe('outbound_heavy');
  });

  it('returns aligned when the split sits inside the ratio band', () => {
    expect(decideCommitmentImbalanceSignal(5, 5)).toBe('aligned');
    expect(decideCommitmentImbalanceSignal(6, 4)).toBe('aligned'); // 6 = 1.5×4, not strictly greater
    expect(decideCommitmentImbalanceSignal(4, 6)).toBe('aligned');
    expect(decideCommitmentImbalanceSignal(7, 5)).toBe('aligned'); // 7 < 7.5
  });

  it('treats an exact ratio match as aligned (strict-inequality test)', () => {
    // 6 == 1.5×4 — must NOT trip outbound_heavy because the test is `>`,
    // not `>=`. Mirrors `decidePreferredChannel`'s strict-majority discipline.
    expect(decideCommitmentImbalanceSignal(4, 6)).toBe('aligned');
    expect(decideCommitmentImbalanceSignal(6, 4)).toBe('aligned');
  });

  it('respects caller-supplied sample floor + ratio', () => {
    // Floor 11 — total 10 strictly below it.
    expect(decideCommitmentImbalanceSignal(5, 5, 11)).toBe('insufficient_data');
    // Floor 10 — total 10 clears (the floor test is strict `<`, not `<=`).
    expect(decideCommitmentImbalanceSignal(5, 5, 10)).toBe('aligned');
    // Ratio 2 — 8/5 stays aligned (8 < 10); ratio 1.5 would flip
    // outbound_heavy (8 > 7.5).
    expect(decideCommitmentImbalanceSignal(5, 8, undefined, 2)).toBe('aligned');
    expect(decideCommitmentImbalanceSignal(5, 8, undefined, 1.5)).toBe('outbound_heavy');
  });

  it('coerces negative + non-finite counts to zero defensively', () => {
    expect(decideCommitmentImbalanceSignal(-3, 10)).toBe('outbound_heavy');
    expect(decideCommitmentImbalanceSignal(10, Number.NaN)).toBe('inbound_heavy');
    expect(decideCommitmentImbalanceSignal(Number.NEGATIVE_INFINITY, 0)).toBe(
      'insufficient_data',
    );
  });
});

// ────────────────────────────────────────────────────────────────
// countCommitmentsByDirectionForContact — pure SQL helper
// ────────────────────────────────────────────────────────────────

describe('countCommitmentsByDirectionForContact', () => {
  const since = NOW - COMMITMENT_IMBALANCE_WINDOW_MS;

  it('returns zero counts for an empty database', () => {
    expect(countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW))
      .toEqual({ inbound_count: 0, outbound_count: 0 });
  });

  it('returns zero counts for an empty email argument', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
    });
    const row = countCommitmentsByDirectionForContact(stubCtx(), '', since, NOW);
    expect(row).toEqual({ inbound_count: 0, outbound_count: 0 });
  });

  it('counts inbound vs outbound separately', () => {
    seedDirection('inbound', 'alice@example.com', 3, 'in_');
    seedDirection('outbound', 'alice@example.com', 5, 'out_');
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    expect(row).toEqual({ inbound_count: 3, outbound_count: 5 });
  });

  it('excludes internal direction (does not skew the relationship signal)', () => {
    seedDirection('inbound', 'alice@example.com', 3, 'in_');
    seedDirection('internal', 'alice@example.com', 10, 'self_');
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    expect(row).toEqual({ inbound_count: 3, outbound_count: 0 });
  });

  it('passes lifecycle_state and due_status through unfiltered (spec line 285: "both axes considered")', () => {
    for (const lifecycle of ['pending', 'fulfilled', 'cancelled', 'expired'] as const) {
      insertCommitment({
        id: `in_${lifecycle}`,
        direction: 'inbound',
        lifecycle_state: lifecycle,
        counterparty_contact_id: 'alice@example.com',
        created_at: NOW - 10 * ONE_DAY,
      });
    }
    for (const due of ['not_due', 'due_soon', 'overdue', 'no_deadline'] as const) {
      insertCommitment({
        id: `out_${due}`,
        direction: 'outbound',
        due_status: due,
        counterparty_contact_id: 'alice@example.com',
        created_at: NOW - 10 * ONE_DAY,
      });
    }
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    expect(row).toEqual({ inbound_count: 4, outbound_count: 4 });
  });

  it('strict counterparty filter — alice + bob counts independent', () => {
    seedDirection('inbound', 'alice@example.com', 2, 'a_in_');
    seedDirection('outbound', 'alice@example.com', 3, 'a_out_');
    seedDirection('inbound', 'bob@example.com', 5, 'b_in_');
    const aliceRow = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    const bobRow = countCommitmentsByDirectionForContact(stubCtx(), 'bob@example.com', since, NOW);
    expect(aliceRow).toEqual({ inbound_count: 2, outbound_count: 3 });
    expect(bobRow).toEqual({ inbound_count: 5, outbound_count: 0 });
  });

  it('excludes rows whose created_at falls outside the window', () => {
    // 3 in-window inbound, 5 out-of-window inbound.
    seedDirection('inbound', 'alice@example.com', 3, 'in_');
    for (let i = 0; i < 5; i += 1) {
      insertCommitment({
        id: `old_${i}`,
        direction: 'inbound',
        counterparty_contact_id: 'alice@example.com',
        created_at: NOW - (95 + i) * ONE_DAY,
      });
    }
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    expect(row.inbound_count).toBe(3);
  });

  it('excludes tombstoned rows (deleted_at IS NOT NULL)', () => {
    insertCommitment({
      id: 'live',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      created_at: NOW - ONE_DAY,
    });
    insertCommitment({
      id: 'tombstoned',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      created_at: NOW - 2 * ONE_DAY,
      deleted_at: NOW - 100,
    });
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    expect(row).toEqual({ inbound_count: 1, outbound_count: 0 });
  });

  it('window edge: created_at = since is inside, created_at = now is outside', () => {
    insertCommitment({
      id: 'at_since',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      created_at: since,
    });
    insertCommitment({
      id: 'at_now',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      created_at: NOW,
    });
    const row = countCommitmentsByDirectionForContact(stubCtx(), 'alice@example.com', since, NOW);
    // `created_at >= since AND created_at < now` — half-open interval.
    expect(row.inbound_count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() — abstention + emission paths
// ────────────────────────────────────────────────────────────────

describe('commitmentImbalanceProducer.produce — abstention', () => {
  it('returns null when source_record.email is empty', async () => {
    const out = await commitmentImbalanceProducer.produce(
      stubCtx(),
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
  });

  it('returns null when the contact has zero cross-party commitments in window', async () => {
    const out = await commitmentImbalanceProducer.produce(
      stubCtx(),
      sourceFor('quiet@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when the only commitments are internal (self-promises)', async () => {
    seedDirection('internal', 'alice@example.com', 10, 'self_');
    const out = await commitmentImbalanceProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when all in-window commitments belong to a different counterparty', async () => {
    seedDirection('inbound', 'bob@example.com', 10, 'b_in_');
    const out = await commitmentImbalanceProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });

  it('returns null when all commitments are outside the 90-day window', async () => {
    for (let i = 0; i < 10; i += 1) {
      insertCommitment({
        id: `old_${i}`,
        direction: 'inbound',
        counterparty_contact_id: 'alice@example.com',
        created_at: NOW - (95 + i) * ONE_DAY,
      });
    }
    const out = await commitmentImbalanceProducer.produce(
      stubCtx(),
      sourceFor('alice@example.com'),
    );
    expect(out).toBeNull();
  });
});

describe('commitmentImbalanceProducer.produce — emissions', () => {
  it('emits insufficient_data when 0 < total < sample_floor', async () => {
    seedDirection('inbound', 'alice@example.com', 1, 'in_');
    seedDirection('outbound', 'alice@example.com', 2, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('insufficient_data');
    expect(value.inbound_count).toBe(1);
    expect(value.outbound_count).toBe(2);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits inbound_heavy when this contact promises far more than the user does back', async () => {
    seedDirection('inbound', 'alice@example.com', 12, 'in_');
    seedDirection('outbound', 'alice@example.com', 3, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('inbound_heavy');
    expect(value.inbound_count).toBe(12);
    expect(value.outbound_count).toBe(3);
  });

  it('emits outbound_heavy when the user promises far more than this contact does back', async () => {
    seedDirection('inbound', 'alice@example.com', 2, 'in_');
    seedDirection('outbound', 'alice@example.com', 10, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('outbound_heavy');
    expect(value.inbound_count).toBe(2);
    expect(value.outbound_count).toBe(10);
  });

  it('emits aligned when the split sits inside the 1.5× band', async () => {
    seedDirection('inbound', 'alice@example.com', 6, 'in_');
    seedDirection('outbound', 'alice@example.com', 5, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('aligned');
    expect(value.inbound_count).toBe(6);
    expect(value.outbound_count).toBe(5);
  });

  it('emits inbound_heavy when outbound is zero but inbound clears the floor', async () => {
    seedDirection('inbound', 'alice@example.com', 5, 'in_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('inbound_heavy');
    expect(value.inbound_count).toBe(5);
    expect(value.outbound_count).toBe(0);
  });

  it('excludes internal commitments from the imbalance math while still counting cross-party', async () => {
    seedDirection('inbound', 'alice@example.com', 6, 'in_');
    seedDirection('outbound', 'alice@example.com', 5, 'out_');
    // 20 internal commitments — must not skew the count.
    seedDirection('internal', 'alice@example.com', 20, 'self_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.inbound_count).toBe(6);
    expect(value.outbound_count).toBe(5);
    expect(value.imbalance_signal).toBe('aligned');
  });

  it('uses ctx.now() for computed_at so the harness clock determines staleness', async () => {
    seedDirection('inbound', 'alice@example.com', 6, 'in_');
    seedDirection('outbound', 'alice@example.com', 5, 'out_');
    const later = NOW + 12 * 3_600_000;
    const value = await expectValue(stubCtx(later), 'alice@example.com');
    expect(value.computed_at).toBe(later);
  });

  it('per-contact scope — alice + bob get independent signals off the same warehouse', async () => {
    seedDirection('inbound', 'alice@example.com', 12, 'a_in_');
    seedDirection('outbound', 'alice@example.com', 3, 'a_out_');
    seedDirection('outbound', 'bob@example.com', 10, 'b_out_');
    seedDirection('inbound', 'bob@example.com', 2, 'b_in_');
    const alice = await expectValue(stubCtx(), 'alice@example.com');
    const bob = await expectValue(stubCtx(), 'bob@example.com');
    expect(alice.imbalance_signal).toBe('inbound_heavy');
    expect(bob.imbalance_signal).toBe('outbound_heavy');
  });
});

// ────────────────────────────────────────────────────────────────
// Registry round-trip
// ────────────────────────────────────────────────────────────────

describe('commitment_imbalance registry round-trip', () => {
  it('registry topic exists with per_record shape + contact scope + housekeeping producer_kind', () => {
    const def = ENRICHMENT_REGISTRY.commitment_imbalance;
    expect(def).toBeDefined();
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['contact']);
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.recompute_cadence).toBe('24h');
  });

  it('registry aggregates_from includes commitment so cascade fires on commitment.state_changed', () => {
    const def = ENRICHMENT_REGISTRY.commitment_imbalance;
    expect(def.aggregates_from).toEqual(['commitment']);
  });

  it('value_schema accepts a producer-emitted decided payload', async () => {
    seedDirection('inbound', 'alice@example.com', 12, 'in_');
    seedDirection('outbound', 'alice@example.com', 3, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    const def = ENRICHMENT_REGISTRY.commitment_imbalance as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });

  it('value_schema accepts a producer-emitted insufficient_data payload', async () => {
    seedDirection('inbound', 'alice@example.com', 1, 'in_');
    seedDirection('outbound', 'alice@example.com', 2, 'out_');
    const value = await expectValue(stubCtx(), 'alice@example.com');
    expect(value.imbalance_signal).toBe('insufficient_data');
    const def = ENRICHMENT_REGISTRY.commitment_imbalance as {
      value_schema: (input: unknown) => { ok: boolean };
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });
});
