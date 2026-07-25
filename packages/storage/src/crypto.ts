import type { EncryptedEntry } from './types.js';

/** AES-256-GCM envelope encryption helpers using Web Crypto API.
 *  Works in browser and Node 19+.
 *
 *  The DEK (Data Encryption Key) encrypts vault entries.
 *  The DEK itself is wrapped by a KEK (Key Encryption Key) — install KEK or user KEK.
 *  See D-035 for the full envelope encryption design.
 */

const IV_BYTES = 12;  // 96-bit nonce, recommended for AES-GCM
const KEY_BYTES = 32; // 256-bit key

/** Generate a fresh random 256-bit key (DEK or KEK). */
export const generateKey = async (): Promise<CryptoKey> => {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,  // extractable for wrapping
    ['encrypt', 'decrypt'],
  );
};

/** Export a CryptoKey to base64 raw bytes for storage or wrapping. */
export const exportKey = async (key: CryptoKey): Promise<string> => {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
};

/** Import a base64-encoded key back into a CryptoKey. */
export const importKey = async (base64: string): Promise<CryptoKey> => {
  const bytes = base64ToBytes(base64);
  return crypto.subtle.importKey(
    'raw',
    bytes as unknown as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
};

/** Encrypt a string with the given key. Returns ciphertext + IV as an EncryptedEntry. */
export const encrypt = async (key: CryptoKey, plaintext: string): Promise<EncryptedEntry> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const now = Date.now();
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    created_at: now,
    updated_at: now,
  };
};

/** Decrypt an EncryptedEntry back to plaintext. Throws on tampering or wrong key. */
export const decrypt = async (key: CryptoKey, entry: EncryptedEntry): Promise<string> => {
  const ciphertext = base64ToBytes(entry.ciphertext);
  const iv = base64ToBytes(entry.iv);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
    key,
    ciphertext as unknown as ArrayBuffer,
  );
  return new TextDecoder().decode(decrypted);
};

/** Wrap a DEK with a KEK. Returns the wrapped key as base64. */
export const wrapKey = async (kek: CryptoKey, dek: CryptoKey): Promise<EncryptedEntry> => {
  const dekBase64 = await exportKey(dek);
  return encrypt(kek, dekBase64);
};

/** Unwrap a DEK from a wrapped form using a KEK. */
export const unwrapKey = async (kek: CryptoKey, wrapped: EncryptedEntry): Promise<CryptoKey> => {
  const dekBase64 = await decrypt(kek, wrapped);
  return importKey(dekBase64);
};

// ── Passphrase-based key derivation (D-035) ────────────────────────────

const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 recommendation for SHA-256
const SALT_BYTES = 16;

/** Generate a random salt for passphrase derivation. */
export const generateSalt = (): string =>
  bytesToBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

/** Derive a KEK from a passphrase + salt via PBKDF2-SHA256. */
export const deriveKeyFromPassphrase = async (
  passphrase: string,
  saltBase64: string,
): Promise<CryptoKey> => {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const salt = base64ToBytes(saltBase64);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable — used only for wrap/unwrap
    ['encrypt', 'decrypt'],
  );
};

// ── base64 helpers (work in browser + Node 18+) ────────────────────────

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
