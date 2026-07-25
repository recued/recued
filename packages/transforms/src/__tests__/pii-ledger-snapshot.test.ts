import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiiLedgerStoreSnapshot, RedactionAliasEntry } from '@recued/contracts';

import {
  _resetPiiLedgerState,
  aliasFields,
  createPiiLedgerStore,
  type Ledger,
  type PiiLedgerStore,
} from '../pii-alias.js';

const NOW = Date.parse('2026-01-02T03:04:05.000Z');

const nameFields = [{ path: 'name', kind: 'name' }] as const;

const mustSerialize = (store: PiiLedgerStore): PiiLedgerStoreSnapshot => {
  const snapshot = store.serialize();
  expect(snapshot).toBeDefined();
  return snapshot!;
};

const aliasName = (ledger: Ledger, realValue: string): string => {
  const aliased = aliasFields(ledger, { name: realValue }, nameFields) as { name: string };
  return aliased.name;
};

const nameEntry = (
  handle: string,
  realValue: string,
  aliasValue: string,
): RedactionAliasEntry => ({
  scope_id: handle,
  kind: 'name',
  real_value: realValue,
  alias_value: aliasValue,
  first_observed_at: { source_ref: 'name' },
  created_at: NOW,
});

const makeNameSnapshot = (realValue = 'Alice Smith') => {
  const store = createPiiLedgerStore();
  const { handle, ledger } = store.create();
  const alias = aliasName(ledger, realValue);
  return { store, handle, ledger, alias, snapshot: mustSerialize(store) };
};

const sidOf = (handle: string): number => Number(handle.split(':')[1]?.split('.')[0]);

