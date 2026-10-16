import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, isOAuthPermissionInventory, isOAuthPermissionCleanupPreview,
  type ConnectionAuth, type CollectionCaps, type OAuthPermissionNeeds, type ManagedOAuthConnectionUse } from '@recued/contracts';
import { createOAuthPermissionService } from '../oauth-permission-consolidation.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createServerAccountStore } from '../account-store.js';
import { encodeAuthForStorage } from '../connection-auth-storage.js';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';

const dbs: Database.Database[] = []; afterEach(() => { vi.restoreAllMocks(); dbs.splice(0).forEach(db => db.close()); });
const read = 'https://www.googleapis.com/auth/gmail.readonly';
const sheets = 'https://www.googleapis.com/auth/spreadsheets';
const caps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'required', auth: 'oauth', path_style: 'uri' };
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); let unlocked = true;
  const key = () => unlocked ? Buffer.alloc(32, 7) : null;
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key }); apps.setIssuer('google', 'google-client', 'fixture-secret');
  apps.setIssuer('microsoft', 'microsoft-client', 'fixture-ms-secret');
  const instances = createInstanceStore({ db, now: () => 1000 }); const connections = createConnectionStore(db); const account = createServerAccountStore(db);
  const uses = new Map<string, ManagedOAuthConnectionUse[]>(); const needs = new Map<string, OAuthPermissionNeeds>();
  const service = createOAuthPermissionService({ apps, instances, rows: () => connections.list(), key, accountStore: account, nativeRequirements: () => ({ requirements: [], complete: true, warnings: [] }), now: () => 2000,
    connectionUses: name => ({ uses: uses.get(name) ?? [], complete: true }),
    requirements: name => needs.get(name) ?? { requirements: [], complete: true, warnings: [] } });
  const api = async (name: string, granted: string[] | undefined, patch: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}, base = 'https://sheets.googleapis.com/v4') => {
    const auth: ConnectionAuth = { type: 'oauth2_refresh', client_id: 'google-client', client_secret: 'fixture-secret', refresh_token: 'refresh-' + name,
      current_access_token: 'access-' + name, token_endpoint: GOOGLE_TOKEN_URL, saved_oauth_app: { issuer: 'google', id: 'default' }, ...patch };
    connections.upsert({ kind: 'api', name, display_name: name, auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, key),
      config_json: JSON.stringify({ vendor: 'test', base_url: base }), enrolled_at: 100, updated_at: 1000,
      ...(granted ? { granted_scopes_json: JSON.stringify(granted) } : {}) });
  };
  const native = async (slug = 'work', granted = [read, sheets], provider = 'gmail', platform: 'mail' | 'calendar' = 'mail', extra: Record<string, unknown> = {}) => {
    instances.upsert({ platform, slug, adapter_type: provider, config: { account_slug: slug, account_email: slug + '@example.test', ...extra }, caps,
      auth_state: 'healthy', last_synced_at: 444 }); instances.markBackfillComplete(platform, slug);
    await account.set(provider + '.' + slug + '.granted_scopes', granted.join(' ')); await account.set(provider + '.' + slug + '.refresh_token', 'native-refresh-' + slug);
    await account.set(provider + '.' + slug + '.history_id', 'keep-cursor');
  };
  const inventory = async (filter?: { issuer: 'google' | 'microsoft'; app_id: string }) => {
    const result = await service.handle({ action: 'permission_inventory', ...filter }); if (!result.permission_inventory) throw Error('missing inventory');
    expect(isOAuthPermissionInventory(result.permission_inventory)).toBe(true); return result.permission_inventory;
  };
  const preview = async (inv: Awaited<ReturnType<typeof inventory>>, groupId = inv.groups[0]!.id, selected = [sheets]) => {
    const result = await service.handle({ action: 'preview_permission_cleanup', inventory_fingerprint: inv.fingerprint, group_id: groupId, selected_scopes: selected,
      ...(inv.filter ? { filter: inv.filter } : {}) });
    expect(isOAuthPermissionCleanupPreview(result.permission_cleanup)).toBe(true); return result.permission_cleanup!;
  };
  return { db, key, apps, instances, connections, account, service, api, native, inventory, preview, uses, needs, lock: () => { unlocked = false; } };
};

