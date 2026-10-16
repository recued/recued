import { describe,expect,it } from 'vitest';
import { savedOAuthAppIssuerForEndpoints,savedOAuthAppRequestedScopes,withSavedOAuthAppProvider } from '../oauth-app-reuse.js';
import { GOOGLE_OAUTH_AUTHORIZE_URL,GOOGLE_OAUTH_TOKEN_URL,buildGenericVendorProvider } from '../connection-vendor-providers.js';
const google={authorize_url:GOOGLE_OAUTH_AUTHORIZE_URL,token_endpoint:GOOGLE_OAUTH_TOKEN_URL};
describe('saved OAuth app endpoint binding',()=>{
  it('matches the trusted Google endpoint pair and a server-side token-only check',()=>{
    expect(savedOAuthAppIssuerForEndpoints(google)).toBe('google');
    expect(savedOAuthAppIssuerForEndpoints({token_endpoint:google.token_endpoint})).toBe('google');
  });
  it.each(['common','organizations','consumers','a0000000-b000-c000-d000-e00000000000','company.example'])('matches one Microsoft tenant %s on both endpoints',tenant=>{
    const root=`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/`;
    expect(savedOAuthAppIssuerForEndpoints({token_endpoint:root+'token',authorize_url:root+'authorize'})).toBe('microsoft');
  });
  it.each(['https://evil.example/token','https://oauth2.googleapis.com.evil.example/token','http://oauth2.googleapis.com/token','https://user@oauth2.googleapis.com/token','https://oauth2.googleapis.com:444/token','https://oauth2.googleapis.com/token?redirect=evil','https://oauth2.googleapis.com/token#fragment','https://oauth2.googleapis.com/other','https://login.microsoftonline.com/common/oauth2/v2.0/token','not a URL'])('refuses mixed or unsafe token destination %s',token_endpoint=>{
    expect(savedOAuthAppIssuerForEndpoints({...google,token_endpoint})).toBeNull();
  });
  it.each(['https://evil.example/authorize','https://accounts.google.com/o/oauth2/v2/auth?redirect=evil','https://accounts.google.com/o/oauth2/v2/auth#fragment'])('refuses incompatible Google consent destination %s',authorize_url=>{
    expect(savedOAuthAppIssuerForEndpoints({...google,authorize_url})).toBeNull();
  });
  it('refuses cross-tenant and issuer mixtures for Microsoft',()=>{
    const token_endpoint='https://login.microsoftonline.com/common/oauth2/v2.0/token';
    expect(savedOAuthAppIssuerForEndpoints({token_endpoint,authorize_url:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize'})).toBeNull();
    expect(savedOAuthAppIssuerForEndpoints({token_endpoint,authorize_url:google.authorize_url})).toBeNull();
    expect(savedOAuthAppIssuerForEndpoints({token_endpoint:'https://login.microsoftonline.com/common%2Fextra/oauth2/v2.0/token'})).toBeNull();
  });
});

it('requests a renewable generic Google grant with PKCE without adding API scopes',()=>{
 const p=withSavedOAuthAppProvider(buildGenericVendorProvider({...google,scopes:['sheets.readonly']}),'google');
 expect(p.oauth).toMatchObject({supports_pkce:true,authorize_params:{access_type:'offline',prompt:'consent'},scopes:['sheets.readonly']});
});
it('shows Microsoft offline access once alongside the requested API scopes',()=>{
 expect(savedOAuthAppRequestedScopes('microsoft',['User.Read','offline_access'])).toEqual(['User.Read','offline_access']);
 expect(savedOAuthAppRequestedScopes('microsoft',['User.Read'])).toEqual(['User.Read','offline_access']);
});

it('preserves the manual form scope list when no saved app is selected',()=>{expect(savedOAuthAppRequestedScopes(null,['read','read'])).toEqual(['read','read']);});
