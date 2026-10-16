import Database from 'better-sqlite3';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { GOOGLE_OAUTH_AUTHORIZE_URL,GOOGLE_OAUTH_TOKEN_URL } from '@recued/contracts';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { resolveConnectionOAuthApp } from '../connection-saved-oauth-app.js';
import { handleConnectionEnroll,handleConnectionCompleteVendorOAuth,makeConnectionHandlers,decodeAuthFromStorage,type ConnectionRpcDeps } from '../connection-handler.js';
import { createVendorOAuthFlowStore } from '../connection-vendor-oauth-flow.js';
import { handleVendorOAuthComplete } from '../connection-vendor-oauth-complete.js';
import { createVendorOAuthResultStore } from '../connection-vendor-oauth-flow.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
const databases:Database.Database[]=[];afterEach(()=>databases.splice(0).forEach(db=>db.close()));
const NOW=Date.parse('2026-10-14T12:00:00Z');const ORIGIN='https://server.example.test';
const endpoints={authorize_url:GOOGLE_OAUTH_AUTHORIZE_URL,token_endpoint:GOOGLE_OAUTH_TOKEN_URL};
const fixture=()=>{
  const db=new Database(':memory:');databases.push(db);let key:Buffer|null=Buffer.alloc(32,45);
  const saved=createOAuthAppConfigStore(db,{getEncryptionKey:()=>key});saved.setIssuer('google','saved-id','SERVER-ONLY-SECRET');
  const store=createConnectionStore(db);const deps:ConnectionRpcDeps={store,oauthAppConfig:saved,getEncryptionKey:()=>key,now:()=>NOW};
  const identity=createServerIdentity({store:createInMemoryServerKeyStore(),now:()=>NOW});
  const flows=createVendorOAuthFlowStore({now:()=>NOW});
  const fetcher=vi.fn(async(_url:string,_init?:{method?:string;headers?:Record<string,string>;body?:string})=>({ok:true,status:200,json:async()=>({access_token:'access-token',refresh_token:'new-refresh',scope:'drive.readonly',expires_in:3600}),text:async()=>''}));
  deps.fetcher=fetcher;deps.vendorOAuthStart={identity,flowStore:flows,serverPublicUrl:()=>ORIGIN};
  const auth={type:'oauth2_refresh' as const,client_id:'saved-id',refresh_token:'own-refresh',token_endpoint:GOOGLE_OAUTH_TOKEN_URL};
  const enroll={name:'drive',kind:'api' as const,display_name:'Drive',config:{vendor:'google',base_url:'https://www.googleapis.com/drive/v3'},auth,oauth_app_issuer:'google' as const};
  const complete={vendor:'google',client_id:'saved-id',code:'code',redirect_uri:'http://127.0.0.1:4319/webclient/oauth-callback.html',oauth_app_issuer:'google' as const};
  return{db,saved,store,deps,identity,flows,fetcher,auth,enroll,complete,lock:()=>{key=null;}};
};
describe('reuse a server-held OAuth app',()=>{
  it('refuses owner-supplied provenance inside credentials', async () => {
    const h = fixture();
    await expect(handleConnectionEnroll(h.deps, { ...h.enroll, auth: { ...h.auth, saved_oauth_app: { issuer: 'google', id: 'default' } } })).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.store.list()).toHaveLength(0);
  });
  it('uses the selected named app even when its Client ID matches the default and keeps API credentials after app removal', async () => {
    const h = fixture(); const app = h.saved.saveApp({ issuer: 'google', label: 'Separate work app', client_id: 'saved-id', client_secret: 'NAMED-SERVER-SECRET' });
    const complete = { ...h.complete, oauth_app_id: app.id };
    await handleConnectionCompleteVendorOAuth(h.deps, complete);
    expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('client_secret')).toBe('NAMED-SERVER-SECRET');
    await handleConnectionEnroll(h.deps, { ...h.enroll, oauth_app_id: app.id });
    h.saved.deleteApp('google', app.id, app.revision);
    expect(await decodeAuthFromStorage(h.store.get('api', 'drive')!.auth_ciphertext, { kind: 'api', name: 'drive' }, h.deps.getEncryptionKey)).toMatchObject({ client_secret: 'NAMED-SERVER-SECRET' });
    expect(h.saved.getClientSecret('google')).toBe('SERVER-ONLY-SECRET');
  });
  it.each([false, true])('pins a named app in signed callback flows, selected app removed=%s', async removed => {
    const h = fixture(); const app = h.saved.saveApp({ issuer: 'google', label: 'Work app', client_id: 'saved-id', client_secret: 'NAMED-SERVER-SECRET' });
    const started = await makeConnectionHandlers(h.deps)!.handlers['collection.connection.startVendorOAuth']({ ...h.complete,
      oauth_app_id: app.id, redirect_uri: ORIGIN + '/oauth/complete' }, undefined as never);
    if (removed) h.saved.deleteApp('google', app.id, app.revision);
    else h.saved.clearIssuer('google');
    const response = await handleVendorOAuthComplete({ identity: h.identity, flowStore: h.flows,
      resultStore: createVendorOAuthResultStore({ now: () => NOW }), oauthAppConfig: h.saved, serverPublicUrl: () => ORIGIN,
      fetcher: h.fetcher, now: () => NOW }, { method: 'GET', code: 'public-code', state: new URL(started.authorize_url).searchParams.get('state')! });
    if (removed) { expect(response.outcome).toBe('exchange_failed'); expect(h.fetcher).not.toHaveBeenCalled(); }
    else { expect(response.outcome).toBe('completed'); expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('client_secret')).toBe('NAMED-SERVER-SECRET'); }
  });
  it('keeps manual credential resolution unchanged',()=>{
    expect(resolveConnectionOAuthApp({client_id:'manual',client_secret:'manual-secret',token_endpoint:'https://own.example/token'})).toEqual({client_id:'manual',client_secret:'manual-secret'});
  });
  it('resolves only matching saved app credentials on the server',()=>{
    const h=fixture();expect(resolveConnectionOAuthApp({store:h.saved,issuer:'google',client_id:'saved-id',...endpoints})).toEqual({client_id:'saved-id',client_secret:'SERVER-ONLY-SECRET'});
    expect(JSON.stringify(h.db.prepare('SELECT * FROM oauth_app_config').all())).not.toContain('SERVER-ONLY-SECRET');
  });
  it.each(['unknown issuer','mixed secret','different issuer','unsafe endpoint','changed id','missing app','locked'])('refuses %s without resolving another app',reason=>{
    const h=fixture();const args:Parameters<typeof resolveConnectionOAuthApp>[0]={store:h.saved,issuer:'google',client_id:'saved-id',...endpoints};
    if(reason==='unknown issuer')args.issuer='other';if(reason==='mixed secret')args.client_secret='manual-secret';
    if(reason==='different issuer')args.issuer='microsoft';if(reason==='unsafe endpoint')args.token_endpoint='https://evil.example/token';
    if(reason==='changed id')args.client_id='old-id';if(reason==='missing app')h.saved.clearIssuer('google');if(reason==='locked')h.lock();
    expect(()=>resolveConnectionOAuthApp(args)).toThrow();
  });
  it('stores a complete encrypted credential snapshot and returns no app secret',async()=>{
    const h=fixture();const result=await handleConnectionEnroll(h.deps,h.enroll);const row=h.store.get('api','drive')!;
    expect(row.auth_ciphertext).not.toContain('SERVER-ONLY-SECRET');expect(JSON.stringify(result)).not.toContain('SERVER-ONLY-SECRET');
    expect(await decodeAuthFromStorage(row.auth_ciphertext,{kind:'api',name:'drive'},h.deps.getEncryptionKey)).toEqual({...h.auth,client_secret:'SERVER-ONLY-SECRET',saved_oauth_app:{issuer:'google',id:'default'}});
    expect(JSON.stringify(result)).not.toContain('oauth_app_issuer');h.saved.clearIssuer('google');
    expect(await decodeAuthFromStorage(row.auth_ciphertext,{kind:'api',name:'drive'},h.deps.getEncryptionKey)).toMatchObject({client_secret:'SERVER-ONLY-SECRET'});
  });
  it.each(['client changed','secret changed','removed'])('refuses %s during asynchronous encryption without saving a row',async change=>{
    const h=fixture();h.deps.getEncryptionKey=()=>{if(change==='removed')h.saved.clearIssuer('google');else h.saved.setIssuer('google',change==='client changed'?'new-id':'saved-id','NEW-SECRET');return Buffer.alloc(32,45);};
    await expect(handleConnectionEnroll(h.deps,h.enroll)).rejects.toThrow();expect(h.store.get('api','drive')).toBeNull();
  });
  it('rejects a saved app on another auth kind or token host before writing',async()=>{
    const h=fixture();await expect(handleConnectionEnroll(h.deps,{...h.enroll,auth:{type:'bearer',token:'token'}})).rejects.toMatchObject({code:'bad_request'});
    await expect(handleConnectionEnroll(h.deps,{...h.enroll,auth:{...h.auth,token_endpoint:'https://evil.example/token'}})).rejects.toMatchObject({code:'bad_request'});
    expect(h.store.list()).toHaveLength(0);
  });
  it('exchanges a local code with the saved secret and returns only the ordinary OAuth result',async()=>{
    const h=fixture();const result=await handleConnectionCompleteVendorOAuth(h.deps,h.complete);
    expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('client_secret')).toBe('SERVER-ONLY-SECRET');
    expect(result).toMatchObject({refresh_token:'new-refresh'});expect(JSON.stringify(result)).not.toContain('SERVER-ONLY-SECRET');
  });
  it('checks trusted effective registry endpoints rather than caller overrides',async()=>{
    const h=fixture();await handleConnectionCompleteVendorOAuth(h.deps,{...h.complete,authorize_url:'https://evil.example/authorize',token_endpoint:'https://evil.example/token'} as Parameters<typeof handleConnectionCompleteVendorOAuth>[1]);
    expect(h.fetcher.mock.calls[0]?.[0]).toBe(GOOGLE_OAUTH_TOKEN_URL);
  });
  it('refuses a generic destination before sending any saved secret',async()=>{
    const h=fixture();await expect(handleConnectionCompleteVendorOAuth(h.deps,{...h.complete,vendor:'generic',authorize_url:GOOGLE_OAUTH_AUTHORIZE_URL,token_endpoint:'https://evil.example/token'} as Parameters<typeof handleConnectionCompleteVendorOAuth>[1])).rejects.toMatchObject({code:'bad_request'});
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('does not return an authorization if the saved secret changes during exchange',async()=>{
    const h=fixture();h.fetcher.mockImplementationOnce(async()=>{h.saved.setIssuer('google','saved-id','NEW-SECRET');return{ok:true,status:200,json:async()=>({refresh_token:'new-refresh',access_token:'access',expires_in:3600,scope:'drive.readonly'}),text:async()=>''};});
    await expect(handleConnectionCompleteVendorOAuth(h.deps,h.complete)).rejects.toMatchObject({code:'oauth_app_changed'});
  });
  it('runs the signed public callback with the saved server-side credential',async()=>{
    const h=fixture();const slice=makeConnectionHandlers(h.deps)!;
    const started=await slice.handlers['collection.connection.startVendorOAuth']({...h.complete,redirect_uri:ORIGIN+'/oauth/complete'},undefined as never);
    expect(JSON.stringify(started)).not.toContain('SERVER-ONLY-SECRET');
    const results=createVendorOAuthResultStore({now:()=>NOW});
    const response=await handleVendorOAuthComplete({identity:h.identity,flowStore:h.flows,resultStore:results,oauthAppConfig:h.saved,serverPublicUrl:()=>ORIGIN,fetcher:h.fetcher,now:()=>NOW},{method:'GET',code:'public-code',state:new URL(started.authorize_url).searchParams.get('state')!});
    expect(response.outcome).toBe('completed');expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('client_secret')).toBe('SERVER-ONLY-SECRET');
  });
  it.each(['removed before callback','changed during exchange'])('refuses a public callback after the app is %s',async change=>{
    const h=fixture();const started=await makeConnectionHandlers(h.deps)!.handlers['collection.connection.startVendorOAuth']({...h.complete,redirect_uri:ORIGIN+'/oauth/complete'},undefined as never);
    if(change==='removed before callback')h.saved.clearIssuer('google');
    else h.fetcher.mockImplementationOnce(async()=>{h.saved.setIssuer('google','saved-id','NEW-SECRET');return{ok:true,status:200,json:async()=>({refresh_token:'new-refresh',access_token:'access',expires_in:3600,scope:'drive.readonly'}),text:async()=>''};});
    const response=await handleVendorOAuthComplete({identity:h.identity,flowStore:h.flows,resultStore:createVendorOAuthResultStore({now:()=>NOW}),oauthAppConfig:h.saved,serverPublicUrl:()=>ORIGIN,fetcher:h.fetcher,now:()=>NOW},{method:'GET',code:'public-code',state:new URL(started.authorize_url).searchParams.get('state')!});
    expect(response.outcome).toBe('exchange_failed');expect(response.body).toContain('saved OAuth app');expect(h.fetcher).toHaveBeenCalledTimes(change==='removed before callback'?0:1);
  });
  it.each(['google','microsoft'] as const)('starts a renewable generic %s authorization with PKCE',async issuer=>{
    const h=fixture();h.saved.setIssuer('microsoft','ms-id','MS-SECRET');
    const pair=issuer==='google'?endpoints:{authorize_url:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token_endpoint:'https://login.microsoftonline.com/common/oauth2/v2.0/token'};
    const started=await makeConnectionHandlers(h.deps)!.handlers['collection.connection.startVendorOAuth']({vendor:'generic',client_id:issuer==='google'?'saved-id':'ms-id',oauth_app_issuer:issuer,...pair,scopes:['read'],redirect_uri:ORIGIN+'/oauth/complete'},undefined as never);
    const url=new URL(started.authorize_url);expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    if(issuer==='google'){expect(url.searchParams.get('access_type')).toBe('offline');expect(url.searchParams.get('prompt')).toBe('consent');}
    else expect(url.searchParams.get('scope')).toContain('offline_access');
  });
  it.each(['google','microsoft'] as const)('completes a signed generic %s flow and keeps its result owner-bound',async issuer=>{
    const h=fixture();h.saved.setIssuer('microsoft','ms-id','MS-SECRET');
    const pair=issuer==='google'?endpoints:{authorize_url:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token_endpoint:'https://login.microsoftonline.com/common/oauth2/v2.0/token'};
    const started=await makeConnectionHandlers(h.deps)!.handlers['collection.connection.startVendorOAuth']({vendor:'generic',client_id:issuer==='google'?'saved-id':'ms-id',oauth_app_issuer:issuer,...pair,scopes:['read'],redirect_uri:ORIGIN+'/oauth/complete'},undefined as never);
    const results=createVendorOAuthResultStore({now:()=>NOW});
    const response=await handleVendorOAuthComplete({identity:h.identity,flowStore:h.flows,resultStore:results,oauthAppConfig:h.saved,serverPublicUrl:()=>ORIGIN,fetcher:h.fetcher,now:()=>NOW},{method:'GET',code:'public-code',state:new URL(started.authorize_url).searchParams.get('state')!});
    expect(response.outcome).toBe('completed');expect(h.fetcher.mock.calls[0]?.[0]).toBe(pair.token_endpoint);
    const body=new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body);
    expect(body.get('client_secret')).toBe(issuer==='google'?'SERVER-ONLY-SECRET':'MS-SECRET');expect(body.get('code_verifier')).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(results.take(started.flow_id,'wrong-claim')).toBeNull();
    expect(results.take(started.flow_id,started.claim_secret)).toMatchObject({refresh_token:'new-refresh'});
    expect(results.take(started.flow_id,started.claim_secret)).toBeNull();
  });
  it.each([['google','before'],['google','during'],['microsoft','before'],['microsoft','during']] as const)('rejects a generic %s app changed %s callback exchange',async(issuer,timing)=>{
    const h=fixture();h.saved.setIssuer('microsoft','ms-id','MS-SECRET');
    const client_id=issuer==='google'?'saved-id':'ms-id';
    const pair=issuer==='google'?endpoints:{authorize_url:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token_endpoint:'https://login.microsoftonline.com/common/oauth2/v2.0/token'};
    const started=await makeConnectionHandlers(h.deps)!.handlers['collection.connection.startVendorOAuth']({vendor:'generic',client_id,oauth_app_issuer:issuer,...pair,scopes:['read'],redirect_uri:ORIGIN+'/oauth/complete'},undefined as never);
    const change=()=>h.saved.setIssuer(issuer,client_id,'ROTATED-SECRET');
    if(timing==='before')change();else h.fetcher.mockImplementationOnce(async()=>{change();return{ok:true,status:200,json:async()=>({refresh_token:'new-refresh',access_token:'access',expires_in:3600,scope:'read'}),text:async()=>''};});
    const results=createVendorOAuthResultStore({now:()=>NOW});
    const response=await handleVendorOAuthComplete({identity:h.identity,flowStore:h.flows,resultStore:results,oauthAppConfig:h.saved,serverPublicUrl:()=>ORIGIN,fetcher:h.fetcher,now:()=>NOW},{method:'GET',code:'public-code',state:new URL(started.authorize_url).searchParams.get('state')!});
    expect(response.outcome).toBe('exchange_failed');expect(h.fetcher).toHaveBeenCalledTimes(timing==='before'?0:1);expect(results.take(started.flow_id,started.claim_secret)).toBeNull();
  });
  it('uses a saved Microsoft app with a matching tenant and a separate consent grant',async()=>{
    const h=fixture();h.saved.setIssuer('microsoft','microsoft-id','MICROSOFT-SECRET');
    const root='https://login.microsoftonline.com/common/oauth2/v2.0/';
    await handleConnectionCompleteVendorOAuth(h.deps,{...h.complete,vendor:'generic',client_id:'microsoft-id',oauth_app_issuer:'microsoft',authorize_url:root+'authorize',token_endpoint:root+'token'} as Parameters<typeof handleConnectionCompleteVendorOAuth>[1]);
    expect(h.fetcher.mock.calls[0]?.[0]).toBe(root+'token');expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('client_secret')).toBe('MICROSOFT-SECRET');
  });
});

it('forwards the generic saved-app PKCE proof into the actual token request',async()=>{
 const h=fixture();await handleConnectionCompleteVendorOAuth(h.deps,{...h.complete,vendor:'generic',...endpoints,code_verifier:'a'.repeat(43)} as Parameters<typeof handleConnectionCompleteVendorOAuth>[1]);
 expect(new URLSearchParams(h.fetcher.mock.calls[0]?.[1]?.body).get('code_verifier')).toBe('a'.repeat(43));
});
