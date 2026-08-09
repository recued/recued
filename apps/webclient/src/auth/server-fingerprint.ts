/** `sha256:<hex>` identity fingerprint of a paired server's ed25519 key.
 *
 *  ⛔ WHY THIS EXISTS. `POST /v1/account/binding/token` accepts an optional
 *  `server_fingerprint` that binds the minted token to ONE server; the auth
 *  Worker's DO rejects an exchange whose proving server differs. The webclient
 *  never sent it — `mintBindingToken()` was called with no arguments — so every
 *  token it minted was server-AGNOSTIC, and the Worker says what that means in
 *  its own source: a captured token is redeemable by ANY server presenting a
 *  valid self-proof, which binds the attacker's server to the victim's account
 *  AND consumes the victim's single-use nonce, so the victim's own server then
 *  fails with `nonce_reused`. Two independent audits (backend 2026-08-08 finding
 *  7, webclient 2026-08-08 finding 1) landed on the same close-out, and both
 *  noted it is webclient-side: only the client knows which server it is paired
 *  to. This is that half.
 *
 *  ⚠ THE ENCODING IS NOT NEGOTIABLE — three implementations must agree, and a
 *  mismatch fails CLOSED (the exchange rejects and binding stops working, which
 *  is safe but total):
 *
 *    · the server        — `ed25519PublicKeyFingerprint` (`backend/server/src/
 *      keys/index.ts`): `'sha256:' + sha256(spki_der).hex`
 *    · the auth Worker   — `fingerprintOfSpki` (`apps/auth-worker/src/
 *      binding-crypto.ts`): identical, over the SPKI DER it decodes from the
 *      server's self-proof
 *    · here              — over the SAME SPKI DER, decoded from the base64 the
 *      webclient pinned at pair time (`server_public_key`, the exact bytes
 *      `auth/ed25519-verifier.ts` imports as `'spki'`)
 *
 *  `server-fingerprint.test.ts` computes the server's value and this one over
 *  one generated key and asserts equality, so the agreement is proven rather
 *  than asserted in a comment.
 *
 *  ⚠ THROWS rather than returning undefined on a key it cannot decode. A caller
 *  that swallowed the failure would quietly mint the server-agnostic token this
 *  module exists to stop — the same defect, now with a helper in front of it.
 */

import { base64ToBytes } from '@recued/crypto';

const HEX = '0123456789abcdef';

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf]! + HEX[byte & 0xf]!;
  }
  return out;
};

/** Derive the `sha256:<hex>` fingerprint of a base64-encoded SPKI DER ed25519
 *  public key — the `server_public_key` the webclient pins at pair time. */
export const serverKeyFingerprint = async (
  server_public_key_spki_b64: string,
): Promise<string> => {
  const spki = base64ToBytes(server_public_key_spki_b64);
  if (spki.length === 0) {
    throw new Error('server_public_key did not decode to any bytes');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', spki as BufferSource),
  );
  return `sha256:${toHex(digest)}`;
};
