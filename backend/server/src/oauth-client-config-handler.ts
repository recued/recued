/** D-127 wire-up — `server.getOAuthClientConfig` handler.
 *
 *  Public read of the per-provider OAuth client_id this server is
 *  configured with. The extension uses the returned client_id to
 *  construct the provider's authorize URL (`buildGmailOAuthUrl` /
 *  `buildGraphOAuthUrl` / its calendar siblings) and hands it to
 *  `chrome.identity.launchWebAuthFlow`. The captured `code` flows
 *  back through `collection.mail.enrollOAuth` /
 *  `collection.calendar.enrollOAuth`, which the server exchanges
 *  against the same client_id paired with the never-leaves-server
 *  client_secret.
 *
 *  Only the public client_id is returned — `clientSecret` stays
 *  resident on the server. `null` for a provider means the matching
 *  env var is unset on this server; the extension surfaces a
 *  "configure your server first" hint rather than opening an OAuth
 *  popup that's guaranteed to fail at code-exchange time. */

import type {
  HandlerSlice,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';

export interface OAuthClientConfigDeps {
  /** Source of the configured client ids. Returning `null` for a
   *  provider surfaces `null` on the rpc; absent providers return
   *  `null` too. Composition root reads from the same env-var-backed
   *  constants the enroll handlers use (`GMAIL_OAUTH_CONFIG.clientId`
   *  etc.) so the rpc shape stays in lockstep with the actual
   *  exchange-time config. */
  getClientId(provider: 'gmail' | 'gcal' | 'graph'): string | null;
}

export type OAuthClientConfigMethods = 'server.getOAuthClientConfig';

export const makeOAuthClientConfigHandlers = (
  deps: OAuthClientConfigDeps | undefined,
): HandlerSlice<ServerRpcRegistry, OAuthClientConfigMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const wrap = (provider: 'gmail' | 'gcal' | 'graph'): { client_id: string } | null => {
    const id = deps.getClientId(provider);
    if (!id || id.length === 0) return null;
    return { client_id: id };
  };
  return {
    methods: ['server.getOAuthClientConfig'],
    handlers: {
      'server.getOAuthClientConfig': async () => ({
        gmail: wrap('gmail'),
        gcal: wrap('gcal'),
        graph: wrap('graph'),
      }),
    },
  };
};
