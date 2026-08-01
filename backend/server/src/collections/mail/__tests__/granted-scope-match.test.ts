import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createInstanceStore } from '../../instance-store.js';
import { handleMailEnrollOAuth, type MailEnrollDeps } from '../enroll.js';
import {
  createGmailProvider,
  type GmailProviderConfig,
} from '../gmail-provider.js';
import {
  createGraphProvider,
  type GraphProviderConfig,
} from '../graph-provider.js';
import {
  grantedScopesInclude,
  type HttpFetcher,
  type OAuthAccountStore,
  type OAuthProviderConfig,
} from '../oauth.js';
import type { MailProvider } from '../provider.js';

const GRAPH_SEND_SCOPE = 'Mail.Send';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const makeStore = (): OAuthAccountStore => {
  const data = new Map<string, string>();
  return {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
};

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth.example.test/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const unusedFetcher: HttpFetcher = async () => ({
  status: 200,
  ok: true,
  async json() { return {}; },
  async text() { return ''; },
});

const graphProvider = (grantedScopes: string[]): MailProvider => {
  const config: GraphProviderConfig = {
    account_slug: 'work',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: grantedScopes,
  };
  return createGraphProvider({
    slug: 'work',
    config: () => config,
    accountStore: makeStore(),
    providerConfig,
    fetcher: unusedFetcher,
    scheduler: () => () => undefined,
  });
};

const gmailProvider = (grantedScopes: string[]): MailProvider => {
  const config: GmailProviderConfig = {
    account_slug: 'work',
    backfill_days: 7,
    poll_seconds: 30,
    granted_scopes: grantedScopes,
  };
  return createGmailProvider({
    slug: 'work',
    config: () => config,
    accountStore: makeStore(),
    providerConfig,
    fetcher: unusedFetcher,
    scheduler: () => () => undefined,
  });
};

const expectSendState = (provider: MailProvider, capable: boolean): void => {
  expect(provider.sendCapable).toBe(capable);
  if (capable) {
    expect(provider.send).toBeDefined();
  } else {
    expect(provider.send).toBeUndefined();
  }
};

describe('grantedScopesInclude', () => {
  it('matches an exact scope', () => {
    expect(grantedScopesInclude(['Mail.Send'], 'Mail.Send')).toBe(true);
  });

  it('matches a resource-qualified grant against a short wanted scope', () => {
    expect(grantedScopesInclude(
      ['https://graph.microsoft.com/Mail.Send'],
      'Mail.Send',
    )).toBe(true);
  });

  it('matches a short grant against a resource-qualified wanted scope', () => {
    expect(grantedScopesInclude(
      ['Mail.Send'],
      'https://graph.microsoft.com/Mail.Send',
    )).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(grantedScopesInclude(['mail.send'], 'Mail.Send')).toBe(true);
    expect(grantedScopesInclude(['MAIL.SEND'], 'Mail.Send')).toBe(true);
  });

  it('tolerates surrounding whitespace on a granted scope', () => {
    expect(grantedScopesInclude(['  Mail.Send\t'], 'Mail.Send')).toBe(true);
  });

  it('returns false when the scope is absent', () => {
    expect(grantedScopesInclude(
      ['Mail.Read', 'offline_access'],
      'Mail.Send',
    )).toBe(false);
  });

  it('does not use substring matching', () => {
    expect(grantedScopesInclude(['Mail.ReadWrite'], 'Mail.Read')).toBe(false);
    expect(grantedScopesInclude(['NotMail.Send'], 'Mail.Send')).toBe(false);
  });

  it('matches Google full URIs without conflating distinct scopes', () => {
    expect(grantedScopesInclude([GMAIL_SEND_SCOPE], GMAIL_SEND_SCOPE)).toBe(true);
    expect(grantedScopesInclude(
      [GMAIL_SEND_SCOPE],
      'https://www.googleapis.com/auth/gmail.readonly',
    )).toBe(false);
  });

  it('returns false for an empty wanted scope or empty granted list', () => {
    expect(grantedScopesInclude(['Mail.Send'], '')).toBe(false);
    expect(grantedScopesInclude([], 'Mail.Send')).toBe(false);
  });
});

describe('provider send-capability wiring', () => {
  it('enables Graph send for a resource-qualified Mail.Send grant', () => {
    expectSendState(
      graphProvider(['https://graph.microsoft.com/Mail.Send']),
      true,
    );
  });

  it('keeps Graph send unavailable without Mail.Send', () => {
    expectSendState(graphProvider(['Mail.Read']), false);
  });

  it('enables Gmail send for the full gmail.send URI', () => {
    expectSendState(gmailProvider([GMAIL_SEND_SCOPE]), true);
  });

  it('enables Gmail send for a lowercased gmail.send URI', () => {
    expectSendState(gmailProvider([GMAIL_SEND_SCOPE.toLowerCase()]), true);
  });
});

const enrollWithScopes = async (
  adapter: 'gmail' | 'graph',
  scope: string,
): Promise<{ send_capable: boolean }> => {
  const db = new Database(':memory:');
  const fetcher: HttpFetcher = async (url) => {
    if (url === providerConfig.tokenUrl) {
      const body = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope,
      };
      return {
        status: 200,
        ok: true,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
      };
    }
    const body = adapter === 'graph'
      ? { id: 'graph-user-id', userPrincipalName: 'me@example.com' }
      : { emailAddress: 'me@gmail.com' };
    return {
      status: 200,
      ok: true,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
  const deps: MailEnrollDeps = {
    instances: createInstanceStore({ db }),
    accountStore: makeStore(),
    oauthConfig: () => providerConfig,
    fetcher,
    now: () => 1_000,
  };

  try {
    return await handleMailEnrollOAuth(deps, {
      adapter,
      account_slug: `work-${adapter}`,
      code: 'authorization-code',
      redirect_uri: 'https://app.example.test/oauth/callback',
    });
  } finally {
    db.close();
  }
};

describe('handleMailEnrollOAuth send_capable', () => {
  it('reports true for a resource-qualified Microsoft Mail.Send scope', async () => {
    const result = await enrollWithScopes(
      'graph',
      'https://graph.microsoft.com/Mail.Read '
        + 'https://graph.microsoft.com/Mail.Send',
    );
    expect(result.send_capable).toBe(true);
  });

  it('reports false when the Microsoft Mail.Send scope is absent', async () => {
    const result = await enrollWithScopes(
      'graph',
      'https://graph.microsoft.com/Mail.Read',
    );
    expect(result.send_capable).toBe(false);
  });

  it('reports true for the full Gmail send scope', async () => {
    const result = await enrollWithScopes('gmail', GMAIL_SEND_SCOPE);
    expect(result.send_capable).toBe(true);
  });
});
