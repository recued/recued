/** `rewrapBearerForActivePair` acceptance — the shared in-place bearer
 *  re-wrap behind the `token.rotated` handler (D-148 § A.4.4) and the M5 S2b
 *  archive-restore rebind handoff.
 *
 *  Surface:
 *    - Happy path: reads server context → wraps with AAD bound to the NEW
 *      token_id → persists `webclient_token` → returns { ok, record }.
 *    - issued_at: override applied when passed; wrap's own stamp kept when not.
 *    - IN-PLACE invariant: ONLY `webclient_token` is written — never
 *      server_url / server_public_key (so the bootstrap's strict pair-triple
 *      never breaks mid-swap; no lockout window).
 *    - server_url / server_public_key null → read_pair_context, no wrap.
 *    - localStore read throws → read_pair_context.
 *    - wrap throws → wrap stage, no persist.
 *    - persist throws → persist stage. */

import { describe, expect, it } from 'vitest';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import type { WebclientLocalStore } from './local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from './token-store.js';
import { rewrapBearerForActivePair } from './rewrap-bearer.js';

// ──────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────

interface LocalStoreControls {
  store: WebclientLocalStore;
  setCalls(): Array<{ key: WebclientLocalKey; value: unknown }>;
  current<K extends WebclientLocalKey>(key: K): WebclientLocalStorage[K] | null;
}

const buildLocalStore = (
  initial: Partial<WebclientLocalStorage>,
  opts: { failGet?: Error; failSetOn?: WebclientLocalKey } = {},
): LocalStoreControls => {
  const data: Partial<WebclientLocalStorage> = { ...initial };
  const setCalls: Array<{ key: WebclientLocalKey; value: unknown }> = [];
  const store: WebclientLocalStore = {
    async get<K extends WebclientLocalKey>(key: K) {
      if (opts.failGet) throw opts.failGet;
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      if (opts.failSetOn === key) throw new Error(`idb-write-failed:${key}`);
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
  };
  return {
    store,
    setCalls: () => setCalls.slice(),
    current: (key) => (data[key] ?? null) as never,
  };
};

interface TokenStoreControls {
  store: WebclientTokenStore;
  wrapCalls(): Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }>;
  failNextWrap(err: Error): void;
}

const buildTokenStore = (): TokenStoreControls => {
  const calls: Array<{ token_id: string; bearer: string; aad: WebclientTokenAad }> = [];
  let pendingFailure: Error | null = null;
  return {
    store: {
      async wrap({ token_id, bearer, aad }) {
        if (pendingFailure) {
          const err = pendingFailure;
          pendingFailure = null;
          throw err;
        }
        calls.push({ token_id, bearer, aad });
        return {
          token_id,
          ciphertext_b64: `ct-${token_id}`,
          iv_b64: `iv-${token_id}`,
          issued_at: 111, // wrap-time clock stamp (overridden iff issued_at passed)
        } satisfies WebclientTokenRecord;
      },
      async unwrap() {
        throw new Error('not used in these tests');
      },
    },
    wrapCalls: () => calls.slice(),
    failNextWrap: (err) => {
      pendingFailure = err;
    },
  };
};

const OLD_TOKEN: WebclientTokenRecord = {
  token_id: 'tok-old',
  ciphertext_b64: 'old-ct',
  iv_b64: 'old-iv',
  issued_at: 1_700_000_000_000,
};

const PAIRED: Partial<WebclientLocalStorage> = {
  server_url: 'wss://alice.recued.cloud:8443/ws',
  server_public_key: 'spki-base64',
  webclient_token: OLD_TOKEN,
};

// ══════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════

