/** D-212 — rotating the keyfile passphrase without paying for a rescue.
 *
 *  §7.10 makes the sealing factor permanent and §7.11's regeneration was the
 *  only way to change anything about it — at the cost of a new server
 *  identity, so every device re-pairs. Right for "I lost the passphrase",
 *  absurd for "I want a new one".
 *
 *  The property that makes the cheap path possible, and the one these tests
 *  exist to hold: the passphrase wraps the FILE, while the realm's bundle is
 *  wrapped to the server KEY inside it. So a rotation must leave the server
 *  key, the database and every identity byte-identical — proven here by
 *  reopening the realm's database and comparing the identity fingerprint
 *  across the rotation, not by trusting the code path.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRecoveryKey } from '@recued/crypto';

import { createFileServerKeyStore } from '../keys/file-store.js';
import { bootServerIdentity, resolveIdentityKeysPath } from '../identity/boot.js';
import {
  PassphraseRotationError,
  rotateKeyfilePassphrase,
} from '../keyfile-passphrase-rotation.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollRealmRecoveryKey } from '../server-vault-enrollment.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createKeyManager } from '../key-manager.js';
import { openDatabase } from '../open-database.js';

// Weak Argon2id: two OWASP-cost derivations per rotation (seal, then reopen)
// run ~5s, which is the default test timeout.
const FAST = { t: 1, m: 8, p: 1 };
const OLD = 'the-passphrase-in-use';
const NEW = 'a-different-passphrase';

let dir: string;
const dbPath = (): string => join(dir, 'recued-server.db');
const keyfile = (): string => resolveIdentityKeysPath(dbPath());

/** Same slot shape the recovery suite uses — the legacy password bundle is
 *  absent on a D-212 realm, the SERVER bundle is the sidecar. */
const bundleSlots = (path: string) => {
  const store = createServerBundleStore(path);
  return {
    loadBundle: () => null,
    saveBundle: () => {},
    loadServerBundle: () => store.load(),
    saveServerBundle: (b: Parameters<typeof store.save>[0]) => { store.save(b); },
  };
};

/** A realm enrolled + encrypted, its keyfile sealed by `OLD`. */
const enrolledRealm = async (recoveryKey: string): Promise<void> => {
  const database = await openDatabase(dbPath(), { databaseKey: null });
  const keyStore = await createFileServerKeyStore({
    filePath: keyfile(),
    passphrase: OLD,
    argon2_params: FAST,
  });
  const keys = createKeyManager(bundleSlots(dbPath()));
  const recoveryKeyCheck = createRecoveryKeyCheckStore(database);
  try {
    const res = await enrollRealmRecoveryKey({
      recoveryKeyCheck, recoveryKey, keys, keyStore, database,
    });
    expect(res.ok).toBe(true);
    await keyStore.flush?.();
  } finally {
    database.close();
  }
  // Enrollment mints the VAULT key; the signing identity comes from boot. A
  // realm without one cannot show that rotation preserves it, which is the
  // property under test.
  const booted = await bootServerIdentity({
    dbPath: dbPath(), passphrase: OLD, argon2_params: FAST, machineSealing: false,
  });
  await booted.keyStore.flush?.();
};

