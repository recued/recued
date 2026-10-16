import { OAUTH_APP_ID,RpcError,savedOAuthAppIssuerForEndpoints } from '@recued/contracts';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';

/** Resolve only after selecting the effective provider endpoints. Never send
 * a saved secret to a caller-supplied endpoint belonging to another issuer. */
export const resolveConnectionOAuthApp = (input: {
  store?: OAuthAppConfigStore;issuer?: unknown;app_id?: unknown;client_id: string;client_secret?: string;
  token_endpoint: string;authorize_url?: string;
}): { client_id: string;client_secret?: string } => {
  if (input.app_id !== undefined && (typeof input.app_id !== 'string' || !OAUTH_APP_ID.test(input.app_id) || input.issuer === undefined)) throw new RpcError('bad_request','Choose the saved app and its vendor.');
  if (input.issuer === undefined) return { client_id: input.client_id,
    ...(input.client_secret !== undefined ? { client_secret: input.client_secret } : {}) };
  if (input.issuer !== 'google' && input.issuer !== 'microsoft') throw new RpcError('bad_request','Choose a saved Google or Microsoft OAuth app.');
  if (input.client_secret !== undefined) throw new RpcError('bad_request','Choose the saved app or enter app credentials, then authorize again.');
  if (savedOAuthAppIssuerForEndpoints(input) !== input.issuer) throw new RpcError('bad_request','The saved OAuth app does not match these OAuth endpoints.');
  if (!input.store) throw new RpcError('not_configured','Saved OAuth apps are unavailable on this server.',503);
  const id = typeof input.app_id === 'string' ? input.app_id : 'default';
  const clientId = input.store.getClientId(input.issuer,id);
  if (!clientId || !input.store.hasSecret(input.issuer,id)) throw new RpcError('not_configured','This saved OAuth app is no longer configured. Refresh the saved apps.',503);
  if (clientId !== input.client_id) throw new RpcError('oauth_app_changed','The saved OAuth app changed. Refresh it and authorize again.',409);
  let secret: string | null;
  try { secret = input.store.getClientSecret(input.issuer,id); }
  catch (error) {
    if (error instanceof Error && /locked/i.test(error.message)) throw new RpcError('locked','Unlock Recued before using the saved OAuth app.',423);
    throw new RpcError('oauth_app_unavailable','The saved OAuth app could not be read. Save its credentials again.',503);
  }
  if (!secret) throw new RpcError('not_configured','This saved OAuth app has no client secret. Save the app again.',503);
  return { client_id: clientId,client_secret: secret };
};

/** After asynchronous exchange/encryption, bind the saved app again before
 * returning an authorization or persisting credentials. */
export const assertConnectionOAuthAppCurrent = (
  input: Omit<Parameters<typeof resolveConnectionOAuthApp>[0],'client_secret'>,
  expected: { client_id: string;client_secret?: string },
): void => {
  if (input.issuer === undefined) return;
  const current = resolveConnectionOAuthApp(input);
  if (current.client_id !== expected.client_id || current.client_secret !== expected.client_secret) {
    throw new RpcError('oauth_app_changed','The saved OAuth app changed. Refresh it and authorize again.',409);
  }
};
