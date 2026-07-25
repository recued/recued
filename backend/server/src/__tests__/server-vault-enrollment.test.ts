/** Slice 3a — enrollment + boot auto-unlock orchestration helpers.
 *  Exercises the crash-safe ordering, idempotency, and the enroll →
 *  "restart" → auto-unlock round-trip that ties the keyfile server key
 *  to the vault bundle. */

import { describe, it, expect } from 'vitest';
import {
  generateRecoveryKey,
  type Bundle,
  type ServerBundle,
} from '@recued/crypto';
import { createKeyManager } from '../key-manager.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import {
  enrollServerVaultFromRecoveryKey,
  autoUnlockServerVaultFromKeyfile,
} from '../server-vault-enrollment.js';

/** Persistent bundle slots shared across "restarts" (fresh KeyManagers). */
const mkBundleStore = () => {
  let serverBundle: ServerBundle | null = null;
  let passwordBundle: Bundle | null = null;
  return {
    loadBundle: () => passwordBundle,
    saveBundle: (b: Bundle) => { passwordBundle = b; },
    loadServerBundle: () => serverBundle,
    saveServerBundle: (b: ServerBundle) => { serverBundle = b; },
  };
};

const b64 = (u: Uint8Array | null): string => (u ? Buffer.from(u).toString('base64') : '');

describe('enrollServerVaultFromRecoveryKey', () => {
  it('first boot: mints a keyfile server key, initializes the bundle, unlocks', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);
    const recoveryKey = generateRecoveryKey().mnemonic;

    const result = await enrollServerVaultFromRecoveryKey({ keys, keyStore, recoveryKey });

    expect(result).toBe('enrolled');
    expect(keys.state()).toBe('unlocked');
    expect(keyStore.loadServerVaultKey()).not.toBeNull();
    expect(keys.keyProvider('server-data')()).not.toBeNull();
  });

  it('is idempotent — a re-pair on an encrypted server is a no-op', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);
    const recoveryKey = generateRecoveryKey().mnemonic;

    await enrollServerVaultFromRecoveryKey({ keys, keyStore, recoveryKey });
    const keyAfterFirst = b64(keyStore.loadServerVaultKey());

    // Second call (state now unlocked) does nothing — a DIFFERENT key is
    // reported already-enrolled, and the keyfile server key is unchanged.
    const second = await enrollServerVaultFromRecoveryKey({
      keys, keyStore, recoveryKey: generateRecoveryKey().mnemonic,
    });
    expect(second).toBe('already_enrolled');
    expect(b64(keyStore.loadServerVaultKey())).toBe(keyAfterFirst);
  });

  it('a bad recovery key throws and leaves the vault un-enrolled (self-healing on retry)', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);

    await expect(
      enrollServerVaultFromRecoveryKey({ keys, keyStore, recoveryKey: 'not a mnemonic' }),
    ).rejects.toThrow(/mnemonic/i);
    // No bundle was persisted; still first-boot.
    expect(keys.state()).toBe('uninitialized');
    expect(store.loadServerBundle()).toBeNull();

    // Retry with a good key regenerates the server key + enrolls cleanly.
    const ok = await enrollServerVaultFromRecoveryKey({
      keys, keyStore, recoveryKey: generateRecoveryKey().mnemonic,
    });
    expect(ok).toBe('enrolled');
    expect(keys.state()).toBe('unlocked');
  });
});

describe('autoUnlockServerVaultFromKeyfile', () => {
  it('enroll → restart → auto-unlock recovers the SAME Master DEK', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();

    // First boot: enrol.
    const km1 = createKeyManager(store);
    await enrollServerVaultFromRecoveryKey({
      keys: km1, keyStore, recoveryKey: generateRecoveryKey().mnemonic,
    });
    const subDekAtEnroll = b64(km1.keyProvider('server-data')());
    km1.lock();

    // Restart: fresh KeyManager over the persisted bundle + same keyfile.
    const km2 = createKeyManager(store);
    expect(km2.state()).toBe('locked');
    const result = await autoUnlockServerVaultFromKeyfile({ keys: km2, keyStore });

    expect(result).toBe('unlocked');
    expect(km2.state()).toBe('unlocked');
    expect(b64(km2.keyProvider('server-data')())).toBe(subDekAtEnroll);
  });

  it('skips when the realm is fresh (no bundle)', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);
    expect(await autoUnlockServerVaultFromKeyfile({ keys, keyStore })).toBe('skipped');
    expect(keys.state()).toBe('uninitialized');
  });

  it('skips (stays locked) when the keyfile has no server key — recovery-key rescue territory', async () => {
    const store = mkBundleStore();

    // Enrol against one keyfile...
    const km1 = createKeyManager(store);
    await enrollServerVaultFromRecoveryKey({
      keys: km1, keyStore: createInMemoryServerKeyStore(), recoveryKey: generateRecoveryKey().mnemonic,
    });
    km1.lock();

    // ...but boot with an EMPTY keyfile (simulating a lost / un-flushed key).
    const emptyKeyStore = createInMemoryServerKeyStore();
    const km2 = createKeyManager(store);
    expect(km2.state()).toBe('locked');
    expect(await autoUnlockServerVaultFromKeyfile({ keys: km2, keyStore: emptyKeyStore })).toBe('skipped');
    expect(km2.state()).toBe('locked');
  });
});
