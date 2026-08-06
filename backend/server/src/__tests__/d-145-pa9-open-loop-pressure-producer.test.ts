/** D-145 PA9 — `open_loop_pressure` producer tests (per-contact v1).
 *
 *  Tenth D-145 PA9 producer impl + sixth per-record producer on
 *  `walker_kind: 'contact'`. First three-source cross-entity reader
 *  (commitments + tasks + mails). Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration four-collection shape)
 *    - Producer-kind alignment (declaration + registry both
 *      'housekeeping', valid_scopes preserved as ['contact', 'project']
 *      for per-project follow-on slice)
 *    - computeAgeDays pure cases (zero / negative / non-finite)
 *    - computePressureScore pure cases (saturation cap, non-finite
 *      defensiveness)
 *    - aggregateOpenCommitmentsForContact SQL (direction filter,
 *      lifecycle filter, tombstone exclusion, empty-id short-circuit,
 *      age weighting)
 *    - aggregateOpenTasksForContact SQL (done filter, assigned filter,
 *      tombstone exclusion, age weighting)
 *    - aggregateUnreadMailsForContact SQL (cross-table scan, is_read
 *      filter, canonical address narrow, age weighting, missing is_read
 *      treated as unread)
 *    - produce() integration: sample-floor abstention (zero open),
 *      mixed three-source fold, pressure-score saturation
 *    - Registry value_schema acceptance round-trip */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  OPEN_LOOP_PRESSURE_DECLARATION,
  type ContactRecord,
  type OpenLoopPressureValue,
} from '@recued/contracts';

