/** D-145 PA9 — `commitment_followthrough_score` producer tests.
 *
 *  Twelfth D-145 PA9 producer impl + first **PSI-eligible** producer to
 *  land. The 4-producer PSI substrate (`commitment_followthrough_score`
 *  + `task_completion_velocity` + `project_velocity` +
 *  `context_packet_quality`) drives D-133 drift detection over the
 *  emitted `confidence` distribution; this producer sets the precedent
 *  shape (`PsiEligibleScoreValue`) + static `producer_version_hash`
 *  composition every PSI-eligible producer should follow.
 *
 *  Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration / static producer_version_hash)
 *    - Declaration + registry producer_kind / emits_confidence alignment
 *    - computeFollowthroughConfidence pure cases (linear ramp, saturation,
 *      non-finite defensive)
 *    - countTerminalCommitmentsForContact SQL (direction filter, lifecycle
 *      filter, window filter, tombstone exclusion, empty-id short-circuit,
 *      MAX(state_changed_at) for event_at)
 *    - produce() integration: sample-floor abstention, score math, event_at
 *      stamping, cross-contact isolation
 *    - Registry value_schema acceptance round-trip
 *    - End-to-end: feeding the band producer real source rows produces
 *      the right band */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION,
  ENRICHMENT_REGISTRY,
  type ContactRecord,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import {
  commitmentFollowthroughScoreProducer,
  commitmentReliabilityBandProducer,
  computeFollowthroughConfidence,
  countTerminalCommitmentsForContact,
  COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION,
  COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH,
  COMMITMENT_FOLLOWTHROUGH_SCORE_SAMPLE_FLOOR,
  COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { COMMITMENT_TABLE } from '../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-followthrough-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
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
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
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

const buildCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
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

/** Seed `count` inbound commitments terminating in `state` over the
 *  past `daySpread` days. Used to exercise sample-floor + score math. */
const seedTerminalCommitments = (
  email: string,
  state: 'fulfilled' | 'cancelled' | 'expired',
  count: number,
  daySpread: number = 30,
  idPrefix: string = state,
): void => {
  for (let i = 0; i < count; i++) {
    insertCommitment({
      id: `${idPrefix}_${email}_${i}`,
      direction: 'inbound',
      lifecycle_state: state,
      counterparty_contact_id: email,
      state_changed_at: NOW - (i % daySpread) * DAY,
    });
  }
};

const expectValue = async (
  ctx: HousekeepingContext,
  contact: ContactRecord,
): Promise<PsiEligibleScoreValue> => {
  const out = await commitmentFollowthroughScoreProducer.produce(ctx, sourceFor(contact));
  if (out === null) throw new Error(`expected producer output for ${contact.email}, got null`);
  return out.value as PsiEligibleScoreValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('commitmentFollowthroughScoreProducer surface contract', () => {
  it('targets the commitment_followthrough_score registry topic', () => {
    expect(commitmentFollowthroughScoreProducer.topic).toBe('commitment_followthrough_score');
  });

  it('targets the contact source scope', () => {
    expect(commitmentFollowthroughScoreProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(commitmentFollowthroughScoreProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(commitmentFollowthroughScoreProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(commitmentFollowthroughScoreProducer.ai_surface).toBeUndefined();
  });

  it('declares a static producer_version_hash so PSI drift detection iterates per-version', () => {
    expect(commitmentFollowthroughScoreProducer.producer_version_hash).toBe(
      COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH,
    );
    // FNV-1a self-describing prefix
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH.startsWith('fnv1a:')).toBe(true);
  });

  it('declares scope_read for contact + commitment with the load-bearing fields', () => {
    const decls = commitmentFollowthroughScoreProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.contact',
      'data.commitment',
    ]);
    expect(decls.find((e) => e.collection === 'data.commitment')!.sample_field_paths).toEqual([
      'counterparty_contact_id',
      'direction',
      'lifecycle_state',
      'state_changed_at',
    ]);
  });

  it('exposes window + sample-floor + saturation constants', () => {
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS).toBe(90 * DAY);
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_SAMPLE_FLOOR).toBe(30);
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────
// PSI-eligible declaration + registry alignment
// ────────────────────────────────────────────────────────────────

describe('PSI-eligible alignment', () => {
  it('declaration carries confidence_kind: "emits_confidence" (PSI-eligible)', () => {
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION.confidence_kind).toBe('emits_confidence');
  });

  it('declaration carries sample_floor ≥ 30 (PSI calibration baseline)', () => {
    expect(COMMITMENT_FOLLOWTHROUGH_SCORE_DECLARATION.sample_floor).toBeGreaterThanOrEqual(30);
  });

  it('registry entry carries emits_confidence: true so D-133 drift task picks it up', () => {
    expect(
      (ENRICHMENT_REGISTRY.commitment_followthrough_score as { emits_confidence?: boolean })
        .emits_confidence,
    ).toBe(true);
  });

  it('registry entry carries producer_kind: "housekeeping"', () => {
    expect(ENRICHMENT_REGISTRY.commitment_followthrough_score.producer_kind).toBe('housekeeping');
  });

  it('registry preserves valid_scopes: ["contact"]', () => {
    expect(ENRICHMENT_REGISTRY.commitment_followthrough_score.valid_scopes).toEqual(['contact']);
  });
});

// ────────────────────────────────────────────────────────────────
// computeFollowthroughConfidence pure cases
// ────────────────────────────────────────────────────────────────

describe('computeFollowthroughConfidence', () => {
  it('scales linearly with sample size below saturation', () => {
    expect(computeFollowthroughConfidence(30)).toBeCloseTo(0.3, 10);
    expect(computeFollowthroughConfidence(50)).toBeCloseTo(0.5, 10);
    expect(computeFollowthroughConfidence(99)).toBeCloseTo(0.99, 10);
  });

  it('saturates at 1.0 at and above the saturation cap', () => {
    expect(computeFollowthroughConfidence(100)).toBe(1);
    expect(computeFollowthroughConfidence(500)).toBe(1);
  });

  it('returns 0 for zero or negative sample sizes (defensive)', () => {
    expect(computeFollowthroughConfidence(0)).toBe(0);
    expect(computeFollowthroughConfidence(-5)).toBe(0);
  });

  it('returns 0 for non-finite inputs (defensive)', () => {
    expect(computeFollowthroughConfidence(Number.NaN)).toBe(0);
    expect(computeFollowthroughConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('honours an overridden saturation point (future tunable_params)', () => {
    expect(computeFollowthroughConfidence(50, 200)).toBeCloseTo(0.25, 10);
    expect(computeFollowthroughConfidence(200, 200)).toBe(1);
  });

  it('returns 0 for non-positive saturation override', () => {
    expect(computeFollowthroughConfidence(50, 0)).toBe(0);
    expect(computeFollowthroughConfidence(50, -1)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// countTerminalCommitmentsForContact SQL
// ────────────────────────────────────────────────────────────────

describe('countTerminalCommitmentsForContact', () => {
  const SINCE = NOW - COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS;

  it('returns zero counts for an empty contact email', () => {
    expect(countTerminalCommitmentsForContact(buildCtx(), '', SINCE)).toEqual({
      fulfilled_count: 0,
      terminal_count: 0,
      latest_terminal_at: null,
    });
  });

  it('counts fulfilled / cancelled / expired separately + together', () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 5);
    seedTerminalCommitments('alice@example.com', 'cancelled', 3);
    seedTerminalCommitments('alice@example.com', 'expired', 2);
    const counts = countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE);
    expect(counts.fulfilled_count).toBe(5);
    expect(counts.terminal_count).toBe(10);
    expect(counts.latest_terminal_at).toBe(NOW);
  });

  it('excludes pending commitments (open lifecycle = no terminal signal)', () => {
    insertCommitment({
      id: 'c_pending',
      direction: 'inbound',
      lifecycle_state: 'pending',
      counterparty_contact_id: 'alice@example.com',
    });
    expect(countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE).terminal_count).toBe(0);
  });

  it('excludes outbound + internal direction (only inbound counts toward THEIR followthrough)', () => {
    insertCommitment({
      id: 'c_outbound',
      direction: 'outbound',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
    });
    insertCommitment({
      id: 'c_internal',
      direction: 'internal',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
    });
    expect(countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE).terminal_count).toBe(0);
  });

  it('excludes commitments older than the window', () => {
    insertCommitment({
      id: 'c_old',
      direction: 'inbound',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 100 * DAY, // outside 90d window
    });
    expect(countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE).terminal_count).toBe(0);
  });

  it('excludes tombstoned commitments', () => {
    insertCommitment({
      id: 'c_deleted',
      direction: 'inbound',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
      deleted_at: NOW,
    });
    insertCommitment({
      id: 'c_tombstoned',
      direction: 'inbound',
      lifecycle_state: 'cancelled',
      counterparty_contact_id: 'alice@example.com',
      sync_state: 'tombstoned',
    });
    expect(countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE).terminal_count).toBe(0);
  });

  it('returns MAX(state_changed_at) across contributing rows', () => {
    insertCommitment({
      id: 'c_older',
      direction: 'inbound',
      lifecycle_state: 'fulfilled',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 10 * DAY,
    });
    insertCommitment({
      id: 'c_newer',
      direction: 'inbound',
      lifecycle_state: 'cancelled',
      counterparty_contact_id: 'alice@example.com',
      state_changed_at: NOW - 2 * DAY,
    });
    const counts = countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE);
    expect(counts.latest_terminal_at).toBe(NOW - 2 * DAY);
  });

  it('isolates by contact (no cross-contact bleed)', () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 5);
    seedTerminalCommitments('bob@example.com', 'cancelled', 5);
    expect(
      countTerminalCommitmentsForContact(buildCtx(), 'alice@example.com', SINCE).terminal_count,
    ).toBe(5);
    expect(
      countTerminalCommitmentsForContact(buildCtx(), 'bob@example.com', SINCE).fulfilled_count,
    ).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('commitmentFollowthroughScoreProducer.produce', () => {
  it('returns null when the contact has fewer than 30 terminal commitments in window', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 20);
    const result = await commitmentFollowthroughScoreProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact has zero terminal commitments', async () => {
    const result = await commitmentFollowthroughScoreProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact email is empty', async () => {
    const result = await commitmentFollowthroughScoreProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('')),
    );
    expect(result).toBeNull();
  });

  it('emits a score of 1.0 when every terminal commitment was fulfilled', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.score).toBe(1);
    expect(value.sample_count).toBe(30);
    expect(value.confidence).toBeCloseTo(0.3, 10);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits a score of 0.0 when every terminal commitment was cancelled or expired', async () => {
    seedTerminalCommitments('alice@example.com', 'cancelled', 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.score).toBe(0);
    expect(value.sample_count).toBe(30);
  });

  it('emits a mid-range score when terminal commitments are mixed', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 18); // 60%
    seedTerminalCommitments('alice@example.com', 'cancelled', 12);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.score).toBeCloseTo(0.6, 10);
    expect(value.sample_count).toBe(30);
  });

  it('saturates confidence at 1.0 when sample_count reaches the saturation cap', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 100, 60);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.sample_count).toBe(100);
    expect(value.confidence).toBe(1);
  });

  it('stamps event_at to MAX(state_changed_at) across the contributing rows', async () => {
    // Spread terminal commitments across day 0..29 so MAX = NOW.
    seedTerminalCommitments('alice@example.com', 'fulfilled', 30);
    const out = await commitmentFollowthroughScoreProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(out?.event_at).toBe(NOW);
  });

  it('excludes commitments older than the 90d window from the score', async () => {
    // Seed 30 in-window cancelled + 50 ancient fulfilled.
    seedTerminalCommitments('alice@example.com', 'cancelled', 30);
    for (let i = 0; i < 50; i++) {
      insertCommitment({
        id: `ancient_${i}`,
        direction: 'inbound',
        lifecycle_state: 'fulfilled',
        counterparty_contact_id: 'alice@example.com',
        state_changed_at: NOW - 100 * DAY,
      });
    }
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.sample_count).toBe(30);
    expect(value.score).toBe(0);
  });

  it('isolates per contact across the cycle', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 30); // reliable
    seedTerminalCommitments('bob@example.com', 'cancelled', 30); // risky

    const aliceValue = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    const bobValue = await expectValue(buildCtx(), fakeContact('bob@example.com'));

    expect(aliceValue.score).toBe(1);
    expect(bobValue.score).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value-schema round-trip
