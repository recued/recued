/** D-136 P7.C — Historical-chain resolver + recipe staleness widening.
 *
 *  Two stores ship in this phase, plus a resolver default flip:
 *
 *    1. `EnrichmentStore.getRowAsOf({…, as_of})` — walks the supersede
 *       chain to find the row whose `[event_at, superseded_event_at)`
 *       interval covers `as_of`. Effective time is
 *       `COALESCE(event_at, ingested_at)` so legacy rows without an
 *       explicit event time still land on the timeline. The chain
 *       head's interval extends to `+∞`; ancestors' intervals end at
 *       the next row's event time.
 *
 *    2. `EnrichmentStore.getChain({…})` — returns the full supersede
 *       chain ordered by effective time DESC. Multi-author shape A
 *       merges chains; pass `authored_by` to narrow to one chain.
 *
 *    3. `enrichment-resolver` flips `fresh_only: true → false` on every
 *       `data.enrichment.*` recipe-side read. Stale + expired rows
 *       surface alongside fresh ones; consumers read `staleness_class`
 *       off the bag-form envelope to decide.
 *
 *  Spec: `docs/d-136-spec.md` §A.13.3 + spec P7 lines 1123-1124. The
 *  storage substrate is the foundation P7.D's `mcp.enrichment.read`
 *  rpc layers `as_of` / `coherent_at` / `include_historical` filters
 *  on top of. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createEnrichmentResolver } from '../storage/enrichment-resolver.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-c-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const COMPANY = (
  override: Partial<{
    domain: string;
    company_name: string | null;
    source: 'signature_parse' | 'domain_only';
    domain_category: 'free_mail' | 'business';
    reasoning: string;
    computed_at: number;
  }> = {},
) => ({
  domain: 'acme.com',
  company_name: 'Acme',
  source: 'domain_only' as const,
  domain_category: 'business' as const,
  reasoning: 'derived from domain',
  computed_at: NOW,
  ...override,
});

const DRIFT = (
  override: Partial<{
    source_topic: string;
    psi: number;
    severity: 'none' | 'moderate' | 'significant';
    computed_at: number;
  }> = {},
) => ({
  source_topic: 'purpose',
  psi: 0.15,
  severity: 'moderate' as const,
  baseline_window: { start_at: 0, end_at: 1000, sample_count: 100 },
  recent_window: { start_at: 1000, end_at: 2000, sample_count: 30 },
  baseline_distribution: [0.8, 0.85, 0.9],
  recent_distribution: [0.7, 0.75, 0.65],
  computed_at: NOW,
  ...override,
});

/** Build a 3-row supersede chain on `company` for `(contact, alice)`.
 *  Rows are inserted in event_at-ascending order so the chain head is
 *  the most recent (the natural producer pattern). */
const buildCompanyChain = (target: string = 'alice@example.com') => {
  const r1 = store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: 'Acme', computed_at: 1000 }),
    authored_by: 'system.housekeeping.company',
    event_at: 1000,
  });
  const r2 = store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: 'Globex', computed_at: 2000 }),
    authored_by: 'system.housekeeping.company',
    event_at: 2000,
  });
  const r3 = store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: 'Initech', computed_at: 3000 }),
    authored_by: 'system.housekeeping.company',
    event_at: 3000,
  });
  return { r1, r2, r3 };
};

const buildDriftChain = (derived_entity_id: string = 'drift_purpose') => {
  const r1 = store.upsert({
    topic: 'confidence_drift_signal',
    derived_entity_id,
    value: DRIFT({ psi: 0.10, severity: 'none', computed_at: 1000 }),
    authored_by: 'system.housekeeping.confidence_drift',
    event_at: 1000,
  });
  const r2 = store.upsert({
    topic: 'confidence_drift_signal',
    derived_entity_id,
    value: DRIFT({ psi: 0.20, severity: 'moderate', computed_at: 2000 }),
    authored_by: 'system.housekeeping.confidence_drift',
    event_at: 2000,
  });
  const r3 = store.upsert({
    topic: 'confidence_drift_signal',
    derived_entity_id,
    value: DRIFT({ psi: 0.40, severity: 'significant', computed_at: 3000 }),
    authored_by: 'system.housekeeping.confidence_drift',
    event_at: 3000,
  });
  return { r1, r2, r3 };
};

