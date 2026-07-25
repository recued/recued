import { describe, it, expect } from 'vitest';
import {
  generateKey, exportKey, importKey,
  encrypt, decrypt,
  wrapKey, unwrapKey,
} from '../crypto.js';

describe('generateKey', () => {
  it('produces a CryptoKey', async () => {
    const key = await generateKey();
    expect(key).toBeDefined();
    expect((key as CryptoKey).type).toBe('secret');
  });

  it('two calls produce different keys', async () => {
    const k1 = await generateKey();
    const k2 = await generateKey();
    const e1 = await exportKey(k1);
    const e2 = await exportKey(k2);
    expect(e1).not.toBe(e2);
  });
});

describe('exportKey/importKey', () => {
  it('round-trips a key', async () => {
    const original = await generateKey();
    const exported = await exportKey(original);
    const imported = await importKey(exported);

    // Verify imported key can decrypt what original encrypted
    const ciphertext = await encrypt(original, 'hello');
    const plaintext = await decrypt(imported, ciphertext);
    expect(plaintext).toBe('hello');
  });

  it('exported key is base64 string', async () => {
    const key = await generateKey();
    const exported = await exportKey(key);
    expect(typeof exported).toBe('string');
    expect(exported).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('encrypt/decrypt', () => {
  it('round-trips a string', async () => {
    const key = await generateKey();
    const ciphertext = await encrypt(key, 'secret data');
    const plaintext = await decrypt(key, ciphertext);
    expect(plaintext).toBe('secret data');
  });

  it('round-trips empty string', async () => {
    const key = await generateKey();
    const ciphertext = await encrypt(key, '');
    expect(await decrypt(key, ciphertext)).toBe('');
  });

  it('round-trips unicode', async () => {
    const key = await generateKey();
    const ciphertext = await encrypt(key, '日本語 🔐 émoji');
    expect(await decrypt(key, ciphertext)).toBe('日本語 🔐 émoji');
  });

  it('round-trips JSON-serialized data', async () => {
    const key = await generateKey();
    const original = JSON.stringify({ token: 'pat-na2-secret', scopes: ['read', 'write'] });
    const ciphertext = await encrypt(key, original);
    expect(await decrypt(key, ciphertext)).toBe(original);
  });

  it('produces different ciphertexts for same plaintext (random IV)', async () => {
    const key = await generateKey();
    const c1 = await encrypt(key, 'same');
    const c2 = await encrypt(key, 'same');
    expect(c1.ciphertext).not.toBe(c2.ciphertext);
    expect(c1.iv).not.toBe(c2.iv);
  });

  it('decryption fails with wrong key', async () => {
    const k1 = await generateKey();
    const k2 = await generateKey();
    const ciphertext = await encrypt(k1, 'secret');
    await expect(decrypt(k2, ciphertext)).rejects.toThrow();
  });

  it('decryption fails on tampered ciphertext', async () => {
    const key = await generateKey();
    const entry = await encrypt(key, 'secret');
    // Flip a character in the base64 ciphertext
    const tampered = {
      ...entry,
      ciphertext: entry.ciphertext.slice(0, -2) + 'AA',
    };
    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it('records timestamps on entry', async () => {
    const key = await generateKey();
    const before = Date.now();
    const entry = await encrypt(key, 'x');
    const after = Date.now();
    expect(entry.created_at).toBeGreaterThanOrEqual(before);
    expect(entry.created_at).toBeLessThanOrEqual(after);
    expect(entry.updated_at).toBe(entry.created_at);
  });
});

describe('wrapKey/unwrapKey (envelope encryption)', () => {
  it('wraps and unwraps a DEK with a KEK', async () => {
    const dek = await generateKey();
    const kek = await generateKey();

    const wrapped = await wrapKey(kek, dek);
    const unwrapped = await unwrapKey(kek, wrapped);

    // Verify the unwrapped DEK is functionally identical
    const ciphertext = await encrypt(dek, 'data');
    const plaintext = await decrypt(unwrapped, ciphertext);
    expect(plaintext).toBe('data');
  });

  it('unwrap fails with wrong KEK', async () => {
    const dek = await generateKey();
    const kek1 = await generateKey();
    const kek2 = await generateKey();

    const wrapped = await wrapKey(kek1, dek);
    await expect(unwrapKey(kek2, wrapped)).rejects.toThrow();
  });

  it('multiple KEKs can wrap the same DEK independently', async () => {
    const dek = await generateKey();
    const installKek = await generateKey();
    const userKek = await generateKey();

    // Wrap the same DEK two ways (envelope encryption pattern)
    const wrappedByInstall = await wrapKey(installKek, dek);
    const wrappedByUser = await wrapKey(userKek, dek);

    // Either KEK can recover the same DEK
    const dekFromInstall = await unwrapKey(installKek, wrappedByInstall);
    const dekFromUser = await unwrapKey(userKek, wrappedByUser);

    // Both unwrapped DEKs should decrypt the same data identically
    const ciphertext = await encrypt(dek, 'shared secret');
    expect(await decrypt(dekFromInstall, ciphertext)).toBe('shared secret');
    expect(await decrypt(dekFromUser, ciphertext)).toBe('shared secret');
  });
});

// ────────────────────────────────────────────────────────────────
// Passphrase-derived KEK (D-035)
// ────────────────────────────────────────────────────────────────

import { deriveKeyFromPassphrase, generateSalt } from '../crypto.js';

describe('deriveKeyFromPassphrase', () => {
  it('same passphrase + salt produces same key', async () => {
    const salt = generateSalt();
    const k1 = await deriveKeyFromPassphrase('my-sync-pass', salt);
    const k2 = await deriveKeyFromPassphrase('my-sync-pass', salt);
    // Both should encrypt/decrypt the same content
    const ct = await encrypt(k1, 'test');
    const pt = await decrypt(k2, ct);
    expect(pt).toBe('test');
  });

  it('different passphrase produces different key', async () => {
    const salt = generateSalt();
    const k1 = await deriveKeyFromPassphrase('pass-a', salt);
    const k2 = await deriveKeyFromPassphrase('pass-b', salt);
    const ct = await encrypt(k1, 'secret');
    await expect(decrypt(k2, ct)).rejects.toThrow();
  });

  it('different salt produces different key', async () => {
    const s1 = generateSalt();
    const s2 = generateSalt();
    const k1 = await deriveKeyFromPassphrase('same-pass', s1);
    const k2 = await deriveKeyFromPassphrase('same-pass', s2);
    const ct = await encrypt(k1, 'secret');
    await expect(decrypt(k2, ct)).rejects.toThrow();
  });

  it('wrap/unwrap DEK round-trip with passphrase KEK', async () => {
    const dek = await generateKey();
    const salt = generateSalt();
    const kek = await deriveKeyFromPassphrase('my-passphrase', salt);
    const wrapped = await wrapKey(kek, dek);
    const unwrapped = await unwrapKey(kek, wrapped);
    // Verify the unwrapped DEK can decrypt what the original encrypted
    const ct = await encrypt(dek, 'vault-secret');
    const pt = await decrypt(unwrapped, ct);
    expect(pt).toBe('vault-secret');
  });
});

// ────────────────────────────────────────────────────────────────
// createEncryptedCollection — transparent encrypt/decrypt wrapper
// ────────────────────────────────────────────────────────────────

import { createEncryptedCollection } from '../encrypted-collection.js';
import { createInMemoryCollection } from '../in-memory.js';
import type { EncryptedEntry } from '../types.js';

describe('createEncryptedCollection', () => {
  it('round-trips a value through encrypt/decrypt', async () => {
    const dek = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col = createEncryptedCollection<{ name: string; key: string }>(backing, dek);

    await col.set('slot1', { name: 'OpenAI', key: 'sk-abc123' });
    const retrieved = await col.get('slot1');
    expect(retrieved).toEqual({ name: 'OpenAI', key: 'sk-abc123' });
  });

  it('stores encrypted data in the backing collection', async () => {
    const dek = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col = createEncryptedCollection<{ secret: string }>(backing, dek);

    await col.set('key1', { secret: 'plaintext' });
    const raw = await backing.get('key1');
    expect(raw).not.toBeNull();
    expect(raw!.ciphertext).toBeDefined();
    expect(raw!.iv).toBeDefined();
    // The raw backing entry should NOT contain the plaintext
    expect(JSON.stringify(raw)).not.toContain('plaintext');
  });

  it('returns null for missing keys', async () => {
    const dek = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col = createEncryptedCollection<string>(backing, dek);
    expect(await col.get('nope')).toBeNull();
  });

  it('has/delete/clear work correctly', async () => {
    const dek = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col = createEncryptedCollection<number>(backing, dek);

    await col.set('a', 42);
    expect(await col.has('a')).toBe(true);
    await col.delete('a');
    expect(await col.has('a')).toBe(false);

    await col.set('b', 1);
    await col.set('c', 2);
    await col.clear();
    expect(await col.size()).toBe(0);
  });

  it('list returns all decrypted values', async () => {
    const dek = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col = createEncryptedCollection<string>(backing, dek);

    await col.set('a', 'hello');
    await col.set('b', 'world');
    const all = await col.list();
    expect(all.sort()).toEqual(['hello', 'world']);
  });

  it('different DEK cannot decrypt', async () => {
    const dek1 = await generateKey();
    const dek2 = await generateKey();
    const backing = createInMemoryCollection<EncryptedEntry>();
    const col1 = createEncryptedCollection<string>(backing, dek1);
    const col2 = createEncryptedCollection<string>(backing, dek2);

    await col1.set('secret', 'my-api-key');
    await expect(col2.get('secret')).rejects.toThrow();
  });
});
