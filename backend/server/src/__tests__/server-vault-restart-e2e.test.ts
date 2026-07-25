/** Slice 4 (part 2) — the vault credential survives a restart keyed by the
 *  Master DEK (no plaintext server_dek), auto-unlocked from the keyfile;
 *  and the ref resolver reads the stable `baseVault` mutation LIVE (so the
 *  post-unlock re-load reaches recipes without an executor rebuild). */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveValue } from '@recued/contracts';
import { generateRecoveryKey } from '@recued/crypto';
import { createKeyManager } from '../key-manager.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import { createServerVaultStore } from '../server-vault.js';
import {
  enrollServerVaultFromRecoveryKey,
  autoUnlockServerVaultFromKeyfile,
} from '../server-vault-enrollment.js';

const mkKeyManager = (db: Database.Database) => {
  const sb = createServerBundleStore(db);
  return createKeyManager({
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => sb.load(),
    saveServerBundle: (b) => sb.save(b),
  });
};

describe('vault credential survives a restart under the Master DEK', () => {
  it('enroll → set cred → restart → keyfile auto-unlock → read it back (no plaintext DEK)', async () => {
    const db = new Database(':memory:');
    try {
      const keyStore = createInMemoryServerKeyStore();

      // First boot: enrol (mints the keyfile server key + bundle, unlocks).
      const km1 = mkKeyManager(db);
      await enrollServerVaultFromRecoveryKey({
        keys: km1, keyStore, recoveryKey: generateRecoveryKey().mnemonic,
      });
      const vault1 = await createServerVaultStore(db, {
        getEncryptionKey: () => km1.keyProvider('vault')(),
      });
      await vault1.set('mypub', 'hubspot_token', 'pat-abc-123');

      // The whole point: no plaintext DEK row — the vault is Master-DEK-keyed.
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='server_dek'`).get(),
      ).toBeUndefined();

      // Restart: fresh KeyManager over the SAME db (bundle persisted) + the
      // SAME keyfile. Headless auto-unlock — no recovery key.
      const km2 = mkKeyManager(db);
      expect(km2.state()).toBe('locked');
      expect(await autoUnlockServerVaultFromKeyfile({ keys: km2, keyStore })).toBe('unlocked');

      // The credential decrypts under the auto-unlocked Master DEK.
      const vault2 = await createServerVaultStore(db, {
        getEncryptionKey: () => km2.keyProvider('vault')(),
      });
      expect(await vault2.get('mypub', 'hubspot_token')).toBe('pat-abc-123');
    } finally {
      db.close();
    }
  });
});

describe('stable baseVault is read live by the ref resolver', () => {
  it('resolveValue reflects an in-place mutation of the vault Record (post-unlock re-load reaches recipes)', () => {
    // The boot keeps ONE stable baseVault object; the executor captures it as
    // `stores.vault` and the resolver reads it at dispatch. So a post-unlock
    // re-load that MUTATES the object in place is visible without rebuilding
    // the executor — the mechanism the reboot path relies on.
    const baseVault: Record<string, unknown> = {};
    const stores = { vault: baseVault, config: {}, context: {}, meta: {}, step: {} } as never;

    // Locked first-load: empty → the ref resolves to nothing.
    expect(resolveValue('{{vault.mypub.hubspot_token}}', stores) ?? null).toBeNull();

    // Post-unlock re-load mutates the SAME object in place.
    Object.assign(baseVault, { mypub: { hubspot_token: 'pat-abc-123' } });

    // Same stores reference now resolves the credential.
    expect(resolveValue('{{vault.mypub.hubspot_token}}', stores)).toBe('pat-abc-123');
  });
});
