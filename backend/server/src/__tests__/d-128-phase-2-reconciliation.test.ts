/** D-128 Phase 2 — Reconciliation harness tests.
 *
 *  Covers:
 *  - `EnrichmentStore.listByTarget` + `refreshMetaForTarget` helpers.
 *  - `bridgeEnrichmentCascade` widened to platform-reference scopes.
 *  - `VendorReconciler` interface + `buildVendorReconciliationTask`
 *    harness — cursor advance, hash skip, synthetic event shape,
 *    idempotent re-run, delete propagation, cascade integration via
 *    a stub reconciler.
 *  - `ReconcilerRegistry` register / get / list / clear semantics. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { WarehouseEvent } from '@recued/warehouse-events';
import {
  composeVendorEntityScope,
  MetaSnapshotTooLargeError,
  PLATFORM_REFERENCE_META_MAX_BYTES,
  type ConnectionRecord,
  type EnrichmentMeta,
  type EnrichmentScope,
} from '@recued/contracts';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { bridgeEnrichmentCascade } from '../events/emit-sites.js';
import {
  buildVendorReconciliationTask,
  reconciliationTaskId,
  type SlimRecord,
  type VendorReconciler,
  type ConnectionLookup,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { VendorRateGate, RateGateLease } from '../housekeeping/reconciliation/vendor-rate-gate.js';
import {
  createReconcilerRegistry,
  registerVendorReconciler,
  getVendorReconciler,
  listVendorReconcilers,
  clearDefaultReconcilerRegistry,
} from '../housekeeping/reconciliation/reconciler-registry.js';

import type { HousekeepingContext } from '../housekeeping/registry.js';
import type { EnrichmentRowSnapshot } from '@recued/transforms';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-128-p2-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  clearDefaultReconcilerRegistry();
});

const validRollup = {
  interaction_count: 1,
  last_interaction: 1,
  recent_subjects: ['x'],
  cursor_at: 1,
  window_ms: 30 * 24 * 60 * 60 * 1000,
};

const sampleMeta = (
  hash = 'fnv1a:abc',
  name = 'Acme Q3 Expansion',
): EnrichmentMeta => ({
  snapshot_at: 1730294400000,
  snapshot_hash: hash,
  name,
  status: 'negotiation',
  amount: 50000,
});

const sampleConnection = (name = 'acme-hubspot'): ConnectionRecord => ({
  name,
  kind: 'api',
  display_name: name,
  config: { base_url: 'https://api.hubapi.com' },
  auth: { type: 'bearer', token: 'pat-token' },
  enrolled_at: 1,
  updated_at: 1,
});

const makeBus = () => {
  const events: WarehouseEvent[] = [];
  const bus = createWarehouseEventBus();
  bus.subscribe('**', (ev) => {
    events.push(ev);
  });
  return { bus, events };
};

interface StubVendorOptions {
  vendor?: string;
  entity?: string;
  records?: ReadonlyArray<SlimRecord>;
  deletions?: ReadonlyArray<string>;
  withDeletions?: boolean;
}

const makeStubReconciler = (opts: StubVendorOptions = {}): VendorReconciler & {
  hashCalls: number;
  metaCalls: number;
  listUpdatedCalls: Array<{ cursor: number; limit: number }>;
} => {
  const vendor = opts.vendor ?? 'hubspot';
  const entity = opts.entity ?? 'deal';
  const records = opts.records ?? [];
  const deletions = opts.deletions ?? [];
  const wantDeletions = opts.withDeletions ?? deletions.length > 0;

  const recon: VendorReconciler & {
    hashCalls: number;
    metaCalls: number;
    listUpdatedCalls: Array<{ cursor: number; limit: number }>;
  } = {
    vendor,
    entity,
    default_cadence: '6h',
    hashCalls: 0,
    metaCalls: 0,
    listUpdatedCalls: [],
    async *listUpdatedSince(_conn, cursor, limit) {
      recon.listUpdatedCalls.push({ cursor, limit });
      for (const r of records) {
        if (r.modified_at > cursor) yield r;
      }
    },
    hashOf(record) {
      recon.hashCalls += 1;
      return `fnv1a:${record.id}-${record.modified_at}`;
    },
    toMeta(record) {
      recon.metaCalls += 1;
      return {
        snapshot_at: record.modified_at,
        snapshot_hash: `fnv1a:${record.id}-${record.modified_at}`,
        name: `Record ${record.id}`,
      };
    },
  };

  if (wantDeletions) {
    recon.listDeletedSince = async function* (_conn, _cursor) {
      for (const id of deletions) yield id;
    };
  }

  return recon;
};

const makeContext = (overrides: Partial<HousekeepingContext> = {}): HousekeepingContext => {
  const wb = createWarehouseEventBus();
  return {
    db,
    bus: wb,
    enrichmentStore: store,
    recipeStore: {
      // tests don't touch the recipe store; the harness only reads
      // enrichmentStore + bus + now(). Cast through unknown so the
      // unused fields don't force a full stub.
    } as unknown as HousekeepingContext['recipeStore'],
    now: (): number => 2_000_000_000_000,
    emitAuditRow: () => {},
    ...overrides,
  };
};

// ────────────────────────────────────────────────────────────────
// listByTarget + refreshMetaForTarget
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — listByTarget', () => {
  it('returns rows ordered newest-first across topics', () => {
    const scope: EnrichmentScope = 'contact';
    const target = 'bob@x.com';
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope,
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.r1',
      meta: sampleMeta('fnv1a:first'),
    });
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope,
      target_id: target,
      value: { ...validRollup, interaction_count: 9 },
      authored_by: 'recipe.r1',
      meta: sampleMeta('fnv1a:second'),
    });

    const rows = store.listByTarget(scope, target);
    expect(rows.length).toBe(1); // upsert collapses to one row per (topic, scope, target, author)
    expect(rows[0]!.meta?.snapshot_hash).toBe('fnv1a:second');
  });

  it('filters by scope + target_id strictly', () => {
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'bob@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: 'alice@x.com',
      value: validRollup,
      authored_by: 'recipe.r',
    });

    expect(store.listByTarget('contact', 'bob@x.com')).toHaveLength(1);
    expect(store.listByTarget('contact', 'unknown@x.com')).toHaveLength(0);
  });

  it('returns empty for an unknown (scope, target_id) pair', () => {
    expect(
      store.listByTarget(
        'connection.api.hubspot.deal' as EnrichmentScope,
        'hubspot_deal_47291',
      ),
    ).toHaveLength(0);
  });
});

describe('D-128 P2 — refreshMetaForTarget', () => {
  it('bulk-updates meta on every row for (scope, target_id) and returns count', () => {
    const scope: EnrichmentScope = 'contact';
    const target = 'bob@x.com';
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope,
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.r1',
      meta: sampleMeta('fnv1a:old'),
    });
    const updated = store.refreshMetaForTarget(scope, target, sampleMeta('fnv1a:new'));
    expect(updated).toBe(1);
    const rows = store.listByTarget(scope, target);
    expect(rows[0]!.meta?.snapshot_hash).toBe('fnv1a:new');
  });

  it('returns 0 when no row matches', () => {
    expect(
      store.refreshMetaForTarget('contact', 'nobody@x.com', sampleMeta()),
    ).toBe(0);
  });

  it('throws MetaSnapshotTooLargeError on oversize meta + leaves rows untouched', () => {
    const scope: EnrichmentScope = 'contact';
    const target = 'bob@x.com';
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope,
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.r',
      meta: sampleMeta('fnv1a:keep'),
    });
    const oversized: EnrichmentMeta = {
      snapshot_at: 1,
      snapshot_hash: 'fnv1a:big',
      bloat: 'x'.repeat(PLATFORM_REFERENCE_META_MAX_BYTES + 100),
    };
    expect(() => store.refreshMetaForTarget(scope, target, oversized))
      .toThrow(MetaSnapshotTooLargeError);
    expect(store.listByTarget(scope, target)[0]!.meta?.snapshot_hash).toBe('fnv1a:keep');
  });

  it('a producer re-upsert WITHOUT meta does not clobber the reconciler snapshot (the meta-sourced-alert race)', () => {
    // The production clobber path end-to-end: a producer creates the row
    // (no meta) → the reconciler snapshots the source record onto it via
    // refreshMetaForTarget → the producer re-derives `value` on the next
    // event and upserts again WITHOUT meta. Before the COALESCE fix, that
    // re-upsert NULLed the snapshot, so a meta-reading alert firing on the
    // same event saw no amount/name. The snapshot must survive.
    const scope: EnrichmentScope = 'contact';
    const target = 'bob@x.com';
    // 1. Producer first write — value only, no meta (a fresh producer row).
    store.upsert({
      topic: 'contact_timeline_rollup', scope, target_id: target,
      value: validRollup, authored_by: 'recipe.producer',
    });
    expect(store.listByTarget(scope, target)[0]!.meta).toBeNull();
    // 2. Reconciler snapshots the record onto the row.
    expect(store.refreshMetaForTarget(scope, target, sampleMeta('fnv1a:snap'))).toBe(1);
    // 3. Producer re-derives + re-upserts, still no meta.
    store.upsert({
      topic: 'contact_timeline_rollup', scope, target_id: target,
      value: { ...validRollup, interaction_count: 9 }, authored_by: 'recipe.producer',
    });
    // The snapshot survives AND the re-derived value landed.
    const row = store.listByTarget(scope, target)[0]!;
    expect(row.meta?.snapshot_hash).toBe('fnv1a:snap');
    expect((row.value as { interaction_count: number }).interaction_count).toBe(9);
  });
});

// ────────────────────────────────────────────────────────────────
// bridgeEnrichmentCascade — platform-reference widening
// ────────────────────────────────────────────────────────────────

const stubCascade = () => {
  const updates: Array<[EnrichmentScope, string]> = [];
  const deletes: Array<[EnrichmentScope, string]> = [];
  return {
    updates,
    deletes,
    cascadeForSourceUpdate: (scope: EnrichmentScope, id: string) => {
      updates.push([scope, id]);
      return null;
    },
    cascadeForSourceDelete: (scope: EnrichmentScope, id: string) => {
      deletes.push([scope, id]);
      return null;
    },
  };
};

describe('D-128 P2 — bridgeEnrichmentCascade widens for platform-reference scopes', () => {
  it('fires cascadeForSourceUpdate on `updated` for connection.api.<vendor>.<entity>', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'connection.api.hubspot.deal',
      slug: 'acme',
      entity_type: 'deal',
      event_kind: 'updated',
      record_id: 'hubspot_deal_47291',
      at: 1,
    });
    expect(cascade.updates).toEqual([
      ['connection.api.hubspot.deal', 'hubspot_deal_47291'],
    ]);
    expect(cascade.deletes).toEqual([]);
  });

  it('fires cascadeForSourceUpdate on `created` for platform-reference (first sighting)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'connection.api.hubspot.deal',
      slug: 'acme',
      entity_type: 'deal',
      event_kind: 'created',
      record_id: 'hubspot_deal_new',
      at: 1,
    });
    expect(cascade.updates).toEqual([
      ['connection.api.hubspot.deal', 'hubspot_deal_new'],
    ]);
  });

  it('fires cascadeForSourceDelete on `deleted` for platform-reference', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'connection.api.hubspot.deal',
      slug: 'acme',
      entity_type: 'deal',
      event_kind: 'deleted',
      record_id: 'hubspot_deal_47291',
      at: 1,
    });
    expect(cascade.deletes).toEqual([
      ['connection.api.hubspot.deal', 'hubspot_deal_47291'],
    ]);
  });

  it('does NOT fire cascadeForSourceUpdate on `created` for closed-list scopes (pre-D-128 behavior preserved)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'msg-1',
      at: 1,
    });
    expect(cascade.updates).toEqual([]);
  });

  it('rejects non-scope platforms (random string isn\'t a platform-reference)', () => {
    const cascade = stubCascade();
    const bus = createWarehouseEventBus();
    bridgeEnrichmentCascade(bus, cascade);
    bus.emit({
      platform: 'random',
      slug: 'x',
      entity_type: 'thing',
      event_kind: 'updated',
      record_id: 'r-1',
      at: 1,
    });
    expect(cascade.updates).toEqual([]);
    expect(cascade.deletes).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// buildVendorReconciliationTask — meta + task id + cursor + idempotency
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — buildVendorReconciliationTask basic shape', () => {
  it('produces a task with id `reconciliation.<vendor>.<entity>.<connection_name>`', () => {
    const recon = makeStubReconciler();
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme-hubspot',
      lookupConnection: () => sampleConnection('acme-hubspot'),
    });
    expect(task.meta.id).toBe('reconciliation.hubspot.deal.acme-hubspot');
    expect(task.meta.kind).toBe('core');
    expect(task.meta.interruptible).toBe(true);
    expect(task.meta.idle_eligible).toBe(true);
  });

  it('reconciliationTaskId helper composes the canonical id', () => {
    expect(reconciliationTaskId('hubspot', 'deal', 'acme'))
      .toBe('reconciliation.hubspot.deal.acme');
  });
});

// ────────────────────────────────────────────────────────────────
// step() — happy path: hash diff fires events + advances cursor
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — step() emits events on hash diff + advances cursor', () => {
  it('first sighting emits `created` (no existing rows) and advances cursor to max(modified_at)', async () => {
    const records: SlimRecord[] = [
      { id: 'deal-1', modified_at: 1_000 },
      { id: 'deal-2', modified_at: 2_000 },
    ];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    const result = await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 2_000 });
    expect(events).toHaveLength(2);
    expect(events[0]!.event_kind).toBe('created');
    expect(events[0]!.platform).toBe('connection.api.hubspot.deal');
    expect(events[0]!.record_id).toBe('deal-1');
    expect(events[0]!.slug).toBe('acme');
    expect(events[1]!.record_id).toBe('deal-2');
  });

  it('hash match (existing row carries same snapshot_hash) skips emit + does not refresh meta', async () => {
    const scope: EnrichmentScope = 'connection.api.hubspot.deal';
    const target = 'deal-1';
    const stableHash = 'fnv1a:deal-1-1500';
    // Pre-existing row with the same hash the reconciler will compute.
    store.upsert({
      topic: 'contact_timeline_rollup',  // borrow a real topic; the harness reads meta only
      scope: 'contact',
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.x',
      meta: { snapshot_at: 1, snapshot_hash: stableHash, name: 'old name' },
    });
    // Repoint that row at the platform-ref scope so listByTarget finds it.
    db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(scope, target);

    const records: SlimRecord[] = [{ id: target, modified_at: 1_500 }];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    const result = await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(result.status).toBe('complete');
    expect(events).toHaveLength(0);
    // Meta still says "old name" (no refresh).
    const rows = store.listByTarget(scope, target);
    expect(rows[0]!.meta?.name).toBe('old name');
  });

  it('hash diff with existing rows refreshes meta + emits `updated`', async () => {
    const scope: EnrichmentScope = 'connection.api.hubspot.deal';
    const target = 'deal-1';
    store.upsert({
      topic: 'contact_timeline_rollup',
      scope: 'contact',
      target_id: target,
      value: validRollup,
      authored_by: 'recipe.x',
      meta: { snapshot_at: 1, snapshot_hash: 'fnv1a:stale', name: 'old name' },
    });
    db.prepare('UPDATE data_enrichment SET scope = ? WHERE target_id = ?').run(scope, target);

    const records: SlimRecord[] = [{ id: target, modified_at: 9_000 }];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);

    expect(events).toHaveLength(1);
    expect(events[0]!.event_kind).toBe('updated');
    expect(events[0]!.record_id).toBe(target);

    const rows = store.listByTarget(scope, target);
    expect(rows[0]!.meta?.snapshot_hash).toBe(`fnv1a:${target}-9000`);
    expect(rows[0]!.meta?.name).toBe(`Record ${target}`);
  });

  it('idempotent re-run after cursor advance does no work', async () => {
    const records: SlimRecord[] = [
      { id: 'deal-1', modified_at: 1_000 },
      { id: 'deal-2', modified_at: 2_000 },
    ];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    const r1 = await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(events).toHaveLength(2);
    events.length = 0;

    // Re-run from advanced cursor — the stub gates `r.modified_at > cursor`
    // so nothing yields.
    const r2 = await task.step(ctx, r1.cursor, 60_000);
    expect(r2.status).toBe('complete');
    expect(r2.cursor).toEqual({ kind: 'time', last_seen_at: 2_000 });
    expect(events).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// step() — yield paths
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — step() yield paths', () => {
  it('connection lookup returning null yields with `no_work` and preserves cursor', async () => {
    const recon = makeStubReconciler();
    const lookup: ConnectionLookup = () => null;
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'unknown',
      lookupConnection: lookup,
    });
    const ctx = makeContext();

    const result = await task.step(ctx, { kind: 'time', last_seen_at: 5_000 }, 60_000);
    expect(result.status).toBe('yield');
    expect((result as { reason: string }).reason).toBe('no_work');
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 5_000 });
  });

  // ── D-184 — the shared VendorRateGate is consulted per step ──
  it('yields vendor_budget_suspended WITHOUT pulling when the gate is suspended', async () => {
    const recon = makeStubReconciler({ records: [{ id: 'deal-1', modified_at: 1_000 }] });
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    const gate: VendorRateGate = { acquire: () => 'suspended' };
    const result = await task.step(makeContext({ rateGate: gate }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('yield');
    expect((result as { reason: string }).reason).toBe('vendor_budget_suspended');
    expect(recon.listUpdatedCalls).toHaveLength(0); // never pulled the vendor API
  });

  it('yields vendor_pull_in_flight WITHOUT pulling when the gate reports busy', async () => {
    const recon = makeStubReconciler({ records: [{ id: 'deal-1', modified_at: 1_000 }] });
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    const gate: VendorRateGate = { acquire: () => 'busy' };
    const result = await task.step(makeContext({ rateGate: gate }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('yield');
    expect((result as { reason: string }).reason).toBe('vendor_pull_in_flight');
    expect(recon.listUpdatedCalls).toHaveLength(0);
  });

  it('records api_calls/pages (keyed by connection name + vendor) + releases the lease after a pull', async () => {
    const recon = makeStubReconciler({
      records: [{ id: 'deal-1', modified_at: 1_000 }, { id: 'deal-2', modified_at: 2_000 }],
    });
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    const recorded: Array<{ api_calls: number; entity: string; pages: number }> = [];
    let released = 0;
    const lease: RateGateLease = {
      record: (i) => recorded.push({ api_calls: i.api_calls, entity: i.entity, pages: i.pages }),
      release: () => { released += 1; },
    };
    const acquireArgs: Array<{ connection_id: string; vendor: string }> = [];
    const gate: VendorRateGate = {
      acquire: (i) => { acquireArgs.push({ connection_id: i.connection_id, vendor: i.vendor }); return lease; },
    };
    const result = await task.step(makeContext({ rateGate: gate }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');
    expect(recon.listUpdatedCalls).toHaveLength(1); // pulled
    expect(acquireArgs).toEqual([{ connection_id: 'acme', vendor: 'hubspot' }]); // keyed by connection NAME
    expect(recorded).toEqual([{ api_calls: 1, entity: 'deal', pages: 1 }]); // 2 records ≤ 1 page
    expect(released).toBe(1);
  });

  it('honors a reconciler apiCallsFor override (HubSpot engagement = pages + processed)', async () => {
    // D-184 — the HubSpot engagement reconcilers make a per-record
    // associations GET on top of the search page, so they override
    // apiCallsFor to `pages + processed` (mirrors the retired runonce
    // runner's api_calls_consumed). SF engagement + record reconcilers
    // keep the default `pages` (proven by the lease test above). This
    // guards the override direction from regressing back to `pages`.
    const records: SlimRecord[] = [
      { id: 'eng-1', modified_at: 1_000 },
      { id: 'eng-2', modified_at: 2_000 },
    ];
    const recon: VendorReconciler = {
      vendor: 'hubspot',
      entity: 'email',
      default_cadence: '6h',
      async *listUpdatedSince(_c, cursor) {
        for (const r of records) if (r.modified_at > cursor) yield r;
      },
      selfIngest: () => { /* engagement write owned by the reconciler */ },
      apiCallsFor: (processed, pages) => pages + processed,
    };
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    const recorded: Array<{ api_calls: number; pages: number }> = [];
    const lease: RateGateLease = {
      record: (i) => recorded.push({ api_calls: i.api_calls, pages: i.pages }),
      release: () => { /* no-op */ },
    };
    const gate: VendorRateGate = { acquire: () => lease };
    const result = await task.step(makeContext({ rateGate: gate }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');
    // 2 records in 1 page → pages=1, api_calls = 1 + 2 = 3 (NOT the default 1).
    expect(recorded).toEqual([{ api_calls: 3, pages: 1 }]);
  });

  it('does NOT gate a non-engagement vendor (no acquire call; pulls ungated)', async () => {
    const recon = makeStubReconciler({ vendor: 'linear', entity: 'issue', records: [{ id: 'x-1', modified_at: 1_000 }] });
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    let acquired = 0;
    const gate: VendorRateGate = { acquire: () => { acquired += 1; return 'suspended'; } };
    const result = await task.step(makeContext({ rateGate: gate }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(acquired).toBe(0); // 'linear' isn't an engagement vendor → ungated
    expect(result.status).toBe('complete');
    expect(recon.listUpdatedCalls).toHaveLength(1);
  });

  // ── D-184 — selfIngest replaces the harness default write ──
  it('calls selfIngest per record INSTEAD of the default write (no warehouse emit)', async () => {
    const records: SlimRecord[] = [
      { id: 'eng-1', modified_at: 1_000 },
      { id: 'eng-2', modified_at: 2_000 },
    ];
    const ingested: string[] = [];
    const recon: VendorReconciler = {
      vendor: 'hubspot',
      entity: 'email',
      default_cadence: '6h',
      async *listUpdatedSince(_c, cursor) {
        for (const r of records) if (r.modified_at > cursor) yield r;
      },
      // no hashOf / toMeta — the engagement shape
      selfIngest: (_conn, name, slim) => { ingested.push(`${name}:${slim.id}`); },
    };
    const task = buildVendorReconciliationTask({
      reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const result = await task.step(makeContext({ bus }), { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(result.status).toBe('complete');
    expect(ingested).toEqual(['acme:eng-1', 'acme:eng-2']); // own write per record
    expect(events).toHaveLength(0); // default hash-diff + bus.emit path NOT taken
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 2_000 }); // cursor still advances
  });

  it('throws at construction when a reconciler has neither selfIngest nor hashOf/toMeta', () => {
    const recon: VendorReconciler = {
      vendor: 'hubspot',
      entity: 'email',
      default_cadence: '6h',
      async *listUpdatedSince() { /* empty */ },
    };
    expect(() =>
      buildVendorReconciliationTask({
        reconciler: recon, connection_name: 'acme', lookupConnection: () => sampleConnection('acme'),
      }),
    ).toThrow(/selfIngest or both hashOf/);
  });

  it('budget exhaustion mid-iteration yields with cursor at last seen modified_at', async () => {
    const records: SlimRecord[] = [
      { id: 'deal-1', modified_at: 1_000 },
      { id: 'deal-2', modified_at: 2_000 },
      { id: 'deal-3', modified_at: 3_000 },
    ];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });

    let nowCallCount = 0;
    const ctx = makeContext({
      now: () => {
        // 1st call (startedAt) → 1_000_000; subsequent budget checks
        // increment by 50 each call, exceeding the 60ms budget after
        // ~2 records.
        const t = 1_000_000 + nowCallCount * 50;
        nowCallCount += 1;
        return t;
      },
    });

    const result = await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60);
    expect(result.status).toBe('yield');
    expect((result as { reason: string }).reason).toBe('budget_exhausted');
    // Cursor advanced to the last record processed before yield.
    expect((result.cursor as { kind: 'time'; last_seen_at: number }).last_seen_at)
      .toBeGreaterThan(0);
  });

  it('cursor with kind != time treats last_seen_at as 0 (defensive)', async () => {
    const records: SlimRecord[] = [{ id: 'deal-1', modified_at: 100 }];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const ctx = makeContext();

    const result = await task.step(ctx, { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    // Cursor reset into `time` shape with the records' max modified_at.
    expect(result.cursor).toEqual({ kind: 'time', last_seen_at: 100 });
  });
});

// ────────────────────────────────────────────────────────────────
// step() — delete propagation
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — step() delete propagation', () => {
  it('emits `deleted` events for every target_id from listDeletedSince', async () => {
    const recon = makeStubReconciler({
      records: [],
      deletions: ['deal-x', 'deal-y'],
    });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);

    const deleted = events.filter((e) => e.event_kind === 'deleted');
    expect(deleted.map((e) => e.record_id)).toEqual(['deal-x', 'deal-y']);
    expect(deleted[0]!.platform).toBe('connection.api.hubspot.deal');
  });

  it('reconciler without listDeletedSince hook produces zero delete events', async () => {
    const recon = makeStubReconciler({ records: [], withDeletions: false });
    expect(recon.listDeletedSince).toBeUndefined();
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const { bus, events } = makeBus();
    const ctx = makeContext({ bus });

    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(events).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Cascade integration round-trip via stub reconciler
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — cascade integration round-trip', () => {
  it('reconciliation `updated` event flows through bridgeEnrichmentCascade', async () => {
    const cascade = stubCascade();
    const records: SlimRecord[] = [{ id: 'deal-1', modified_at: 100 }];
    const recon = makeStubReconciler({ records });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });

    const wb = createWarehouseEventBus();
    bridgeEnrichmentCascade(wb, cascade);
    const ctx = makeContext({ bus: wb });

    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    // First sighting emits `created`; bridge promotes to update-cascade
    // for platform-reference scopes.
    expect(cascade.updates).toEqual([
      ['connection.api.hubspot.deal', 'deal-1'],
    ]);
  });

  it('reconciliation `deleted` event flows through to cascadeForSourceDelete', async () => {
    const cascade = stubCascade();
    const recon = makeStubReconciler({ records: [], deletions: ['deal-x'] });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });

    const wb = createWarehouseEventBus();
    bridgeEnrichmentCascade(wb, cascade);
    const ctx = makeContext({ bus: wb });

    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(cascade.deletes).toEqual([
      ['connection.api.hubspot.deal', 'deal-x'],
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// ReconcilerRegistry
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — ReconcilerRegistry', () => {
  it('register / get by scope and by vendor+entity', () => {
    const reg = createReconcilerRegistry();
    const recon = makeStubReconciler();
    reg.register(recon);
    expect(reg.get('connection.api.hubspot.deal' as EnrichmentScope)).toBe(recon);
    expect(reg.getByVendorEntity('hubspot', 'deal')).toBe(recon);
  });

  it('throws on duplicate (vendor, entity) registration', () => {
    const reg = createReconcilerRegistry();
    reg.register(makeStubReconciler());
    expect(() => reg.register(makeStubReconciler())).toThrow(/already registered/);
  });

  it('list returns insertion order; clear empties', () => {
    const reg = createReconcilerRegistry();
    reg.register(makeStubReconciler({ entity: 'deal' }));
    reg.register(makeStubReconciler({ entity: 'contact' }));
    expect(reg.list().map((r) => r.entity)).toEqual(['deal', 'contact']);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
  });

  it('get returns undefined for unknown scope', () => {
    const reg = createReconcilerRegistry();
    expect(reg.get('connection.api.hubspot.deal' as EnrichmentScope)).toBeUndefined();
  });

  it('default registry helpers register / get / list / clear', () => {
    expect(listVendorReconcilers()).toHaveLength(0);
    const recon = makeStubReconciler();
    registerVendorReconciler(recon);
    expect(getVendorReconciler('connection.api.hubspot.deal' as EnrichmentScope)).toBe(recon);
    expect(listVendorReconcilers()).toHaveLength(1);
    clearDefaultReconcilerRegistry();
    expect(listVendorReconcilers()).toHaveLength(0);
  });

  it('rejects malformed vendor/entity at compose-time', () => {
    const reg = createReconcilerRegistry();
    const bad: VendorReconciler = {
      vendor: 'HubSpot',
      entity: 'deal',
      default_cadence: '6h',
      async *listUpdatedSince() {},
      hashOf: () => 'h',
      toMeta: (r) => ({ snapshot_at: 1, snapshot_hash: 'h', id: r.id }),
    };
    expect(() => reg.register(bad)).toThrow(/vendor must match/);
  });
});

