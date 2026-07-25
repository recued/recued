/** Slice 3b — end-to-end: `/auth/pair` first-boot enrollment turns on
 *  real at-rest encryption, and a simulated restart auto-unlocks the
 *  Master DEK from the keyfile. Drives the REAL Node http server with
 *  `keys` + `getServerKeyStore` wired exactly as `compose-listeners`
 *  does in production. */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createPairingManager } from '../pairing.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createKeyManager } from '../key-manager.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import { autoUnlockServerVaultFromKeyfile } from '../server-vault-enrollment.js';
import { generateRecoveryKey } from '@recued/crypto';

const b64 = (u: Uint8Array | null): string => (u ? Buffer.from(u).toString('base64') : '');

const mkVaultKeyManager = (db: Database.Database) => {
  const serverBundleStore = createServerBundleStore(db);
  const keys = createKeyManager({
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => serverBundleStore.load(),
    saveServerBundle: (b) => serverBundleStore.save(b),
  });
  return { keys, serverBundleStore };
};

const bootServer = async (db: Database.Database) => {
  const pairing = createPairingManager({ realmToken: 'vault-realm' });
  const recoveryKeyCheck = createRecoveryKeyCheckStore(db);
  const keyStore = createInMemoryServerKeyStore();
  const { keys, serverBundleStore } = mkVaultKeyManager(db);
  const manifests = createManifestRegistry('/nonexistent');
  const recipeStore = createRecipeStore('/nonexistent');
  const server = await startServer(0, {
    executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
    pairing,
    recoveryKeyCheck,
    keys,
    getServerKeyStore: () => keyStore,
  });
  return { server, pairing, recoveryKeyCheck, keyStore, keys, serverBundleStore };
};

describe('/auth/pair first-boot server-vault enrollment', () => {
  let running: RunningServer | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (running) await running.close();
    running = undefined;
    if (db) db.close();
    db = undefined;
  });

  it('first pair turns on encryption: bundle persisted, keyfile key set, vault unlocked', async () => {
    db = new Database(':memory:');
    const boot = await bootServer(db);
    running = boot.server;

    // Fresh server ⇒ uninitialized before the pair.
    expect(boot.keys.state()).toBe('uninitialized');
    expect(boot.serverBundleStore.exists()).toBe(false);

    const code = boot.pairing.refreshCode();
    const recoveryKey = generateRecoveryKey().mnemonic;
    const res = await fetch(`http://127.0.0.1:${boot.server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, recoveryKey, instanceId: 'first', displayName: 'Mac' }),
    });

    expect(res.status).toBe(200);
    // Encryption is now ON: the Master DEK is unlocked, the bundle is
    // persisted, and the keyfile holds the auto-unlock server key.
    expect(boot.keys.state()).toBe('unlocked');
    expect(boot.serverBundleStore.exists()).toBe(true);
    expect(boot.keyStore.loadServerVaultKey()).not.toBeNull();
    expect(boot.keys.keyProvider('server-data')()).not.toBeNull();
  });

  it('after a restart the server auto-unlocks the SAME Master DEK from the keyfile — no recovery key', async () => {
    db = new Database(':memory:');
    const boot = await bootServer(db);
    running = boot.server;

    const code = boot.pairing.refreshCode();
    const recoveryKey = generateRecoveryKey().mnemonic;
    await fetch(`http://127.0.0.1:${boot.server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, recoveryKey, instanceId: 'first' }),
    });
    const subDekAtEnroll = b64(boot.keys.keyProvider('server-data')());
    expect(subDekAtEnroll).not.toBe('');

    // Simulate a process restart: a fresh KeyManager over the SAME db
    // (bundle persisted) + the SAME keyfile. This is what the boot
    // auto-unlock step runs — with NO recovery key.
    const restarted = mkVaultKeyManager(db);
    expect(restarted.keys.state()).toBe('locked');

    const result = await autoUnlockServerVaultFromKeyfile({
      keys: restarted.keys,
      keyStore: boot.keyStore,
    });

    expect(result).toBe('unlocked');
    expect(restarted.keys.state()).toBe('unlocked');
    expect(b64(restarted.keys.keyProvider('server-data')())).toBe(subDekAtEnroll);
  });

  it('a malformed recovery key at first pair is rejected (400) and leaves encryption OFF', async () => {
    db = new Database(':memory:');
    const boot = await bootServer(db);
    running = boot.server;

    const code = boot.pairing.refreshCode();
    const res = await fetch(`http://127.0.0.1:${boot.server.port}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, recoveryKey: 'not a valid mnemonic', instanceId: 'first' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('recovery_key_invalid');
    // Nothing enrolled — still first-boot, encryption OFF.
    expect(boot.keys.state()).toBe('uninitialized');
    expect(boot.serverBundleStore.exists()).toBe(false);
  });
});
