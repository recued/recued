/** Phase F (D-108) — archive encryption helpers.
 *
 *  Keeps the archive module self-contained: HKDF for key derivation,
 *  AES-256-GCM for per-file AEAD, HMAC-SHA-256 for the trailing
 *  archive signature. Implementation uses Node's built-in `crypto`
 *  module directly (not Web Crypto) because the archive flows are
 *  server-only — we don't need the ext's Web Crypto path here, and
 *  the synchronous Node APIs are easier to compose with streams.
 *
 *  Domain separation:
 *    contentKey = HKDF(recoveryKey, salt, 'recued-archive-v1')
 *    hmacKey    = HKDF(recoveryKey, salt, 'recued-archive-v1-hmac')
 *
 *  Key length: 32 bytes (AES-256 + HMAC-SHA-256 both consume 32).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  AEAD_TAG_LEN,
  CONTENT_INFO,
  HMAC_INFO,
  IV_LEN,
} from './archive-format.js';

const KEY_LEN = 32;

export interface ArchiveKeys {
  content: Buffer;
  hmac: Buffer;
}

/** Derive content + HMAC keys from a recovery-key buffer. `salt` is
 *  the per-archive random salt stored in the manifest. Uses Node's
 *  `hkdfSync` (SHA-256) and returns 32-byte keys for each domain. */
export const deriveArchiveKeys = (
  recoveryKey: Buffer,
  salt: Buffer,
): ArchiveKeys => {
  if (recoveryKey.length !== KEY_LEN) {
    throw new Error(`archive: recovery key must be ${KEY_LEN} bytes (got ${recoveryKey.length})`);
  }
  if (salt.length === 0) {
    throw new Error('archive: salt must be non-empty');
  }
  const content = Buffer.from(
    hkdfSync('sha256', recoveryKey, salt, CONTENT_INFO, KEY_LEN),
  );
  const hmac = Buffer.from(
    hkdfSync('sha256', recoveryKey, salt, HMAC_INFO, KEY_LEN),
  );
  return { content, hmac };
};

/** Random 32-byte salt for the manifest. Tests can inject a fixed
 *  salt via the export options; production always generates fresh. */
export const newSalt = (): Buffer => Buffer.from(randomBytes(32));

/** Encrypt a single buffer using AES-256-GCM with a random 12-byte
 *  IV. Returns `iv || ciphertext || tag` concatenated for simpler
 *  framing on the wire. */
export const encryptRecord = (
  key: Buffer,
  plaintext: Buffer,
): Buffer => {
  const iv = Buffer.from(randomBytes(IV_LEN));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
};

/** Streaming counterpart to `encryptRecord`. Emits the same
 *  `iv || ciphertext || tag` AES-256-GCM framing, but incrementally so a
 *  large record (the db backup) never sits whole in memory:
 *
 *    body = iv ++ (every `update(chunk)` output) ++ `final()`
 *
 *  where `final()` is `cipher.final() || authTag` (GCM produces no trailing
 *  ciphertext, so this is the 16-byte tag). Concatenating those pieces
 *  yields the exact bytes `encryptRecord` would produce for the same
 *  plaintext under that iv, and `decryptRecord` consumes the result
 *  unchanged. The record body length is therefore known up front:
 *  `IV_LEN + plaintextLen + AEAD_TAG_LEN`. */
export interface RecordCipher {
  /** Random 12-byte IV — the record body's leading bytes, write it before
   *  the first ciphertext chunk. */
  iv: Buffer;
  /** Encrypt one plaintext chunk, returning its ciphertext (may be empty). */
  update(chunk: Buffer): Buffer;
  /** Flush the cipher and return the trailing GCM auth tag. Call once,
   *  after the final `update`. */
  final(): Buffer;
}

export const createRecordCipher = (key: Buffer): RecordCipher => {
  const iv = Buffer.from(randomBytes(IV_LEN));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return {
    iv,
    update: (chunk) => cipher.update(chunk),
    final: () => Buffer.concat([cipher.final(), cipher.getAuthTag()]),
  };
};

/** Decrypt a single buffer produced by `encryptRecord`. Throws on
 *  authentication failure (AES-GCM tag mismatch). */
export const decryptRecord = (
  key: Buffer,
  framed: Buffer,
): Buffer => {
  if (framed.length < IV_LEN + AEAD_TAG_LEN) {
    throw new Error('archive: record too short for IV + tag');
  }
  const iv = framed.subarray(0, IV_LEN);
  const tag = framed.subarray(framed.length - AEAD_TAG_LEN);
  const ct = framed.subarray(IV_LEN, framed.length - AEAD_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};

/** Streaming counterpart to `decryptRecord` — the inverse of
 *  `createRecordCipher`. Decrypts a record body framed as
 *  `iv || ciphertext || tag` WITHOUT holding the whole record in memory:
 *  the caller strips the leading 12-byte iv (passing it here), streams the
 *  ciphertext chunks through `update`, and passes the trailing 16-byte tag
 *  to `final` once the body is exhausted.
 *
 *  GCM is a stream cipher, so `update` emits plaintext BEFORE the tag is
 *  verified — a streaming consumer must therefore write that plaintext
 *  OPTIMISTICALLY (to staging) and only COMMIT once `final` returns without
 *  throwing. `final` calls `decipher.final()`, which authenticates the tag
 *  and throws on mismatch (wrong key or tampered ciphertext). The plaintext
 *  produced equals `decryptRecord`'s for the same `iv || ct || tag`. */
export interface RecordDecipher {
  /** Decrypt one ciphertext chunk, returning its plaintext (may be empty). */
  update(chunk: Buffer): Buffer;
  /** Set the GCM auth tag, flush, and authenticate. Returns any trailing
   *  plaintext block (empty for GCM). THROWS on tag mismatch. Call once,
   *  after the final `update`. */
  final(tag: Buffer): Buffer;
}

export const createRecordDecipher = (key: Buffer, iv: Buffer): RecordDecipher => {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  return {
    update: (chunk) => decipher.update(chunk),
    final: (tag) => {
      decipher.setAuthTag(tag);
      return decipher.final();
    },
  };
};

/** Streaming HMAC accumulator for the archive signature. The caller
 *  feeds every byte of the archive (including the plaintext manifest
 *  prefix + the magic + length headers + the ciphertext records) in
 *  order; `finalize()` returns the 32-byte HMAC trailer. */
export interface ArchiveHmac {
  update(chunk: Buffer): void;
  finalize(): Buffer;
}

export const createArchiveHmac = (hmacKey: Buffer): ArchiveHmac => {
  const h = createHmac('sha256', hmacKey);
  let finalized = false;
  return {
    update(chunk) {
      if (finalized) throw new Error('archive: hmac already finalized');
      h.update(chunk);
    },
    finalize() {
      if (finalized) throw new Error('archive: hmac already finalized');
      finalized = true;
      return h.digest();
    },
  };
};

/** SHA-256 of a buffer — used for quick integrity checks in tests. */
export const sha256 = (buf: Buffer): Buffer =>
  createHash('sha256').update(buf).digest();
