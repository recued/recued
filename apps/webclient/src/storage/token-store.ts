/** D-148 § A.4.1 — webclient bearer-token store.
 *
 *  The bearer is wrapped at storage time with `crypto.subtle` AES-GCM
 *  + a non-extractable key. The non-extractable key lives in the
 *  webclient's IndexedDB key-store; `crypto.subtle.exportKey` against
 *  it raises `InvalidAccessError` per the WebCrypto spec. This means
 *  even an attacker that gains read-access to IDB cannot extract the
 *  bearer outside the runtime — they must call into `crypto.subtle`
 *  to unwrap, and they must do so inside the same origin.
 *
 *  The plaintext bearer never persists in any IDB row. The runtime
 *  unwraps once at WS connect, builds the `Authorization: Bearer`
 *  header, and discards the plaintext as soon as the request has
 *  flushed.
 *
 *  Codex P2 #5 fold — AAD binding. The wrap call's `additionalData`
 *  binds the ciphertext to the active pair-context (`token_id`,
 *  `server_url`, `server_public_key`). An attacker who swaps the
 *  IDB row to a different `token_id`'s ciphertext fails AEAD verify
 *  at unwrap → no bearer leak. The same AAD must be threaded into
 *  unwrap; mismatched AAD raises a typed `webclient_token_corrupt`
 *  error per Codex P3 #2 fold. The caller (the bootstrap) is
 *  responsible for re-issuing wrap-with-fresh-AAD whenever the pair
 *  context rotates (server URL change, identity rotation re-pair).
 *
 *  P4 ships an in-memory key-resolver (the test fixture) + the
 *  contract for the `crypto.subtle` resolver. Wiring the production
 *  resolver against `crypto.subtle.generateKey({ name: 'AES-GCM',
 *  length: 256 }, false, ['encrypt', 'decrypt'])` is a thin
 *  responsibility of the webclient bootstrap.
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

/** Codex P2 #5 fold — AAD binding context. The caller threads this
 *  in at wrap time + the same context at unwrap; AEAD-verify rejects
 *  any mismatch. Renaming a field, changing storage origin, or
 *  swapping in a different server's ciphertext all surface as
 *  `webclient_token_corrupt`. */
export interface WebclientTokenAad {
  token_id: string;
  /** ⛔ v1 ONLY, AND ONLY FOR READING. Dropped from the AAD in v2 — see
   *  `buildAadBytesV2`. Callers still pass it so a v1 record can be opened and
   *  re-sealed; nothing WRITES it into an AAD any more. Absent ⇒ v1 fallback is
   *  not attempted, which is correct for a record this client sealed itself. */
  server_url?: string;
  server_public_key: string;
}

/** Codex P3 #2 fold — typed error class for unwrap failures. The
 *  caller maps to the user-visible "re-pair required" prompt + an
 *  audit row. */
export class WebclientTokenCorruptError extends Error {
  readonly code = 'webclient_token_corrupt' as const;
  constructor(public readonly reason: string) {
    super(`webclient.token-store: ${reason}`);
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
   *  for as long as it takes to fire the WS auth request, then drop. */
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

/** Codex P3 #1 fold — refuse weak randomness silently. Production
 *  paths always have WebCrypto; the explicit throw is so a misuse
 *  in a hostile environment is loud rather than degraded. */
const defaultRandomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  throw new Error(
    'webclient.token-store: WebCrypto.getRandomValues is unavailable; refusing to fall back to Math.random for AES-GCM IV',
  );
};

/** Codex P2 #5 fold — canonicalize the AAD into stable bytes. Order
 *  + delimiter are fixed so the wrap path + unwrap path always
 *  produce the same input under the same context. */
/** ⛔ THE CURRENT SEAL: identity, not address.
 *
 *  🔑 `server_url` WAS DOING IDENTITY WORK IT IS BAD AT. The AAD's job is
 *  profile isolation — "a token lifted from one profile into another fails AEAD
 *  verify". `server_public_key` delivers that AND survives an address change,
 *  which the URL does not. Binding the credential to WHERE a server was made a
 *  legitimate move (a self-hoster changing `public_port` off 443) invalidate
 *  every bearer, so "edit the URL" and "re-pair" were the same operation —
 *  enforced by AEAD rather than by policy.
 *
 *  ⚠ ISOLATION IS UNCHANGED, NOT RELAXED. Two profiles on the same server share
 *  a key but never a `token_id`, and the wrap path already refuses an AAD whose
 *  `token_id` differs from the record's. */
const buildAadBytesV2 = (aad: WebclientTokenAad): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    domain: 'recued.webclient.token.aad.v2',
    token_id: aad.token_id,
    server_public_key: aad.server_public_key,
  }));

/** ⛔ READ-ONLY. Retained solely so records sealed before 2026-09-17 can be
 *  opened once and re-sealed under v2. Nothing wraps with this.
 *
 *  ⛔⛔ DO NOT DELETE THIS ON THE OLD CRITERION, WHICH WAS FALSE. It read:
 *  *"Remove once a release has shipped in which every reachable client has
 *  reconnected at least once — every unwrap re-seals, so the population drains
 *  on its own."* ⛔ **AN UNWRAP DOES NOT RE-SEAL.** `onLegacyAadRecord` is the
 *  hook that makes it, and acting on that sentence means deleting the only
 *  reader of every un-migrated record: bearers unrecoverable, every affected
 *  install re-pairing.
 *
 *  ⚠ THE REAL RETIREMENT ORDER: wire `onLegacyAadRecord` to a persist-the-
 *  re-sealed-record path → ship it → let a release pass in which clients
 *  reconnect → THEN delete this. Each step is observable; "everyone has
 *  reconnected" on its own is not evidence of anything.
 *
 *  🔑 WHERE THAT ORDER STANDS: step 1 is DONE — `webclient-main.ts` wires the
 *  hook to a re-seal of the exact record it opened, and
 *  `__tests__/d-148-legacy-aad-drain.test.ts` reads that composition so the
 *  wiring cannot quietly go missing again. Steps 2-4 are NOT.
 *
 *  ⛔⛔ AND CHECK THE DEPLOYED BUILD, NOT THIS TREE. Wiring the hook drains
 *  nobody until a release carrying it reaches clients, and those are different
 *  facts a comment cannot keep current — `wrangler deployments list` for the
 *  webclient is the one that can. ⚠ Do NOT try to answer it by grepping the
 *  shipped bundle for `onLegacyAadRecord`: identifiers are mangled there, so an
 *  absence reads the same as a rename. (`retargetProfile` is shipped and also
 *  greps to zero — that is the control that proves the method blind.) */
