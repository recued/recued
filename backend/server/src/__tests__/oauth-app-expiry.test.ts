import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OAuthAppsRequest } from '@recued/contracts';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db); let unlocked = true;
  const store = createOAuthAppConfigStore(db, { getEncryptionKey: () => unlocked ? Buffer.alloc(32, 17) : null });
  const handlers = makeOAuthAppConfigHandlers({ store, uses: () => [{ lane: 'mail', slug: 'work' }] })!.handlers;
  const call = (request: OAuthAppsRequest) => handlers['server.oauthApps'](request, undefined as never);
  const add = () => store.saveApp({ issuer: 'microsoft', label: 'Work', client_id: 'client', client_secret: 'fixture-old-secret', secret_expires_on: '2026-11-14' });
  return { db, store, handlers, call, add, lock: () => { unlocked = false; } };
};
describe('saved OAuth app expiry persistence', () => {
  it('updates dates for an in-use app without decrypting or rewriting the secret', async () => {
    const f = fixture(); const app = f.add(); const before = f.db.prepare('SELECT key,value FROM oauth_app_config ORDER BY key').all();
    f.lock();
    const result = await f.call({ action: 'save', issuer: app.issuer, id: app.id, label: app.label,
      client_id: app.client_id, expected_revision: app.revision, secret_expires_on: '2027-01-31' });
    expect(result.secret_expiry_supported).toBe(true);
    expect(result.apps[0]).toMatchObject({ secret_expires_on: '2027-01-31', revision: app.revision + 1, uses: [{ lane: 'mail', slug: 'work' }] });
    expect(f.db.prepare("SELECT key,value FROM oauth_app_config WHERE key NOT LIKE '%.profile' ORDER BY key").all())
      .toEqual(before.filter(row => !(row as { key: string }).key.endsWith('.profile')));
    expect(JSON.stringify(result)).not.toMatch(/fixture-old-secret|client_secret/);
  });
  it('preserves the date on a rename, clears it explicitly, and fences stale edits', async () => {
    const f = fixture(); const app = f.add();
    const renamed = f.store.saveApp({ ...app, label: 'Renamed', expected_revision: app.revision, secret_expires_on: undefined });
    expect(renamed.secret_expires_on).toBe('2026-11-14');
    await expect(f.call({ action: 'save', ...app, expected_revision: app.revision, secret_expires_on: null })).rejects.toMatchObject({ code: 'conflict' });
    const result = await f.call({ action: 'save', ...renamed, expected_revision: renamed.revision, secret_expires_on: null });
    expect(result.apps[0]).not.toHaveProperty('secret_expires_on');
    expect(f.store.getClientSecret(app.issuer, app.id)).toBe('fixture-old-secret');
  });
  it('can clear an obsolete date on an app whose secret is missing without inventing a credential', async () => {
    const f = fixture(); const app = f.add();
    f.db.prepare('DELETE FROM oauth_app_config WHERE key=?').run(app.issuer + '.app.' + app.id + '.client_secret');
    const result = await f.call({ action: 'save', ...app, expected_revision: app.revision, secret_expires_on: null });
    expect(result.apps[0]).toMatchObject({ has_secret: false }); expect(result.apps[0]).not.toHaveProperty('secret_expires_on');
    expect(f.store.getClientSecret(app.issuer, app.id)).toBeNull();
  });
  it('clears old dates for replacements and can record a new date for a new secret', () => {
    const f = fixture(); let app = f.add();
    const { secret_expires_on: _oldDate, ...identity } = app;
    app = f.store.saveApp({ ...identity, expected_revision: app.revision, client_secret: 'fixture-new-secret' });
    expect(app).not.toHaveProperty('secret_expires_on');
    app = f.store.saveApp({ ...app, expected_revision: app.revision, client_secret: 'fixture-next-secret', secret_expires_on: '2028-02-29' });
    expect(app.secret_expires_on).toBe('2028-02-29');
    expect(f.store.getClientSecret(app.issuer, app.id)).toBe('fixture-next-secret');
  });
  it('does not carry an expiry date through legacy default-app replacement or recreation', () => {
    const f = fixture(); f.store.setIssuer('google', 'client', 'fixture-original');
    const original = f.store.getApp('google', 'default')!;
    f.store.saveApp({ ...original, expected_revision: original.revision, secret_expires_on: '2026-11-14' });
    f.store.setIssuer('google', 'client', 'fixture-replaced');
    expect(f.store.getApp('google', 'default')).not.toHaveProperty('secret_expires_on');
    f.store.clearIssuer('google'); f.store.setIssuer('google', 'client', 'fixture-recreated');
    expect(f.store.getApp('google', 'default')).not.toHaveProperty('secret_expires_on');
  });
  it.each(['2026-02-29', '2026-04-31', '', '2026-10-15T00:00:00Z'])('rejects invalid date %s atomically in the store and RPC', async date => {
    const f = fixture(); const app = f.add(); const before = f.db.prepare('SELECT * FROM oauth_app_config ORDER BY key').all();
    expect(() => f.store.saveApp({ ...app, expected_revision: app.revision, secret_expires_on: date })).toThrow(/expiry date/);
    await expect(f.call({ action: 'save', ...app, expected_revision: app.revision, secret_expires_on: date })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.db.prepare('SELECT * FROM oauth_app_config ORDER BY key').all()).toEqual(before);
  });
  it('keeps the previous date and ciphertext after a failed secret replacement', () => {
    const f = fixture(); const app = f.add(); const before = f.db.prepare('SELECT * FROM oauth_app_config ORDER BY key').all(); f.lock();
    expect(() => f.store.saveApp({ ...app, expected_revision: app.revision, client_secret: 'fixture-replaced', secret_expires_on: '2027-01-01' })).toThrow(/locked/);
    expect(f.db.prepare('SELECT * FROM oauth_app_config ORDER BY key').all()).toEqual(before);
  });
  it('reads dates after a cold store reopen, and treats corrupt date metadata as unknown without hiding credentials', async () => {
    const f = fixture(); const app = f.add();
    const reopened = createOAuthAppConfigStore(f.db, { getEncryptionKey: () => Buffer.alloc(32, 17) });
    expect(reopened.getApp(app.issuer, app.id)).toEqual(app);
    f.db.prepare('UPDATE oauth_app_config SET value=? WHERE key=?').run(JSON.stringify({ label: app.label, revision: app.revision, secret_expires_on: '2026-02-29' }), app.issuer + '.app.' + app.id + '.profile');
    expect(reopened.getApp(app.issuer, app.id)).toMatchObject({ client_id: app.client_id, has_secret: true });
    expect(reopened.getApp(app.issuer, app.id)).not.toHaveProperty('secret_expires_on');
    const response = await f.call({ action: 'list' }); expect(response.secret_expiry_supported).toBe(true);
    expect((await f.handlers['server.getOAuthAppConfig'](undefined, undefined as never)).microsoft.apps?.[0]).not.toHaveProperty('secret_expires_on');
  });
  it('preserves dates across closing and reopening the SQLite file without decrypting the secret', () => {
    const directory = mkdtempSync(join(tmpdir(), 'recued-app-expiry-')); temporaryDirectories.push(directory);
    const path = join(directory, 'data.sqlite'); const first = new Database(path);
    const store = createOAuthAppConfigStore(first, { getEncryptionKey: () => Buffer.alloc(32, 17) });
    const app = store.saveApp({ issuer: 'google', label: 'Work', client_id: 'client', client_secret: 'fixture-secret', secret_expires_on: '2027-11-14' }); first.close();
    const second = new Database(path); databases.push(second);
    const reopened = createOAuthAppConfigStore(second, { getEncryptionKey: () => null });
    expect(reopened.getApp(app.issuer, app.id)).toEqual(app);
    expect(() => reopened.getClientSecret(app.issuer, app.id)).toThrow(/locked/);
  });
});
