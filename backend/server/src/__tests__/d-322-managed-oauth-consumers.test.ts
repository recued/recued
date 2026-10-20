/** D-322: native consumers, encrypted credentials, policy and account lifetime. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedLocalRpc, type ConnectionAuth, type ConnectionRow, type ManagedOAuthAuth } from '@recued/contracts';
import { DEFAULT_RESPONSE_BODY_MAX_BYTES } from '@recued/ingredients';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthConsumers } from '../managed-oauth-consumers.js';
import { createFileSourceConnectionResolver } from '../file-source-connection-resolver.js';
import { handleMailEnrollManagedOAuth, handleMailDelete, handleMailList } from '../collections/mail/enroll.js';
import { handleCalendarEnrollManagedOAuth, handleCalendarDelete, handleCalendarList,
  handleCalendarAttachGraphGrant } from '../collections/calendar/enroll.js';
import { createCalendarAdapterRegistry } from '../collections/calendar/adapter-registry.js';
import { createGcalAdapterFactory } from '../collections/calendar/gcal-provider.js';
import { createGraphCalAdapterFactory } from '../collections/calendar/graph-provider.js';
import { createGmailProvider } from '../collections/mail/gmail-provider.js';
import { createGraphProvider } from '../collections/mail/graph-provider.js';
import { handleCalendarCreate } from '../collections/calendar/calendar-dispatcher.js';
import type { OAuthAccountStore } from '../collections/mail/oauth.js';
import type { CalendarCollection } from '../collections/calendar/calendar-collection.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const source = {
  gmail: { base: 'https://gmail.googleapis.com/gmail/v1', origin: 'https://gmail.googleapis.com' },
  gcal: { base: 'https://www.googleapis.com/calendar/v3', origin: 'https://www.googleapis.com' },
  graph: { base: 'https://graph.microsoft.com/v1.0', origin: 'https://graph.microsoft.com' },
  google: { base: 'https://www.googleapis.com/drive/v3', origin: 'https://www.googleapis.com' },
  dropbox: { base: 'https://api.dropboxapi.com/2', origin: 'https://api.dropboxapi.com' },
};

const setup = async (provider: keyof typeof source = 'gmail') => {
  const db = new Database(':memory:'); dbs.push(db);
  let locked = false;
  const key = () => locked ? null : new Uint8Array(32).fill(9);
  const connections = createConnectionStore(db), instances = createInstanceStore({ db });
  const accountData = new Map<string, string>();
  const account: OAuthAccountStore = { get: vi.fn(async k => accountData.get(k) ?? null),
    set: vi.fn(async (k, v) => { accountData.set(k, v); }), delete: vi.fn(async k => { accountData.delete(k); }),
    getAll: async () => Object.fromEntries(accountData) };
  const directConfig = vi.fn((): never => { throw new Error('Direct OAuth must not be used'); });
  const directFetch = vi.fn(async (): Promise<never> => { throw new Error('Direct HTTP must not be used'); });
  const proxy = vi.fn(async (_path: string, _init: RequestInit): Promise<Response> => Response.json({}));
  const brokerFetch = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/integrations') return Response.json({ data: [] });
    if (!path.startsWith('/proxy/')) throw new Error('Consumer unexpectedly started OAuth');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-environment-key');
    expect(new Headers(init?.headers).get('retries')).toBe('0');
    expect(new Headers(init?.headers).get('nango-proxy-authorization')).toBeNull();
    return proxy(path.slice('/proxy'.length), init ?? {});
  });
  const decode = (row: ConnectionRow) => decodeAuthFromStorage(row.auth_ciphertext, row, key);
  const profiles = createManagedOAuthProfileStore(db, key);
  const broker = createManagedOAuthService({ profiles, listConnections: () => connections.list(), decodeAuth: decode,
    fetchImpl: brokerFetch });
  const saved = await broker.handle({ action: 'save_profile', broker: 'nango', label: 'Fixture',
    base_url: 'https://api.nango.dev', api_key: 'fixture-environment-key' });
  if (saved.action !== 'save_profile') throw new Error('profile fixture');
  const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: saved.profile.id,
    integration_id: 'fixture-integration', connection_id: 'fixture-account', target_origin: source[provider].origin,
    requested_scopes: ['requested-only-is-not-a-grant'], imported: true };
  const put = async (newAuth: ConnectionAuth = auth, base = source[provider].base) => connections.upsert({
    kind: 'api', name: 'source', display_name: 'Managed account', config_json: JSON.stringify({ base_url: base }),
    auth_ciphertext: await encodeAuthForStorage(newAuth, { kind: 'api', name: 'source' }, key),
    enrolled_at: 1, updated_at: 1,
  });
  await put();
  const consumers = createManagedOAuthConsumers({ connections, instances, decodeAuth: decode, broker });
  const adapters = createCalendarAdapterRegistry();
  adapters.register(createGcalAdapterFactory({ accountStore: account, providerConfig: directConfig,
    fetcher: directFetch, managedOAuth: consumers }));
  adapters.register(createGraphCalAdapterFactory({ accountStore: account, providerConfig: directConfig,
    fetcher: directFetch, managedOAuth: consumers }));
  const mail = { instances, accountStore: account, managedOAuth: consumers, oauthConfig: directConfig, fetcher: directFetch };
  const calendar = { ...mail, adapters };
  const handlers = makeConnectionHandlers({ store: connections, getEncryptionKey: key, managedOAuth: broker,
    assertCollectionUnreferenced: consumers.assertUnreferenced })!.handlers;
  return { auth, put, connections, instances, account, accountData, consumers, mail, calendar, proxy, brokerFetch,
    directConfig, directFetch, lock: () => { locked = true; }, handlers,
    fileResolve: createFileSourceConnectionResolver({ connectionStore: connections, decodeAuthFromStorage,
      encodeAuthForStorage, keyProvider: key, managedOAuth: broker, fetchImpl: directFetch }) };
};

describe('managed foundational accounts', () => {
  it('keeps managed account activation in the owner control plane', () => {
    expect(isReservedLocalRpc('collection.mail.enrollManagedOAuth')).toBe(true);
    expect(isReservedLocalRpc('collection.calendar.enrollManagedOAuth')).toBe(true);
  });
  it('retains the native provider response ceiling on the broker path', async () => {
    const f = await setup(); let canceled = false;
    f.proxy.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(DEFAULT_RESPONSE_BODY_MAX_BYTES + 1)); },
      cancel() { canceled = true; },
    })));
    const transport = await f.consumers.resolve('gmail', 'source');
    await expect(transport.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile'))
      .rejects.toThrow();
    expect(canceled).toBe(true); expect(f.proxy).toHaveBeenCalledOnce();
  });
  it.each(['gmail', 'graph'] as const)('enrolls %s with verified native identity, unknown grants and no local tokens', async provider => {
    const f = await setup(provider);
    f.proxy.mockImplementation(async () => Response.json(provider === 'gmail'
      ? { emailAddress: 'owner@example.test' } : { id: 'native-account', mail: null, userPrincipalName: 'owner@example.test' }));
    const result = await handleMailEnrollManagedOAuth(f.mail, { provider, account_slug: 'work', connection_name: 'source', backfill_days: 400 });
    expect(result).toEqual({ slug: 'work', account_email: 'owner@example.test', permission_state: 'unknown' });
    const row = f.instances.get('mail', 'work')!;
    expect(row.config).toMatchObject({ account_slug: 'managed-mail:work', managed_oauth: { connection_name: 'source' },
      managed_send_enabled: false, managed_mutation_enabled: false, backfill_days: 400 });
    expect(f.accountData.size).toBe(0);
    expect(f.connections.get('api', 'source')!.granted_scopes_json ?? null).toBeNull();
    expect(JSON.stringify(row.config)).not.toContain('fixture-environment-key');
    expect(f.directConfig).not.toHaveBeenCalled(); expect(f.directFetch).not.toHaveBeenCalled();
    expect(await handleMailList(f.mail)).toMatchObject({ instances: [{ managed_connection_name: 'source', send_capable: false }] });
    await expect(handleMailEnrollManagedOAuth(f.mail, { provider, account_slug: 'work', connection_name: 'source' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it.each(['gcal', 'graph'] as const)('enrolls %s read-only, and gates writes before network or warehouse changes', async adapter => {
    const f = await setup(adapter);
    f.proxy.mockResolvedValue(Response.json(adapter === 'gcal' ? { items: [{ id: 'primary', accessRole: 'owner' }] } : { value: [] }));
    const enrolled = await handleCalendarEnrollManagedOAuth(f.calendar,
      { adapter, slug: 'work', connection_name: 'source' });
    expect(enrolled.permission_state).toBe('unknown');
    expect(enrolled.caps).toMatchObject({ read: 'yes', create_event: 'no', delete_event: 'no', update_event: 'no', rsvp: 'no' });
    expect(f.instances.get('calendar', 'work')!.config.account_slug).toBe('managed-calendar:work');
    const count = f.proxy.mock.calls.length;
    const applyVerifiedUpsert = vi.fn();
    await expect(handleCalendarCreate({ instances: f.instances, getCollection: () => ({ applyVerifiedUpsert }) as unknown as CalendarCollection },
      { slug: 'work', calendar_id: 'primary', event: { summary: 'Fixture', calendar_id: 'primary', status: 'confirmed',
        start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false } }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(f.proxy).toHaveBeenCalledTimes(count); expect(applyVerifiedUpsert).not.toHaveBeenCalled();
    expect(f.directConfig).not.toHaveBeenCalled(); expect(f.accountData.size).toBe(0);
    expect(await handleCalendarList(f.calendar)).toMatchObject({ instances: [{ managed_connection_name: 'source' }] });
  });

  it.each(['gmail', 'graph'] as const)('uses the %s read transport once on an expired/revoked account', async provider => {
    const f = await setup(provider), transport = await f.consumers.resolve(provider, 'source');
    f.proxy.mockImplementation(async () => Response.json({ error: 'native_denial' }, { status: 401 }));
    const opts = { slug: 'work', accountStore: f.account, providerConfig: f.directConfig,
      fetcher: f.directFetch, managedFetcher: transport.fetch,
      config: () => ({ account_slug: 'managed-mail:work', backfill_days: 1, poll_seconds: 60, account_email: 'owner@example.test' }) };
    const mail = provider === 'gmail' ? createGmailProvider(opts) : createGraphProvider(opts);
    expect(mail.sendCapable).toBe(false); expect(mail.send).toBeUndefined();
    await expect(mail.fetchMessage!('native-id')).rejects.toThrow();
    expect(f.proxy).toHaveBeenCalledTimes(1);
    expect(f.account.get).not.toHaveBeenCalled(); expect(f.account.set).not.toHaveBeenCalled();
    expect(f.directConfig).not.toHaveBeenCalled(); expect(f.directFetch).not.toHaveBeenCalled();
  });

  it.each(['gmail', 'graph'] as const)('does not replay an opted-in %s send when the broker reports a lost result', async provider => {
    const f = await setup(provider), transport = await f.consumers.resolve(provider, 'source');
    f.proxy.mockImplementation(async path => provider === 'graph' && path.endsWith('/me/messages')
      ? Response.json({ id: 'native-draft' }, { status: 201 })
      : Response.json({ error: 'upstream_unavailable' }, { status: 503 }));
    const opts = { slug: 'work', accountStore: f.account, providerConfig: f.directConfig,
      managedFetcher: transport.fetch, managedSendEnabled: true,
      config: () => ({ account_slug: 'managed-mail:work', backfill_days: 1, poll_seconds: 60, account_email: 'owner@example.test' }) };
    const mail = provider === 'gmail' ? createGmailProvider(opts) : createGraphProvider(opts);
    await expect(mail.send!({ to: ['recipient@example.test'], subject: 'Fixture', body_text: 'Fixture only' })).rejects.toThrow();
    expect(f.proxy).toHaveBeenCalledTimes(provider === 'graph' ? 2 : 1);
    expect(f.proxy.mock.calls.every(([, init]) => init.method === 'POST')).toBe(true);
    if (provider === 'graph') expect(f.proxy.mock.calls.filter(([path]) => path.endsWith('/native-draft/send'))).toHaveLength(1);
    expect(f.account.get).not.toHaveBeenCalled(); expect(f.account.set).not.toHaveBeenCalled();
  });

  it.each(['gcal', 'graph'] as const)('enforces native %s permission denial after Calendar write opt-in without local refresh', async adapter => {
    const f = await setup(adapter);
    f.proxy.mockImplementation(async () => Response.json(adapter === 'gcal'
      ? { items: [{ id: 'primary', accessRole: 'owner' }] } : { value: [{ id: 'primary', canEdit: true }] }));
    const enrolled = await handleCalendarEnrollManagedOAuth(f.calendar,
      { adapter, slug: 'work', connection_name: 'source', write_enabled: true });
    expect(enrolled.caps.create_event).toBe('yes'); expect(enrolled.permission_state).toBe('unknown');
    const row = f.instances.get('calendar', 'work')!;
    const calendar = f.calendar.adapters.get(adapter)!.create({ slug: 'work', config: row.config,
      getAccountValue: async key => f.account.get(key) });
    f.proxy.mockClear();
    f.proxy.mockImplementation(async () => Response.json({ error: { message: 'native_permission_denied' } }, { status: 403 }));
    await expect(calendar.createEvent!('primary', { summary: 'Fixture', calendar_id: 'primary', status: 'confirmed',
      start_at: 1, end_at: 2, timezone: 'UTC', is_all_day: false })).rejects.toThrow();
    expect(f.proxy).toHaveBeenCalledOnce(); expect(f.proxy.mock.calls[0][1].method).toBe('POST');
    expect(f.account.get).not.toHaveBeenCalled(); expect(f.account.set).not.toHaveBeenCalled();
    expect(f.directConfig).not.toHaveBeenCalled();
  });

  it('fences source account replacement and vault locking after the transport was created', async () => {
    const f = await setup(), transport = await f.consumers.resolve('gmail', 'source');
    await f.put({ ...f.auth, connection_id: 'a-different-person' });
    await expect(transport.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { method: 'GET', headers: {} }))
      .rejects.toMatchObject({ code: 'conflict' });
    await f.put(); f.lock();
    await expect(transport.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { method: 'GET', headers: {} }))
      .rejects.toMatchObject({ code: 'locked' });
    expect(f.proxy).not.toHaveBeenCalled();
  });

  it('does not save a collection if the source changes or disappears during its identity probe', async () => {
    const f = await setup();
    f.proxy.mockImplementation(async () => {
      await f.put({ ...f.auth, connection_id: 'different-person' });
      return Response.json({ emailAddress: 'old-owner@example.test' });
    });
    await expect(handleMailEnrollManagedOAuth(f.mail, { provider: 'gmail', account_slug: 'work', connection_name: 'source' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(f.instances.get('mail', 'work')).toBeNull(); expect(f.accountData.size).toBe(0);
  });

  // D-322 audit — reconnect can retire evidence without changing encrypted credentials.
  it('rejects grant evidence retired during asynchronous credential decoding', async () => {
    const f = await setup(); const row = f.connections.get('api', 'source')!;
    f.connections.upsert({ ...row, granted_scopes_json: '["previously-reported-scope"]' });
    const consumers = createManagedOAuthConsumers({ connections: f.connections, instances: f.instances,
      decodeAuth: async () => { f.connections.clearGrantedScopes(['source']); return f.auth; },
      broker: { fetch: vi.fn() } });
    await expect(consumers.resolve('gmail', 'source')).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['mail', 'calendar'] as const)('refuses stale %s grant evidence after a concurrent reconnect', async platform => {
    const f = await setup(platform === 'mail' ? 'gmail' : 'gcal');
    const row = f.connections.get('api', 'source')!;
    f.connections.upsert({ ...row, granted_scopes_json: '["previously-reported-scope"]' });
    f.proxy.mockImplementation(async () => {
      f.connections.clearGrantedScopes(['source']);
      return Response.json(platform === 'mail' ? { emailAddress: 'owner@example.test' }
        : { items: [{ id: 'primary', accessRole: 'owner' }] });
    });
    const enroll = platform === 'mail'
      ? handleMailEnrollManagedOAuth(f.mail, { provider: 'gmail', account_slug: 'work', connection_name: 'source' })
      : handleCalendarEnrollManagedOAuth(f.calendar, { adapter: 'gcal', slug: 'work', connection_name: 'source' });
    await expect(enroll).rejects.toMatchObject({ code: 'conflict' });
    expect(f.instances.get(platform, 'work')).toBeNull();
    expect(f.connections.get('api', 'source')!.granted_scopes_json).toBeUndefined();
  });

  it('rejects malformed mailbox JSON before saving', async () => {
    const f = await setup(); f.proxy.mockResolvedValue(new Response('not-json'));
    await expect(handleMailEnrollManagedOAuth(f.mail,
      { provider: 'gmail', account_slug: 'work', connection_name: 'source' }))
      .rejects.toMatchObject({ code: 'probe_failed' });
    expect(f.instances.get('mail', 'work')).toBeNull();
  });

  it.each(['mail', 'calendar'] as const)('reports a saved %s account when mirror startup fails', async platform => {
    const f = await setup(platform === 'mail' ? 'gmail' : 'gcal');
    const onEnrolled = async () => { throw new Error('fixture adapter failed'); };
    f.proxy.mockImplementation(async () => Response.json(platform === 'mail'
      ? { emailAddress: 'owner@example.test' } : { items: [{ id: 'primary', accessRole: 'owner' }] }));
    const enroll = platform === 'mail'
      ? handleMailEnrollManagedOAuth({ ...f.mail, onEnrolled },
        { provider: 'gmail', account_slug: 'work', connection_name: 'source' })
      : handleCalendarEnrollManagedOAuth({ ...f.calendar, onEnrolled },
        { adapter: 'gcal', slug: 'work', connection_name: 'source' });
    await expect(enroll).rejects.toMatchObject({ code: 'adapter_start_failed', message: expect.stringContaining('was saved') });
    expect(f.instances.get(platform, 'work')!.config.managed_oauth).toMatchObject({ connection_name: 'source' });
  });

  it.each(['gmail', 'graph'] as const)('does not convert %s owner send opt-in into a vendor permission', async provider => {
    const f = await setup(provider), transport = await f.consumers.resolve(provider, 'source');
    f.proxy.mockImplementation(async () => Response.json({ error: 'native_permission_denied' }, { status: 403 }));
    const opts = { slug: 'work', accountStore: f.account, providerConfig: f.directConfig,
      managedFetcher: transport.fetch, managedSendEnabled: true,
      config: () => ({ account_slug: 'managed-mail:work', backfill_days: 1, poll_seconds: 60, account_email: 'owner@example.test' }) };
    const mail = provider === 'gmail' ? createGmailProvider(opts) : createGraphProvider(opts);
    await expect(mail.send!({ to: ['recipient@example.test'], subject: 'Fixture', body_text: 'Fixture only' }))
      .rejects.toThrow();
    expect(f.proxy).toHaveBeenCalledOnce();
    expect(f.connections.get('api', 'source')!.granted_scopes_json ?? null).toBeNull();
    expect(f.accountData.size).toBe(0);
  });

  it('refuses unrelated service connections and malformed provider identities', async () => {
    const f = await setup('google');
    await expect(f.consumers.resolve('gcal', 'source')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.consumers.resolve('gmail', 'source')).rejects.toMatchObject({ code: 'bad_request' });
    await f.put({ ...f.auth, target_origin: source.gmail.origin }, source.gmail.base);
    f.proxy.mockResolvedValue(Response.json({}));
    await expect(handleMailEnrollManagedOAuth(f.mail, { provider: 'gmail', account_slug: 'work', connection_name: 'source' }))
      .rejects.toMatchObject({ code: 'probe_failed' });
    expect(f.instances.get('mail', 'work')).toBeNull();
  });

  it('keeps a shared Graph account alive until both collections are removed, preserving direct tokens and broker profiles', async () => {
    const f = await setup('graph');
    f.proxy.mockImplementation(async path => Response.json(path.endsWith('/me')
      ? { mail: 'owner@example.test' } : { value: [] }));
    await handleMailEnrollManagedOAuth(f.mail, { provider: 'graph', account_slug: 'work', connection_name: 'source' });
    await handleCalendarEnrollManagedOAuth(f.calendar, { adapter: 'graph', slug: 'work', connection_name: 'source' });
    await expect(handleCalendarAttachGraphGrant(f.calendar, { slug: 'other' })).rejects.toThrow();
    const remove = () => f.handlers['collection.connection.delete']({ kind: 'api', name: 'source' }, undefined as never);
    await expect(remove()).rejects.toMatchObject({ code: 'conflict' });
    f.accountData.set('graph.work.refresh_token', 'direct-grant');
    f.accountData.set('graph.managed-mail-work.refresh_token', 'direct-account-with-managed-prefix');
    f.accountData.set('graph.managed-mail:work.delta_link', 'mail-cursor');
    f.accountData.set('graph.managed-calendar:work.cal_delta_link.primary', 'calendar-cursor');
    await handleMailDelete(f.mail, { slug: 'work' });
    expect(f.accountData.has('graph.managed-mail:work.delta_link')).toBe(false);
    expect(f.accountData.get('graph.work.refresh_token')).toBe('direct-grant');
    expect(f.accountData.get('graph.managed-mail-work.refresh_token')).toBe('direct-account-with-managed-prefix');
    await expect(remove()).rejects.toMatchObject({ code: 'conflict' });
    await handleCalendarDelete(f.calendar, { slug: 'work' });
    expect(f.accountData.has('graph.managed-calendar:work.cal_delta_link.primary')).toBe(false);
    expect(f.accountData.get('graph.work.refresh_token')).toBe('direct-grant');
    await remove(); expect(f.connections.get('api', 'source')).toBeNull();
  });
});

describe('managed file credential lifetime', () => {
  it('retains raw response fields and signal, while rechecking the encrypted connection per request', async () => {
    const f = await setup('google');
    const native = { files: [{ id: '1', owners: [{ displayName: 'Native name' }], extension: { untouched: true } }], nextPageToken: 'opaque' };
    f.proxy.mockImplementation(async () => Response.json(native));
    const cred = (await f.fileResolve('source'))!;
    expect(cred.auth).toEqual(f.auth);
    const signal = new AbortController().signal;
    const res = await cred.managedFetch!('https://www.googleapis.com/drive/v3/files', { method: 'GET', headers: {}, signal });
    expect(await res.json()).toEqual(native); expect(f.proxy.mock.calls[0][1].signal).toBe(signal);
    await f.put({ ...f.auth, connection_id: 'different-person' });
    await expect(cred.managedFetch!('https://www.googleapis.com/drive/v3/files', { method: 'GET', headers: {} }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(f.proxy).toHaveBeenCalledTimes(1); expect(f.directFetch).not.toHaveBeenCalled();
  });

  it('allows only Dropbox\'s authored content host as a second authenticated file origin', async () => {
    const f = await setup('dropbox'), cred = (await f.fileResolve('source'))!;
    f.proxy.mockImplementation(async () => new Response('native-bytes'));
    await cred.managedFetch!('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': '{"path":"id:fixture"}' } });
    expect(new Headers(f.proxy.mock.calls[0][1].headers).get('base-url-override')).toBe('https://content.dropboxapi.com');
    await expect(cred.managedFetch!('https://attacker.example/files', { method: 'GET', headers: {} })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.consumers.resolve('graph', 'source')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.handlers['collection.connection.managedOAuth']({ action: 'profiles' }, undefined as never)).resolves.toMatchObject({ action: 'profiles' });
    expect(f.proxy).toHaveBeenCalledTimes(1);
  });

  it('blocks an already-resolved managed file transport while the vault is locked', async () => {
    const f = await setup('google'), cred = (await f.fileResolve('source'))!;
    f.lock();
    await expect(cred.managedFetch!('https://www.googleapis.com/drive/v3/files', { method: 'GET', headers: {} }))
      .rejects.toMatchObject({ code: 'locked' });
    expect(f.proxy).not.toHaveBeenCalled();
  });
});