// ────────────────────────────────────────────────────────────────

describe('registry value_schema acceptance', () => {
  it('registry validator accepts a producer-shaped value', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    const result = ENRICHMENT_REGISTRY.commitment_followthrough_score.value_schema(value);
    expect(result.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end with the band consumer (the whole reason this producer
// exists). Asserts that real source rows flow through and band
// classification matches the underlying score.
// ────────────────────────────────────────────────────────────────

describe('end-to-end with commitment_reliability_band consumer', () => {
  const runBothProducers = async (
    email: string,
  ): Promise<{ band: string; source_score: number | null }> => {
    const ctx = buildCtx();
    // 1) Score producer writes its enrichment row.
    const scoreOut = await commitmentFollowthroughScoreProducer.produce(
      ctx,
      sourceFor(fakeContact(email)),
    );
    if (scoreOut === null) {
      // Below floor — band producer should also abstain (returns null).
      const bandOut = await commitmentReliabilityBandProducer.produce(
        ctx,
        sourceFor(fakeContact(email)),
      );
      if (bandOut !== null) throw new Error('expected band producer to abstain when source abstains');
      return { band: 'abstained', source_score: null };
    }
    const scoreValue = scoreOut.value as PsiEligibleScoreValue;
    store.upsert({
      topic: 'commitment_followthrough_score',
      scope: 'contact',
      target_id: email,
      value: scoreValue,
      authored_by: 'system.housekeeping.commitment_followthrough_score',
    });
    // 2) Band producer reads the freshly-written row.
    const bandOut = await commitmentReliabilityBandProducer.produce(
      ctx,
      sourceFor(fakeContact(email)),
    );
    if (bandOut === null) throw new Error('expected band producer to emit');
    const bandValue = bandOut.value as { band: string; source_score: number | null };
    return { band: bandValue.band, source_score: bandValue.source_score };
  };

  it('every fulfilled → reliable band end-to-end', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 30);
    const out = await runBothProducers('alice@example.com');
    expect(out.band).toBe('reliable');
    expect(out.source_score).toBe(1);
  });

  it('mid-range score → mixed band end-to-end', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 18);
    seedTerminalCommitments('alice@example.com', 'cancelled', 12);
    const out = await runBothProducers('alice@example.com');
    expect(out.band).toBe('mixed');
    expect(out.source_score).toBeCloseTo(0.6, 10);
  });

  it('every cancelled → risky band end-to-end', async () => {
    seedTerminalCommitments('alice@example.com', 'cancelled', 30);
    const out = await runBothProducers('alice@example.com');
    expect(out.band).toBe('risky');
    expect(out.source_score).toBe(0);
  });

  it('below sample floor → both producers abstain', async () => {
    seedTerminalCommitments('alice@example.com', 'fulfilled', 10);
    const out = await runBothProducers('alice@example.com');
    expect(out.band).toBe('abstained');
  });
});
