/** Slice 2 — server vault path: KeyManager initServerVault /
 *  unlockWithServerKey, the keyfile server-vault-key slot, and the
 *  server-bundle store. This is the "make it TRUE" mechanism: a Master
 *  DEK dual-wrapped under a keyfile server key (headless auto-unlock)
 *  and the user's recovery key (disaster recovery). */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateRecoveryKey,
  generateServerKey,
  type Bundle,
  type ServerBundle,
} from '@recued/crypto';
import { createKeyManager } from '../key-manager.js';
import {
  createServerBundleStore,
  resolveServerBundlePath,
} from '../server-bundle-store.js';
import { createFileServerKeyStore, flushFileServerKeyStore } from '../keys/file-store.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';

/** In-memory store harness exposing BOTH bundle slots. */
const mkStore = () => {
  let serverBundle: ServerBundle | null = null;
  let passwordBundle: Bundle | null = null;
  return {
    loadBundle: () => passwordBundle,
    saveBundle: (b: Bundle) => { passwordBundle = b; },
    loadServerBundle: () => serverBundle,
    saveServerBundle: (b: ServerBundle) => { serverBundle = b; },
    get serverBundle() { return serverBundle; },
  };
};

const b64 = (u: Uint8Array | null): string => (u ? Buffer.from(u).toString('base64') : '');

const enroll = () => ({
  recoveryKey: generateRecoveryKey().mnemonic,
  serverKey: generateServerKey(),
});

describe('KeyManager.initServerVault', () => {
  it('transitions uninitialized → unlocked and persists the server bundle', async () => {
    const store = mkStore();
    const km = createKeyManager(store);
    expect(km.state()).toBe('uninitialized');

    const { recoveryKey, serverKey } = enroll();
    await km.initServerVault({ recoveryKey, serverKey });

    expect(km.state()).toBe('unlocked');
    expect(store.serverBundle).not.toBeNull();
    expect(km.keyProvider('server-data')()).not.toBeNull();
  });

  it('refuses to init when a server bundle already exists (orphan guard)', async () => {
    const store = mkStore();
    const { recoveryKey, serverKey } = enroll();
    const km1 = createKeyManager(store);
    await km1.initServerVault({ recoveryKey, serverKey });
    km1.lock();

    // A second manager sees the persisted bundle → boots locked → refuses.
    const km2 = createKeyManager(store);
    expect(km2.state()).toBe('locked');
    await expect(km2.initServerVault(enroll())).rejects.toThrow(/already exists/);
  });

  it('refuses to init without a server-bundle store wired', async () => {
    const km = createKeyManager({
      loadBundle: () => null,
      saveBundle: () => {},
      // no loadServerBundle / saveServerBundle
    });
    await expect(km.initServerVault(enroll())).rejects.toThrow(/not wired/);
  });

  it('propagates a malformed recovery key without persisting anything', async () => {
    const store = mkStore();
    const km = createKeyManager(store);
    await expect(
      km.initServerVault({ recoveryKey: 'not a mnemonic', serverKey: generateServerKey() }),
    ).rejects.toThrow(/mnemonic/i);
    expect(store.serverBundle).toBeNull();
    expect(km.state()).toBe('uninitialized');
  });
});

