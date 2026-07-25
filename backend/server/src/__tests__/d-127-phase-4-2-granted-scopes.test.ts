/** D-127 P4.2 — granted-scope plumbing tests.
 *
 *  Pins the spec § A.7.2 boundary: post-OAuth scope verification
 *  reads the granted scope set (from the token endpoint's `scope`
 *  field) and surfaces it via `getGrantedScopes`. The provider's
 *  `sendCapable` consults the granted set, not the requested one,
 *  so a partial grant (user untickets send on the consent screen)
 *  gracefully degrades to read-only.
 *
 *  Coverage:
 *    - `parseGrantedScopes` — RFC 6749 space-separated input,
 *      defensive on commas / whitespace / empty / undefined.
 *    - `exchangeCodeForTokens` — persists `scope` to the account
 *      store + surfaces parsed array on the response.
 *    - `refreshAccessToken` — re-persists `scope` on every refresh
 *      so a downgrade lands without a re-enrollment; preserves the
 *      stored value when the provider omits `scope`.
 *    - `getGrantedScopes` — reads back the persisted value.
 *    - Partial-grant degradation — gmail-provider's sendCapable
 *      stays false when the granted set lacks `gmail.send` despite
 *      the request including it; same for graph. */

import { describe, expect, it } from 'vitest';
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  getGrantedScopes,
  parseGrantedScopes,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfig,
} from '../collections/mail/oauth.js';
import { createGmailProvider, GMAIL_SEND_SCOPE } from '../collections/mail/gmail-provider.js';
import { createGraphProvider, GRAPH_SEND_SCOPE } from '../collections/mail/graph-provider.js';

// ────────────────────────────────────────────────────────────────
// Harness
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

const makeFetcher = (
  response: { status: number; body: unknown },
): HttpFetcher => async () => ({
  status: response.status,
  ok: response.status >= 200 && response.status < 300,
  async json() { return response.body; },
  async text() {
    return typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  },
});

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth.example.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

// ────────────────────────────────────────────────────────────────
// parseGrantedScopes
// ────────────────────────────────────────────────────────────────

