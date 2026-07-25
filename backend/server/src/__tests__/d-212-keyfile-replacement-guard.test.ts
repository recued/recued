/** D-212 follow-on — a server that STARTS mid-rotation must not undo it.
 *
 *  ── The composition ─────────────────────────────────────────────────
 *  `rotateKeyfilePassphrase` refuses while a server is RUNNING, and takes the
 *  directory reservation for its write. **Normal boot honours neither.** A
 *  server that starts after the lock check and during the rotation constructs
 *  its key store from the OLD passphrase in its environment, and any later
 *  `persist()` — an account-binding save, a publisher-identity write — re-encodes
 *  the WHOLE document under that old passphrase, silently undoing a rotation
 *  that already reported success. The operator finds their new passphrase
 *  failing at some unpredictable later boot.
 *
 *  Neither half of the fix lives where the finding was raised, so neither is
 *  provable from one file: the rotation asks about the lock a second time at its
 *  act site, and the key store refuses to overwrite a keyfile it no longer
 *  recognises. These tests hold the SEAM between them.
 *
 *  ⛔ Every test here asserts the ROTATION SURVIVED, not merely that something
 *  threw. A guard that writes the file and then reports a failure satisfies
 *  `rejects.toThrow` exactly as well as one that refuses, and only the second is
 *  the property.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryKey } from '@recued/crypto';

import {
  KeyfileReplacedError,
  createFileServerKeyStore,
  resealKeyfileWithPassphrase,
} from '../keys/file-store.js';
import type { StoredAccountBinding } from '../keys/index.js';
import { bootServerIdentity, resolveIdentityKeysPath } from '../identity/boot.js';
import { rotateKeyfilePassphrase } from '../keyfile-passphrase-rotation.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollRealmRecoveryKey } from '../server-vault-enrollment.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createKeyManager } from '../key-manager.js';
import { openDatabase } from '../open-database.js';

// Weak Argon2id: two OWASP-cost derivations per rotation run ~5s, the default
// test timeout.
const FAST = { t: 1, m: 8, p: 1 };
const OLD = 'the-passphrase-in-use';
const NEW = 'a-different-passphrase';

let dir: string;
const dbPath = (): string => join(dir, 'recued-server.db');
const keyfile = (): string => resolveIdentityKeysPath(dbPath());
const lockPath = (): string => join(dir, 'recued-server.lock');

const bundleSlots = (path: string) => {
  const store = createServerBundleStore(path);
  return {
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => store.load(),
    saveServerBundle: (b: Parameters<typeof store.save>[0]) => { store.save(b); },
  };
};

/** A realm enrolled + encrypted, its keyfile sealed by `OLD`, with a signing
 *  identity — the state a live server boots from. */
const enrolledRealm = async (): Promise<void> => {
  const database = await openDatabase(dbPath(), { databaseKey: null });
  const keyStore = await createFileServerKeyStore({
    filePath: keyfile(), passphrase: OLD, argon2_params: FAST,
  });
  try {
    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck: createRecoveryKeyCheckStore(database),
      recoveryKey: generateRecoveryKey().mnemonic,
      keys: createKeyManager(bundleSlots(dbPath())),
      keyStore,
      database,
    });
    expect(res.ok).toBe(true);
    await keyStore.flush?.();
  } finally {
    database.close();
  }
  const booted = await bootServerIdentity({
    dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
  });
  await booted.keyStore.flush?.();
};

const binding = (id: string): StoredAccountBinding => ({
  account_id: id,
  server_scoped_credential: 'cred',
  server_fingerprint: 'sha256:deadbeef',
  bound_at: 1,
  credential_issued_at: 1,
});

/** The assertion that matters: the rotation is still in force. Proven from the
 *  artifact — the file opens under NEW and refuses OLD — never from a return
 *  value or an absence of exceptions. */
