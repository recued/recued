/** D-148 P4 — webclient token wrap/unwrap.
 *
 *  Tests inject a deterministic AES-GCM-shaped fake (xor cipher with
 *  AAD-bound suffix) so the encrypted output is round-trippable +
 *  AAD-mismatch-detectable. Production wires
 *  `crypto.subtle.encrypt({ name: 'AES-GCM' })` which provides AAD
 *  binding natively. */

import { describe, expect, it } from 'vitest';
import {
  WebclientTokenCorruptError,
  createWebclientTokenStore,
  WEBCLIENT_TOKEN_AES_PARAMS,
  type WebclientTokenAad,
  type WebclientTokenWrapDeps,
} from '../storage/token-store.js';

const buildDeps = (
  override: Partial<WebclientTokenWrapDeps> = {},
): WebclientTokenWrapDeps => {
  // Shape-equivalent reversible cipher — the test asserts round-
  // trip + IV usage + AAD binding (mismatched AAD on decrypt
  // throws). Production path covers AES-GCM correctness via
  // WebCrypto.
  const aad_to_marker = (aad: Uint8Array): number => {
    let acc = 0;
    for (let i = 0; i < aad.length; i++) acc = (acc + aad[i]) & 0xff;
    return acc;
  };
  return {
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (i * 17 + 3) % 256;
      return out;
    },
    resolveKey: async () => ({ id: 'test-key' }),
    encrypt: async ({ iv, plaintext, additional_data }) => {
      const marker = aad_to_marker(additional_data);
      // Append the AAD marker as a one-byte tag at the end of the
      // ciphertext. Decrypt rejects when the tag doesn't match the
      // recomputed marker — emulating GCM's auth tag.
      const out = new Uint8Array(plaintext.length + 1);
      for (let i = 0; i < plaintext.length; i++) {
        out[i] = plaintext[i] ^ iv[i % iv.length];
      }
      out[plaintext.length] = marker;
      return out;
    },
    decrypt: async ({ iv, ciphertext, additional_data }) => {
      if (ciphertext.length === 0) throw new Error('empty ciphertext');
      const marker = aad_to_marker(additional_data);
      const expected = ciphertext[ciphertext.length - 1];
      if (marker !== expected) {
        throw new Error('AAD verification failed');
      }
      const body = ciphertext.subarray(0, ciphertext.length - 1);
      const out = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) {
        out[i] = body[i] ^ iv[i % iv.length];
      }
      return out;
    },
    now: () => 1_700_000_000_000,
    ...override,
  };
};

const AAD = (token_id = 'tok_abc'): WebclientTokenAad => ({
  token_id,
  server_url: 'wss://alice.recued.cloud:8443/ws',
  server_public_key: 'pk-alice',
});