describe('OAuth permission consolidation and cleanup preview', () => {
  it('finds a leftover Sheets grant after its pack is uninstalled, while keeping Mail read access', async () => {
    const f = fixture(); await f.native(); const before = f.db.serialize(); const inv = await f.inventory();
    expect(inv.groups[0]?.scopes).toContainEqual({ scope: sheets, status: 'unused_locally', evidence: 'recorded_grant', required_by: [] });
    expect(inv.groups[0]?.scopes.find(s => s.scope === read)).toMatchObject({ status: 'required', required_by: [{ kind: 'mail', id: 'work' }] });
    const plan = await f.preview(inv); expect(plan).toMatchObject({ method: 'google_revoke_reconnect', mutation: false, verification: 'not_checked', selected_scopes: [sheets] });
    expect(plan.retained_scopes).toContain(read); expect(f.db.serialize()).toEqual(before);
    expect(await f.account.get('gmail.work.history_id')).toBe('keep-cursor'); expect(f.instances.get('mail', 'work')).toMatchObject({ last_synced_at: 444, backfill_complete: true });
  });
  it('protects a scope still needed by another pack sharing an API authorization', async () => {
    const f = fixture(); await f.api('mail', [read, sheets], { native_credential_id: 'shared' }); await f.api('sheets', [read, sheets], { native_credential_id: 'shared' });
    const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'sheet-pack', label: 'Spreadsheet pack' };
    f.uses.set('sheets', [use]); f.needs.set('sheets', { complete: true, warnings: [], requirements: [{ scope: sheets, uses: [use] }] });
    let inv = await f.inventory(); expect(inv.groups).toHaveLength(1); expect(inv.groups[0]?.connection_names).toEqual(['mail', 'sheets']);
    expect(inv.groups[0]?.scopes.find(s => s.scope === sheets)).toMatchObject({ status: 'required' });
    await expect(f.preview(inv)).rejects.toMatchObject({ code: 'bad_request' });
    f.uses.delete('sheets'); f.needs.delete('sheets'); inv = await f.inventory();
    expect(inv.groups[0]?.scopes.find(s => s.scope === sheets)?.status).toBe('unused_locally');
  });
  it('does not recommend removing a mailbox scope another authorization under the same app still needs', async () => {
    const f = fixture(); await f.native(); await f.api('sheet-pack-account', [sheets]);
    const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'sheet-pack', label: 'Spreadsheet pack' };
    f.uses.set('sheet-pack-account', [use]); f.needs.set('sheet-pack-account', { complete: true, warnings: [], requirements: [{ scope: sheets, uses: [use] }] });
    const inv = await f.inventory(); const mailbox = inv.groups.find(g => g.native_accounts.length)!;
    expect(mailbox.scopes.find(s => s.scope === sheets)).toMatchObject({ status: 'unknown', required_by: [use] });
    await expect(f.preview(inv, mailbox.id)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('keeps independent accounts and grant families separate even when they reuse an app', async () => {
    const f = fixture(); await f.native('one'); await f.native('two'); await f.api('api', [sheets]);
    const inv = await f.inventory(); expect(inv.groups).toHaveLength(3); expect(new Set(inv.groups.map(g => g.app_key)).size).toBe(1);
    const native = inv.groups.find(g => g.native_accounts[0]?.slug === 'one')!;
    expect((await f.preview(inv, native.id)).related_group_ids).toHaveLength(2);
  });
  it('supports exact saved-app filtered previews without treating another account as the selected grant', async () => {
    const f = fixture(); await f.native(); const inv = await f.inventory({ issuer: 'google', app_id: 'default' });
    expect(inv.filter).toEqual({ issuer: 'google', app_id: 'default' }); expect((await f.preview(inv)).selected_scopes).toEqual([sheets]);
  });
  it('protects native uses through a second saved app with the same Client ID in filtered reviews', async () => {
    const f = fixture(); const calendar = 'https://www.googleapis.com/auth/calendar.readonly';
    const copy = f.apps.saveApp({ issuer: 'google', label: 'Same client, other saved app', client_id: 'google-client', client_secret: 'fixture-secret' });
    await f.native('mail', [read, calendar]); await f.native('events', [calendar], 'gcal', 'calendar', { oauth_app_id: copy.id });
    const inv = await f.inventory({ issuer: 'google', app_id: 'default' });
    expect(inv.groups).toHaveLength(2);
    const mail = inv.groups.find(g => g.native_accounts[0]?.platform === 'mail')!;
    expect(mail.scopes.find(s => s.scope === calendar)).toMatchObject({ status: 'unknown', required_by: [{ kind: 'calendar', id: 'events' }] });
    await expect(f.preview(inv, mail.id, [calendar])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('keeps native Microsoft Mail and Calendar sharing one grant together', async () => {
    const f = fixture(); await f.native('work', ['Mail.Read', 'Calendars.Read', 'User.Read', 'Files.Read'], 'graph');
    await f.native('work', ['Mail.Read', 'Calendars.Read', 'User.Read', 'Files.Read'], 'graph', 'calendar');
    const inv = await f.inventory(); expect(inv.groups).toHaveLength(1);
    expect(inv.groups[0]?.native_accounts).toHaveLength(2); expect(inv.groups[0]?.required_scopes).toEqual(expect.arrayContaining(['Mail.Read', 'Calendars.Read', 'offline_access', 'User.Read']));
    expect((await f.preview(inv, inv.groups[0]!.id, ['Files.Read'])).method).toBe('microsoft_consent_review');
  });
  it.each([
    { granted: 'https://www.googleapis.com/auth/gmail.modify', required: read, issuer: 'google' },
    { granted: sheets, required: sheets + '.readonly', issuer: 'google' },
    { granted: 'https://www.googleapis.com/auth/drive', required: 'https://www.googleapis.com/auth/drive.readonly', issuer: 'google' },
    { granted: 'Mail.ReadWrite', required: 'Mail.Read', issuer: 'microsoft' },
    { granted: 'https://graph.microsoft.com/Calendars.ReadWrite', required: 'Calendars.Read', issuer: 'microsoft' },
    { granted: 'Files.ReadWrite', required: 'Files.Read', issuer: 'microsoft' },
    { granted: 'https://www.googleapis.com/auth/drive', required: sheets, issuer: 'google' },
    { granted: 'https://www.googleapis.com/auth/drive.readonly', required: sheets + '.readonly', issuer: 'google' },
    { granted: 'Sites.Read.All', required: 'Files.Read', issuer: 'microsoft' },
    { granted: 'https://graph.microsoft.com/Sites.ReadWrite.All', required: 'Files.Read', issuer: 'microsoft' },
  ])('does not label broader $granted unused when it covers $required', async scenario => {
    const f = fixture(); const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'pack', label: 'Still installed' };
    await f.api('api', [scenario.granted], scenario.issuer === 'microsoft' ? { client_id: 'microsoft-client', token_endpoint: MICROSOFT_TOKEN_URL, saved_oauth_app: { issuer: 'microsoft', id: 'default' } } : {},
      scenario.issuer === 'microsoft' ? 'https://graph.microsoft.com/v1.0' : 'https://sheets.googleapis.com/v4');
    f.uses.set('api', [use]); f.needs.set('api', { complete: true, warnings: [], requirements: [{ scope: scenario.required, uses: [use] }] });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes.find(s => s.scope === scenario.granted)?.status).toBe('required');
    await expect(f.preview(inv, inv.groups[0]!.id, [scenario.granted])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('keeps paused schedules and saved recipes as dependencies', async () => {
    const f = fixture(); await f.api('api', [sheets]); const use: ManagedOAuthConnectionUse = { kind: 'schedule', id: 'paused', label: 'Monthly export', paused: true };
    f.uses.set('api', [use]); f.needs.set('api', { complete: true, warnings: [], requirements: [{ scope: sheets, uses: [use] }] });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes[0]?.required_by[0]).toMatchObject({ paused: true });
  });
  it('keeps unrecognized broad-scope relationships unknown instead of assuming an exact list difference is safe', async () => {
    const f = fixture(); const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'analytics', label: 'Analytics pack' };
    const broad = 'https://www.googleapis.com/auth/analytics.edit'; const narrow = 'https://www.googleapis.com/auth/analytics.readonly';
    await f.api('api', [broad, narrow]); f.uses.set('api', [use]); f.needs.set('api', { complete: true, warnings: [], requirements: [{ scope: narrow, uses: [use] }] });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes.find(s => s.scope === broad)?.status).toBe('unknown');
    await expect(f.preview(inv, inv.groups[0]!.id, [broad])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each([
    { granted: 'https://www.googleapis.com/auth/calendar.readonly', required: 'https://www.googleapis.com/auth/calendar.events.readonly' },
    { granted: 'https://www.googleapis.com/auth/drive.readonly', required: 'https://www.googleapis.com/auth/drive.metadata.readonly' },
  ])('keeps a known grant protected when a needed scope has unsupported implications: $required', async scenario => {
    const f = fixture(); const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'narrow', label: 'Narrow permissions' };
    await f.api('api', [scenario.granted]); f.uses.set('api', [use]);
    f.needs.set('api', { complete: true, warnings: [], requirements: [{ scope: scenario.required, uses: [use] }] });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes.find(s => s.scope === scenario.granted)?.status).toBe('unknown');
    await expect(f.preview(inv, inv.groups[0]!.id, [scenario.granted])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('retains file-download access even when no pack is installed', async () => {
    const f = fixture(); await f.api('drive', ['https://www.googleapis.com/auth/drive', sheets], {}, 'https://www.googleapis.com/drive/v3');
    f.uses.set('drive', [{ kind: 'file', id: 'source', label: 'Drive files' }]); const inv = await f.inventory();
    expect(inv.groups[0]?.scopes.find(s => s.scope.endsWith('/drive'))?.status).toBe('required');
    expect(inv.groups[0]?.scopes.find(s => s.scope === sheets)?.status).toBe('unused_locally');
  });
  it('keeps resource permissions unknown when an installed operation uses a static .default grant', async () => {
    const f = fixture(); const use: ManagedOAuthConnectionUse = { kind: 'pack', id: 'static', label: 'Static permissions' };
    await f.api('api', ['Mail.Read'], { client_id: 'microsoft-client', token_endpoint: MICROSOFT_TOKEN_URL,
      saved_oauth_app: { issuer: 'microsoft', id: 'default' } }, 'https://graph.microsoft.com/v1.0');
    f.uses.set('api', [use]); f.needs.set('api', { complete: true, warnings: [], requirements: [{ scope: 'https://graph.microsoft.com/.default', uses: [use] }] });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes.find(s => s.scope === 'Mail.Read')?.status).toBe('unknown');
    await expect(f.preview(inv, inv.groups[0]!.id, ['Mail.Read'])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each(['unknown grants', 'incomplete dependencies', 'unreadable sibling'])('does not recommend cleanup with %s', async mode => {
    const f = fixture(); await f.api('api', mode === 'unknown grants' ? undefined : [sheets], { required_scopes: [sheets] });
    if (mode === 'incomplete dependencies') f.needs.set('api', { requirements: [], complete: false, warnings: ['Unknown recipe'] });
    if (mode === 'unreadable sibling') f.connections.upsert({ kind: 'api', name: 'broken', display_name: 'broken', auth_ciphertext: 'invalid', config_json: '{}', enrolled_at: 0, updated_at: 0 });
    const inv = await f.inventory(); expect(inv.groups[0]?.scopes.find(s => s.scope === sheets)?.status).toBe('unknown');
    await expect(f.preview(inv)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('does not infer broker grants or merge equal remote IDs in different profiles', async () => {
    const f = fixture();
    for (const id of ['one', 'two']) {
      const auth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: id, integration_id: 'google', connection_id: 'same-id', target_origin: 'https://sheets.googleapis.com', requested_scopes: [sheets], required_scopes: [sheets] };
      f.connections.upsert({ kind: 'api', name: id, display_name: id, auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name: id }, f.key), config_json: '{"base_url":"https://sheets.googleapis.com/v4"}', enrolled_at: 0, updated_at: 0 });
    }
    const inv = await f.inventory(); expect(inv.groups).toHaveLength(2); expect(new Set(inv.groups.map(g => g.app_key)).size).toBe(2);
    expect(inv.groups.every(g => !g.grants_known && g.scopes[0]?.status === 'unknown')).toBe(true);
  });
  it.each(['pack', 'grants', 'grant generation', 'collection', 'app', 'connection'])('retires the preview after %s changes', async mutation => {
    const f = fixture(); await f.native(); await f.api('api', [sheets]); const inv = await f.inventory(); const group = inv.groups.find(g => g.native_accounts.length)!;
    if (mutation === 'pack') f.needs.set('api', { requirements: [{ scope: sheets, uses: [{ kind: 'pack', id: 'new', label: 'New pack' }] }], complete: true, warnings: [] });
    if (mutation === 'grants') await f.account.set('gmail.work.granted_scopes', read);
    if (mutation === 'grant generation') await f.account.set('gmail.work.grant_generation', 'new-generation');
    if (mutation === 'collection') f.instances.upsert({ ...f.instances.get('mail', 'work')!, config: { ...f.instances.get('mail', 'work')!.config, label_filter: ['new'] } });
    if (mutation === 'app') f.apps.setIssuer('google', 'changed-client', 'different-secret');
    if (mutation === 'connection') await f.api('new', [read]);
    await expect(f.preview(inv, group.id)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('performs no provider calls or local writes through the owner RPC', async () => {
    const f = fixture(); await f.native(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Provider I/O forbidden'));
    const handlers = makeOAuthAppConfigHandlers({ store: f.apps, permissions: f.service })!.handlers; const before = f.db.serialize();
    const response = await handlers['server.oauthApps']({ action: 'permission_inventory' }, undefined as never);
    expect(isOAuthPermissionInventory(response.permission_inventory)).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(f.db.serialize()).toEqual(before);
    expect(JSON.stringify(response)).not.toMatch(/fixture-secret|native-refresh|keep-cursor/);
  });
  it('keeps an otherwise current cleanup review valid while mailbox sync progresses', async () => {
    const f = fixture(); await f.native(); const inv = await f.inventory();
    f.instances.upsert({ ...f.instances.get('mail', 'work')!, last_synced_at: 999 });
    expect((await f.preview(inv)).selected_scopes).toEqual([sheets]);
  });
  it('does not mix pre-reauthorization capabilities with a newly expanded grant', async () => {
    const f = fixture(); await f.native(); const get = f.account.get.bind(f.account); let expanded = false;
    vi.spyOn(f.account, 'get').mockImplementation(async key => {
      const value = await get(key);
      if (key === 'gmail.work.granted_scopes' && !expanded) {
        expanded = true; await f.account.set(key, [read, sheets, 'https://www.googleapis.com/auth/gmail.send'].join(' '));
      }
      return value;
    });
    await expect(f.inventory()).rejects.toMatchObject({ code: 'conflict' });
  });
});
