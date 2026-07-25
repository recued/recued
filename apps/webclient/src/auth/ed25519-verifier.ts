/** Ed25519 signature verifier (browser WebCrypto).
 *
 *  Pure helper used by the cert-pin handler (§ A.6.5) to verify
 *  rotation notices + reverts against the pinned `server_public_key`.
 *  Lifted out of the old `auth/pair-verifier.ts` during D-156 P8 so
 *  the cert-pin path doesn't depend on the deleted pair-blob substrate;
 *  exports identical semantics to the original — returns false on
 *  ANY failure mode (import error, decode error, signature mismatch)
 *  so callers map uniformly to invalid-signature.
 *
 *  Why WebCrypto rather than `@noble/ed25519`: Ed25519 verify landed
 *  in Chrome 113+ / Firefox 130+ / Safari 17+ which matches the
 *  webclient's evergreen-browser baseline. Keeping the WebCrypto
 *  primitive avoids pulling a curve impl into the bundle for the
 *  one pinned-signature check the webclient performs. */

import { base64ToBytes } from '@recued/crypto';

/** Verify an Ed25519 signature using WebCrypto. Returns false on any
 *  failure mode (import error, decode error, signature mismatch);
 *  callers map uniformly to their invalid-signature error code. */
export const verifyEd25519 = async (
  public_key_spki_b64: string,
  payload: Uint8Array,
  signature_b64: string,
): Promise<boolean> => {
  try {
    const spki = base64ToBytes(public_key_spki_b64);
    const sig = base64ToBytes(signature_b64);
    const key = await crypto.subtle.importKey(
      'spki',
      spki as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sig as BufferSource,
      payload as BufferSource,
    );
  } catch {
    return false;
  }
};
