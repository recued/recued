/** KeyManager unit tests — state machine + sub-DEK derivation + zeroization. */

import { describe, it, expect } from 'vitest';
import { createKeyManager } from '../key-manager.js';
import type { Bundle } from '@recued/crypto';

const FAST = { t: 1, m: 1024, p: 1 };

const mkFakeStore = () => {
  let bundle: Bundle | null = null;
  return {
    loadBundle: () => bundle,
    saveBundle: (b: Bundle) => { bundle = b; },
    argon2Params: FAST,
    get currentBundle() { return bundle; },
    set currentBundle(b: Bundle | null) { bundle = b; },
  };
};

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('KeyManager — initial state', () => {
  it('uninitialized when no bundle persisted', () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    expect(km.state()).toBe('uninitialized');
  });

  it('locked when bundle persisted', async () => {
    const store = mkFakeStore();
    // Seed a bundle via init on one KM, then re-construct.
    const km1 = createKeyManager(store);
    await km1.init({ password: 'pw' });
    km1.lock();

    const km2 = createKeyManager(store);
    expect(km2.state()).toBe('locked');
  });
});

describe('KeyManager — init', () => {
  it('transitions uninitialized → unlocked, returns recovery key', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    const { recoveryKey } = await km.init({ password: 'pw' });
    expect(km.state()).toBe('unlocked');
    expect(recoveryKey.split(/\s+/).length).toBe(24);
    expect(store.currentBundle).not.toBeNull();
  });

  it('refuses to init when bundle already exists (locked)', async () => {
    const store = mkFakeStore();
    const km1 = createKeyManager(store);
    await km1.init({ password: 'pw' });
    km1.lock();

    const km2 = createKeyManager(store);
    await expect(km2.init({ password: 'new-pw' })).rejects.toThrow('bundle already exists');
  });

  it('refuses to init when already unlocked', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    await expect(km.init({ password: 'again' })).rejects.toThrow('already unlocked');
  });
});

describe('KeyManager — unlock', () => {
  it('password unlock succeeds', async () => {
    const store = mkFakeStore();
    const km1 = createKeyManager(store);
    await km1.init({ password: 'the-right-pw' });
    km1.lock();

    const km2 = createKeyManager(store);
    await km2.unlock({ password: 'the-right-pw' });
    expect(km2.state()).toBe('unlocked');
  });

  it('recovery-key unlock succeeds', async () => {
    const store = mkFakeStore();
    const km1 = createKeyManager(store);
    const { recoveryKey } = await km1.init({ password: 'pw' });
    km1.lock();

    const km2 = createKeyManager(store);
    await km2.unlock({ recoveryKey });
    expect(km2.state()).toBe('unlocked');
  });

  it('wrong password → rejects, stays locked', async () => {
    const store = mkFakeStore();
    const km1 = createKeyManager(store);
    await km1.init({ password: 'correct' });
    km1.lock();

    const km2 = createKeyManager(store);
    await expect(km2.unlock({ password: 'wrong' })).rejects.toThrow();
    expect(km2.state()).toBe('locked');
  });

  it('unlock while uninitialized throws', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await expect(km.unlock({ password: 'pw' })).rejects.toThrow('no bundle exists');
  });

  it('unlock while already unlocked is a no-op', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    await km.unlock({ password: 'pw' }); // should not throw
    expect(km.state()).toBe('unlocked');
  });

  it('requires password or recoveryKey', async () => {
    const store = mkFakeStore();
    const km1 = createKeyManager(store);
    await km1.init({ password: 'pw' });
    km1.lock();

    const km2 = createKeyManager(store);
    await expect(km2.unlock({})).rejects.toThrow('password or recoveryKey');
  });
});

describe('KeyManager — lock + zeroization', () => {
  it('lock() transitions unlocked → locked', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    expect(km.state()).toBe('unlocked');
    km.lock();
    expect(km.state()).toBe('locked');
  });

  it('getSubDEK throws after lock()', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    km.lock();
    expect(() => km.getSubDEK('server-data')).toThrow('locked');
  });

  it('keyProvider returns null after lock()', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    const provider = km.keyProvider('server-data');
    expect(provider()).not.toBeNull();
    km.lock();
    expect(provider()).toBeNull();
  });

  it('re-unlock after lock restores key access', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    // Snapshot the bytes (NOT the reference — lock() will zero the buffer).
    const keyABytes = Array.from(km.getSubDEK('server-data'));

    km.lock();
    await km.unlock({ password: 'pw' });
    const keyBBytes = Array.from(km.getSubDEK('server-data'));

    // Same Master DEK → same sub-DEK bytes deterministically
    expect(keyBBytes).toEqual(keyABytes);
  });

  it('zeroization on lock — captured sub-DEK reference becomes zero bytes', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    const keyRef = km.getSubDEK('server-data');
    // Before lock — non-zero
    expect(keyRef.some(b => b !== 0)).toBe(true);
    km.lock();
    // After lock — the buffer that `keyRef` points to has been wiped.
    // This is the zeroization contract: even copies of the reference
    // become unusable post-lock.
    expect(keyRef.every(b => b === 0)).toBe(true);
  });

  it('lock on uninitialized is a no-op (stays uninitialized)', () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    expect(km.state()).toBe('uninitialized');
    km.lock();
    expect(km.state()).toBe('uninitialized');
  });
});

describe('KeyManager — sub-DEK behavior', () => {
  it('caches sub-DEKs across calls', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    const a = km.getSubDEK('server-data');
    const b = km.getSubDEK('server-data');
    expect(a).toBe(b); // same reference → cached
  });

  it('different domains return different bytes', async () => {
    const store = mkFakeStore();
    const km = createKeyManager(store);
    await km.init({ password: 'pw' });
    const a = km.getSubDEK('server-data');
    const b = km.getSubDEK('blob-store');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('onStateChange fires on every transition', async () => {
    const store = mkFakeStore();
    const events: string[] = [];
    const km = createKeyManager({
      ...store,
      onStateChange: (next) => events.push(next),
    });
    await km.init({ password: 'pw' }); // uninitialized → unlocked
    km.lock();                          // unlocked → locked
    await km.unlock({ password: 'pw' });// locked → unlocked
    expect(events).toEqual(['unlocked', 'locked', 'unlocked']);
  });
});