// ────────────────────────────────────────────────────────────────
// 1. getRowAsOf — Shape A historical chain walk
// ────────────────────────────────────────────────────────────────

describe('getRowAsOf — Shape A (per-record, historical topic)', () => {
  it('returns null when as_of predates the first chain row', () => {
    buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 500,
    });
    expect(out).toBeNull();
  });

  it('returns the oldest chain row when as_of falls in its interval', () => {
    const { r1 } = buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 1500,
    });
    expect(out?._id).toBe(r1._id);
    expect((out?.value as { company_name: string }).company_name).toBe('Acme');
  });

  it('returns the middle chain row when as_of falls in its interval', () => {
    const { r2 } = buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 2500,
    });
    expect(out?._id).toBe(r2._id);
    expect((out?.value as { company_name: string }).company_name).toBe('Globex');
  });

  it('returns the chain head when as_of equals head event_at', () => {
    const { r3 } = buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 3000,
    });
    expect(out?._id).toBe(r3._id);
    expect(out?.superseded_by_id).toBeNull();
  });

  it('returns the chain head when as_of is far in the future (head interval extends to +∞)', () => {
    const { r3 } = buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: Number.MAX_SAFE_INTEGER,
    });
    expect(out?._id).toBe(r3._id);
  });

  it('returns the boundary row when as_of equals an ancestor event_at', () => {
    // Boundary semantic: `[event_at, next.event_at)` — left-closed,
    // right-open. as_of=2000 lands on r2 (its event_at), not r1.
    const { r2 } = buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 2000,
    });
    expect(out?._id).toBe(r2._id);
  });

  it('falls back to ingested_at for rows without event_at', () => {
    // Row written without event_at — effective time = ingested_at = NOW.
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'bob@example.com',
      value: COMPANY({ company_name: 'NoEventAt' }),
      authored_by: 'system.housekeeping.company',
      // no event_at
    });
    // as_of < NOW → null (no row covers it)
    const before = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'bob@example.com',
      as_of: NOW - 1,
    });
    expect(before).toBeNull();
    // as_of >= NOW → returns the row
    const after = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'bob@example.com',
      as_of: NOW,
    });
    expect(after).not.toBeNull();
    expect((after?.value as { company_name: string }).company_name).toBe('NoEventAt');
  });

  it('returns null on missing target', () => {
    buildCompanyChain();
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'no-such-contact@example.com',
      as_of: 5000,
    });
    expect(out).toBeNull();
  });

  it('returns null when as_of is not a finite number', () => {
    buildCompanyChain();
    const nanOut = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: Number.NaN,
    });
    expect(nanOut).toBeNull();
    const infOut = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: Number.POSITIVE_INFINITY,
    });
    expect(infOut).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. getRowAsOf — multi-author + tombstone
// ────────────────────────────────────────────────────────────────

describe('getRowAsOf — multi-author shape A', () => {
  it('without authored_by, picks the freshest row across author chains at as_of', () => {
    // Author A's chain: event_at = 1000, 2000
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'AuthorA-old', computed_at: 1000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 1000,
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'AuthorA-new', computed_at: 2000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 2000,
    });
    // Author B's chain: event_at = 1500
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'AuthorB-mid', computed_at: 1500 }),
      authored_by: 'recipe.alt',
      event_at: 1500,
    });
    // as_of=1800 → largest event_at <= 1800 across both authors is 1500 (B-mid)
    const out = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      as_of: 1800,
    });
    expect((out?.value as { company_name: string }).company_name).toBe('AuthorB-mid');
  });

  it('with authored_by, narrows to that author chain', () => {
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'AuthorA-only', computed_at: 1000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 1000,
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'AuthorB-only', computed_at: 1500 }),
      authored_by: 'recipe.alt',
      event_at: 1500,
    });
    const fromA = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      authored_by: 'system.housekeeping.company',
      as_of: 5000,
    });
    expect((fromA?.value as { company_name: string }).company_name).toBe('AuthorA-only');
    const fromB = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      authored_by: 'recipe.alt',
      as_of: 5000,
    });
    expect((fromB?.value as { company_name: string }).company_name).toBe('AuthorB-only');
  });
});

