/** D-148 — changing the address of an already-paired server.
 *
 *  ⛔ THE CASE THAT MATTERS IS THE v1 RE-SEAL. The v1 token AAD bound the
 *  ciphertext to `server_url`, and `onLegacyAadRecord` — the hook that would
 *  drain v1 rows in the background — IS WIRED TO NOTHING, so a v1 record stays
 *  v1 for ever. Without the re-seal, moving the address of a v1-wrapped
 *  profile destroys the bearer and the user is told to re-pair BY THE FEATURE
 *  THAT PROMISED TO MOVE THEM SAFELY.
 *
 *  ⚠ THE LAST FOUR CASES ARE THE JOIN. Everything before them re-seals and
 *  reads the record back with an AAD THIS FILE builds — while the production
 *  reader builds a different one: `buildAad` in `webclient-bootstrap.ts` always
 *  passes `server_url`, and after a move that is the NEW address. A re-seal
 *  that were somehow still v1 would satisfy every earlier assertion and fail on
 *  the next real connect. Two suites either side of one boundary, the join
 *  never run.
 *
 *  The v1 records here are sealed by `sealV1` under a REAL Ed25519 key, so the
 *  probe under test is the real probe. The genuine shipped artifact
 *  (`storage/__fixtures__/token-aad-v1-record.json`) pins the v1 READER, in
 *  `storage/token-aad-migration.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import { webcrypto, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  WebclientServerProfile,
  WebclientTokenRecord,
} from '@recued/contracts';
import { buildIdentityProbePayload } from '@recued/contracts';
import { ed25519Sign } from '@recued/server/keys/index.js';
import type { Ed25519Keypair } from '@recued/server/keys/index.js';

import { retargetServerUrl } from '../retarget-server-url.js';
import { createWebclientTokenStore } from '../../storage/token-store.js';
import type { WebclientTokenAad } from '../../storage/token-store.js';

/** The fixture's own sealing context — it was wrapped at this address. */
const OLD_URL = 'wss://alice.recued.net/ws';
const NEW_URL = 'wss://alice.recued.net:4433/ws';
const V1_BEARER = 'bearer-sealed-under-aad-v1';
const KEY_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i++) KEY_BYTES[i] = (i * 7) % 256;

interface MinimalSubtle {
  importKey(f: string, k: Uint8Array, a: string, e: boolean, u: string[]): Promise<unknown>;
  encrypt(a: { name: string; iv: Uint8Array; additionalData?: Uint8Array }, k: unknown, d: Uint8Array): Promise<ArrayBuffer>;
  decrypt(a: { name: string; iv: Uint8Array; additionalData?: Uint8Array }, k: unknown, d: Uint8Array): Promise<ArrayBuffer>;
}
const subtle = webcrypto.subtle as unknown as MinimalSubtle;

/** Seal a record the RETIRED way, under a real server key.
 *
 *  ⚠ The v1 AAD bytes are written out literally here rather than imported.
 *  `buildAadBytesV1` is module-private and, more to the point, a test that
 *  reused the implementation's own builder could not tell a correct format
 *  from a matching mistake. The genuine shipped artifact
 *  (`storage/__fixtures__/token-aad-v1-record.json`) is what pins the real
 *  builder, in `storage/token-aad-migration.test.ts`; this constructs an
 *  equivalent record under a key the probe can actually verify against. */
const sealV1 = async (args: {
  token_id: string;
  bearer: string;
  server_url: string;
  server_public_key: string;
}): Promise<WebclientTokenRecord> => {
  const key = await subtle.importKey('raw', KEY_BYTES, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(12);
  iv[0] = 0xff;
  const additionalData = new TextEncoder().encode(
    JSON.stringify({
      domain: 'recued.webclient.token.aad.v1',
      token_id: args.token_id,
      server_url: args.server_url,
      server_public_key: args.server_public_key,
    }),
  );
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      key,
      new TextEncoder().encode(args.bearer),
    ),
  );
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return {
    token_id: args.token_id,
    ciphertext_b64: b64(ciphertext),
    iv_b64: b64(iv),
    issued_at: 1_700_000_000_000,
  } as WebclientTokenRecord;
};

const realTokenStore = async () => {
  const key = await subtle.importKey('raw', KEY_BYTES, 'AES-GCM', false, ['encrypt', 'decrypt']);
  // ⚠ A COUNTER, not a constant: re-sealing reuses the key, so a fixed IV
  // would be an AES-GCM nonce reuse and the test would be modelling something
  // no correct caller does.
  let counter = 0;
  return createWebclientTokenStore({
    resolveKey: async () => key,
    encrypt: async ({ key: k, iv, plaintext, additional_data }) =>
      new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additional_data }, k, plaintext)),
    decrypt: async ({ key: k, iv, ciphertext, additional_data }) =>
      new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additional_data }, k, ciphertext)),
    randomBytes: () => {
      const iv = new Uint8Array(12);
      iv[0] = counter++;
      return iv;
    },
    now: () => 1_700_000_000_000,
  });
};