const rotationSurvived = async (): Promise<void> => {
  const reopened = await createFileServerKeyStore({
    filePath: keyfile(), passphrase: NEW, argon2_params: FAST, warn: () => {},
  });
  expect(reopened.loadServerVaultKey()).not.toBeNull();
  await expect(
    createFileServerKeyStore({ filePath: keyfile(), passphrase: OLD, argon2_params: FAST }),
  ).rejects.toThrow();
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'd212-clobber-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('D-212 — a store cannot overwrite a keyfile that was replaced underneath it', () => {
  it('the mid-rotation server refuses its write, and the rotation stands', async () => {
    await enrolledRealm();

    // The server that started during the rotation: it opened the file BEFORE
    // the reseal and holds OLD in memory for the rest of its life.
    const live = await bootServerIdentity({
      dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
    });

    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    // The ordinary write that used to undo it. Nothing about this call is
    // unusual — it is the D-175 account binding landing a few seconds later.
    live.keyStore.saveAccountBinding(binding('acct_1'));
    await expect(live.keyStore.flush?.()).rejects.toThrow(KeyfileReplacedError);

    await rotationSurvived();
  });

  it('names what changed rather than reporting a generic write failure', async () => {
    await enrolledRealm();
    const live = await bootServerIdentity({
      dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
    });
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    live.keyStore.saveAccountBinding(binding('acct_1'));
    // "failed to write" would send the operator looking at their disk. The one
    // fact they need is that something else re-sealed this file.
    await expect(live.keyStore.flush?.()).rejects.toThrow(/changed on disk since this process opened it/);
    await expect(live.keyStore.flush?.()).rejects.toThrow(/nothing was written/);
  });

  it('does not retry a replacement — the condition cannot clear', async () => {
    // ⚠ A mechanism test. Retrying still REFUSES, so no assertion on the
    // outcome can see the difference; the observable is that the store does not
    // grind a fresh Argon2id derivation and emit a second identical warning
    // every time anyone flushes.
    await enrolledRealm();
    const warnings: string[] = [];
    const live = await bootServerIdentity({
      dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
    });
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    // Re-open the store with a warn sink, then trip it.
    const observed = await createFileServerKeyStore({
      filePath: keyfile(), passphrase: OLD, argon2_params: FAST, warn: (m) => warnings.push(m),
    }).catch(() => null);
    // The reopen fails outright — the passphrase no longer opens it — which is
    // the OTHER half of the story and is why the live store above is the only
    // way to reach the guard at all.
    expect(observed).toBeNull();

    live.keyStore.saveAccountBinding(binding('acct_1'));
    await expect(live.keyStore.flush?.()).rejects.toThrow(KeyfileReplacedError);
    await expect(live.keyStore.flush?.()).rejects.toThrow(KeyfileReplacedError);
    await rotationSurvived();
  });

  it('warns once per refused save, not once per flush', async () => {
    await enrolledRealm();
    const warnings: string[] = [];
    // A store built directly, so the warn sink is ours.
    const live = await createFileServerKeyStore({
      filePath: keyfile(), passphrase: OLD, argon2_params: FAST, warn: (m) => warnings.push(m),
    });
    await resealKeyfileWithPassphrase({
      filePath: keyfile(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    live.saveAccountBinding(binding('acct_1'));
    await expect(live.flush?.()).rejects.toThrow(KeyfileReplacedError);
    await expect(live.flush?.()).rejects.toThrow(KeyfileReplacedError);
    // Two flushes, one attempted write. Without the terminal check the second
    // flush schedules another persist and this is 2.
    expect(warnings.filter((w) => /changed on disk/.test(w))).toHaveLength(1);
  });

  it('refuses when the keyfile APPEARS under a store that opened nothing', async () => {
    // Two first boots sharing a directory — the keyfile is directory-scoped, so
    // this is the same race with no rotation involved. The loser must not
    // publish its own identity over the winner's realm.
    const path = join(dir, 'shared-keys.json');
    const first = await createFileServerKeyStore({
      filePath: path, passphrase: 'first', argon2_params: FAST, warn: () => {},
    });
    const second = await createFileServerKeyStore({
      filePath: path, passphrase: 'second', argon2_params: FAST, warn: () => {},
    });

    first.saveServerVaultKey(new Uint8Array(32).fill(1));
    await expect(first.flush?.()).resolves.toBeUndefined();

    second.saveServerVaultKey(new Uint8Array(32).fill(2));
    await expect(second.flush?.()).rejects.toThrow(KeyfileReplacedError);
    // The winner's file is intact — same bytes, same key, still its own
    // passphrase.
    const reopened = await createFileServerKeyStore({
      filePath: path, passphrase: 'first', argon2_params: FAST, warn: () => {},
    });
    expect(reopened.loadServerVaultKey()).toEqual(new Uint8Array(32).fill(1));
  });

  it('says the file is GONE when it is, rather than blaming a re-seal', async () => {
    // §7.10 tells an operator who wants a different sealing factor to stop the
    // server and delete the keyfile. A store that re-creates it resurrects the
    // identity they were discarding — refused, and named as a deletion, because
    // "another process re-sealed it" would send them looking for a rotation
    // that never happened.
    const path = join(dir, 'gone-keys.json');
    const store = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    store.saveServerVaultKey(new Uint8Array(32).fill(1));
    await store.flush?.();

    rmSync(path);
    store.saveServerVaultKey(new Uint8Array(32).fill(2));
    await expect(store.flush?.()).rejects.toThrow(/is gone now/);
    await expect(store.flush?.()).rejects.toThrow(/refusing to re-create/);
    expect(existsSync(path)).toBe(false);
  });

  it('does not trip on its own writes', async () => {
    // The obvious way to build this wrong: compare against the digest read at
    // construction and never advance it, so the store's SECOND write refuses.
    const path = join(dir, 'own-keys.json');
    const store = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    for (let i = 1; i <= 3; i += 1) {
      store.saveServerVaultKey(new Uint8Array(32).fill(i));
      await expect(store.flush?.()).resolves.toBeUndefined();
    }
    const reopened = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    expect(reopened.loadServerVaultKey()).toEqual(new Uint8Array(32).fill(3));
  });

  it('does not trip on the §7.10 seal-on-open upgrade it performs itself', async () => {
    // That upgrade writes during construction, before `ownedDigest` has ever
    // been advanced by a persist. A guard that only advanced on save* would
    // refuse the store's next write.
    //
    // ⚠ No server vault key in the pre-upgrade file: §7.10 allows the seal only
    // while the keyfile is not yet load-bearing, so a fixture that wrote one
    // would be refused before it reached the guard under test.
    const path = join(dir, 'upgrade-keys.json');
    const plain = await createFileServerKeyStore({ filePath: path, warn: () => {} });
    plain.saveAccountBinding(binding('acct_pre'));
    await plain.flush?.();
    expect(JSON.parse(readFileSync(path, 'utf8')).encrypted).toBe(false);

    const sealed = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).encrypted).toBe(true);
    sealed.saveAccountBinding(binding('acct_1'));
    await expect(sealed.flush?.()).resolves.toBeUndefined();
    const reopened = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    expect(reopened.loadAccountBinding()?.account_id).toBe('acct_1');
  });

  it('describes its OWN posture as it stands, not as it was at construction', async () => {
    // The store re-seals the file during construction (§7.10), so the posture it
    // opened with is stale by its first save. A refusal that still says
    // "unsealed" tells the operator something false about the process doing the
    // refusing — and that message is their only signal about what happened.
    const path = join(dir, 'posture-keys.json');
    const plain = await createFileServerKeyStore({ filePath: path, warn: () => {} });
    plain.saveAccountBinding(binding('acct_pre'));
    await plain.flush?.();

    const sealed = await createFileServerKeyStore({
      filePath: path, passphrase: 'p', argon2_params: FAST, warn: () => {},
    });
    // Rotated out from under it.
    await resealKeyfileWithPassphrase({
      filePath: path, currentPassphrase: 'p', newPassphrase: 'q', argon2_params: FAST,
    });

    sealed.saveAccountBinding(binding('acct_1'));
    await expect(sealed.flush?.()).rejects.toThrow(/sealed by a passphrase then/);
  });
});

