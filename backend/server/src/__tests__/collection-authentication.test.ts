import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCollectionAuthenticationReview, type ConnectionAuth, type CollectionAuthenticationProvider,
  type AuthenticationCollectionPlatform, type CollectionCaps, type CollectionPermissionChoices, type ManagedOAuthRequest } from '@recued/contracts';
import { createCollectionAuthenticationService } from '../collection-authentication-service.js';
import { createCollectionOAuthSources } from '../collection-oauth-sources.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createManagedOAuthConsumers, managedOAuthFetcherFor } from '../managed-oauth-consumers.js';
import { createCalendarAdapterRegistry } from '../collections/calendar/adapter-registry.js';
import { handleCalendarDelete, handleCalendarUpdate } from '../collections/calendar/enroll.js';
import { handleMailDelete, handleMailList } from '../collections/mail/enroll.js';
import { collectionScopesCover } from '../collection-authentication-checks.js';
import { createGcalAdapterFactory } from '../collections/calendar/gcal-provider.js';
import { createGraphCalAdapterFactory } from '../collections/calendar/graph-provider.js';
import { managedOAuthConnectionUses } from '../managed-oauth-account-usage.js';
import { composeMailStack } from '../collections/mail/compose.js';
import { composeCalendarStack } from '../collections/calendar/compose.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const base = (p: CollectionAuthenticationProvider): string => p === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1'
  : p === 'gcal' ? 'https://www.googleapis.com/calendar/v3' : 'https://graph.microsoft.com/v1.0';
const scope = (platform: AuthenticationCollectionPlatform, p: CollectionAuthenticationProvider): string => platform === 'mail'
  ? p === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly' : 'Mail.Read'
  : p === 'gcal' ? 'https://www.googleapis.com/auth/calendar.readonly' : 'Calendars.Read';
