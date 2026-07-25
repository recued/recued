/** M5 S2b — `createArchiveRebindStash` host-seam acceptance.
 *
 *  The factory is a thin map from `ArchiveImportRebind` onto the shared
 *  `rewrapBearerForActivePair` (covered exhaustively by its own test). These
 *  tests pin the load-bearing FIELD MAPPING the panel/helper tests can't see:
 *  that `rebind.token_id` drives the AAD/record token_id and `rebind.bearer`
 *  drives the wrapped bearer — NOT swapped, NOT a raw store — plus the
 *  best-effort (never-throws) contract. token_id and bearer use deliberately
 *  distinct values so a swap can't slip through a coincident fixture. */

import { describe, expect, it } from 'vitest';
import type {
  ArchiveImportRebind,
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';
import { createArchiveRebindStash } from './archive-rebind-stash.js';

const PAIRED: Partial<WebclientLocalStorage> = {
  server_url: 'wss://alice.recued.cloud:8443/ws',
  server_public_key: 'spki-base64',
  webclient_token: {
    token_id: 'tok-old',
    ciphertext_b64: 'old-ct',
    iv_b64: 'old-iv',
    issued_at: 1_700_000_000_000,
  },
};

interface LocalControls {
  store: WebclientLocalStore;
  setCalls(): Array<{ key: WebclientLocalKey; value: unknown }>;
  current<K extends WebclientLocalKey>(key: K): WebclientLocalStorage[K] | null;
}

const buildLocalStore = (
  initial: Partial<WebclientLocalStorage>,
  failSetOn?: WebclientLocalKey,
): LocalControls => {
  const data: Partial<WebclientLocalStorage> = { ...initial };
  const setCalls: Array<{ key: WebclientLocalKey; value: unknown }> = [];
  return {
    store: {
      async get<K extends WebclientLocalKey>(key: K) {
        return (data[key] ?? null) as WebclientLocalStorage[K] | null;
      },
      async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
        if (failSetOn === key) throw new Error(`idb-write-failed:${key}`);
        setCalls.push({ key, value });
        (data as Record<string, unknown>)[key] = value;
      },
      async remove(key) {
        delete data[key];
      },
      async inspect() {
        return {
          server_url: data.server_url ?? null,
          webclient_token: data.webclient_token ?? null,
          server_public_key: data.server_public_key ?? null,
          pair_metadata: data.pair_metadata ?? null,
          cert_pin_state: data.cert_pin_state ?? null,
        };
      },
      async clear() {
        for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
      },
    },
    setCalls: () => setCalls.slice(),
    current: (key) => (data[key] ?? null) as never,
  };
};

interface TokenControls {
  store: WebclientTokenStore;
  wrapCalls(): Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
}

const buildTokenStore = (): TokenControls => {
  const calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }> = [];
  return {
    store: {
      async wrap({ token_id, bearer, aad }) {
        calls.push({ token_id, bearer, aad });
        return {
          token_id,
          ciphertext_b64: `ct-${token_id}`,
          iv_b64: `iv-${token_id}`,
          issued_at: 222,
        } satisfies WebclientTokenRecord;
      },
      async unwrap() {
        throw new Error('not used');
      },
    },
    wrapCalls: () => calls.slice(),
  };
};

// Distinct token_id vs bearer so a field swap can't pass on coincident values.
const REBIND: ArchiveImportRebind = {
  token_id: 'REBIND_TOKEN_ID',
  bearer: 'REBIND_BEARER_PLAINTEXT',
  instance_id: 'inst-driving',
};

describe('createArchiveRebindStash', () => {
  it('maps rebind.token_id → AAD/record token_id and rebind.bearer → bearer (not swapped, not raw)', async () => {
    const local = buildLocalStore(PAIRED);
    const token = buildTokenStore();
    const stash = createArchiveRebindStash({
      localStore: local.store,
      tokenStore: token.store,
    });

    await stash(REBIND);

    // Wrap was called with the bearer from rebind.bearer + token_id from
    // rebind.token_id — and the AAD is bound to the NEW token_id.
    expect(token.wrapCalls()).toEqual([
      {
        token_id: 'REBIND_TOKEN_ID',
        bearer: 'REBIND_BEARER_PLAINTEXT',
        aad: {
          token_id: 'REBIND_TOKEN_ID',
          server_url: 'wss://alice.recued.cloud:8443/ws',
          server_public_key: 'spki-base64',
        },
      },
    ]);
    const call = token.wrapCalls()[0]!;
    expect(call.token_id).not.toBe(REBIND.bearer); // explicitly: no swap
    expect(call.bearer).not.toBe(REBIND.token_id);

    // Persisted as a WRAPPED record (ciphertext, never the raw bearer) under
    // the NEW token_id, overwriting ONLY webclient_token.
    expect(local.setCalls().map((c) => c.key)).toEqual(['webclient_token']);
    const persisted = local.current('webclient_token');
    expect(persisted?.token_id).toBe('REBIND_TOKEN_ID');
    expect(persisted?.ciphertext_b64).toBe('ct-REBIND_TOKEN_ID');
    expect(JSON.stringify(persisted)).not.toContain('REBIND_BEARER_PLAINTEXT');
  });

  it('is best-effort — a persist failure is swallowed (never throws into the caller)', async () => {
    const local = buildLocalStore(PAIRED, 'webclient_token');
    const token = buildTokenStore();
    const stash = createArchiveRebindStash({
      localStore: local.store,
      tokenStore: token.store,
    });

    // Must resolve, not reject — the panel relies on this never throwing.
    await expect(stash(REBIND)).resolves.toBeUndefined();
  });
});