describe('getRowAsOf — non-monotonic chain (Codex P7.C review)', () => {
  it('returns the head for as_of >= head.event_at when a backfill makes head event_at < ancestor event_at', () => {
    // Producer wrote chain head at event_at=2000; later a backfilled
    // mail arrived (older real-world event_at) and the producer
    // re-ran via supersede mode → new chain head with event_at=1500.
    //
    // Chain (after backfill):
    //   r1 (event_at=2000, superseded_by=r2)
    //   r2 (event_at=1500, superseded_by=NULL — head)
    //
    // Coverage intervals derived from supersede links:
    //   r1's interval = [2000, 1500) — empty (lower > upper)
    //   r2's interval = [1500, +∞)
    //
    // Pre-fix bug: SQL picked the row with max effective_time <= as_of
    // ignoring supersede links, so as_of=2500 returned r1 (event_at=2000)
    // instead of r2. The interval-via-supersede-link gate (Codex P7.C
    // review fix) correctly excludes r1 (its successor r2's event_at
    // 1500 is NOT > 2500) and returns r2 (head, no successor cap).
    const r1 = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'backfill@example.com',
      value: COMPANY({ company_name: 'Original', computed_at: 2000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 2000,
    });
    const r2 = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'backfill@example.com',
      value: COMPANY({ company_name: 'BackfilledHead', computed_at: 1500 }),
      authored_by: 'system.housekeeping.company',
      event_at: 1500, // older than r1's event_at — backfill semantics
    });
    // Verify chain shape — r1 superseded by r2, r2 is head.
    expect(store.getById(r1._id)?.superseded_by_id).toBe(r2._id);
    expect(store.getById(r2._id)?.superseded_by_id).toBeNull();

    // For any as_of >= 1500 (head's event_at), the head's interval
    // [1500, +∞) covers — return r2.
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'backfill@example.com',
        as_of: Number.MAX_SAFE_INTEGER,
      })?._id,
    ).toBe(r2._id);
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'backfill@example.com',
        as_of: 2500,
      })?._id,
    ).toBe(r2._id);
    // Boundary: as_of=2000 — r1's interval is empty, r2's [1500, +∞)
    // covers 2000 — return r2 (NOT r1 even though as_of equals r1's
    // event_at).
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'backfill@example.com',
        as_of: 2000,
      })?._id,
    ).toBe(r2._id);
    // Lower boundary: as_of=1500 — r2's [1500, +∞) covers (left-closed).
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'backfill@example.com',
        as_of: 1500,
      })?._id,
    ).toBe(r2._id);
    // Below the chain: as_of=1499 — no interval covers, return null.
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'backfill@example.com',
        as_of: 1499,
      }),
    ).toBeNull();
  });

  it('handles same-event-at across chain rows — head wins, ancestor interval is empty', () => {
    // Edge case: r1 and r2 both written at the same event_at (e.g.,
    // two supersede passes within the same producer ms tick).
    // Chain: r1 (event_at=1000, superseded_by=r2) → r2 (event_at=1000, head)
    //   r1's interval = [1000, 1000) — empty (left == right)
    //   r2's interval = [1000, +∞)
    //
    // Pre-fix: SQL ordered by `effective_time DESC, ingested_at DESC`
    // so r2 (later ingested_at) won the tie — but the answer was
    // semantically by accident. With non-monotonic chains the tie
    // could fall the wrong way. The interval-via-supersede-link gate
    // makes the correctness explicit.
    const r1 = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'sametick@example.com',
      value: COMPANY({ company_name: 'First', computed_at: 1000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 1000,
    });
    const r2 = store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'sametick@example.com',
      value: COMPANY({ company_name: 'Second', computed_at: 1000 }),
      authored_by: 'system.housekeeping.company',
      event_at: 1000, // same event_at as r1
    });
    expect(r1._id).not.toBe(r2._id);

    const at_future = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'sametick@example.com',
      as_of: 1500,
    });
    expect(at_future?._id).toBe(r2._id);
    expect((at_future?.value as { company_name: string }).company_name).toBe('Second');

    // Boundary: as_of=1000 — r2 (head) covers via [1000, +∞).
    const at_boundary = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'sametick@example.com',
      as_of: 1000,
    });
    expect(at_boundary?._id).toBe(r2._id);

    // Below boundary: as_of=999 — neither row's interval covers.
    expect(
      store.getRowAsOf({
        topic: 'company',
        scope: 'contact',
        target_id: 'sametick@example.com',
        as_of: 999,
      }),
    ).toBeNull();
  });
});

