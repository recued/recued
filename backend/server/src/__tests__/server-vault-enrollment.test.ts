/** Slice 3a — enrollment + boot auto-unlock orchestration helpers.
 *  Exercises the crash-safe ordering, idempotency, and the enroll →
 *  "restart" → auto-unlock round-trip that ties the keyfile server key
 *  to the vault bundle. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, it, expect } from 'vitest';
import {
  generateRecoveryKey,
  type Bundle,
  type ServerBundle,
} from '@recued/crypto';
import { createKeyManager } from '../key-manager.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import {
  enrollServerVaultFromRecoveryKey,
  enrollRealmRecoveryKey,
  autoUnlockServerVaultFromKeyfile,
} from '../server-vault-enrollment.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { KEYFILE_RESERVATION_FILE } from '../keys/directory-reservation.js';
import { verifyRecoveryKeyAgainstRealm } from '../recovery-key-processor.js';
import { openDatabase } from '../open-database.js';

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

const resources: Array<{ dir: string; db: Database.Database }> = [];
const createEnrollmentDatabase = async (): Promise<Database.Database> => {
  const dir = mkdtempSync(join(tmpdir(), 'server-vault-enroll-'));
  const db = await openDatabase(join(dir, 'realm.db'), { databaseKey: null });
  db.exec('CREATE TABLE enrollment_probe (value TEXT)');
  resources.push({ dir, db });
  return db;
};

afterEach(() => {
  while (resources.length > 0) {
    const resource = resources.pop()!;
    try { resource.db.close(); } catch { /* already closed */ }
    rmSync(resource.dir, { recursive: true, force: true });
  }
});

describe('enrollServerVaultFromRecoveryKey', () => {
  it('first boot: mints a keyfile server key, initializes the bundle, unlocks', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);
    const recoveryKey = generateRecoveryKey().mnemonic;
    const database = await createEnrollmentDatabase();

    const result = await enrollServerVaultFromRecoveryKey({
      keys, keyStore, recoveryKey, database,
    });

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
    const database = await createEnrollmentDatabase();

    await enrollServerVaultFromRecoveryKey({ keys, keyStore, recoveryKey, database });
    const keyAfterFirst = b64(keyStore.loadServerVaultKey());

    // Second call (state now unlocked) does nothing — a DIFFERENT key is
    // reported already-enrolled, and the keyfile server key is unchanged.
    const second = await enrollServerVaultFromRecoveryKey({
      keys, keyStore, database, recoveryKey: generateRecoveryKey().mnemonic,
    });
    expect(second).toBe('already_enrolled');
    expect(b64(keyStore.loadServerVaultKey())).toBe(keyAfterFirst);
  });

  it('a bad recovery key throws and leaves the vault un-enrolled (self-healing on retry)', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const keys = createKeyManager(store);
    const database = await createEnrollmentDatabase();

    await expect(
      enrollServerVaultFromRecoveryKey({
        keys, keyStore, database, recoveryKey: 'not a mnemonic',
      }),
    ).rejects.toThrow(/mnemonic/i);
    // No bundle was persisted; still first-boot.
    expect(keys.state()).toBe('uninitialized');
    expect(store.loadServerBundle()).toBeNull();

    // Retry with a good key regenerates the server key + enrolls cleanly.
    const ok = await enrollServerVaultFromRecoveryKey({
      keys, keyStore, database, recoveryKey: generateRecoveryKey().mnemonic,
    });
    expect(ok).toBe('enrolled');
    expect(keys.state()).toBe('unlocked');
  });
});

