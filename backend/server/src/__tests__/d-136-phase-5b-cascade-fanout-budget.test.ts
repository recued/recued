/** D-136 §A.5 / audit §24.4 A17 P5b — cascade fan-out budget tests.
 *
 *  Two governors:
 *    1. Per-identity rate ceiling — `cascade_budget_per_second_per_identity`
 *    2. Per-topic queue-depth ceiling — `cascade_queue_depth_max_per_topic`
 *
 *  Both ceilings are SOFT — they reduce cascade thrash but the
 *  primitives' idempotency contract guarantees correctness on re-fire.
 *
 *  The governor itself is a pure in-memory data structure; these
 *  tests cover both the unit-level mechanics + the integrated cascade
 *  primitive observability counters (rows_rate_limited /
 *  rows_queue_depth_capped). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCascadeBudgetGovernor,
  NO_OP_CASCADE_BUDGET_GOVERNOR,
} from '../storage/cascade-budget.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5b-cascade-budget-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Governor unit tests ────────────────────────────────────────────

describe('CascadeBudgetGovernor — per-identity rate ceiling', () => {
  it('admits up to cap inside a 1-second window, then drops', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 3,
      cascade_queue_depth_max_per_topic: 10_000,
    });
    const t0 = 1000;
    expect(gov.reserveForIdentity('alice@example.com', 1, t0)).toEqual({
      admitted: 1,
      dropped: 0,
    });
    expect(gov.reserveForIdentity('alice@example.com', 1, t0 + 100)).toEqual({
      admitted: 1,
      dropped: 0,
    });
    expect(gov.reserveForIdentity('alice@example.com', 1, t0 + 200)).toEqual({
      admitted: 1,
      dropped: 0,
    });
    // 4th call within 1s — over cap.
    expect(gov.reserveForIdentity('alice@example.com', 1, t0 + 300)).toEqual({
      admitted: 0,
      dropped: 1,
    });
  });

  it('partially admits when a multi-row request straddles the cap', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 5,
      cascade_queue_depth_max_per_topic: 10_000,
    });
    expect(gov.reserveForIdentity('alice', 3, 1000)).toEqual({ admitted: 3, dropped: 0 });
    // 5 desired but only 2 slots left in this window.
    expect(gov.reserveForIdentity('alice', 5, 1100)).toEqual({ admitted: 2, dropped: 3 });
  });

  it('reaps expired entries after 1s — fresh window resets the cap', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 2,
      cascade_queue_depth_max_per_topic: 10_000,
    });
    expect(gov.reserveForIdentity('alice', 2, 1000)).toEqual({ admitted: 2, dropped: 0 });
    // 1s + 1ms later — both prior entries reaped.
    expect(gov.reserveForIdentity('alice', 2, 2001)).toEqual({ admitted: 2, dropped: 0 });
  });

  it('keeps separate windows per identity_key', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 1,
      cascade_queue_depth_max_per_topic: 10_000,
    });
    expect(gov.reserveForIdentity('alice', 1, 1000).admitted).toBe(1);
    expect(gov.reserveForIdentity('bob', 1, 1000).admitted).toBe(1);
    // Each identity hits its own cap; alice still saturated.
    expect(gov.reserveForIdentity('alice', 1, 1100).dropped).toBe(1);
  });

  it('cap = 0 drops everything', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 0,
      cascade_queue_depth_max_per_topic: 10_000,
    });
    expect(gov.reserveForIdentity('alice', 5, 1000)).toEqual({ admitted: 0, dropped: 5 });
  });
});

describe('CascadeBudgetGovernor — per-topic queue-depth ceiling', () => {
  it('admits up to (cap - currentDepth)', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 100,
      cascade_queue_depth_max_per_topic: 10,
    });
    expect(gov.reserveForTopic('purpose', 5, 0)).toEqual({ admitted: 5, dropped: 0 });
    expect(gov.reserveForTopic('purpose', 8, 4)).toEqual({ admitted: 6, dropped: 2 });
    // currentDepth at cap → 0 admitted.
    expect(gov.reserveForTopic('purpose', 3, 10)).toEqual({ admitted: 0, dropped: 3 });
    // currentDepth ABOVE cap → still 0 admitted (no negative headroom).
    expect(gov.reserveForTopic('purpose', 3, 15)).toEqual({ admitted: 0, dropped: 3 });
  });

  it('cap = 0 drops everything', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 100,
      cascade_queue_depth_max_per_topic: 0,
    });
    expect(gov.reserveForTopic('purpose', 1, 0)).toEqual({ admitted: 0, dropped: 1 });
  });
});

describe('CascadeBudgetGovernor — reconfigure', () => {
  it('takes effect on the next reservation', () => {
    const gov = createCascadeBudgetGovernor({
      cascade_budget_per_second_per_identity: 1,
      cascade_queue_depth_max_per_topic: 10,
    });
    expect(gov.reserveForIdentity('alice', 1, 1000).admitted).toBe(1);
    expect(gov.reserveForIdentity('alice', 1, 1100).dropped).toBe(1);
    gov.reconfigure({ cascade_budget_per_second_per_identity: 100 });
    expect(gov.reserveForIdentity('alice', 1, 1100).admitted).toBe(1);
    expect(gov.config().cascade_budget_per_second_per_identity).toBe(100);
  });
});

describe('NO_OP_CASCADE_BUDGET_GOVERNOR', () => {
  it('admits everything regardless of inputs', () => {
    expect(NO_OP_CASCADE_BUDGET_GOVERNOR.reserveForIdentity('alice', 1_000_000, 0)).toEqual({
      admitted: 1_000_000,
      dropped: 0,
    });
    expect(NO_OP_CASCADE_BUDGET_GOVERNOR.reserveForTopic('purpose', 1_000_000, 999_999)).toEqual({
      admitted: 1_000_000,
      dropped: 0,
    });
  });
});

// ── Cascade engine integration ─────────────────────────────────────

const seedBehavioralSignatureRow = (target_id: string): string => {
  // Shape A perspective topic — `behavioral_signature` is a working
  // group with `identity_aggregation: 'perspective'` and
  // `aggregates_from: ['mail', 'calendar']`. Value shape per
  // `BehavioralSignatureValue` in `enrichment-registry.ts`.
  const r = store.upsert({
    topic: 'behavioral_signature',
    scope: 'contact',
    target_id,
    authored_by: 'system.housekeeping.behavioral_signature',
    value: {
      mail_count_window: 10,
      mail_count_total: 50,
      meeting_count_window: 2,
      meeting_count_total: 8,
      mean_reply_latency_ms: 60_000,
      reply_sample_count: 5,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: 1_750_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    },
  });
  return r._id;
};

describe('cascadeForIdentityChange — per-identity rate ceiling', () => {
  it('drops over-cap identities + reports rows_rate_limited', () => {
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');

    let frozen = 1000;
    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 2,
        cascade_queue_depth_max_per_topic: 10_000,
      }),
      now: () => frozen,
    });

    // Three identity_keys in one cascade call — cap is 2 per
    // identity/sec, so 2 admit + 1 drops.
    // Each identity has DIFFERENT identity_key so each gets its own
    // window. Cap-of-2 means each individual identity's first call
    // admits. To exercise the rate cap, we need MULTIPLE cascades to
    // the SAME identity within the window.
    const r1 = cascade.cascadeForIdentityChange('mail', 'mail_1', ['alice@example.com']);
    expect(r1.rows_lifecycle_action_enqueued).toBe(1);
    expect(r1.rows_rate_limited).toBe(0);

    frozen = 1100;
    const r2 = cascade.cascadeForIdentityChange('mail', 'mail_2', ['alice@example.com']);
    expect(r2.rows_lifecycle_action_enqueued).toBe(0); // already enqueued
    expect(r2.rows_rate_limited).toBe(0); // 2nd call still under cap of 2

    // 3rd call to alice — over cap.
    frozen = 1200;
    const r3 = cascade.cascadeForIdentityChange('mail', 'mail_3', ['alice@example.com']);
    expect(r3.rows_lifecycle_action_enqueued).toBe(0); // would have been a no-op anyway
    expect(r3.rows_rate_limited).toBe(1);
  });

  it('partially admits when only some identity_keys are over-cap', () => {
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');

    let frozen = 1000;
    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1,
        cascade_queue_depth_max_per_topic: 10_000,
      }),
      now: () => frozen,
    });

    // Saturate alice's window with one prior call.
    cascade.cascadeForIdentityChange('mail', 'mail_x', ['alice@example.com']);
    frozen = 1100;
    // Mixed call: alice over-cap, bob admits.
    const r = cascade.cascadeForIdentityChange('mail', 'mail_y', [
      'alice@example.com',
      'bob@example.com',
    ]);
    // Bob's row was enqueued; alice was rate-limited.
    expect(r.rows_rate_limited).toBe(1);
    expect(r.rows_lifecycle_action_enqueued).toBe(1);
  });

  it('admits everything when the no-op governor is wired (back-compat)', () => {
    // Three identities, no governor → legacy unbounded behavior.
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');
    const cascade = createEnrichmentCascade(store);
    const r = cascade.cascadeForIdentityChange('mail', 'mail_x', [
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
    expect(r.rows_rate_limited).toBe(0);
    expect(r.rows_lifecycle_action_enqueued).toBe(3);
  });
});

describe('cascadeForIdentityChange — per-topic queue-depth ceiling', () => {
  it('caps enqueues when the topic queue is at depth limit', () => {
    // Seed 3 contacts, but cap at 1 row per topic — only 1 admits.
    seedBehavioralSignatureRow('alice@example.com');
    seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');

    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 1,
      }),
    });
    const r = cascade.cascadeForIdentityChange('mail', 'mail_x', [
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
    // Cap of 1 → only 1 row enqueues.
    expect(r.rows_lifecycle_action_enqueued).toBe(1);
    expect(r.rows_queue_depth_capped).toBe(2);
  });

  it('respects existing pending depth — already-saturated topic skips entirely', () => {
    const r1 = seedBehavioralSignatureRow('alice@example.com');
    const r2 = seedBehavioralSignatureRow('bob@example.com');
    seedBehavioralSignatureRow('carol@example.com');

    // Pre-saturate the queue by directly enqueuing 2 rows.
    expect(store.markStaleAndEnqueueByRowIds([r1, r2], 'recompute')).toBe(2);

    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 2,
      }),
    });
    // Cap is 2, depth is already 2 → headroom 0 → cascade drops.
    const r = cascade.cascadeForIdentityChange('mail', 'mail_x', [
      'carol@example.com',
    ]);
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    expect(r.rows_queue_depth_capped).toBe(1);
  });
});

describe('cascadeForConnectionDelete — per-topic queue-depth ceiling', () => {
  it('skips perspective fan-out when the topic queue is saturated', () => {
    // Seed a behavioral_signature row + saturate its queue.
    const r1 = seedBehavioralSignatureRow('alice@example.com');
    const r2 = seedBehavioralSignatureRow('bob@example.com');
    expect(store.markStaleAndEnqueueByRowIds([r1, r2], 'recompute')).toBe(2);

    const cascade = createEnrichmentCascade(store, {
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 2,
      }),
    });
    // No connection-scope rows → only the perspective fan-out is in
    // play. behavioral_signature.aggregates_from includes 'mail' (not
    // 'connection.api') so D-136 P5a's connection-delete fan-out
    // doesn't actually reach behavioral_signature here. Verify the
    // primitive returns cleanly without dropped fan-out.
    const r = cascade.cascadeForConnectionDelete('api', 'hubspot');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    expect(r.rows_queue_depth_capped).toBe(0);
  });
});

describe('CascadeResult — observability counter shape', () => {
  it('exposes rows_rate_limited + rows_queue_depth_capped (default 0)', () => {
    seedBehavioralSignatureRow('alice@example.com');
    const cascade = createEnrichmentCascade(store);
    const r = cascade.cascadeForIdentityChange('mail', 'mail_1', ['alice@example.com']);
    expect(r).toMatchObject({
      rows_lifecycle_action_enqueued: 1,
      rows_rate_limited: 0,
      rows_queue_depth_capped: 0,
    });
  });
});
