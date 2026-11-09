/** D-169 P0 Slice 2B — bridge token wrap/unwrap.
 *
 *  Mirror of `apps/webclient/src/__tests__/token-store.test.ts`. The
 *  bridge's `createWebclientTokenStore` factory is a verbatim port of
 *  the webclient's primitive — substrate alignment requires they
 *  produce binary-compatible AAD bytes + the same record shape. These
 *  tests inject the same deterministic AES-GCM-shaped fake (xor cipher
 *  with AAD-bound suffix tag) so the encrypted output is
 *  round-trippable + AAD-mismatch-detectable. Production wires
 *  `crypto.subtle.encrypt({ name: 'AES-GCM' })` which provides AAD
 *  binding natively (see `apps/bridge/src/boot/service-worker-entry.ts`).
 *
 *  Why test the bridge copy too: the substrate is duplicated until a
 *  follow-on cleanup lifts it to a shared package (`@recued/crypto`).
 *  A regression in one copy must not silently diverge from the other;
 *  re-running this test on the bridge tree catches drift early. */

import { describe, expect, it } from 'vitest';
import {
  WebclientTokenCorruptError,
  createWebclientTokenStore,
  WEBCLIENT_TOKEN_AES_PARAMS,
  type WebclientTokenAad,
  type WebclientTokenWrapDeps,
} from '../storage/token-store.js';
// ⚠ The OTHER copy, imported so parity is compared instead of transcribed.
import { createWebclientTokenStore as createWebclientTokenStoreWeb } from '../../../webclient/src/storage/token-store.js';