const realKeypair = (): Ed25519Keypair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    key_class: 'server_identity_key',
    private_key_b64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    public_key_b64: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
    public_key_fingerprint: 'unused',
    created_at: 0,
  } as Ed25519Keypair;
};

/** A real server at the candidate address: signs the probe payload properly. */
const signingServer = (keypair: Ed25519Keypair) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { nonce: string };
    return new Response(
      JSON.stringify({
        signature: ed25519Sign(
          keypair,
          buildIdentityProbePayload({
            nonce: body.nonce,
            server_public_key: keypair.public_key_b64,
          }),
        ),
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;

const profileFor = (keypair: Ed25519Keypair, token: WebclientTokenRecord | null): WebclientServerProfile => ({
  id: 'p1',
  label: 'Home server',
  server_url: OLD_URL,
  webclient_token: token,
  server_public_key: keypair.public_key_b64,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
});

describe('retargetServerUrl', () => {
  it('⛔⛔ re-seals a v1-AAD record so the bearer survives the move', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    let saved: { url: string; token: WebclientTokenRecord | null } | null = null;

    const outcome = await retargetServerUrl(
      profileFor(keypair, legacy),
      NEW_URL,
      {
        tokenStore: store,
        retarget: async (_id, url, token) => {
          saved = { url, token };
          return url;
        },
        fetch: signingServer(keypair),
      },
    );

    expect(outcome).toEqual({ kind: 'saved', server_url: NEW_URL });
    expect(saved!.url).toBe(NEW_URL);

    // 🔑 THE ASSERTION THE FEATURE RESTS ON: the stored record opens with NO
    // `server_url` in the AAD — so it keeps opening wherever the server moves.
    const aadV2: WebclientTokenAad = {
      token_id: 'tok_v1',
      server_public_key: keypair.public_key_b64,
    };
    await expect(store.unwrap(saved!.token!, aadV2)).resolves.toBe(V1_BEARER);
  });

  it('⛔ writes NOTHING when the candidate does not prove the pinned identity', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const impostor = realKeypair();
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    let called = false;

    const outcome = await retargetServerUrl(
      profileFor(keypair, legacy),
      NEW_URL,
      {
        tokenStore: store,
        retarget: async () => {
          called = true;
          return NEW_URL;
        },
        // A real, live server — just not THIS one.
        fetch: signingServer(impostor),
      },
    );

    expect(outcome.kind).toBe('refused');
    expect(called).toBe(false);
    // ⚠ And the profile's own record is untouched: it still opens at the OLD
    // address, which is the only state the user can still connect from.
    await expect(
      store.unwrap(legacy, {
        token_id: 'tok_v1',
        server_url: OLD_URL,
        server_public_key: keypair.public_key_b64,
      }),
    ).resolves.toBe(V1_BEARER);
  });

  it('writes nothing when the candidate is unreachable', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    let called = false;
    const outcome = await retargetServerUrl(profileFor(keypair, null), NEW_URL, {
      tokenStore: store,
      retarget: async () => { called = true; return NEW_URL; },
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'refused', probe: { kind: 'unreachable' } });
    expect(called).toBe(false);
  });

  it('moves a profile that holds no bearer — nothing to re-seal is not an error', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const outcome = await retargetServerUrl(profileFor(keypair, null), NEW_URL, {
      tokenStore: store,
      retarget: async (_id, url) => url,
      fetch: signingServer(keypair),
    });
    expect(outcome).toEqual({ kind: 'saved', server_url: NEW_URL });
  });

  it('⛔ a profile with no pinned key is never even CONTACTED', async () => {
    // ⚠ Found by mutation. This used to assert only that nothing was written —
    // and fabricating a key in place of the missing one passed it, because the
    // probe then refused anyway and the write still did not happen. The
    // property that mutation broke is the one that matters: with nothing to
    // verify AGAINST, the browser must not reach out to the address at all.
    // "Verified" would otherwise be a word with no content, and the user's
    // browser would have dialled a stranger to earn it.
    const store = await realTokenStore();
    const keypair = realKeypair();
    let called = false;
    const fetchSpy = vi.fn(signingServer(keypair) as never);
    const outcome = await retargetServerUrl(
      { ...profileFor(keypair, null), server_public_key: null },
      NEW_URL,
      {
        tokenStore: store,
        retarget: async () => { called = true; return NEW_URL; },
        fetch: fetchSpy as never,
      },
    );
    expect(outcome).toEqual({ kind: 'refused', probe: { kind: 'not_the_same_server' } });
    expect(called).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a store refusal (duplicate address / stale id) without claiming success', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const outcome = await retargetServerUrl(profileFor(keypair, null), NEW_URL, {
      tokenStore: store,
      retarget: async () => null,
      fetch: signingServer(keypair),
    });
    expect(outcome).toEqual({ kind: 'rejected_by_store' });
  });

  it('⚠ writes nothing when the bearer cannot be re-sealed', async () => {
    const keypair = realKeypair();
    let called = false;
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    const outcome = await retargetServerUrl(profileFor(keypair, legacy), NEW_URL, {
      tokenStore: {
        unwrap: async () => { throw new Error('key unavailable'); },
        wrap: async () => { throw new Error('unreachable'); },
      },
      retarget: async () => { called = true; return NEW_URL; },
      fetch: signingServer(keypair),
    });
    expect(outcome.kind).toBe('token_reseal_failed');
    expect(called).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════
  // THE JOIN. Everything above re-seals and then reads the record back with
  // an AAD this test builds. ⛔ THE PRODUCTION READER BUILDS A DIFFERENT ONE:
  // `buildAad` in webclient-bootstrap.ts ALWAYS passes `server_url`, and after
  // a move that is the NEW address. A re-seal that were somehow still v1 would
  // pass every assertion above and fail on the next real connect — two suites
  // either side of one boundary, with the join never run.
  // ══════════════════════════════════════════════════════════════════════

  /** The exact shape `buildAad(hydratePairState(store))` produces. */
  const productionAad = (token_id: string, server_url: string, server_public_key: string) =>
    ({ token_id, server_url, server_public_key });

  it('⛔⛔ the moved record opens under the PRODUCTION AAD, carrying the NEW address', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    let saved: WebclientTokenRecord | null = null;

    await retargetServerUrl(profileFor(keypair, legacy), NEW_URL, {
      tokenStore: store,
      retarget: async (_id, url, token) => { saved = token; return url; },
      fetch: signingServer(keypair),
    });

    // Read it the way the next boot will: every unwrap site passes the
    // CURRENT server_url, and `unwrap` tries v2 first — which ignores the
    // field entirely, which is the whole point of dropping it from v2.
    await expect(
      store.unwrap(saved!, productionAad('tok_v1', NEW_URL, keypair.public_key_b64)),
    ).resolves.toBe(V1_BEARER);
  });

  it('⚠ and the same record WITHOUT the re-seal fails — the defect this prevents', async () => {
    // Makes the guarantee legible: it is the re-seal doing the work, not luck.
    const store = await realTokenStore();
    const keypair = realKeypair();
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    // v2 fails (it is a v1 record); the v1 fallback rebuilds the AAD with the
    // NEW address and fails too. The bearer is unrecoverable and the user is
    // told to re-pair.
    await expect(
      store.unwrap(legacy, productionAad('tok_v1', NEW_URL, keypair.public_key_b64)),
    ).rejects.toThrow();
    // Same record, OLD address — still fine. So nothing is corrupt; the
    // address is simply part of what sealed it.
    await expect(
      store.unwrap(legacy, productionAad('tok_v1', OLD_URL, keypair.public_key_b64)),
    ).resolves.toBe(V1_BEARER);
  });

  it('a re-sealed record opens at ANY address, so a second move also works', async () => {
    const store = await realTokenStore();
    const keypair = realKeypair();
    const legacy = await sealV1({
      token_id: 'tok_v1',
      bearer: V1_BEARER,
      server_url: OLD_URL,
      server_public_key: keypair.public_key_b64,
    });
    let saved: WebclientTokenRecord | null = null;
    await retargetServerUrl(profileFor(keypair, legacy), NEW_URL, {
      tokenStore: store,
      retarget: async (_id, url, token) => { saved = token; return url; },
      fetch: signingServer(keypair),
    });

    for (const address of [OLD_URL, NEW_URL, 'wss://third.example:9443/ws']) {
      await expect(
        store.unwrap(saved!, productionAad('tok_v1', address, keypair.public_key_b64)),
      ).resolves.toBe(V1_BEARER);
    }
  });

  it('pins the production AAD shape this file models', () => {
    // ⚠ If `buildAad` ever stopped passing `server_url`, the cases above would
    // still pass while modelling a reader that no longer exists.
    const source = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'webclient-bootstrap.ts'),
      'utf-8',
    );
    const builder = source.slice(source.indexOf('const buildAad ='), source.indexOf('const buildAad =') + 300);
    expect(builder).toMatch(/token_id:\s*pair\.token\.token_id/);
    expect(builder).toMatch(/server_url:\s*pair\.serverUrl/);
    expect(builder).toMatch(/server_public_key:\s*pair\.serverPublicKey/);
  });
});