describe('parseGrantedScopes', () => {
  it('splits a single space-separated RFC 6749 scope string', () => {
    expect(parseGrantedScopes(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    )).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });

  it('handles comma-separated input defensively (some providers slip in commas)', () => {
    expect(parseGrantedScopes('Mail.Read,Mail.Send,offline_access')).toEqual([
      'Mail.Read', 'Mail.Send', 'offline_access',
    ]);
  });

  it('dedupes repeated scopes', () => {
    expect(parseGrantedScopes('Mail.Read offline_access Mail.Read')).toEqual([
      'Mail.Read', 'offline_access',
    ]);
  });

  it('returns [] for empty / undefined / whitespace', () => {
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes('')).toEqual([]);
    expect(parseGrantedScopes('   ')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// exchangeCodeForTokens — scope persistence
// ────────────────────────────────────────────────────────────────

describe('exchangeCodeForTokens — granted_scopes', () => {
  it('persists the raw scope string + surfaces parsed array on response', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({
      status: 200,
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
      },
    });
    const out = await exchangeCodeForTokens({
      provider: 'gmail',
      slug: 'work',
      code: 'AUTHCODE',
      redirectUri: 'chrome-extension://abc/oauth',
      providerConfig,
      accountStore: store,
      fetcher,
    });
    expect(out.granted_scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    expect(store.data.get('gmail.work.granted_scopes')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    );
  });

  it('persists empty string when provider omits scope so read path returns [] not "key missing"', async () => {
    const store = makeStore();
    const fetcher = makeFetcher({
      status: 200,
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
    });
    const out = await exchangeCodeForTokens({
      provider: 'graph',
      slug: 'work',
      code: 'x',
      redirectUri: 'x',
      providerConfig,
      accountStore: store,
      fetcher,
    });
    expect(out.granted_scopes).toEqual([]);
    expect(store.data.get('graph.work.granted_scopes')).toBe('');
  });

  it('captures partial-grant scope set (user unticked send on consent)', async () => {
    // Form requested gmail.send + readonly + profile; user only granted
    // readonly + profile. The persisted set reflects what was granted,
    // not what was requested.
    const store = makeStore();
    const fetcher = makeFetcher({
      status: 200,
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
      },
    });
    const out = await exchangeCodeForTokens({
      provider: 'gmail',
      slug: 'work',
      code: 'x',
      redirectUri: 'x',
      providerConfig,
      accountStore: store,
      fetcher,
    });
    expect(out.granted_scopes).not.toContain(GMAIL_SEND_SCOPE);
    expect(out.granted_scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});

// ────────────────────────────────────────────────────────────────
// refreshAccessToken — scope re-persistence + downgrade detection
// ────────────────────────────────────────────────────────────────

describe('refreshAccessToken — granted_scopes', () => {
  it('re-persists scope on refresh so downgrades land without re-enrollment', async () => {
    const store = makeStore();
    store.data.set('gmail.work.refresh_token', 'rt');
    store.data.set(
      'gmail.work.granted_scopes',
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    );
    // Provider downgrades on refresh (user revoked send in account settings).
    const fetcher = makeFetcher({
      status: 200,
      body: {
        access_token: 'at2',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      },
    });
    const out = await refreshAccessToken({
      provider: 'gmail',
      slug: 'work',
      providerConfig,
      accountStore: store,
      fetcher,
    });
    expect(out.granted_scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(store.data.get('gmail.work.granted_scopes')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
  });

  it('preserves stored scope when provider omits scope on refresh (defensive — Gmail + Graph echo, OIDC providers may not)', async () => {
    const store = makeStore();
    store.data.set('graph.work.refresh_token', 'rt');
    store.data.set('graph.work.granted_scopes', 'Mail.Read Mail.Send offline_access');
    const fetcher = makeFetcher({
      status: 200,
      body: { access_token: 'at2', expires_in: 3600 /* scope omitted */ },
    });
    const out = await refreshAccessToken({
      provider: 'graph',
      slug: 'work',
      providerConfig,
      accountStore: store,
      fetcher,
    });
    // Stored value preserved — refresh did not overwrite with empty.
    expect(store.data.get('graph.work.granted_scopes')).toBe('Mail.Read Mail.Send offline_access');
    // Surfaced array reflects the preserved value, not [] from a
    // missing scope field.
    expect(out.granted_scopes).toContain('Mail.Send');
  });
});

// ────────────────────────────────────────────────────────────────
// getGrantedScopes
// ────────────────────────────────────────────────────────────────

describe('getGrantedScopes', () => {
  it('reads back the persisted scope set', async () => {
    const store = makeStore();
    store.data.set('gmail.work.granted_scopes', 'a b c');
    expect(await getGrantedScopes(store, 'gmail', 'work')).toEqual(['a', 'b', 'c']);
  });

  it('returns [] when nothing stored', async () => {
    const store = makeStore();
    expect(await getGrantedScopes(store, 'graph', 'never-enrolled')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Partial-grant degradation — provider sendCapable
// ────────────────────────────────────────────────────────────────

describe('Partial-grant degradation — gmail provider', () => {
  it('sendCapable=true when granted set contains GMAIL_SEND_SCOPE', () => {
    const provider = createGmailProvider({
      slug: 'work',
      config: () => ({
        account_slug: 'work',
        backfill_days: 7,
        poll_seconds: 30,
        granted_scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          GMAIL_SEND_SCOPE,
        ],
      }),
      accountStore: makeStore(),
      providerConfig,
    });
    expect(provider.sendCapable).toBe(true);
    expect(typeof provider.send).toBe('function');
  });

  it('sendCapable=false when send was REQUESTED but NOT in granted set (partial grant)', () => {
    // Form requested send but user unticked it. The provider sees
    // only what was granted — `granted_scopes` here mirrors what
    // `parseGrantedScopes` returned from the token-exchange response.
    const provider = createGmailProvider({
      slug: 'work',
      config: () => ({
        account_slug: 'work',
        backfill_days: 7,
        poll_seconds: 30,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }),
      accountStore: makeStore(),
      providerConfig,
    });
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
  });

  it('sendCapable=false when granted_scopes is undefined (read-only enrollment)', () => {
    const provider = createGmailProvider({
      slug: 'work',
      config: () => ({
        account_slug: 'work',
        backfill_days: 7,
        poll_seconds: 30,
      }),
      accountStore: makeStore(),
      providerConfig,
    });
    expect(provider.sendCapable).toBe(false);
  });
});

describe('Partial-grant degradation — graph provider', () => {
  it('sendCapable=true when granted set contains GRAPH_SEND_SCOPE', () => {
    const provider = createGraphProvider({
      slug: 'work',
      config: () => ({
        account_slug: 'work',
        backfill_days: 7,
        poll_seconds: 30,
        folders: ['Inbox'],
        granted_scopes: ['Mail.Read', 'offline_access', GRAPH_SEND_SCOPE],
      }),
      accountStore: makeStore(),
      providerConfig,
    });
    expect(provider.sendCapable).toBe(true);
    expect(typeof provider.send).toBe('function');
  });

  it('sendCapable=false on partial grant (Mail.Send requested but not granted)', () => {
    const provider = createGraphProvider({
      slug: 'work',
      config: () => ({
        account_slug: 'work',
        backfill_days: 7,
        poll_seconds: 30,
        folders: ['Inbox'],
        granted_scopes: ['Mail.Read', 'offline_access'],
      }),
      accountStore: makeStore(),
      providerConfig,
    });
    expect(provider.sendCapable).toBe(false);
    expect(provider.send).toBeUndefined();
  });
});
