import Database from 'better-sqlite3';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFileVendorDeclaration, type ManagedOAuthAuth, type DirectOAuthAuthorization, type ManagedOAuthImpactPreview } from '@recued/contracts';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createFileSourceConnectionResolver } from '../file-source-connection-resolver.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createFileMetaStore, ensureFileMetaSchema, buildFileMetaSnapshot } from '../storage/file-meta-store.js';
import { createFileSourceSyncStateStore, initialFileSourceSyncState, ensureFileSourceSyncStateSchema } from '../storage/file-source-sync-state.js';
import { wireFileSourceBoot } from '../file-source-boot.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';
import { buildFileSourceAdapterResolver } from '../file-source-adapters/index.js';
import { runFileSourceSync } from '../file-source-sync.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const base = 'https://www.googleapis.com/drive/v3'; const scope = 'https://www.googleapis.com/auth/drive.readonly'; const source = 'google.work.file';
const fixture = async (brokerOriginal = false, renewOriginal = false) => {
  const db = new Database(':memory:'); databases.push(db); const key = () => new Uint8Array(32).fill(27);
  ensureWorkEntitySchema(db); ensureFileMetaSchema(db); ensureFileSourceSyncStateSchema(db);
  const store = createConnectionStore(db); const sources = createWorkEntityStore(db); const meta = createFileMetaStore(db); const sync = createFileSourceSyncStateStore(db);
  const profiles = createManagedOAuthProfileStore(db, key);
  let originalDownloadGate:Promise<void>|undefined;
  let admitted=true; let wrongBytes=false; let downloadReads=0;
  let targetId = 'same-account'; let files = ['one']; let partial = false; let count = 0;
  let gate: Promise<void> | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const u = new URL(String(input)); const headers = new Headers(init?.headers);
    if (u.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'drive', provider: 'google-drive' }] });
    if (u.pathname === '/integrations/drive') return Response.json({ data: { unique_key: 'drive', provider: 'google-drive', credentials: { type: 'OAUTH2', scopes: scope } } });
    if (u.pathname === '/connections') return Response.json({ connections: [{ connection_id: 'target', provider_config_key: 'drive', id: 201, created: '2026-10-01T00:00:00Z' },
      { connection_id: 'original', provider_config_key: 'drive', id: 200, created: '2026-10-01T00:00:00Z' }] });
    if (u.pathname === '/token') {
      const original = new URLSearchParams(String(init?.body)).get('client_id') === 'old-client';
      return Response.json({ access_token: original ? 'original-renewed' : 'native-target', refresh_token: original ? 'old-rotated' : 'native-rotated', expires_in: 3600, scope });
    }
    const proxy = u.pathname.startsWith('/proxy/');
    const path = proxy ? u.pathname.slice(6) : u.pathname;
    const authorization = headers.get('authorization');
    if (!proxy && !authorization) return Response.json({}, { status: 401 });
    const target = proxy ? headers.get('connection-id') === 'target' : authorization === 'Bearer native-target';
    if (target) { count++; await gate; }
    if(u.searchParams.get('alt')==='media'){downloadReads++;if(!target)await originalDownloadGate;return new Response(target&&wrongBytes?'other-file':'%PDF file',{headers:{'Content-Type':'application/pdf'}});}
    if (path.endsWith('/about')) return Response.json({ user: { permissionId: target ? targetId : 'same-account', emailAddress: 'owner@example.test' } });
    if (path.endsWith('/startPageToken')) return Response.json({ startPageToken: 'unused-preview-cursor' });
    if (path.endsWith('/files')) return Response.json({ files: (target ? files : ['one']).map(id => ({ id, name: id + '.pdf', mimeType: 'application/pdf' })), ...(target && partial ? { incompleteSearch: true } : {}) });
    if (path.endsWith('/changes')) return Response.json({ changes: [], newStartPageToken: 'next-runtime-cursor' });
    throw new Error('Unexpected fixture URL ' + u);
  });
  const decode = (row: NonNullable<ReturnType<typeof store.get>>) => decodeAuthFromStorage(row.auth_ciphertext, row, key);
  let resolve!: ReturnType<typeof createFileSourceConnectionResolver>;
  const service = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: decode, fetchImpl: fetch, now: () => 1_000_000,
    connectionUses: () => ({ complete: true, uses: [{ kind: 'file', id: source, label: 'Work files' }] }),
    fileSources: { verificationFiles:meta, admitRemoteFetch:()=>admitted, resolveConnection: name => resolve(name), authSourceId: name => store.getAuthSourceId?.('api',name),
      registration: id => { const s = sources.getSource(id); return s ? JSON.stringify([s.id,s.registered_at]) : undefined; } } });
  const saved = await service.handle({ action: 'save_profile', broker: 'nango', label: 'Cloud', base_url: 'https://api.nango.dev', api_key: 'fixture-key' });
  if (saved.action !== 'save_profile') throw new Error('Fixture profile');
  const broker: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: saved.profile.id, integration_id: 'drive', connection_id: 'original', target_origin: 'https://www.googleapis.com', requested_scopes: [scope], required_scopes: [scope] };
  store.upsert({ kind: 'api', name: 'work', display_name: 'Keep this name', enrolled_at: 10, updated_at: 20, last_used_at: 30,
    config_json: JSON.stringify({ vendor: 'google', base_url: base, import_scope: 'Work/**', owner_config: { keep: true } }),
    subresource_path: '/folder', auth_ciphertext: await encodeAuthForStorage(brokerOriginal ? broker : { type: 'oauth2_refresh', client_id: 'old-client', refresh_token: 'old-refresh', token_endpoint: 'https://oauth.example.test/token', current_access_token: 'original-native', expires_at: renewOriginal ? 1_000_000 : 10_000_000 }, { kind: 'api', name: 'work' }, key) });
  wireFileSourceBoot({ connectionStore: store, store: sources, now: () => 10 });
  sync.upsert({ ...initialFileSourceSyncState(source), cursor_blob: 'kept-runtime-cursor', last_full_walk_at: 1_000_000, last_success_at: 40 });
  meta.upsert({ scope: source, target_id: 'one', meta: buildFileMetaSnapshot({ provider: 'google', remote_id: 'one', filename: 'one.pdf', mime_type: 'application/pdf' },10), now: 10 });
  resolve = createFileSourceConnectionResolver({ connectionStore: store, decodeAuthFromStorage, encodeAuthForStorage, keyProvider: key, managedOAuth: service, fetchImpl: fetch, now: () => 1_000_000 });
  profiles.rememberAccountScopes('https://api.nango.dev', 'drive', JSON.stringify([201,Date.parse('2026-10-01T00:00:00Z')]), [scope]);
  const make = () => makeConnectionHandlers({ store, getEncryptionKey: key, managedOAuth: service, resolveFetch: fetch, now: () => 1_000_000,
    authenticationRepairTargets: () => [{ kind: 'file_source', source_id: source }] })!.handlers;
  const handlers = make();
  const prepare = (verification_file_id?:string) => handlers['collection.connection.managedOAuth']({ action: 'file_authentication_prepare', name: 'work', expected_updated_at: store.get('api','work')!.updated_at, ...(verification_file_id?{verification_file_id}:{}) },undefined as never);
  const authorize = async () => {
    const request = { profile_id: saved.profile.id, integration_id: 'drive', name: 'work', base_url: base, vendor: 'google', scopes: [scope], connection_id: 'target', switch_authentication: true as const, expected_updated_at: store.get('api','work')!.updated_at, include_account_impact: true as const };
    const preview = await service.handle({ action: 'preview', ...request }); if (preview.action !== 'preview') throw new Error('Preview');
    const result = await service.handle({ action: 'start', ...request, preview_fingerprint: preview.preview.fingerprint }); if (result.action !== 'reuse') throw new Error('Reuse');
    const impact = await service.handle({ action: 'account_impact', flow_id: result.flow_id, claim_secret: result.claim_secret }); if (impact.action !== 'account_impact') throw new Error('Impact');
    return { auth: result.auth, impact: impact.impact };
  };
  const direct = async () => {
    const review = await handlers['collection.connection.managedOAuth']({ action: 'review_direct_authentication', selections: [{ name: 'work', expected_updated_at: store.get('api','work')!.updated_at }], scopes: [scope],
      auth: { type: 'oauth2_refresh', client_id: 'new-client', client_secret: 'new-secret', token_endpoint: 'https://oauth.example.test/token', refresh_token: 'new-refresh' } }, undefined as never);
    if (review.action !== 'review_direct_authentication') throw new Error('Direct review'); return review;
  };
  const apply = (auth: ManagedOAuthAuth | DirectOAuthAuthorization, impact: ManagedOAuthImpactPreview, attempt_id = 'file-auth-switch-0001', revision = 20) => handlers['collection.connection.managedOAuth']({ action: 'apply_authentication_switch', name: 'work', expected_updated_at: revision,
    verification_url: base + '/about?fields=user', auth, impact_fingerprint: impact.fingerprint, attempt_id }, undefined as never);
  const state = () => ({ row: store.get('api','work')!, source: sources.getSource(source), sync: sync.get(source), file: meta.get(source,'one') });
  return { db, store, sources, sync, meta, service, handlers, make, prepare, authorize, direct, apply, state, fetch, resolve, decode,
    otherAccount: () => { targetId = 'other-account'; }, fewerFiles: () => { files = []; }, incomplete: () => { partial = true; },
    changeBrokerProfile:()=>service.handle({action:'save_profile',id:saved.profile.id,broker:'nango',label:'Changed broker',base_url:'https://api.nango.dev',api_key:'replacement-env-key'}),
    pauseOriginalDownload:()=>{let release!:()=>void;originalDownloadGate=new Promise<void>(r=>{release=r;});return release;},
    replaceCredential:async()=>{const old=store.get('api','work')!;return store.upsert({...old,updated_at:old.updated_at+1,auth_ciphertext:await encodeAuthForStorage({type:'bearer',token:'owner-replacement'},{kind:'api',name:'work'},key)});},
    wrongBytes:()=>{wrongBytes=true;}, revoke:()=>{admitted=false;}, downloadReads:()=>downloadReads,
    count: () => count, pause: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; } };
};
describe('file-source migration through the production switch boundary', () => {
  it('renews an expired original grant and switches with its new editor revision while preserving source state', async () => {
    const f = await fixture(false, true); const before = f.state(); const authSource = f.store.getAuthSourceId?.('api', 'work');
    const preparation = await f.prepare();
    if (preparation.action !== 'file_authentication_prepare') throw new Error('Preparation');
    expect(preparation.updated_at).toBeGreaterThan(before.row.updated_at);
    expect(f.store.getAuthSourceId?.('api', 'work')).toBe(authSource);
    expect(await f.decode(f.state().row)).toMatchObject({ type: 'oauth2_refresh', current_access_token: 'original-renewed', refresh_token: 'old-rotated' });
    for (const k of ['source', 'sync', 'file'] as const) expect(f.state()[k]).toEqual(before[k]);
    const reviewed = await f.authorize();
    await f.apply(reviewed.auth, reviewed.impact, 'renewed-file-auth-0001', preparation.updated_at);
    expect(await f.decode(f.state().row)).toMatchObject({ type: 'managed_oauth', connection_id: 'target' });
    for (const k of ['source', 'sync', 'file'] as const) expect(f.state()[k]).toEqual(before[k]);
  });
  it.each([false,true])('preserves source registration, mirror, cursor, import scope and connection metadata when brokerOriginal=%s', async brokerOriginal => {
    const f = await fixture(brokerOriginal); const before = f.state(); await f.prepare(); const reviewed = await f.authorize();
    expect(reviewed.impact.file_source).toMatchObject({ status: 'verified', file_count: 1, current: { account_id: 'same-account' }, target: { account_id: 'same-account' } });
    expect(f.state()).toEqual(before); const result = await f.apply(reviewed.auth,reviewed.impact); expect(result.action).toBe('apply_authentication_switch');
    const history = createAuthenticationIncidentStore(f.db);
    expect(history.history({ scope: { kind: 'file_source', source_id: source } }, 1_000_001).repairs).toMatchObject([
      { action: 'switch_authentication', status: 'applied', targets: [{ kind: 'connection', name: 'work' }, { kind: 'file_source', source_id: source }] }]);
    const after = f.state(); for (const k of ['source','sync','file'] as const) expect(after[k]).toEqual(before[k]);
    for (const k of ['name','display_name','config_json','enrolled_at','last_used_at','subresource_path'] as const) expect(after.row[k]).toEqual(before.row[k]);
    expect(await f.decode(after.row)).toMatchObject({ type: 'managed_oauth', connection_id: 'target' });
    const calls = f.fetch.mock.calls.length; await f.apply(reviewed.auth,reviewed.impact); expect(f.fetch.mock.calls).toHaveLength(calls);
    const outcome = await f.make()['collection.connection.credentialRotationStatus']({ kind: 'api', name: 'work', attempt_id: 'file-auth-switch-0001' },undefined as never);
    expect(outcome.outcome).toMatchObject({ status: 'succeeded' }); expect(f.fetch.mock.calls).toHaveLength(calls);
    const adapter = buildFileSourceAdapterResolver({ resolveConnection: f.resolve, fetchImpl: (url,init) => { const { body, ...rest } = init; return f.fetch(url,{ ...rest, ...(body !== undefined ? { body: body as BodyInit } : {}) }); } })('google')!;
    const sync = await runFileSourceSync({ store: f.meta, syncState: f.sync, listFiles: adapter, now: () => 1_000_001 }, { source_id: source, connection_name: 'work', declaration: getFileVendorDeclaration('google')! });
    expect(sync.ok).toBe(true); expect(f.sync.get(source)!.cursor_blob).toBe('next-runtime-cursor'); expect(f.meta.get(source,'one')).toEqual(before.file);
  });
  it('supports reverse migration from Nango to a fresh direct OAuth review', async () => {
    const f = await fixture(true); const before = f.state(); await f.prepare(); const reviewed = await f.direct();
    expect(reviewed.impact.file_source?.status).toBe('verified'); await f.apply(reviewed.auth,reviewed.impact);
    expect(await f.decode(f.state().row)).toMatchObject({ type: 'oauth2_refresh', client_id: 'new-client', refresh_token: 'native-rotated' });
    expect(f.state().sync).toEqual(before.sync); expect(f.state().file).toEqual(before.file); expect(f.state().source).toEqual(before.source);
  });
  it.each(['otherAccount','fewerFiles','incomplete'] as const)('keeps the saved source when candidate %s changes after review', async change => {
    const f = await fixture(); await f.prepare(); const reviewed = await f.authorize(); const before = f.state(); f[change]();
    await expect(f.apply(reviewed.auth,reviewed.impact)).rejects.toMatchObject({ code: 'credential_verification_failed' }); expect(f.state()).toEqual(before);
    const outcome = await f.handlers['collection.connection.credentialRotationStatus']({ kind: 'api', name: 'work', attempt_id: 'file-auth-switch-0001' },undefined as never);
    expect(outcome.outcome).toMatchObject({ status: 'failed' });
  });
  it('requires the reviewed file impact rather than accepting a generic URL check', async () => {
    const f = await fixture(); await f.prepare(); const { auth } = await f.authorize(); const before = f.state();
    await expect(f.handlers['collection.connection.managedOAuth']({ action: 'apply_authentication_switch', attempt_id: 'bypass-file-0001', name: 'work', expected_updated_at: 20, auth, verification_url: base + '/about' },undefined as never)).rejects.toThrow('Review the matching file source');
    expect(f.state()).toEqual(before);
  });
  it('keeps changes made to the source while verification is pending', async () => {
    const f = await fixture(); await f.prepare(); const reviewed = await f.authorize(); const beforeCount = f.count(); const resume = f.pause();
    const applying = f.apply(reviewed.auth,reviewed.impact); const rejection = expect(applying).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(f.count()).toBeGreaterThan(beforeCount));
    const row = f.store.get('api','work')!; f.store.upsert({ ...row, config_json: JSON.stringify({ vendor: 'google', base_url: base, import_scope: 'Different/**' }), updated_at: 21 });
    const changed = f.state(); resume(); await rejection; expect(f.state()).toEqual(changed);
  });
  it.each(['direct','broker'] as const)('applies the same file proof in a %s bulk migration', async target => {
    const f = await fixture(); await f.prepare('one'); const reviewed = target === 'direct' ? await f.direct() : await f.authorize(); const before = f.state();
    const result = await f.handlers['collection.connection.managedOAuth']({ action: 'migration_prepare', id: 'file-source-bulk-migration-0001',
      selections: [{ name: 'work', expected_updated_at: 20, verification_url: base + '/about?fields=user' }],
      auth: reviewed.auth, impact_fingerprint: reviewed.impact.fingerprint },undefined as never);
    if (result.action !== 'migration_prepare') throw new Error('Bulk review');
    let ready = result.migration;
    await vi.waitFor(async () => {
      const status = await f.handlers['collection.connection.managedOAuth']({ action: 'migration_status', id: result.migration.id },undefined as never);
      if (status.action !== 'migration_status') throw new Error('Bulk status'); ready = status.migrations[0]!; expect(ready.state).toBe('ready');
    });
    expect(ready.rows[0]!.state).toBe('verified'); expect(ready.rows[0]!.impact?.file_source?.status).toBe('verified');expect(ready.rows[0]!.impact?.file_source?.download?.status).toBe('verified');
    expect(f.state()).toEqual(before);
    const applying = await f.handlers['collection.connection.managedOAuth']({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! },undefined as never);
    if (applying.action !== 'migration_apply') throw new Error('Bulk apply');
    await vi.waitFor(async () => {
      const status = await f.handlers['collection.connection.managedOAuth']({ action: 'migration_status', id: result.migration.id },undefined as never);
      if (status.action !== 'migration_status') throw new Error('Bulk status'); expect(status.migrations[0]!.state).toBe('completed'); expect(status.migrations[0]!.rows[0]!.state).toBe('migrated');
    });
    expect(f.state().source).toEqual(before.source); expect(f.state().sync).toEqual(before.sync); expect(f.state().file).toEqual(before.file);
  });
  it('rolls back a failed durable credential transaction without changing source or consuming the authorization', async () => {
    const f = await fixture(); await f.prepare(); const reviewed = await f.authorize(); const before = f.state();
    vi.spyOn(f.store,'completeCredentialRotationAttempt').mockImplementationOnce(() => { throw new Error('fixture transaction failure'); });
    await expect(f.apply(reviewed.auth,reviewed.impact)).rejects.toThrow('fixture transaction failure'); expect(f.state()).toEqual(before);
    await f.apply(reviewed.auth,reviewed.impact,'file-auth-switch-0002'); expect(await f.decode(f.state().row)).toMatchObject({ type: 'managed_oauth' });
  });
});

