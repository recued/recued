/** Phase D (D-106) — collection.mail.enrollOAuth handler (Commit 14).
 *
 *  Exercises the rpc handler that the extension calls after capturing
 *  an OAuth `code` from the provider redirect. Handler delegates to
 *  `exchangeCodeForTokens`; this test asserts input validation +
 *  success path + error translation.
 */

import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';
import {
  handleCollectionEnrollOAuth,
  type CollectionHandlerDeps,
} from '../collections/collection-handler.js';
import type {
  HttpFetcher,
  OAuthAccountStore,
  OAuthProvider,
  OAuthProviderConfig,
} from '../collections/mail/oauth.js';
import type { CollectionRegistry } from '../collections/registry.js';
import { createCollectionRegistry } from '../collections/registry.js';

const makeStore = (): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

const mkFetcher = (response: { status: number; body: unknown }): HttpFetcher =>
  async () => ({
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    async json() { return response.body; },
    async text() { return typeof response.body === 'string' ? response.body : JSON.stringify(response.body); },
  });

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth.example.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

interface Harness {
  deps: CollectionHandlerDeps;
  store: ReturnType<typeof makeStore>;
}

const newHarness = (opts: {
  fetcher?: HttpFetcher;
  config?: (p: OAuthProvider) => OAuthProviderConfig | null;
  registry?: CollectionRegistry;
} = {}): Harness => {
  const store = makeStore();
  const deps: CollectionHandlerDeps = {
    registry: opts.registry ?? createCollectionRegistry(),
    enrollOAuth: {
      accountStore: store,
      config: opts.config ?? (() => providerConfig),
      fetcher: opts.fetcher ?? mkFetcher({
        status: 200,
        body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      }),
    },
  };
  return { deps, store };
};

// ────────────────────────────────────────────────────────────────
// happy path
// ────────────────────────────────────────────────────────────────

describe('handleCollectionEnrollOAuth', () => {
  it('exchanges code and persists tokens for gmail', async () => {
    const h = newHarness();
    const result = await handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail',
      account_slug: 'work',
      code: 'CODE',
      redirect_uri: 'chrome-extension://abc',
    });
    expect(result).toEqual({ ok: true, account_key_prefix: 'gmail.work' });
    expect(h.store.data.get('gmail.work.refresh_token')).toBe('rt');
    expect(h.store.data.get('gmail.work.access_token')).toBe('at');
  });

  it('exchanges code and persists tokens for graph', async () => {
    const h = newHarness();
    const result = await handleCollectionEnrollOAuth(h.deps, {
      provider: 'graph',
      account_slug: 'personal',
      code: 'CODE2',
      redirect_uri: 'x',
    });
    expect(result.account_key_prefix).toBe('graph.personal');
    expect(h.store.data.get('graph.personal.refresh_token')).toBe('rt');
  });
});

// ────────────────────────────────────────────────────────────────
// validation
// ────────────────────────────────────────────────────────────────

describe('handleCollectionEnrollOAuth — validation', () => {
  it('rejects invalid provider', async () => {
    const h = newHarness();
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'yahoo',
      account_slug: 'work', code: 'c', redirect_uri: 'x',
    })).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing account_slug', async () => {
    const h = newHarness();
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', code: 'c', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects missing code', async () => {
    const h = newHarness();
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', account_slug: 'w', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects missing redirect_uri', async () => {
    const h = newHarness();
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', account_slug: 'w', code: 'c',
    })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns not_configured when enrollOAuth deps absent', async () => {
    const deps: CollectionHandlerDeps = { registry: createCollectionRegistry() };
    await expect(handleCollectionEnrollOAuth(deps, {
      provider: 'gmail', account_slug: 'w', code: 'c', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('returns not_configured when provider client id unset', async () => {
    const h = newHarness({ config: () => ({ tokenUrl: 'x', clientId: '' }) });
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', account_slug: 'w', code: 'c', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

// ────────────────────────────────────────────────────────────────
// upstream errors
// ────────────────────────────────────────────────────────────────

describe('handleCollectionEnrollOAuth — upstream errors', () => {
  it('translates token exchange failure to upstream_error', async () => {
    const h = newHarness({
      fetcher: mkFetcher({ status: 400, body: 'invalid_grant' }),
    });
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', account_slug: 'w', code: 'bad', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('translates missing_refresh_token to bad_request', async () => {
    const h = newHarness({
      fetcher: mkFetcher({ status: 200, body: { access_token: 'at', expires_in: 3600 } }),
    });
    await expect(handleCollectionEnrollOAuth(h.deps, {
      provider: 'gmail', account_slug: 'w', code: 'c', redirect_uri: 'x',
    })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
