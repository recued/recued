import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOAuthAppConfigStore } from '../../oauth-app-config-store.js';
import { createInstanceStore } from '../instance-store.js';
import { handleMailEnrollOAuth } from '../mail/enroll.js';
import { handleCalendarEnrollOAuth, handleCalendarAttachGraphGrant } from '../calendar/enroll.js';
import { createCalendarAdapterRegistry } from '../calendar/adapter-registry.js';
import { createGcalAdapterFactory } from '../calendar/gcal-provider.js';
import { createGraphCalAdapterFactory } from '../calendar/graph-provider.js';
import type { HttpFetcher, OAuthProvider, OAuthProviderConfig } from '../mail/oauth.js';
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db);
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: () => Buffer.alloc(32, 7) });
  apps.setIssuer('google', 'primary-google', 'fixture-primary'); apps.setIssuer('microsoft', 'primary-entra', 'fixture-primary');
  const google = apps.saveApp({ issuer: 'google', label: 'Google work', client_id: 'google-work', client_secret: 'fixture-google-work' });
  const microsoft = apps.saveApp({ issuer: 'microsoft', label: 'Microsoft work', client_id: 'entra-work', client_secret: 'fixture-entra-work' });
  const values = new Map<string, string>(); const account = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const fetcher = vi.fn<HttpFetcher>(async (url, init) => ({ status: 200, ok: true, text: async () => '', json: async () =>
    init?.method === 'POST' ? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600,
      scope: 'Mail.Read Calendars.ReadWrite User.Read' } : url.includes('/me/profile') ? { emailAddress: 'owner@example.test' }
        : url.endsWith('/me') ? { id: 'owner-id', userPrincipalName: 'owner@example.test' } : { items: [], value: [] } }));
  const resolve = vi.fn((provider: OAuthProvider, id?: string): OAuthProviderConfig | null => {
    const issuer = provider === 'graph' ? 'microsoft' : 'google'; const clientId = apps.getClientId(issuer, id);
    return clientId ? { clientId, clientSecret: apps.getClientSecret(issuer, id)!, tokenUrl: provider === 'graph'
      ? 'https://login.microsoftonline.com/common/oauth2/v2.0/token' : 'https://oauth2.googleapis.com/token' } : null;
  });
  const instances = createInstanceStore({ db }); const adapters = createCalendarAdapterRegistry();
  const gcal = createGcalAdapterFactory({ accountStore: account, providerConfig: id => resolve('gcal', id), fetcher, now: () => 1000 });
  const graph = createGraphCalAdapterFactory({ accountStore: account, providerConfig: id => resolve('graph', id), fetcher, now: () => 1000 });
  adapters.register(gcal); adapters.register(graph);
  const mail = { instances, accountStore: account, oauthConfig: resolve, fetcher, now: () => 1000 };
  const calendar = { ...mail, adapters };
  return { apps, google, microsoft, values, account, fetcher, resolve, instances, mail, calendar, gcal, graph };
};
describe('named app enrollment and refresh', () => {
  it.each(['gmail', 'graph'] as const)('exchanges %s with the selected app and persists its profile reference', async adapter => {
    const f = fixture(); const app = adapter === 'gmail' ? f.google : f.microsoft;
    await handleMailEnrollOAuth(f.mail, { adapter, account_slug: 'work', code: 'fixture-code', redirect_uri: 'https://app.example.test/callback',
      oauth_app_id: app.id, oauth_client_id: app.client_id });
    const body = new URLSearchParams(f.fetcher.mock.calls[0]![1]!.body);
    expect(body.get('client_id')).toBe(app.client_id); expect(body.get('client_secret')).toBe(adapter === 'gmail' ? 'fixture-google-work' : 'fixture-entra-work');
    expect(f.instances.get('mail', 'work')!.config.oauth_app_id).toBe(app.id);
  });
  it('pins Google Calendar renewal to its app after a default change, and picks up that app secret rotation', async () => {
    const f = fixture(); await handleCalendarEnrollOAuth(f.calendar, { adapter: 'gcal', slug: 'work', oauth_code: 'fixture-code',
      oauth_redirect_uri: 'https://app.example.test/callback', oauth_app_id: f.google.id, oauth_client_id: f.google.client_id });
    const row = f.instances.get('calendar', 'work')!;
    f.apps.setIssuer('google', 'different-primary', 'fixture-different-primary');
    f.apps.saveApp({ issuer: 'google', id: f.google.id, expected_revision: f.google.revision, label: f.google.label,
      client_id: f.google.client_id, client_secret: 'fixture-rotated-work' });
    f.values.set('gcal.work.expires_at', '0'); f.fetcher.mockClear();
    await f.gcal.probeCaps({ slug: 'work', config: row.config, getAccountValue: key => f.account.get('gcal.work.' + key) });
    const renewal = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const body = new URLSearchParams(renewal[1]!.body);
    expect(body.get('grant_type')).toBe('refresh_token'); expect(body.get('client_id')).toBe('google-work'); expect(body.get('client_secret')).toBe('fixture-rotated-work');
  });
  it('attaches Microsoft Calendar to the same named app and refuses another app before exchanging mail credentials', async () => {
    const f = fixture(); await handleMailEnrollOAuth(f.mail, { adapter: 'graph', account_slug: 'work', code: 'fixture-code',
      redirect_uri: 'https://app.example.test/callback', oauth_app_id: f.microsoft.id, oauth_client_id: f.microsoft.client_id });
    await handleCalendarAttachGraphGrant(f.calendar, { slug: 'work' });
    expect(f.instances.get('calendar', 'work')!.config.oauth_app_id).toBe(f.microsoft.id);
    f.instances.delete('mail', 'work'); f.fetcher.mockClear(); const before = new Map(f.values);
    await expect(handleMailEnrollOAuth(f.mail, { adapter: 'graph', account_slug: 'work', code: 'fixture-another-code',
      redirect_uri: 'https://app.example.test/callback' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values).toEqual(before);
  });
  it('rejects a changed client or removed app before accepting enrollment credentials', async () => {
    const f = fixture(); await expect(handleMailEnrollOAuth(f.mail, { adapter: 'gmail', account_slug: 'work', code: 'fixture-code',
      redirect_uri: 'https://app.example.test/callback', oauth_app_id: f.google.id, oauth_client_id: 'old-client' })).rejects.toMatchObject({ code: 'conflict' });
    f.apps.deleteApp('google', f.google.id, f.google.revision);
    await expect(handleCalendarEnrollOAuth(f.calendar, { adapter: 'gcal', slug: 'work', oauth_code: 'fixture-code',
      oauth_redirect_uri: 'https://app.example.test/callback', oauth_app_id: f.google.id })).rejects.toMatchObject({ code: 'not_configured' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
});