describe('KeyManager.unlockWithServerKey (headless boot auto-unlock)', () => {
  it('a restarted manager unlocks to the SAME Master DEK via the server key', async () => {
    const store = mkStore();
    const { recoveryKey, serverKey } = enroll();

    const km1 = createKeyManager(store);
    await km1.initServerVault({ recoveryKey, serverKey });
    const subDekAtEnroll = b64(km1.keyProvider('server-data')());
    km1.lock();

    // Simulate a restart: fresh manager over the persisted bundle.
    const km2 = createKeyManager(store);
    expect(km2.state()).toBe('locked');
    await km2.unlockWithServerKey({ serverKey });

    expect(km2.state()).toBe('unlocked');
    // Same Master DEK ⇒ same derived sub-DEK bytes.
    expect(b64(km2.keyProvider('server-data')())).toBe(subDekAtEnroll);
  });

  it('uses a pre-storage bundle snapshot for initial state but re-reads disk to unlock', async () => {
    const store = mkStore();
    const { recoveryKey, serverKey } = enroll();
    const first = createKeyManager(store);
    await first.initServerVault({ recoveryKey, serverKey });
    first.lock();

    let liveServerBundleReads = 0;
    const restarted = createKeyManager({
      loadBundle: store.loadBundle,
      saveBundle: store.saveBundle,
      initialServerBundle: store.serverBundle,
      loadServerBundle: () => {
        liveServerBundleReads += 1;
        return store.serverBundle;
      },
      saveServerBundle: store.saveServerBundle,
    });

    expect(restarted.state()).toBe('locked');
    expect(liveServerBundleReads).toBe(0);
    await restarted.unlockWithServerKey({ serverKey });
    expect(liveServerBundleReads).toBe(1);
    expect(restarted.state()).toBe('unlocked');
  });

  it('rejects a wrong server key and stays locked', async () => {
    const store = mkStore();
    const { recoveryKey, serverKey } = enroll();
    const km1 = createKeyManager(store);
    await km1.initServerVault({ recoveryKey, serverKey });
    km1.lock();

    const km2 = createKeyManager(store);
    await expect(km2.unlockWithServerKey({ serverKey: generateServerKey() })).rejects.toThrow();
    expect(km2.state()).toBe('locked');
    expect(km2.keyProvider('server-data')()).toBeNull();
  });

  it('throws when no server bundle exists', async () => {
    const store = mkStore();
    const km = createKeyManager(store);
    await expect(km.unlockWithServerKey({ serverKey: generateServerKey() })).rejects.toThrow(/no server vault bundle/);
  });
});

describe('ServerKeyStore server-vault-key slot', () => {
  it('in-memory store round-trips the key by value (defensive copy)', () => {
    const store = createInMemoryServerKeyStore();
    expect(store.loadServerVaultKey()).toBeNull();
    const key = generateServerKey();
    store.saveServerVaultKey(key);
    const back = store.loadServerVaultKey();
    expect(back).not.toBeNull();
    expect(b64(back)).toBe(b64(key));
    // Mutating the caller's copy must not corrupt the stored key.
    key.fill(0);
    expect(b64(store.loadServerVaultKey())).not.toBe(b64(key));
  });

  it('disk keyfile persists the vault key across a reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-vault-keyfile-'));
    try {
      const path = join(dir, 'identity.json');
      const key = generateServerKey();

      const s1 = await createFileServerKeyStore({ filePath: path });
      s1.saveServerVaultKey(key);
      await flushFileServerKeyStore(s1);

      // Reopen the file — the vault key must survive.
      const s2 = await createFileServerKeyStore({ filePath: path });
      expect(b64(s2.loadServerVaultKey())).toBe(b64(key));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createServerBundleStore', () => {
  it('round-trips a server bundle in an owner-only sidecar before any db exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-vault-bundle-'));
    try {
      const dbPath = join(dir, 'realm.db');
      const store = createServerBundleStore(dbPath);
      expect(store.path).toBe(resolveServerBundlePath(dbPath));
      expect(store.exists()).toBe(false);
      expect(store.load()).toBeNull();

      // Mint a real bundle via a throwaway KeyManager.
      const km = createKeyManager({
        loadBundle: () => null,
        saveBundle: () => {},
        loadServerBundle: () => store.load(),
        saveServerBundle: (b) => store.save(b),
      });
      const { recoveryKey, serverKey } = enroll();
      await km.initServerVault({ recoveryKey, serverKey });

      expect(store.exists()).toBe(true);
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.wrapped_server.length).toBeGreaterThan(0);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);

      // A fresh store over the same db path reads the same sidecar; SQLite is
      // neither opened nor created anywhere in this test.
      expect(createServerBundleStore(dbPath).load()).toEqual(loaded);

      store.clear();
      expect(store.exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a present sidecar is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srv-vault-bundle-corrupt-'));
    try {
      const store = createServerBundleStore(join(dir, 'realm.db'));
      writeFileSync(store.path, '{not-json', { mode: 0o600 });
      expect(store.exists()).toBe(true);
      expect(() => store.load()).toThrow(/is unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