const buildDeps = (
  override: Partial<WebclientTokenWrapDeps> = {},
): WebclientTokenWrapDeps => {
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

/** ⚠ NO `server_url` — v2 does not bind the address, and the bridge's AAD type
 *  no longer has the field at all. */
const AAD = (token_id = 'tok_abc'): WebclientTokenAad => ({
  token_id,
  server_public_key: 'pk-alice',
});

describe('D-169 P0 Slice 2B — bridge token store', () => {
  it('exposes the same AES-GCM params as the webclient primitive', () => {
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

  it('unwrap with a mismatched KEY throws WebclientTokenCorruptError', async () => {
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 'secret',
      aad: AAD(),
    });
    await expect(
      store.unwrap(record, { ...AAD(), server_public_key: 'pk-someone-else' }),
    ).rejects.toBeInstanceOf(WebclientTokenCorruptError);
  });

  it('⛔ the AAD type carries no address at all — not optional, absent', async () => {
    // The v1 binding is gone from the TYPE, not merely unused, so a caller
    // cannot reintroduce it by passing one. That is the "no compat shim" rule
    // enforced by the compiler rather than by a reviewer noticing.
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({ token_id: 'tok_abc', bearer: 'secret', aad: AAD('tok_abc') });
    // Unwrapping needs only what v2 binds.
    await expect(store.unwrap(record, AAD('tok_abc'))).resolves.toBe('secret');
    expect(Object.keys(AAD())).toEqual(['token_id', 'server_public_key']);
  });

  it('⛔ there is NO v1 reader here, and that is the decision', async () => {
    // D-148 I-20: "pre-launch zero-installs: no migration code, no compat
    // shims." The bridge is not shipped, so no record was ever sealed under v1
    // BY IT — a fallback here would guard nobody while carrying a second format
    // for ever. The webclient keeps one because its population is real.
    //
    // ⚠ A bridge paired before the change re-pairs. One paste, one pair module.
    const deps = buildDeps();
    const store = createWebclientTokenStore(deps);
    const aad = AAD();
    const v1Bytes = new TextEncoder().encode(JSON.stringify({
      domain: 'recued.webclient.token.aad.v1',
      token_id: aad.token_id,
      server_url: 'wss://alice.recued.cloud:8443/ws',
      server_public_key: aad.server_public_key,
    }));
    const iv = deps.randomBytes(WEBCLIENT_TOKEN_AES_PARAMS.iv_length_bytes);
    const ciphertext = await deps.encrypt({
      key: await deps.resolveKey(),
      iv,
      plaintext: new TextEncoder().encode('legacy-bearer'),
      additional_data: v1Bytes,
    });
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
    const legacy = {
      token_id: aad.token_id,
      ciphertext_b64: b64(ciphertext),
      iv_b64: b64(iv),
      issued_at: 1,
    };
    // Refused, loudly and as corruption — which is the honest answer: this
    // store has no idea what a v1 record is.
    await expect(store.unwrap(legacy, aad)).rejects.toBeInstanceOf(WebclientTokenCorruptError);
  });

  it('unwrap with AAD.token_id mismatching record.token_id throws', async () => {
    const store = createWebclientTokenStore(buildDeps());
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 'secret',
      aad: AAD('tok_abc'),
    });
    await expect(store.unwrap(record, AAD('tok_xyz'))).rejects.toBeInstanceOf(
      WebclientTokenCorruptError,
    );
  });

  it('wrap rejects when AAD.token_id != wrap token_id', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.wrap({ token_id: 'tok_abc', bearer: 'x', aad: AAD('tok_other') }),
    ).rejects.toThrow(/aad\.token_id must equal the wrap token_id/);
  });

  it('wrap rejects empty token_id or bearer', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.wrap({ token_id: '', bearer: 'x', aad: AAD('') }),
    ).rejects.toThrow();
    await expect(
      store.wrap({ token_id: 'tok', bearer: '', aad: AAD('tok') }),
    ).rejects.toThrow();
  });

  it('unwrap rejects malformed records (missing iv / ciphertext)', async () => {
    const store = createWebclientTokenStore(buildDeps());
    await expect(
      store.unwrap(
        // @ts-expect-error testing runtime guard against malformed input
        { token_id: 'tok_abc', issued_at: 0 },
        AAD(),
      ),
    ).rejects.toBeInstanceOf(WebclientTokenCorruptError);
  });

  it('unwrap normalizes inner decrypt failure into WebclientTokenCorruptError', async () => {
    const store = createWebclientTokenStore({
      ...buildDeps(),
      decrypt: async () => {
        throw new Error('synthetic decrypt failure');
      },
    });
    const record = await store.wrap({
      token_id: 'tok_abc',
      bearer: 'x',
      aad: AAD(),
    });
    await expect(store.unwrap(record, AAD())).rejects.toBeInstanceOf(
      WebclientTokenCorruptError,
    );
  });

  it('⛔⛔ AAD bytes are IDENTICAL to the webclient\'s — compared, not transcribed', async () => {
    // ⛔ THIS TEST USED TO PIN A LITERAL, AND THAT IS WHY IT NEVER FIRED. Its
    // name and its comment both promised cross-surface parity — "if either side
    // drifts, a future shared-storage migration would silently fail AEAD verify
    // on the other surface" — while the assertion compared the bridge's output
    // to a HARDCODED string. When the webclient moved to AAD v2 on 2026-09-17
    // this stayed green for a day, guarding nothing, in a file whose header
    // says the two copies must not silently diverge.
    //
    // 🔑 A test that transcribes the other side is a second copy of it. The two
    // stores are now DRIVEN and their AAD bytes compared, so the parity claim
    // is checked by construction rather than restated.
    const capture = async (
      make: typeof createWebclientTokenStore | typeof createWebclientTokenStoreWeb,
    ): Promise<string> => {
      let captured: Uint8Array | null = null;
      const store = make({
        ...buildDeps(),
        // ⚠ Typed explicitly: the `as never` below erases the contextual type
        // the destructuring would otherwise infer from, and `typecheck:tests`
        // catches that where vitest does not.
        encrypt: async ({ plaintext, additional_data }: {
          plaintext: Uint8Array;
          additional_data: Uint8Array;
        }) => {
          captured = additional_data;
          return new Uint8Array(plaintext.length + 1);
        },
      } as never);
      await store.wrap({ token_id: 'tok_abc', bearer: 'x', aad: AAD('tok_abc') as never });
      expect(captured).not.toBeNull();
      return new TextDecoder().decode(captured!);
    };

    const bridgeBytes = await capture(createWebclientTokenStore);
    const webclientBytes = await capture(createWebclientTokenStoreWeb);
    expect(bridgeBytes).toBe(webclientBytes);

    // And pinned in full, so a change agreed on BOTH sides is still deliberate.
    expect(bridgeBytes).toBe(
      JSON.stringify({
        domain: 'recued.webclient.token.aad.v2',
        token_id: 'tok_abc',
        server_public_key: 'pk-alice',
      }),
    );
    // ⚠ The field the migration removed, asserted absent rather than assumed.
    expect(bridgeBytes).not.toContain('server_url');
  });
});