describe('getRowAsOf — tombstoned rows', () => {
  it('surfaces tombstoned chain rows with value=NULL preserved', () => {
    const { r1, r2, r3 } = buildCompanyChain();
    // Tombstone the middle ancestor (r2). Per audit §10.2 the row's
    // _id + event_at survive; value goes NULL + tombstoned_at populated.
    store.tombstoneRowIds([r2._id], 'user_discarded');

    // as_of in r2's interval (2000-3000) returns r2 with NULL value.
    const at_r2 = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 2500,
    });
    expect(at_r2?._id).toBe(r2._id);
    expect(at_r2?.value).toBeNull();
    expect(at_r2?.tombstoned_at).not.toBeNull();
    expect(at_r2?.tombstone_reason).toBe('user_discarded');

    // as_of before r2 still returns r1 unchanged.
    const at_r1 = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 1500,
    });
    expect(at_r1?._id).toBe(r1._id);
    expect(at_r1?.value).not.toBeNull();

    // as_of >= 3000 returns r3 (head still untombstoned).
    const at_r3 = store.getRowAsOf({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 5000,
    });
    expect(at_r3?._id).toBe(r3._id);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. getRowAsOf — Shape B (derived_entity)
// ────────────────────────────────────────────────────────────────

describe('getRowAsOf — Shape B (derived_entity)', () => {
  it('walks the supersede chain by derived_entity_id', () => {
    const { r1, r2, r3 } = buildDriftChain();
    expect(r1._id).not.toBe(r2._id);
    expect(r2._id).not.toBe(r3._id);

    const before = store.getRowAsOf({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
      as_of: 500,
    });
    expect(before).toBeNull();

    const at_r1 = store.getRowAsOf({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
      as_of: 1500,
    });
    expect(at_r1?._id).toBe(r1._id);

    const at_head = store.getRowAsOf({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
      as_of: 5000,
    });
    expect(at_head?._id).toBe(r3._id);
  });

  it('returns null when the derived_entity_id is unknown', () => {
    buildDriftChain();
    const out = store.getRowAsOf({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'no_such_drift',
      as_of: 5000,
    });
    expect(out).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. getRowAsOf — non-historical topics (degenerate single-row chain)
// ────────────────────────────────────────────────────────────────

describe('getRowAsOf — non-historical topic (degenerate chain)', () => {
  it('returns the single overwrite row for any as_of >= event_at', () => {
    // `purpose` is non-historical (default lifecycle); writes overwrite
    // in place — chain of length 1. The walker still works.
    const row = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
      event_at: 5000,
    });
    expect(
      store.getRowAsOf({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'mail_1',
        as_of: 4999,
      }),
    ).toBeNull();
    const at = store.getRowAsOf({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      as_of: 5000,
    });
    expect(at?._id).toBe(row._id);
  });

  it('an overwrite-mode rewrite collapses the chain to one row at the latest event_at', () => {
    // First write at event_at=5000, overwritten at 6000. Only the
    // latest survives (overwrite semantics) — as_of=5500 returns the
    // current row stamped at 6000 (no chain to walk back through).
    const r1 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
      event_at: 5000,
    });
    const r2 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'follow-up', confidence: 0.95 },
      authored_by: 'system.housekeeping.purpose',
      event_at: 6000,
    });
    expect(r1._id).toBe(r2._id); // overwrite preserves _id
    const before = store.getRowAsOf({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      as_of: 5500,
    });
    expect(before).toBeNull(); // current row's event_at = 6000, not <= 5500
  });
});

