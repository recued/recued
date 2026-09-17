/** D-148 — a v1-sealed record is RE-SEALED once it has been opened.
 *
 *  ⛔ WHY THIS IS THE LOAD-BEARING HALF OF THE MIGRATION. `onLegacyAadRecord`
 *  is the store's signal that a record opened under the retired v1 AAD, and it
 *  had NO production caller — while a comment in that same file claimed "every
 *  unwrap re-seals, so the population drains on its own". It did not drain at
 *  all, so v1 support could never be retired, and deleting it on that sentence
 *  would have made every un-migrated bearer unrecoverable.
 *
 *  ⚠ The store deliberately does not re-seal itself: "a store that silently
 *  rewrote rows during a read would make an unwrap a WRITE, in the one code
 *  path that runs before the app knows whether it is even online." The owner of
 *  persistence does it, which is `webclient-main.ts`. This drives that
 *  composition rather than a hand-built copy of it.
 */

import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { WebclientTokenRecord } from '@recued/contracts';

import { createWebclientTokenStore } from '../storage/token-store.js';
import {
  createInMemoryWebclientLocalStore,
  type WebclientProfileAwareStore,
} from '../storage/local-store.js';
import { codeOf } from './helpers/source-text.js';

const KEY_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i += 1) KEY_BYTES[i] = (i * 7) % 256;
const URL_A = 'wss://alice.example/ws';
const PUB = 'cGsteWVz';
const BEARER = 'the-legacy-bearer';

interface MinimalSubtle {
  importKey(f: string, k: Uint8Array, a: string, e: boolean, u: string[]): Promise<unknown>;
  encrypt(a: { name: string; iv: Uint8Array; additionalData?: Uint8Array }, k: unknown, d: Uint8Array): Promise<ArrayBuffer>;
  decrypt(a: { name: string; iv: Uint8Array; additionalData?: Uint8Array }, k: unknown, d: Uint8Array): Promise<ArrayBuffer>;
}
const subtle = webcrypto.subtle as unknown as MinimalSubtle;

/** The composition `webclient-main.ts` builds, reproduced with an in-memory
 *  store. ⚠ The re-seal RULE it encodes is pinned against the real file below,
 *  so this cannot drift into testing a private invention. */
const buildStack = async (localStore: WebclientProfileAwareStore) => {
  const key = await subtle.importKey('raw', KEY_BYTES, 'AES-GCM', false, ['encrypt', 'decrypt']);
  let ivCounter = 0;
  const legacy = new Set<string>();
  const base = createWebclientTokenStore({
    resolveKey: async () => key,
    encrypt: async ({ key: k, iv, plaintext, additional_data }) =>
      new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additional_data }, k, plaintext)),
    decrypt: async ({ key: k, iv, ciphertext, additional_data }) =>
      new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additional_data }, k, ciphertext)),
    randomBytes: () => { const iv = new Uint8Array(12); iv[0] = ivCounter++; return iv; },
    now: () => 1_700_000_000_000,
    onLegacyAadRecord: (record) => { legacy.add(record.token_id); },
  });
  const store = {
    wrap: base.wrap.bind(base),
    async unwrap(record: WebclientTokenRecord, aad: { token_id: string; server_url?: string; server_public_key: string }) {
      const bearer = await base.unwrap(record, aad);
      if (legacy.delete(record.token_id)) {
        const current = await localStore.get('webclient_token');
        if (current && current.token_id === record.token_id
            && current.ciphertext_b64 === record.ciphertext_b64) {
          await localStore.set('webclient_token', await base.wrap({
            token_id: aad.token_id,
            bearer,
            aad: { token_id: aad.token_id, server_public_key: aad.server_public_key },
          }));
        }
      }
      return bearer;
    },
  };
  return { store, base };
};

const sealV1 = async (token_id: string, server_url: string): Promise<WebclientTokenRecord> => {
  const key = await subtle.importKey('raw', KEY_BYTES, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(12); iv[0] = 0xff;
  const additionalData = new TextEncoder().encode(JSON.stringify({
    domain: 'recued.webclient.token.aad.v1', token_id, server_url, server_public_key: PUB,
  }));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(BEARER)));
  return {
    token_id,
    ciphertext_b64: Buffer.from(ct).toString('base64'),
    iv_b64: Buffer.from(iv).toString('base64'),
    issued_at: 1,
  } as WebclientTokenRecord;
};

describe('D-148 — the v1 population actually drains', () => {
  it('⛔⛔ one unwrap converts the stored record to v2', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile(URL_A);
    const legacyRecord = await sealV1('tok1', URL_A);
    await localStore.set('webclient_token', legacyRecord);
    const { store, base } = await buildStack(localStore);

    expect(await store.unwrap(legacyRecord, {
      token_id: 'tok1', server_url: URL_A, server_public_key: PUB,
    })).toBe(BEARER);

    const stored = await localStore.get('webclient_token');
    expect(stored, 'the stored record was replaced').not.toEqual(legacyRecord);
    // 🔑 THE CONVERGENCE: it now opens with NO url — so the address can move,
    // and the next boot needs no v1 fallback for it.
    await expect(base.unwrap(stored!, { token_id: 'tok1', server_public_key: PUB }))
      .resolves.toBe(BEARER);
  });

  it('⚠ a second unwrap re-seals NOTHING — the drain is idempotent', async () => {
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile(URL_A);
    const legacyRecord = await sealV1('tok1', URL_A);
    await localStore.set('webclient_token', legacyRecord);
    const { store } = await buildStack(localStore);

    await store.unwrap(legacyRecord, { token_id: 'tok1', server_url: URL_A, server_public_key: PUB });
    const afterFirst = await localStore.get('webclient_token');
    await store.unwrap(afterFirst!, { token_id: 'tok1', server_url: URL_A, server_public_key: PUB });
    expect(await localStore.get('webclient_token')).toEqual(afterFirst);
  });

  it('⛔ does NOT overwrite when the opened record is not the stored one', async () => {
    // An unwrap can be driven for a record belonging to another profile.
    // Writing then would move one profile's bearer onto another.
    const localStore = createInMemoryWebclientLocalStore();
    await localStore.ensureProfile(URL_A);
    const mine = await sealV1('tok-mine', URL_A);
    await localStore.set('webclient_token', mine);
    const theirs = await sealV1('tok-theirs', 'wss://other.example/ws');
    const { store } = await buildStack(localStore);

    await store.unwrap(theirs, {
      token_id: 'tok-theirs', server_url: 'wss://other.example/ws', server_public_key: PUB,
    });
    expect(await localStore.get('webclient_token')).toEqual(mine);
  });

  it('⛔ the REAL composition wires this, not just the copy above', () => {
    // The rule is only worth testing where it actually runs.
    const main = codeOf(new URL('../webclient-main.ts', import.meta.url).pathname);
    expect(main).toMatch(/onLegacyAadRecord/);
    expect(main).toMatch(/buildResealingTokenStore\(db,\s*localStore\)/);
    // And the re-seal drops the URL, which is the point of converting at all.
    expect(main).toMatch(/aad:\s*\{\s*token_id:[^}]*server_public_key:[^}]*\}/);
  });
});
