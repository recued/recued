/** Saved app secrets may go only to their issuer's OAuth endpoints. */
import type { OAuthAppIssuer } from './foundational-oauth.js';
import { GOOGLE_OAUTH_AUTHORIZE_URL, GOOGLE_OAUTH_TOKEN_URL, GOOGLE_OAUTH_AUTHORIZE_PARAMS, type ConnectionVendorProvider } from './connection-vendor-providers.js';

const cleanEndpoint = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '' ? url : null;
  } catch { return null; }
};
export const savedOAuthAppIssuerForEndpoints = (input: {
  token_endpoint: string;authorize_url?: string;
}): OAuthAppIssuer | null => {
  const token = cleanEndpoint(input.token_endpoint);
  const authorize = input.authorize_url === undefined ? undefined : cleanEndpoint(input.authorize_url);
  if (!token || authorize === null) return null;
  if (token.href === GOOGLE_OAUTH_TOKEN_URL
    && (authorize === undefined || authorize.href === GOOGLE_OAUTH_AUTHORIZE_URL)) return 'google';
  if (token.hostname !== 'login.microsoftonline.com') return null;
  const tenant = /^\/([a-zA-Z0-9][a-zA-Z0-9.-]{0,254})\/oauth2\/v2\.0\/token$/.exec(token.pathname)?.[1];
  if (!tenant) return null;
  return authorize === undefined || authorize.hostname === token.hostname
    && authorize.pathname === `/${tenant}/oauth2/v2.0/authorize` ? 'microsoft' : null;
};

export const savedOAuthAppRequestedScopes = (issuer: OAuthAppIssuer | null,scopes: readonly string[]): string[] =>
  issuer === null ? [...scopes] : [...new Set([...scopes,...(issuer === 'microsoft' ? ['offline_access'] : [])])];
/** Generic saved-app setup needs a renewable grant, just like the registered
 * Google/Microsoft forms. The owner sees the scope floor before consent. */
export const withSavedOAuthAppProvider = (provider: ConnectionVendorProvider,issuer: OAuthAppIssuer): ConnectionVendorProvider => ({
  ...provider,oauth: { ...provider.oauth,supports_pkce: true,
    scopes: savedOAuthAppRequestedScopes(issuer,provider.oauth.scopes),
    ...(issuer === 'google' ? { authorize_params: { ...provider.oauth.authorize_params,...GOOGLE_OAUTH_AUTHORIZE_PARAMS } } : {}),
  },
});
