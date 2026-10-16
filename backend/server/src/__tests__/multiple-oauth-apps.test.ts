import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OAuthAppsRequest } from '@recued/contracts';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { makeOAuthAppConfigHandlers, oauthAppUses } from '../oauth-app-config-handler.js';
import { createInstanceStore } from '../collections/instance-store.js';
const key = Buffer.alloc(32, 17);
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); });
const fixture = () => {
  const db = new Database(':memory:'); close.push(() => db.close());
  let unlocked = true; let inUse = false;
  const store = createOAuthAppConfigStore(db, { getEncryptionKey: () => unlocked ? key : null });
  const handlers = makeOAuthAppConfigHandlers({ store, uses: () => inUse ? [{ lane: 'mail', slug: 'work' }] : [] })!.handlers;
  const call = (args: OAuthAppsRequest) => handlers['server.oauthApps'](args, undefined as never);
  const add = (label = 'Work Google', clientId = 'work-client') => store.saveApp({ issuer: 'google', label, client_id: clientId, client_secret: 'fixture-work-secret' });
  return { db, store, handlers, call, add, lock: () => { unlocked = false; }, use: () => { inUse = true; } };
};
describe('multiple saved OAuth app profiles', () => {
  it('counts native profile dependencies without counting borrowed API authentication', () => {
    const f = fixture(); const app = f.add(); const instances = createInstanceStore({ db: f.db });
    const caps = { read: 'yes' as const, write: 'no' as const, delete: 'no' as const, watch: 'realtime' as const, mirror: 'required' as const, auth: 'oauth' as const, path_style: 'uri' as const };
    const rows = [
      { platform: 'mail' as const, slug: 'legacy', adapter_type: 'gmail', config: {} },
      { platform: 'calendar' as const, slug: 'work', adapter_type: 'gcal', config: { oauth_app_id: app.id } },
      { platform: 'mail' as const, slug: 'managed', adapter_type: 'gmail', config: { managed_oauth: {}, oauth_app_id: app.id } },
      { platform: 'calendar' as const, slug: 'borrowed', adapter_type: 'gcal', config: { oauth_connection: {}, oauth_app_id: app.id } },
      { platform: 'mail' as const, slug: 'microsoft', adapter_type: 'graph', config: {} },
    ];
    for (const row of rows) instances.upsert({ ...row, caps, auth_state: 'healthy', last_synced_at: null });
    expect(oauthAppUses(instances, 'google', 'default')).toEqual([{ lane: 'mail', slug: 'legacy' }]);
    expect(oauthAppUses(instances, 'google', app.id)).toEqual([{ lane: 'calendar', slug: 'work' }]);
    expect(oauthAppUses(instances, 'microsoft', 'default')).toEqual([{ lane: 'mail', slug: 'microsoft' }]);
  });
  it('can set up the default app when a named app already uses its generated name', async () => {
    const f = fixture(); const named = f.add('Default Google app');
    await expect(f.handlers['server.setOAuthAppConfig']({ issuer: 'google', client_id: 'default-client', client_secret: 'fixture-default-secret' }, undefined as never)).resolves.toEqual({ ok: true });
    expect(f.store.getApp('google', 'default')?.label).not.toBe(named.label);
    expect(f.store.getClientSecret('google', named.id)).toBe('fixture-work-secret');
  });
  it.each(['delete', 'clear'] as const)('fences stale default-app edits across %s and recreation', async action => {
    const f = fixture(); f.store.setIssuer('google', 'original-client', 'fixture-original-secret');
    const original = f.store.getApp('google', 'default')!;
    if (action === 'delete') await f.call({ action, issuer: 'google', id: 'default', expected_revision: original.revision });
    else await f.handlers['server.clearOAuthAppConfig']({ issuer: 'google' }, undefined as never);
    await expect(f.call({ action: 'save', issuer: 'google', id: 'default', expected_revision: original.revision,
      label: 'Stale draft', client_id: 'old-tab-client', client_secret: 'fixture-old-tab-secret' })).rejects.toMatchObject({ code: 'not_found' });
    f.store.setIssuer('google', 'replacement-client', 'fixture-replacement-secret');
    const replacement = f.store.getApp('google', 'default')!;
    expect(replacement.revision).toBeGreaterThan(original.revision);
    await expect(f.call({ action: 'save', issuer: 'google', id: 'default', expected_revision: original.revision,
      label: 'Stale draft', client_id: original.client_id, client_secret: 'fixture-old-tab-secret' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.call({ action: 'delete', issuer: 'google', id: 'default', expected_revision: original.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.store.getClientSecret('google')).toBe('fixture-replacement-secret');
  });
  it('keeps app names unambiguous within a vendor while allowing the same label on another vendor', async () => {
    const f = fixture(); f.add('Work');
    await expect(f.call({ action: 'save', issuer: 'google', label: 'work', client_id: 'other', client_secret: 'fixture-other-secret' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.call({ action: 'save', issuer: 'microsoft', label: 'Work', client_id: 'entra', client_secret: 'fixture-entra-secret' })).resolves.toMatchObject({ action: 'save' });
    expect(f.store.listApps()).toHaveLength(2);
  });
  it('keeps legacy keys as the default while storing separate named apps without returning secrets', async () => {
    const f = fixture(); f.store.setIssuer('google', 'primary-client', 'fixture-primary-secret');
    f.db.prepare('DELETE FROM oauth_app_config WHERE key = ?').run('google.profile');
    const before = f.db.prepare('SELECT value FROM oauth_app_config WHERE key = ?').get('google.client_secret');
    const first = f.add(); const second = f.add('Personal Google', 'personal-client');
    const microsoft = f.store.saveApp({ issuer: 'microsoft', label: 'Work Microsoft', client_id: 'entra-client', client_secret: 'fixture-entra-secret' });
    expect(first.id).not.toBe(second.id); expect(f.store.getClientId('google')).toBe('primary-client');
    expect(f.store.getClientSecret('google', first.id)).toBe('fixture-work-secret');
    expect(f.store.getClientSecret('microsoft', microsoft.id)).toBe('fixture-entra-secret');
    expect(f.db.prepare('SELECT value FROM oauth_app_config WHERE key = ?').get('google.client_secret')).toEqual(before);
    const response = await f.call({ action: 'list' }); expect(response.apps).toHaveLength(4);
    expect(response.apps.find(app => app.id === 'default')).toMatchObject({ label: 'Default Google app', revision: 1 });
    expect(JSON.stringify(response)).not.toContain('"client_secret"'); expect(JSON.stringify(response)).not.toContain('fixture-');
    const snapshot = await f.handlers['server.getOAuthAppConfig'](undefined, undefined as never);
    expect(snapshot.google.apps?.map(app => app.id)).toContain(first.id); expect(snapshot.google.client_id).toBe('primary-client');
    f.store.clearIssuer('google'); expect(f.store.getClientSecret('google', first.id)).toBe('fixture-work-secret');
  });
  it('survives a cold database reopen and never places plaintext secrets in SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-oauth-apps-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    let db = new Database(join(dir, 'test.sqlite'));
    const first = createOAuthAppConfigStore(db, { getEncryptionKey: () => key });
    const app = first.saveApp({ issuer: 'google', label: 'Work', client_id: 'client', client_secret: 'fixture-kept-secret' });
    expect(JSON.stringify(db.prepare('SELECT * FROM oauth_app_config').all())).not.toContain('fixture-kept-secret');
    db.close(); db = new Database(join(dir, 'test.sqlite')); close.push(() => db.close());
    const reopened = createOAuthAppConfigStore(db, { getEncryptionKey: () => key });
    expect(reopened.getApp('google', app.id)).toEqual(app); expect(reopened.getClientSecret('google', app.id)).toBe('fixture-kept-secret');
  });
  it('binds encrypted secrets to the exact issuer and app ID', () => {
    const f = fixture(); const first = f.add(); const second = f.add('Second', 'second-client');
    const firstKey = `google.app.${first.id}.client_secret`; const secondKey = `google.app.${second.id}.client_secret`;
    const ciphertext = f.db.prepare<[string], { value: string }>('SELECT value FROM oauth_app_config WHERE key = ?').get(firstKey)!.value;
    f.db.prepare('UPDATE oauth_app_config SET value = ? WHERE key = ?').run(ciphertext, secondKey);
    expect(() => f.store.getClientSecret('google', second.id)).toThrow(); expect(f.store.getClientSecret('microsoft', first.id)).toBeNull();
  });
  it('renames without a secret read, rotates only the selected app and rejects stale edits', async () => {
    const f = fixture(); const app = f.add(); const other = f.add('Other', 'other-client');
    const renamed = await f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: app.revision, label: 'Renamed', client_id: app.client_id });
    const current = renamed.apps.find(item => item.id === app.id)!;
    expect(current.revision).toBe(2); expect(f.store.getClientSecret('google', app.id)).toBe('fixture-work-secret');
    await expect(f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 1, label: 'Old tab', client_id: app.client_id })).rejects.toMatchObject({ code: 'conflict' });
    await f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 2, label: 'Renamed', client_id: app.client_id, client_secret: 'fixture-rotated-secret' });
    expect(f.store.getClientSecret('google', app.id)).toBe('fixture-rotated-secret'); expect(f.store.getClientSecret('google', other.id)).toBe('fixture-work-secret');
  });
  it('does not write partial app metadata when the vault is locked', async () => {
    const f = fixture(); const app = f.add(); const before = f.store.listApps(); f.lock();
    expect((await f.call({ action: 'list' })).apps[0]).toMatchObject({ id: app.id, has_secret: true });
    await expect(f.call({ action: 'save', issuer: 'google', label: 'Locked', client_id: 'another-client', client_secret: 'fixture-another-secret' })).rejects.toMatchObject({ code: 'locked' });
    expect(f.store.listApps()).toEqual(before);
  });
  it('blocks deleting or replacing an app used by Mail or Calendar while allowing rotation and rename', async () => {
    const f = fixture(); const app = f.add(); f.use();
    await expect(f.call({ action: 'delete', issuer: 'google', id: app.id, expected_revision: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 1, label: 'Other', client_id: 'new-client', client_secret: 'fixture-new-secret' })).rejects.toMatchObject({ code: 'conflict' });
    const updated = await f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 1, label: 'Same app', client_id: app.client_id, client_secret: 'fixture-rotated-secret' });
    expect(updated.apps[0]!.uses).toEqual([{ lane: 'mail', slug: 'work' }]);
  });
  it('requires a matching secret for a changed Client ID and fences removal by revision', async () => {
    const f = fixture(); const app = f.add();
    await expect(f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 1, label: app.label, client_id: 'different-client' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.call({ action: 'delete', issuer: 'google', id: app.id, expected_revision: 9 })).rejects.toMatchObject({ code: 'conflict' });
    await f.call({ action: 'delete', issuer: 'google', id: app.id, expected_revision: 1 });
    expect(f.store.getApp('google', app.id)).toBeNull();
    await expect(f.call({ action: 'save', issuer: 'google', id: app.id, expected_revision: 1, label: app.label, client_id: app.client_id, client_secret: 'fixture-recreate-secret' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