describe('selected-file proof at the atomic authentication switch',()=>{
  it.each(['broker','direct'] as const)('verifies a chosen download before a %s switch without changing source state',async target=>{
    const f=await fixture(target==='direct');const before=f.state();const preparation=await f.prepare('one');
    expect(preparation.action==='file_authentication_prepare'&&preparation.file_source?.download).toMatchObject({remote_id:'one',status:'pending'});
    const reviewed=target==='broker'?await f.authorize():await f.direct();expect(reviewed.impact.file_source?.download).toMatchObject({remote_id:'one',status:'verified'});
    const reads=f.downloadReads();await f.apply(reviewed.auth,reviewed.impact);expect(f.downloadReads()).toBeGreaterThan(reads);
    for(const k of ['source','sync','file'] as const)expect(f.state()[k]).toEqual(before[k]);
    const after=f.downloadReads();await f.apply(reviewed.auth,reviewed.impact);expect(f.downloadReads()).toBe(after);
    await f.make()['collection.connection.credentialRotationStatus']({kind:'api',name:'work',attempt_id:'file-auth-switch-0001'},undefined as never);expect(f.downloadReads()).toBe(after);
  });
  it.each(['wrongBytes','revoke'] as const)('refuses %s introduced after review and preserves every saved source field',async change=>{
    const f=await fixture();await f.prepare('one');const reviewed=await f.authorize();const before=f.state();f[change]();
    await expect(f.apply(reviewed.auth,reviewed.impact)).rejects.toMatchObject({code:'credential_verification_failed'});expect(f.state()).toEqual(before);
  });
  it.each([undefined,'one'])('invalidates a reviewed file proof when preparation is replaced with %s',async next=>{
    const f=await fixture();await f.prepare('one');const reviewed=await f.authorize();const before=f.state();await f.prepare(next);
    await expect(f.apply(reviewed.auth,reviewed.impact)).rejects.toMatchObject({code:'conflict'});expect(f.state()).toEqual(before);
  });
});


