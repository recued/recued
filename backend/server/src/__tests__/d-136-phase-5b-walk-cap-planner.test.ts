/** D-136 §A.7 P5b — walk-cap planner tests.
 *
 *  Covers:
 *    1. Pending-row enumeration: only chain-head, non-pinned rows
 *       enter the plan; superseded + pinned rows are excluded.
 *    2. AI-surface filter: deterministic topics never enter the
 *       walk-cap budget pass.
 *    3. Trust-state gating: `'off'` and `'manual'` topics skip with
 *       structured reasons.
 *    4. Pause-AI gating: AI-surface topics skip when
 *       `pause_background_ai_until > now`.
 *    5. Pool routing: `pool_policy: 'byok_only'` accounts BYOK;
 *       `'free_only'` + `'free_then_byok'` account free; the global
 *       `allow_byok_background = false` master collapses everything
 *       to free.
 *    6. Budget gate: `over_budget` flips to true when estimated >
 *       remaining for either pool.
 *    7. Dedup probe: when wired, matching rows fold into `dedup_hits`
 *       with `estimated_tokens: 0` and don't bump the budget.
 *    8. Daily window rollover: `rollBudgetWindow` zeroes counters when
 *       `now > budget_window_start + 24h`; the first-open path seeds
 *       `budget_window_start` without zeroing.
 *    9. Persistence round-trip: `persistBudgetState` + `readBudgetState`
 *       round-trip the counters across restarts. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENRICHMENT_PINNED_AUTHOR_PREFIX, ENRICHMENT_REGISTRY } from '@recued/contracts';

import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import {
  PLANNER_BUDGET_STATE_TASK_ID,
  persistBudgetState,
  planHousekeepingCycle,
  readBudgetState,
  rollBudgetWindow,
  type PlannerBudgetState,
  type PlannerConfig,
  type PlannerProducerInfo,
} from '../housekeeping/cycle-planner.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

const NOW = 1_750_000_000_000; // 2025-06-15-ish UTC

const baseConfig = (overrides?: Partial<PlannerConfig>): PlannerConfig => ({
  daily_token_budget_free: 1_000_000,
  daily_token_budget_byok: 10_000_000,
  allow_byok_background: true,
  pause_background_ai_until: null,
  ...overrides,
});

const baseState = (overrides?: Partial<PlannerBudgetState>): PlannerBudgetState => ({
  tokens_consumed_today_free: 0,
  tokens_consumed_today_byok: 0,
  budget_window_start: NOW,
  ...overrides,
});

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5b-planner-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
  ensureHousekeepingSchema(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── enumeration filter ─────────────────────────────────────────────

describe('D-136 §A.7 — planner pending-row enumeration', () => {
  it('returns rows whose lifecycle_action_pending is set and chain-head + non-pinned', () => {
    // The planner is only meaningful for ai-surface housekeeping
    // topics. `purpose` is stable_truth, recompute_on_drift,
    // ai_surface — the canonical D-136 candidate.
    const r1 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.9 },
    });
    const r2 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.8 },
    });
    // mark_stale + enqueue both
    expect(store.markStaleAndEnqueueByRowIds([r1._id, r2._id], 'recompute')).toBe(2);

    const producers: ReadonlyArray<PlannerProducerInfo> = [
      { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
    ];
    const plan = planHousekeepingCycle({
      db,
      store,
      config: baseConfig(),
      state: baseState(),
      producers,
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(2);
    expect(plan.leaves.map((l) => l.row_id).sort()).toEqual([r1._id, r2._id].sort());
    expect(plan.skipped).toHaveLength(0);
  });

  it('excludes pinned rows', () => {
    const author = `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.test_vote`;
    // pinned via author + mode: 'pinned'. `purpose` is non-historical
    // so the pinned write overwrites in place + sets is_pinned=1.
    const pinned = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_x',
      authored_by: author,
      value: { purpose: 'support', confidence: 1.0 },
      mode: 'pinned',
    });
    expect(pinned.is_pinned).toBe(true);
    // markStaleAndEnqueue silently filters pinned rows in the SQL —
    // verify by observing 0 changed.
    expect(store.markStaleAndEnqueueByRowIds([pinned._id], 'recompute')).toBe(0);

    const plan = planHousekeepingCycle({
      db,
      store,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
  });
});

// ── AI-surface gating ──────────────────────────────────────────────

describe('D-136 §A.7 — AI-surface filter', () => {
  it('excludes non-AI-surface topics from the budget pass + surfaces them in skipped', () => {
    // `thread_signals` is deterministic / aggregate — non-ai-surface.
    // P4's enqueue path is registry-gated to recompute_on_drift, but
    // the planner shouldn't budget tokens for it regardless.
    const r = store.upsert({
      topic: 'thread_signals',
      scope: 'mail',
      target_id: 'thread_1',
      authored_by: 'system.housekeeping.thread_signals',
      value: {
        thread_id: 'thread_1',
        message_count: 3,
        participant_count: 2,
        span_days: 1,
        has_unread: false,
      },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const plan = planHousekeepingCycle({
      db,
      store,
      config: baseConfig(),
      state: baseState(),
      producers: [
        // thread_signals declared but flagged non-ai-surface
        { topic: 'thread_signals', is_ai_surface: false, token_estimate_per_record: 0 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe('not_ai_surface');
    expect(plan.estimated_free_tokens).toBe(0);
    expect(plan.over_budget).toBe(false);
  });

  it('marks unknown-to-registry topics as `topic_unknown_to_registry`', () => {
    // Use `purpose` (a real registry entry) to satisfy the
    // upsert validator, but pass an empty producer list to the
    // planner so the topic looks unknown to it.
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const plan = planHousekeepingCycle({
      db,
      store,
      config: baseConfig(),
      state: baseState(),
      producers: [],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('topic_unknown_to_registry');
  });
});

// ── trust gating ───────────────────────────────────────────────────

describe('D-136 §A.7 — trust-state gating', () => {
  it("skips topics with trust_state: 'off'", () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'off' }, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('trust_off');
  });

  it("skips topics with trust_state: 'manual' (default for AI-surface)", () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const trustStore = createTrustStore(db);
    // No persisted row → registry default — `purpose` has
    // is_ai_surface=true so the resolved default is 'manual'.
    expect(trustStore.read('purpose', true).trust_state).toBe('manual');

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('trust_manual');
  });

  it("admits topics with trust_state: 'auto' set by the user", () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'free_only' }, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(1);
    expect(plan.leaves[0]!.pool).toBe('free');
    expect(plan.estimated_free_tokens).toBe(250);
    expect(plan.over_budget).toBe(false);
  });
});

// ── pause-AI gate ──────────────────────────────────────────────────

describe('D-136 §A.7 — Pause-AI window', () => {
  it('skips AI-surface topics when pause_background_ai_until > now', () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);

    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto' }, NOW);

    // Seed the housekeeping_config singleton with an active pause
    // window. `isAiPaused` reads `pause_background_ai_until` from
    // this row.
    db.prepare(
      `INSERT INTO housekeeping_config
         (id, preset, cycle_budget_ms, cycle_interval_minutes, pause_background_ai_until, updated_at)
         VALUES ('singleton', 'balanced', 60000, 60, ?, ?)`,
    ).run(NOW + 60 * 60 * 1000, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toBe('paused_ai');
  });
});

// ── pool routing ───────────────────────────────────────────────────

describe('D-136 §A.7 — pool routing', () => {
  const seed = (target_id: string): string => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id,
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(store.markStaleAndEnqueueByRowIds([r._id], 'recompute')).toBe(1);
    return r._id;
  };

  it("routes to BYOK when pool_policy: 'byok_only' + global byok-allowed", () => {
    seed('mail_1');
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'byok_only' }, NOW);
    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig({ allow_byok_background: true }),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 500 },
      ],
      now: NOW,
    });
    expect(plan.leaves[0]!.pool).toBe('byok');
    expect(plan.estimated_byok_tokens).toBe(500);
    expect(plan.estimated_free_tokens).toBe(0);
  });

  it("routes to free when pool_policy: 'free_only'", () => {
    seed('mail_1');
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'free_only' }, NOW);
    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig({ allow_byok_background: true }),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 500 },
      ],
      now: NOW,
    });
    expect(plan.leaves[0]!.pool).toBe('free');
    expect(plan.estimated_free_tokens).toBe(500);
  });

  it('collapses everything to free when allow_byok_background = false', () => {
    seed('mail_1');
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'byok_only' }, NOW);
    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig({ allow_byok_background: false }),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 500 },
      ],
      now: NOW,
    });
    expect(plan.leaves[0]!.pool).toBe('free');
    expect(plan.estimated_byok_tokens).toBe(0);
    expect(plan.estimated_free_tokens).toBe(500);
  });
});

// ── budget gate ────────────────────────────────────────────────────

describe('D-136 §A.7 — budget gate', () => {
  it('flips over_budget when estimated_free > remaining_free', () => {
    // 5 rows × 300 tokens = 1500 estimated free
    for (let i = 0; i < 5; i++) {
      const r = store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: `mail_${i}`,
        authored_by: 'system.housekeeping.purpose',
        value: { purpose: 'inquiry', confidence: 0.5 },
      });
      store.markStaleAndEnqueueByRowIds([r._id], 'recompute');
    }
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'free_only' }, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      // Tiny free budget — 1000 < 1500 → over_budget
      config: baseConfig({ daily_token_budget_free: 1000 }),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 300 },
      ],
      now: NOW,
    });
    expect(plan.leaves).toHaveLength(5);
    expect(plan.estimated_free_tokens).toBe(1500);
    expect(plan.remaining_free).toBe(1000);
    expect(plan.over_budget).toBe(true);
  });

  it('subtracts already-consumed tokens from remaining', () => {
    const r = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.markStaleAndEnqueueByRowIds([r._id], 'recompute');
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'free_only' }, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig({ daily_token_budget_free: 1000 }),
      state: baseState({ tokens_consumed_today_free: 800 }),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 250 },
      ],
      now: NOW,
    });
    expect(plan.estimated_free_tokens).toBe(250);
    expect(plan.remaining_free).toBe(200);
    expect(plan.over_budget).toBe(true); // 250 > 200
  });
});

// ── dedup probe ────────────────────────────────────────────────────

describe('D-136 §A.7 — dedup probe', () => {
  it('moves matched rows into dedup_hits with estimated_tokens: 0', () => {
    const r1 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    const r2 = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.markStaleAndEnqueueByRowIds([r1._id, r2._id], 'recompute');
    const trustStore = createTrustStore(db);
    trustStore.write('purpose', { trust_state: 'auto', pool_policy: 'free_only' }, NOW);

    const plan = planHousekeepingCycle({
      db,
      store,
      trustStore,
      config: baseConfig(),
      state: baseState(),
      producers: [
        { topic: 'purpose', is_ai_surface: true, token_estimate_per_record: 300 },
      ],
      now: NOW,
      // Probe: r1 matches, r2 doesn't.
      probeDedup: (row): boolean => row._id === r1._id,
    });
    expect(plan.leaves).toHaveLength(2);
    expect(plan.dedup_hits).toHaveLength(1);
    expect(plan.dedup_hits[0]!.row_id).toBe(r1._id);
    expect(plan.dedup_hits[0]!.estimated_tokens).toBe(0);
    expect(plan.will_compute).toHaveLength(1);
    expect(plan.will_compute[0]!.row_id).toBe(r2._id);
    expect(plan.estimated_free_tokens).toBe(300); // only the will_compute row
  });
});

// ── daily window rollover ──────────────────────────────────────────

describe('D-136 §A.7 — rollBudgetWindow', () => {
  it('seeds the window without zeroing on first open', () => {
    const out = rollBudgetWindow(
      { tokens_consumed_today_free: 0, tokens_consumed_today_byok: 0, budget_window_start: null },
      NOW,
    );
    expect(out.rolled).toBe(false);
    expect(out.state.budget_window_start).not.toBeNull();
    // counters preserved (zero in this case but the contract is to
    // preserve, not zero, on first-open).
    expect(out.state.tokens_consumed_today_free).toBe(0);
  });

  it('zeroes counters when now > start + 24h', () => {
    const start = NOW;
    const next = start + 25 * 60 * 60 * 1000;
    const out = rollBudgetWindow(
      {
        tokens_consumed_today_free: 5000,
        tokens_consumed_today_byok: 12_000,
        budget_window_start: start,
      },
      next,
    );
    expect(out.rolled).toBe(true);
    expect(out.state.tokens_consumed_today_free).toBe(0);
    expect(out.state.tokens_consumed_today_byok).toBe(0);
    expect(out.state.budget_window_start).not.toBe(start);
  });

  it('preserves counters within the same window', () => {
    const out = rollBudgetWindow(
      {
        tokens_consumed_today_free: 100,
        tokens_consumed_today_byok: 200,
        budget_window_start: NOW,
      },
      NOW + 60 * 60 * 1000, // +1h
    );
    expect(out.rolled).toBe(false);
    expect(out.state.tokens_consumed_today_free).toBe(100);
    expect(out.state.tokens_consumed_today_byok).toBe(200);
  });
});

// ── persistence round-trip ─────────────────────────────────────────

describe('D-136 §A.7 — budget state persistence', () => {
  it('persistBudgetState + readBudgetState round-trip the counters', () => {
    persistBudgetState(
      db,
      {
        tokens_consumed_today_free: 4321,
        tokens_consumed_today_byok: 56_789,
        budget_window_start: NOW,
      },
      NOW,
    );
    const back = readBudgetState(db);
    expect(back.tokens_consumed_today_free).toBe(4321);
    expect(back.tokens_consumed_today_byok).toBe(56_789);
    expect(back.budget_window_start).toBe(NOW);
  });

  it('readBudgetState returns zeroed shape with null window when no row written', () => {
    const fresh = readBudgetState(db);
    expect(fresh.tokens_consumed_today_free).toBe(0);
    expect(fresh.tokens_consumed_today_byok).toBe(0);
    expect(fresh.budget_window_start).toBeNull();
  });

  it('uses the well-known PLANNER_BUDGET_STATE_TASK_ID', () => {
    persistBudgetState(
      db,
      {
        tokens_consumed_today_free: 1,
        tokens_consumed_today_byok: 2,
        budget_window_start: NOW,
      },
      NOW,
    );
    const row = db
      .prepare(`SELECT task_id FROM housekeeping_state WHERE task_id = ?`)
      .get(PLANNER_BUDGET_STATE_TASK_ID) as { task_id: string } | undefined;
    expect(row?.task_id).toBe(PLANNER_BUDGET_STATE_TASK_ID);
  });
});

// ── Sanity: registry classifies `purpose` correctly ────────────────

describe('D-136 P1 invariant referenced by P5b planner', () => {
  it("`purpose` topic is stable_truth + recompute_on_drift (the canonical walk-cap candidate)", () => {
    const def = ENRICHMENT_REGISTRY.purpose;
    expect(def.temporal_class).toBe('stable_truth');
    expect(def.lifecycle_policy).toBe('recompute_on_drift');
  });
});
