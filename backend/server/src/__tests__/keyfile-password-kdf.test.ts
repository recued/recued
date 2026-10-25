import * as crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ARGON2_PARAMS, base64ToBytes, decodeCiphertext, decrypt, deriveKEKFromPassword, encodeCiphertext, encrypt,
} from '@recued/crypto';
import { createKeyfilePasswordKdf, deriveKeyfileKEK, nodeArgon2, usableNodeArgon2 } from '../keys/password-kdf.js';
import { createFileServerKeyStore } from '../keys/file-store.js';

const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
const nativeAvailable = nodeArgon2 !== null;

describe('server keyfile password KDF', () => {
  it.runIf(nativeAvailable)('matches portable default-cost derivation for ASCII and Unicode including NUL', async () => {
    for (const password of ['public fixture passphrase', '測定\0café🔑']) {
      const expected = await deriveKEKFromPassword(password, salt);
      expect(new Uint8Array(await deriveKeyfileKEK(password, salt))).toEqual(expected);
    }
  });

  it("takes Node's Argon2 only where it can run", () => {
    const argon2 = vi.fn<typeof crypto.argon2>();
    const works = { argon2, argon2Sync: () => Buffer.alloc(4), getFips: () => 0 };
    expect(usableNodeArgon2(works)).toBe(argon2);
    expect(usableNodeArgon2({ getFips: () => 0 }), 'a Node before 24.7').toBeNull();
    expect(usableNodeArgon2({ ...works, getFips: () => 1 }), 'FIPS mode').toBeNull();
    // A Node built on an OpenSSL without Argon2 still exports argon2, and every call throws.
    const unsupported = () => { throw Object.assign(new Error('Argon2 is not supported'), { code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED' }); };
    expect(usableNodeArgon2({ ...works, argon2Sync: unsupported }), 'an OpenSSL without Argon2').toBeNull();
    expect(argon2).not.toHaveBeenCalled();
  });

  it('keeps the portable reader for stored custom parameters and unavailable native APIs', async () => {
    const custom = { t: 1, m: 32, p: 1 }; const native = vi.fn<typeof crypto.argon2>();
    const expected = await deriveKEKFromPassword('fixture', salt, custom);
    expect(await createKeyfilePasswordKdf(native)('fixture', salt, custom)).toEqual(expected);
    expect(native).not.toHaveBeenCalled();
    expect(await createKeyfilePasswordKdf(null)('fixture', salt, custom)).toEqual(expected);
  });

  it('preserves password and salt validation without calling native code', async () => {
    const native = vi.fn<typeof crypto.argon2>(); const derive = createKeyfilePasswordKdf(native);
    await expect(derive('', salt)).rejects.toThrow('password must be non-empty');
    await expect(derive('fixture', new Uint8Array(8))).rejects.toThrow('password salt must be 16 bytes');
    expect(native).not.toHaveBeenCalled();
  });

  it('passes the unchanged cost profile and snapshots salt views before asynchronous work', async () => {
    const backing = new Uint8Array(32); backing.set(salt, 8); const view = backing.subarray(8, 24);
    let nonce: Uint8Array | undefined;
    const native: typeof crypto.argon2 = (algorithm, params, callback) => {
      expect(algorithm).toBe('argon2id');
      expect(params).toMatchObject({ parallelism: 4, tagLength: 32, memory: 65536, passes: 3 });
      nonce = params.nonce as Uint8Array;
      queueMicrotask(() => callback(null, Buffer.alloc(32, 7)));
    };
    const pending = createKeyfilePasswordKdf(native)('fixture', view);
    backing.fill(255);
    expect(nonce).toEqual(salt);
    expect(await pending).toEqual(Buffer.alloc(32, 7));
  });

  it('propagates native errors instead of retrying another derivation', async () => {
    const failure = new Error('native derivation failed');
    const native = vi.fn<typeof crypto.argon2>((_algorithm, _params, callback) => callback(failure, Buffer.alloc(0)));
    await expect(createKeyfilePasswordKdf(native)('fixture', salt)).rejects.toBe(failure);
    expect(native).toHaveBeenCalledOnce();
  });

  it.runIf(nativeAvailable)('reads portable keyfiles and lets the portable implementation read native writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyfile-kdf-')); const filePath = join(dir, 'identity.json');
    const password = 'public keyfile interoperability fixture'; const serverKey = Uint8Array.from({ length: 32 }, (_, i) => i);
    try {
      const store = await createFileServerKeyStore({ filePath, passphrase: password });
      store.saveServerVaultKey(serverKey); await store.flush?.();
      const document = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(document.kdf_params).toEqual(DEFAULT_ARGON2_PARAMS);
      const portableKek = await deriveKEKFromPassword(password, base64ToBytes(document.kdf_salt_b64), document.kdf_params);
      const plaintext = await decrypt(portableKek, decodeCiphertext(document.payload));
      document.payload = encodeCiphertext(await encrypt(portableKek, plaintext));
      writeFileSync(filePath, JSON.stringify(document), { mode: 0o600 });
      const reopened = await createFileServerKeyStore({ filePath, passphrase: password });
      expect(reopened.loadServerVaultKey()).toEqual(serverKey);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
