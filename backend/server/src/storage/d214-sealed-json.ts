/** Shared AEAD codec for D-214-owned diagnostic tables.
 *
 * Production passes the chat sub-DEK provider because all payloads derive from
 * chat. Undefined remains the repository's test/pre-KeyManager base64 fallback;
 * a wired-but-locked provider fails closed.
 */

import {
  base64ToBytes,
  bytesToBase64,
  decodeCiphertext,
  decrypt,
  encodeCiphertext,
  encrypt,
} from '@recued/crypto';

export type D214KeyProvider = () => Uint8Array | null;

export class D214VaultLockedError extends Error {
  constructor(operation: string) {
    super(`d-214: server FileVault is locked, cannot ${operation}`);
    this.name = 'D214VaultLockedError';
  }
}

const aad = (domain: string, identity: string): Uint8Array =>
  new TextEncoder().encode(`recued/v1/d214/${domain}/${identity}`);

const requireKey = (
  provider: D214KeyProvider,
  operation: string,
): Uint8Array => {
  const key = provider();
  if (key === null) throw new D214VaultLockedError(operation);
  return key;
};

export const sealD214Json = async (
  value: unknown,
  domain: string,
  identity: string,
  provider?: D214KeyProvider,
): Promise<string> => {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (provider === undefined) return bytesToBase64(plaintext);
  return encodeCiphertext(
    await encrypt(
      requireKey(provider, `seal ${domain}`),
      plaintext,
      aad(domain, identity),
    ),
  );
};

export const openD214Json = async <T>(
  blob: string,
  domain: string,
  identity: string,
  provider?: D214KeyProvider,
): Promise<T> => {
  const plaintext = provider === undefined
    ? base64ToBytes(blob)
    : await decrypt(
        requireKey(provider, `open ${domain}`),
        decodeCiphertext(blob),
        aad(domain, identity),
      );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
};
