import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createServerAccountStore } from '../account-store.js';

const mkDb = () => new Database(':memory:');

describe('ServerAccountStore — onBytesChanged hook', () => {
  it('reports positive delta on first set', async () => {
    const deltas: number[] = [];
    const store = createServerAccountStore(mkDb(), { onBytesChanged: (d) => deltas.push(d) });
    await store.set('slack.team', 'T123');
    // JSON.stringify('T123') = '"T123"' = 6 chars
    expect(deltas).toEqual([6]);
  });

  it('reports net delta on overwrite', async () => {
    const deltas: number[] = [];
    const store = createServerAccountStore(mkDb(), { onBytesChanged: (d) => deltas.push(d) });
    await store.set('k', 'aa');    // 4 bytes for '"aa"'
    deltas.length = 0;
    await store.set('k', 'aaaaaa'); // 8 bytes for '"aaaaaa"'
    expect(deltas).toEqual([4]);
  });

  it('reports negative delta on delete', async () => {
    const deltas: number[] = [];
    const store = createServerAccountStore(mkDb(), { onBytesChanged: (d) => deltas.push(d) });
    await store.set('k', 'v'); // 3 bytes for '"v"'
    deltas.length = 0;
    await store.delete('k');
    expect(deltas).toEqual([-3]);
  });

  it('delete of missing key reports no delta', async () => {
    const deltas: number[] = [];
    const store = createServerAccountStore(mkDb(), { onBytesChanged: (d) => deltas.push(d) });
    await store.delete('never');
    expect(deltas).toEqual([]);
  });

  it('clear reports total freed', async () => {
    const deltas: number[] = [];
    const store = createServerAccountStore(mkDb(), { onBytesChanged: (d) => deltas.push(d) });
    await store.set('a', 'aaa'); // 5 for '"aaa"'
    await store.set('b', 'b');   // 3 for '"b"'
    deltas.length = 0;
    await store.clear();
    // Order depends on SQLite scan — sum is all we care about.
    expect(deltas.reduce((s, d) => s + d, 0)).toBe(-8);
  });

  it('legacy path without hook still functions', async () => {
    const store = createServerAccountStore(mkDb());
    await expect(store.set('k', 'v')).resolves.toBeUndefined();
  });

  it('getAll preserves prototype-sensitive keys without polluting Object.prototype', async () => {
    const store = createServerAccountStore(mkDb());
    await store.set('__proto__', 'secret');
    await store.set('constructor', 'ctor');
    await store.set('safe', 'ok');

    const all = await store.getAll();
    expect(Object.getPrototypeOf(all)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(all, '__proto__')).toBe(true);
    expect(all['__proto__']).toBe('secret');
    expect(all.constructor).toBe('ctor');
    expect(all.safe).toBe('ok');
    expect(({} as Record<string, unknown>).secret).toBeUndefined();
  });

  it('swallows handler exceptions', async () => {
    const store = createServerAccountStore(mkDb(), {
      onBytesChanged: () => { throw new Error('boom'); },
    });
    await expect(store.set('k', 'v')).resolves.toBeUndefined();
  });
});