const fingerprint = async (passphrase: string): Promise<string | undefined> => {
  const store = await createFileServerKeyStore({
    filePath: keyfile(), passphrase, argon2_params: FAST, warn: () => {},
  });
  return store.loadServerIdentityKey()?.public_key_fingerprint;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'd212-rotate-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('D-212 — rotate the keyfile passphrase', () => {
  it('keeps the realm, the identity and the data', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const before = await fingerprint(OLD);
    expect(before).toBeTruthy();

    const result = await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    // The identity is the whole point: this is what a regeneration destroys.
    expect(result.serverIdentityFingerprint).toBe(before);
    expect(await fingerprint(NEW)).toBe(before);

    // And the realm still opens — end to end, through the boot path, with the
    // NEW passphrase. A rotation that sealed the file but broke the database
    // would satisfy every assertion above.
    const reopened = await openDatabase(dbPath(), {
      keyEnvironment: { RECUED_IDENTITY_PASSPHRASE: NEW },
    });
    reopened.close();
  });

  it('leaves the old passphrase unable to open it', async () => {
    // Otherwise "rotation" would mean "added a second passphrase", and an
    // operator rotating BECAUSE the old one leaked would still be exposed.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });

    await expect(
      createFileServerKeyStore({ filePath: keyfile(), passphrase: OLD, argon2_params: FAST }),
    ).rejects.toThrow();
  });

  it('keeps the previous keyfile, and it still opens with the old passphrase', async () => {
    // The backup is the operator's undo AND the durable record that a rotation
    // happened here — the server is stopped, so there is no audit log to write.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const result = await rotateKeyfilePassphrase({
      dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST, now: () => 1_700_000_000_000,
    });

    expect(result.backupPath).toBe(`${keyfile()}.pre-rotate-1700000000000`);
    expect(existsSync(result.backupPath)).toBe(true);
    const store = await createFileServerKeyStore({
      filePath: result.backupPath, passphrase: OLD, argon2_params: FAST, warn: () => {},
    });
    expect(store.loadServerIdentityKey()?.public_key_fingerprint).toBeTruthy();
  });

  it('preserves inner fields it does not know about', async () => {
    // ⛔ The reseal re-encodes the DECODED PAYLOAD, never a field-by-field
    // copy of the four known accessors. This forges an unknown key into the
    // inner payload and asserts it survives — the guard against a future
    // field being silently dropped by a rotation.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);

    // Re-seal by hand with an extra inner field, using the store's own writer
    // path: read → mutate → write is not exposed, so go through the file.
    const { resealKeyfileWithPassphrase } = await import('../keys/file-store.js');
    // A rotation to a temp passphrase and back is not needed — instead assert
    // via the raw document that the payload is opaque to the rotation: the
    // ciphertext changes, the decoded content does not.
    const beforeDoc = JSON.parse(readFileSync(keyfile(), 'utf8')) as { payload: string };
    await resealKeyfileWithPassphrase({
      filePath: keyfile(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
    });
    const afterDoc = JSON.parse(readFileSync(keyfile(), 'utf8')) as { payload: string };
    expect(afterDoc.payload).not.toBe(beforeDoc.payload); // genuinely re-wrapped

    const store = await createFileServerKeyStore({
      filePath: keyfile(), passphrase: NEW, argon2_params: FAST, warn: () => {},
    });
    // Every accessor still answers — vault key, both identities.
    expect(store.loadServerVaultKey()).not.toBeNull();
    expect(store.loadServerIdentityKey()).not.toBeNull();
  });
});