describe('enrollRealmRecoveryKey — the shared door', () => {
  /** The race the old code assumed away. Two concurrent first-pairs with
   *  DIFFERENT keys both passed `initServerVault`'s orphan guard, because
   *  it checks before its own await and never rechecks — so the keyfile,
   *  bundle, database and sentinel could each end up bound to a different
   *  key. The door serializes; exactly one key may win, whole. */
  it('two concurrent first enrollments with different keys cannot split the realm', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);

    const keyA = generateRecoveryKey().mnemonic;
    let keyB = generateRecoveryKey().mnemonic;
    while (keyB === keyA) keyB = generateRecoveryKey().mnemonic;

    const [a, b] = await Promise.all([
      enrollRealmRecoveryKey({ recoveryKeyCheck, recoveryKey: keyA, keys, keyStore, database }),
      enrollRealmRecoveryKey({ recoveryKeyCheck, recoveryKey: keyB, keys, keyStore, database }),
    ]);

    // Exactly one enrolls; the loser is rejected as a different account —
    // never a second, partial enrollment.
    const outcomes = [a, b].map((r) => (r.ok ? r.outcome : r.code)).sort();
    expect(outcomes).toEqual(['enrolled', 'mismatch']);

    // And the realm is whole: the winner's key opens the bundle the
    // keyfile-held server key unlocks, and the sentinel agrees with it.
    const winner = a.ok ? keyA : keyB;
    const loser = a.ok ? keyB : keyA;
    expect(await verifyRecoveryKeyAgainstRealm(recoveryKeyCheck, winner)).toBe('match');
    expect(await verifyRecoveryKeyAgainstRealm(recoveryKeyCheck, loser)).toBe('mismatch');

    const restarted = createKeyManager(store);
    expect(await autoUnlockServerVaultFromKeyfile({ keys: restarted, keyStore })).toBe('unlocked');
    expect(b64(restarted.keyProvider('server-data')())).toBe(b64(keys.keyProvider('server-data')()));
  });

  it('a malformed mnemonic reports invalid, not mismatch, on an enrolled realm', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);

    const enrolled = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: generateRecoveryKey().mnemonic, keys, keyStore, database,
    });
    expect(enrolled.ok).toBe(true);

    const typo = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: 'not a valid mnemonic', keys, keyStore, database,
    });
    expect(typo.ok).toBe(false);
    expect(typo.ok === false && typo.code).toBe('invalid');
  });

  it('refuses rather than enrolling sentinel-only when the keyfile is missing', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);

    // `keys` wired but no keyStore — a wiring bug. Opening the gate here
    // is what left the WS door enrolled over a plaintext database.
    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: generateRecoveryKey().mnemonic, keys, database,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe('not_configured');
    expect(recoveryKeyCheck.exists()).toBe(false);
    expect(keys.state()).toBe('uninitialized');
  });
});

describe('autoUnlockServerVaultFromKeyfile', () => {
  it('enroll → restart → auto-unlock recovers the SAME Master DEK', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();

    // First boot: enrol.
    const km1 = createKeyManager(store);
    const database = await createEnrollmentDatabase();
    await enrollServerVaultFromRecoveryKey({
      keys: km1, keyStore, database, recoveryKey: generateRecoveryKey().mnemonic,
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
    const database = await createEnrollmentDatabase();
    await enrollServerVaultFromRecoveryKey({
      keys: km1,
      keyStore: createInMemoryServerKeyStore(),
      database,
      recoveryKey: generateRecoveryKey().mnemonic,
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

describe('enrollRealmRecoveryKey — the bundle is the authoritative anchor', () => {
  /** A realm has two anchors, and the gap between "encryption on" and "sentinel
   *  written" is not transactional — a crash, or a sentinel write that fails on
   *  a full/read-only disk, leaves a bundle with NO sentinel, permanently.
   *
   *  Gating only on the sentinel skipped the match check entirely in that
   *  state, so the next caller's key was enrolled over a realm still encrypted
   *  under the owner's. The owner's real key then read as `mismatch` here and
   *  at the archive realm gate, while the stranger's matched — and because an
   *  enrolled realm no longer demands a pairing code, they could pair outright. */
  it('refuses a stranger when the sentinel is missing but the vault bundle is not', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);

    const ownerKey = generateRecoveryKey().mnemonic;
    let strangerKey = generateRecoveryKey().mnemonic;
    while (strangerKey === ownerKey) strangerKey = generateRecoveryKey().mnemonic;

    expect((await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: ownerKey, keys, keyStore, database,
    })).ok).toBe(true);

    // The crash window: encryption is on and the bundle is on disk, but the
    // sentinel is gone.
    recoveryKeyCheck.clear();
    expect(recoveryKeyCheck.exists()).toBe(false);
    expect(keys.state()).toBe('unlocked');

    const hijack = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: strangerKey, keys, keyStore, database,
    });
    expect(hijack.ok).toBe(false);
    expect(hijack.ok === false && hijack.code).toBe('mismatch');
    // Nothing bound: the realm did not silently acquire a new owner.
    expect(recoveryKeyCheck.exists()).toBe(false);

    // The real owner still gets in, and re-seals the sentinel to their key.
    const recovered = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: ownerKey, keys, keyStore, database,
    });
    expect(recovered.ok).toBe(true);
    expect(await verifyRecoveryKeyAgainstRealm(recoveryKeyCheck, ownerKey)).toBe('match');
    expect(await verifyRecoveryKeyAgainstRealm(recoveryKeyCheck, strangerKey)).toBe('mismatch');
  });
});

