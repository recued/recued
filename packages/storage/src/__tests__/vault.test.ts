import { describe, it, expect, beforeEach } from 'vitest';
import { createVaultStore, type VaultStore } from '../vault.js';
import { createInMemoryCollection } from '../in-memory.js';
import { generateKey } from '../crypto.js';
import type { Collection, EncryptedEntry } from '../types.js';

let collection: Collection<EncryptedEntry>;
let vault: VaultStore;
let dek: CryptoKey;

beforeEach(async () => {
  collection = createInMemoryCollection<EncryptedEntry>();
  dek = await generateKey();
  vault = createVaultStore(collection, dek);
});

describe('createVaultStore', () => {
  describe('set/get', () => {
    it('stores and retrieves a value', async () => {
      await vault.set('recued-core', 'hubspot.token', 'pat-na2-abc123');
      expect(await vault.get('recued-core', 'hubspot.token')).toBe('pat-na2-abc123');
    });

    it('returns null for missing key', async () => {
      expect(await vault.get('recued-core', 'missing')).toBeNull();
    });

    it('overwrites existing entries', async () => {
      await vault.set('recued-core', 'token', 'old');
      await vault.set('recued-core', 'token', 'new');
      expect(await vault.get('recued-core', 'token')).toBe('new');
    });

    it('stores values encrypted in the underlying collection', async () => {
      await vault.set('recued-core', 'token', 'super-secret');
      const raw = await collection.get('vault.recued-core.token');
      expect(raw).toBeDefined();
      expect(raw?.ciphertext).not.toContain('super-secret');
      expect(raw?.iv).toBeDefined();
    });
  });

  describe('publisher isolation', () => {
    it('different publishers do not see each other data', async () => {
      await vault.set('publisher-a', 'token', 'a-secret');
      await vault.set('publisher-b', 'token', 'b-secret');

      expect(await vault.get('publisher-a', 'token')).toBe('a-secret');
      expect(await vault.get('publisher-b', 'token')).toBe('b-secret');
    });

    it('listByPublisher returns only that publisher entries', async () => {
      await vault.set('publisher-a', 'key1', 'a1');
      await vault.set('publisher-a', 'key2', 'a2');
      await vault.set('publisher-b', 'key1', 'b1');

      const aEntries = await vault.listByPublisher('publisher-a');
      expect(aEntries).toHaveLength(2);
      expect(aEntries.map(e => e.value).sort()).toEqual(['a1', 'a2']);
    });

    it('listByPublisher returns decrypted values', async () => {
      await vault.set('recued-core', 'k', 'plaintext');
      const entries = await vault.listByPublisher('recued-core');
      expect(entries[0].value).toBe('plaintext');
    });

    it('listByPublisher returns user-facing keys (not scoped)', async () => {
      await vault.set('recued-core', 'hubspot.token', 'x');
      const entries = await vault.listByPublisher('recued-core');
      expect(entries[0].key).toBe('hubspot.token');
      expect(entries[0].key).not.toContain('vault.');
    });
  });

  describe('has', () => {
    it('true after set', async () => {
      await vault.set('p', 'k', 'v');
      expect(await vault.has('p', 'k')).toBe(true);
    });

    it('false for missing', async () => {
      expect(await vault.has('p', 'missing')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a single entry', async () => {
      await vault.set('p', 'k', 'v');
      await vault.delete('p', 'k');
      expect(await vault.has('p', 'k')).toBe(false);
    });

    it('does not affect other publishers', async () => {
      await vault.set('p1', 'k', 'v1');
      await vault.set('p2', 'k', 'v2');
      await vault.delete('p1', 'k');
      expect(await vault.get('p2', 'k')).toBe('v2');
    });
  });

  describe('deleteByPublisher', () => {
    it('removes all entries for a publisher', async () => {
      await vault.set('p1', 'k1', 'a');
      await vault.set('p1', 'k2', 'b');
      await vault.set('p2', 'k1', 'c');

      const count = await vault.deleteByPublisher('p1');
      expect(count).toBe(2);
      expect(await vault.has('p1', 'k1')).toBe(false);
      expect(await vault.has('p1', 'k2')).toBe(false);
      expect(await vault.has('p2', 'k1')).toBe(true);
    });
  });

  describe('encryption integrity', () => {
    it('different DEK cannot decrypt entries', async () => {
      await vault.set('p', 'k', 'secret');

      const otherDek = await generateKey();
      const otherVault = createVaultStore(collection, otherDek);

      await expect(otherVault.get('p', 'k')).rejects.toThrow();
    });
  });
});