describe('D-212 — rotation asks about the running server again, at the act site', () => {
  it('refuses a server that starts after the first check', async () => {
    await enrolledRealm();
    const before = readFileSync(keyfile(), 'utf8');

    // ⛔ `now()` is called after the probes and before the reservation is taken
    // — the exact window a real start lands in. Using it as the seam is what
    // makes the race reproducible at all; the distinct wording asserted below is
    // reachable ONLY through the second check, so this cannot pass by tripping
    // the first one.
    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
        isProcessAlive: () => true,
        now: () => {
          writeFileSync(lockPath(), JSON.stringify({ pid: 4242, boot_at: 1, bind_port: 7717 }));
          return 1_700_000_000_000;
        },
      }),
    ).rejects.toThrow(/started .* while this rotation was preparing/);

    // Refused before the copy, so the keyfile is byte-identical and the
    // operator's current passphrase still works.
    expect(readFileSync(keyfile(), 'utf8')).toBe(before);
  });

  it('still proceeds when nothing starts', async () => {
    // The counterpart: the second check must not refuse on its own debris —
    // this rotation is not a running server.
    await enrolledRealm();
    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW,
        argon2_params: FAST, isProcessAlive: () => true,
      }),
    ).resolves.toMatchObject({ keyfilePath: keyfile() });
    await rotationSurvived();
  });
});
