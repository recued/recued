/** D-322 §23 — named, reviewed credential switches use the production atomic rotation boundary. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ManagedOAuthAuth, ManagedOAuthAuthorizationRequest } from '@recued/contracts';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const scope = 'https://www.googleapis.com/auth/spreadsheets';
const base = 'https://sheets.googleapis.com/v4';
const checkUrl = base + '/spreadsheets/test-sheet?fields=spreadsheetId';
const fixture = async (managed: boolean | 'bearer' = false, nativeRequirements: readonly string[] = []) => {
  const db = new Database(':memory:'); databases.push(db); const key = () => new Uint8Array(32).fill(9);
  const profiles = createManagedOAuthProfileStore(db, key); const store = createConnectionStore(db);
  let positiveStatus = 200; let anonymousStatus = 401; let gate: Promise<void> | undefined;
  let requiredScopes = [scope];
  let networkFailure: 'proxy' | 'anonymous' | undefined;
  let remoteState: 'original' | 'recreated' | 'missing' | 'auth_error' | 'legacy' = 'original';
  let remoteId = 'replacement-account'; let remoteNumericId = 201; let completedTag = '';
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input.toString());
    if (url.hostname === 'sheets.googleapis.com') {
      if (networkFailure === 'anonymous') throw new Error('private-network-detail fixture-broker-key');
      return Response.json({ private: 'discard-this-vendor-body' }, { status: anonymousStatus });
    }
    if (url.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'sheets', provider: 'google-sheet' }] });
    if (url.pathname === '/integrations/sheets') return Response.json({ data: { unique_key: 'sheets', provider: 'google-sheet',
      credentials: { type: 'OAUTH2', scopes: scope } } });
    if (url.pathname.startsWith('/connect/sessions')) {
      completedTag = JSON.parse(String(init?.body)).tags.recued_flow; remoteId = 'fresh-account'; remoteNumericId = 401;
      return Response.json({ data: { connect_link: 'https://connect.nango.dev/?token=fixture', expires_at: '2030-01-01T00:00:00Z' } });
    }
    if (url.pathname === '/connections') return Response.json({ connections: remoteState === 'missing' ? [] : [{ connection_id: remoteId,
      provider_config_key: 'sheets', id: remoteState === 'legacy' ? undefined : remoteState === 'recreated' ? 299 : remoteNumericId,
      created: '2026-10-01T00:00:00Z', tags: { recued_flow: completedTag },
      errors: remoteState === 'auth_error' ? [{ type: 'auth' }] : [] }] });
    if (url.pathname.startsWith('/proxy/')) {
      if (networkFailure === 'proxy') throw new Error('private-network-detail fixture-broker-key');
      await gate; return Response.json({ native: 'discard-this-vendor-body' }, { status: positiveStatus });
    }
    throw new Error('Unexpected fixture URL ' + url);
  });
  const decode = (row: NonNullable<ReturnType<typeof store.get>>) => decodeAuthFromStorage(row.auth_ciphertext, row, key);
  const service = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: decode,
    fetchImpl: fetch, now: () => 1_000_000, requiredScopes: () => requiredScopes,
    requiredScopeSources: () => [{ slug: 'sheet-pack', name: 'Sheet pack', scopes: [scope] }] });
  const saved = await service.handle({ action: 'save_profile', broker: 'nango', label: 'Fixture Nango',
    base_url: 'https://api.nango.dev', api_key: 'fixture-broker-key' });
  if (saved.action !== 'save_profile') throw new Error('Fixture profile');
  const original: ConnectionAuth = managed === true ? { type: 'managed_oauth', broker_profile_id: saved.profile.id, integration_id: 'sheets',
    connection_id: 'original-account', target_origin: 'https://sheets.googleapis.com', requested_scopes: [scope], required_scopes: [scope] }
    : managed === 'bearer' ? { type: 'bearer', token: 'old-bearer-token' }
    : { type: 'oauth2_refresh', client_id: 'old-direct-client', client_secret: 'old-direct-secret',
        token_endpoint: 'https://accounts.example.test/token', refresh_token: 'old-direct-refresh',
        ...(nativeRequirements.length ? { required_scopes: nativeRequirements } : {}) };
  store.upsert({ kind: 'api', name: 'shared-sheets', display_name: 'Shared sheets', enrolled_at: 10, updated_at: 20,
    auth_ciphertext: await encodeAuthForStorage(original, { kind: 'api', name: 'shared-sheets' }, key),
    config_json: JSON.stringify({ base_url: base, vendor: 'google', owner_setting: { keep: true } }),
    subresource_path: '/team', last_used_at: 30, health_json: '{"status":"ok","last_probed_at":40}',
    granted_scopes_json: '["old-account-grant"]' });
  profiles.rememberAccountScopes('https://api.nango.dev', 'sheets', JSON.stringify([201, Date.parse('2026-10-01T00:00:00Z')]), [scope]);
  const oauthAppConfig = createOAuthAppConfigStore(db, { getEncryptionKey: key });
  const handlers = makeConnectionHandlers({ store, getEncryptionKey: key, managedOAuth: service, resolveFetch: fetch,
    oauthAppConfig, now: () => 1_000_000 })!.handlers;
  const request: ManagedOAuthAuthorizationRequest = { profile_id: saved.profile.id, integration_id: 'sheets',
    name: 'shared-sheets', base_url: base, vendor: 'google', scopes: [], connection_id: 'replacement-account',
    switch_authentication: true, expected_updated_at: 20 };
  const authorize = async () => {
    const preview = await service.handle({ action: 'preview', ...request });
    if (preview.action !== 'preview') throw new Error('Fixture preview');
    const result = await service.handle({ action: 'start', ...request, preview_fingerprint: preview.preview.fingerprint });
    if (result.action !== 'reuse') throw new Error('Fixture should reuse existing consent');
    return { auth: result.auth, preview: preview.preview };
  };
  const apply = (auth: ManagedOAuthAuth, id = 'authentication-switch-0001', verification_url = checkUrl) =>
    handlers['collection.connection.managedOAuth']({ action: 'apply_authentication_switch', name: 'shared-sheets',
      attempt_id: id, expected_updated_at: 20, auth, verification_url }, undefined as never);
  return { store, profiles, service, fetch, decode, request, handlers, authorize, apply, saved, oauthAppConfig,
    requirements: (scopes: string[]) => { requiredScopes = scopes; },
    status: (positive: number, anonymous = 401) => { positiveStatus = positive; anonymousStatus = anonymous; },
    failNetwork: (at: 'proxy' | 'anonymous') => { networkFailure = at; },
    remote: (state: typeof remoteState) => { remoteState = state; },
    pause: () => { let resume!: () => void; gate = new Promise<void>(resolve => { resume = resolve; }); return () => { resume(); gate = undefined; }; },
  };
};

describe('D-322 reviewed authentication switching', () => {
  it('returns only the current public OAuth app context, with no credential or token and no vendor calls', async () => {
    const f = await fixture(false, ['recorded-native-permission']); const before = f.store.list(); const count = f.fetch.mock.calls.length;
    const response = await f.handlers['collection.connection.managedOAuth']({ action: 'reauthorization_context',
      name: 'shared-sheets', expected_updated_at: 20 }, undefined as never);
    expect(response).toEqual({ action: 'reauthorization_context', name: 'shared-sheets', updated_at: 20,
      auth_type: 'oauth2_refresh', client_id: 'old-direct-client', token_endpoint: 'https://accounts.example.test/token', required_scopes: [scope, 'recorded-native-permission'] });
    expect(JSON.stringify(response)).not.toContain('old-direct-secret'); expect(JSON.stringify(response)).not.toContain('old-direct-refresh');
    expect(f.store.list()).toEqual(before); expect(f.fetch.mock.calls.length).toBe(count);
    await expect(f.handlers['collection.connection.managedOAuth']({ action: 'reauthorization_context',
      name: 'shared-sheets', expected_updated_at: 21 }, undefined as never)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('refuses installed requirements changed during the public native-app read', async () => {
    const f = await fixture(); const before = f.store.list(); const count = f.fetch.mock.calls.length;
    const reading = f.handlers['collection.connection.managedOAuth']({ action: 'reauthorization_context',
      name: 'shared-sheets', expected_updated_at: 20 }, undefined as never);
    f.requirements(['changed-pack-permission']);
    await expect(reading).rejects.toMatchObject({ code: 'conflict' });
    expect(f.store.list()).toEqual(before); expect(f.fetch.mock.calls.length).toBe(count);
  });
  it('resolves the saved app secret on the server for a native review and returns only an encrypted candidate', async () => {
    const f = await fixture(); f.oauthAppConfig.setIssuer('google', 'saved-client', 'saved-app-secret');
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (new URL(url.toString()).hostname === 'oauth2.googleapis.com') {
        expect(new URLSearchParams(String(init?.body)).get('client_secret')).toBe('saved-app-secret');
        return Response.json({ access_token: 'candidate-access', expires_in: 3600, token_type: 'Bearer', scope });
      }
      return original(url, init);
    });
    const before = f.store.list();
    const review = await f.handlers['collection.connection.managedOAuth']({ action: 'review_direct_authentication',
      selections: [{ name: 'shared-sheets', expected_updated_at: 20 }], oauth_app_issuer: 'google', scopes: [scope],
      auth: { type: 'oauth2_refresh', client_id: 'saved-client', token_endpoint: 'https://oauth2.googleapis.com/token', refresh_token: 'new-private-refresh' } }, undefined as never);
    expect(review.action).toBe('review_direct_authentication');
    expect(JSON.stringify(review)).not.toContain('saved-app-secret'); expect(JSON.stringify(review)).not.toContain('new-private-refresh');
    expect(JSON.stringify(review)).not.toContain('candidate-access'); expect(f.store.list()).toEqual(before);
  });
  it.each([false, true])('pins completed new-account identity and refuses missing metadata legacy=%s', async legacy => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { connection_id: omitted, ...request } = f.request; void omitted;
    const preview = await f.service.handle({ action: 'preview', ...request });
    if (preview.action !== 'preview') throw new Error('Fixture preview');
    const start = await f.service.handle({ action: 'start', ...request, preview_fingerprint: preview.preview.fingerprint });
    if (start.action !== 'start') throw new Error('Fixture start');
    if (legacy) f.remote('legacy');
    const completing = f.service.handle({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (legacy) { await expect(completing).rejects.toMatchObject({ code: 'conflict' }); expect(f.store.get('api', 'shared-sheets')).toEqual(before); return; }
    const result = await completing;
    if (result.action !== 'status' || !result.auth) throw new Error('Fixture completion');
    expect(result.auth.connection_id).toBe('fresh-account'); expect(f.store.get('api', 'shared-sheets')).toEqual(before);
    await f.apply(result.auth);
    expect(await f.decode(f.store.get('api', 'shared-sheets')!)).toMatchObject({ connection_id: 'fresh-account' });
  });
  it.each(['recreated', 'missing', 'auth_error'] as const)('keeps the saved credential when a reviewed account becomes %s', async state => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { auth } = await f.authorize(); f.remote(state);
    await expect(f.apply(auth)).rejects.toMatchObject({ code: 'credential_verification_failed', details: { reason: 'broker_account_changed' } });
    expect(f.store.get('api', 'shared-sheets')).toEqual(before);
    expect(f.fetch.mock.calls.some(([url]) => new URL(url.toString()).pathname.startsWith('/proxy/'))).toBe(false);
  });
  it('rechecks the reviewed account identity after the resource read', async () => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { auth } = await f.authorize(); const resume = f.pause();
    const applying = f.apply(auth);
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([url]) => new URL(url.toString()).pathname.startsWith('/proxy/'))).toBe(true));
    f.remote('recreated'); resume(); await expect(applying).rejects.toMatchObject({ code: 'credential_verification_failed', details: { reason: 'broker_account_changed' } });
    expect(f.store.get('api', 'shared-sheets')).toEqual(before);
  });
  it('retains the reviewed receipt when the durable swap transaction fails', async () => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { auth } = await f.authorize();
    vi.spyOn(f.store, 'completeCredentialRotationAttempt').mockImplementationOnce(() => { throw new Error('fixture transaction failed'); });
    await expect(f.apply(auth)).rejects.toThrow('fixture transaction failed'); expect(f.store.get('api', 'shared-sheets')).toEqual(before);
    expect((await f.apply(auth, 'after-transaction-failure-0002')).action).toBe('apply_authentication_switch');
  });
  it('stores only reviewed broker fields and refuses owner-supplied cache expiry as verification evidence', async () => {
    const f = await fixture(); const { auth } = await f.authorize();
    const result = await f.apply({ ...auth, expires_at: 9_999_999, refresh_token: 'surplus-refresh', api_key: 'surplus-key' } as ManagedOAuthAuth);
    if (result.action !== 'apply_authentication_switch') throw new Error('Fixture result');
    expect(result.verification).not.toHaveProperty('access_expires_at');
    expect(JSON.stringify(await f.decode(f.store.get('api', 'shared-sheets')!))).not.toMatch(/surplus|expires_at|api_key|refresh_token/);
  });
  it('uses the saved vendor for permission-source labels when the switch request omits it', async () => {
    const f = await fixture(); const { vendor: omitted, ...request } = f.request; void omitted;
    const result = await f.service.handle({ action: 'preview', ...request });
    if (result.action !== 'preview') throw new Error('Fixture preview');
    expect(result.preview.sources).toContainEqual({ kind: 'pack', label: 'Sheet pack (sheet-pack)', scopes: [scope] });
  });
  it.each([false, true, 'bearer'] as const)('keeps the named connection and metadata when replacing managed=$0', async managed => {
    const f = await fixture(managed); const before = f.store.get('api', 'shared-sheets')!;
    const deleted = vi.fn(); f.store.addOnDelete(deleted);
    const { auth, preview } = await f.authorize();
    expect(preview.required_scopes).toEqual([scope]); expect(f.store.get('api', 'shared-sheets')).toEqual(before);
    f.fetch.mockClear(); const result = await f.apply(auth);
    expect(result.action).toBe('apply_authentication_switch');
    if (result.action !== 'apply_authentication_switch') throw new Error('Fixture result');
    expect(result.connection).toMatchObject({ name: 'shared-sheets', kind: 'api' });
    expect(result.verification).toEqual({ status: 'verified', auth_type: 'managed_oauth', verified_at: 1_000_000 });
    const after = f.store.get('api', 'shared-sheets')!;
    expect(after.updated_at).toBe(1_000_000);
    for (const key of ['pk', 'name', 'display_name', 'config_json', 'enrolled_at', 'subresource_path', 'last_used_at'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.granted_scopes_json).toBeUndefined(); expect(deleted).not.toHaveBeenCalled();
    expect(await f.decode(after)).toMatchObject({ type: 'managed_oauth', connection_id: 'replacement-account' });
    expect(JSON.stringify(result)).not.toMatch(/discard-this-vendor-body|old-direct-secret|old-direct-refresh|fixture-broker-key|authorization_receipt/);
    const anonymous = f.fetch.mock.calls.find(([input]) => new URL(input.toString()).hostname === 'sheets.googleapis.com')!;
    expect(anonymous[0]).toBe(checkUrl); expect(new Headers(anonymous[1]?.headers).has('Authorization')).toBe(false);
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    const count = f.fetch.mock.calls.length; await f.apply(auth); expect(f.fetch).toHaveBeenCalledTimes(count);
    const recovered = await f.handlers['collection.connection.credentialRotationStatus']({ kind: 'api', name: 'shared-sheets',
      attempt_id: 'authentication-switch-0001' }, undefined as never);
    expect(recovered.outcome).toMatchObject({ status: 'succeeded', verification: { status: 'verified', auth_type: 'managed_oauth' } });
    await expect(f.apply({ ...auth, connection_id: 'different-account' })).rejects.toThrow('already completed');
  });
  it.each([[403, 401], [500, 401], [200, 200], [200, 404]])('keeps the old credential when access=%s and anonymous=%s', async (positive, anonymous) => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets')!; const { auth } = await f.authorize();
    f.status(positive, anonymous); await expect(f.apply(auth)).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.store.get('api', 'shared-sheets')).toEqual(before); expect(await f.decode(before)).toMatchObject({ refresh_token: 'old-direct-refresh' });
    // The consent receipt was only inspected: a corrected check can use it with a fresh durable attempt.
    f.status(200, 401); expect((await f.apply(auth, 'authentication-switch-0002')).action).toBe('apply_authentication_switch');
  });
  it.each(['proxy', 'anonymous'] as const)('keeps the saved row and sanitizes a network failure at %s', async at => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { auth } = await f.authorize(); f.failNetwork(at);
    const error = await f.apply(auth).catch(error => error);
    expect(error).toMatchObject({ code: 'credential_verification_failed', details: { verification_status: 'unreachable', existing_credential_preserved: true } });
    expect(JSON.stringify(error)).not.toMatch(/private-network-detail|fixture-broker-key/);
    expect(f.store.get('api', 'shared-sheets')).toEqual(before);
    const status = await f.handlers['collection.connection.credentialRotationStatus']({ kind: 'api', name: 'shared-sheets',
      attempt_id: 'authentication-switch-0001' }, undefined as never);
    expect(status.outcome).toMatchObject({ status: 'failed', reason: 'unreachable' });
  });
  it('cannot save a switch receipt through ordinary update, reauthorization or direct rotation', async () => {
    const f = await fixture(); const before = f.store.get('api', 'shared-sheets'); const { auth } = await f.authorize();
    await expect(f.handlers['collection.connection.update']({ name: 'shared-sheets', kind: 'api', patch: { auth } } as never, undefined as never)).rejects.toMatchObject({ code: 'credential_verification_required' });
    await expect(f.handlers['collection.connection.managedOAuth']({ action: 'save_reauthorization', name: 'shared-sheets', expected_updated_at: 20, patch: { auth } }, undefined as never)).rejects.toThrow('reviewed authentication switch');
    await expect(f.handlers['collection.connection.rotateCredentials']({ name: 'shared-sheets', kind: 'api', attempt_id: 'wrong-route-0001', patch: { auth } }, undefined as never)).rejects.toThrow('Use managed OAuth reauthorization');
    expect(f.store.get('api', 'shared-sheets')).toEqual(before);
  });
  it.each(['https://example.test/private', base + '/../../private', 'https://name:secret@sheets.googleapis.com/v4/private', 'not-a-url'])('rejects an unsafe or out-of-service check: %s', async url => {
    const f = await fixture(); const { auth } = await f.authorize(); const before = f.store.get('api', 'shared-sheets'); f.fetch.mockClear();
    await expect(f.apply(auth, 'unsafe-switch-0001', url)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.store.get('api', 'shared-sheets')).toEqual(before);
  });
  it('requires a reviewed preview and the current vendor and row revision before creating authorization', async () => {
    const f = await fixture();
    await expect(f.service.handle({ action: 'start', ...f.request })).rejects.toThrow('Review permissions');
    for (const changes of [{ expected_updated_at: 19 }, { base_url: 'https://www.googleapis.com/drive/v3' }, { vendor: 'different' }]) {
      await expect(f.service.handle({ action: 'preview', ...f.request, ...changes })).rejects.toThrow(/changed|keeps the saved vendor/);
    }
    expect(f.fetch.mock.calls.some(([input]) => new URL(input.toString()).pathname.startsWith('/connect/sessions'))).toBe(false);
  });
  it('does not overwrite a metadata edit made while the replacement API is being checked', async () => {
    const f = await fixture(); const { auth } = await f.authorize(); const resume = f.pause();
    const applying = f.apply(auth); const rejected = expect(applying).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([input]) => new URL(input.toString()).pathname.startsWith('/proxy/'))).toBe(true));
    f.store.upsert({ ...f.store.get('api', 'shared-sheets')!, display_name: 'Changed elsewhere', updated_at: 21 });
    const latest = f.store.get('api', 'shared-sheets'); resume(); await rejected;
    expect(f.store.get('api', 'shared-sheets')).toEqual(latest);
  });
  it('keeps newer use observations while the old authentication stays usable during verification', async () => {
    const f = await fixture(); const original = f.store.get('api', 'shared-sheets')!; const { auth } = await f.authorize(); const resume = f.pause();
    const applying = f.apply(auth);
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([input]) => new URL(input.toString()).pathname.startsWith('/proxy/'))).toBe(true));
    expect(await f.decode(f.store.get('api', 'shared-sheets')!)).toMatchObject({ type: 'oauth2_refresh' });
    f.store.upsert({ ...original, last_used_at: 100, health_json: '{"status":"auth_failed","last_probed_at":101}' });
    resume(); await applying;
    expect(f.store.get('api', 'shared-sheets')).toMatchObject({ last_used_at: 100 });
    expect(JSON.parse(f.store.get('api', 'shared-sheets')!.health_json!)).toEqual({ status: 'ok', last_probed_at: 1_000_000 });
  });
  it('can switch to a profile for a different Nango environment without changing the named service', async () => {
    const f = await fixture(true); const oldProfile = f.saved.profile.id;
    const target = await f.service.handle({ action: 'save_profile', broker: 'nango', label: 'Other environment',
      base_url: 'https://other.nango.test', api_key: 'other-fixture-key' });
    if (target.action !== 'save_profile') throw new Error('Fixture profile');
    f.request.profile_id = target.profile.id;
    f.profiles.rememberAccountScopes('https://other.nango.test', 'sheets', JSON.stringify([201, Date.parse('2026-10-01T00:00:00Z')]), [scope]);
    const { auth } = await f.authorize(); await f.apply(auth);
    expect(await f.decode(f.store.get('api', 'shared-sheets')!)).toMatchObject({ broker_profile_id: target.profile.id });
    expect(f.profiles.list().map(profile => profile.id)).toContain(oldProfile);
    expect(f.store.list()).toHaveLength(1);
  });
});
