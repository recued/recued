import { describe,expect,it } from 'vitest';
import { GOOGLE_OAUTH_TOKEN_URL,GOOGLE_OAUTH_AUTHORIZE_URL,type OAuthAppConfigSnapshot } from '@recued/contracts';
import { initialConnectionsPageState } from '../connections/state.js';
import { renderConnectionsPage,connectionFormValidationIssue } from '../connections/page.js';
import { connectionOAuthCredentialReadiness } from '../connections/oauth-credentials.js';
import { googleSchema } from '../connection-schemas/vendors/google.js';
const config:OAuthAppConfigSnapshot={google:{client_id:'saved-id',has_secret:true,source:'stored'},microsoft:{client_id:null,has_secret:false,source:null}};
const fixture=()=>{const state=initialConnectionsPageState();state.dialog={...state.dialog,stage:'form',mode:'create',kind:'api',vendor:'google',savedOAuthApps:{loading:false,config},values:{name:'drive',display_name:'Drive','auth.type':'oauth2_refresh','auth.token_endpoint':GOOGLE_OAUTH_TOKEN_URL,'config.vendor':'google','config.base_url':'https://www.googleapis.com/drive/v3'}};return state;};
describe('saved app form projection',()=>{
  it('offers a compatible saved app while keeping the manual fields available',()=>{const state=fixture();const html=renderConnectionsPage(state);expect(html).toContain('Use saved Google app');expect(html).toContain('data-conn-field="auth.client_secret"');});
  it('hides the secret and pins the public app ID after selection',()=>{
    const state=fixture();Object.assign(state.dialog.values,{'auth.saved_oauth_app':'google','auth.client_id':'saved-id','auth.refresh_token':'new-token'});
    const html=renderConnectionsPage(state);expect(html).toContain('Using your saved Google app');expect(html).toContain('Enter another app');
    expect(html).not.toContain('data-conn-field="auth.client_secret"');expect(html).toMatch(/data-conn-field="auth.client_id"[^>]*readonly|readonly[^>]*data-conn-field="auth.client_id"/);
    expect(connectionOAuthCredentialReadiness(state.dialog)).toMatchObject({ready:true,refreshReady:true});
    expect(connectionFormValidationIssue(googleSchema,state.dialog.values,undefined,'create')).toBeNull();
  });
  it('never treats a mismatched saved-app marker as a secret',()=>{
    const state=fixture();Object.assign(state.dialog.values,{'auth.saved_oauth_app':'microsoft','auth.client_id':'saved-id'});
    expect(connectionOAuthCredentialReadiness(state.dialog)?.requirements.find(item=>item.fieldKey==='auth.client_secret')?.status).toBe('missing');
    expect(renderConnectionsPage(state)).toContain('data-conn-field="auth.client_secret"');
  });
  it('keeps saved app reuse off existing-connection rotation forms',()=>{const state=fixture();state.dialog.mode='edit';expect(renderConnectionsPage(state)).not.toContain('data-saved-oauth-apps');});
  it('shows loading and retry copy without claiming missing metadata is authoritative',()=>{const state=fixture();state.dialog.savedOAuthApps={loading:false,error:'Saved apps could not be loaded.'};const html=renderConnectionsPage(state);expect(html).toContain('Refresh saved apps');expect(html).toContain('Saved apps could not be loaded.');});
  it('matches a generic Google API without requiring a registry vendor',()=>{const state=fixture();state.dialog.vendor=null;state.dialog.values['auth.authorize_url']=GOOGLE_OAUTH_AUTHORIZE_URL;expect(renderConnectionsPage(state)).toContain('Use saved Google app');state.dialog.values['auth.token_endpoint']='https://evil.example/token';expect(renderConnectionsPage(state)).not.toContain('data-saved-oauth-apps');});
});

it('shows renewable Microsoft consent in generic saved-app setup',()=>{
 const state=fixture();state.dialog.vendor=null;state.dialog.savedOAuthApps={loading:false,config:{...config,microsoft:{client_id:'ms-id',has_secret:true,source:'stored'}}};
 Object.assign(state.dialog.values,{'auth.authorize_url':'https://login.microsoftonline.com/common/oauth2/v2.0/authorize','auth.token_endpoint':'https://login.microsoftonline.com/common/oauth2/v2.0/token','auth.client_id':'ms-id','auth.saved_oauth_app':'microsoft','auth.scopes':'User.Read'});
 expect(connectionOAuthCredentialReadiness(state.dialog)?.scopes).toEqual(['User.Read','offline_access']);expect(renderConnectionsPage(state)).toContain('Using your saved Microsoft app');
});
