import { describe, expect, it } from 'vitest';

import { createInMemoryCollection } from '../in-memory.js';
import { generateKey } from '../crypto.js';
import { createVaultStore, VaultQuotaExceededError } from '../vault.js';
import type { EncryptedEntry } from '../types.js';

const mkStore = async (opts?: Parameters<typeof createVaultStore>[2]) => {
  const collection = createInMemoryCollection<EncryptedEntry>();
  const dek = await generateKey();
  return createVaultStore(collection, dek, opts);
};

describe('vault quota enforcement (D-103)', () => {
  it('without quotas, set accepts arbitrary sizes', async () => {
    const store = await mkStore();
    await store.set('acme', 'token', 'x'.repeat(10_000));
    expect(await store.get('acme', 'token')).toHaveLength(10_000);
  });

  it('per-publisher cap rejects writes that would cross it', async () => {
    const store = await mkStore({ quotas: { perPublisherBytes: 100 } });
    await store.set('acme', 'a', 'x'.repeat(60));
    await expect(store.set('acme', 'b', 'y'.repeat(60))).rejects.toBeInstanceOf(
      VaultQuotaExceededError,
    );
  });

  it('per-publisher cap is not shared across publishers', async () => {
    const store = await mkStore({ quotas: { perPublisherBytes: 100 } });
    await store.set('acme', 'a', 'x'.repeat(60));
    // Different publisher has its own 100-byte budget.
    await expect(store.set('beta', 'a', 'y'.repeat(60))).resolves.toBeUndefined();
  });

  it('total cap rejects writes across publishers', async () => {
    const store = await mkStore({ quotas: { totalBytes: 120 } });
    await store.set('acme', 'a', 'x'.repeat(60));
    await store.set('beta', 'a', 'y'.repeat(50));
    await expect(store.set('gamma', 'a', 'z'.repeat(20))).rejects.toBeInstanceOf(
      VaultQuotaExceededError,
    );
  });

  it('updating an existing key computes the delta, not the full new size', async () => {
    const store = await mkStore({ quotas: { perPublisherBytes: 100 } });
    await store.set('acme', 'a', 'x'.repeat(80));
    // Same key, slightly bigger — delta is +10, still under 100.
    await expect(store.set('acme', 'a', 'x'.repeat(90))).resolves.toBeUndefined();
    // Now same key, much bigger — +40 would cross 100.
    await expect(store.set('acme', 'a', 'x'.repeat(130))).rejects.toBeInstanceOf(
      VaultQuotaExceededError,
    );
  });

  it('error shape carries scope + current + limit', async () => {
    const store = await mkStore({ quotas: { perPublisherBytes: 50 } });
    try {
      await store.set('acme', 'a', 'x'.repeat(60));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultQuotaExceededError);
      const err = e as VaultQuotaExceededError;
      expect(err.scope).toBe('publisher');
      expect(err.limit).toBe(50);
      expect(err.current).toBe(60);
      expect(err.publisher).toBe('acme');
    }
  });

  it('both caps applied in order — per-publisher fires before total', async () => {
    const store = await mkStore({ quotas: { perPublisherBytes: 50, totalBytes: 1000 } });
    await expect(store.set('acme', 'a', 'x'.repeat(60))).rejects.toMatchObject({
      scope: 'publisher',
    });
  });
});
