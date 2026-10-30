import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { DEFAULT_COMMITMENT_VIEW_FILTERS, parseSavedDataViewDefinition, sameSavedDataViewDefinition,
  type CommitmentViewFilters, type WorkEntityListRpcRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { handleWorkEntityGet, handleWorkEntityList, handleWorkEntityCommitmentClose, type WorkEntityCrudRpcDeps } from '../work-entity-crud-handler.js';

let db: Database.Database, store: WorkEntityStore, deps: WorkEntityCrudRpcDeps;
beforeEach(() => {
  db = new Database(':memory:'); ensureWorkEntitySchema(db); store = createWorkEntityStore(db);
  for (const id of ['recued.commitment', 'other.commitment']) store.registerSource({ id,
    top_tier_kind: 'commitment', source_kind: 'builtin', source_label: id, write_capable: true });
  const resolver = createWorkEntityResolver(store);
  deps = { store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus: createWarehouseEventBus() }),
    contactDisplay: { getByContactIdResolved: id => id === 'merged-contact' ? { contact_id: 'survivor', name: 'Maya Chen', email: 'maya@example.test' } : null } };
});
afterEach(() => db.close());
const write = (id: string, input: Partial<Parameters<WorkEntityStore['writeCommitment']>[0]> = {}) =>
  store.writeCommitment({ id, statement: id, direction: 'outbound', promised_at: 1000, derivation: 'user_declared', source_id: 'recued.commitment', ...input }, 1000);
const list = (input: Omit<WorkEntityListRpcRequest, 'kind'> = {}) =>
  handleWorkEntityList(deps, { kind: 'commitment', commitment_filter: DEFAULT_COMMITMENT_VIEW_FILTERS, ...input });

describe('Commitment views through the owner RPC and SQLite', () => {
  it('keeps a pending source change intact when a close races the reader snapshot', async () => {
    write('pending-change');
    store.stagePendingWrite('commitment', 'pending-change', { staged_at: 2000, operation: 'update', dirty_fields: ['statement'], state: 'awaiting_verify' });
    const before = store.readCommitment('pending-change');
    for (const outcome of ['fulfilled', 'cancelled'] as const) {
      await expect(handleWorkEntityCommitmentClose(deps, { id: 'pending-change' }, outcome, true)).rejects.toMatchObject({ code: 'bad_request' });
      expect(store.readCommitment('pending-change')).toEqual(before);
    }
    write('closed-change', { lifecycle_state: 'fulfilled' });
    store.stagePendingWrite('commitment', 'closed-change', { staged_at: 2000, operation: 'update', dirty_fields: ['statement'], state: 'awaiting_verify' });
    const closed = store.readCommitment('closed-change');
    await expect(handleWorkEntityCommitmentClose(deps, { id: 'closed-change' }, 'fulfilled', true)).resolves.toMatchObject({ entity: { lifecycle_state: 'fulfilled' } });
    expect(store.readCommitment('closed-change')).toEqual(closed);
  });

  it('searches beyond the first page with literal Unicode and wildcard punctuation, on matching source and totals', async () => {
    for (let i = 0; i < 205; i++) write(`recent-${i}`, { state_changed_at: 5000 + i });
    write('match-a', { statement: 'École_100% proposal', promised_for_at: 3000 });
    write('match-b', { statement: 'Send école_100% invoice', promised_for_at: 4000 });
    write('decoy', { statement: 'ÉcoleX100x proposal' });
    write('other-source', { statement: 'École_100% proposal', source_id: 'other.commitment' });
    const request = { search: '  ÉCOLE_100% ', source_id: 'recued.commitment', limit: 1 };
    const first = await list(request), second = await list({ ...request, offset: 1 });
    expect(first.entities.map(row => row.id)).toEqual(['match-a']);
    expect(second.entities.map(row => row.id)).toEqual(['match-b']);
    expect(first.total).toBe(2); expect(second.total).toBe(2);
    expect((await list({ search: 'ÉCOLE_100%' })).total).toBe(3);
  });

  it('composes direction and lifecycle without treating overdue closed obligations as open', async () => {
    write('owe-late', { due_status: 'overdue', promised_for_at: 500 });
    write('waiting-late', { direction: 'inbound', due_status: 'overdue', promised_for_at: 600 });
    write('owe-soon', { due_status: 'due_soon', promised_for_at: 2000 });
    write('self', { direction: 'internal' });
    for (const lifecycle_state of ['fulfilled', 'cancelled', 'expired'] as const) write(lifecycle_state, { lifecycle_state, due_status: 'overdue' });
    const ids = async (commitment_filter: CommitmentViewFilters) => (await list({ commitment_filter })).entities.map(row => row.id);
    expect(await ids({ direction: 'outbound', status: 'overdue' })).toEqual(['owe-late']);
    expect(await ids({ direction: 'inbound', status: 'open' })).toEqual(['waiting-late']);
    expect(await ids({ direction: 'all', status: 'closed' })).toEqual(['fulfilled', 'cancelled', 'expired']);
    expect((await list({ commitment_filter: { direction: 'internal', status: 'all' } })).total).toBe(1);
  });

  it('orders the full filtered list by lifecycle and deadline with deterministic ties before paging', async () => {
    write('no-date', { state_changed_at: 9000 }); write('b', { promised_for_at: 2000 }); write('a', { promised_for_at: 2000 });
    write('later', { promised_for_at: 3000 }); write('closed', { lifecycle_state: 'fulfilled', promised_for_at: 1 });
    const ids: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const page = await list({ limit: 2, offset }); expect(page.total).toBe(5); ids.push(...page.entities.map(row => row.id));
    }
    expect(ids).toEqual(['a', 'b', 'later', 'no-date', 'closed']);
    expect(store.listCommitments({ limit: 1 })[0]?.id).toBe('no-date');
  });

  it('forward-resolves counterparty display for both list and reader without changing stored identity', async () => {
    write('promise', { counterparty_contact_id: 'merged-contact' });
    const page = await list(), detail = await handleWorkEntityGet(deps, { kind: 'commitment', id: 'promise' });
    expect(page.counterparty_labels).toEqual({ 'merged-contact': 'Maya Chen' });
    expect(detail.counterparty_labels).toEqual(page.counterparty_labels);
    expect(store.readCommitment('promise')?.counterparty_contact_id).toBe('merged-contact');
  });

  it('rejects malformed filters and wrong-kind use instead of broadening the result', async () => {
    for (const value of [null, { direction: 'outbound' }, { direction: 'invented', status: 'open' }, { direction: 'all', status: 'closed', extra: true }]) {
      await expect(list({ commitment_filter: value as never })).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(handleWorkEntityList(deps, { kind: 'task', commitment_filter: DEFAULT_COMMITMENT_VIEW_FILTERS })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(list({ search: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('round-trips saved commitment settings while preserving legacy views and rejecting filters on other kinds', () => {
    const legacy = { tab: 'commitment', query: 'proposal', source_id: null, booking_lifecycle: 'all' } as const;
    expect(parseSavedDataViewDefinition(legacy)).toEqual(legacy);
    expect(sameSavedDataViewDefinition(legacy, { ...legacy, commitment_filters: DEFAULT_COMMITMENT_VIEW_FILTERS })).toBe(true);
    const current = { ...legacy, commitment_filters: { direction: 'inbound', status: 'overdue' } };
    expect(parseSavedDataViewDefinition(current)).toEqual(current);
    expect(parseSavedDataViewDefinition({ ...current, tab: 'task' })).toBeNull();
    expect(parseSavedDataViewDefinition({ ...legacy, commitment_filters: { direction: 'outbound' } })).toBeNull();
  });
});
