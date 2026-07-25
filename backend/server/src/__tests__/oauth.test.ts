/** Phase D (D-106) — OAuth helpers (Commit 14).
 *
 *  Exercises the shared token exchange / refresh / getAccessToken
 *  helpers that Gmail + Graph providers depend on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exchangeCodeForTokens,
  getAccessToken,
  keyPrefix,
  OAuthError,
  refreshAccessToken,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfig,
} from '../collections/mail/oauth.js';

// ────────────────────────────────────────────────────────────────
// In-memory harness
// ────────────────────────────────────────────────────────────────

const makeStore = (): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

const makeFetcher = (
  response: { status: number; body: unknown },
  calls: FetchCall[] = [],
): HttpFetcher => async (url, init) => {
  calls.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ?? '',
  });
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    async json() { return response.body; },
    async text() { return typeof response.body === 'string' ? response.body : JSON.stringify(response.body); },
  };
};

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth.example.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

// ────────────────────────────────────────────────────────────────
// exchangeCodeForTokens
// ────────────────────────────────────────────────────────────────

describe('exchangeCodeForTokens', () => {
  it('persists access + refresh tokens + expires_at', async () => {
    const store = makeStore();
    const calls: FetchCall[] = [];
    const fetcher = makeFetcher(
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
      calls,
    );
    const now = () => 1_700_000_000_000;
    const out = await exchangeCodeForTokens({
      provider: 'gmail',
      slug: 'work',
      code: 'AUTHCODE',
      redirectUri: 'chrome-extension://abc/oauth',
      providerConfig,
      accountStore: store,
      fetcher,
      now,
    });
    expect(out.access_token).toBe('at');
    expect(out.expires_at).toBe(1_700_000_000_000 + 3600_000);
    expect(store.data.get('gmail.work.access_token')).toBe('at');
    expect(store.data.get('gmail.work.refresh_token')).toBe('rt');
    expect(store.data.get('gmail.work.expires_at')).toBe(String(1_700_000_000_000 + 3600_000));

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://oauth.example.com/token');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain('code=AUTHCODE');
    expect(calls[0].body).toContain('client_id=cid');
    expect(calls[0].body).toContain('client_secret=csecret');
    expect(calls[0].body).toContain('grant_type=authorization_code');
  });

  it('throws token_exchange_failed on non-2xx', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({ status: 400, body: { error: 'invalid_grant' } });
    await expect(exchangeCodeForTokens({
      provider: 'graph',
      slug: 'work',
      code: 'bad',
      redirectUri: 'x',
      providerConfig,
      accountStore: store,
      fetcher,
    })).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('throws missing_refresh_token when provider omits it', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({ status: 200, body: { access_token: 'at', expires_in: 3600 } });
    await expect(exchangeCodeForTokens({
      provider: 'gmail',
      slug: 'work',
      code: 'x',
      redirectUri: 'x',
      providerConfig,
      accountStore: store,
      fetcher,
    })).rejects.toMatchObject({ code: 'missing_refresh_token' });
  });

  it('throws invalid_response when access_token is missing', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({ status: 200, body: { expires_in: 3600 } });
    await expect(exchangeCodeForTokens({
      provider: 'gmail',
      slug: 'work',
      code: 'x',
      redirectUri: 'x',
      providerConfig,
      accountStore: store,
      fetcher,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

// ────────────────────────────────────────────────────────────────
// refreshAccessToken
// ────────────────────────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('uses stored refresh_token and updates access_token + expires_at', async () => {
    const store = makeStore();
    store.data.set('gmail.work.refresh_token', 'rt-existing');
    const calls: FetchCall[] = [];
    const fetcher = makeFetcher({ status: 200, body: { access_token: 'at2', expires_in: 3600 } }, calls);
    const out = await refreshAccessToken({
      provider: 'gmail', slug: 'work',
      providerConfig, accountStore: store, fetcher,
      now: () => 2_000_000_000_000,
    });
    expect(out.access_token).toBe('at2');
    expect(store.data.get('gmail.work.access_token')).toBe('at2');
    expect(store.data.get('gmail.work.expires_at')).toBe(String(2_000_000_000_000 + 3600_000));
    expect(calls[0].body).toContain('refresh_token=rt-existing');
    expect(calls[0].body).toContain('grant_type=refresh_token');
  });

  it('rotates refresh_token when provider returns a new one', async () => {
    const store = makeStore();
    store.data.set('gmail.work.refresh_token', 'rt1');
    const fetcher = makeFetcher({
      status: 200,
      body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 },
    });
    await refreshAccessToken({
      provider: 'gmail', slug: 'work', providerConfig, accountStore: store, fetcher,
    });
    expect(store.data.get('gmail.work.refresh_token')).toBe('rt2');
  });

  it('throws missing_refresh_token when none stored', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({ status: 200, body: {} });
    await expect(refreshAccessToken({
      provider: 'gmail', slug: 'work', providerConfig, accountStore: store, fetcher,
    })).rejects.toMatchObject({ code: 'missing_refresh_token' });
  });

  it('throws token_refresh_failed on 400', async () => {
    const store = makeStore();
    store.data.set('graph.work.refresh_token', 'rt');
    const fetcher = makeFetcher({ status: 400, body: 'invalid_grant' });
    await expect(refreshAccessToken({
      provider: 'graph', slug: 'work', providerConfig, accountStore: store, fetcher,
    })).rejects.toMatchObject({ code: 'token_refresh_failed' });
  });
});

// ────────────────────────────────────────────────────────────────
// getAccessToken — cache + refresh
// ────────────────────────────────────────────────────────────────

describe('getAccessToken', () => {
  it('returns cached token when not near expiry', async () => {
    const store = makeStore();
    const nowMs = 1_700_000_000_000;
    store.data.set('gmail.work.access_token', 'cached-at');
    store.data.set('gmail.work.expires_at', String(nowMs + 3600_000));
    store.data.set('gmail.work.refresh_token', 'rt');
    const fetcher: HttpFetcher = async () => { throw new Error('unreachable'); };
    const token = await getAccessToken({
      provider: 'gmail', slug: 'work', providerConfig, accountStore: store,
      fetcher, now: () => nowMs,
    });
    expect(token).toBe('cached-at');
  });

  it('refreshes when expires_at within skew window', async () => {
    const store = makeStore();
    const nowMs = 1_700_000_000_000;
    store.data.set('gmail.work.access_token', 'old-at');
    store.data.set('gmail.work.expires_at', String(nowMs + 1000)); // inside skew
    store.data.set('gmail.work.refresh_token', 'rt');
    const fetcher = makeFetcher({ status: 200, body: { access_token: 'new-at', expires_in: 3600 } });
    const token = await getAccessToken({
      provider: 'gmail', slug: 'work', providerConfig, accountStore: store,
      fetcher, now: () => nowMs,
    });
    expect(token).toBe('new-at');
    expect(store.data.get('gmail.work.access_token')).toBe('new-at');
  });

  it('forces a refresh when force=true', async () => {
    const store = makeStore();
    store.data.set('gmail.work.access_token', 'cached-at');
    store.data.set('gmail.work.expires_at', String(Date.now() + 3600_000));
    store.data.set('gmail.work.refresh_token', 'rt');
    const fetcher = makeFetcher({ status: 200, body: { access_token: 'fresh', expires_in: 3600 } });
    const token = await getAccessToken({
      provider: 'gmail', slug: 'work', providerConfig, accountStore: store,
      fetcher, force: true,
    });
    expect(token).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// keyPrefix
// ────────────────────────────────────────────────────────────────

describe('keyPrefix', () => {
  it('produces provider.slug concatenation', () => {
    expect(keyPrefix('gmail', 'work')).toBe('gmail.work');
    expect(keyPrefix('graph', 'personal')).toBe('graph.personal');
  });
});