const buildAadBytesV1 = (aad: WebclientTokenAad): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    domain: 'recued.webclient.token.aad.v1',
    token_id: aad.token_id,
    server_url: aad.server_url,
    server_public_key: aad.server_public_key,
  }));

const assertAadShape = (aad: WebclientTokenAad): void => {
  if (
    !aad ||
    typeof aad.token_id !== 'string' ||
    (aad.server_url !== undefined && typeof aad.server_url !== 'string') ||
    typeof aad.server_public_key !== 'string' ||
    aad.token_id.length === 0 ||

    aad.server_public_key.length === 0
  ) {
    throw new Error('webclient.token-store: AAD context required (token_id + server_public_key)');
  }
};

export const createWebclientTokenStore = (
  deps: Partial<WebclientTokenWrapDeps> & {
    resolveKey: WebclientTokenWrapDeps['resolveKey'];
    encrypt: WebclientTokenWrapDeps['encrypt'];
    decrypt: WebclientTokenWrapDeps['decrypt'];
    /** Fired when a record opened under the RETIRED v1 AAD.
     *
     *  ⛔ THIS IS WHAT MAKES THE MIGRATION CONVERGE. Without it a v1 record is
     *  read successfully for ever, the population never drains, and v1 support
     *  can never be retired — a second format, permanently.
     *
     *  🔑 A CONSTRUCTION DEP, NOT AN INTERFACE METHOD. Adding a method to
     *  `WebclientTokenStore` would have obliged NINE test doubles to implement
     *  something none of them exercise — blast radius bought nothing. The store
     *  is constructed once in production; whoever constructs it is exactly who
     *  can persist a re-seal.
     *
     *  ⚠ Best-effort by contract. It runs inside the unwrap path, so a throw
     *  here must never turn a successful read into a failure; the caller wraps
     *  its own work. */
    onLegacyAadRecord?: (
      record: WebclientTokenRecord,
      aad: WebclientTokenAad,
    ) => void;
  },
): WebclientTokenStore => {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  const now = deps.now ?? Date.now;
  return {
    async wrap({ token_id, bearer, aad }) {
      if (!token_id || !bearer) {
        throw new Error('webclient.token-store: token_id and bearer are required');
      }
      assertAadShape(aad);
      // Codex P2 #5 fold — wrap-time AAD must include the token_id
      // it's being stored under. Mismatch with the row's saved
      // `token_id` would silently bind a different context.
      if (aad.token_id !== token_id) {
        throw new Error('webclient.token-store: aad.token_id must equal the wrap token_id');
      }
      const iv = randomBytes(WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes);
      if (iv.length !== WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes) {
        throw new Error(
          `webclient.token-store: random IV length must be ${WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes} bytes`,
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
      if (!record || typeof record.ciphertext_b64 !== 'string' || typeof record.iv_b64 !== 'string') {
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
      } catch (v2Err) {
        // ⛔⛔ THE FALLBACK IS THE MIGRATION, AND ITS FAILURE MODE IS THAT
        // EVERYONE RE-PAIRS. A record sealed before 2026-09-17 carries the v1
        // AAD; opening it here is the ONLY thing standing between an existing
        // install and a forced re-pair of every device.
        //
        // ⚠ ATTEMPTED ONLY WHEN THE CALLER SUPPLIED A URL. A v2-sealed record
        // that fails to open is corrupt, and retrying it under a v1 AAD built
        // from an absent `server_url` would turn a clean failure into a second
        // confusing one.
        //
        // ⚠ AND IT CHANGES NOTHING ON DISK HERE. Re-sealing is the owner of
        // persistence's job, signalled through `onLegacyAadRecord` — a store
        // that silently rewrote rows during a read would make an unwrap a
        // write, in the one code path that runs before the app knows whether it
        // is even online.
        if (aad.server_url !== undefined && aad.server_url.length > 0) {
          try {
            const plaintext = await deps.decrypt({
              key,
              iv,
              ciphertext,
              additional_data: buildAadBytesV1(aad),
            });
            // ⛔ TELL SOMEONE. Without this the record stays v1 for ever: the
            // migration never converges and v1 support can never be retired.
            // ⚠ Best-effort and never awaited into the read path — a failing
            // re-seal must not turn a successful unwrap into a failed one.
            try { deps.onLegacyAadRecord?.(record, aad); } catch { /* noted, not fatal */ }
            return new TextDecoder().decode(plaintext);
          } catch { /* fall through to the v2 error — v1 was the long shot */ }
        }
        const err = v2Err;
        // Codex P3 #2 fold — normalize AEAD verify / decrypt failure
        // into a stable error class the caller routes to "re-pair
        // required" UX + audit row.
        if (err instanceof WebclientTokenCorruptError) throw err;
        throw new WebclientTokenCorruptError(
          err instanceof Error ? err.message : 'decrypt failed',
        );
      }
    },
  };
};
