/** D-148 § A.4.1 / D-169 P0 Slice 2B — bridge bearer-token store.
 *
 *  ⛔ AAD v2 ONLY — NO v1 READER, DELIBERATELY. The webclient carries a
 *  read-only v1 fallback because records sealed before its migration exist in
 *  the wild. THIS SURFACE HAS NO SUCH POPULATION: the bridge is not shipped, so
 *  no record was ever sealed under v1 by it, and D-148 I-20 (*"pre-launch
 *  zero-installs: no migration code, no compat shims"*) says a shim guarding
 *  nobody does not get written. A bridge paired before this change re-pairs —
 *  a single pair module, one paste.
 *
 *  ⚠ The two stores are therefore NOT identical, and that is intended rather
 *  than drift: their WRAP paths and AAD bytes are, and
 *  `d-169-phase-0-slice-2b-token-store.test.ts` compares them by driving both.
 *  Only the webclient's legacy READER differs.
 *  The bridge persists the same AES-GCM-wrapped `WebclientTokenRecord`
 *  the webclient does (per D-169 § N.8 / TR-1: one auth path, one
 *  substrate). The bearer is wrapped at storage time with
 *  `crypto.subtle` AES-GCM + a non-extractable key whose handle lives
 *  in IndexedDB; `crypto.subtle.exportKey` against the key raises
 *  `InvalidAccessError`, so even a hostile extension that gains
 *  chrome.storage read access cannot extract the plaintext bearer
 *  without calling back into the SW's WebCrypto.
 *
 *  The plaintext bearer never persists in chrome.storage or IndexedDB.
 *  The runtime unwraps once per (re)connect, builds the structured
 *  `<token_id>.<plaintext>` bearer the server expects, and discards
 *  the plaintext as soon as the WS frame has flushed.
 *
 *  AAD binding (Codex P2 #5 fold posture lifted from the webclient).
 *  The wrap call's `additionalData` binds the ciphertext to the active
 *  pair-context (`token_id` + `server_url` + `server_public_key`). An
 *  attacker who swaps the chrome.storage row to a different
 *  `token_id`'s ciphertext fails AEAD verify at unwrap → no bearer
 *  leak. The same AAD must be threaded into unwrap; mismatched AAD
 *  raises a typed `webclient_token_corrupt` error. The bootstrap is
 *  responsible for re-issuing wrap-with-fresh-AAD whenever the pair
 *  context rotates (server URL change, identity rotation re-pair).
 *
 *  Slice 2B ships both the in-memory key resolver (the test fixture)
 *  AND the production WebCrypto resolver — see
 *  `apps/bridge/src/boot/service-worker-entry.ts:buildBridgeTokenStore`
 *  for the SW-side wiring against `crypto.subtle.generateKey` +
 *  IndexedDB-persisted non-extractable handle. Tests inject their own
 *  resolver shape against this same interface.
 */

import type { WebclientTokenRecord } from '@recued/contracts';

/** AES-GCM parameters per § A.4.1. 256-bit key, 96-bit IV. The IV
 *  is regenerated on every wrap call (CSPRNG); reusing an IV with the
 *  same key is forbidden per the AES-GCM standard. */
export const WEBCLIENT_TOKEN_AES_PARAMS = {
  name: 'AES-GCM' as const,
  iv_length_bytes: 12,
  key_bits: 256,
} as const;

/** AAD binding context. The caller threads this in at wrap time + the
 *  same context at unwrap; AEAD-verify rejects any mismatch. Renaming
 *  a field, changing storage origin, or swapping in a different
 *  server's ciphertext all surface as `webclient_token_corrupt`. */
export interface WebclientTokenAad {
  token_id: string;
  server_public_key: string;
}

/** Typed error class for unwrap failures. The caller maps to the
 *  user-visible "re-pair required" prompt + an audit row. Same code
 *  string the webclient emits so server-side telemetry stays one
 *  taxonomy across both paired clients. */
export class WebclientTokenCorruptError extends Error {
  readonly code = 'webclient_token_corrupt' as const;
  constructor(public readonly reason: string) {
    super(`bridge.token-store: ${reason}`);
  }
}

export interface WebclientTokenWrapDeps {
  /** Build a fresh CSPRNG IV. Default fills `Uint8Array(12)` with
   *  `crypto.getRandomValues`; tests inject a deterministic IV for
   *  reproducible wrap output. */
  randomBytes(byte_count: number): Uint8Array;
  /** AES-GCM encrypt against the runtime's non-extractable key. The
   *  resolver function returns an opaque handle the runtime knows how
   *  to use (`CryptoKey` in production; identity in tests). */
  resolveKey(): Promise<unknown>;
  encrypt(args: {
    key: unknown;
    iv: Uint8Array;
    plaintext: Uint8Array;
    additional_data: Uint8Array;
  }): Promise<Uint8Array>;
  decrypt(args: {
    key: unknown;
    iv: Uint8Array;
    ciphertext: Uint8Array;
    additional_data: Uint8Array;
  }): Promise<Uint8Array>;
  /** `now()` for `issued_at` capture. Tests inject a fixed clock. */
  now(): number;
}