describe('D-148 P4 — webclient token store', () => {
  it('exposes the expected AES-GCM params', () => {
    expect(WEBCLIENT_TOKEN_AES_PARAMS.name).toBe('AES-GCM');
    expect(WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes).toBe(12);
    expect(WEBCLIENT_TOKEN_AES_PARAMS.key_bits).toBe(256);
  });

  it('wrap → unwrap round-trips the bearer with AAD', async () => {
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 'super-secret-bearer',
      aad: AAD(),
    });
    expect(record.token_id).toBe('tok_abc');
    expect(record.iv_b64.length).toBeGreaterThan(0);
    expect(record.ciphertext_b64.length).toBeGreaterThan(0);
    expect(record.issued_at).toBe(1_700_000_000_000);
    const unwrapped = await store.unwrap(record, AAD());
    expect(unwrapped).toBe('super-secret-bearer');
  });

  it('unwrap with mismatched AAD throws WebclientTokenCorruptError', async () => {
    // ⚠⚠ THIS USED TO MISMATCH `server_url`, WITH `attacker.example.com` AS THE
    // FIXTURE — and that name made it read as a reachable attack. It is not: in
    // production `hydratePairState` reads the ciphertext AND every AAD input
    // from the same store, so an attacker editing a field edits the value the
    // AAD is REBUILT from, and both sides move together. What the AAD actually
    // defends is ciphertext RELOCATION between profiles (its own docstring
    // says so), which the two cases below exercise.
    //
    // 🔑 A fixture's NAME is not a threat model. Mistaking one for the other
    // cost a correct change a revert and two design documents (2026-09-17).
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({ token_id: 'tok_abc', bearer: 's', aad: AAD() });
    // A different server IDENTITY — the binding that survives an address change.
    await expect(
      store.unwrap(record, { ...AAD(), server_public_key: 'ed25519:SOMEONEELSE' }),
    ).rejects.toBeInstanceOf(WebclientTokenCorruptError);
  });

  it('⚠ the URL is NO LONGER part of the seal — that is what makes it editable', async () => {
    // The point of AAD v2: a self-hoster moving `public_port` off 443 keeps
    // every paired device. Under v1 this threw.
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({ token_id: 'tok_abc', bearer: 's', aad: AAD() });
    expect(await store.unwrap(record, { ...AAD(), server_url: 'wss://same-server:4433/ws' }))
      .toBe('s');
  });

  it('unwrap with AAD.token_id mismatching record.token_id throws', async () => {
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 's',
      aad: AAD(),
    });
    await expect(
      store.unwrap(record, AAD('tok_DIFFERENT')),
    ).rejects.toBeInstanceOf(WebclientTokenCorruptError);
  });

  it('wrap rejects when AAD.token_id != wrap token_id', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.wrap({ token_id: 'tok_abc', bearer: 's', aad: AAD('tok_OTHER') }),
    ).rejects.toThrow();
  });

  it('wrap rejects empty token_id, bearer, or AAD fields', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.wrap({ token_id: '', bearer: 'x', aad: AAD() }),
    ).rejects.toThrow();
    await expect(
      store.wrap({ token_id: 't', bearer: '', aad: AAD('t') }),
    ).rejects.toThrow();
    await expect(
      store.wrap({
        token_id: 't',
        bearer: 'x',
        // ⚠ `server_public_key`, not `server_url` — the URL left the AAD in v2
        // and an empty one is no longer a malformed context.
        aad: { ...AAD('t'), server_public_key: '' },
      }),
    ).rejects.toThrow();
  });

  it('unwrap rejects malformed / empty records', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.unwrap(
        { token_id: 't', ciphertext_b64: '', iv_b64: '', issued_at: 0 } as never,
        AAD('t'),
      ),
    ).rejects.toBeInstanceOf(WebclientTokenCorruptError);
    await expect(store.unwrap({} as never, AAD())).rejects.toBeInstanceOf(
      WebclientTokenCorruptError,
    );
  });

  it('unwrap normalizes inner decrypt failure into WebclientTokenCorruptError', async () => {
    const store = createWebclientTokenStore(
      buildDeps({
        decrypt: async () => {
          throw new Error('underlying webcrypto failure');
        },
      }),
    );
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 'b',
      aad: AAD(),
    });
    await expect(store.unwrap(record, AAD())).rejects.toBeInstanceOf(
      WebclientTokenCorruptError,
    );
  });

  it('IV varies across wraps even with the same plaintext', async () => {
    let counter = 0;
    const store = createWebclientTokenStore(
      buildDeps({
        randomBytes: (n) => {
          const out = new Uint8Array(n);
          for (let i = 0; i < n; i++) out[i] = (i + counter) % 256;
          counter += 7;
          return out;
        },
      }),
    );
    const a = await store.wrap({ token_id: 't', bearer: 'b', aad: AAD('t') });
    const b = await store.wrap({ token_id: 't', bearer: 'b', aad: AAD('t') });
    expect(a.iv_b64).not.toBe(b.iv_b64);
  });

  it('refuses unexpected IV length from the random source', async () => {
    const store = createWebclientTokenStore(
      buildDeps({
        randomBytes: () => new Uint8Array(8), // not 12
      }),
    );
    await expect(
      store.wrap({ token_id: 't', bearer: 'b', aad: AAD('t') }),
    ).rejects.toThrow(/IV length/);
  });
});
