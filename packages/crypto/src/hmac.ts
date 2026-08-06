/** HMAC-SHA256 hex digest — the one isomorphic MAC primitive.
 *
 *  Sibling of `hash.ts`, and it exists for the same reason: `@noble/hashes` is
 *  pure JS and produces identical bytes in Node and the browser, so this is the
 *  MAC to reach for anywhere `node:crypto` is unavailable. `packages/` is
 *  bundle-portable engine code — `packages/ingredients/src/watchers/http.ts`
 *  records the rule — and the outbound connection adapter that signs requests
 *  lives there.
 *
 *  🔑 **Synchronous on purpose.** The obvious alternative, `crypto.subtle.sign`,
 *  is async, and the one caller (`injectAuth` in the connection api adapter) is
 *  a synchronous function sitting on the hot path of every outbound call. Being
 *  able to sign without making that function — and therefore its callers —
 *  async is what keeps request signing a local change instead of a refactor.
 *
 *  ⛔ **Server-only code should NOT use this.** `node:crypto`'s `createHmac` is
 *  faster and constant-time-compared via `timingSafeEqual`; see
 *  `backend/server/src/webhook-timestamped-hmac-engine.ts`, which verifies
 *  INBOUND signatures and must compare in constant time. This module only ever
 *  PRODUCES a signature for an outbound request, where there is nothing to
 *  compare and no attacker-supplied digest to be timed against.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const utf8 = new TextEncoder();
const bytes = (v: string | Uint8Array): Uint8Array =>
  typeof v === 'string' ? utf8.encode(v) : v;

/** Lowercase hex HMAC-SHA256 of `message` under `key`, both UTF-8 or raw bytes.
 *
 *  Verified against Binance's published worked example — see
 *  `__tests__/hmac.test.ts`, which pins the vendor's own vector rather than a
 *  digest this repo computed for itself. A test that only checks our output
 *  against our output proves the function is deterministic, not correct. */
export const hmacSha256Hex = (
  key: string | Uint8Array,
  message: string | Uint8Array,
): string => bytesToHex(hmac(sha256, bytes(key), bytes(message)));
