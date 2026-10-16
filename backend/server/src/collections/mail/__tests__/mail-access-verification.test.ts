import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmailProvider } from '../gmail-provider.js';
import { createGraphProvider } from '../graph-provider.js';
import type { HttpFetcher, OAuthAccountStore } from '../oauth.js';
import type { MailProvider } from '../provider.js';

const providers: MailProvider[] = [];
afterEach(async () => { for (const provider of providers.splice(0)) await provider.close(); });

const response = (body: unknown, status = 200): Awaited<ReturnType<HttpFetcher>> => ({
  ok: status === 200, status,
  async json() { return body; }, async text() { return JSON.stringify(body); },
});

const setup = (kind: 'gmail' | 'graph', fetcher: HttpFetcher) => {
  const data = new Map([
    [`${kind}.work.access_token`, 'fixture-access'],
    [`${kind}.work.expires_at`, String(Date.now() + 3_600_000)],
  ]);
  const accountStore: OAuthAccountStore = {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); }, async delete(key) { data.delete(key); },
  };
  const common = { slug: 'work', accountStore, fetcher,
    providerConfig: { clientId: 'fixture', clientSecret: 'fixture', tokenUrl: 'https://fixture.example/token' },
  };
  const provider = kind === 'gmail'
    ? createGmailProvider({ ...common, config: () => ({ account_slug: 'work', backfill_days: 30, poll_seconds: 30 }) })
    : createGraphProvider({ ...common, config: () => ({ account_slug: 'work', backfill_days: 30, poll_seconds: 30, folder_filter: ['inbox'] }) });
  providers.push(provider);
  return provider;
};

describe.each(['gmail', 'graph'] as const)('%s mailbox access evidence', (kind) => {
  it('verifies an empty first page before a later page finishes, without importing any email', async () => {
    let release!: () => void;
    let secondPage!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { secondPage = resolve; });
    const provider = setup(kind, async (url) => {
      if (url.endsWith('/profile')) return response({ historyId: '100' });
      if (new URL(url).pathname.endsWith('/delta')) return response({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=fixture' });
      if (new URL(url).searchParams.has('pageToken')) {
        secondPage(); await pending;
        return response(kind === 'gmail' ? { messages: [] } : { value: [] });
      }
      return response(kind === 'gmail'
        ? { messages: [], nextPageToken: 'next' }
        : { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?pageToken=next' });
    });
    const verified = vi.fn(); const onMessage = vi.fn(async () => true);
    await provider.connect();
    const scanning = provider.initialScan({ backfill_days: 30, onAccessVerified: verified, onMessage });
    try {
      await requested;
      expect(verified).toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    } finally { release(); await scanning; }
    expect(verified.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not use token or profile success as mailbox access proof when the mailbox read is refused', async () => {
    const provider = setup(kind, async (url) => url.endsWith('/profile')
      ? response({ historyId: '100' })
      : response({ error: { code: 'ErrorAccessDenied', errors: [{ reason: 'insufficientPermissions' }] } }, 403));
    const verified = vi.fn();
    await provider.connect();
    await expect(provider.initialScan({ backfill_days: 30, onAccessVerified: verified, onMessage: async () => true })).rejects.toThrow();
    expect(verified).not.toHaveBeenCalled();
  });

  it('does not verify a malformed message list', async () => {
    const provider = setup(kind, async (url) => url.endsWith('/profile')
      ? response({ historyId: '100' })
      : response(kind === 'gmail' ? { messages: 'invalid' } : { value: 'invalid' }));
    const verified = vi.fn();
    await provider.connect();
    await expect(provider.initialScan({ backfill_days: 30, onAccessVerified: verified, onMessage: async () => true })).rejects.toThrow();
    expect(verified).not.toHaveBeenCalled();
  });
});

it('verifies Graph access while its initial delta baseline is still paging', async () => {
  let release!: () => void; let requested!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { requested = resolve; });
  const provider = setup('graph', async (url) => {
    if (url.includes('pageToken=next')) {
      requested(); await pending;
      return response({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=fixture' });
    }
    if (new URL(url).pathname.endsWith('/delta')) return response({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?pageToken=next' });
    return response({ value: [] });
  });
  const verified = vi.fn();
  await provider.connect();
  const scanning = provider.initialScan({ backfill_days: 30, onAccessVerified: verified, onMessage: async () => true });
  try { await waiting; expect(verified).toHaveBeenCalledOnce(); }
  finally { release(); await scanning; }
});
