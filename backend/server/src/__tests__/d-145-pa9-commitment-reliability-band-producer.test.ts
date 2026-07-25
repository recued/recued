/** D-145 PA9 — `commitment_reliability_band` producer tests.
 *
 *  Eleventh D-145 PA9 producer impl + seventh per-record producer on
 *  `walker_kind: 'contact'`. First per-record producer that reads from
 *  `data.enrichment.*` (via `ctx.enrichmentStore.list`) rather than a
 *  raw warehouse collection — derived_band semantics over the
 *  PSI-eligible `commitment_followthrough_score` source.
 *
 *  Covers:
 *    - Producer surface contract (topic / scope / token estimate /
 *      cadence / scope_read_declaration shape)
 *    - Declaration + registry producer_kind alignment
 *    - decideCommitmentReliabilityBand pure cases (threshold boundaries,
 *      sample-floor short-circuit, non-finite defensiveness)
 *    - readFollowthroughScoreForContact (no-row / well-formed row /
 *      malformed row defensive)
 *    - produce() integration: source-row absence (null), below-floor
 *      sample (insufficient_data), reliable / mixed / risky bands
 *    - Registry value_schema acceptance round-trip */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMITMENT_RELIABILITY_BAND_DECLARATION,
  COMMITMENT_RELIABILITY_BANDS,
  ENRICHMENT_REGISTRY,
  type CommitmentReliabilityBandValue,
  type ContactRecord,
} from '@recued/contracts';

