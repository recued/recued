import { afterEach,describe,expect,it,vi } from 'vitest';
import { OPENER_RELAY_MESSAGE_KIND,type OAuthAppConfigSnapshot } from '@recued/contracts';
import { mountConnectionsEnrollPanel,type MountConnectionsEnrollPanelOptions,type ConnectionsCompleteVendorOAuthCaller,type ConnectionsStartVendorOAuthCaller,type VendorOAuthPopupHandle } from '../settings/connections-enroll-panel.js';
const handles:Array<{dispose():void}>=[];afterEach(()=>handles.splice(0).forEach(h=>h.dispose()));
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
const config:OAuthAppConfigSnapshot={google:{client_id:'saved-id',has_secret:true,source:'stored'},microsoft:{client_id:null,has_secret:false,source:null}};
const fixture=async(overrides:Partial<MountConnectionsEnrollPanelOptions>={})=>{
  let html='';const listeners=new Map<string,Array<(event:unknown)=>void>>();
  const host={get innerHTML(){return html;},set innerHTML(value:string){html=value;},contains:()=>true,querySelector:()=>null,
    addEventListener:(name:string,fn:(event:unknown)=>void)=>listeners.set(name,[...(listeners.get(name)??[]),fn]),
    removeEventListener:(name:string,fn:(event:unknown)=>void)=>listeners.set(name,(listeners.get(name)??[]).filter(item=>item!==fn))};
  const fire=(type:string,event:unknown)=>listeners.get(type)?.forEach(fn=>fn(event));
  const click=(action:string,extra:Record<string,string>={})=>{const node={dataset:{action,...extra},closest:()=>node,getAttribute:()=>null,setAttribute:()=>{},removeAttribute:()=>{}};fire('click',{target:node,preventDefault(){}});};
  const field=(key:string,value:string,tagName='INPUT')=>{const node={dataset:{connField:key},tagName,value,closest:()=>node};const type=tagName==='SELECT'?'change':'input';fire(type,{target:node,type});};
  let popup:VendorOAuthPopupHandle&{closed:boolean;close():void}={location:{href:''},closed:false,close(){this.closed=true;},sessionStorage:{setItem(){}}};
  let receive:((event:{origin:string;data:unknown})=>void)|undefined;
  const complete=vi.fn<ConnectionsCompleteVendorOAuthCaller>(async()=>({refresh_token:'own-refresh',granted_scopes:['drive.readonly']}));
  const start=vi.fn<ConnectionsStartVendorOAuthCaller>(async()=>({authorize_url:'https://accounts.google.com/authorize?state=server-state',flow_id:'flow-fixture',server_identity_public_key_b64:'fixture-key',claim_secret:'owner-claim'}));
  const enroll=vi.fn(async(args:Parameters<MountConnectionsEnrollPanelOptions['runEnroll']>[0])=>({connection:{name:args.name,kind:args.kind,display_name:args.display_name,auth_type:args.auth.type}}));
  const get=vi.fn(async()=>structuredClone(config));
  const opts:MountConnectionsEnrollPanelOptions={host:host as unknown as HTMLElement,document:{activeElement:null} as unknown as Document,
    initialVendor:'google',runList:async()=>({connections:[]}),runEnroll:enroll,runUpdate:async()=>{throw new Error('unused');},runDelete:async()=>({deleted:true}),runProbe:async()=>({health:{status:'ok',checked_at:1}}),
    runGetOAuthAppConfig:get,runStartVendorOAuth:start,runTakeVendorOAuthResult:async()=>({result:null}),runCompleteVendorOAuth:complete,subscribe:()=>()=>{},
    oauthEnv:{open:()=>{popup={location:{href:''},closed:false,close(){this.closed=true;},sessionStorage:{setItem(){}}};return popup;},setTimeout:()=>1,clearTimeout:()=>{}},
    foundationalOAuthEnv:{origin:'http://127.0.0.1:4319',randomState:()=> 'nonce',onMessage:fn=>{receive=fn;return()=>{receive=undefined;};},setTimeout:()=>()=>{},setInterval:()=>()=>{}},...overrides};
  const panel=mountConnectionsEnrollPanel(opts);handles.push(panel);await panel.whenLoaded();await flush();
  return{host,panel,click,field,start,complete,enroll,get,popup:()=>popup,
    finish:()=>receive?.({origin:'http://127.0.0.1:4319',data:{kind:OPENER_RELAY_MESSAGE_KIND,state:new URL(popup.location.href).searchParams.get('state'),code:'local-code'}})};
};
describe('saved OAuth app enrollment controller',()=>{
  it('uses the displayed usable profile when the legacy default has no secret', async () => {
    const id = 'app-' + 'a'.repeat(32);
    const get = async (): Promise<OAuthAppConfigSnapshot> => ({ ...config, google: { ...config.google, has_secret: false, apps: [
      { id: 'default', issuer: 'google', label: 'Incomplete default', client_id: 'saved-id', has_secret: false, revision: 1 },
      { id, issuer: 'google', label: 'Ready work app', client_id: 'work-client', has_secret: true, revision: 1 }] } });
    const h = await fixture({ runGetOAuthAppConfig: get });
    expect(h.host.innerHTML).toContain('Ready work app');
    h.click('connections-use-saved-oauth-app', { issuer: 'google' });
    expect(h.panel.getState().dialog.values).toMatchObject({ 'auth.saved_oauth_app_id': id, 'auth.client_id': 'work-client' });
  });
  it('does not substitute the default app when the selected named app disappears', async () => {
    const id = 'app-' + 'a'.repeat(32);
    const get = vi.fn(async (): Promise<OAuthAppConfigSnapshot> => ({ ...config, google: { ...config.google, apps: [
      { id: 'default', issuer: 'google', label: 'Default', client_id: 'saved-id', has_secret: true, revision: 1 },
      { id, issuer: 'google', label: 'Work', client_id: 'saved-id', has_secret: true, revision: 1 }] } }));
    const h = await fixture({ runGetOAuthAppConfig: get }); h.field('name', 'drive');
    h.field('auth.saved_oauth_app_choice', id, 'SELECT'); h.click('connections-use-saved-oauth-app', { issuer: 'google' });
    get.mockResolvedValueOnce(config); h.click('connections-refresh-saved-oauth-apps'); await flush();
    expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();
    expect(h.panel.getState().dialog.values['auth.client_id']).toBe(''); expect(h.host.innerHTML).toContain('changed or was removed');
    expect(h.host.innerHTML).toContain('<option value="" selected>Choose a saved app</option>');
    h.click('connections-use-saved-oauth-app', { issuer: 'google' });
    expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();
    h.field('auth.saved_oauth_app_choice', 'default', 'SELECT'); h.click('connections-use-saved-oauth-app', { issuer: 'google' });
    expect(h.panel.getState().dialog.values['auth.saved_oauth_app_id']).toBe('default');
    expect(h.start).not.toHaveBeenCalled(); expect(h.enroll).not.toHaveBeenCalled();
  });
  it('selects a named app by ID through local authorization and enrollment without its secret', async () => {
    const id = 'app-' + 'a'.repeat(32);
    const get = vi.fn(async (): Promise<OAuthAppConfigSnapshot> => ({ ...config, google: { ...config.google, apps: [
      { id: 'default', issuer: 'google', label: 'Default', client_id: 'saved-id', has_secret: true, revision: 1 },
      { id, issuer: 'google', label: 'Work', client_id: 'saved-id', has_secret: true, revision: 1 }] } }));
    const h = await fixture({ runGetOAuthAppConfig: get }); h.field('name', 'drive'); h.field('display_name', 'Drive');
    h.field('auth.saved_oauth_app_choice', id, 'SELECT'); h.click('connections-use-saved-oauth-app', { issuer: 'google' });
    h.click('connections-authorize-vendor'); await vi.waitFor(() => expect(h.popup().location.href).toMatch(/^https:/)); h.finish(); await flush();
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ oauth_app_issuer: 'google', oauth_app_id: id }));
    h.click('connections-submit-form'); await flush(); expect(h.enroll).toHaveBeenCalledWith(expect.objectContaining({ oauth_app_id: id }));
    expect(h.enroll.mock.calls[0]?.[0].auth).not.toHaveProperty('client_secret');
  });
  it('selects a server app without placing its secret in values or HTML',async()=>{const h=await fixture();h.click('connections-use-saved-oauth-app',{issuer:'google'});expect(h.panel.getState().dialog.values).toMatchObject({'auth.client_id':'saved-id','auth.saved_oauth_app':'google'});expect(h.panel.getState().dialog.values['auth.client_secret']).toBeUndefined();expect(h.host.innerHTML).not.toContain('data-conn-field="auth.client_secret"');});
  it('keeps typed credentials intact when metadata loads asynchronously',async()=>{let resolve:((value:OAuthAppConfigSnapshot)=>void)|undefined;const h=await fixture({runGetOAuthAppConfig:()=>new Promise(done=>{resolve=done;})});h.field('auth.client_id','my-own-id');h.field('auth.client_secret','my-own-secret');resolve?.(config);await flush();expect(h.panel.getState().dialog.values).toMatchObject({'auth.client_id':'my-own-id','auth.client_secret':'my-own-secret'});});
  it('uses the same app reference for local exchange and enrollment',async()=>{const h=await fixture();h.field('name','drive');h.field('display_name','Drive');h.click('connections-use-saved-oauth-app',{issuer:'google'});h.click('connections-authorize-vendor');await vi.waitFor(()=>expect(h.popup().location.href).toMatch(/^https:/));h.finish();await flush();expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({client_id:'saved-id',oauth_app_issuer:'google'}));expect(h.complete.mock.calls[0]?.[0]).not.toHaveProperty('client_secret');h.click('connections-submit-form');await flush();expect(h.enroll).toHaveBeenCalledWith(expect.objectContaining({oauth_app_issuer:'google',auth:expect.objectContaining({client_id:'saved-id',refresh_token:'own-refresh'})}));expect(h.enroll.mock.calls[0]?.[0].auth).not.toHaveProperty('client_secret');});
  it('forwards the selected app through the signed public start path',async()=>{const h=await fixture({foundationalOAuthEnv:{origin:'https://app.recued.com',randomState:()=> 'unused',onMessage:()=>()=>{},setTimeout:()=>()=>{},setInterval:()=>()=>{}}});h.field('name','drive');h.field('display_name','Drive');h.click('connections-use-saved-oauth-app',{issuer:'google'});h.click('connections-authorize-vendor');await flush();expect(h.start).toHaveBeenCalledWith(expect.objectContaining({client_id:'saved-id',oauth_app_issuer:'google'}));expect(h.start.mock.calls[0]?.[0]).not.toHaveProperty('client_secret');expect(h.complete).not.toHaveBeenCalled();});
  it('invalidates authorization when the owner switches back to manual app details',async()=>{const h=await fixture();h.field('name','drive');h.field('display_name','Drive');h.click('connections-use-saved-oauth-app',{issuer:'google'});h.click('connections-authorize-vendor');await vi.waitFor(()=>expect(h.popup().location.href).toMatch(/^https:/));h.finish();await flush();h.click('connections-enter-oauth-app');expect(h.panel.getState().dialog.values).toMatchObject({'auth.client_id':'','auth.refresh_token':''});expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();expect(h.panel.getState().dialog.oauthGrantedScopes).toBeNull();});
  it('blocks forged changes to a selected app ID and switches away from incompatible endpoints',async()=>{const h=await fixture();h.click('connections-use-saved-oauth-app',{issuer:'google'});h.field('auth.client_id','other-id');expect(h.panel.getState().dialog.values['auth.client_id']).toBe('saved-id');h.field('auth.token_endpoint','https://evil.example/token');expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();});
  it('clears a removed saved app on refresh and keeps the rest of the form',async()=>{const h=await fixture();h.field('name','drive');h.click('connections-use-saved-oauth-app',{issuer:'google'});h.get.mockResolvedValueOnce({...config,google:{client_id:null,has_secret:false,source:null}});h.click('connections-refresh-saved-oauth-apps');await flush();expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();expect(h.panel.getState().dialog.values.name).toBe('drive');expect(h.host.innerHTML).toContain('changed or was removed');});
  it.each(['succeeded','failed'])('reconciles a changed saved app when an authorization has %s',async outcome=>{
    const h=await fixture();h.field('name','drive');h.field('display_name','Drive');h.click('connections-use-saved-oauth-app',{issuer:'google'});
    let settle:(()=>void)|undefined;
    h.complete.mockImplementationOnce(()=>new Promise((resolve,reject)=>{settle=()=>outcome==='succeeded'?resolve({refresh_token:'old-app-refresh',granted_scopes:['read']}):reject(new Error('The saved OAuth app changed.'));}));
    h.click('connections-authorize-vendor');await vi.waitFor(()=>expect(h.popup().location.href).toMatch(/^https:/));h.finish();await flush();
    h.get.mockResolvedValueOnce({...config,google:{client_id:'new-id',has_secret:true,source:'stored'}});await h.panel.refresh();await flush();
    expect(h.panel.getState().dialog.values['auth.client_id']).toBe('saved-id');expect(h.panel.getState().dialog.oauthInFlight).toBe(true);
    settle?.();await flush();
    expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();expect(h.panel.getState().dialog.values['auth.refresh_token']).toBe('');expect(h.panel.getState().dialog.values.name).toBe('drive');expect(h.host.innerHTML).toContain('changed or was removed');
    h.click('connections-use-saved-oauth-app',{issuer:'google'});expect(h.panel.getState().dialog.values['auth.client_id']).toBe('new-id');
  });
  it('refuses a cached app selection while its latest metadata read has failed',async()=>{
    const h=await fixture();h.get.mockRejectedValueOnce(new Error('metadata outage'));h.click('connections-refresh-saved-oauth-apps');await flush();
    h.click('connections-use-saved-oauth-app',{issuer:'google'});expect(h.panel.getState().dialog.values['auth.saved_oauth_app']).toBeUndefined();
  });
  it('ignores a late app metadata response after disposal',async()=>{let resolve:((value:OAuthAppConfigSnapshot)=>void)|undefined;const h=await fixture({runGetOAuthAppConfig:()=>new Promise(done=>{resolve=done;})});h.panel.dispose();const html=h.host.innerHTML;resolve?.(config);await flush();expect(h.host.innerHTML).toBe(html);});
});

it('forwards the generic saved-app PKCE verifier after bound local consent',async()=>{
 const h=await fixture();h.click('connections-back-to-kind');h.click('connections-pick-kind',{kind:'api'});h.field('auth.type','oauth2_refresh','SELECT');
 h.field('auth.authorize_url','https://accounts.google.com/o/oauth2/v2/auth');h.field('auth.token_endpoint','https://oauth2.googleapis.com/token');h.field('config.base_url','https://sheets.googleapis.com/v4');h.field('name','sheets');h.field('display_name','Sheets');
 h.click('connections-use-saved-oauth-app',{issuer:'google'});h.click('connections-authorize-vendor');await vi.waitFor(()=>expect(h.popup().location.href).toContain('code_challenge='));h.finish();await flush();
 expect(h.complete.mock.calls[0]?.[0]).toMatchObject({oauth_app_issuer:'google',code_verifier:expect.stringMatching(/^[a-zA-Z0-9_-]{43}$/)});
});
