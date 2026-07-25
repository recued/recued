/** D-192 S4c2 — wireGenericEngagementReconciliation boot tests.
 *
 *  The generic engagement glue: scan bound api connections + register a generic
 *  `buildGenericEngagementReconciler` housekeeping task per `(vendor,
 *  delta_cursor-engagement-entity, connection)` — but ONLY for vendors with a
 *  registered leaf AND no bespoke reconciler AND `sync_kind: 'delta_cursor'`.
 *  Mirrors the D-190 canonical-CRM boot test against the REAL housekeeping +
 *  reconciler registries with a fake connection store. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeVendorEntityScope,
  type ConnectionKind,
  type ConnectionRow,
  type ConnectionVendorEntity,
} from '@recued/contracts';

import { wireGenericEngagementReconciliation } from '../data/generic-engagement-reconciler-boot.js';
import type { GenericEngagementLeaf } from '../data/generic-engagement-reconciler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EngagementStore } from '../storage/engagement-store.js';
import type { ConnectionLookup, VendorReconciler } from '../housekeeping/reconciliation/vendor-reconciler.js';
import { reconciliationTaskId } from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
  listHousekeepingTasks,
} from '../housekeeping/registry.js';
import {
  clearDefaultReconcilerRegistry,
  registerVendorReconciler,
} from '../housekeeping/reconciliation/reconciler-registry.js';

// ────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────

const row = (name: string, vendor: string): ConnectionRow =>
  ({
    pk: `api:${name}`,
    kind: 'api',
    name,
    display_name: name,
    config_json: JSON.stringify({ vendor }),
    auth_ciphertext: '',
    enrolled_at: 1,
    updated_at: 1,
  }) as ConnectionRow;

interface FakeStore extends ConnectionStoreSqlite {
  _fireUpsert(r: ConnectionRow): void;
  _fireDelete(kind: ConnectionKind, name: string): void;
  _add(r: ConnectionRow): void;
  _remove(name: string): void;
}

const fakeConnectionStore = (initial: ConnectionRow[]): FakeStore => {
  const rows = new Map(initial.map((r) => [r.name, r]));
  const upsertHooks: Array<(r: ConnectionRow) => void> = [];
  const deleteHooks: Array<(kind: ConnectionKind, name: string) => void> = [];
  return {
    get: (_kind: ConnectionKind, name: string) => rows.get(name) ?? null,
    list: () => [...rows.values()],
    addOnUpsert: (h: (r: ConnectionRow) => void) => {
      upsertHooks.push(h);
      return () => {};
    },
    addOnDelete: (h: (kind: ConnectionKind, name: string) => void) => {
      deleteHooks.push(h);
      return () => {};
    },
    _add: (r: ConnectionRow) => rows.set(r.name, r),
    _remove: (name: string) => rows.delete(name),
    _fireUpsert: (r: ConnectionRow) => upsertHooks.forEach((h) => h(r)),
    _fireDelete: (kind: ConnectionKind, name: string) => deleteHooks.forEach((h) => h(kind, name)),
  } as unknown as FakeStore;
};

const engagementEntity = (
  vendor: string,
  entity: string,
  sync_kind: 'delta_cursor' | 'poll' | 'stream',
): ConnectionVendorEntity =>
  ({
    vendor,
    entity,
    scope: composeVendorEntityScope(vendor, entity),
    display_name: `${vendor} ${entity}`,
    meta_fields: [],
    engagement: { capability: 'always', sync_kind },
  }) as unknown as ConnectionVendorEntity;

const plainEntity = (vendor: string, entity: string): ConnectionVendorEntity =>
  ({ vendor, entity, scope: composeVendorEntityScope(vendor, entity), meta_fields: [] }) as unknown as ConnectionVendorEntity;

const STUB_ENGAGEMENT_STORE = {} as unknown as EngagementStore;
// Construction reads only `entity.engagement.sync_kind` + wires closures — it never
// calls a leaf method — so a bare stub suffices for the boot's registration tests.
const STUB_LEAF = {} as unknown as GenericEngagementLeaf;
const lookup: ConnectionLookup = () => null;

const wire = (
  store: ConnectionStoreSqlite,
  registry: ConnectionVendorEntity[],
  resolveLeaf: (e: ConnectionVendorEntity) => GenericEngagementLeaf | undefined = () => STUB_LEAF,
): void =>
  wireGenericEngagementReconciliation({
    connectionStore: store,
    lookupConnection: lookup,
    engagementStore: STUB_ENGAGEMENT_STORE,
    resolveRegistry: () => registry,
    resolveLeaf,
    now: () => 1,
  });

beforeEach(() => {
  clearDefaultHousekeepingRegistry();
  clearDefaultReconcilerRegistry();
});
afterEach(() => {
  clearDefaultHousekeepingRegistry();
  clearDefaultReconcilerRegistry();
});

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-192 S4c2 — wireGenericEngagementReconciliation', () => {
  const DELTA_REGISTRY = [
    engagementEntity('dynamics', 'email', 'delta_cursor'),
    engagementEntity('dynamics', 'appointment', 'delta_cursor'),
    plainEntity('dynamics', 'contact'), // NOT an engagement entity — must be skipped
  ];

  it('registers a generic task per delta_cursor engagement entity for a bound pack connection', () => {
    wire(fakeConnectionStore([row('acme-dynamics', 'dynamics')]), DELTA_REGISTRY);
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'acme-dynamics'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'appointment', 'acme-dynamics'))).toBeDefined();
    // The non-engagement entity is NOT reconciled.
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'contact', 'acme-dynamics'))).toBeUndefined();
  });

  it('SKIPS a non-delta engagement entity (poll / stream ride bespoke / other paths)', () => {
    const REG = [
      engagementEntity('hubspotish', 'email', 'poll'),
      engagementEntity('sfish', 'task', 'stream'),
    ];
    wire(fakeConnectionStore([row('c-poll', 'hubspotish'), row('c-stream', 'sfish')]), REG);
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('SKIPS an entity whose vendor has no registered leaf (declared but not reconcilable)', () => {
    wire(
      fakeConnectionStore([row('acme-dynamics', 'dynamics')]),
      DELTA_REGISTRY,
      () => undefined, // no leaf for this vendor
    );
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('SKIPS a vendor that already has a bespoke reconciler (no double-drive)', () => {
    const bespoke: VendorReconciler = {
      vendor: 'dynamics',
      entity: 'email',
      default_cadence: '6h',
      async *listUpdatedSince() {},
      hashOf: () => 'h',
      toMeta: () => ({ snapshot_at: 1, snapshot_hash: 'h' }),
    };
    registerVendorReconciler(bespoke);

    wire(fakeConnectionStore([row('acme-dynamics', 'dynamics')]), [engagementEntity('dynamics', 'email', 'delta_cursor')]);
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'acme-dynamics'))).toBeUndefined();
  });

  it('registers nothing for a connection whose vendor declares no delta engagement entity', () => {
    wire(fakeConnectionStore([row('acme-linear', 'linear')]), [plainEntity('linear', 'issue')]);
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('registers nothing when the vendor cannot be resolved (no vendor in config)', () => {
    const bad = { ...row('mystery', 'x'), config_json: '{}' } as ConnectionRow;
    wire(fakeConnectionStore([bad]), DELTA_REGISTRY);
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('addOnUpsert registers tasks for a newly-enrolled delta engagement connection', () => {
    const store = fakeConnectionStore([]);
    wire(store, DELTA_REGISTRY);
    expect(listHousekeepingTasks()).toHaveLength(0);

    const r = row('new-dynamics', 'dynamics');
    store._add(r);
    store._fireUpsert(r);
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'new-dynamics'))).toBeDefined();
  });

  it('a SECOND connection of the same vendor reuses the reconciler + registers its own task', () => {
    const store = fakeConnectionStore([row('d-1', 'dynamics')]);
    wire(store, DELTA_REGISTRY);
    const r2 = row('d-2', 'dynamics');
    store._add(r2);
    store._fireUpsert(r2);
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'd-1'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'd-2'))).toBeDefined();
  });

  it('addOnDelete deregisters the generic tasks for the removed connection', () => {
    const store = fakeConnectionStore([row('acme-dynamics', 'dynamics')]);
    wire(store, DELTA_REGISTRY);
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'acme-dynamics'))).toBeDefined();

    store._remove('acme-dynamics');
    store._fireDelete('api', 'acme-dynamics');
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'email', 'acme-dynamics'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('dynamics', 'appointment', 'acme-dynamics'))).toBeUndefined();
  });

  it('is idempotent — re-wiring does not throw or double-register a task', () => {
    const store = fakeConnectionStore([row('acme-dynamics', 'dynamics')]);
    wire(store, DELTA_REGISTRY);
    expect(() => wire(store, DELTA_REGISTRY)).not.toThrow();
    expect(
      listHousekeepingTasks().filter(
        (t) => t.meta.id === reconciliationTaskId('dynamics', 'email', 'acme-dynamics'),
      ),
    ).toHaveLength(1);
  });
});
