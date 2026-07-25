/** D-136 §A.14.1 P5b — external context pulse cascade tests.
 *
 *  Covers:
 *    1. `recordPulse` first-record path: returns `{changed: false,
 *       first_record: true}` and persists the value.
 *    2. `recordPulse` repeat-with-same-value: `changed: false`.
 *    3. `recordPulse` change path: `changed: true`.
 *    4. Dependency registry: `add` + `consumersOf` round-trip.
 *    5. Cascade primitive `cascadeForExternalContextPulseChange`:
 *       - No registry → no-op (back-compat, pre-P5b cascade engines).
 *       - With registry, pulse fires recompute on consumer topics.
 *       - Per-topic queue-depth ceiling honoured.
 *       - Multiple consumers: fan-out enqueues each topic.
 *       - Idempotent: re-fire is a no-op.
 *
 *  The substrate composes with the §A.5 cascade primitives — same
 *  observability counters (rows_lifecycle_action_enqueued +
 *  rows_queue_depth_capped). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCascadeBudgetGovernor } from '../storage/cascade-budget.js';
import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import {
  createExternalContextDependencyRegistry,
  createExternalContextPulseStore,
  filterInvalidatingConsumers,
} from '../storage/external-context-pulse.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p5b-pulse-'));
  db = new Database(join(dir, 'warehouse.db'));
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Pulse store ────────────────────────────────────────────────────

describe('ExternalContextPulseStore.recordPulse', () => {
  it('first record: changed=false, first_record=true', () => {
    const ps = createExternalContextPulseStore(db);
    const out = ps.recordPulse('hubspot_api_deal_meta', 'hash_v1', NOW);
    expect(out.changed).toBe(false);
    expect(out.first_record).toBe(true);
    expect(out.pulse_value).toBe('hash_v1');
  });

  it('repeat with same value: changed=false, first_record=false', () => {
    const ps = createExternalContextPulseStore(db);
    ps.recordPulse('hubspot_api_deal_meta', 'hash_v1', NOW);
    const out = ps.recordPulse('hubspot_api_deal_meta', 'hash_v1', NOW + 1000);
    expect(out.changed).toBe(false);
    expect(out.first_record).toBe(false);
  });

  it('change path: changed=true', () => {
    const ps = createExternalContextPulseStore(db);
    ps.recordPulse('hubspot_api_deal_meta', 'hash_v1', NOW);
    const out = ps.recordPulse('hubspot_api_deal_meta', 'hash_v2', NOW + 1000);
    expect(out.changed).toBe(true);
    expect(out.first_record).toBe(false);
  });

  it('persists next_check_at when provided', () => {
    const ps = createExternalContextPulseStore(db);
    ps.recordPulse('periodic_check_thing', 'hash_v1', NOW, NOW + 60_000);
    const back = ps.readPulse('periodic_check_thing');
    expect(back?.next_check_at).toBe(NOW + 60_000);
  });

  it('readPulse returns null for unknown context_id', () => {
    const ps = createExternalContextPulseStore(db);
    expect(ps.readPulse('never_recorded')).toBeNull();
  });

  it('listPulses returns all recorded pulses', () => {
    const ps = createExternalContextPulseStore(db);
    ps.recordPulse('a', 'av1', NOW);
    ps.recordPulse('b', 'bv1', NOW);
    const all = ps.listPulses();
    expect(all.map((p) => p.context_id).sort()).toEqual(['a', 'b']);
  });

  it('clear drops every record', () => {
    const ps = createExternalContextPulseStore(db);
    ps.recordPulse('a', 'av1', NOW);
    ps.clear();
    expect(ps.listPulses()).toHaveLength(0);
  });
});

// ── Dependency registry ────────────────────────────────────────────

describe('ExternalContextDependencyRegistry', () => {
  it('round-trips topic ↔ context_id mappings', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('lifecycle_stage_inferred', [
      {
        id: 'hubspot_api_deal_meta',
        pulse_provider: 'connection',
        invalidates_on_pulse_change: true,
      },
    ]);
    const consumers = reg.consumersOf('hubspot_api_deal_meta');
    expect(consumers.has('lifecycle_stage_inferred')).toBe(true);
  });

  it('multiple consumers of one context_id fan out together', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('lifecycle_stage_inferred', [
      {
        id: 'hubspot_api_deal_meta',
        pulse_provider: 'connection',
        invalidates_on_pulse_change: true,
      },
    ]);
    reg.add('deal_health_score', [
      {
        id: 'hubspot_api_deal_meta',
        pulse_provider: 'connection',
        invalidates_on_pulse_change: true,
      },
    ]);
    const consumers = reg.consumersOf('hubspot_api_deal_meta');
    expect(consumers.size).toBe(2);
    expect(consumers.has('lifecycle_stage_inferred')).toBe(true);
    expect(consumers.has('deal_health_score')).toBe(true);
  });

  it('returns empty Set for unknown context_id', () => {
    const reg = createExternalContextDependencyRegistry();
    expect(reg.consumersOf('never_declared').size).toBe(0);
  });

  it('idempotent on repeat add', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'mcp_thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    reg.add('purpose', [
      { id: 'mcp_thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    expect(reg.consumersOf('mcp_thing').size).toBe(1);
  });
});

describe('filterInvalidatingConsumers helper', () => {
  it('filters consumers whose declarations opt out of invalidation', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    reg.add('summary', [
      { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: false },
    ]);
    const filtered = filterInvalidatingConsumers(reg, 'thing', [
      {
        topic: 'purpose',
        deps: [
          { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
        ],
      },
      {
        topic: 'summary',
        deps: [
          { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: false },
        ],
      },
    ]);
    expect(filtered.has('purpose')).toBe(true);
    expect(filtered.has('summary')).toBe(false);
  });
});

// ── Cascade primitive integration ──────────────────────────────────

describe('cascadeForExternalContextPulseChange', () => {
  it('no-op when no registry is wired (back-compat)', () => {
    const cascade = createEnrichmentCascade(store);
    const r = cascade.cascadeForExternalContextPulseChange('any');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    expect(r.rows_queue_depth_capped).toBe(0);
  });

  it('no-op when context_id is empty', () => {
    const reg = createExternalContextDependencyRegistry();
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('no-op when no consumer declared the context_id', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'other_thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('not_subscribed');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('enqueues recompute on consumer-topic chain heads', () => {
    // Seed a `purpose` row + register `purpose` as a consumer of
    // 'hubspot_api_deal_meta'. The cascade should walk the registry +
    // call enqueueLifecycleActionForTopic('purpose', 'recompute').
    const seeded = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    expect(seeded.lifecycle_action_pending).toBeNull();

    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      {
        id: 'hubspot_api_deal_meta',
        pulse_provider: 'connection',
        invalidates_on_pulse_change: true,
      },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('hubspot_api_deal_meta');
    expect(r.rows_lifecycle_action_enqueued).toBe(1);

    // Verify the row's lifecycle_action_pending flipped.
    const back = store.getByRecord('purpose', 'mail', 'mail_1', 'system.housekeeping.purpose');
    expect(back?.lifecycle_action_pending).toBe('recompute');
  });

  it('fans out to multiple consumer topics', () => {
    // Seed rows for two topics — `purpose` + `summary` — both
    // subscribed to one context_id. Both should enqueue.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.upsert({
      topic: 'summary',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.summary',
      value: { summary: 'short', key_points: [] },
    });
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'shared_ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    reg.add('summary', [
      { id: 'shared_ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r = cascade.cascadeForExternalContextPulseChange('shared_ctx');
    expect(r.rows_lifecycle_action_enqueued).toBe(2);
  });

  it('honours per-topic queue-depth ceiling — all-or-nothing skip', () => {
    // Seed three NEW (LAP=NULL) candidates — these would all enqueue
    // when the cascade fires. Cap is 2 → real fan-out (3) > headroom
    // (2 - 0) → all-or-nothing skip. Codex P5b review fix: prior code
    // reserved 1 slot regardless of fan-out, which let the cap be
    // bypassed when topics had any headroom.
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_2',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_3',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, {
      externalContextRegistry: reg,
      governor: createCascadeBudgetGovernor({
        cascade_budget_per_second_per_identity: 1000,
        cascade_queue_depth_max_per_topic: 2,
      }),
    });
    // 3 candidates, cap 2, current depth 0 → headroom 2, fan-out 3 →
    // skip entirely; report dropped = 1 (governor returns admitted: 2,
    // dropped: 1 against desired: 3).
    const r = cascade.cascadeForExternalContextPulseChange('thing');
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
    expect(r.rows_queue_depth_capped).toBe(1);
    // Verify no rows were partially enqueued.
    const lapCount = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM data_enrichment WHERE lifecycle_action_pending IS NOT NULL`,
      )
      .get() as { n: number }).n;
    expect(lapCount).toBe(0);
  });

  it('idempotent on re-fire — second call enqueues 0', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: { purpose: 'inquiry', confidence: 0.5 },
    });
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'thing', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const cascade = createEnrichmentCascade(store, { externalContextRegistry: reg });
    const r1 = cascade.cascadeForExternalContextPulseChange('thing');
    expect(r1.rows_lifecycle_action_enqueued).toBe(1);
    const r2 = cascade.cascadeForExternalContextPulseChange('thing');
    // Already enqueued → enqueueLifecycleActionForTopic SQL filter
    // (`IS NULL`) skips → 0 changes.
    expect(r2.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('fires the cascade notifier with reason: external_context_pulse_change', () => {
    const reg = createExternalContextDependencyRegistry();
    reg.add('purpose', [
      { id: 'ctx', pulse_provider: 'mcp_tool', invalidates_on_pulse_change: true },
    ]);
    const hints: Array<{ source_id?: string; reason: string }> = [];
    const cascade = createEnrichmentCascade(store, {
      externalContextRegistry: reg,
      notifier: (h): void => {
        hints.push({
          ...(h.source_id !== undefined ? { source_id: h.source_id } : {}),
          reason: h.reason,
        });
      },
    });
    cascade.cascadeForExternalContextPulseChange('ctx');
    expect(hints).toEqual([
      { source_id: 'ctx', reason: 'external_context_pulse_change' },
    ]);
  });
});
