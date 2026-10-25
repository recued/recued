import * as crypto from 'node:crypto';
import {
  DEFAULT_ARGON2_PARAMS, DERIVED_KEY_LEN, SALT_LEN, deriveKEKFromPassword, type Argon2Params,
} from '@recued/crypto';

/** Node's own Argon2 (24.7 and later) where it can run: not in FIPS mode, and not
 * on a Node whose OpenSSL has no Argon2, which still exports `argon2` but throws
 * ERR_CRYPTO_ARGON2_NOT_SUPPORTED on every call, so a minimal run decides. */
export const usableNodeArgon2 = (node: {
  argon2?: typeof crypto.argon2; argon2Sync?: typeof crypto.argon2Sync; getFips(): number;
}): typeof crypto.argon2 | null => {
  if (typeof node.argon2 !== 'function' || typeof node.argon2Sync !== 'function' || node.getFips() !== 0) return null;
  try {
    node.argon2Sync('argon2id', { message: 'probe', nonce: new Uint8Array(8), parallelism: 1, tagLength: 4, memory: 8, passes: 1 });
  } catch {
    return null;
  }
  return node.argon2;
};

/** The bearer-token check (`keys/index.ts`) uses it too. */
export const nodeArgon2 = usableNodeArgon2(crypto);

/** Keep Node's implementation at the server boundary. The portable crypto
 * package still serves browsers and extensions. Only the existing default
 * cost profile takes this path; stored custom profiles keep their old reader. */
export const createKeyfilePasswordKdf = (
  native: typeof crypto.argon2 | null = nodeArgon2,
) => async (password: string, salt: Uint8Array, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<Uint8Array> => {
  if (!native || password.length === 0 || salt.length !== SALT_LEN ||
      params.t !== DEFAULT_ARGON2_PARAMS.t || params.m !== DEFAULT_ARGON2_PARAMS.m || params.p !== DEFAULT_ARGON2_PARAMS.p) {
    return deriveKEKFromPassword(password, salt, params);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    native('argon2id', { message: password, nonce: Uint8Array.from(salt),
      parallelism: params.p, tagLength: DERIVED_KEY_LEN, memory: params.m, passes: params.t },
    (error, key) => { if (error) reject(error); else resolve(key); });
  });
};

export const deriveKeyfileKEK = createKeyfilePasswordKdf();
