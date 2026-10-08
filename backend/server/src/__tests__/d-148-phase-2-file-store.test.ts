/** D-148 P2 — file-backed ServerKeyStore.
 *
 *  Acceptance per spec § P2:
 *   - First boot creates a key + persists it.
 *   - Second boot reads the same key (idempotent).
 *   - Mismatched key_class on save throws (I-7 storage discipline).
 *   - Plain JSON mode roundtrips.
 *   - Passphrase-encrypted mode roundtrips + wrong passphrase fails.
 *   - Corrupt file fails clean (no silent overwrite).
 *   - Atomic write — partial-write crash never leaves file half-
 *     populated.
 */

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFileServerKeyStore,
  flushFileServerKeyStore,
} from '../keys/file-store.js';
import {
  generateEd25519Keypair,
  ensureServerIdentityKeys,
} from '../keys/index.js';

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'd148-p2-keystore-'));
const cleanupDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

describe('D-148 P2 — file-backed ServerKeyStore (plain JSON)', () => {
  it('first boot creates + persists keys', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      const { server_identity, publisher_identity } = ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      expect(existsSync(path)).toBe(true);
      // Re-open: same fingerprints.
      const reopened = await createFileServerKeyStore({ filePath: path });
      expect(reopened.loadServerIdentityKey()?.public_key_fingerprint)
        .toBe(server_identity.public_key_fingerprint);
      expect(reopened.loadPublisherIdentityKey()?.public_key_fingerprint)
        .toBe(publisher_identity.public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  it('second boot is idempotent (does NOT regenerate)', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const first = await createFileServerKeyStore({ filePath: path });
      const a = ensureServerIdentityKeys(first);
      await flushFileServerKeyStore(first);
      const second = await createFileServerKeyStore({ filePath: path });
      const b = ensureServerIdentityKeys(second);
      expect(b.server_identity.public_key_fingerprint).toBe(a.server_identity.public_key_fingerprint);
      expect(b.publisher_identity.public_key_fingerprint).toBe(a.publisher_identity.public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  it('refuses mismatched key_class on save', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      const server_identity = generateEd25519Keypair('server_identity_key');
      expect(() => store.savePublisherIdentityKey(server_identity)).toThrow(
        /publisher_identity_key/,
      );
      const publisher_identity = generateEd25519Keypair('publisher_identity_key');
      expect(() => store.saveServerIdentityKey(publisher_identity)).toThrow(
        /server_identity_key/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it('file mode is 0600 (owner-only read/write)', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      const stat = statSync(path);
      // Lower 9 mode bits — owner/group/other rwx. Should be rw------- = 0o600.
      const perm = stat.mode & 0o777;
      expect(perm).toBe(0o600);
    } finally {
      cleanupDir(dir);
    }
  });

  it('rejects malformed file at construction', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      writeFileSync(path, 'not json{');
      await expect(createFileServerKeyStore({ filePath: path })).rejects.toThrow(/valid JSON/);
    } finally {
      cleanupDir(dir);
    }
  });

  it('rejects unsupported version at construction', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      writeFileSync(path, JSON.stringify({ version: 99, encrypted: false, payload: '' }));
      await expect(createFileServerKeyStore({ filePath: path })).rejects.toThrow(
        /unsupported version/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it('rejects key_class mismatch in stored file (tamper detection)', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      // Manually swap the key_class field in the unencrypted file.
      const fs = await import('node:fs');
      const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
      const innerB64 = raw.payload as string;
      const buf = Buffer.from(innerB64, 'base64');
      const inner = JSON.parse(buf.toString('utf8'));
      inner.server_identity.key_class = 'publisher_identity_key';
      raw.payload = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
      fs.writeFileSync(path, JSON.stringify(raw));
      const reopened = await createFileServerKeyStore({ filePath: path });
      expect(() => reopened.loadServerIdentityKey()).toThrow(/wrong key_class/);
    } finally {
      cleanupDir(dir);
    }
  });

  it('creates parent directory when missing', async () => {
    const dir = makeTempDir();
    try {
      const nested = join(dir, 'sub', 'dir');
      const path = join(nested, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

// Use FAST_ARGON2 in tests so KEK derivation completes well under
// the default vitest timeout. Production callers leave argon2_params
// unset and pick up the OWASP 2024 baseline.
const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

describe('D-148 P2 — file-backed ServerKeyStore (passphrase-encrypted)', () => {
  it('encrypted roundtrip with correct passphrase', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.enc.json');
      const passphrase = 'correct-horse-battery-staple';
      const store = await createFileServerKeyStore({
        filePath: path, passphrase, argon2_params: FAST_ARGON2,
      });
      const { server_identity } = ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      const reopened = await createFileServerKeyStore({
        filePath: path, passphrase, argon2_params: FAST_ARGON2,
      });
      expect(reopened.loadServerIdentityKey()?.public_key_fingerprint).toBe(
        server_identity.public_key_fingerprint,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it('wrong passphrase fails decrypt', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.enc.json');
      const passphrase = 'correct-horse-battery-staple';
      const store = await createFileServerKeyStore({
        filePath: path, passphrase, argon2_params: FAST_ARGON2,
      });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      await expect(
        createFileServerKeyStore({
          filePath: path, passphrase: 'wrong', argon2_params: FAST_ARGON2,
        }),
      ).rejects.toThrow(/decryption failed/);
    } finally {
      cleanupDir(dir);
    }
  });

  it('opening encrypted file without passphrase fails — saying which file and what to set', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.enc.json');
      const passphrase = 'correct-horse-battery-staple';
      const store = await createFileServerKeyStore({
        filePath: path, passphrase, argon2_params: FAST_ARGON2,
      });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      // This message is a passphrase-sealed server's WHOLE boot output, so it
      // must say what to do: it used to say only "file is encrypted but no
      // passphrase supplied" while the installer promised a server that waits
      // for `recued unlock` (2026-10-07).
      const opened = createFileServerKeyStore({ filePath: path });
      await expect(opened).rejects.toThrow(/sealed with a passphrase/);
      await expect(opened).rejects.toThrow(/RECUED_IDENTITY_PASSPHRASE is not set/);
      await expect(opened).rejects.toThrow(path);
      await expect(opened).rejects.toThrow(/service's own environment/);
    } finally {
      cleanupDir(dir);
    }
  });

  /** D-212 §7.10 — this used to assert a throw, and that throw was a defect.
   *
   *  First boot flushes a plaintext keyfile BEFORE pairing exists, and the
   *  unsealed-keyfile warning tells the operator to set the passphrase. So the
   *  refusal fired on the exact remedy the product prescribes: the operator set
   *  the variable, restarted, and the server did not boot. The old test name
   *  ("fails") read as intent, which is how it survived.
   *
   *  Opening a plaintext keyfile WITH a passphrase is now the sealing upgrade —
   *  bounded to files that are not yet load-bearing (see the vault-key case
   *  below), because after that point sealing is fixed for the realm's life. */
  it('opening an unencrypted file with a passphrase SEALS it, durably', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const first = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(first);
      await flushFileServerKeyStore(first);
      const fingerprint = first.loadServerIdentityKey()?.public_key_fingerprint;
      expect(JSON.parse(readFileSync(path, 'utf8')).encrypted).toBe(false);

      const upgraded = await createFileServerKeyStore({
        filePath: path, passphrase: 'foo', argon2_params: FAST_ARGON2,
      });

      // Sealed on disk before the constructor returned — not merely scheduled.
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      expect(doc.encrypted).toBe(true);
      expect(doc.kdf_salt_b64).toBeTypeOf('string');
      // A machine seal is NOT what happened; the passphrase is the operator's
      // stated intent and outranks the ladder (§7.4).
      expect(Object.hasOwn(doc, 'sealed_by')).toBe(false);
      expect(upgraded.sealingPosture?.()).toBe('passphrase');
      // The identity survived the re-seal — an upgrade, not a reset.
      expect(upgraded.loadServerIdentityKey()?.public_key_fingerprint).toBe(fingerprint);

      // And it now genuinely requires that passphrase.
      await expect(createFileServerKeyStore({ filePath: path }))
        .rejects.toThrow(/sealed with a passphrase, and RECUED_IDENTITY_PASSPHRASE is not set/);
      const reopened = await createFileServerKeyStore({
        filePath: path, passphrase: 'foo', argon2_params: FAST_ARGON2,
      });
      expect(reopened.loadServerIdentityKey()?.public_key_fingerprint).toBe(fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  /** ⛔ The boundary on that upgrade. Once the keyfile holds the server vault
   *  key it opens the warehouse, sealing is fixed for the realm's life, and a
   *  passphrase appearing in the environment for one accidental run must not
   *  silently re-seal a live realm — removing it again would lock the operator
   *  out of their own data. That transition is §7.11's, taken deliberately. */
  it('REFUSES to seal a keyfile that already holds the server vault key', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(store);
      store.saveServerVaultKey(new Uint8Array(32).fill(7));
      await flushFileServerKeyStore(store);

      await expect(
        createFileServerKeyStore({
          filePath: path, passphrase: 'foo', argon2_params: FAST_ARGON2,
        }),
      ).rejects.toThrow(/already holds this realm's server vault key/);

      // Nothing was written on refusal — the file is exactly as it was.
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      expect(doc.encrypted).toBe(false);
    } finally {
      cleanupDir(dir);
    }
  });

  it('encrypted file does NOT contain plaintext key_class strings', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.enc.json');
      const store = await createFileServerKeyStore({
        filePath: path,
        passphrase: 'correct-horse-battery-staple',
        argon2_params: FAST_ARGON2,
      });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      const fs = await import('node:fs');
      const raw = fs.readFileSync(path, 'utf8');
      // The plaintext markers should never appear in the encrypted body.
      expect(raw).not.toContain('server_identity_key');
      expect(raw).not.toContain('publisher_identity_key');
      // The payload should be AEAD ciphertext base64 — no JSON sub-objects.
      const parsed = JSON.parse(raw);
      expect(parsed.encrypted).toBe(true);
      expect(typeof parsed.payload).toBe('string');
      expect(typeof parsed.kdf_salt_b64).toBe('string');
      // The persisted KDF params match what we used at write.
      expect(parsed.kdf_params).toEqual(FAST_ARGON2);
    } finally {
      cleanupDir(dir);
    }
  });
});

/** Saves are sync at the interface and persist in the background, so every
 *  write failure lands on one shared promise chain. What that chain does with a
 *  failure decides whether the keyfile recovers or quietly stops being written.
 *
 *  The failure here is a real one rather than a mocked throw: a DIRECTORY
 *  standing where the keyfile goes makes the publisher's `rename` fail with
 *  EISDIR every time, and removing it lets the very next write through. */
describe('D-148 P2 — a failed keyfile write does not stop the next one', () => {
  const blockWrites = (path: string): void => { mkdirSync(path); };
  const unblockWrites = (path: string): void => { rmSync(path, { recursive: true }); };

  it('writes to disk again after a failure, and flush stops reporting it', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path, warn: () => {} });

      blockWrites(path);
      store.saveServerVaultKey(new Uint8Array(32).fill(7));
      await expect(flushFileServerKeyStore(store)).rejects.toThrow();

      // The disk comes back, and a later save has to actually reach it — under
      // the old chain this save short-circuited on the rejected promise and the
      // keyfile was never written again for the life of the process.
      unblockWrites(path);
      const key = new Uint8Array(32).fill(9);
      store.saveServerVaultKey(key);
      await expect(flushFileServerKeyStore(store)).resolves.toBeUndefined();

      const reopened = await createFileServerKeyStore({ filePath: path });
      expect(reopened.loadServerVaultKey()).toEqual(key);
    } finally {
      cleanupDir(dir);
    }
  });

  it('keeps every earlier save, so the recovered file is whole', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path, warn: () => {} });

      // The identity keys are saved while the disk is refusing writes. They
      // exist only in the cache at that point; the write that finally lands has
      // to carry them, or a rotation survives in memory and nowhere else.
      blockWrites(path);
      const { server_identity, publisher_identity } = ensureServerIdentityKeys(store);
      await expect(flushFileServerKeyStore(store)).rejects.toThrow();

      unblockWrites(path);
      store.saveServerVaultKey(new Uint8Array(32).fill(3));
      await flushFileServerKeyStore(store);

      const reopened = await createFileServerKeyStore({ filePath: path });
      expect(reopened.loadServerIdentityKey()?.public_key_fingerprint)
        .toBe(server_identity.public_key_fingerprint);
      expect(reopened.loadPublisherIdentityKey()?.public_key_fingerprint)
        .toBe(publisher_identity.public_key_fingerprint);
    } finally {
      cleanupDir(dir);
    }
  });

  it('flush retries rather than replaying the error it reported before', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path, warn: () => {} });

      blockWrites(path);
      store.saveServerVaultKey(new Uint8Array(32).fill(1));
      await expect(flushFileServerKeyStore(store)).rejects.toThrow();

      // No further save — only the condition clears. A flush that reported from
      // memory would still be handing back the old error here.
      unblockWrites(path);
      await expect(flushFileServerKeyStore(store)).resolves.toBeUndefined();
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  it('reports a write failure that is still live', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const warnings: string[] = [];
      const store = await createFileServerKeyStore({
        filePath: path, warn: (m) => warnings.push(m),
      });

      blockWrites(path);
      store.saveServerVaultKey(new Uint8Array(32).fill(1));
      await expect(flushFileServerKeyStore(store)).rejects.toThrow();
      // Still blocked, so the answer must not have changed.
      await expect(flushFileServerKeyStore(store)).rejects.toThrow();
      // And a save nobody flushes is not silent.
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain(path);
    } finally {
      cleanupDir(dir);
    }
  });

  it('never lets a background write failure reach the process as an unhandled rejection', async () => {
    const dir = makeTempDir();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path, warn: () => {} });

      // saveAccountBinding and friends are fire-and-forget by design — nothing
      // awaits them. The server's own `unhandledRejection` handler treats what
      // escapes as fatal and exits 1, so a full disk during a rotation would
      // take the server down.
      blockWrites(path);
      store.saveAccountBinding({
        account_id: 'acct_1',
        server_scoped_credential: 'cred',
        server_fingerprint: 'fp',
        bound_at: 1,
        credential_issued_at: 1,
      });
      store.saveServerVaultKey(new Uint8Array(32).fill(5));

      // Long enough for the persists to settle and for Node to have decided
      // whether anything went unhandled.
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      cleanupDir(dir);
    }
  });
});