// ────────────────────────────────────────────────────────────────
// step() — listUpdatedSince batch_size threading
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — batch_size threads through to listUpdatedSince', () => {
  it('passes the harness-configured batch_size to the reconciler call', async () => {
    const recon = makeStubReconciler({ records: [] });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
      batch_size: 17,
    });
    const ctx = makeContext();
    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(recon.listUpdatedCalls[0]?.limit).toBe(17);
  });

  it('uses PLATFORM_REFERENCE_BATCH_SIZE when not overridden', async () => {
    const recon = makeStubReconciler({ records: [] });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const ctx = makeContext();
    await task.step(ctx, { kind: 'time', last_seen_at: 0 }, 60_000);
    expect(recon.listUpdatedCalls[0]?.limit).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────
// step() — cursor-passing to reconciler
// ────────────────────────────────────────────────────────────────

describe('D-128 P2 — cursor passes to reconciler.listUpdatedSince', () => {
  it('threads the existing cursor.last_seen_at as the cursor argument', async () => {
    const recon = makeStubReconciler({ records: [] });
    const task = buildVendorReconciliationTask({
      reconciler: recon,
      connection_name: 'acme',
      lookupConnection: () => sampleConnection('acme'),
    });
    const ctx = makeContext();
    await task.step(ctx, { kind: 'time', last_seen_at: 12_345 }, 60_000);
    expect(recon.listUpdatedCalls[0]?.cursor).toBe(12_345);
  });
});
