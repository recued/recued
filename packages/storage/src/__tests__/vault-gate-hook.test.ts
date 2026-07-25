import { describe, it, expect } from 'vitest';
import {
  createVaultStore,
  createInMemoryCollection,
  generateKey,
  type EncryptedEntry,
} from '../index.js';

const mkVault = async (hook?: (delta: number) => void) => {
  const collection = createInMemoryCollection<EncryptedEntry>();
  const dek = await generateKey();
  const store = createVaultStore(collection, dek, {
    ...(hook ? { onBytesChanged: hook } : {}),
  });
  return { store, collection, dek };
};

describe('VaultStore — onBytesChanged hook', () => {
  it('reports positive delta on first set', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.set('pub-1', 'api_key', 'secret-value');
    expect(deltas).toEqual(['secret-value'.length]);
  });

  it('reports net delta on overwrite', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.set('pub-1', 'api_key', 'short');
    deltas.length = 0;
    await store.set('pub-1', 'api_key', 'a-much-longer-secret-value');
    expect(deltas).toEqual(['a-much-longer-secret-value'.length - 'short'.length]);
  });

  it('reports net delta on shrink-overwrite', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.set('pub-1', 'api_key', 'x'.repeat(100));
    deltas.length = 0;
    await store.set('pub-1', 'api_key', 'xy');
    expect(deltas[0]).toBeLessThan(0);
    expect(deltas[0]).toBe(2 - 100);
  });

  it('reports negative delta on delete', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.set('pub-1', 'api_key', 'secret');
    deltas.length = 0;
    await store.delete('pub-1', 'api_key');
    expect(deltas).toEqual([-'secret'.length]);
  });

  it('deleteByPublisher sums freed plaintext bytes', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.set('pub-1', 'a', 'aaa');
    await store.set('pub-1', 'b', 'bbbb');
    await store.set('pub-2', 'c', 'ccccc');
    deltas.length = 0;
    const n = await store.deleteByPublisher('pub-1');
    expect(n).toBe(2);
    expect(deltas).toEqual([-('aaa'.length + 'bbbb'.length)]);
  });

  it('delete of missing entry reports no delta', async () => {
    const deltas: number[] = [];
    const { store } = await mkVault((d) => deltas.push(d));
    await store.delete('pub-1', 'never');
    expect(deltas).toEqual([]);
  });

  it('no-op when onBytesChanged absent (legacy)', async () => {
    const { store } = await mkVault();
    await expect(store.set('pub-1', 'k', 'v')).resolves.toBeUndefined();
  });

  it('swallows handler exceptions', async () => {
    const { store } = await mkVault(() => { throw new Error('boom'); });
    await expect(store.set('pub-1', 'k', 'v')).resolves.toBeUndefined();
  });
});