describe('rewrapBearerForActivePair', () => {
  it('happy path: reads server context → wraps with new-token_id AAD → persists → ok', async () => {
    const local = buildLocalStore(PAIRED);
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh-bearer-plaintext',
    });

    expect(result.ok).toBe(true);
    const wrapCalls = token.wrapCalls();
    expect(wrapCalls).toEqual([
      {
        token_id: 'tok-new',
        bearer: 'fresh-bearer-plaintext',
        aad: {
          token_id: 'tok-new',
          server_url: 'wss://alice.recued.cloud:8443/ws',
          server_public_key: 'spki-base64',
        },
      },
    ]);
    const persisted = local.current('webclient_token');
    expect(persisted).toEqual({
      token_id: 'tok-new',
      ciphertext_b64: 'ct-tok-new',
      iv_b64: 'iv-tok-new',
      issued_at: 111, // wrap's own stamp — no override passed
    });
    if (result.ok) expect(result.record).toEqual(persisted);
  });

  it('IN-PLACE: writes ONLY webclient_token, never server_url / server_public_key', async () => {
    const local = buildLocalStore(PAIRED);
    const token = buildTokenStore();

    await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    const setKeys = local.setCalls().map((c) => c.key);
    expect(setKeys).toEqual(['webclient_token']);
    // The strict-triple's other two fields are untouched → never a null window.
    expect(local.current('server_url')).toBe('wss://alice.recued.cloud:8443/ws');
    expect(local.current('server_public_key')).toBe('spki-base64');
  });

  it('issued_at override is stamped onto the persisted record when passed', async () => {
    const local = buildLocalStore(PAIRED);
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
      issued_at: 1_700_000_999_999,
    });

    expect(result.ok).toBe(true);
    expect(local.current('webclient_token')?.issued_at).toBe(1_700_000_999_999);
  });

  it('server_url null → read_pair_context, no wrap, no persist', async () => {
    const local = buildLocalStore({ ...PAIRED, server_url: null });
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    expect(result).toMatchObject({ ok: false, stage: 'read_pair_context' });
    if (!result.ok) expect(result.error.message).toMatch(/pair context incomplete/);
    expect(token.wrapCalls()).toHaveLength(0);
    expect(local.setCalls()).toHaveLength(0);
    // Old bearer left intact → reconnect falls back to a clean re-pair.
    expect(local.current('webclient_token')).toEqual(OLD_TOKEN);
  });

  it('server_public_key null → read_pair_context, no wrap', async () => {
    const local = buildLocalStore({ ...PAIRED, server_public_key: null });
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    expect(result).toMatchObject({ ok: false, stage: 'read_pair_context' });
    expect(token.wrapCalls()).toHaveLength(0);
  });

  it('localStore read throws → read_pair_context (the throw is tagged, never propagated)', async () => {
    const local = buildLocalStore(PAIRED, { failGet: new Error('idb-read-blew-up') });
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    expect(result).toMatchObject({ ok: false, stage: 'read_pair_context' });
    if (!result.ok) expect(result.error.message).toMatch(/idb-read-blew-up/);
    expect(token.wrapCalls()).toHaveLength(0);
  });

  it('wrap throws → wrap stage, no persist (old bearer intact)', async () => {
    const local = buildLocalStore(PAIRED);
    const token = buildTokenStore();
    token.failNextWrap(new Error('AES key unavailable'));

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    expect(result).toMatchObject({ ok: false, stage: 'wrap' });
    if (!result.ok) expect(result.error.message).toMatch(/AES key unavailable/);
    expect(local.setCalls()).toHaveLength(0);
    expect(local.current('webclient_token')).toEqual(OLD_TOKEN);
  });

  it('persist throws → persist stage (wrap completed first)', async () => {
    const local = buildLocalStore(PAIRED, { failSetOn: 'webclient_token' });
    const token = buildTokenStore();

    const result = await rewrapBearerForActivePair({
      localStore: local.store,
      tokenStore: token.store,
      token_id: 'tok-new',
      bearer: 'fresh',
    });

    expect(result).toMatchObject({ ok: false, stage: 'persist' });
    if (!result.ok) expect(result.error.message).toMatch(/idb-write-failed/);
    expect(token.wrapCalls()).toHaveLength(1); // wrap ran before the failed persist
  });
});