import {
  aggregateOpenCommitmentsForContact,
  aggregateOpenTasksForContact,
  aggregateUnreadMailsForContact,
  computeAgeDays,
  computePressureScore,
  openLoopPressureProducer,
  OPEN_LOOP_PRESSURE_SATURATION_DAYS,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import { COMMITMENT_TABLE, TASK_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const MAIL_TABLE_PRIMARY = 'collection_mail_33333333cc';
const MAIL_TABLE_SECONDARY = 'collection_mail_44444444dd';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-pressure-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const createMailTable = (name: string): void => {
    db.exec(`
      CREATE TABLE ${name} (
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
  };
  createMailTable(MAIL_TABLE_PRIMARY);
  createMailTable(MAIL_TABLE_SECONDARY);
  // Minimal commitment table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${COMMITMENT_TABLE} (
      id                       TEXT PRIMARY KEY,
      direction                TEXT NOT NULL,
      lifecycle_state          TEXT NOT NULL DEFAULT 'pending',
      counterparty_contact_id  TEXT,
      state_changed_at         INTEGER NOT NULL,
      sync_state               TEXT NOT NULL DEFAULT 'live',
      deleted_at               INTEGER
    );
  `);
  // Minimal task table — only the columns the producer reads.
  db.exec(`
    CREATE TABLE ${TASK_TABLE} (
      id                   TEXT PRIMARY KEY,
      assigned_contact_id  TEXT,
      done                 INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL,
      sync_state           TEXT NOT NULL DEFAULT 'live',
      deleted_at           INTEGER
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface CommitmentRow {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  lifecycle_state?: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  counterparty_contact_id?: string | null;
  state_changed_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertCommitment = (row: CommitmentRow): void => {
  db.prepare(
    `INSERT INTO ${COMMITMENT_TABLE}
       (id, direction, lifecycle_state, counterparty_contact_id, state_changed_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.direction,
    row.lifecycle_state ?? 'pending',
    row.counterparty_contact_id ?? null,
    row.state_changed_at ?? NOW,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

interface TaskRow {
  id: string;
  assigned_contact_id?: string | null;
  done?: 0 | 1;
  updated_at?: number;
  sync_state?: 'live' | 'stale_unreachable' | 'tombstoned';
  deleted_at?: number | null;
}

const insertTask = (row: TaskRow): void => {
  db.prepare(
    `INSERT INTO ${TASK_TABLE}
       (id, assigned_contact_id, done, updated_at, sync_state, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.assigned_contact_id ?? null,
    row.done ?? 0,
    row.updated_at ?? NOW,
    row.sync_state ?? 'live',
    row.deleted_at ?? null,
  );
};

const insertMail = (
  table: string,
  record_id: string,
  hot: Record<string, unknown>,
  received_at = NOW,
): void => {
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(record_id, received_at, received_at, JSON.stringify(hot), 100, record_id);
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

const fakeContact = (email: string): ContactRecord => ({
  _id: email,
  _collection: 'contact',
  email,
  first_seen: NOW - 365 * DAY,
  last_interaction: NOW - DAY,
  interaction_count: 1,
  source: 'email_from',
  created_at: NOW - 365 * DAY,
  updated_at: NOW - DAY,
});

const sourceFor = (contact: ContactRecord): SourceRecord<ContactRecord> => ({
  target_id: contact.email,
  data: contact,
  cursor_token: contact.email,
});

const expectValue = async (
  ctx: HousekeepingContext,
  contact: ContactRecord,
): Promise<OpenLoopPressureValue> => {
  const out = await openLoopPressureProducer.produce(ctx, sourceFor(contact));
  if (out === null) throw new Error(`expected producer output for ${contact.email}, got null`);
  return out.value as OpenLoopPressureValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('openLoopPressureProducer surface contract', () => {
  it('targets the open_loop_pressure registry topic', () => {
    expect(openLoopPressureProducer.topic).toBe('open_loop_pressure');
  });

  it('targets the contact source scope (per-contact v1)', () => {
    expect(openLoopPressureProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(openLoopPressureProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(openLoopPressureProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(openLoopPressureProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for contact + commitment + task + mail with the load-bearing fields', () => {
    const decls = openLoopPressureProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.contact',
      'data.commitment',
      'data.task',
      'data.mail',
    ]);
    expect(decls.find((e) => e.collection === 'data.commitment')!.sample_field_paths).toEqual([
      'counterparty_contact_id',
      'lifecycle_state',
      'direction',
      'state_changed_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.task')!.sample_field_paths).toEqual([
      'assigned_contact_id',
      'done',
      'updated_at',
    ]);
    expect(decls.find((e) => e.collection === 'data.mail')!.sample_field_paths).toEqual([
      'from',
      'to',
      'cc',
      'is_read',
      'received_at',
    ]);
  });

  it('exposes the 60-day saturation cap constant', () => {
    expect(OPEN_LOOP_PRESSURE_SATURATION_DAYS).toBe(60);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer-kind alignment + dual-scope reservation
// ────────────────────────────────────────────────────────────────

describe('producer_kind alignment + dual-scope reservation', () => {
  it('declaration carries producer_kind: "housekeeping"', () => {
    expect(OPEN_LOOP_PRESSURE_DECLARATION.producer_kind).toBe('housekeeping');
  });

  it('registry entry carries producer_kind: "housekeeping" so buildEnrichmentProducerTask accepts it', () => {
    expect(ENRICHMENT_REGISTRY.open_loop_pressure.producer_kind).toBe('housekeeping');
  });

  it('registry valid_scopes: ["contact", "project"] backs both scope-keyed producers', () => {
    // Per-contact (this test file) + per-project (companion file
    // `d-145-pa9-open-loop-pressure-project-producer.test.ts`) both
    // ride the multi-scope task-id substrate; the registry's
    // `valid_scopes` enumerates the supported scopes that
    // `buildEnrichmentProducerTask` validates against at construction.
    expect(ENRICHMENT_REGISTRY.open_loop_pressure.valid_scopes).toEqual(['contact', 'project']);
  });
});

// ────────────────────────────────────────────────────────────────
// computeAgeDays pure cases
// ────────────────────────────────────────────────────────────────

describe('computeAgeDays', () => {
  it('returns elapsed days for a past timestamp', () => {
    expect(computeAgeDays(NOW - 10 * DAY, NOW)).toBeCloseTo(10, 10);
  });

  it('returns 0 for a future timestamp (clock-skew defensive)', () => {
    expect(computeAgeDays(NOW + DAY, NOW)).toBe(0);
  });

  it('returns 0 for the present moment', () => {
    expect(computeAgeDays(NOW, NOW)).toBe(0);
  });

  it('returns 0 for non-finite input', () => {
    expect(computeAgeDays(Number.NaN, NOW)).toBe(0);
    expect(computeAgeDays(NOW, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// computePressureScore pure cases
// ────────────────────────────────────────────────────────────────

describe('computePressureScore', () => {
  it('returns 0 for 0 age-weighted score', () => {
    expect(computePressureScore(0)).toBe(0);
  });

  it('returns proportional score below saturation', () => {
    expect(computePressureScore(30)).toBeCloseTo(0.5, 10); // 30d / 60d
  });

  it('clamps to 1 at saturation', () => {
    expect(computePressureScore(60)).toBe(1);
  });

  it('clamps to 1 above saturation', () => {
    expect(computePressureScore(120)).toBe(1);
  });

  it('returns 0 for negative score (defensive)', () => {
    expect(computePressureScore(-5)).toBe(0);
  });

  it('returns 0 for non-finite score (NaN defensiveness)', () => {
    expect(computePressureScore(Number.NaN)).toBe(0);
  });

  it('honours custom saturation_days override', () => {
    expect(computePressureScore(30, 30)).toBe(1); // 30d / 30d cap
    expect(computePressureScore(15, 30)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for non-positive saturation_days', () => {
    expect(computePressureScore(30, 0)).toBe(0);
    expect(computePressureScore(30, -1)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// aggregateOpenCommitmentsForContact SQL
// ────────────────────────────────────────────────────────────────

describe('aggregateOpenCommitmentsForContact', () => {
  it('returns zero aggregate for an empty contact email', () => {
    expect(aggregateOpenCommitmentsForContact(stubCtx(), '', NOW)).toEqual({
      count: 0,
      age_weighted: 0,
    });
  });

  it('counts open inbound + outbound commitments to this contact', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 5 * DAY,
    });
    insertCommitment({
      id: 'c2',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 10 * DAY,
    });
    const agg = aggregateOpenCommitmentsForContact(stubCtx(), 'alice@example.com', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(15, 5);
  });

  it('excludes internal-direction commitments', () => {
    insertCommitment({
      id: 'c1',
      direction: 'internal',
      counterparty_contact_id: 'alice@example.com',
    });
    expect(aggregateOpenCommitmentsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('excludes non-pending lifecycle states', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
    });
    insertCommitment({
      id: 'c2',
      direction: 'outbound',
      lifecycle_state: 'cancelled',
      counterparty_contact_id: 'alice@example.com',
    });
    insertCommitment({
      id: 'c3',
      direction: 'outbound',
      lifecycle_state: 'expired',
      counterparty_contact_id: 'alice@example.com',
    });
    expect(aggregateOpenCommitmentsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('excludes tombstoned commitments', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      deleted_at: NOW,
    });
    insertCommitment({
      id: 'c2',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      sync_state: 'tombstoned',
    });
    expect(aggregateOpenCommitmentsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('clamps age weight to 0 for future-dated commitments (clock skew)', () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW + 10 * DAY,
    });
    const agg = aggregateOpenCommitmentsForContact(stubCtx(), 'alice@example.com', NOW);
    expect(agg.count).toBe(1);
    expect(agg.age_weighted).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// aggregateOpenTasksForContact SQL
// ────────────────────────────────────────────────────────────────

describe('aggregateOpenTasksForContact', () => {
  it('returns zero aggregate for an empty contact email', () => {
    expect(aggregateOpenTasksForContact(stubCtx(), '', NOW)).toEqual({
      count: 0,
      age_weighted: 0,
    });
  });

  it('counts open tasks assigned to this contact', () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      updated_at: NOW - 7 * DAY,
    });
    insertTask({
      id: 't2',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      updated_at: NOW - 3 * DAY,
    });
    const agg = aggregateOpenTasksForContact(stubCtx(), 'alice@example.com', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(10, 5);
  });

  it('excludes done tasks', () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 1,
    });
    expect(aggregateOpenTasksForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('excludes tombstoned tasks', () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      deleted_at: NOW,
    });
    expect(aggregateOpenTasksForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('excludes tasks assigned to a different contact', () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'other@example.com',
      done: 0,
    });
    expect(aggregateOpenTasksForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// aggregateUnreadMailsForContact SQL
// ────────────────────────────────────────────────────────────────

describe('aggregateUnreadMailsForContact', () => {
  it('returns zero aggregate for an empty contact email', () => {
    expect(aggregateUnreadMailsForContact(stubCtx(), '', NOW)).toEqual({
      count: 0,
      age_weighted: 0,
    });
  });

  it('counts unread mails involving the contact', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'alice@example.com',
      to: ['me@example.com'],
      is_read: false,
    }, NOW - 4 * DAY);
    insertMail(MAIL_TABLE_PRIMARY, 'm2', {
      from: 'me@example.com',
      to: ['alice@example.com'],
      is_read: false,
    }, NOW - 2 * DAY);
    const agg = aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(6, 5);
  });

  it('excludes read mails (is_read: true)', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'alice@example.com',
      to: ['me@example.com'],
      is_read: true,
    });
    expect(aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('treats missing is_read as unread (defensive — adapter without is_read column shouldn\'t silently zero signal)', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'alice@example.com',
      to: ['me@example.com'],
    });
    expect(aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(1);
  });

  it('excludes mails not involving the contact (substring false-positive guard)', () => {
    // Email substring appears in the body via the LIKE, but the
    // canonical From/To/Cc check rejects it.
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'bob@example.com',
      to: ['me@example.com'],
      is_read: false,
      subject: 'meeting with alice@example.com', // substring false-positive
    });
    expect(aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(0);
  });

  it('sums unread mails across multiple mail collection tables (multi-account)', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'alice@example.com',
      to: ['me@example.com'],
      is_read: false,
    }, NOW - DAY);
    insertMail(MAIL_TABLE_SECONDARY, 's1', {
      from: 'alice@example.com',
      to: ['work@example.com'],
      is_read: false,
    }, NOW - 2 * DAY);
    const agg = aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW);
    expect(agg.count).toBe(2);
    expect(agg.age_weighted).toBeCloseTo(3, 5);
  });

  it('parses display-name-wrapped From headers (canonical address match)', () => {
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'Alice Liddell <alice@example.com>',
      to: ['me@example.com'],
      is_read: false,
    });
    expect(aggregateUnreadMailsForContact(stubCtx(), 'alice@example.com', NOW).count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('openLoopPressureProducer.produce', () => {
  it('returns null when the contact has zero open work across all three sources (sample-floor unmet)', async () => {
    const result = await openLoopPressureProducer.produce(
      stubCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact email is empty', async () => {
    const result = await openLoopPressureProducer.produce(
      stubCtx(),
      sourceFor(fakeContact('')),
    );
    expect(result).toBeNull();
  });

  it('folds commitments + tasks + mails into one rollup', async () => {
    insertCommitment({
      id: 'c1',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 10 * DAY,
    });
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      updated_at: NOW - 5 * DAY,
    });
    insertMail(MAIL_TABLE_PRIMARY, 'm1', {
      from: 'alice@example.com',
      to: ['me@example.com'],
      is_read: false,
    }, NOW - 3 * DAY);

    const value = await expectValue(stubCtx(), fakeContact('alice@example.com'));
    expect(value.open_count).toBe(3);
    expect(value.age_weighted_score).toBeCloseTo(18, 5); // 10 + 5 + 3
    expect(value.pressure_score).toBeCloseTo(18 / 60, 5);
    expect(value.computed_at).toBe(NOW);
  });

  it('saturates pressure_score at 1 when age_weighted_score exceeds the cap', async () => {
    // One ancient open commitment (>60 days)
    insertCommitment({
      id: 'c1',
      direction: 'outbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 120 * DAY,
    });
    const value = await expectValue(stubCtx(), fakeContact('alice@example.com'));
    expect(value.open_count).toBe(1);
    expect(value.age_weighted_score).toBeCloseTo(120, 5);
    expect(value.pressure_score).toBe(1);
  });

  it('emits a row for contacts at the minimum sample floor (1 open item, fresh)', async () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      updated_at: NOW, // age = 0
    });
    const value = await expectValue(stubCtx(), fakeContact('alice@example.com'));
    expect(value.open_count).toBe(1);
    expect(value.age_weighted_score).toBe(0);
    expect(value.pressure_score).toBe(0);
  });

  it('excludes other contacts\' open work from this contact\'s rollup', async () => {
    // Other contact's open task — should not influence Alice's rollup.
    insertTask({
      id: 't_other',
      assigned_contact_id: 'bob@example.com',
      done: 0,
      updated_at: NOW - 30 * DAY,
    });
    insertCommitment({
      id: 'c_alice',
      direction: 'inbound',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 5 * DAY,
    });
    const value = await expectValue(stubCtx(), fakeContact('alice@example.com'));
    expect(value.open_count).toBe(1);
    expect(value.age_weighted_score).toBeCloseTo(5, 5);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value-schema round-trip
// ────────────────────────────────────────────────────────────────

describe('registry value_schema acceptance', () => {
  it('registry validator accepts a producer-shaped value', async () => {
    insertTask({
      id: 't1',
      assigned_contact_id: 'alice@example.com',
      done: 0,
      updated_at: NOW - DAY,
    });
    const value = await expectValue(stubCtx(), fakeContact('alice@example.com'));
    const result = ENRICHMENT_REGISTRY.open_loop_pressure.value_schema(value);
    expect(result.ok).toBe(true);
  });
});
