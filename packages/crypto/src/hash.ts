/** SHA-256 hex digest — the one isomorphic string-hash primitive.
 *
 *  `@noble/hashes` is pure JS and produces identical bytes in Node and
 *  the browser, so this is the hash to reach for anywhere `node:crypto`
 *  is unavailable (the bundle-portable packages — `@recued/contracts`
 *  runs in the webclient). Server-only code may use `node:crypto`
 *  directly; this exists so the portable layer has a shared, drift-free
 *  digest rather than each call site re-deriving one. */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const utf8 = new TextEncoder();

/** Lowercase hex SHA-256 of a string (UTF-8) or raw bytes. */
export const sha256Hex = (input: string | Uint8Array): string =>
  bytesToHex(sha256(typeof input === 'string' ? utf8.encode(input) : input));