beforeEach(() => {
  _resetPiiLedgerState();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PiiLedgerStore snapshot', () => {
  it('omits empty stores but carries minted unaliased handles with empty maps', () => {
    const store = createPiiLedgerStore();

    expect(store.serialize()).toBeUndefined();

    const { handle } = store.create();
    expect(store.serialize()).toEqual({
      sid: 1,
      ledger_seq: 1,
      handles: [handle],
      by_kind_real_value: [],
      by_kind_base_alias: [],
      counters: [],
      sibling_counters: [],
      pre_scan_literals: [],
    });
  });

  it('serializes aliasFields entries as a structured clone independent of live maps', () => {
    const { store, handle, ledger } = makeNameSnapshot();
    const snapshot = mustSerialize(store);
    const aliceEntry = nameEntry(handle, 'Alice Smith', 'pii.Person1');

    expect(snapshot).toEqual({
      sid: 1,
      ledger_seq: 1,
      handles: [handle],
      by_kind_real_value: [['name::Alice Smith', aliceEntry]],
      by_kind_base_alias: [['name::pii.Person1', aliceEntry]],
      counters: [['name', 1]],
      sibling_counters: [],
      pre_scan_literals: [],
    });

    const liveEntry = ledger.byKindBaseAlias.get('name::pii.Person1');
    expect(liveEntry).toBeDefined();
    liveEntry!.real_value = 'Mutated Alice';
    aliasName(ledger, 'Bob Jones');

    expect(snapshot.by_kind_real_value).toEqual([['name::Alice Smith', aliceEntry]]);
    expect(snapshot.by_kind_base_alias).toEqual([['name::pii.Person1', aliceEntry]]);
    expect(mustSerialize(store).by_kind_real_value.map(([key]) => key)).toEqual([
      'name::Alice Smith',
      'name::Bob Jones',
    ]);
  });

  it('hydrates old handles and restores pre-pause aliases while unknown handles miss', () => {
    const { handle, alias, snapshot } = makeNameSnapshot();
    const hydrated = createPiiLedgerStore(snapshot);

    expect(hydrated.get(handle)).toBeDefined();
    expect(hydrated.get('pii-ledger:999.999')).toBeUndefined();
    expect(hydrated.restoreAll({ echo: `Approved ${alias}` })).toEqual({
      echo: 'Approved Alice Smith',
    });
  });

  it('continues alias maps after hydration without reissuing Person1 for a new value', () => {
    const { snapshot } = makeNameSnapshot();
    const hydrated = createPiiLedgerStore(snapshot);
    const { ledger } = hydrated.create();

    expect(aliasName(ledger, 'Alice Smith')).toBe('pii.Person1');
    expect(aliasName(ledger, 'Bob Jones')).toBe('pii.Person2');
  });

  it('continues handles on the hydrated sid and bumps later fresh stores past it', () => {
    const { handle, snapshot } = makeNameSnapshot();
    const hydrated = createPiiLedgerStore(snapshot);
    const { handle: resumedHandle } = hydrated.create();

    expect(resumedHandle).not.toBe(handle);
    expect(resumedHandle).toBe(`pii-ledger:${snapshot.sid}.2`);

    const freshHandle = createPiiLedgerStore().create().handle;
    expect(sidOf(freshHandle)).toBeGreaterThan(snapshot.sid);
  });

  it('round-trips multi-pause snapshots with old and new handles and entries', () => {
    const first = makeNameSnapshot('Alice Smith');
    const hydrated = createPiiLedgerStore(first.snapshot);
    const { handle: secondHandle, ledger: secondLedger } = hydrated.create();
    const bobAlias = aliasName(secondLedger, 'Bob Jones');

    expect(bobAlias).toBe('pii.Person2');

    const secondSnapshot = mustSerialize(hydrated);
    expect(secondSnapshot.handles).toEqual([first.handle, secondHandle]);
    expect(secondSnapshot.by_kind_real_value.map(([key]) => key)).toEqual([
      'name::Alice Smith',
      'name::Bob Jones',
    ]);
    expect(secondSnapshot.by_kind_base_alias.map(([key]) => key)).toEqual([
      'name::pii.Person1',
      'name::pii.Person2',
    ]);

    const secondHydrated = createPiiLedgerStore(secondSnapshot);
    expect(secondHydrated.restoreAll(`Pair ${first.alias} with ${bobAlias}`)).toBe(
      'Pair Alice Smith with Bob Jones',
    );
  });

  it('tolerates snapshots with missing member arrays and still mints on the reused sid', () => {
    const store = createPiiLedgerStore({
      sid: 5,
      ledger_seq: 1,
      handles: undefined,
      by_kind_real_value: undefined,
      by_kind_base_alias: undefined,
      counters: undefined,
      sibling_counters: undefined,
      pre_scan_literals: undefined,
    } as unknown as PiiLedgerStoreSnapshot);

    expect(() => store.restoreAll('pii.Person1')).not.toThrow();
    expect(store.create().handle).toBe('pii-ledger:5.2');
  });

  it('falls back to a fresh sid for a bogus snapshot sid and remains usable', () => {
    const store = createPiiLedgerStore({
      sid: 'x',
      ledger_seq: 0,
      handles: [],
      by_kind_real_value: [],
      by_kind_base_alias: [],
      counters: [],
      sibling_counters: [],
      pre_scan_literals: [],
    } as unknown as PiiLedgerStoreSnapshot);

    const { handle, ledger } = store.create();
    expect(handle).toBe('pii-ledger:1.1');
    expect(aliasName(ledger, 'Alice Smith')).toBe('pii.Person1');
  });

  it('disposes hydrated stores back to pass-through restore and undefined snapshots', () => {
    const { handle, alias, snapshot } = makeNameSnapshot();
    const hydrated = createPiiLedgerStore(snapshot);

    expect(hydrated.restoreAll(alias)).toBe('Alice Smith');

    hydrated.dispose();

    expect(hydrated.get(handle)).toBeUndefined();
    expect(hydrated.restoreAll(alias)).toBe(alias);
    expect(hydrated.serialize()).toBeUndefined();
  });
});
