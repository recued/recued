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
  mkdtempSync,
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

  it('opening encrypted file without passphrase fails', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.enc.json');
      const passphrase = 'correct-horse-battery-staple';
      const store = await createFileServerKeyStore({
        filePath: path, passphrase, argon2_params: FAST_ARGON2,
      });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      await expect(createFileServerKeyStore({ filePath: path })).rejects.toThrow(
        /encrypted but no passphrase/,
      );
    } finally {
      cleanupDir(dir);
    }
  });

  it('opening unencrypted file with passphrase fails', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'keys.json');
      const store = await createFileServerKeyStore({ filePath: path });
      ensureServerIdentityKeys(store);
      await flushFileServerKeyStore(store);
      await expect(
        createFileServerKeyStore({
          filePath: path, passphrase: 'foo', argon2_params: FAST_ARGON2,
        }),
      ).rejects.toThrow(/unencrypted but a passphrase/);
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
