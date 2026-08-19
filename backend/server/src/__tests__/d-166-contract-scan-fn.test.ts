/** D-166 Slice 4d.1 — `createContractScanFn`: the pure adapter from a backend
 *  `ContractStore` to the dispatcher's `@recued/contracts` `ScanFn` (forward
 *  `scope` / `prefix` to `store.scan`, map each `ContractRow` onto the
 *  `{ segments, value }` `ContractRowLike` the 4d catalog-gate resolver consumes).
 *  Exercised against a recording fake store (forwarding + mapping in isolation)
 *  and one real store (structural compatibility against actual scan output). */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { D165_CONTRACT_SCHEMA } from '@recued/contracts';

import {
  createContractScanFn,
  createContractStore,
  type ContractRow,
  type ContractStore,
} from '../storage/contract-store.js';

/** A recording fake `ContractStore`: only `scan` is meant to be hit by the
 *  adapter — every other method throws, proving the adapter touches nothing
 *  else. `scan` records its (scope, prefix) so forwarding can be asserted. */
const recordingStore = (
  rows: ContractRow[],
): {
  store: ContractStore;
  calls: Array<{ scope: string; prefix: readonly string[] | undefined }>;
} => {
  const calls: Array<{ scope: string; prefix: readonly string[] | undefined }> = [];
  const notCalled =
    (name: string) =>
    (): never => {
      throw new Error(`createContractScanFn must not call store.${name}`);
    };
  const store: ContractStore = {
    scan: (scope, prefix) => {
      calls.push({ scope, prefix });
      return rows;
    },
    put: notCalled('put'),
    // D-247 — the scan fn must not write, by either door.
    putIfAbsent: notCalled('putIfAbsent'),
    get: notCalled('get'),
    delete: notCalled('delete'),
    deleteByPrefix: notCalled('deleteByPrefix'),
    seedSchema: notCalled('seedSchema'),
    transaction: notCalled('transaction'),
  };
  return { store, calls };
};

const row = (segments: string[], value: Record<string, unknown>): ContractRow => ({
  scope: 'installed_ingredient',
  segments,
  value,
  written_at: 0,
});

describe('createContractScanFn (D-166 Slice 4d.1)', () => {
  it('forwards scope + prefix to store.scan verbatim (incl. the empty prefix)', () => {
    const { store, calls } = recordingStore([]);
    const scan = createContractScanFn(store);
    scan('installed_ingredient', ['hubspot']);
    scan('grant', []);
    expect(calls).toEqual([
      { scope: 'installed_ingredient', prefix: ['hubspot'] },
      { scope: 'grant', prefix: [] },
    ]);
  });

  it('maps each ContractRow to the `{ segments, value }` ContractRowLike only', () => {
    const { store } = recordingStore([
      row(['hubspot', 'deal-reader-hubspot'], { a: 1 }),
      row(['hubspot', 'contact-reader-hubspot'], { b: 2 }),
    ]);
    const out = createContractScanFn(store)('installed_ingredient', ['hubspot']);
    expect(out.length).toBe(2);
    // Exactly the ContractRowLike surface — `scope` / `written_at` are dropped.
    expect(out.map((r) => Object.keys(r).sort())).toEqual([
      ['segments', 'value'],
      ['segments', 'value'],
    ]);
  });

  it('preserves segments + value (the unknown→record pass-through) in order', () => {
    const { store } = recordingStore([
      row(['a'], { v: 'first' }),
      row(['b'], { v: 'second' }),
    ]);
    const out = createContractScanFn(store)('installed_ingredient', []);
    expect(out[0].segments).toEqual(['a']);
    expect(out[0].value).toEqual({ v: 'first' });
    expect(out[1].segments).toEqual(['b']);
    expect(out[1].value).toEqual({ v: 'second' });
  });

  it('works end-to-end against a real store + actual scan output (seeded schema)', () => {
    const store = createContractStore(new Database(':memory:'));
    store.seedSchema(D165_CONTRACT_SCHEMA);
    const out = createContractScanFn(store)('schema', ['composite_keys']);
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(r.segments[0]).toBe('composite_keys');
      expect(typeof r.value).toBe('object');
    }
  });
});