// ────────────────────────────────────────────────────────────────
// 5. getRowAsOf — shape mismatch errors
// ────────────────────────────────────────────────────────────────

describe('getRowAsOf — input validation', () => {
  it('throws when scope+target_id missing for a per_record topic', () => {
    expect(() =>
      store.getRowAsOf({
        topic: 'company',
        derived_entity_id: 'wrong_for_per_record',
        as_of: 5000,
      }),
    ).toThrow(/per_record/);
  });

  it('throws when derived_entity_id missing for a derived_entity topic', () => {
    expect(() =>
      store.getRowAsOf({
        topic: 'confidence_drift_signal',
        scope: 'mail',
        target_id: 'wrong',
        as_of: 5000,
      }),
    ).toThrow(/derived_entity/);
  });

  it('throws on unknown topic', () => {
    expect(() =>
      store.getRowAsOf({
        topic: 'not_a_topic',
        scope: 'contact',
        target_id: 'alice@example.com',
        as_of: 5000,
      }),
    ).toThrow(/enrichment_topic_unknown/);
  });

  it('throws on topic + scope mismatch (company is contact-only)', () => {
    expect(() =>
      store.getRowAsOf({
        topic: 'company',
        scope: 'mail',
        target_id: 'alice@example.com',
        as_of: 5000,
      }),
    ).toThrow(/enrichment_scope_unsupported/);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. getChain — full historical chain
// ────────────────────────────────────────────────────────────────

describe('getChain — Shape A historical', () => {
  it('returns the full chain ordered by event_at DESC', () => {
    const { r1, r2, r3 } = buildCompanyChain();
    const chain = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(chain).toHaveLength(3);
    expect(chain[0]?._id).toBe(r3._id); // head first
    expect(chain[1]?._id).toBe(r2._id);
    expect(chain[2]?._id).toBe(r1._id); // oldest last
  });

  it('returns empty array when no rows match', () => {
    expect(
      store.getChain({
        topic: 'company',
        scope: 'contact',
        target_id: 'no-such-contact@example.com',
      }),
    ).toEqual([]);
  });

  it('respects limit (default 100; max 1000)', () => {
    buildCompanyChain();
    const limited = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    // Limit of 0 rounds up to 1 (Math.max guard).
    const minimal = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      limit: 0,
    });
    expect(minimal).toHaveLength(1);
  });

  it('without authored_by, merges chains across authors DESC', () => {
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'A1', computed_at: 1000 }),
      authored_by: 'authorA',
      event_at: 1000,
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'A2', computed_at: 3000 }),
      authored_by: 'authorA',
      event_at: 3000,
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'B1', computed_at: 2000 }),
      authored_by: 'authorB',
      event_at: 2000,
    });
    const merged = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
    });
    expect(merged).toHaveLength(3);
    const names = merged.map((r) => (r.value as { company_name: string }).company_name);
    expect(names).toEqual(['A2', 'B1', 'A1']); // 3000, 2000, 1000
  });

  it('with authored_by, narrows to one chain', () => {
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'A1', computed_at: 1000 }),
      authored_by: 'authorA',
      event_at: 1000,
    });
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      value: COMPANY({ company_name: 'B1', computed_at: 2000 }),
      authored_by: 'authorB',
      event_at: 2000,
    });
    const onlyA = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'shared@example.com',
      authored_by: 'authorA',
    });
    expect(onlyA).toHaveLength(1);
    expect((onlyA[0]?.value as { company_name: string }).company_name).toBe('A1');
  });

  it('includes tombstoned chain rows so audit consumers see full history', () => {
    const { r2 } = buildCompanyChain();
    store.tombstoneRowIds([r2._id], 'user_discarded');
    const chain = store.getChain({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(chain).toHaveLength(3);
    const tombstoned = chain.find((r) => r._id === r2._id);
    expect(tombstoned?.tombstoned_at).not.toBeNull();
    expect(tombstoned?.value).toBeNull();
  });
});