describe('a failed auth.unlock must not turn a locked realm into an unopenable one', () => {
  /** The documented rescue path used to be the thing that broke the realm.
   *  `unlock()` consulted only the LEGACY password bundle, which a D-212 realm
   *  never has, so it flipped state to `uninitialized` while the vault sidecar
   *  sat on disk. A re-pair then saw `uninitialized`, overwrote the keyfile,
   *  and only afterwards hit `initServerVault`'s guard — leaving a keyfile that
   *  cannot open the bundle it is paired with. Entry condition: "auto-unlock
   *  failed, vault is locked", which is exactly the disaster-recovery situation
   *  the boot log points operators at. */
  it('unlock with the recovery key opens a server-vault realm instead of drifting state', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKey = generateRecoveryKey().mnemonic;
    await enrollServerVaultFromRecoveryKey({
      keys: createKeyManager(store), keyStore, recoveryKey, database,
    });

    // Restart: a fresh manager over the persisted sidecar, nothing in RAM.
    const restarted = createKeyManager(store);
    expect(restarted.state()).toBe('locked');

    await restarted.unlock({ recoveryKey });
    expect(restarted.state()).toBe('unlocked');
  });

  it('a password unlock refuses without drifting state, and the keyfile survives a re-pair', async () => {
    const store = mkBundleStore();
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKey = generateRecoveryKey().mnemonic;
    await enrollServerVaultFromRecoveryKey({
      keys: createKeyManager(store), keyStore, recoveryKey, database,
    });
    const keyfileAtRest = b64(keyStore.loadServerVaultKey());

    const restarted = createKeyManager(store);
    await expect(restarted.unlock({ password: 'anything' })).rejects.toThrow(/recovery key/i);
    // Locked is the truth. Drifting to `uninitialized` is what armed the brick.
    expect(restarted.state()).toBe('locked');

    // And from a manager whose in-memory state genuinely disagrees with disk,
    // enrollment still refuses on the DURABLE bundle rather than minting a
    // replacement keyfile key over it. `initialServerBundle` is the pre-storage
    // boot snapshot, so a realm that acquired its bundle after that snapshot
    // was taken presents exactly this shape: `uninitialized` over a live
    // sidecar. `state` alone would wave it through.
    const drifted = createKeyManager({ ...store, initialServerBundle: null });
    expect(drifted.state()).toBe('uninitialized');
    expect(drifted.hasServerBundle()).toBe(true);
    expect(await enrollServerVaultFromRecoveryKey({
      keys: drifted, keyStore, recoveryKey, database,
    })).toBe('already_enrolled');
    expect(b64(keyStore.loadServerVaultKey())).toBe(keyfileAtRest);

    // The realm still opens with the key the user was shown.
    const proof = createKeyManager(store);
    await proof.unlock({ recoveryKey });
    expect(proof.state()).toBe('unlocked');
  });
});

