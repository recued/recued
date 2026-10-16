import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, isCollectionOAuthAppContext, isCollectionOAuthAppReview,
  type CollectionCaps, type CollectionPermissionChoices, type CollectionOAuthAppSwitchRequest, type CollectionOAuthAppSwitchResponse } from '@recued/contracts';
import { createServerAccountStore } from '../account-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createCollectionOAuthAppSwitchService } from '../collection-oauth-app-switch.js';
import { createCalendarAdapterRegistry } from '../collections/calendar/adapter-registry.js';
import { refreshAccessToken, type HttpFetcher } from '../collections/mail/oauth.js';
import { makeConnectionHandlers } from '../connection-handler.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { collectionAuthenticationLocks } from '../collection-authentication-locks.js';
import { createGcalAdapterFactory } from '../collections/calendar/gcal-provider.js';
import { composeMailStack } from '../collections/mail/compose.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { handleMailList } from '../collections/mail/enroll.js';
import { handleCalendarCreate } from '../collections/calendar/calendar-dispatcher.js';

const dbs: Database.Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
const mailCaps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' };
const calCaps: CollectionCaps = { read: 'yes', list_calendars: 'yes', create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no', search: 'local', watch: 'poll', auth: 'oauth', recurrence: 'server' };
const fixture = async (provider: 'gmail' | 'gcal' | 'graph' = 'gmail', shared = false) => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 1000;
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: () => Buffer.alloc(32, 8) });
  const issuer = provider === 'graph' ? 'microsoft' : 'google';
  apps.setIssuer(issuer, 'old-client', 'fixture-old-secret');
  const target = apps.saveApp({ issuer, label: 'Work app', client_id: 'new-client', client_secret: 'fixture-new-secret' });
  const deltas: number[] = []; const account = createServerAccountStore(db, { onBytesChanged: n => deltas.push(n) });
  const instances = createInstanceStore({ db, now: () => clock });
  const platform: 'mail' | 'calendar' = provider === 'gcal' ? 'calendar' : 'mail';
  const scopes = provider === 'gmail' ? ['https://www.googleapis.com/auth/gmail.readonly']
    : provider === 'gcal' ? ['https://www.googleapis.com/auth/calendar.readonly'] : ['Mail.Read', ...(shared ? ['Calendars.Read'] : [])];
  let granted = [...scopes]; let owner = 'owner@example.test'; let targetOwner = owner; let denied = ''; let unknown = false;
  let gate: Promise<void> | undefined; let tokenGate: Promise<void> | undefined; let shortExpiry = false; let anonymousStatus = 401;
  const fetcher = vi.fn<HttpFetcher>(async (raw, init) => {
    const url = new URL(raw); const token = init?.headers?.Authorization;
    if (init?.method === 'POST') {
      await tokenGate;
      const body = new URLSearchParams(init.body);
      expect(body.get('client_secret')).toBe(body.get('client_id') === 'new-client' ? 'fixture-new-secret' : 'fixture-old-secret');
      return { status: 200, ok: true, text: async () => '', json: async () => ({ access_token: body.get('grant_type') === 'authorization_code' ? 'new-access' : 'renewed-old-access',
        refresh_token: body.get('grant_type') === 'authorization_code' ? 'new-refresh' : 'rotated-old-refresh', expires_in: shortExpiry ? 1 : 3600, scope: granted.join(' ') }) };
    }
    if (!token) return { status: anonymousStatus, ok: anonymousStatus < 400, json: async () => ({}), text: async () => '' };
    if (gate && token === 'Bearer new-access') await gate;
    if (denied && url.pathname.includes(denied)) return { status: 403, ok: false, json: async () => ({}), text: async () => '' };
    const email = token === 'Bearer new-access' ? targetOwner : owner;
    const value = unknown && token === 'Bearer new-access' ? {} : url.pathname.endsWith('/profile') ? { emailAddress: email }
      : url.pathname.endsWith('/calendars/primary') ? { id: email }
        : url.pathname.endsWith('/mailFolders/inbox') ? { id: 'inbox:' + email }
          : url.pathname.endsWith('/me/calendar') ? { id: 'calendar:' + email, owner: { address: email } }
            : url.pathname.endsWith('/me') ? { id: email, mail: email }
              : url.pathname.endsWith('/messages') ? provider === 'gmail' ? { messages: [{ id: 'message' }] } : { value: [{ id: 'message', body: { content: 'fixture' } }] }
                : { id: 'team', items: [], value: [{ id: 'event', body: { content: 'fixture' } }] };
    return { status: 200, ok: true, json: async () => value, text: async () => '' };
  });
  const config = (_p: string, appId?: string) => {
    const clientId = apps.getClientId(issuer, appId);
    return clientId ? { clientId, clientSecret: apps.getClientSecret(issuer, appId)!, tokenUrl: issuer === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL } : null;
  };
  const mailLife = { stop: vi.fn(async (_s: string) => {}), restart: vi.fn(async (_s: string) => {}), running: vi.fn(() => true) };
  const calLife = { stop: vi.fn(async (_s: string) => {}), restart: vi.fn(async (_s: string) => {}), running: vi.fn(() => true) };
  const mail = { instances, accountStore: account, oauthConfig: config, fetcher, authenticationChange: mailLife };
  const calendar = { ...mail, adapters: createCalendarAdapterRegistry(), authenticationChange: calLife };
  instances.upsert({ platform, slug: 'work', adapter_type: provider, config: { account_slug: 'work',
    [platform === 'mail' ? provider === 'gmail' ? 'label_filter' : 'folder_filter' : 'calendar_filter']: ['team'], backfill_days: 20 },
  caps: platform === 'mail' ? mailCaps : calCaps, auth_state: 'healthy', last_synced_at: 444 });
  instances.markBackfillComplete(platform, 'work');
  if (shared) {
    instances.upsert({ platform: 'calendar', slug: 'work', adapter_type: 'graph', config: { account_slug: 'work', calendar_filter: ['team'] },
      caps: calCaps, auth_state: 'healthy', last_synced_at: 555 });
    instances.markBackfillComplete('calendar', 'work');
  }
  for (const [key, value] of Object.entries({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: '9999999', granted_scopes: scopes.join(' '),
    history_id: 'mail-cursor', 'cal_delta_link.team': 'calendar-cursor' })) await account.set(provider + '.work.' + key, value);
  const deps = { db, instances, apps, accountStore: account, mail, calendar, now: () => clock, anonymous: fetcher };
  const service = createCollectionOAuthAppSwitchService(deps);
  const handlers = makeConnectionHandlers({ store: createConnectionStore(db), collectionOAuthAppSwitch: service })!.handlers;
  const call = (r: CollectionOAuthAppSwitchRequest) => handlers['collection.connection.managedOAuth'](r, undefined as never) as Promise<CollectionOAuthAppSwitchResponse>;
  const context = async () => { const r = await call({ action: 'collection_authentication_app_context', platform, slug: 'work' }); if (r.action !== 'collection_authentication_app_context') throw Error('context'); return r.context; };
  const authorize = async () => { const ctx = await context(); const r = await call({ action: 'collection_authentication_app_authorize', context_id: ctx.id, fingerprint: ctx.fingerprint, app_id: target.id, expected_revision: target.revision });
    if (r.action !== 'collection_authentication_app_authorize') throw Error('authorize'); return r.authorization; };
  const review = async () => { const auth = await authorize(); const r = await call({ action: 'collection_authentication_app_review', authorization_id: auth.id, code: 'fixture-code', redirect_uri: 'https://app.recued.com/oauth-callback' });
    if (r.action !== 'collection_authentication_app_review') throw Error('review'); return r.review; };
  const apply = (r: Awaited<ReturnType<typeof review>>, attempt = 'a'.repeat(43)) => call({ action: 'collection_authentication_app_apply', review_id: r.id, fingerprint: r.fingerprint, attempt_id: attempt });
  return { db, apps, target, account, instances, mail, calendar, platform, provider, scopes, config, fetcher, deps, service, call, context, authorize, review, apply, mailLife, calLife, deltas,
    clock: (n: number) => { clock = n; }, owner: (s: string) => { owner = s; }, targetOwner: (s: string) => { targetOwner = s; },
    grant: (s: string[]) => { granted = s; }, deny: (s: string) => { denied = s; }, unknown: () => { unknown = true; }, expire: () => { shortExpiry = true; },
    gate: (p?: Promise<void>) => { gate = p; }, tokenGate: (p?: Promise<void>) => { tokenGate = p; }, anonymous: (n: number) => { anonymousStatus = n; } };
};
describe('switch saved native OAuth app', () => {
  it.each(['gmail', 'gcal', 'graph'] as const)('reviews and swaps %s without changing mirror state or exposing tokens', async provider => {
    const f = await fixture(provider); const before = f.instances.get(f.platform, 'work')!; const tokens = await f.account.getAll();
    expect(isCollectionOAuthAppContext(await f.context())).toBe(true);
    const review = await f.review(); expect(isCollectionOAuthAppReview(review)).toBe(true);
    expect(await f.account.getAll()).toEqual(tokens); expect(JSON.stringify(review)).not.toMatch(/fixture-.*secret|new-access|new-refresh|client_secret/);
    const result = await f.apply(review); expect(result).toMatchObject({ outcome: { status: 'applied', app_id: f.target.id } });
    expect(f.instances.get(f.platform, 'work')).toMatchObject({ ...before, config: { ...before.config, oauth_app_id: f.target.id } });
    expect(await f.account.get(provider + '.work.refresh_token')).toBe('new-refresh');
    expect(await f.account.get(provider + '.work.history_id')).toBe('mail-cursor');
    expect(await f.account.get(provider + '.work.cal_delta_link.team')).toBe('calendar-cursor');
    expect(f.platform === 'mail' ? f.mailLife.restart : f.calLife.restart).toHaveBeenCalledOnce();
  });
  it('switches shared Microsoft Mail and Calendar together with their combined permissions', async () => {
    const f = await fixture('graph', true); const review = await f.review();
    expect(review.context.collections).toHaveLength(2); expect(review.context.requested_scopes).toEqual(expect.arrayContaining(['Mail.Read', 'Calendars.Read', 'offline_access']));
    await f.apply(review);
    for (const platform of ['mail', 'calendar'] as const) expect(f.instances.get(platform, 'work')).toMatchObject({ backfill_complete: true, config: { oauth_app_id: f.target.id } });
    expect(f.mailLife.stop).toHaveBeenCalledOnce(); expect(f.calLife.stop).toHaveBeenCalledOnce();
  });
  it.each(['different', 'unknown', 'scope', 'resource', 'public', 'expiry'] as const)('refuses %s evidence while preserving the old app and every live token', async failure => {
    const f = await fixture(); const before = f.instances.get('mail', 'work'); const tokens = await f.account.getAll();
    if (failure === 'different') f.targetOwner('other@example.test');
    if (failure === 'unknown') f.unknown();
    if (failure === 'scope') f.grant([]);
    if (failure === 'resource') f.deny('/labels/team');
    if (failure === 'public') f.anonymous(200);
    if (failure === 'expiry') f.expire();
    await expect(f.review()).rejects.toBeTruthy();
    expect(f.instances.get('mail', 'work')).toEqual(before); expect(await f.account.getAll()).toEqual(tokens);
    expect(f.mailLife.stop).not.toHaveBeenCalled();
  });
  it('requires the full existing write scope even when protected reads work', async () => {
    const f = await fixture(); await f.account.set('gmail.work.granted_scopes', f.scopes.join(' ') + ' https://www.googleapis.com/auth/gmail.send');
    await expect(f.review()).rejects.toThrow('every permission');
  });
  it('reviews permissions reported by renewal before building the requested scope list', async () => {
    const f = await fixture(); f.grant([...f.scopes, 'https://www.googleapis.com/auth/gmail.send']);
    await f.account.set('gmail.work.expires_at', '0');
    const ctx = await f.context();
    expect(ctx.requested_scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(await f.apply(await f.review())).toMatchObject({ outcome: { status: 'applied' } });
    expect(f.instances.get('mail', 'work')!.config.native_send_enabled).toBe(true);
  });
  it('fences app changes and removed group members before exchange or apply', async () => {
    const f = await fixture('graph', true); const auth = await f.authorize();
    f.apps.saveApp({ issuer: 'microsoft', id: f.target.id, expected_revision: 1, label: 'Updated', client_id: f.target.client_id });
    await expect(f.call({ action: 'collection_authentication_app_review', authorization_id: auth.id, code: 'fixture', redirect_uri: 'https://app.recued.com/oauth-callback' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const g = await fixture('graph', true); const review = await g.review(); const tokens = await g.account.getAll();
    g.instances.delete('calendar', 'work'); expect(await g.apply(review)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    expect(await g.account.getAll()).toEqual(tokens);
  });
  it('retires a candidate that finishes after cancellation without touching live tokens', async () => {
    const f = await fixture(); const auth = await f.authorize(); const before = await f.account.getAll();
    let release!: () => void; f.tokenGate(new Promise<void>(done => { release = done; }));
    const pending = f.call({ action: 'collection_authentication_app_review', authorization_id: auth.id, code: 'fixture', redirect_uri: 'https://app.recued.com/oauth-callback' });
    await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    await f.call({ action: 'collection_authentication_app_retire', id: auth.id }); release();
    await expect(pending).rejects.toMatchObject({ code: 'conflict' }); expect(await f.account.getAll()).toEqual(before);
  });
  it('rolls tokens, rows and receipt back together if the atomic commit fails', async () => {
    const f = await fixture(); const review = await f.review(); const before = await f.account.getAll(); const row = f.instances.get('mail', 'work');
    f.deltas.length = 0;
    f.db.exec("CREATE TRIGGER fail_app_switch BEFORE UPDATE OF config_json ON collection_instances BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'failed' } });
    expect(await f.account.getAll()).toEqual(before); expect(f.instances.get('mail', 'work')).toEqual(row);
    expect(f.deltas).toEqual([]);
    expect(f.mailLife.restart).toHaveBeenCalledOnce();
  });
  it('rejects source permission changes during the final access check', async () => {
    const f = await fixture(); const review = await f.review();
    const fetch = f.fetcher.getMockImplementation()!; let controls = 0;
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'GET' && !init.headers?.Authorization && ++controls === 2) {
        await f.account.set('gmail.work.granted_scopes', f.scopes.join(' ') + ' https://www.googleapis.com/auth/gmail.send');
      }
      return response;
    });
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    expect(f.instances.get('mail', 'work')!.config.oauth_app_id).toBeUndefined();
    expect(await f.account.get('gmail.work.refresh_token')).toBe('old-refresh');
    expect(await f.account.get('gmail.work.granted_scopes')).toContain('gmail.send');
    expect(f.mailLife.restart).toHaveBeenCalledOnce();
  });
  it('does not retain applied-only restart recovery after a receipt transaction rolls back', async () => {
    const f = await fixture(); const review = await f.review(); const before = await f.account.getAll();
    f.db.exec("CREATE TRIGGER fail_switch_receipt BEFORE UPDATE ON collection_oauth_app_switch_attempts WHEN json_extract(NEW.outcome_json, '$.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
    const result = await f.apply(review);
    expect(result).toMatchObject({ outcome: { status: 'failed' } });
    if (result.action !== 'collection_authentication_app_apply') throw Error('apply');
    expect(result.outcome).not.toHaveProperty('restart_needed');
    expect(await f.account.getAll()).toEqual(before);
    expect(f.instances.get('mail', 'work')!.config.oauth_app_id).toBeUndefined();
    expect(await f.call({ action: 'collection_authentication_app_status', attempt_id: 'a'.repeat(43) })).toMatchObject({ outcome: result.outcome });
    expect(f.mailLife.restart).toHaveBeenCalledOnce();
  });
  it('compares source permission evidence atomically with the token swap', async () => {
    const f = await fixture(); const review = await f.review(); const write = f.account.transactionalWrite!;
    f.account.transactionalWrite = (entries, commit) => {
      if (commit) f.db.prepare('UPDATE account_store SET data = ? WHERE key = ?')
        .run(JSON.stringify(f.scopes.join(' ') + ' https://www.googleapis.com/auth/gmail.send'), 'gmail.work.granted_scopes');
      write(entries, commit);
    };
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    expect(await f.account.get('gmail.work.refresh_token')).toBe('old-refresh');
    expect(f.instances.get('mail', 'work')!.config.oauth_app_id).toBeUndefined();
    expect(f.mailLife.restart).toHaveBeenCalledOnce();
  });
  it('recovers an applied receipt without repeating consent or apply, including restart failure', async () => {
    const f = await fixture(); const review = await f.review(); f.mailLife.restart.mockRejectedValueOnce(Error('restart')); f.mailLife.running.mockReturnValue(false);
    const result = await f.apply(review); expect(result).toMatchObject({ outcome: { status: 'applied', restart_needed: [{ platform: 'mail', slug: 'work' }] } });
    expect(await f.apply(review)).toEqual(result); expect(f.mailLife.stop).toHaveBeenCalledOnce();
    f.mailLife.running.mockReturnValue(true);
    const reopened = createCollectionOAuthAppSwitchService(f.deps);
    expect(await reopened.handle({ action: 'collection_authentication_app_status', attempt_id: 'a'.repeat(43) })).toMatchObject({ outcome: { status: 'applied' } });
    const status = await reopened.handle({ action: 'collection_authentication_app_status', attempt_id: 'a'.repeat(43) });
    if (status.action !== 'collection_authentication_app_status') throw Error('status');
    expect(status.outcome).not.toHaveProperty('restart_needed');
  });
  it('shares migration locks with the existing saved-API authentication switch', async () => {
    const f = await fixture(); const review = await f.review(); const locks = collectionAuthenticationLocks(f.db); locks.add('mail:work');
    await expect(f.apply(review)).rejects.toMatchObject({ code: 'conflict' }); locks.delete('mail:work');
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
  });
  it('expires a prepared review without applying or replacing any token', async () => {
    const f = await fixture(); const review = await f.review(); const tokens = await f.account.getAll();
    f.clock(review.expires_at + 1); await expect(f.apply(review)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.account.getAll()).toEqual(tokens); expect(f.mailLife.stop).not.toHaveBeenCalled();
  });
  it('rejects an old in-flight refresh after applying the new app grant', async () => {
    const f = await fixture(); const review = await f.review();
    let release!: () => void; f.tokenGate(new Promise<void>(done => { release = done; }));
    const refresh = refreshAccessToken({ provider: 'gmail', slug: 'work', providerConfig: f.config('gmail')!, accountStore: f.account, fetcher: f.fetcher, now: () => 1000 });
    await vi.waitFor(() => expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } }); release();
    await expect(refresh).rejects.toThrow('oauth_grant_changed'); expect(await f.account.get('gmail.work.refresh_token')).toBe('new-refresh');
  });
  it('renews through the actual Calendar factory using the newly selected app', async () => {
    const f = await fixture('gcal'); await f.apply(await f.review());
    await f.account.set('gcal.work.expires_at', '0'); f.fetcher.mockClear();
    const factory = createGcalAdapterFactory({ accountStore: f.account, providerConfig: appId => f.config('gcal', appId), fetcher: f.fetcher, now: () => 1000 });
    const caps = await factory.probeCaps({ slug: 'work', config: f.instances.get('calendar', 'work')!.config, getAccountValue: key => f.account.get('gcal.work.' + key) });
    expect(caps.create_event).toBe('no');
    const renewal = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(new URLSearchParams(renewal[1]!.body).get('client_id')).toBe('new-client');
  });
  it.each(['gmail', 'graph'] as const)('keeps %s send and mutation disabled when the new grant is broader', async provider => {
    const f = await fixture(provider);
    f.grant(provider === 'gmail' ? [...f.scopes, 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify']
      : [...f.scopes, 'Mail.Send', 'Mail.ReadWrite']);
    await f.apply(await f.review());
    const bus = createWarehouseEventBus();
    const stack = composeMailStack(f.db, { bus,
      blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
      getGate: () => ({ addUsed() {}, setUsed() {}, info: () => ({ surface: 'test', used: 0, quota: 1000000, reservePct: 0, state: 'healthy' }) }) as never,
    }, { accountStore: f.account, oauthConfig: f.config, isVaultUnlocked: () => false, fetcher: f.fetcher });
    try {
      await stack.startAll(); const live = stack.listLive()[0]!;
      expect(live.sendCapable).toBe(false); expect(live.draftCapable).toBe(false);
      expect((await handleMailList(f.mail)).instances[0]!.send_capable).toBe(false);
      expect(await f.account.get(provider + '.work.granted_scopes')).toContain(provider === 'gmail' ? 'gmail.send' : 'Mail.Send');
    } finally { await stack.disposeAll(); bus.dispose(); }
  });
  it('preserves opted-in Microsoft send and calendar editing while switching a shared grant', async () => {
    const f = await fixture('graph', true);
    // A grant from before 2026-10-15: Mail.Send without the Mail.ReadWrite the
    // send's draft needs. The switch keeps the choice to send and mends it.
    await f.account.set('graph.work.granted_scopes', 'Mail.Read Mail.Send Calendars.ReadWrite');
    f.instances.updateCaps('calendar', 'work', { ...calCaps, create_event: 'yes', update_event: 'yes', delete_event: 'yes', rsvp: 'yes' });
    f.grant(['Mail.Read', 'Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite']);
    const review = await f.review();
    expect(review.context.requested_scopes).toEqual(expect.arrayContaining(['Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite']));
    await f.apply(review);
    expect(f.instances.get('mail', 'work')!.config.native_send_enabled).toBe(true);
    expect(f.instances.get('calendar', 'work')!.config.native_write_enabled).toBe(true);
  });

  it('refuses a new Microsoft sign-in for a sending mailbox that leaves out Mail.ReadWrite', async () => {
    const f = await fixture('graph', true);
    await f.account.set('graph.work.granted_scopes', 'Mail.Read Mail.Send');
    f.grant(['Mail.Read', 'Mail.Send']);
    // ⛔ It could not send: the send writes a draft first, which needs Mail.ReadWrite.
    await expect(f.review()).rejects.toThrow('The new sign-in must grant every permission needed by the existing collection.');
  });
});


describe('reauthorize the current native OAuth app', () => {
  const prepare = async (f: Awaited<ReturnType<typeof fixture>>, scopes: readonly string[] = [], permissions?: readonly CollectionPermissionChoices[]) => {
    const context = await f.call({ action: 'collection_authentication_app_context', platform: f.platform, slug: 'work', intent: 'reauthorize', scopes,
      ...(permissions ? { permissions } : {}) });
    if (context.action !== 'collection_authentication_app_context') throw Error('context');
    const authorization = await f.call({ action: 'collection_authentication_app_authorize', context_id: context.context.id,
      fingerprint: context.context.fingerprint, app_id: context.context.current_app.id, expected_revision: context.context.current_app.revision });
    if (authorization.action !== 'collection_authentication_app_authorize') throw Error('authorization');
    const review = await f.call({ action: 'collection_authentication_app_review', authorization_id: authorization.authorization.id,
      code: 'fresh-consent', redirect_uri: 'https://app.recued.com/oauth-callback' });
    if (review.action !== 'collection_authentication_app_review') throw Error('review');
    return review.review;
  };
  it.each(['gmail', 'gcal', 'graph'] as const)('reauthorizes %s in place and replaces tokens only after verified apply', async provider => {
    const f = await fixture(provider, provider === 'graph'); if (provider === 'graph') f.grant([...f.scopes, 'User.Read']); const old = f.instances.get(f.platform, 'work')!; const tokens = await f.account.getAll();
    const review = await prepare(f); expect(review.context.intent).toBe('reauthorize'); expect(review.app.id).toBe('default');
    expect(await f.account.getAll()).toEqual(tokens); expect(f.mailLife.stop).not.toHaveBeenCalled();
    expect(await f.apply(review)).toMatchObject({ outcome: { intent: 'reauthorize', status: 'applied', app_id: 'default' } });
    const current = f.instances.get(f.platform, 'work')!;
    expect(current).toMatchObject({ slug: old.slug, created_at: old.created_at, last_synced_at: old.last_synced_at, backfill_complete: true });
    expect(current.config).toMatchObject(old.config); expect(await f.account.get(provider + '.work.refresh_token')).toBe('new-refresh');
    expect(await f.account.get(provider + '.work.history_id')).toBe('mail-cursor');
    if (provider === 'graph') expect(f.calLife.restart).toHaveBeenCalledOnce();
  });
  it('retains prior grants and requests the additional permissions in the review', async () => {
    const f = await fixture(); const extra = 'https://www.googleapis.com/auth/gmail.labels';
    await f.account.set('gmail.work.granted_scopes', [...f.scopes, extra].join(' '));
    f.grant([...f.scopes, extra, 'https://www.googleapis.com/auth/gmail.modify']);
    const review = await prepare(f, ['https://www.googleapis.com/auth/gmail.modify']);
    expect(review.context.requested_scopes).toEqual(expect.arrayContaining([extra, ...f.scopes, 'https://www.googleapis.com/auth/gmail.modify']));
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
  });
  it.each(['scope', 'account'] as const)('rejects partial grants or a different account during %s repair', async reason => {
    const f = await fixture(); const original = await f.account.getAll(); const row = f.instances.get('mail', 'work');
    if (reason === 'account') f.targetOwner('other@example.test');
    await expect(prepare(f, reason === 'scope' ? ['https://www.googleapis.com/auth/gmail.labels'] : [])).rejects.toBeTruthy();
    expect(await f.account.getAll()).toEqual(original); expect(f.instances.get('mail', 'work')).toEqual(row); expect(f.mailLife.stop).not.toHaveBeenCalled();
  });
  it('can repair a refused old token using the previously verified corpus identity', async () => {
    const f = await fixture(); await f.context();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => init?.headers?.Authorization === 'Bearer old-access'
      ? { ok: false, status: 401, json: async () => ({}), text: async () => '' } : original(url, init));
    const review = await prepare(f); expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
  });
  it('refuses unconfirmed old identity and invalid scope requests without overwriting data', async () => {
    const f = await fixture(); f.deny('/profile'); const old = await f.account.getAll();
    await expect(prepare(f)).rejects.toBeTruthy();
    expect(await f.account.getAll()).toEqual(old);
    for (const scopes of [['read write'], ['a,b'], new Array(257).fill('read')]) {
      await expect(f.call({ action: 'collection_authentication_app_context', platform: 'mail', slug: 'work', intent: 'reauthorize', scopes })).rejects.toMatchObject({ code: 'bad_request' });
    }
  });
  it('rejects changing the app from a current-app consent review', async () => {
    const f = await fixture(); const context = await f.call({ action: 'collection_authentication_app_context', platform: 'mail', slug: 'work', intent: 'reauthorize' });
    if (context.action !== 'collection_authentication_app_context') throw Error('context');
    await expect(f.call({ action: 'collection_authentication_app_authorize', context_id: context.context.id,
      fingerprint: context.context.fingerprint, app_id: f.target.id, expected_revision: f.target.revision })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('rejects a replaced local grant after consent without overwriting its newer credentials', async () => {
    const f = await fixture(); const review = await prepare(f);
    await f.account.set('gmail.work.grant_generation', 'new-owner-authorization');
    await f.account.set('gmail.work.refresh_token', 'keep-newer-refresh');
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'failed', reason: 'changed' } });
    expect(await f.account.get('gmail.work.refresh_token')).toBe('keep-newer-refresh'); expect(f.mailLife.stop).not.toHaveBeenCalled();
  });

  it.each(['gmail', 'graph'] as const)('enables %s sending without enabling organization, including real provider reconstruction', async provider => {
    const f = await fixture(provider);
    const choices: CollectionPermissionChoices = { platform: 'mail', slug: 'work', read: true, send: true, organize: false };
    f.grant(provider === 'gmail' ? [...f.scopes, 'https://www.googleapis.com/auth/gmail.send'] : [...f.scopes, 'Mail.Send', 'Mail.ReadWrite', 'User.Read']);
    const before = f.instances.get('mail', 'work')!; const tokens = await f.account.getAll();
    const review = await prepare(f, [], [choices]);
    expect(review.context.collections[0]!.permissions).toEqual({ current: { ...choices, send: false }, selected: choices });
    expect(review.context.requested_scopes).toContain(provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.ReadWrite');
    expect(f.instances.get('mail', 'work')).toEqual(before); expect(await f.account.getAll()).toEqual(tokens);
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
    expect(f.instances.get('mail', 'work')!.config).toMatchObject({ ...before.config, native_send_enabled: true, native_mutation_enabled: false });
    const bus = createWarehouseEventBus();
    const stack = composeMailStack(f.db, { bus,
      blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
      getGate: () => ({ addUsed() {}, setUsed() {}, info: () => ({ surface: 'test', used: 0, quota: 1000000, reservePct: 0, state: 'healthy' }) }) as never,
    }, { accountStore: f.account, oauthConfig: f.config, isVaultUnlocked: () => false, fetcher: f.fetcher });
    try { await stack.startAll(); const live = stack.listLive()[0]!;
      expect(live.sendCapable).toBe(true); expect(live.mutationCapable).toBe(false);
      expect((await handleMailList(f.mail)).instances[0]!.send_capable).toBe(true);
    } finally { await stack.disposeAll(); bus.dispose(); }
  });
  it.each([{ scopes: ['Mail.Read', 'Mail.Send', 'User.Read'] }, { scopes: ['Mail.ReadWrite', 'User.Read'] }])('rejects incomplete Microsoft send evidence $scopes', async ({ scopes }) => {
    const f = await fixture('graph'); f.grant(scopes); const before = await f.account.getAll();
    await expect(prepare(f, [], [{ platform: 'mail', slug: 'work', read: true, send: true, organize: false }])).rejects.toBeTruthy();
    expect(await f.account.getAll()).toEqual(before); expect(f.instances.get('mail', 'work')!.config.native_send_enabled).toBeUndefined();
    expect(f.mailLife.stop).not.toHaveBeenCalled();
  });
  it('requests event editing without calendar administration and atomically updates the Calendar caps', async () => {
    const f = await fixture('gcal'); f.grant([...f.scopes, 'https://www.googleapis.com/auth/calendar.events']);
    const before = f.instances.get('calendar', 'work')!;
    const review = await prepare(f, [], [{ platform: 'calendar', slug: 'work', read: true, edit_events: true }]);
    expect(review.context.requested_scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(review.context.requested_scopes).not.toContain('https://www.googleapis.com/auth/calendar');
    expect(f.instances.get('calendar', 'work')).toEqual(before);
    await f.apply(review); expect(f.instances.get('calendar', 'work')).toMatchObject({ backfill_complete: true, last_synced_at: before.last_synced_at,
      config: { ...before.config, native_write_enabled: true }, caps: { create_event: 'yes', update_event: 'yes', delete_event: 'yes', rsvp: 'yes' } });
    const factory = createGcalAdapterFactory({ accountStore: f.account, providerConfig: appId => f.config('gcal', appId), fetcher: f.fetcher });
    expect(await factory.probeCaps({ slug: 'work', config: f.instances.get('calendar', 'work')!.config, getAccountValue: key => f.account.get('gcal.work.' + key) })).toMatchObject({ create_event: 'yes' });
  });
  it('keeps other shared Microsoft choices while enabling sending for Mail', async () => {
    const f = await fixture('graph', true); f.grant([...f.scopes, 'Mail.Send', 'Mail.ReadWrite', 'User.Read']);
    const review = await prepare(f, [], [{ platform: 'mail', slug: 'work', read: true, send: true, organize: false }]);
    const calendar = review.context.collections.find(c => c.platform === 'calendar')!;
    expect(calendar.permissions!.selected).toEqual({ platform: 'calendar', slug: 'work', read: true, edit_events: false });
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
    expect(f.instances.get('calendar', 'work')!.config.native_write_enabled).toBe(false);
    expect(f.instances.get('mail', 'work')!.config).toMatchObject({ native_send_enabled: true, native_mutation_enabled: false });
  });
  it('turns off local Calendar editing without revoking the retained vendor grant', async () => {
    const f = await fixture('gcal'); await f.account.set('gcal.work.granted_scopes', 'https://www.googleapis.com/auth/calendar');
    f.instances.updateCaps('calendar', 'work', { ...calCaps, create_event: 'yes', update_event: 'yes', delete_event: 'yes', rsvp: 'yes' });
    f.grant(['https://www.googleapis.com/auth/calendar']);
    const review = await prepare(f, [], [{ platform: 'calendar', slug: 'work', read: true, edit_events: false }]);
    expect(review.context.collections[0]!.permissions!.current).toMatchObject({ edit_events: true });
    expect(review.context.requested_scopes).toContain('https://www.googleapis.com/auth/calendar');
    await f.apply(review); expect(f.instances.get('calendar', 'work')).toMatchObject({ config: { native_write_enabled: false }, caps: { create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no' } });
    expect(await f.account.get('gcal.work.granted_scopes')).toBe('https://www.googleapis.com/auth/calendar');
    const create = vi.fn(async () => { throw Error('A disabled capability must not reach the provider'); });
    await expect(handleCalendarCreate({ instances: f.instances, getCollection: () => ({ provider: { createEvent: create } } as never) },
      { slug: 'work', calendar_id: 'team', event: {} as never })).rejects.toMatchObject({ code: 'forbidden' });
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves individual restrictions on an unchanged shared Microsoft Calendar while enabling Mail sending', async () => {
    const f = await fixture('graph', true);
    const caps: CollectionCaps = { ...calCaps, create_event: 'yes', update_event: 'no', delete_event: 'no', rsvp: 'no' };
    f.instances.updateCaps('calendar', 'work', caps);
    await f.account.set('graph.work.granted_scopes', [...f.scopes, 'Calendars.ReadWrite'].join(' '));
    f.grant([...f.scopes, 'Calendars.ReadWrite', 'Mail.Send', 'Mail.ReadWrite', 'User.Read']);
    const review = await prepare(f, [], [
      { platform: 'mail', slug: 'work', read: true, send: true, organize: false },
      { platform: 'calendar', slug: 'work', read: true, edit_events: true },
    ]);
    expect(await f.apply(review)).toMatchObject({ outcome: { status: 'applied' } });
    expect(f.instances.get('calendar', 'work')!.caps).toEqual(caps);
  });
  it('does not enable a local capability merely because an advanced scope was granted', async () => {
    const f = await fixture('graph'); f.grant([...f.scopes, 'Mail.Send', 'Mail.ReadWrite', 'User.Read']);
    const review = await prepare(f, ['Mail.Send', 'Mail.ReadWrite']); await f.apply(review);
    expect(f.instances.get('mail', 'work')!.config).toMatchObject({ native_send_enabled: false, native_mutation_enabled: false });
  });
  it('rejects malformed, duplicate, unrelated and cross-platform choices without vendor requests or writes', async () => {
    const f = await fixture(); const original = await f.account.getAll(); const choice = { platform: 'mail', slug: 'work', read: true, send: true, organize: false };
    for (const permissions of [[{ ...choice, read: false }], [{ ...choice, send: 'true' }], [choice, choice], [{ ...choice, slug: 'other' }],
      [{ ...choice, edit_events: true }], [{ platform: 'calendar', slug: 'work', read: true, edit_events: true }]]) {
      const reads = f.fetcher.mock.calls.length;
      await expect(f.call({ action: 'collection_authentication_app_context', platform: 'mail', slug: 'work', intent: 'reauthorize',
        permissions: permissions as never })).rejects.toMatchObject({ code: 'bad_request' });
      expect(f.fetcher.mock.calls).toHaveLength(reads);
    }
    expect(await f.account.getAll()).toEqual(original); expect(f.mailLife.stop).not.toHaveBeenCalled();
  });

});
