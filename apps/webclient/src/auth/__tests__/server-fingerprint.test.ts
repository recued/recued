/** The webclient's server fingerprint must equal the server's own.
 *
 *  ⛔ WHY THIS TEST AND NOT A COMMENT. `mintBindingToken({ server_fingerprint })`
 *  binds a binding token to ONE server, and the auth Worker's DO enforces it by
 *  STRING COMPARISON against the fingerprint the proving server presents. So the
 *  three implementations have to agree byte for byte:
 *
 *    · `ed25519PublicKeyFingerprint`  — backend/server/src/keys/index.ts
 *    · `fingerprintOfSpki`            — apps/auth-worker/src/binding-crypto.ts
 *    · `serverKeyFingerprint`         — the one under test
 *
 *  A disagreement fails CLOSED — every bind is rejected — which is safe but
 *  total, and it would present as "account binding is broken" with nothing
 *  pointing at an encoding. Asserting equality against the REAL server helper
 *  over a REAL generated key is what turns that from a latent outage into a red
 *  test. It is the known-positive discipline: prove the two sides agree on a
 *  value neither one hard-codes.
 *
 *  ⚠ The webclient runs `crypto.subtle` and the server runs node:crypto; both
 *  are available here, which is exactly what makes this cross-check possible in
 *  one process. */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { ed25519PublicKeyFingerprint } from '@recued/server/keys/index.js';
import { serverKeyFingerprint } from '../server-fingerprint.js';

/** One real ed25519 keypair, exported the way the server exports its identity
 *  key and the way the webclient pins it: base64 of the SPKI DER. */
const realServerKey = (): { spkiDer: Uint8Array; b64: string } => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const spkiDer = new Uint8Array(der);
  return { spkiDer, b64: der.toString('base64') };
};

describe('server fingerprint — webclient vs server', () => {
  it('derives the SAME sha256:<hex> the server derives, for the same key', async () => {
    for (let i = 0; i < 5; i += 1) {
      const key = realServerKey();
      const fromServer = ed25519PublicKeyFingerprint(key.spkiDer);
      const fromWebclient = await serverKeyFingerprint(key.b64);
      expect(
        fromWebclient,
        'a mismatch here means every account bind is rejected by the DO',
      ).toBe(fromServer);
    }
  });

  it('produces the documented shape', async () => {
    const fingerprint = await serverKeyFingerprint(realServerKey().b64);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable — the same key always yields the same value', async () => {
    const key = realServerKey();
    expect(await serverKeyFingerprint(key.b64)).toBe(await serverKeyFingerprint(key.b64));
  });

  it('distinguishes two servers', async () => {
    // The whole control is "this token is for THAT server". If two keys
    // collided here the binding would be no better than the unbound mint.
    expect(await serverKeyFingerprint(realServerKey().b64))
      .not.toBe(await serverKeyFingerprint(realServerKey().b64));
  });

  it('THROWS on a key it cannot decode rather than returning a falsy value', async () => {
    // The caller mints with whatever this returns. A swallowed failure would
    // send `server_fingerprint: undefined`, which is exactly the unbound token
    // this module exists to prevent — so the failure has to be loud.
    await expect(serverKeyFingerprint('')).rejects.toThrow();
  });
});
