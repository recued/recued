import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileSourceAuthentication } from '../file-source-authentication.js';
import { getVendorProvider, type ConnectionAuth, type ConnectionRow, type FileSourceOAuthProvider } from '@recued/contracts';
import type { FileConnectionCredential } from '../file-source-adapters/index.js';
import { buildFileMetaSnapshot, type FileMetaStore, type FileMetaRow } from '../storage/file-meta-store.js';

const fixture = (provider: FileSourceOAuthProvider = 'google', config: Record<string, unknown> = {}) => {
  let time = 1000; let registry: string | undefined = 'source-incarnation'; let authSource = 'original-grant'; let locked = false;
  let changed = false; let incomplete = false; let anonymous = 401; let differentNamespace = false; let noProfile = false;
  let empty = false; let redirect = false; let malformed = false; let large = false; let outside = false;
  let gate: Promise<void> | undefined; let anonymousGate: Promise<void> | undefined; let unlockGate: Promise<void> | undefined;
  let downloadGate: Promise<void> | undefined;
  let anonymousRedirect = false; let admitted = true; let differentBytes = false; let contentStatus = 200;
  let mirror: FileMetaRow[] = [{scope:provider+'.work.file',target_id:'file-1',meta:buildFileMetaSnapshot({provider,remote_id:'file-1',filename:'Report.pdf',mime_type:'application/pdf'},1)}];
  const verificationFiles: Pick<FileMetaStore,'get'|'browse'> = {
    get: (scope,id) => mirror.find(r=>r.scope===scope&&r.target_id===id)??null,
    browse: (scope,query,limit,after) => mirror.filter(r=>r.scope===scope&&(!after||r.target_id>after)&&r.meta.filename.includes(query)).sort((a,b)=>a.target_id.localeCompare(b.target_id)).slice(0,limit),
  };
  const row: ConnectionRow = { pk: 'api/work', kind: 'api', name: 'work', display_name: 'Work', enrolled_at: 1, updated_at: 2,
    config_json: JSON.stringify({ vendor: provider, base_url: getVendorProvider(provider)!.default_base_url, ...config }), auth_ciphertext: 'original-encrypted' };
  const original: ConnectionAuth = { type: 'bearer', token: 'original-secret' };
  const target: ConnectionAuth = { type: 'oauth2_refresh', client_id: 'new-app', refresh_token: 'new-refresh', token_endpoint: 'https://oauth2.googleapis.com/token',
    current_access_token: 'target-secret', expires_at: 10_000_000 };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const u = new URL(String(input)); const token = new Headers(init?.headers).get('authorization');
    if (!token) {
      await anonymousGate;
      if (anonymousRedirect && u.pathname.endsWith('/about')) return new Response(null, { status: 302, headers: { Location: '/identity-control' } });
      return Response.json({}, { status: anonymous });
    }
    const selected = token === 'Bearer target-secret';
    if (selected) await gate;
    if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/leak' } });
    const id = selected && changed ? 'other-user' : 'same-user';
    if (u.pathname.endsWith('/about')) return Response.json(malformed ? {} : { user: { permissionId: id, emailAddress: 'owner@example.test' } });
    if (u.pathname === '/v1.0/me') return Response.json(noProfile ? {} : { id, mail: 'owner@example.test' }, { status: noProfile ? 403 : 200 });
    if (u.pathname === '/v1.0/me/drive') return Response.json({ id: id + '-personal-drive' });
    if (u.pathname.endsWith('/get_current_account')) return Response.json({ account_id: id, email: 'owner@example.test', root_info: { root_namespace_id: selected && differentNamespace ? 'other-root' : 'root' } });
    if (u.pathname.endsWith('/users/me')) return Response.json({ id, login: 'owner@example.test' });
    if(u.searchParams.get('alt')==='media'||u.pathname.endsWith('/content')||u.pathname.endsWith('/download')) { await downloadGate; return new Response(selected&&differentBytes?'wrong bytes':'%PDF file',{status:contentStatus,headers:{'Content-Type':'application/pdf'}}); }
    const fileId = selected && outside ? 'newly-visible' : 'file-1';
    if (u.pathname.endsWith('/startPageToken')) return Response.json({ startPageToken: 'preview-token-never-saved' });
    if (u.pathname.endsWith('/files')) {
      if (large) return new Response('x'.repeat(17000000));
      return Response.json({ files: empty ? [] : [{ id: fileId, name: 'Report.pdf', mimeType: 'application/pdf' }], ...(incomplete ? { incompleteSearch: true } : {}) });
    }
    if (u.pathname.endsWith('/root/delta')) return Response.json({ value: empty ? [] : [{ id: fileId, name: 'Report.pdf', file: { mimeType: 'application/pdf' }, parentReference: { path: '/drive/root:/Work' } }],
      ...(incomplete ? {} : { '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=preview' }) });
    if (u.pathname.endsWith('/files/list_folder')) return Response.json({ entries: empty ? [] : [{ '.tag': 'file', id: fileId, name: 'Report.pdf', path_display: '/Work/Report.pdf' }], has_more: incomplete, cursor: incomplete ? undefined : 'preview-cursor' });
    if (u.pathname.endsWith('/events')) return Response.json({ entries: [], next_stream_position: '1234567890123456789' });
    if (u.pathname.includes('/folders/')) return Response.json({ entries: empty ? [] : [{ type: 'file', id: fileId, name: 'Report.pdf', path_collection: { entries: [{ id: '0', name: 'All Files' }] } }], total_count: empty ? 0 : 1, offset: 0, limit: 1000 });
    throw new Error('Unexpected provider request ' + u);
  });
  const resolve = vi.fn(async (): Promise<FileConnectionCredential> => ({ auth: original, config: JSON.parse(row.config_json) as Record<string, unknown> }));
  const managedFetch = vi.fn(async (_auth: unknown, url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: 'Bearer target-secret' } }));
  const service = createFileSourceAuthentication({ rows: () => [row], resolveConnection: resolve, registration: () => registry, authSourceId: () => authSource,
    verificationFiles, admitRemoteFetch:()=>admitted,
    unlock: async () => { await unlockGate; if (locked) throw new Error('private locked'); return original; }, fetch, managedFetch, now: () => time });
  return { service, row, target, fetch, managedFetch, resolve,
    change: () => { changed = true; }, incomplete: () => { incomplete = true; }, namespace: () => { differentNamespace = true; },
    anonymous: (status: number) => { anonymous = status; }, lock: () => { locked = true; },
    expire: () => { time += 31 * 60_000; }, replace: () => { registry = 'replacement'; }, remove: () => { registry = undefined; },
    rotate: () => { authSource = 'different-grant'; }, noProfile: () => { noProfile = true; }, empty: () => { empty = true; },
    redirect: () => { redirect = true; }, malformed: () => { malformed = true; }, large: () => { large = true; }, outside: () => { outside = true; },
    pauseDownload: () => { let release!:()=>void;downloadGate=new Promise<void>(r=>{release=r;});return release; },
    pause: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
    pauseAnonymous: () => { let release!: () => void; anonymousGate = new Promise<void>(r => { release = r; }); return release; },
    pauseUnlock: () => { let release!: () => void; unlockGate = new Promise<void>(r => { release = r; }); return release; },
    anonymousRedirect: () => { anonymousRedirect = true; },
    revoke:()=>{admitted=false;}, differentBytes:()=>{differentBytes=true;}, contentFail:()=>{contentStatus=403;},
    manyFiles:()=>{mirror=Array.from({length:28},(_,i)=>{const id='file-'+String(i).padStart(2,'0');return {scope:provider+'.work.file',target_id:id,meta:buildFileMetaSnapshot({provider,remote_id:id,filename:'Report '+id},1)};});},
    malformedMirror:()=>{mirror[0]!.scope='other-source';},
  };
};
afterEach(() => vi.useRealTimers());
describe('same-source file authentication metadata proof', () => {
  it.each(['google','onedrive','sharepoint','dropbox','box'] as const)('proves %s through its production adapter without retaining candidate tokens or cursors', async provider => {
    const f = fixture(provider, provider === 'sharepoint' ? { drive_id: 'team-library' } : {});
    const before = { ...f.row }; const pending = await f.service.prepare('work', 2);
    expect(pending).toMatchObject({ status: 'pending', provider, file_count: 1, current: { status: 'known', email: 'owner@example.test' } });
    const proof = await f.service.preview(f.row, f.target);
    expect(proof).toMatchObject({ status: 'verified', target: { account_id: provider === 'onedrive' || provider === 'sharepoint' ? 'drive:same-user-personal-drive' : 'same-user' }, file_count: 1 });
    expect(f.row).toEqual(before); expect(JSON.stringify(proof)).not.toMatch(/secret|refresh|preview-token|preview-cursor|Report.pdf/);
    expect(f.fetch.mock.calls.every(([, init]) => ['GET','POST'].includes(init?.method ?? ''))).toBe(true);
    if (provider === 'dropbox') expect(f.fetch.mock.calls.some(([url, init]) => String(url).includes('get_current_account') && init?.method === 'POST')).toBe(true);
    if (provider === 'sharepoint') expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/drives/team-library/root/delta'))).toBe(true);
  });
  it('uses a protected personal-drive identity when Graph /me needs unavailable permissions', async () => {
    const f = fixture('onedrive'); f.noProfile(); await f.service.prepare('work');
    expect(await f.service.preview(f.row, f.target)).toMatchObject({ current: { account_id: 'drive:same-user-personal-drive' }, target: { account_id: 'drive:same-user-personal-drive' } });
  });
  it('uses the broker proxy without extracting or saving vendor tokens', async () => {
    const f = fixture('dropbox'); await f.service.prepare('work');
    expect(await f.service.preview(f.row, { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'dropbox', connection_id: 'account', target_origin: 'https://api.dropboxapi.com', requested_scopes: [] })).toMatchObject({ status: 'verified' });
    expect(f.managedFetch).toHaveBeenCalled(); expect(JSON.stringify(await f.service.preview(f.row))).not.toContain('target-secret');
  });
  it('rejects another account before reading its file listing', async () => {
    const f = fixture(); await f.service.prepare('work'); f.fetch.mockClear(); f.change();
    await expect(f.service.preview(f.row, f.target)).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/files'))).toBe(false);
  });
  it('rejects a changed Dropbox namespace even for the same account', async () => {
    const f = fixture('dropbox'); await f.service.prepare('work'); f.namespace(); await expect(f.service.preview(f.row, f.target)).rejects.toThrow('namespace');
  });
  it.each(['google','onedrive','sharepoint','dropbox'] as const)('refuses incomplete %s pagination', async provider => {
    const f = fixture(provider); await f.service.prepare('work'); f.incomplete();
    await expect(f.service.preview(f.row, f.target)).rejects.toThrow('complete file metadata');
  });
  it.each(['google','onedrive','dropbox','box'] as const)('refuses a changed visible file set for %s', async provider => {
    const f = fixture(provider); await f.service.prepare('work'); f.outside(); await expect(f.service.preview(f.row, f.target)).rejects.toThrow('visible file set');
  });
  it('accepts an empty source only with a known matching account and a proven complete walk', async () => {
    const f = fixture(); f.empty(); await f.service.prepare('work'); expect(await f.service.preview(f.row, f.target)).toMatchObject({ status: 'verified', file_count: 0 });
    f.change(); await expect(f.service.preview(f.row, f.target)).rejects.toThrow('different vendor account');
  });
  it.each([200,404,500])('rejects an anonymous identity control returning %s', async status => {
    const f = fixture(); f.anonymous(status); await expect(f.service.prepare('work')).rejects.toThrow('protected vendor');
  });
  it.each(['expire','replace','remove','rotate'] as const)('fences %s before the final swap', async action => {
    const f = fixture(); await f.service.prepare('work'); f[action](); expect(() => f.service.assertCurrent('work')).toThrow(/review|reviewed/);
  });
  it('fences a source changed while candidate metadata is in flight', async () => {
    const f = fixture(); await f.service.prepare('work'); const resume = f.pause(); const reading = f.service.preview(f.row, f.target);
    await vi.waitFor(() => expect(f.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer target-secret')).toBe(true));
    f.replace(); resume(); await expect(reading).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['lock','redirect','malformed','large'] as const)('keeps failures sanitized for %s', async action => {
    const f = fixture(); await f.service.prepare('work'); f[action]();
    const error: unknown = await f.service.preview(f.row, f.target).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'credential_verification_failed' }); expect(JSON.stringify(error)).not.toMatch(/original-secret|target-secret|private locked|evil.invalid/);
  });
  it('stops waiting when a broker ignores cancellation and discards the late reply', async () => {
    const f = fixture(); await f.service.prepare('work'); const resume = f.pause(); const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
    try {
      const checking = f.service.preview(f.row, f.target); const rejection = expect(checking).rejects.toMatchObject({ code: 'credential_verification_failed' });
      await vi.waitFor(() => expect(f.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer target-secret')).toBe(true));
      controller.abort(); await rejection; resume();
    } finally { timeout.mockRestore(); resume(); }
  });
  it('refuses redirects in the anonymous identity control', async () => {
    const f = fixture(); f.anonymousRedirect();
    await expect(f.service.prepare('work')).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.fetch.mock.calls.some(([url]) => String(url).endsWith('/identity-control'))).toBe(false);
  });
  it.each(['pauseAnonymous', 'pauseUnlock'] as const)('keeps %s inside the complete snapshot deadline', async pause => {
    const f = fixture(); const resume = f[pause](); const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let result: unknown; let finished = false;
    const checking = f.service.prepare('work').then(value => { result = value; finished = true; }, error => { result = error; finished = true; });
    try {
      if (pause === 'pauseAnonymous') await vi.waitFor(() => expect(f.fetch.mock.calls.some(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true));
      else for (let i = 0; i < 24; i++) await Promise.resolve();
      controller.abort();
      for (let i = 0; i < 48; i++) await Promise.resolve();
      expect(finished).toBe(true);
      expect(result).toMatchObject({ code: 'credential_verification_failed' });
      expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/files'))).toBe(false);
    } finally { resume(); await checking; timeout.mockRestore(); }
  });
  it('checks the saved import scope using the same matcher as sync', async () => {
    const f = fixture('dropbox', { import_scope: 'Different/**' }); await f.service.prepare('work'); f.outside();
    expect(await f.service.preview(f.row, f.target)).toMatchObject({ status: 'verified', file_count: 0, selections: ['Existing vendor root', 'Import scope: Different/**'] });
  });
  it('keeps unrelated vendor API services outside the file proof', async () => {
    const f = fixture(); f.row.config_json = JSON.stringify({ vendor: 'google', base_url: 'https://sheets.googleapis.com/v4' });
    expect(await f.service.prepare('work')).toBeNull(); expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('explicit selected-file preparation',()=>{
  it('lists saved source files locally, with search and stable pagination',async()=>{
    const f=fixture();f.manyFiles();const first=await f.service.files('work',2);expect(first.files).toHaveLength(25);expect(first.next_cursor).toBe('file-24');
    expect((await f.service.files('work',2,'',first.next_cursor)).files.map(f=>f.remote_id)).toEqual(['file-25','file-26','file-27']);
    expect((await f.service.files('work',2,'file-27')).files).toHaveLength(1);expect(f.fetch).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();
    await expect(f.service.files('work',1)).rejects.toMatchObject({code:'conflict'});await expect(f.service.files('work',2,'x\n')).rejects.toMatchObject({code:'bad_request'});
  });
  it.each(['lock','revoke'] as const)('does not disclose local file choices with %s',async action=>{
    const f=fixture();f[action]();expect(await f.service.files('work',2)).toMatchObject({available:false,files:[]});expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['google','onedrive','sharepoint','box','dropbox'] as const)('checks only the explicitly chosen %s file before and after authorization',async provider=>{
    const f=fixture(provider,provider==='sharepoint'?{drive_id:'library'}:{});const before={...f.row};
    const pending=await f.service.prepare('work',2,'file-1');expect(pending?.download).toMatchObject({remote_id:'file-1',status:'pending',mode:'download',comparison:'same_bytes'});
    const managed={type:'managed_oauth' as const,broker_profile_id:'cloud',integration_id:provider,connection_id:'account',target_origin:getVendorProvider(provider)!.default_base_url.split('/').slice(0,3).join('/'),requested_scopes:[]};
    const preview=await f.service.preview(f.row,managed);expect(preview?.download).toMatchObject({...pending!.download,status:'verified'});
    expect(f.row).toEqual(before);expect(JSON.stringify(preview)).not.toMatch(/digest|original-secret|target-secret|%PDF/);
    const contentCalls=f.fetch.mock.calls.filter(([url])=>{const u=new URL(String(url));return u.searchParams.has('alt')||u.pathname.endsWith('/content')||u.pathname.endsWith('/download');});expect(contentCalls).toHaveLength(4);
    if(provider==='dropbox')expect(f.managedFetch.mock.calls.some(([auth,url])=>String(url).includes('content.dropboxapi.com')&&(auth as {target_origin:string}).target_origin==='https://content.dropboxapi.com')).toBe(true);
  });
  it('requires chosen files to belong to the local source and the live scoped file set',async()=>{
    const f=fixture();await expect(f.service.prepare('work',2,'unlisted')).rejects.toThrow('already listed');expect(f.fetch).not.toHaveBeenCalled();
    f.empty();await expect(f.service.prepare('work',2,'file-1')).rejects.toThrow('no longer visible');expect(f.fetch.mock.calls.some(([url])=>String(url).includes('alt=media'))).toBe(false);
  });
  it.each(['differentBytes','contentFail','revoke'] as const)('keeps saved authentication when selected-file %s fails',async change=>{
    const f=fixture();await f.service.prepare('work',2,'file-1');const before={...f.row};f[change]();
    await expect(f.service.preview(f.row,f.target)).rejects.toMatchObject({code:'credential_verification_failed'});expect(f.row).toEqual(before);
  });
  it('pins each explicit preparation and fences capability revocation at apply',async()=>{
    const f=fixture();const first=await f.service.prepare('work',2,'file-1');const next=await f.service.prepare('work',2,'file-1');expect(first!.download!.review_id).not.toBe(next!.download!.review_id);
    f.revoke();expect(()=>f.service.assertCurrent('work')).toThrow('downloads are disabled');
    const metadata=await f.service.prepare('work',2);expect(metadata?.download).toBeUndefined();expect(()=>f.service.assertCurrent('work')).not.toThrow();
  });
});


describe('audit: source credential identity during original preparation',()=>{
  it.each(['metadata','download','metadata-only'] as const)('refuses an owner credential replacement during %s',async stage=>{
    const f=fixture();const resume=stage==='download'?f.pauseDownload():f.pauseAnonymous();
    const checking=f.service.prepare('work',2,stage==='metadata-only'?undefined:'file-1');const rejection=expect(checking).rejects.toMatchObject({code:'conflict'});
    try{
      await vi.waitFor(()=>expect(f.fetch.mock.calls.some(([raw,init])=>stage!=='download'?!new Headers(init?.headers).has('authorization'):new URL(String(raw)).searchParams.get('alt')==='media'&&new Headers(init?.headers).has('authorization'))).toBe(true));
      f.rotate();resume();await rejection;expect(()=>f.service.assertCurrent('work')).toThrow();
    }finally{resume();await checking.catch(()=>{});}
  });
});