import {
  commitmentReliabilityBandProducer,
  decideCommitmentReliabilityBand,
  readFollowthroughScoreForContact,
  COMMITMENT_RELIABILITY_BAND_RELIABLE_THRESHOLD,
  COMMITMENT_RELIABILITY_BAND_MIXED_THRESHOLD,
  COMMITMENT_RELIABILITY_BAND_SAMPLE_FLOOR,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-145-pa9-band-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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

const seedFollowthroughScore = (
  email: string,
  score: number,
  sample_count: number,
  confidence: number = 0.85,
): void => {
  store.upsert({
    topic: 'commitment_followthrough_score',
    scope: 'contact',
    target_id: email,
    value: {
      score,
      sample_count,
      confidence,
      computed_at: NOW - DAY,
    },
    authored_by: 'system.housekeeping.commitment_followthrough_score',
  });
};

const expectValue = async (
  ctx: HousekeepingContext,
  contact: ContactRecord,
): Promise<CommitmentReliabilityBandValue> => {
  const out = await commitmentReliabilityBandProducer.produce(ctx, sourceFor(contact));
  if (out === null) throw new Error(`expected producer output for ${contact.email}, got null`);
  return out.value as CommitmentReliabilityBandValue;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('commitmentReliabilityBandProducer surface contract', () => {
  it('targets the commitment_reliability_band registry topic', () => {
    expect(commitmentReliabilityBandProducer.topic).toBe('commitment_reliability_band');
  });

  it('targets the contact source scope', () => {
    expect(commitmentReliabilityBandProducer.source_scope).toBe('contact');
  });

  it('declares zero token estimate so the harness flips idle_eligible to true', () => {
    expect(commitmentReliabilityBandProducer.estimate_per_record_tokens()).toBe(0);
  });

  it('declares the 24h recompute cadence matching the registry', () => {
    expect(commitmentReliabilityBandProducer.recompute_cadence).toBe('24h');
  });

  it('omits ai_surface (deterministic — Run-Now skips the AI probe)', () => {
    expect(commitmentReliabilityBandProducer.ai_surface).toBeUndefined();
  });

  it('declares scope_read for contact + commitment_followthrough_score enrichment scope', () => {
    const decls = commitmentReliabilityBandProducer.scope_read_declaration;
    expect(decls.map((e) => e.collection)).toEqual([
      'data.contact',
      'data.enrichment.commitment_followthrough_score',
    ]);
    expect(decls.find((e) => e.collection === 'data.contact')!.sample_field_paths).toEqual(['email']);
    expect(
      decls.find((e) => e.collection === 'data.enrichment.commitment_followthrough_score')!.sample_field_paths,
    ).toEqual(['score', 'sample_count']);
  });

  it('exposes the band threshold + sample floor constants', () => {
    expect(COMMITMENT_RELIABILITY_BAND_RELIABLE_THRESHOLD).toBe(0.8);
    expect(COMMITMENT_RELIABILITY_BAND_MIXED_THRESHOLD).toBe(0.5);
    expect(COMMITMENT_RELIABILITY_BAND_SAMPLE_FLOOR).toBe(30);
  });
});

// ────────────────────────────────────────────────────────────────
// Producer-kind alignment
// ────────────────────────────────────────────────────────────────

describe('producer_kind + derived_band alignment', () => {
  it('declaration carries producer_kind: "housekeeping"', () => {
    expect(COMMITMENT_RELIABILITY_BAND_DECLARATION.producer_kind).toBe('housekeeping');
  });

  it('declaration carries confidence_kind: "derived_band" (banded over PSI source, not PSI itself)', () => {
    expect(COMMITMENT_RELIABILITY_BAND_DECLARATION.confidence_kind).toBe('derived_band');
  });

  it('registry entry carries producer_kind: "housekeeping" so buildEnrichmentProducerTask accepts it', () => {
    expect(ENRICHMENT_REGISTRY.commitment_reliability_band.producer_kind).toBe('housekeeping');
  });

  it('registry preserves valid_scopes: ["contact"]', () => {
    expect(ENRICHMENT_REGISTRY.commitment_reliability_band.valid_scopes).toEqual(['contact']);
  });

  it('registry declares consumes_topics: ["commitment_followthrough_score"]', () => {
    expect(
      (ENRICHMENT_REGISTRY.commitment_reliability_band as { consumes_topics?: readonly string[] })
        .consumes_topics,
    ).toEqual(['commitment_followthrough_score']);
  });
});

// ────────────────────────────────────────────────────────────────
// decideCommitmentReliabilityBand pure cases
// ────────────────────────────────────────────────────────────────

describe('decideCommitmentReliabilityBand', () => {
  it('returns reliable for a clean 0.80 score (boundary inclusive)', () => {
    expect(decideCommitmentReliabilityBand(0.8, 30)).toBe('reliable');
  });

  it('returns reliable for scores above the threshold', () => {
    expect(decideCommitmentReliabilityBand(0.95, 50)).toBe('reliable');
  });

  it('returns mixed for a clean 0.50 score (boundary inclusive)', () => {
    expect(decideCommitmentReliabilityBand(0.5, 30)).toBe('mixed');
  });

  it('returns mixed for scores between thresholds', () => {
    expect(decideCommitmentReliabilityBand(0.65, 30)).toBe('mixed');
    expect(decideCommitmentReliabilityBand(0.79, 30)).toBe('mixed');
  });

  it('returns risky for scores below the mixed threshold', () => {
    expect(decideCommitmentReliabilityBand(0.49, 30)).toBe('risky');
    expect(decideCommitmentReliabilityBand(0.0, 30)).toBe('risky');
  });

  it('returns insufficient_data for sample_count below the floor', () => {
    expect(decideCommitmentReliabilityBand(0.95, 29)).toBe('insufficient_data');
    expect(decideCommitmentReliabilityBand(0.4, 0)).toBe('insufficient_data');
  });

  it('returns insufficient_data for non-finite sample_count (defensive)', () => {
    expect(decideCommitmentReliabilityBand(0.9, Number.NaN)).toBe('insufficient_data');
  });

  it('returns insufficient_data for non-finite score (defensive)', () => {
    expect(decideCommitmentReliabilityBand(Number.NaN, 50)).toBe('insufficient_data');
    expect(decideCommitmentReliabilityBand(Number.POSITIVE_INFINITY, 50)).toBe('insufficient_data');
  });

  it('honours overridden thresholds (future tunable_params lift)', () => {
    expect(decideCommitmentReliabilityBand(0.85, 30, 30, 0.9, 0.6)).toBe('mixed');
    expect(decideCommitmentReliabilityBand(0.55, 30, 30, 0.9, 0.6)).toBe('risky');
  });

  it('honours overridden sample_floor (future tunable_params lift)', () => {
    expect(decideCommitmentReliabilityBand(0.9, 15, 10)).toBe('reliable');
    expect(decideCommitmentReliabilityBand(0.9, 15, 20)).toBe('insufficient_data');
  });
});

// ────────────────────────────────────────────────────────────────
// readFollowthroughScoreForContact
// ────────────────────────────────────────────────────────────────

describe('readFollowthroughScoreForContact', () => {
  it('returns null for an empty contact email', () => {
    expect(readFollowthroughScoreForContact(buildCtx(), '')).toBeNull();
  });

  it('returns null when no source row exists', () => {
    expect(readFollowthroughScoreForContact(buildCtx(), 'alice@example.com')).toBeNull();
  });

  it('returns the numeric fields from a well-formed source row', () => {
    seedFollowthroughScore('alice@example.com', 0.75, 42);
    expect(readFollowthroughScoreForContact(buildCtx(), 'alice@example.com')).toEqual({
      score: 0.75,
      sample_count: 42,
    });
  });

  it('returns null when the source row is malformed (non-finite score)', () => {
    // Bypass the schema validator to seed a malformed row directly. The
    // producer's read is defensive against legacy or unvalidated rows.
    db.prepare(
      `INSERT INTO data_enrichment
        (_id, topic, scope, target_id, value, authored_by, ingested_at, authored_at, staleness_class, failure_attempt_count, is_pinned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fresh', 0, 0)`,
    ).run(
      'enr_malformed_score',
      'commitment_followthrough_score',
      'contact',
      'alice@example.com',
      JSON.stringify({ score: 'not-a-number', sample_count: 50, confidence: 0.9, computed_at: NOW }),
      'system.housekeeping.commitment_followthrough_score',
      NOW,
      NOW,
    );
    expect(readFollowthroughScoreForContact(buildCtx(), 'alice@example.com')).toBeNull();
  });

  it('returns null when the source row is missing sample_count', () => {
    db.prepare(
      `INSERT INTO data_enrichment
        (_id, topic, scope, target_id, value, authored_by, ingested_at, authored_at, staleness_class, failure_attempt_count, is_pinned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fresh', 0, 0)`,
    ).run(
      'enr_missing_sample',
      'commitment_followthrough_score',
      'contact',
      'alice@example.com',
      JSON.stringify({ score: 0.6, confidence: 0.9, computed_at: NOW }),
      'system.housekeeping.commitment_followthrough_score',
      NOW,
      NOW,
    );
    expect(readFollowthroughScoreForContact(buildCtx(), 'alice@example.com')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// produce() integration
// ────────────────────────────────────────────────────────────────

describe('commitmentReliabilityBandProducer.produce', () => {
  it('returns null when the contact has no commitment_followthrough_score row (abstains)', async () => {
    const result = await commitmentReliabilityBandProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('alice@example.com')),
    );
    expect(result).toBeNull();
  });

  it('returns null when the contact email is empty', async () => {
    const result = await commitmentReliabilityBandProducer.produce(
      buildCtx(),
      sourceFor(fakeContact('')),
    );
    expect(result).toBeNull();
  });

  it('emits insufficient_data with the source_score preserved when sample_count is below the floor', async () => {
    seedFollowthroughScore('alice@example.com', 0.92, 10);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('insufficient_data');
    expect(value.source_score).toBe(0.92);
    expect(value.computed_at).toBe(NOW);
  });

  it('emits reliable for a high score with adequate sample size', async () => {
    seedFollowthroughScore('alice@example.com', 0.9, 50);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('reliable');
    expect(value.source_score).toBe(0.9);
  });

  it('emits mixed for a mid-range score with adequate sample size', async () => {
    seedFollowthroughScore('alice@example.com', 0.65, 40);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('mixed');
    expect(value.source_score).toBe(0.65);
  });

  it('emits risky for a low score with adequate sample size', async () => {
    seedFollowthroughScore('alice@example.com', 0.3, 35);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('risky');
    expect(value.source_score).toBe(0.3);
  });

  it('emits reliable at the threshold boundary (score exactly 0.80)', async () => {
    seedFollowthroughScore('alice@example.com', 0.8, 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('reliable');
  });

  it('emits mixed at the threshold boundary (score exactly 0.50)', async () => {
    seedFollowthroughScore('alice@example.com', 0.5, 30);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(value.band).toBe('mixed');
  });

  it('reads only the targeted contact\'s source row (cross-contact isolation)', async () => {
    seedFollowthroughScore('alice@example.com', 0.9, 40);
    seedFollowthroughScore('bob@example.com', 0.1, 40);
    const aliceValue = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    expect(aliceValue.band).toBe('reliable');
    const bobValue = await expectValue(buildCtx(), fakeContact('bob@example.com'));
    expect(bobValue.band).toBe('risky');
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value-schema round-trip
// ────────────────────────────────────────────────────────────────

describe('registry value_schema acceptance', () => {
  it('registry validator accepts a producer-shaped value for every band', async () => {
    for (const band of COMMITMENT_RELIABILITY_BANDS) {
      const value: CommitmentReliabilityBandValue = {
        band,
        source_score: band === 'insufficient_data' ? null : 0.5,
        computed_at: NOW,
      };
      const result = ENRICHMENT_REGISTRY.commitment_reliability_band.value_schema(value);
      expect(result.ok, `band '${band}' should validate`).toBe(true);
    }
  });

  it('registry validator round-trips a produced row', async () => {
    seedFollowthroughScore('alice@example.com', 0.7, 33);
    const value = await expectValue(buildCtx(), fakeContact('alice@example.com'));
    const result = ENRICHMENT_REGISTRY.commitment_reliability_band.value_schema(value);
    expect(result.ok).toBe(true);
  });
});