const id = (): string => randomBytes(32).toString('base64url');
const fixture = async (platform: AuthenticationCollectionPlatform = 'mail', provider: CollectionAuthenticationProvider = 'gmail', brokerTarget = false) => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 1000;
  const key = (): Uint8Array => new Uint8Array(32).fill(6);
  const connections = createConnectionStore(db); const instances = createInstanceStore({ db, now: () => clock });
  const data = new Map<string, string>();
  const accountStore = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => { data.set(k, v); },
    delete: vi.fn(async (k: string) => { data.delete(k); }), getAll: async () => Object.fromEntries(data) };
  data.set(provider + '.work.access_token', 'original-account'); data.set(provider + '.work.expires_at', '9999999');
  data.set(provider + '.work.refresh_token', 'original-refresh'); data.set(provider + '.work.granted_scopes', scope(platform, provider));
  data.set(provider + '.work.history_id', 'cursor-777'); data.set(provider + '.work.cal_delta_link.team', 'calendar-cursor');
  let targetAccount = 'owner@example.test'; let originalAccount = targetAccount; let denied = ''; let unknown = false; let grant: string | undefined = scope(platform, provider);
  let resourceGate: Promise<void> | undefined; let anonymousStatus = 401; let cacheExpiry = 3600;
  const fetchImpl = vi.fn<typeof fetch>(async (raw, init) => {
    const u = new URL(String(raw)); const headers = new Headers(init?.headers);
    if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'selected-account', refresh_token: 'selected-rotated', expires_in: cacheExpiry, ...(grant === undefined ? {} : { scope: grant }) });
    if (u.hostname === 'api.nango.dev' && u.pathname === '/integrations') return Response.json({ data: [] });
    const broker = u.hostname === 'api.nango.dev'; const path = broker ? u.pathname.replace(/^\/proxy/, '') : u.pathname;
    if (broker) expect(headers.get('authorization')).toBe('Bearer broker-secret');
    if (!headers.has('authorization')) return new Response(null, { status: anonymousStatus });
    if (path.includes(denied) && denied) return new Response(null, { status: 403 });
    const owner = headers.get('authorization') === 'Bearer original-account' ? originalAccount : targetAccount;
    if (path.endsWith('/profile')) return Response.json(unknown ? {} : { emailAddress: owner });
    if (path.endsWith('/calendars/primary')) return Response.json(unknown ? {} : { id: owner });
    if (path.endsWith('/mailFolders/inbox')) return Response.json(unknown ? {} : { id: 'inbox:' + owner });
    if (path.endsWith('/me/calendar')) return Response.json(unknown ? {} : { id: 'calendar:' + owner, owner: { address: owner } });
    await resourceGate;
    if (path.endsWith('/messages')) return Response.json(provider === 'gmail' ? { messages: [{ id: 'message-1' }] } : { value: [{ id: 'message-1', body: { content: 'fixture only' } }] });
    return Response.json({ id: 'resource-1', body: { content: 'fixture only' }, value: [], items: [] });
  });
  const fetcher = makeBoundedOriginHttpFetcher({ fetchImpl, redirectPolicy: 'error' });
  const broker = createManagedOAuthService({ profiles: createManagedOAuthProfileStore(db, key), listConnections: () => connections.list(),
    decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext, row, key), fetchImpl });
  const saved = await broker.handle({ action: 'save_profile', broker: 'nango', label: 'Cloud', base_url: 'https://api.nango.dev', api_key: 'broker-secret' });
  if (saved.action !== 'save_profile') throw new Error('profile fixture');
  const brokerAuth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: saved.profile.id, integration_id: 'vendor', connection_id: 'selected',
    target_origin: new URL(base(provider)).origin, requested_scopes: [scope(platform, provider)] };
  const native: ConnectionAuth = { type: 'oauth2_refresh', client_id: 'native-app', client_secret: 'native-secret', refresh_token: 'selected-refresh',
    token_endpoint: 'https://oauth2.googleapis.com/token', current_access_token: 'selected-account', expires_at: 9999999 };
  const put = async (name: string, auth: ConnectionAuth, url = base(provider)) => connections.upsert({ kind: 'api', name, display_name: name,
    config_json: JSON.stringify({ base_url: url }), auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, key),
    enrolled_at: 1, updated_at: clock, granted_scopes_json: JSON.stringify([scope(platform, provider)]) });
  await put('native', native); await put('broker', brokerAuth);
  const sources = createCollectionOAuthSources({ store: connections, broker, decode: decodeAuthFromStorage, encode: encodeAuthForStorage, key, fetchImpl, now: () => clock });
  const consumers = createManagedOAuthConsumers({ connections, instances, broker, authentication: sources,
    decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext, row, key) });
  const caps: CollectionCaps = platform === 'mail' ? { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' }
    : { read: 'yes', list_calendars: 'yes', create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no', search: 'local', watch: 'poll', auth: 'oauth', recurrence: 'server' };
  instances.upsert({ platform, slug: 'work', adapter_type: provider, config: { account_slug: 'work', account_email: originalAccount,
    [platform === 'calendar' ? 'calendar_filter' : provider === 'gmail' ? 'label_filter' : 'folder_filter']: ['team'], backfill_days: 20 },
    caps, auth_state: 'healthy', last_synced_at: 555 });
  instances.markBackfillComplete(platform, 'work');
  const lifecycle = { stop: vi.fn(async (_slug: string) => {}), restart: vi.fn(async (_slug: string) => {}) };
  const oauthConfig = () => ({ tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'original-app', clientSecret: 'original-secret' });
  const mail = { instances, accountStore, managedOAuth: consumers, fetcher, oauthConfig, authenticationChange: lifecycle };
  const calendar = { ...mail, adapters: createCalendarAdapterRegistry() };
  const deps = { db, instances, sources, mail, calendar, now: () => clock, anonymous: fetcher };
  const service = createCollectionAuthenticationService(deps);
  const handlers = makeConnectionHandlers({ store: connections, getEncryptionKey: key, managedOAuth: broker, collectionAuthentication: service })!.handlers;
  const rpc = (args: ManagedOAuthRequest) => handlers['collection.connection.managedOAuth'](args, undefined as never);
  const review = async (name = brokerTarget ? 'broker' : 'native') => {
    const result = await rpc({ action: 'collection_authentication_review', platform, slug: 'work', connection_name: name });
    if (result.action !== 'collection_authentication_review') throw new Error('review fixture'); return result.review;
  };
  const apply = (r: Awaited<ReturnType<typeof review>>, attempt_id = id()) => rpc({ action: 'collection_authentication_apply', review_id: r.id, fingerprint: r.fingerprint, attempt_id });
  return { db, deps, instances, connections, data, accountStore, sources, consumers, fetchImpl, fetcher, lifecycle, mail, calendar, native, brokerAuth, put, rpc, review, apply,
    target: (s: string) => { targetAccount = s; }, original: (s: string) => { originalAccount = s; }, deny: (s: string) => { denied = s; },
    unknown: () => { unknown = true; }, grant: (s?: string) => { grant = s; }, clock: (v: number) => { clock = v; },
    gate: (p: Promise<void> | undefined) => { resourceGate = p; }, anonymous: (n: number) => { anonymousStatus = n; }, expiry: (n: number) => { cacheExpiry = n; } };
};

describe('same-account Mail and Calendar authentication migration', () => {
  for (const [platform, provider] of [['mail', 'gmail'], ['mail', 'graph'], ['calendar', 'gcal'], ['calendar', 'graph']] as const) {
    for (const broker of [false, true]) it(`${platform}/${provider} preserves state while selecting ${broker ? 'broker' : 'native'} authentication`, async () => {
      const f = await fixture(platform, provider, broker); const before = f.instances.get(platform, 'work')!; const credentials = new Map(f.data);
      const r = await f.review(); expect(isCollectionAuthenticationReview(r)).toBe(true); expect(r.current.account_id).toBe(r.target.account_id);
      const result = await f.apply(r);
      expect(result).toMatchObject({ outcome: { status: 'applied', authentication: broker ? 'broker' : 'direct_oauth' } });
      const row = f.instances.get(platform, 'work')!;
      expect(row).toMatchObject({ slug: 'work', created_at: before.created_at, backfill_complete: true, last_synced_at: 555, caps: before.caps });
      expect(row.config).toMatchObject({ ...before.config, oauth_connection: { connection_name: broker ? 'broker' : 'native' }, managed_send_enabled: false, managed_write_enabled: false });
      expect(f.data).toEqual(credentials); expect(f.lifecycle.stop).toHaveBeenCalledOnce(); expect(f.lifecycle.restart).toHaveBeenCalledOnce();
      expect(f.connections.get('api', 'native')!.auth_ciphertext).not.toContain('native-secret');
      const transport = managedOAuthFetcherFor(f.consumers, provider, row.config.oauth_connection)!;
      const response = await transport(base(provider) + '/runtime-read'); expect(response.ok).toBe(true);
    });
  }
  it('lists direct OAuth first and omits incompatible services', async () => {
    const f = await fixture(); await f.put('wrong', f.native, 'https://www.googleapis.com/drive/v3');
    expect(await f.sources.candidates('gmail')).toEqual([{ name: 'native', display_name: 'native', authentication: 'direct_oauth' }, { name: 'broker', display_name: 'broker', authentication: 'broker' }]);
  });
  it('keeps the collection unchanged for a different or unconfirmed account', async () => {
    const f = await fixture(); const before = f.instances.get('mail', 'work'); f.target('someone@example.test');
    await expect(f.review()).rejects.toThrow('different or unconfirmed'); expect(f.instances.get('mail', 'work')).toEqual(before);
    f.unknown(); await expect(f.review()).rejects.toThrow('could not be verified'); expect(f.lifecycle.stop).not.toHaveBeenCalled();
  });
  it('rechecks identity, selected resources, and anonymous protection at apply', async () => {
    for (const failure of ['account', 'selection', 'public']) {
      const f = await fixture(); const r = await f.review(); const before = f.instances.get('mail', 'work');
      if (failure === 'account') f.target('different@example.test'); else if (failure === 'selection') f.deny('/labels/team'); else f.anonymous(200);
      expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed' } }); expect(f.instances.get('mail', 'work')).toEqual(before);
      expect(f.lifecycle.stop).not.toHaveBeenCalled();
    }
  });
  it('rejects owner edits and an API credential replacement after review', async () => {
    const f = await fixture(); let r = await f.review(); const row = f.instances.get('mail', 'work')!;
    f.instances.upsert({ ...row, config: { ...row.config, label_filter: ['other'] } });
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    r = await f.review(); await f.put('native', { ...f.native, refresh_token: 'replaced-owner-grant' });
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
  });
  it('rejects an owner replacement immediately after successful native renewal', async () => {
    const f = await fixture(); const original = f.connections.get('api', 'native')!;
    const replacement = await encodeAuthForStorage({ ...f.native, refresh_token: 'owner-replacement' }, original, () => new Uint8Array(32).fill(6));
    const persist = f.connections.persistRefreshedAuth!.bind(f.connections);
    vi.spyOn(f.connections, 'persistRefreshedAuth').mockImplementation((...args) => {
      const saved = persist(...args);
      if (saved) f.connections.upsert({ ...f.connections.get('api', 'native')!, auth_ciphertext: replacement });
      return saved;
    });
    await expect(f.sources.prepare('gmail', 'native', [])).rejects.toThrow('changed');
    expect(f.instances.get('mail', 'work')!.config.oauth_connection).toBeUndefined();
  });
  it('invalidates native permission evidence after automatic renewal or token expiry', async () => {
    for (const change of ['renewal', 'expiry'] as const) {
      const f = await fixture(); if (change === 'expiry') f.expiry(120);
      const r = await f.review(); const before = f.instances.get('mail', 'work');
      f.clock(change === 'expiry' ? 200_000 : 2000);
      if (change === 'renewal') await f.sources.prepare('gmail', 'native', []);
      expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
      expect(f.instances.get('mail', 'work')).toEqual(before); expect(f.lifecycle.stop).not.toHaveBeenCalled();
    }
  });
  it('does not leak collection admission when the durable attempt insert fails', async () => {
    const f = await fixture(); const r = await f.review();
    f.db.exec("CREATE TRIGGER reject_attempt BEFORE INSERT ON collection_authentication_attempts BEGIN SELECT RAISE(FAIL, 'fixture insert failure'); END;");
    await expect(f.apply(r)).rejects.toThrow('fixture insert failure');
    f.db.exec('DROP TRIGGER reject_attempt');
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'applied' } });
  });
  it('revalidates after stopping and restores the original adapter on failure', async () => {
    const f = await fixture(); const r = await f.review(); const before = f.instances.get('mail', 'work');
    f.lifecycle.stop.mockImplementation(async () => { f.target('different@example.test'); });
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed' } }); expect(f.instances.get('mail', 'work')).toEqual(before);
    expect(f.lifecycle.restart).toHaveBeenCalledOnce();
  });
  it('keeps exact sync state advanced during review and preserves pending write choices', async () => {
    const f = await fixture(); const r = await f.review(); f.instances.updateAuthState('mail', 'work', { auth_state: 'healthy', last_synced_at: 888 });
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'applied' } }); expect(f.instances.get('mail', 'work')!.last_synced_at).toBe(888);
    const write = await fixture(); write.data.set('gmail.work.granted_scopes', 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send');
    write.grant('https://www.googleapis.com/auth/gmail.modify'); const rw = await write.review(); await write.apply(rw);
    expect(write.instances.get('mail', 'work')!.config).toMatchObject({ managed_send_enabled: true, managed_mutation_enabled: true });
  });
  it('refuses unknown or insufficient permission evidence for existing writes', async () => {
    const f = await fixture(); f.data.set('gmail.work.granted_scopes', 'https://www.googleapis.com/auth/gmail.send');
    f.grant(); await expect(f.review()).rejects.toThrow('permissions must cover');
    f.grant('https://www.googleapis.com/auth/gmail.readonly'); await expect(f.review()).rejects.toThrow('permissions must cover');
    expect(f.instances.get('mail', 'work')!.config.oauth_connection).toBeUndefined();
  });
  for (const platform of ['mail', 'calendar'] as const) {
    for (const resource of ['basic', 'empty', 'malformed'] as const) it(`refuses ${platform} ${resource} Graph data without full read grant evidence`, async () => {
      const f = await fixture(platform, 'graph'); const before = f.instances.get(platform, 'work'); f.grant();
      const real = f.fetchImpl.getMockImplementation()!;
      f.fetchImpl.mockImplementation(async (raw, init) => {
        const url = new URL(String(raw));
        if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/events')) {
          return Response.json(resource === 'malformed' ? {} : { value: resource === 'empty' ? [] : [{ id: 'item-1', subject: 'Basic fields only' }] });
        }
        return real(raw, init);
      });
      await expect(f.review()).rejects.toThrow(/read|body|permissions/);
      expect(f.instances.get(platform, 'work')).toEqual(before); expect(f.lifecycle.stop).not.toHaveBeenCalled();
    });
    it(`accepts ${platform} full Graph body reads with unknown grant metadata`, async () => {
      const f = await fixture(platform, 'graph'); f.grant(); const real = f.fetchImpl.getMockImplementation()!;
      f.fetchImpl.mockImplementation(async (raw, init) => {
        if (new URL(String(raw)).pathname.endsWith('/events')) return Response.json({ value: [{ id: 'event-1', body: { content: '' } }] });
        return real(raw, init);
      });
      expect(await f.apply(await f.review())).toMatchObject({ outcome: { status: 'applied' } });
    });
  }
  it('supports broker-to-native and native-to-broker switches without losing the pinned previous broker account', async () => {
    const f = await fixture(); await f.apply(await f.review('broker')); const brokerRow = f.instances.get('mail', 'work')!;
    await f.put('broker', f.native); // API migration already happened; the collection still pins old broker refs.
    await f.apply(await f.review('native')); expect(f.instances.get('mail', 'work')!.config.oauth_connection).toMatchObject({ type: 'direct_oauth' });
    expect(brokerRow.config.oauth_connection).toMatchObject({ type: 'managed_oauth' }); expect(f.data.get('gmail.work.history_id')).toBe('cursor-777');
  });
  it('uses trusted prior identity if the original source becomes unavailable, without trusting patched config', async () => {
    const f = await fixture(); await f.apply(await f.review('native')); f.connections.delete('api', 'native');
    expect(await f.apply(await f.review('broker'))).toMatchObject({ outcome: { status: 'applied' } });
    f.target('intruder@example.test'); await expect(f.review('broker')).rejects.toThrow('different or unconfirmed');
  });
  it('records a durable result and does not repeat a switch when the reply is lost', async () => {
    const f = await fixture(); const r = await f.review(); const attempt = id(); const first = await f.apply(r, attempt);
    expect(await f.apply(r, attempt)).toEqual(first); expect(f.lifecycle.stop).toHaveBeenCalledOnce();
    const restarted = createCollectionAuthenticationService(f.deps);
    expect(await restarted.handle({ action: 'collection_authentication_status', attempt_id: attempt })).toMatchObject({ outcome: { status: 'applied' } });
  });
  it('records interrupted checks without resuming and reports restart failures honestly', async () => {
    const f = await fixture(); const r = await f.review(); f.lifecycle.restart.mockRejectedValue(new Error('fixture restart failure'));
    const result = await f.apply(r); expect(result).toMatchObject({ outcome: { status: 'applied', restart_needed: true } });
    expect(f.instances.get('mail', 'work')!.auth_state).toBe('degraded');
    const attempt = id(); f.db.prepare('INSERT INTO collection_authentication_attempts VALUES (?, ?, ?, ?)').run(attempt, id(), 'f'.repeat(64), JSON.stringify({
      attempt_id: attempt, platform: 'mail', slug: 'work', status: 'checking', connection_name: 'native', authentication: 'direct_oauth' }));
    const restarted = createCollectionAuthenticationService(f.deps);
    expect(await restarted.handle({ action: 'collection_authentication_status', attempt_id: attempt })).toMatchObject({ outcome: { status: 'failed', reason: 'interrupted' } });
  });
  it('retires closed or expired reviews and serializes migrations for one collection', async () => {
    const f = await fixture(); const r = await f.review(); await f.rpc({ action: 'collection_authentication_retire', review_id: r.id });
    await expect(f.apply(r)).rejects.toThrow('changed'); const next = await f.review(); f.clock(next.expires_at); await expect(f.apply(next)).rejects.toThrow('changed');
    f.clock(1000); const one = await f.review(); const two = await f.review(); let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.apply(one); await expect(f.apply(two)).rejects.toThrow('already in progress'); release(); await pending;
  });
  it('fences a final API edit after async access checks and saves a successful rotation before refusing edited config', async () => {
    const f = await fixture(); const r = await f.review();
    const transport = await f.sources.prepare('gmail', 'native', []); await transport.assertCurrent();
    const row = f.connections.get('api', 'native')!; f.connections.upsert({ ...row, config_json: JSON.stringify({ base_url: base('gmail'), edited: true }) });
    expect(() => transport.beforeSwap()).toThrow('changed'); expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
  });
  it('guards referenced API deletion, lists generic source authentication, and retains shared Graph credentials on collection removal', async () => {
    const f = await fixture('mail', 'graph'); await f.apply(await f.review());
    expect(() => f.consumers.assertUnreferenced('native')).toThrow('used by Mail or Calendar');
    expect((await handleMailList(f.mail)).instances[0]).toMatchObject({ managed_connection_name: 'native', source_authentication: 'direct_oauth' });
    const uses = managedOAuthConnectionUses('native', { instances: f.instances.list(), packSlugs: [], packNames: new Map(), sources: [], complete: true });
    expect(uses.uses).toContainEqual({ kind: 'mail', id: 'work', label: 'work' });
    await handleMailDelete(f.mail, { slug: 'work' }); expect(f.data.get('graph.work.refresh_token')).toBe('original-refresh');
  });
  it('keeps reserved binding and namespace fields out of ordinary Calendar updates', async () => {
    const f = await fixture('calendar', 'gcal'); const before = f.instances.get('calendar', 'work')!;
    await handleCalendarUpdate(f.calendar, { slug: 'work', config_patch: { account_slug: 'other', oauth_connection: { type: 'direct_oauth' }, managed_write_enabled: true, poll_seconds: 40 } });
    expect(f.instances.get('calendar', 'work')!.config).toEqual({ ...before.config, poll_seconds: 40 });
    await f.apply(await f.review()); await handleCalendarDelete(f.calendar, { slug: 'work' }); expect(f.data.get('gcal.work.refresh_token')).toBe('original-refresh');
  });
  it('reuses generic saved native transport in Calendar factories with write choices unchanged', async () => {
    for (const provider of ['gcal', 'graph'] as const) {
      const f = await fixture('calendar', provider); await f.apply(await f.review()); const row = f.instances.get('calendar', 'work')!;
      const options = { accountStore: f.accountStore, providerConfig: () => null, managedOAuth: f.consumers, fetcher: f.fetcher };
      const factory = provider === 'gcal' ? createGcalAdapterFactory(options) : createGraphCalAdapterFactory(options);
      const caps = await factory.probeCaps({ slug: 'work', config: row.config, getAccountValue: async () => null });
      expect(caps).toMatchObject({ create_event: 'no', update_event: 'no' });
    }
  });
  it('recognizes service scope implications and Graph resource URI forms', () => {
    expect(collectionScopesCover(['https://graph.microsoft.com/Mail.ReadWrite'], ['Mail.Read'])).toBe(true);
    expect(collectionScopesCover(['https://www.googleapis.com/auth/calendar'], ['https://www.googleapis.com/auth/calendar.readonly'])).toBe(true);
    expect(collectionScopesCover(['https://www.googleapis.com/auth/gmail.modify'], ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'])).toBe(true);
    expect(collectionScopesCover(['Mail.Read'], ['Mail.Send'])).toBe(false);
  });
  it('records collection scope needs only when applying and renews the referenced native source during runtime', async () => {
    const f = await fixture(); const r = await f.review();
    const readAuth = async () => { const row = f.connections.get('api', 'native')!; return decodeAuthFromStorage(row.auth_ciphertext, row, () => new Uint8Array(32).fill(6)); };
    expect((await readAuth()).type).toBe('oauth2_refresh'); expect((await readAuth() as { required_scopes?: string[] }).required_scopes).toBeUndefined();
    await f.apply(r); expect(await readAuth()).toMatchObject({ required_scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    f.clock(4_000_000); const binding = f.instances.get('mail', 'work')!.config.oauth_connection;
    const calls = f.fetchImpl.mock.calls.filter(([url]) => String(url).includes('/token')).length;
    expect((await f.sources.fetch('gmail', binding)(base('gmail') + '/runtime-read')).ok).toBe(true);
    expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).includes('/token')).length).toBe(calls + 1);
    await expect(f.sources.fetch('gmail', binding)('https://other.example.test/private')).rejects.toThrow('changed');
  });
  it('rolls back source requirements with a failed collection swap', async () => {
    const f = await fixture(); const r = await f.review('broker'); const original = f.connections.get('api', 'broker')!;
    const before = f.instances.get('mail', 'work')!;
    const realUpsert = f.instances.upsert;
    f.instances.upsert = () => { throw new Error('fixture failed SQLite swap'); };
    expect(await f.apply(r)).toMatchObject({ outcome: { status: 'failed' } });
    expect(f.connections.get('api', 'broker')).toEqual(original); expect(f.instances.get('mail', 'work')).toEqual(before);
    f.instances.upsert = realUpsert;
  });
  it('does not migrate after a same-reference remote account is reassigned', async () => {
    const f = await fixture(); await f.apply(await f.review('broker')); f.target('different@example.test');
    await expect(f.review('broker')).rejects.toThrow('different or unconfirmed');
  });
  it('boots and restarts real Mail providers from the saved source without the original OAuth app or grant', async () => {
    for (const provider of ['gmail', 'graph'] as const) {
      const f = await fixture('mail', provider); await f.apply(await f.review()); f.data.clear();
      const bus = createWarehouseEventBus();
      const stack = composeMailStack(f.db, { bus,
        blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
        getGate: () => ({ addUsed() {}, setUsed() {}, info: () => ({ surface: 'test', used: 0, quota: 1000000, reservePct: 0, state: 'healthy' }) }) as never,
      }, { accountStore: f.accountStore, managedOAuth: f.consumers, oauthConfig: () => null, isVaultUnlocked: () => false });
      try {
        await stack.startAll(); expect(stack.listLive().map(row => row.slug)).toEqual(['work']);
        await stack.enrollDeps.authenticationChange!.stop('work'); expect(stack.listLive()).toHaveLength(0);
        await stack.startAll(); expect(stack.listLive()).toHaveLength(0);
        await stack.enrollDeps.authenticationChange!.restart('work'); expect(stack.enrollDeps.authenticationChange!.running!('work')).toBe(true);
      } finally { await stack.disposeAll(); bus.dispose(); }
    }
  });
  it('keeps Calendar stopped during final migration proof despite a concurrent boot sweep', async () => {
    const f = await fixture('calendar', 'gcal'); await f.apply(await f.review()); f.data.clear();
    const bus = createWarehouseEventBus();
    const stack = composeCalendarStack(f.db, { bus,
      blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
      getGate: () => ({ addUsed() {}, setUsed() {}, info: () => ({ surface: 'test', used: 0, quota: 1000000, reservePct: 0, state: 'healthy' }) }) as never,
    }, { accountStore: f.accountStore, managedOAuth: f.consumers, oauthConfig: () => null, isVaultUnlocked: () => false,
      factories: [createGcalAdapterFactory({ accountStore: f.accountStore, managedOAuth: f.consumers, providerConfig: () => null })] });
    try {
      await stack.startAll(); expect(stack.listLive().map(row => row.slug)).toEqual(['work']);
      await stack.enrollDeps.authenticationChange!.stop('work'); await stack.startAll(); expect(stack.listLive()).toHaveLength(0);
      await stack.enrollDeps.authenticationChange!.restart('work'); expect(stack.enrollDeps.authenticationChange!.running!('work')).toBe(true);
    } finally { await stack.disposeAll(); bus.dispose(); }
  });
});

