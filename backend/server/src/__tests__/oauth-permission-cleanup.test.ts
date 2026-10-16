import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, isOAuthPermissionCleanupJob, isOAuthPermissionCleanupAuthorization,
  type CollectionCaps, type OAuthPermissionCleanupRequest, type OAuthPermissionCleanupJob, type OAuthPermissionNeeds } from '@recued/contracts';
import { createServerAccountStore } from '../account-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createCalendarAdapterRegistry } from '../collections/calendar/adapter-registry.js';
import { createOAuthPermissionService } from '../oauth-permission-consolidation.js';
import { createOAuthPermissionCleanupService } from '../oauth-permission-cleanup.js';
import { createOAuthPermissionCleanupStore } from '../oauth-permission-cleanup-store.js';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
import { getAccessToken, refreshAccessToken, exchangeCodeForTokens, type HttpFetcher } from '../collections/mail/oauth.js';
import { collectionAuthenticationLocks } from '../collection-authentication-locks.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { createCollectionOAuthAppSwitchService } from '../collection-oauth-app-switch.js';
import { handleMailDelete } from '../collections/mail/enroll.js';
import { handleCalendarDelete } from '../collections/calendar/enroll.js';

const read = 'https://www.googleapis.com/auth/gmail.readonly'; const sheets = 'https://www.googleapis.com/auth/spreadsheets';
const calRead = 'https://www.googleapis.com/auth/calendar.readonly';
const dbs: Database.Database[] = []; afterEach(() => { vi.restoreAllMocks(); dbs.splice(0).forEach(db => db.close()); });
const mailCaps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', auth: 'oauth', watch: 'poll', mirror: 'required', path_style: 'uri' };
const calCaps: CollectionCaps = { read: 'yes', list_calendars: 'yes', create_event: 'no', update_event: 'no', delete_event: 'no', rsvp: 'no', search: 'local', auth: 'oauth', watch: 'poll', recurrence: 'server' };
const fixture = async (shared = false) => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 1000; let locked = false;
  const key = () => locked ? null : Buffer.alloc(32, 7);
  const account = createServerAccountStore(db); const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key });
  apps.setIssuer('google', 'fixture-client', 'fixture-secret');
  const instances = createInstanceStore({ db, now: () => clock }); const connections = createConnectionStore(db);
  let needs: OAuthPermissionNeeds = { complete: true, requirements: [], warnings: [] };
  let granted = [read, ...(shared ? [calRead] : []), 'email']; let owner = 'owner@example.test'; let anonymousStatus = 401; let denied = '';
  let tokenGate: Promise<void> | undefined; let shortExpiry = false; let exchanges = 0;
  const owners = new Map<string, string>();
  const fetcher = vi.fn<HttpFetcher>(async (raw, init) => {
    const url = new URL(raw); const token = init?.headers?.Authorization;
    if (init?.method === 'POST') {
      expect(url.toString()).toBe(GOOGLE_TOKEN_URL); await tokenGate;
      const sequence = ++exchanges;
      return { status: 200, ok: true, text: async () => '', json: async () => ({ access_token: 'fixture-new-access-' + sequence, refresh_token: 'fixture-new-refresh-' + sequence,
        expires_in: shortExpiry ? 1 : 3600, scope: granted.join(' ') }) };
    }
    if (!token) return { status: anonymousStatus, ok: anonymousStatus < 400, json: async () => ({}), text: async () => '' };
    if (denied && url.pathname.includes(denied)) return { status: 403, ok: false, json: async () => ({}), text: async () => '' };
    const address = token.startsWith('Bearer fixture-new-access-') ? owner : owners.get(token) ?? 'owner@example.test';
    const value = url.pathname.endsWith('/profile') ? { emailAddress: address } : url.pathname.endsWith('/calendars/primary') ? { id: address }
      : url.pathname.endsWith('/messages') ? { messages: [{ id: 'message' }] } : { id: 'team', items: [] };
    return { status: 200, ok: true, json: async () => value, text: async () => '' };
  });
  const config = (_provider: string, id?: string) => {
    const clientId = apps.getClientId('google', id); return clientId ? { clientId, clientSecret: apps.getClientSecret('google', id)!, tokenUrl: GOOGLE_TOKEN_URL } : null;
  };
  const mailLife = { stop: vi.fn(async (_s: string) => {}), restart: vi.fn(async (_s: string) => {}) };
  const calLife = { stop: vi.fn(async (_s: string) => {}), restart: vi.fn(async (_s: string) => {}) };
  const mail = { instances, accountStore: account, oauthConfig: config, fetcher, authenticationChange: mailLife };
  const calendar = { ...mail, adapters: createCalendarAdapterRegistry(), authenticationChange: calLife };
  const add = async (provider: 'gmail' | 'gcal', slug = 'work', address = 'owner@example.test', appId?: string) => {
    const platform = provider === 'gmail' ? 'mail' : 'calendar';
    instances.upsert({ platform, slug, adapter_type: provider, config: { account_slug: slug, account_email: address,
      ...(appId ? { oauth_app_id: appId } : {}), [provider === 'gmail' ? 'label_filter' : 'calendar_filter']: ['team'] },
      caps: provider === 'gmail' ? mailCaps : calCaps, auth_state: 'healthy', last_synced_at: 444 });
    instances.markBackfillComplete(platform, slug); owners.set('Bearer fixture-old-' + provider + slug, address);
    for (const [name, value] of Object.entries({ access_token: 'fixture-old-' + provider + slug, refresh_token: 'fixture-old-refresh', expires_at: '99999999',
      granted_scopes: [provider === 'gmail' ? read : calRead, sheets, 'email'].join(' '), history_id: 'keep-history', sync_cursor: 'keep-cursor' })) await account.set(provider + '.' + slug + '.' + name, value);
  };
  await add('gmail'); if (shared) await add('gcal');
  const permissions = createOAuthPermissionService({ apps, instances, rows: () => connections.list(), accountStore: account, key,
    connectionUses: () => ({ complete: true, uses: [] }), requirements: () => ({ complete: true, requirements: [], warnings: [] }), nativeRequirements: () => needs, now: () => clock });
  const deps = { db, instances, apps, permissions, accountStore: account, mail, calendar, key, now: () => clock, anonymous: fetcher };
  const service = createOAuthPermissionCleanupService(deps);
  const handlers = makeOAuthAppConfigHandlers({ store: apps, permissions, cleanup: service })!.handlers;
  const call = (r: OAuthPermissionCleanupRequest) => handlers['server.oauthApps'](r, undefined as never);
  const job = async (request: OAuthPermissionCleanupRequest): Promise<OAuthPermissionCleanupJob> => {
    const result = await call(request); if (!isOAuthPermissionCleanupJob(result.permission_cleanup_job)) throw Error('Missing valid job'); return result.permission_cleanup_job;
  };
  const prepare = async () => {
    const result = await handlers['server.oauthApps']({ action: 'permission_inventory' }, undefined as never); const inv = result.permission_inventory!;
    expect(result.permission_cleanup_available).toBe(true);
    return job({ action: 'prepare_permission_cleanup', inventory_fingerprint: inv.fingerprint, group_id: inv.groups.find(g => g.native_accounts.some(t => t.platform === 'mail' && t.slug === 'work'))!.id, selected_scopes: [sheets] });
  };
  const pause = async (value?: OAuthPermissionCleanupJob) => { const j = value ?? await prepare(); return job({ action: 'pause_permission_cleanup', id: j.id, expected_revision: j.revision, confirm_shared_access: true }); };
  const authorize = async (value?: OAuthPermissionCleanupJob, reset = true) => { const j = value ?? await pause();
    const result = await call({ action: 'authorize_permission_cleanup', id: j.id, expected_revision: j.revision, reset_confirmed: reset });
    if (!isOAuthPermissionCleanupAuthorization(result.permission_cleanup_authorization) || !isOAuthPermissionCleanupJob(result.permission_cleanup_job)) throw Error('Missing authorization');
    return { job: result.permission_cleanup_job, auth: result.permission_cleanup_authorization };
  };
  const reviewOne = async (value?: OAuthPermissionCleanupJob) => { const a = await authorize(value); return job({ action: 'review_permission_cleanup', id: a.job.id,
    expected_revision: a.job.revision, authorization_id: a.auth.id, code: a.auth.id, redirect_uri: 'https://app.recued.com/oauth-callback' }); };
  const review = async (value?: OAuthPermissionCleanupJob) => { let current = value;
    for (let n = 0; n < 16; n++) { current = await reviewOne(current); if (current.status === 'ready_to_apply') return current; }
    throw Error('Incomplete fixture review');
  };
  const apply = (j: OAuthPermissionCleanupJob) => job({ action: 'apply_permission_cleanup', id: j.id, expected_revision: j.revision });
  const status = (j: OAuthPermissionCleanupJob) => job({ action: 'permission_cleanup_status', id: j.id });
  return { db, deps, key, account, apps, instances, connections, service, handlers, call, job, prepare, pause, authorize, reviewOne, review, apply, status, add, config,
    mailLife, calLife, fetcher, grant: (v: string[]) => { granted = v; }, owner: (v: string) => { owner = v; },
    clock: (v: number) => { clock = v; }, lock: () => { locked = true; }, deny: (v: string) => { denied = v; },
    gate: (v?: Promise<void>) => { tokenGate = v; }, anonymous: (v: number) => { anonymousStatus = v; }, expire: () => { shortExpiry = true; },
    needs: (v: OAuthPermissionNeeds) => { needs = v; } };
};

