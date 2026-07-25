/** Slice 4 (part 1) — lazy Master-DEK-keyed vault store. The vault is
 *  built at boot before the Master DEK unlocks, so it resolves its DEK
 *  lazily from a `getEncryptionKey` provider (`keys.keyProvider('vault')`)
 *  instead of the plaintext `server_dek` row. This is the self-contained
 *  half; wiring it into boot (unlock-before-initVault) is a separate step. */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK, randomBytes } from '@recued/crypto';
import { createServerVaultStore } from '../server-vault.js';

describe('createServerVaultStore — lazy getEncryptionKey path', () => {
  it('round-trips, and interops with the eager master_dek keying', async () => {
    const db = new Database(':memory:');
    try {
      const masterDEK = randomBytes(32);
      const vaultSubDek = deriveSubDEK(masterDEK, 'vault');

      const lazy = await createServerVaultStore(db, { getEncryptionKey: () => vaultSubDek });
      await lazy.set('recued-core', 'api_key', 'sk-secret-123');
      expect(await lazy.get('recued-core', 'api_key')).toBe('sk-secret-123');

      // A fresh EAGER store over the same db + the same Master DEK reads it
      // back — proving the lazy provider bytes == `deriveVaultDekFromMaster`
      // keying, so boot auto-unlock decrypts exactly what enrollment wrote.
      const eager = await createServerVaultStore(db, { master_dek: masterDEK });
      expect(await eager.get('recued-core', 'api_key')).toBe('sk-secret-123');
    } finally {
      db.close();
    }
  });

  it('fails closed while the provider returns null (server locked), then resolves once unlocked', async () => {
    const db = new Database(':memory:');
    try {
      let key: Uint8Array | null = null;
      const store = await createServerVaultStore(db, { getEncryptionKey: () => key });

      await expect(store.get('p', 'k')).rejects.toThrow(/locked/i);
      await expect(store.set('p', 'k', 'v')).rejects.toThrow(/locked/i);

      // Unlock: the provider now yields the sub-DEK; ops resolve lazily.
      key = deriveSubDEK(randomBytes(32), 'vault');
      await store.set('p', 'k', 'v');
      expect(await store.get('p', 'k')).toBe('v');
    } finally {
      db.close();
    }
  });

  it('never creates the plaintext server_dek row on the lazy path', async () => {
    const db = new Database(':memory:');
    try {
      const vaultSubDek = deriveSubDEK(randomBytes(32), 'vault');
      const store = await createServerVaultStore(db, { getEncryptionKey: () => vaultSubDek });
      await store.set('p', 'k', 'v');

      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='server_dek'`)
        .get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rebuilds cleanly when the sub-DEK rotates', async () => {
    const db = new Database(':memory:');
    try {
      const masterA = randomBytes(32);
      let sub = deriveSubDEK(masterA, 'vault');
      const store = await createServerVaultStore(db, { getEncryptionKey: () => sub });
      await store.set('p', 'k', 'v1');
      expect(await store.get('p', 'k')).toBe('v1');

      // Rotate the sub-DEK: the facade rebuilds over the same collection.
      // Old ciphertext no longer decrypts (different key) — proving the
      // rebuild actually swapped keys rather than caching stale.
      sub = deriveSubDEK(randomBytes(32), 'vault');
      await expect(store.get('p', 'k')).rejects.toThrow();
    } finally {
      db.close();
    }
  });
});
