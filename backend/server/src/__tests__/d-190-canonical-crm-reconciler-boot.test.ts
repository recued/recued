/** D-190 (generic reconciler MS4) — wireCanonicalCrmReconciliation boot tests.
 *
 *  The generic glue: scan bound api connections + register a generic
 *  `buildCanonicalCrmReconciler` housekeeping task per `(vendor, crm_alias-entity,
 *  connection)` — but ONLY for vendors with NO bespoke reconciler. Proven against
 *  the REAL housekeeping + reconciler registries with a fake connection store. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeVendorEntityScope,
  type ConnectionKind,
  type ConnectionRow,
  type ConnectionVendorEntity,
  type EnrichmentScope,
} from '@recued/contracts';

import { wireCanonicalCrmReconciliation } from '../data/canonical-crm-reconciler-boot.js';
import type { CanonicalPollDeps } from '../watch/canonical-poll.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
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
      return () => { /* unsubscribe unused in tests */ };
    },
    addOnDelete: (h: (kind: ConnectionKind, name: string) => void) => {
      deleteHooks.push(h);
      return () => { /* noop */ };
    },
    _add: (r: ConnectionRow) => rows.set(r.name, r),
    _remove: (name: string) => rows.delete(name),
    _fireUpsert: (r: ConnectionRow) => upsertHooks.forEach((h) => h(r)),
    _fireDelete: (kind: ConnectionKind, name: string) => deleteHooks.forEach((h) => h(kind, name)),
  } as unknown as FakeStore;
};

const crmEntity = (vendor: string, entity: string, crm_alias: 'deal' | 'contact' | 'account'): ConnectionVendorEntity =>
  ({ vendor, entity, crm_alias, scope: composeVendorEntityScope(vendor, entity), meta_fields: {} }) as unknown as ConnectionVendorEntity;

const nonCrmEntity = (vendor: string, entity: string): ConnectionVendorEntity =>
  ({ vendor, entity, scope: composeVendorEntityScope(vendor, entity), meta_fields: {} }) as unknown as ConnectionVendorEntity;

const FAKE_POLL_DEPS = {} as unknown as CanonicalPollDeps;
const noPriorHashes = (_s: EnrichmentScope): Map<string, string> => new Map();
const lookup: ConnectionLookup = () => null;

const wire = (store: ConnectionStoreSqlite, registry: ConnectionVendorEntity[]): void =>
  wireCanonicalCrmReconciliation({
    connectionStore: store,
    lookupConnection: lookup,
    pollDeps: FAKE_POLL_DEPS,
    getPriorHashes: noPriorHashes,
    resolveRegistry: () => registry,
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

describe('D-190 MS4 — wireCanonicalCrmReconciliation', () => {
  const PIPEDRIVE_REGISTRY = [
    crmEntity('pipedrive', 'deal', 'deal'),
    crmEntity('pipedrive', 'contact', 'contact'),
    nonCrmEntity('pipedrive', 'activity'), // NOT a CRM entity — must be skipped
  ];

  it('registers a generic task per crm_alias entity for a bound pack CRM connection', () => {
    wire(fakeConnectionStore([row('acme-pipedrive', 'pipedrive')]), PIPEDRIVE_REGISTRY);
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'acme-pipedrive'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'contact', 'acme-pipedrive'))).toBeDefined();
    // The non-CRM entity is NOT reconciled.
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'activity', 'acme-pipedrive'))).toBeUndefined();
  });

  it('SKIPS a vendor that already has a bespoke reconciler (no double-drive)', () => {
    // A bespoke hubspot.deal reconciler is registered first (as composeVendorSubstrate does).
    const bespoke: VendorReconciler = {
      vendor: 'hubspot', entity: 'deal', default_cadence: '6h',
      async *listUpdatedSince() { /* empty */ },
      hashOf: () => 'h', toMeta: () => ({ snapshot_at: 1, snapshot_hash: 'h' }),
    };
    registerVendorReconciler(bespoke);

    wire(fakeConnectionStore([row('acme-hubspot', 'hubspot')]), [crmEntity('hubspot', 'deal', 'deal')]);
    // The generic boot did NOT register its own hubspot.deal task (the bespoke
    // vendor boot owns that connection's reconciliation).
    expect(getHousekeepingTask(reconciliationTaskId('hubspot', 'deal', 'acme-hubspot'))).toBeUndefined();
  });

  it('registers nothing for a connection whose vendor declares no crm_alias entity', () => {
    wire(fakeConnectionStore([row('acme-linear', 'linear')]), [nonCrmEntity('linear', 'issue')]);
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('registers nothing when the vendor cannot be resolved (no vendor in config)', () => {
    const bad = { ...row('mystery', 'x'), config_json: '{}' } as ConnectionRow;
    wire(fakeConnectionStore([bad]), PIPEDRIVE_REGISTRY);
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('addOnUpsert registers tasks for a newly-enrolled CRM connection', () => {
    const store = fakeConnectionStore([]);
    wire(store, PIPEDRIVE_REGISTRY);
    expect(listHousekeepingTasks()).toHaveLength(0); // nothing enrolled yet

    const r = row('new-pipedrive', 'pipedrive');
    store._add(r);
    store._fireUpsert(r);
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'new-pipedrive'))).toBeDefined();
  });

  it('a SECOND connection of the same vendor reuses the reconciler + registers its own task', () => {
    const store = fakeConnectionStore([row('pd-1', 'pipedrive')]);
    wire(store, PIPEDRIVE_REGISTRY);
    const r2 = row('pd-2', 'pipedrive');
    store._add(r2);
    store._fireUpsert(r2);
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'pd-1'))).toBeDefined();
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'pd-2'))).toBeDefined();
  });

  it('addOnDelete deregisters the generic tasks for the removed connection', () => {
    const store = fakeConnectionStore([row('acme-pipedrive', 'pipedrive')]);
    wire(store, PIPEDRIVE_REGISTRY);
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'acme-pipedrive'))).toBeDefined();

    store._remove('acme-pipedrive');
    store._fireDelete('api', 'acme-pipedrive');
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'deal', 'acme-pipedrive'))).toBeUndefined();
    expect(getHousekeepingTask(reconciliationTaskId('pipedrive', 'contact', 'acme-pipedrive'))).toBeUndefined();
  });

  it('is idempotent — re-wiring does not throw or double-register a task', () => {
    const store = fakeConnectionStore([row('acme-pipedrive', 'pipedrive')]);
    wire(store, PIPEDRIVE_REGISTRY);
    // A second wire (e.g. a re-scan) over the same registry: the reconciler
    // registry de-dupes + getHousekeepingTask guards the task.
    expect(() => wire(store, PIPEDRIVE_REGISTRY)).not.toThrow();
    expect(
      listHousekeepingTasks().filter(
        (t) => t.meta.id === reconciliationTaskId('pipedrive', 'deal', 'acme-pipedrive'),
      ),
    ).toHaveLength(1);
  });
});