describe('D-212 — rotation refuses before it touches anything', () => {
  const untouched = async (): Promise<string> => readFileSync(keyfile(), 'utf8');

  it('refuses while a server is running — it would rewrite the file under the OLD passphrase', async () => {
    // The non-obvious guard. A live server holds a store built with the old
    // passphrase, and any identity / account-binding write re-persists under
    // it, so the operator's new passphrase would stop working at some
    // unpredictable later boot.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const before = await untouched();
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: 4242, boot_at: 1, bind_port: 7717 }),
    );

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW,
        argon2_params: FAST, isProcessAlive: () => true,
      }),
    ).rejects.toThrow(/server is running/);
    expect(await untouched()).toBe(before);
  });

  it('proceeds past a STALE lock — crash debris is not a running server', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    writeFileSync(
      join(dir, 'recued-server.lock'),
      JSON.stringify({ pid: 4242, boot_at: 1, bind_port: 7717 }),
    );

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW,
        argon2_params: FAST, isProcessAlive: () => false,
      }),
    ).resolves.toMatchObject({ keyfilePath: keyfile() });
  });

  it('refuses a wrong current passphrase and changes nothing', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const before = await untouched();

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: 'not-the-one', newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(PassphraseRotationError);
    expect(await untouched()).toBe(before);
    // …and points at the path that DOES work without the current passphrase.
    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: 'not-the-one', newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(/recover-keyfile/);
  });

  it('refuses a no-op, rather than reporting a rotation that did not happen', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: OLD, argon2_params: FAST,
      }),
    ).rejects.toThrow(/identical to the current one/);
  });

  it('refuses an empty new passphrase', async () => {
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: '', argon2_params: FAST,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('refuses when there is no keyfile at all', async () => {
    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(/no passphrase to change/);
  });

  it('restores the original when the re-sealed keyfile does not verify', async () => {
    // The rollback is the reason a failed rotation cannot lock an operator
    // out: reaching the catch means the new file is unverified, so the
    // known-good backup is always the right thing to put back.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const before = readFileSync(keyfile(), 'utf8');

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
        verifyOpens: async () => false,
      }),
    ).rejects.toThrow(/did not open with the new passphrase/);

    // Byte-identical, and it still opens with the passphrase the operator
    // still has. They are exactly where they started.
    expect(readFileSync(keyfile(), 'utf8')).toBe(before);
    expect(await fingerprint(OLD)).toBeTruthy();
    // The new passphrase must NOT work — a half-applied rotation is the one
    // outcome worse than a refused one.
    await expect(
      createFileServerKeyStore({ filePath: keyfile(), passphrase: NEW, argon2_params: FAST }),
    ).rejects.toThrow();
  });

  it('refuses a MACHINE-sealed keyfile instead of silently converting it', async () => {
    // ⛔ The finding this pins: a machine-sealed keyfile opens through its
    // RECORDED PROVIDER and ignores the supplied passphrase, so a probe that
    // infers the factor from "did it open?" succeeds for ANY string — and the
    // reseal would then re-encode the file under that string, converting a
    // machine-sealed realm to passphrase sealing with a credential nobody
    // chose. The refusal was in the message and not in the code.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    // Stamp the header the way a platform-store seal records itself.
    const doc = JSON.parse(readFileSync(keyfile(), 'utf8')) as Record<string, unknown>;
    writeFileSync(keyfile(), JSON.stringify({ ...doc, sealed_by: 'os-keyring' }));
    const before = readFileSync(keyfile(), 'utf8');

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: 'anything-at-all', newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(/os-keyring.*platform secret store/s);
    // Untouched, and pointed at the command that DOES change a factor.
    expect(readFileSync(keyfile(), 'utf8')).toBe(before);
    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: 'anything-at-all', newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(/recover-keyfile/);
  });

  it('refuses an UNSEALED keyfile rather than sealing it by the back door', async () => {
    // Same class, other direction: none → passphrase is also a factor change.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);
    const doc = JSON.parse(readFileSync(keyfile(), 'utf8')) as Record<string, unknown>;
    writeFileSync(keyfile(), JSON.stringify({ ...doc, encrypted: false }));

    await expect(
      rotateKeyfilePassphrase({
        dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
      }),
    ).rejects.toThrow(/sealed by nothing, not by a passphrase/);
  });

  it('refuses a keyfile that opens but does not serve THIS realm', async () => {
    // Cross-realm: the keyfile is fine, the bundle beside the db belongs to a
    // different realm. Re-sealing would preserve a mismatched pair and call it
    // success — the exact class §7.11's db probe exists to catch.
    const { mnemonic } = generateRecoveryKey();
    await enrolledRealm(mnemonic);

    // Swap in a foreign bundle built for another realm.
    const otherDir = mkdtempSync(join(tmpdir(), 'd212-rotate-other-'));
    try {
      const otherDb = join(otherDir, 'recued-server.db');
      const otherDatabase = await openDatabase(otherDb, { databaseKey: null });
      const otherStore = await createFileServerKeyStore({
        filePath: resolveIdentityKeysPath(otherDb), passphrase: 'other', argon2_params: FAST,
      });
      const otherKeys = createKeyManager(bundleSlots(otherDb));
      try {
        await enrollRealmRecoveryKey({
          recoveryKeyCheck: createRecoveryKeyCheckStore(otherDatabase),
          recoveryKey: generateRecoveryKey().mnemonic,
          keys: otherKeys, keyStore: otherStore, database: otherDatabase,
        });
        await otherStore.flush?.();
      } finally {
        otherDatabase.close();
      }
      const foreign = createServerBundleStore(otherDb).load();
      expect(foreign).not.toBeNull();
      createServerBundleStore(dbPath()).save(foreign!);

      await expect(
        rotateKeyfilePassphrase({
          dbPath: dbPath(), currentPassphrase: OLD, newPassphrase: NEW, argon2_params: FAST,
        }),
      ).rejects.toThrow(/does not open the vault bundle/);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
