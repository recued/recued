/** PKCE (RFC 7636, S256) for a vendor sign-in the browser drives itself — the
 *  loopback dance, which has no server flow record to hold a verifier. The
 *  verifier stays in the opener's memory and reaches the server only beside the
 *  code, in `collection.connection.completeVendorOAuth`; the popup's URL carries
 *  only its challenge. Same shapes as the server's own start
 *  (`defaultCodeVerifier` / `deriveCodeChallenge`). */

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 32 random bytes as base64url: 43 characters, the RFC's minimum length. */
export const mintPkceVerifier = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
};

/** The S256 challenge: `base64url(sha256(verifier))`. */
export const pkceS256Challenge = async (verifier: string): Promise<string> =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
