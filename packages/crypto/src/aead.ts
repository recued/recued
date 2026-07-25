/** Authenticated encryption with associated data — AES-256-GCM.
 *
 *  Wraps Web Crypto's AES-GCM. Each encryption generates a fresh 12-byte
 *  random nonce; the wire format is `nonce || ciphertext || tag` (Web
 *  Crypto returns ciphertext-with-appended-tag already).
 *
 *  Key reuse safety: AES-GCM is catastrophic under nonce reuse (leaks
 *  the authentication key). The 96-bit random nonce space means a birthday
 *  collision at ~2^48 encryptions per key, far below any realistic usage
 *  for cache/warehouse rows per user. If you ever need to encrypt more
 *  than 2^32 items under one sub-DEK, rotate.
 *
 *  AAD: optional associated-data field that's authenticated but not
 *  encrypted. Recued uses this to bind ciphertext to its row key so
 *  moving bytes between rows fails to decrypt.
 */

const IV_LEN = 12;
const KEY_LEN = 32;

/** On-wire encrypted container. */
export interface Ciphertext {
  iv: Uint8Array;          // 12 bytes
  ct: Uint8Array;          // ciphertext || 16-byte GCM tag (Web Crypto packs them)
}

const importKey = async (key: Uint8Array): Promise<CryptoKey> => {
  if (key.length !== KEY_LEN) {
    throw new Error(`aead: key must be ${KEY_LEN} bytes`);
  }
  return crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const encrypt = async (
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Ciphertext> => {
  const cryptoKey = await importKey(key);
  const iv = new Uint8Array(IV_LEN);
  crypto.getRandomValues(iv);

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: iv as BufferSource,
  };
  if (aad && aad.length > 0) params.additionalData = aad as BufferSource;

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(params, cryptoKey, plaintext as BufferSource),
  );
  return { iv, ct };
};

export const decrypt = async (
  key: Uint8Array,
  ciphertext: Ciphertext,
  aad?: Uint8Array,
): Promise<Uint8Array> => {
  const cryptoKey = await importKey(key);
  if (ciphertext.iv.length !== IV_LEN) {
    throw new Error(`aead: iv must be ${IV_LEN} bytes`);
  }

  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: ciphertext.iv as BufferSource,
  };
  if (aad && aad.length > 0) params.additionalData = aad as BufferSource;

  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(params, cryptoKey, ciphertext.ct as BufferSource),
    );
    return pt;
  } catch {
    // Mask underlying errors — Web Crypto's error messages leak almost
    // nothing useful anyway, and normalizing makes failure modes
    // predictable for callers.
    throw new Error('aead: decryption failed (wrong key, tampered ciphertext, or mismatched AAD)');
  }
};

/** Encode ciphertext as base64 string `iv.ct`. For bundle serialization. */
export const encodeCiphertext = (c: Ciphertext): string => {
  const buf = new Uint8Array(c.iv.length + c.ct.length);
  buf.set(c.iv, 0);
  buf.set(c.ct, c.iv.length);
  return bytesToBase64(buf);
};

export const decodeCiphertext = (s: string): Ciphertext => {
  const buf = base64ToBytes(s);
  if (buf.length < IV_LEN + 16) {
    throw new Error('aead: ciphertext too short');
  }
  return {
    iv: buf.slice(0, IV_LEN),
    ct: buf.slice(IV_LEN),
  };
};

// ────────────────────────────────────────────────────────────────
// base64 helpers — no dep on Node's Buffer so this works in browsers.
// ────────────────────────────────────────────────────────────────

export const bytesToBase64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};

export const base64ToBytes = (s: string): Uint8Array => {
  const raw = atob(s);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
};