describe('D-212 §7.10 — enrollment does NOT gate on keyfile sealing', () => {
  /** §7.9's `keyfile_sealing_required` refusal is RETRACTED, and these tests are
   *  its inverse. The refusal fired on essentially every headless Linux install
   *  (`systemd-creds` declines in containers AND on any single-partition host),
   *  named a remedy documented in no user-facing surface, was rendered by the
   *  webclient as "check the URL", and following it BRICKED the server.
   *
   *  §7.10 moves the sealing decision to first boot — where the keyfile is still
   *  disposable, holding signing keys and no server vault key — and enforces the
   *  floor by making the posture legible rather than by refusing. An unsealed
   *  keyfile at enrollment is the operator's informed choice.
   *
   *  ⚠ The stores below COUNT posture reads. `enrollRealmRecoveryKey`'s
   *  `keyStore` type no longer admits `sealingPosture`, so a reintroduced gate
   *  would not typecheck — the counter catches the case where someone re-widens
   *  the type first and reintroduces the gate second. */
  const unsealedStore = (posture: 'machine' | 'passphrase' | 'none' = 'none') => {
    const calls = { posture: 0 };
    return {
      calls,
      keyStore: {
        saveServerVaultKey: () => {},
      loadServerVaultKey: () => null, // no prior key ⇒ no sibling realm to orphan
        flush: async () => {},
        sealingPosture: () => { calls.posture += 1; return posture; },
      },
    };
  };

  it('enrolls over an UNSEALED keyfile, and never consults its posture', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
    const { calls, keyStore } = unsealedStore('none');

    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck,
      recoveryKey: generateRecoveryKey().mnemonic,
      keys,
      keyStore,
      database,
    });

    // The realm IS encrypted and bound; how the keyfile beside it is protected
    // is a separate, first-boot decision that this path must not re-litigate.
    expect(res.ok).toBe(true);
    expect(keys.state()).toBe('unlocked');
    expect(recoveryKeyCheck.exists()).toBe(true);
    expect(calls.posture).toBe(0);
  });

  it('enrolls identically whatever the posture reports', async () => {
    for (const posture of ['machine', 'passphrase', 'none'] as const) {
      const store = mkBundleStore();
      const keys = createKeyManager(store);
      const database = await createEnrollmentDatabase();
      const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
      const { calls, keyStore } = unsealedStore(posture);

      const res = await enrollRealmRecoveryKey({
        recoveryKeyCheck,
        recoveryKey: generateRecoveryKey().mnemonic,
        keys,
        keyStore,
        database,
      });
      expect(res.ok).toBe(true);
      expect(keys.state()).toBe('unlocked');
      expect(calls.posture).toBe(0);
    }
  });

  it('leaves stores that report no posture alone — db-less test compositions', async () => {
    const store = mkBundleStore();
    const keys = createKeyManager(store);
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);

    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck,
      recoveryKey: generateRecoveryKey().mnemonic,
      keys,
      keyStore: {
        saveServerVaultKey: () => {},
        // No prior key ⇒ nothing is wrapped to it ⇒ no sibling realm to orphan.
        loadServerVaultKey: () => null,
        flush: async () => {},
      },
      database,
    });
    expect(res.ok).toBe(true);
  });
});

describe('D-212 — cross-process keyfile reservation', () => {
  it('reports `busy` when ANOTHER process holds the directory, and binds nothing', async () => {
    // The hole this closes: the sibling-realm guard is a check-then-act over a
    // DIRECTORY-scoped keyfile, and a promise chain only serializes one
    // process. A second server process sharing the directory could scan, see
    // no sibling, and write over the first one's key.
    const keys = createKeyManager(mkBundleStore());
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
    const recoveryKey = generateRecoveryKey().mnemonic;

    // A live foreign holder — `process.pid` is alive by definition, and using
    // it means the liveness check is the REAL one, not a stub.
    writeFileSync(
      join(dirname(database.name), KEYFILE_RESERVATION_FILE),
      JSON.stringify({ pid: process.pid, nonce: 'foreign', at: 1 }),
    );

    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey, keys, keyStore, database,
    });

    // `busy`, never `invalid`: the operator's key is fine and retrying is the
    // right response — the same shape as a WAL checkpoint blocked by a reader.
    expect(res).toMatchObject({ ok: false, code: 'busy' });
    // ⛔ And nothing was bound. A refusal that still wrote the sentinel would
    // leave the realm enrolled to a key whose encryption never turned on.
    expect(recoveryKeyCheck.exists()).toBe(false);
  });

  it('proceeds once the holder is gone, leaving no reservation behind', async () => {
    const keys = createKeyManager(mkBundleStore());
    const keyStore = createInMemoryServerKeyStore();
    const database = await createEnrollmentDatabase();
    const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
    const lock = join(dirname(database.name), KEYFILE_RESERVATION_FILE);

    // A dead holder is crash debris, not a holder: honouring it forever would
    // turn one crash into a directory that can never pair again.
    writeFileSync(lock, JSON.stringify({ pid: 999_999, nonce: 'stale', at: 1 }));

    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey: generateRecoveryKey().mnemonic, keys, keyStore, database,
    });

    expect(res).toMatchObject({ ok: true, outcome: 'enrolled' });
    expect(existsSync(lock)).toBe(false);
  });
});
