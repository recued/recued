import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, encodeCiphertext, decodeCiphertext, bytesToBase64, base64ToBytes } from '../aead.js';
import { randomBytes } from '../kdf.js';

const k32 = () => randomBytes(32);

describe('aead — basic encrypt/decrypt', () => {
  it('round-trips a payload', async () => {
    const key = k32();
    const pt = new TextEncoder().encode('hello world');
    const ct = await encrypt(key, pt);
    const back = await decrypt(key, ct);
    expect(new TextDecoder().decode(back)).toBe('hello world');
  });

  it('round-trips binary data', async () => {
    const key = k32();
    const pt = new Uint8Array([0, 1, 2, 3, 254, 255]);
    const ct = await encrypt(key, pt);
    const back = await decrypt(key, ct);
    expect(Array.from(back)).toEqual([0, 1, 2, 3, 254, 255]);
  });

  it('empty plaintext round-trips', async () => {
    const key = k32();
    const pt = new Uint8Array(0);
    const ct = await encrypt(key, pt);
    const back = await decrypt(key, ct);
    expect(back.length).toBe(0);
  });

  it('each encryption uses a fresh nonce → different ciphertext', async () => {
    const key = k32();
    const pt = new TextEncoder().encode('same-plaintext');
    const c1 = await encrypt(key, pt);
    const c2 = await encrypt(key, pt);
    expect(Array.from(c1.iv)).not.toEqual(Array.from(c2.iv));
    expect(Array.from(c1.ct)).not.toEqual(Array.from(c2.ct));
  });
});

describe('aead — authentication failure modes', () => {
  it('wrong key → decrypt throws', async () => {
    const k1 = k32();
    const k2 = k32();
    const ct = await encrypt(k1, new TextEncoder().encode('secret'));
    await expect(decrypt(k2, ct)).rejects.toThrow('decryption failed');
  });

  it('tampered ciphertext → decrypt throws', async () => {
    const key = k32();
    const ct = await encrypt(key, new TextEncoder().encode('secret'));
    // Flip one bit in the ciphertext body
    ct.ct[0] ^= 1;
    await expect(decrypt(key, ct)).rejects.toThrow('decryption failed');
  });

  it('tampered IV → decrypt throws', async () => {
    const key = k32();
    const ct = await encrypt(key, new TextEncoder().encode('secret'));
    ct.iv[0] ^= 1;
    await expect(decrypt(key, ct)).rejects.toThrow('decryption failed');
  });
});

describe('aead — AAD binding', () => {
  it('matching AAD → round-trips', async () => {
    const key = k32();
    const aad = new TextEncoder().encode('bound-to-row-42');
    const ct = await encrypt(key, new TextEncoder().encode('secret'), aad);
    const back = await decrypt(key, ct, aad);
    expect(new TextDecoder().decode(back)).toBe('secret');
  });

  it('mismatched AAD → decrypt throws', async () => {
    const key = k32();
    const aad = new TextEncoder().encode('row-42');
    const wrongAAD = new TextEncoder().encode('row-99');
    const ct = await encrypt(key, new TextEncoder().encode('secret'), aad);
    await expect(decrypt(key, ct, wrongAAD)).rejects.toThrow('decryption failed');
  });

  it('missing AAD where it was used at encrypt → decrypt throws', async () => {
    const key = k32();
    const aad = new TextEncoder().encode('binding');
    const ct = await encrypt(key, new TextEncoder().encode('secret'), aad);
    await expect(decrypt(key, ct)).rejects.toThrow('decryption failed');
  });
});

describe('aead — key length guards', () => {
  it('rejects keys != 32 bytes', async () => {
    const shortKey = new Uint8Array(16);
    await expect(encrypt(shortKey, new Uint8Array([1]))).rejects.toThrow('32 bytes');
  });
});

describe('aead — encoding round-trip', () => {
  it('encodeCiphertext/decodeCiphertext preserves bytes', async () => {
    const key = k32();
    const ct = await encrypt(key, new TextEncoder().encode('roundtrip'));
    const encoded = encodeCiphertext(ct);
    const decoded = decodeCiphertext(encoded);
    expect(Array.from(decoded.iv)).toEqual(Array.from(ct.iv));
    expect(Array.from(decoded.ct)).toEqual(Array.from(ct.ct));
  });

  it('base64 helpers round-trip', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64, 32]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