export interface WebclientTokenStore {
  /** Wrap a freshly-issued bearer + return the persistable record.
   *  Caller passes the plaintext bearer ONCE — the runtime never
   *  surfaces the plaintext through this interface again. The AAD
   *  binds the ciphertext to the current pair context. */
  wrap(args: {
    token_id: string;
    bearer: string;
    aad: WebclientTokenAad;
  }): Promise<WebclientTokenRecord>;
  /** Unwrap a stored record + return the plaintext bearer. The
   *  runtime should hold the unwrapped bearer in a local variable
   *  for as long as it takes to fire the WS auth handshake, then
   *  drop. */
  unwrap(record: WebclientTokenRecord, aad: WebclientTokenAad): Promise<string>;
}

const fromB64 = (b64: string): Uint8Array => {
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback (tests).
  return Uint8Array.from(Buffer.from(b64, 'base64'));
};

const toB64 = (bytes: Uint8Array): string => {
  if (typeof globalThis.btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return globalThis.btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
};

/** Refuse weak randomness silently. Production paths always have
 *  WebCrypto inside the SW (`globalThis.crypto.getRandomValues` is
 *  always present in MV3 service workers); the explicit throw is so a
 *  misuse in a hostile fake environment is loud rather than degraded. */
const defaultRandomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  throw new Error(
    'bridge.token-store: WebCrypto.getRandomValues is unavailable; refusing to fall back to Math.random for AES-GCM IV',
  );
};

/** Canonicalize the AAD into stable bytes.
 *
 *  ⛔ v2 OMITS `server_url`, AND THAT OMISSION IS THE WHOLE POINT. A v1 AAD
 *  bound the ciphertext to the address, so moving a paired server made every
 *  later unwrap fail AEAD verify — the bearer unrecoverable, the user told to
 *  re-pair. Dropping the field is what lets D-148 § A.15's per-client "Update
 *  server URL" affordance exist for this surface at all.
 *
 *  ⚠ Byte-identical to the webclient's `buildAadBytesV2` by TEST, not by
 *  comment: the two forked for a day when the webclient migrated alone, and the
 *  parity case in `d-169-phase-0-slice-2b-token-store.test.ts` now DRIVES both
 *  stores and compares their bytes. The test that was supposed to catch that
 *  fork pinned a literal instead, and stayed green through it. */
const buildAadBytesV2 = (aad: WebclientTokenAad): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    domain: 'recued.webclient.token.aad.v2',
    token_id: aad.token_id,
    server_public_key: aad.server_public_key,
  }));

const assertAadShape = (aad: WebclientTokenAad): void => {
  if (
    !aad ||
    typeof aad.token_id !== 'string' ||
    typeof aad.server_public_key !== 'string' ||
    aad.token_id.length === 0 ||
    aad.server_public_key.length === 0
  ) {
    throw new Error(
      'bridge.token-store: AAD context required (token_id + server_public_key)',
    );
  }
};

export const createWebclientTokenStore = (
  deps: Partial<WebclientTokenWrapDeps> & {
    resolveKey: WebclientTokenWrapDeps['resolveKey'];
    encrypt: WebclientTokenWrapDeps['encrypt'];
    decrypt: WebclientTokenWrapDeps['decrypt'];
  },
): WebclientTokenStore => {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  const now = deps.now ?? Date.now;
  return {
    async wrap({ token_id, bearer, aad }) {
      if (!token_id || !bearer) {
        throw new Error('bridge.token-store: token_id and bearer are required');
      }
      assertAadShape(aad);
      // Wrap-time AAD must include the token_id it's being stored
      // under. Mismatch with the row's saved `token_id` would silently
      // bind a different context (matches webclient's posture).
      if (aad.token_id !== token_id) {
        throw new Error('bridge.token-store: aad.token_id must equal the wrap token_id');
      }
      const iv = randomBytes(WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes);
      if (iv.length !== WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes) {
        throw new Error(
          `bridge.token-store: random IV length must be ${WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes} bytes`,
        );
      }
      const key = await deps.resolveKey();
      const plaintext = new TextEncoder().encode(bearer);
      const ciphertext = await deps.encrypt({
        key,
        iv,
        plaintext,
        // ⛔ ALWAYS v2. There is no path that writes a v1 seal.
        additional_data: buildAadBytesV2(aad),
      });
      return {
        token_id,
        ciphertext_b64: toB64(ciphertext),
        iv_b64: toB64(iv),
        issued_at: now(),
      };
    },
    async unwrap(record, aad) {
      if (
        !record ||
        typeof record.ciphertext_b64 !== 'string' ||
        typeof record.iv_b64 !== 'string'
      ) {
        throw new WebclientTokenCorruptError('malformed token record');
      }
      if (record.ciphertext_b64.length === 0 || record.iv_b64.length === 0) {
        throw new WebclientTokenCorruptError('empty ciphertext or iv');
      }
      assertAadShape(aad);
      if (aad.token_id !== record.token_id) {
        throw new WebclientTokenCorruptError('aad.token_id does not match record.token_id');
      }
      const iv = fromB64(record.iv_b64);
      if (iv.length !== WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes) {
        throw new WebclientTokenCorruptError('iv length unexpected');
      }
      const ciphertext = fromB64(record.ciphertext_b64);
      const key = await deps.resolveKey();
      try {
        const plaintext = await deps.decrypt({
          key,
          iv,
          ciphertext,
          additional_data: buildAadBytesV2(aad),
        });
        return new TextDecoder().decode(plaintext);
      } catch (err) {
        // Normalize AEAD verify / decrypt failure into a stable error
        // class the caller routes to "re-pair required" UX + audit row.
        if (err instanceof WebclientTokenCorruptError) throw err;
        throw new WebclientTokenCorruptError(
          err instanceof Error ? err.message : 'decrypt failed',
        );
      }
    },
  };
};