describe('guided Google permission cleanup', () => {
  it('prepares a public recovery plan without pausing, changing grants or contacting consent endpoints', async () => {
    const f = await fixture(); const before = await f.account.getAll(); const j = await f.prepare();
    expect(j).toMatchObject({ status: 'prepared', mode: 'cleanup', selected_scopes: [sheets], requested_scopes: ['email', read], verification: 'not_checked' });
    expect(await f.account.getAll()).toEqual(before); expect(f.mailLife.stop).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.every(([url, init]) => init?.method !== 'POST' && !url.includes('revoke'))).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/fixture-secret|fixture-old-refresh|access_token/);
  });
  it('pauses every native sign-in for this Google account before manual vendor reset', async () => {
    const f = await fixture(true); const j = await f.pause();
    expect(j.status).toBe('awaiting_reset'); expect(j.targets).toHaveLength(2);
    expect(f.mailLife.stop).toHaveBeenCalledWith('work'); expect(f.calLife.stop).toHaveBeenCalledWith('work');
    for (const provider of ['gmail', 'gcal']) {
      expect(await f.account.get(provider + '.work.permission_cleanup_pending')).toBe(j.id);
      expect(await f.account.get(provider + '.work.refresh_token')).toBe('fixture-old-refresh');
      expect(await f.account.get(provider + '.work.granted_scopes')).toContain(sheets);
    }
    expect(f.instances.get('mail', 'work')?.auth_state).toBe('expired');
  });
  it('requires explicit owner confirmation before pausing and before requesting new consent', async () => {
    const f = await fixture(); const j = await f.prepare();
    await expect(f.call({ action: 'pause_permission_cleanup', id: j.id, expected_revision: j.revision, confirm_shared_access: false } as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.mailLife.stop).not.toHaveBeenCalled(); const paused = await f.pause(j);
    await expect(f.authorize(paused, false)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('verifies a reduced grant and atomically saves it across Mail and Calendar without changing their corpus or cursors', async () => {
    const f = await fixture(true); const before = f.instances.list(); const j = await f.review();
    expect(j).toMatchObject({ status: 'ready_to_apply', reset_confirmation: 'owner_confirmed', verification: 'fresh_grant_checked' });
    expect(await f.account.get('gmail.work.granted_scopes')).toContain(sheets);
    const saved = await f.apply(j); expect(saved.status).toBe('applied');
    for (const provider of ['gmail', 'gcal']) {
      expect(await f.account.get(provider + '.work.refresh_token')).toMatch(/^fixture-new-refresh-/);
      expect(await f.account.get(provider + '.work.granted_scopes')).not.toContain(sheets);
      expect(await f.account.get(provider + '.work.permission_cleanup_pending')).toBeNull();
      expect(await f.account.get(provider + '.work.history_id')).toBe('keep-history'); expect(await f.account.get(provider + '.work.sync_cursor')).toBe('keep-cursor');
    }
    expect(await f.account.get('gmail.work.refresh_token')).not.toBe(await f.account.get('gcal.work.refresh_token'));
    for (const row of before) expect(f.instances.get(row.platform, row.slug)).toMatchObject(row);
    expect(f.mailLife.restart).toHaveBeenCalledOnce(); expect(f.calLife.restart).toHaveBeenCalledOnce();
    const reconnect = await createCollectionOAuthAppSwitchService(f.deps).handle({ action: 'collection_authentication_app_context', platform: 'mail', slug: 'work', intent: 'reauthorize' });
    if (reconnect.action !== 'collection_authentication_app_context') throw Error('Missing reconnect context');
    expect(reconnect.context.requested_scopes).not.toContain(sheets);
    const history = createOAuthPermissionCleanupStore(f.db, f.key, () => 1000).get(j.id);
    expect(Object.values(history.original_scopes).every(s => s.includes(sheets))).toBe(true); expect(history.candidates).toBeUndefined();
    const calls = f.fetcher.mock.calls.length; await f.apply(j); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each(['retained scope', 'missing requirements', 'wrong account', 'anonymous success', 'denied folder', 'expired token'])('keeps the saved grant paused and unchanged after %s', async scenario => {
    const f = await fixture(); const paused = await f.pause();
    if (scenario === 'retained scope') f.grant([read, sheets, 'email']);
    if (scenario === 'missing requirements') f.grant(['email']);
    if (scenario === 'wrong account') f.owner('other@example.test');
    if (scenario === 'anonymous success') f.anonymous(200);
    if (scenario === 'denied folder') f.deny('/labels/team');
    if (scenario === 'expired token') f.expire();
    await expect(f.review(paused)).rejects.toBeInstanceOf(Error);
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
    expect(await f.account.get('gmail.work.granted_scopes')).toContain(sheets);
    expect((await f.status(paused))).toMatchObject({ status: 'awaiting_reconnect', verification: 'not_checked' });
    expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBe(paused.id);
    expect(f.mailLife.restart).not.toHaveBeenCalled();
  });
  it('resumes partial Mail and Calendar verification without sharing tokens or applying early', async () => {
    const f = await fixture(true); const first = await f.reviewOne();
    expect(first).toMatchObject({ status: 'awaiting_reconnect', verification: 'not_checked', reset_confirmation: 'owner_confirmed' });
    expect(first.verified_targets).toHaveLength(1);
    for (const provider of ['gmail', 'gcal']) expect(await f.account.get(provider + '.work.refresh_token')).toBe('fixture-old-refresh');
    const resumed = createOAuthPermissionCleanupService(f.deps);
    expect(resumed.list()[0]?.verified_targets).toEqual(first.verified_targets);
    const authorization = await resumed.handle({ action: 'authorize_permission_cleanup', id: first.id, expected_revision: first.revision, reset_confirmed: true });
    const auth = authorization.permission_cleanup_authorization!;
    const result = await resumed.handle({ action: 'review_permission_cleanup', id: first.id, expected_revision: auth.revision,
      authorization_id: auth.id, code: auth.id, redirect_uri: 'https://app.recued.com/oauth-callback' });
    const complete = result.permission_cleanup_job!;
    expect(complete.status).toBe('ready_to_apply'); expect(complete.verified_targets).toHaveLength(2);
    await f.apply(complete);
    expect(await f.account.get('gmail.work.refresh_token')).not.toBe(await f.account.get('gcal.work.refresh_token'));
  });
  it('rejects premature review or apply without changing a prepared task or pausing access', async () => {
    const f = await fixture(); const j = await f.prepare();
    await expect(f.apply(j)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.job({ action: 'review_permission_cleanup', id: j.id, expected_revision: j.revision,
      authorization_id: 'a'.repeat(43), code: 'unexpected', redirect_uri: 'https://app.recued.com/oauth-callback' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.status(j)).toEqual(j); expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBeNull();
    expect((await f.pause(j)).status).toBe('awaiting_reset');
  });
  it('refuses saving partially verified grants and leaves all live credentials unchanged', async () => {
    const f = await fixture(true); const first = await f.reviewOne();
    await expect(f.apply(first)).rejects.toMatchObject({ code: 'conflict' });
    for (const provider of ['gmail', 'gcal']) expect(await f.account.get(provider + '.work.refresh_token')).toBe('fixture-old-refresh');
    expect((await f.status(first)).verification).toBe('not_checked');
  });
  it('requires a new owner confirmation and fresh checks after repeating the Google reset', async () => {
    const f = await fixture(true); const first = await f.reviewOne();
    const reset = await f.job({ action: 'reset_permission_cleanup', id: first.id, expected_revision: first.revision });
    expect(reset).toMatchObject({ status: 'awaiting_reset', reset_confirmation: 'not_confirmed', verification: 'not_checked' });
    expect(reset.verified_targets).toBeUndefined();
    expect(createOAuthPermissionCleanupStore(f.db, f.key, () => 1000).get(first.id).candidates).toBeUndefined();
    await expect(f.authorize(reset, false)).rejects.toMatchObject({ code: 'bad_request' });
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
  });
  it('refuses inconsistent saved copies of the same Google client before pausing', async () => {
    const f = await fixture(true); const app = f.apps.saveApp({ issuer: 'google', label: 'Calendar app', client_id: 'fixture-client', client_secret: 'different-secret' });
    const row = f.instances.get('calendar', 'work')!;
    f.instances.upsert({ ...row, config: { ...row.config, oauth_app_id: app.id } });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.mailLife.stop).not.toHaveBeenCalled(); expect(f.calLife.stop).not.toHaveBeenCalled();
    expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBeNull();
  });
  it('retains an encrypted candidate and resume authority across server restarts', async () => {
    const f = await fixture(); const j = await f.review();
    const stored = f.db.prepare<[], { data_ciphertext: string }>('SELECT data_ciphertext FROM oauth_permission_cleanups').get()!;
    expect(stored.data_ciphertext).not.toMatch(/fixture-new-access|fixture-new-refresh|fixture-secret|spreadsheets/);
    collectionAuthenticationLocks(f.db).clear(); const resumed = createOAuthPermissionCleanupService(f.deps);
    expect(resumed.list()[0]).toMatchObject({ id: j.id, status: 'ready_to_apply' }); expect(collectionAuthenticationLocks(f.db).has('mail:work')).toBe(true);
    expect((await resumed.handle({ action: 'apply_permission_cleanup', id: j.id, expected_revision: j.revision })).permission_cleanup_job?.status).toBe('applied');
  });
  it('retires an expired candidate without changing the pending live grant or its history', async () => {
    const f = await fixture(); const j = await f.review(); f.clock(j.review_expires_at! + 1);
    const current = await f.status(j); expect(current).toMatchObject({ status: 'awaiting_reconnect', verification: 'not_checked' });
    expect(createOAuthPermissionCleanupStore(f.db, f.key, () => j.review_expires_at! + 1).get(j.id).candidates).toBeUndefined();
    await expect(f.apply(j)).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh'); expect(await f.account.get('gmail.work.granted_scopes')).toContain(sheets);
  });
  it('rejects consent authority that expires while the token endpoint is still responding', async () => {
    const f = await fixture(); const a = await f.authorize(); let release!: () => void;
    f.gate(new Promise(resolve => { release = resolve; }));
    const pending = f.job({ action: 'review_permission_cleanup', id: a.job.id, expected_revision: a.job.revision,
      authorization_id: a.auth.id, code: a.auth.id, redirect_uri: 'https://app.recued.com/oauth-callback' });
    const checked = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    f.clock(a.auth.expires_at); release(); await checked;
    const j = await f.status(a.job); expect(j.status).toBe('awaiting_reconnect'); expect(j.verified_targets).toBeUndefined();
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
  });
  it('records failed restarts and retries them without repeating the credential replacement', async () => {
    const f = await fixture(); const j = await f.review(); f.mailLife.restart.mockRejectedValueOnce(Error('start failed'));
    const saved = await f.apply(j); expect(saved).toMatchObject({ status: 'applied', restart_needed: [{ platform: 'mail', slug: 'work' }] });
    const token = await f.account.get('gmail.work.refresh_token'); const generation = await f.account.get('gmail.work.grant_generation');
    const retried = await f.job({ action: 'restart_permission_cleanup', id: saved.id, expected_revision: saved.revision });
    expect(retried.restart_needed).toBeUndefined(); expect(f.mailLife.restart).toHaveBeenCalledTimes(2);
    expect(await f.account.get('gmail.work.refresh_token')).toBe(token); expect(await f.account.get('gmail.work.grant_generation')).toBe(generation);
  });
  it('does not restart or degrade a replacement corpus that appears during another restart', async () => {
    const f = await fixture(true); const j = await f.review();
    const first = j.targets[0]!; const other = j.targets[1]!;
    if (first.platform === 'api' || other.platform === 'api') throw Error('Expected native fixture targets');
    const firstLife = first.platform === 'mail' ? f.mailLife : f.calLife;
    const otherLife = other.platform === 'mail' ? f.mailLife : f.calLife;
    firstLife.restart.mockImplementationOnce(async () => {
      f.instances.delete(other.platform, other.slug); f.clock(9000); await f.add(other.provider, other.slug);
    });
    const saved = await f.apply(j);
    expect(saved.restart_needed).toEqual([{ platform: other.platform, slug: other.slug }]);
    expect(otherLife.restart).not.toHaveBeenCalled();
    expect(f.instances.get(other.platform, other.slug)).toMatchObject({ created_at: 9000, auth_state: 'healthy' });
  });
  it('fences cached token reads, refresh and ordinary enrollment while cleanup is pending', async () => {
    const f = await fixture(); await f.pause(); const before = f.fetcher.mock.calls.length;
    const opts = { provider: 'gmail' as const, slug: 'work', providerConfig: f.config('gmail')!, accountStore: f.account, fetcher: f.fetcher, now: () => 1000 };
    await expect(getAccessToken(opts)).rejects.toMatchObject({ code: 'conflict' }); await expect(refreshAccessToken(opts)).rejects.toMatchObject({ code: 'conflict' });
    await expect(exchangeCodeForTokens({ ...opts, code: 'other-flow', redirectUri: 'https://app.recued.com/oauth-callback' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.fetcher).toHaveBeenCalledTimes(before);
  });
  it('requires finishing or restoring cleanup before deleting its Mail or Calendar corpus', async () => {
    const f = await fixture(true); await f.pause();
    await expect(handleMailDelete(f.deps.mail, { slug: 'work' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(handleCalendarDelete(f.deps.calendar, { slug: 'work' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.instances.get('mail', 'work')).not.toBeNull(); expect(f.instances.get('calendar', 'work')).not.toBeNull();
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
  });
  it('rejects an in-flight ordinary token exchange that crosses the pause fence', async () => {
    const f = await fixture(); const prepared = await f.prepare(); let release!: () => void;
    f.gate(new Promise(resolve => { release = resolve; }));
    const pending = exchangeCodeForTokens({ provider: 'gmail', slug: 'work', providerConfig: f.config('gmail')!, accountStore: f.account,
      fetcher: f.fetcher, code: 'older-sign-in', redirectUri: 'https://app.recued.com/oauth-callback', now: () => 1000 });
    const checked = expect(pending).rejects.toThrow('oauth_grant_changed');
    await vi.waitFor(() => expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const paused = await f.pause(prepared); release(); await checked;
    expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh'); expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBe(paused.id);
  });
  it('rejects a different grant even when its recorded scopes and generation are unchanged', async () => {
    const f = await fixture(); const prepared = await f.prepare();
    await f.account.set('gmail.work.refresh_token', 'another-account-refresh');
    await expect(f.pause(prepared)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.mailLife.stop).not.toHaveBeenCalled(); expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBeNull();
    expect(await f.account.get('gmail.work.refresh_token')).toBe('another-account-refresh');
  });
  it('offers restore access after a dependency starts requiring the removed permission', async () => {
    const f = await fixture(); const paused = await f.pause();
    f.needs({ complete: true, warnings: [], requirements: [{ scope: sheets, uses: [{ kind: 'pack', id: 'new-pack', label: 'New pack' }] }] });
    await expect(f.authorize(paused)).rejects.toMatchObject({ code: 'conflict' });
    const latest = await f.status(paused); const restore = await f.job({ action: 'restore_permission_cleanup', id: latest.id, expected_revision: latest.revision });
    expect(restore.mode).toBe('restore'); expect(restore.requested_scopes).toContain(sheets); f.grant([read, sheets, 'email']);
    const reviewed = await f.review(restore); expect((await f.apply(reviewed)).status).toBe('restored');
    expect(await f.account.get('gmail.work.granted_scopes')).toContain(sheets);
  });
  it('keeps retained permissions when a restore task is refreshed again', async () => {
    const f = await fixture(); const paused = await f.pause();
    const restore = await f.job({ action: 'restore_permission_cleanup', id: paused.id, expected_revision: paused.revision });
    const refreshed = await f.job({ action: 'refresh_permission_cleanup', id: restore.id, expected_revision: restore.revision });
    expect(refreshed.mode).toBe('restore'); expect(refreshed.requested_scopes).toContain(sheets);
    f.needs({ complete: true, warnings: [], requirements: [{ scope: sheets, uses: [{ kind: 'pack', id: 'added-pack', label: 'Added pack' }] }] });
    const current = await f.job({ action: 'refresh_permission_cleanup', id: refreshed.id, expected_revision: refreshed.revision });
    expect(current.requested_scopes).toContain(sheets); f.grant([read, sheets, 'email']);
    expect((await f.apply(await f.review(current))).status).toBe('restored');
  });
  it('recovers a failed stop after dependencies change, then restores access', async () => {
    const f = await fixture(); const prepared = await f.prepare(); f.mailLife.stop.mockRejectedValueOnce(Error('fixture stop failure'));
    await expect(f.pause(prepared)).rejects.toBeInstanceOf(Error); const stopping = await f.status(prepared);
    expect(stopping.status).toBe('stopping');
    f.needs({ complete: true, warnings: [], requirements: [{ scope: sheets, uses: [{ kind: 'pack', id: 'added-pack', label: 'Added pack' }] }] });
    await expect(f.pause(stopping)).rejects.toMatchObject({ code: 'conflict' });
    const restore = await f.job({ action: 'restore_permission_cleanup', id: stopping.id, expected_revision: stopping.revision });
    expect(restore).toMatchObject({ status: 'stopping', mode: 'restore' });
    const stopped = await f.pause(restore); expect(stopped.status).toBe('awaiting_reconnect');
    f.grant([read, sheets, 'email']); expect((await f.apply(await f.review(stopped))).status).toBe('restored');
  });
  it.each(['mail', 'calendar'] as const)('blocks cleanup while %s deletion is already stopping its adapter', async platform => {
    const f = await fixture(true); const j = await f.prepare(); let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const onDeleted = async () => { entered = true; await gate; };
    const removal = platform === 'mail' ? handleMailDelete({ ...f.deps.mail, onDeleted }, { slug: 'work' })
      : handleCalendarDelete({ ...f.deps.calendar, onDeleted }, { slug: 'work' });
    await vi.waitFor(() => expect(entered).toBe(true));
    try { await expect(f.pause(j)).rejects.toMatchObject({ code: 'conflict' }); }
    finally { release(); await removal; }
    expect(f.instances.get(platform, 'work')).toBeNull();
    for (const provider of ['gmail', 'gcal']) expect(await f.account.get(provider + '.work.permission_cleanup_pending')).toBeNull();
    expect((await f.status(j)).status).toBe('prepared');
  });
  it.each(['mail', 'calendar'] as const)('holds the %s deletion lease before a pause write can await', async platform => {
    const f = await fixture(true); const j = await f.prepare(); let release!: () => void; let blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; }); const get = f.account.get.bind(f.account);
    vi.spyOn(f.account, 'get').mockImplementation(async key => {
      if (!blocked && key.endsWith('.refresh_token') && collectionAuthenticationLocks(f.db).has(platform + ':work')) { blocked = true; await gate; }
      return get(key);
    });
    const pending = f.pause(j); const onDeleted = vi.fn(async () => {});
    await vi.waitFor(() => expect(blocked).toBe(true));
    try {
      await expect(platform === 'mail' ? handleMailDelete({ ...f.deps.mail, onDeleted }, { slug: 'work' })
        : handleCalendarDelete({ ...f.deps.calendar, onDeleted }, { slug: 'work' })).rejects.toMatchObject({ code: 'conflict' });
      expect(onDeleted).not.toHaveBeenCalled();
    } finally { release(); await pending; }
    expect(f.instances.get(platform, 'work')).not.toBeNull(); expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
  });
  it('releases provisional collection leases if the pause transaction rolls back', async () => {
    const f = await fixture(); const j = await f.prepare();
    f.db.exec(`CREATE TRIGGER refuse_cleanup_pause BEFORE UPDATE ON oauth_permission_cleanups
      WHEN NEW.status = 'stopping' BEGIN SELECT RAISE(ABORT, 'fixture pause refusal'); END;`);
    await expect(f.pause(j)).rejects.toBeInstanceOf(Error);
    expect((await f.status(j)).status).toBe('prepared'); expect(collectionAuthenticationLocks(f.db).has('mail:work')).toBe(false);
    expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBeNull(); expect(await f.account.get('gmail.work.grant_generation')).toBeNull();
    await expect(handleMailDelete(f.deps.mail, { slug: 'work' })).resolves.toEqual({ ok: true });
  });
  it('keeps a newer same-name collection outside an old cleanup authority', async () => {
    const f = await fixture(); const j = await f.review(); const old = f.instances.get('mail', 'work')!;
    f.instances.delete('mail', 'work'); f.clock(9000); await f.add('gmail');
    await expect(f.apply(j)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.instances.get('mail', 'work')?.created_at).not.toBe(old.created_at); expect(await f.account.get('gmail.work.refresh_token')).toBe('fixture-old-refresh');
  });
  it('cancels only before pausing and keeps a resumed cleanup available afterward', async () => {
    const f = await fixture(); const prepared = await f.prepare();
    expect((await f.job({ action: 'cancel_permission_cleanup', id: prepared.id, expected_revision: prepared.revision })).status).toBe('cancelled');
    const paused = await f.pause(); await expect(f.call({ action: 'cancel_permission_cleanup', id: paused.id, expected_revision: paused.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.call({ action: 'permission_cleanup_status' })).permission_cleanup_jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: paused.id, status: 'awaiting_reset' })]));
  });
  it('blocks unsupported API authorizations and stale previews before pausing or changing grants', async () => {
    const f = await fixture(); const auth = { type: 'oauth2_refresh' as const, client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'api-refresh', token_endpoint: GOOGLE_TOKEN_URL };
    f.connections.upsert({ kind: 'api', name: 'sheets', display_name: 'Sheets', auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name: 'sheets' }, f.key),
      config_json: '{"base_url":"https://sheets.googleapis.com/v4"}', granted_scopes_json: JSON.stringify([sheets]), enrolled_at: 1, updated_at: 1 });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'bad_request' }); expect(f.mailLife.stop).not.toHaveBeenCalled();
    expect(await f.account.get('gmail.work.permission_cleanup_pending')).toBeNull();
  });
  it('keeps separately verified Google accounts separate while resetting a shared app', async () => {
    const f = await fixture(); await f.add('gmail', 'other', 'different@example.test'); const j = await f.pause();
    expect(j.targets.map(t => t.slug)).toEqual(['work']); expect(await f.account.get('gmail.other.permission_cleanup_pending')).toBeNull();
  });
  it('rolls back token and history writes if the atomic apply is refused', async () => {
    const f = await fixture(true); const j = await f.review();
    // Fail inside the commit callback, after the token writes have run.
    f.db.exec(`CREATE TRIGGER refuse_cleanup_save BEFORE UPDATE ON oauth_permission_cleanups
      WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture commit refusal'); END;`);
    await expect(f.apply(j)).rejects.toBeInstanceOf(Error);
    for (const provider of ['gmail', 'gcal']) {
      expect(await f.account.get(provider + '.work.refresh_token')).toBe('fixture-old-refresh');
      expect(await f.account.get(provider + '.work.granted_scopes')).toContain(sheets);
      expect(await f.account.get(provider + '.work.permission_cleanup_pending')).toBe(j.id);
    }
    expect(await f.account.get('gmail.work.history_id')).toBe('keep-history'); expect((await f.status(j)).status).toBe('awaiting_reconnect');
  });
  it('does not leak candidate credentials when the server is locked', async () => {
    const f = await fixture(); const j = await f.review(); f.lock();
    await expect(f.status(j)).rejects.toMatchObject({ code: 'not_configured' });
    const response = await f.handlers['server.oauthApps']({ action: 'permission_inventory' }, undefined as never);
    expect(response.permission_cleanup_available).toBe(false); expect(response.permission_cleanup_jobs).toBeUndefined();
  });
});