describe('getChain — Shape B derived_entity', () => {
  it('returns the full chain ordered by event_at DESC', () => {
    const { r1, r2, r3 } = buildDriftChain();
    const chain = store.getChain({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'drift_purpose',
    });
    expect(chain).toHaveLength(3);
    expect(chain[0]?._id).toBe(r3._id);
    expect(chain[1]?._id).toBe(r2._id);
    expect(chain[2]?._id).toBe(r1._id);
  });

  it('returns empty array when no chain matches', () => {
    expect(
      store.getChain({
        topic: 'confidence_drift_signal',
        derived_entity_id: 'no_such_drift',
      }),
    ).toEqual([]);
  });
});

describe('getChain — input validation', () => {
  it('throws on shape mismatch (per_record without scope/target_id)', () => {
    expect(() =>
      store.getChain({
        topic: 'company',
        derived_entity_id: 'wrong',
      }),
    ).toThrow(/per_record/);
  });

  it('throws on shape mismatch (derived_entity with scope+target_id)', () => {
    expect(() =>
      store.getChain({
        topic: 'confidence_drift_signal',
        scope: 'mail',
        target_id: 'wrong',
      }),
    ).toThrow(/derived_entity/);
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Resolver staleness widening
// ────────────────────────────────────────────────────────────────

describe('resolver — fresh_only:false default surfaces stale rows', () => {
  it('per-record convenience form returns stale row value (was filtered pre-P7.C)', () => {
    // Use `purpose` (non-historical) to keep the chain to one row;
    // simulate the cascade engine flipping it to stale via the
    // mark-by-author API.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
    });
    const flipped = store.markStaleByAuthor('system.housekeeping.purpose');
    expect(flipped).toBe(1);

    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['mail', 'mail_1', 'purpose']);
    // Pre-P7.C this would have been `kind: 'null'` (fresh_only filtered).
    // Post-P7.C the stale row's value surfaces.
    expect(out.kind).toBe('value');
    if (out.kind === 'value') {
      expect((out.value as { purpose: string }).purpose).toBe('inquiry');
    }
  });

  it('per-record bag form includes stale rows with staleness_class envelope intact', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
    });
    store.markStaleByAuthor('system.housekeeping.purpose');

    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['mail', 'mail_1']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') {
      expect(out.records).toHaveLength(1);
      expect(out.records[0]?.staleness_class).toBe('stale');
    }
  });

  it('per-record wildcard form includes stale rows', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
    });
    store.markStaleByAuthor('system.housekeeping.purpose');

    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['mail', 'mail_1', '*']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') {
      expect(out.records).toHaveLength(1);
      expect(out.records[0]?.staleness_class).toBe('stale');
    }
  });

  it('derived-entity wildcard listing includes stale rows', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'cluster_a',
      value: {
        topic_name: 'Test Cluster',
        summary: 'A test cluster',
        members: ['mail_1'],
        thread_ids: ['thread_1'],
        theme_tokens: ['test'],
        thread_count: 1,
        ai_invoked: false,
        computed_at: NOW,
        window_ms: 90 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.topic_cluster',
    });
    store.markStaleByAuthor('system.housekeeping.topic_cluster');

    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['topic_cluster', '*']);
    expect(out.kind).toBe('list');
    if (out.kind === 'list') {
      expect(out.records).toHaveLength(1);
      expect(out.records[0]?.staleness_class).toBe('stale');
    }
  });

  it('tombstoned chain head surfaces with NULL value via convenience form', () => {
    // Tombstone NULLs the value column. The convenience form returns
    // `value: null` so the recipe sees the absence + downstream
    // null-safety propagates.
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      value: { purpose: 'inquiry', confidence: 0.9 },
      authored_by: 'system.housekeeping.purpose',
    });
    store.tombstoneRowIds([r._id], 'user_discarded');

    const resolver = createEnrichmentResolver(store);
    const out = resolver.resolve(['mail', 'mail_1', 'purpose']);
    expect(out.kind).toBe('value');
    if (out.kind === 'value') {
      expect(out.value).toBeNull();
    }
  });
});