describe('audit: production credential replacement while preparing a download',()=>{
  it('rejects the old-grant proof and preserves the owner replacement and all file state',async()=>{
    const f=await fixture();const originalId=f.store.getAuthSourceId?.('api','work');const resume=f.pauseOriginalDownload();const checking=f.prepare('one');const rejection=expect(checking).rejects.toMatchObject({code:'conflict'});
    try{
      await vi.waitFor(()=>expect(f.downloadReads()).toBe(1));await f.replaceCredential();const replaced=f.state();expect(f.store.getAuthSourceId?.('api','work')).not.toBe(originalId);
      resume();await rejection;expect(f.state()).toEqual(replaced);expect(await f.decode(f.state().row)).toMatchObject({token:'owner-replacement'});
      expect(()=>f.service.assertFileSourceSwitchCurrent?.('work')).toThrow();
    }finally{resume();await checking.catch(()=>{});}
  });
});


describe('audit: original broker context',()=>{
  it('invalidates a prepared Nango source when its broker credentials change',async()=>{
    const f=await fixture(true);await f.prepare('one');const before=f.state();await f.changeBrokerProfile();
    expect(()=>f.service.assertFileSourceSwitchCurrent?.('work')).toThrow();expect(f.state()).toEqual(before);
  });
  it('rejects a profile change while its original Nango download is pending',async()=>{
    const f=await fixture(true);const resume=f.pauseOriginalDownload();const checking=f.prepare('one');const rejection=expect(checking).rejects.toMatchObject({code:'conflict'});
    try{await vi.waitFor(()=>expect(f.downloadReads()).toBe(1));await f.changeBrokerProfile();const before=f.state();resume();await rejection;expect(f.state()).toEqual(before);}
    finally{resume();await checking.catch(()=>{});}
  });
  it('keeps a direct source review independent of an unused broker profile',async()=>{
    const f=await fixture(false);await f.prepare('one');await f.changeBrokerProfile();expect(()=>f.service.assertFileSourceSwitchCurrent?.('work')).not.toThrow();
  });
});