describe('permission choices for connection-backed collections', () => {
  it('accepts a retained full Google Calendar grant for event editing without treating event access as calendar administration', () => {
    expect(collectionScopesCover(['https://www.googleapis.com/auth/calendar'], ['https://www.googleapis.com/auth/calendar.events'])).toBe(true);
    expect(collectionScopesCover(['https://www.googleapis.com/auth/calendar.events'], ['https://www.googleapis.com/auth/calendar'])).toBe(false);
    expect(collectionScopesCover(['https://www.googleapis.com/auth/calendar.events'], ['https://www.googleapis.com/auth/calendar.readonly'])).toBe(false);
  });
  const prepare = async (f: Awaited<ReturnType<typeof fixture>>, permissions: CollectionPermissionChoices, name = 'native') => {
    const response = await f.rpc({ action: 'collection_authentication_review', platform: permissions.platform, slug: 'work', connection_name: name,
      intent: 'permissions', permissions });
    if (response.action !== 'collection_authentication_review') throw Error('permission review'); return response.review;
  };
  it.each(['gmail', 'graph'] as const)('enables %s sending through its current native API grant with organization still off', async provider => {
    const f = await fixture('mail', provider); await f.apply(await f.review()); const before = f.instances.get('mail', 'work')!;
    f.grant(provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
      : 'Mail.Read Mail.Send Mail.ReadWrite');
    const review = await prepare(f, { platform: 'mail', slug: 'work', read: true, send: true, organize: false });
    expect(review.permissions).toMatchObject({ current: { send: false, organize: false }, selected: { send: true, organize: false } });
    expect(f.instances.get('mail', 'work')).toEqual(before);
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied', intent: 'permissions' } });
    expect(f.instances.get('mail', 'work')).toMatchObject({ last_synced_at: before.last_synced_at, backfill_complete: true,
      config: { managed_send_enabled: true, managed_mutation_enabled: false, native_send_enabled: true, native_mutation_enabled: false } });
    expect(f.data.get(provider + '.work.history_id')).toBe('cursor-777');
    expect((await handleMailList(f.mail)).instances[0]!.send_capable).toBe(true);
  });
  it('uses reported broker grants and preserves its existing remote account', async () => {
    const f = await fixture('mail', 'graph', true); await f.apply(await f.review());
    const row = f.connections.get('api', 'broker')!;
    f.connections.upsert({ ...row, granted_scopes_json: JSON.stringify(['Mail.ReadWrite', 'Mail.Send']) });
    const original = f.instances.get('mail', 'work')!.config.oauth_connection;
    const review = await prepare(f, { platform: 'mail', slug: 'work', read: true, send: true, organize: false }, 'broker');
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
    expect(f.instances.get('mail', 'work')!.config).toMatchObject({ oauth_connection: original, managed_send_enabled: true, managed_mutation_enabled: false });
    expect(f.fetchImpl.mock.calls.filter(([raw]) => new URL(String(raw)).pathname.includes('connect/sessions'))).toHaveLength(0);
  });
  it('keeps a broker collection unchanged when permission metadata is unknown', async () => {
    const f = await fixture('mail', 'gmail', true); await f.apply(await f.review());
    f.connections.upsert({ ...f.connections.get('api', 'broker')!, granted_scopes_json: undefined });
    const before = f.instances.get('mail', 'work'); f.lifecycle.stop.mockClear();
    await expect(prepare(f, { platform: 'mail', slug: 'work', read: true, send: true, organize: false }, 'broker')).rejects.toThrow('Vendor-reported permissions');
    expect(f.instances.get('mail', 'work')).toEqual(before); expect(f.lifecycle.stop).not.toHaveBeenCalled();
  });
  it.each(['gcal', 'graph'] as const)('changes %s Calendar caps only after verified apply', async provider => {
    const f = await fixture('calendar', provider); await f.apply(await f.review());
    f.grant(provider === 'gcal' ? 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events' : 'Calendars.Read Calendars.ReadWrite');
    const before = f.instances.get('calendar', 'work')!;
    const review = await prepare(f, { platform: 'calendar', slug: 'work', read: true, edit_events: true });
    expect(f.instances.get('calendar', 'work')).toEqual(before); await f.apply(review);
    expect(f.instances.get('calendar', 'work')).toMatchObject({ config: { managed_write_enabled: true, native_write_enabled: true },
      caps: { create_event: 'yes', update_event: 'yes', delete_event: 'yes', rsvp: 'yes' }, last_synced_at: before.last_synced_at, backfill_complete: true });
  });
  it('pins permission changes to the current source and rejects stale collection configuration', async () => {
    const f = await fixture(); await f.apply(await f.review()); const before = f.instances.get('mail', 'work')!;
    const choice = { platform: 'mail' as const, slug: 'work', read: true as const, send: false, organize: false };
    await expect(prepare(f, choice, 'broker')).rejects.toMatchObject({ code: 'bad_request' });
    const review = await prepare(f, choice);
    f.instances.upsert({ ...before, config: { ...before.config, managed_send_enabled: true } });
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    expect(f.instances.get('mail', 'work')!.config.managed_send_enabled).toBe(true);
  });
  it('reads current choices without probing the vendor or changing credentials', async () => {
    const f = await fixture(); await f.apply(await f.review()); f.fetchImpl.mockClear();
    const before = f.connections.get('api', 'native');
    const response = await f.rpc({ action: 'collection_authentication_candidates', platform: 'mail', slug: 'work' });
    expect(response).toMatchObject({ current_connection_name: 'native', provider: 'gmail', permissions: { platform: 'mail', slug: 'work', read: true, send: false, organize: false } });
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.connections.get('api', 'native')).toEqual(before);
  });
});
