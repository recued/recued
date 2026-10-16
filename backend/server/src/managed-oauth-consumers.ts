import { collectionOAuthSourceName, type CollectionOAuthSources } from './collection-oauth-sources.js';
/** D-322 — first-class collections borrow a saved API connection, never vendor tokens. */
import { RpcError, type ConnectionRow } from '@recued/contracts';
import type { ManagedOAuthService } from './managed-oauth-service.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { CollectionInstanceStore } from './collections/instance-store.js';
import type { HttpFetcher } from './collections/mail/oauth.js';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';

export type ManagedOAuthCollectionProvider = 'gmail' | 'gcal' | 'graph';
export interface ManagedOAuthCollectionBinding {
  connection_name: string;
  broker_profile_id: string;
  integration_id: string;
  connection_id: string;
  target_origin: string;
}
export interface ManagedOAuthCollectionTransport {
  binding: ManagedOAuthCollectionBinding;
  fetch: HttpFetcher;
  /** Null means unknown. Requested scopes are never promoted to grants. */
  grantedScopes: readonly string[] | null;
  assertCurrent(): Promise<void>;
}
export interface ManagedOAuthConsumers {
  authentication?: CollectionOAuthSources;
  resolve(provider: ManagedOAuthCollectionProvider, connectionName: string,
    expected?: unknown): Promise<ManagedOAuthCollectionTransport>;
  fetch(provider: ManagedOAuthCollectionProvider, binding: unknown): HttpFetcher;
  assertUnreferenced(connectionName: string): void;
}

export const managedOAuthFetcherFor = (consumers: ManagedOAuthConsumers | undefined,
  provider: ManagedOAuthCollectionProvider, binding: unknown): HttpFetcher | undefined => {
  if (binding === undefined) return undefined;
  if (!consumers) throw new RpcError('not_configured', 'Managed OAuth is unavailable on this server.');
  if (binding && typeof binding === 'object' && 'type' in binding) {
    if (!consumers.authentication) throw new RpcError('not_configured', 'Saved OAuth authentication is unavailable on this server.');
    return consumers.authentication.fetch(provider, binding);
  }
  return consumers.fetch(provider, binding);
};

const targetFor = (provider: ManagedOAuthCollectionProvider): string => provider === 'gmail'
  ? 'https://gmail.googleapis.com' : provider === 'gcal'
    ? 'https://www.googleapis.com' : 'https://graph.microsoft.com';

export const createManagedOAuthConsumers = (deps: {
  connections: Pick<ConnectionStoreSqlite, 'get'>;
  instances: Pick<CollectionInstanceStore, 'list'>;
  decodeAuth(row: ConnectionRow): Promise<import('@recued/contracts').ConnectionAuth>;
  broker: Pick<ManagedOAuthService, 'fetch'>;
  authentication?: CollectionOAuthSources;
}): ManagedOAuthConsumers => {
  const read = async (provider: ManagedOAuthCollectionProvider, name: string, expected?: unknown) => {
    const row = deps.connections.get('api', name);
    if (!row) throw new RpcError('not_configured', 'The managed API connection is missing. Select a saved connection.');
    const auth = await deps.decodeAuth(row);
    const current = deps.connections.get('api', name);
    if (!current || current.auth_ciphertext !== row.auth_ciphertext || current.config_json !== row.config_json
      || current.granted_scopes_json !== row.granted_scopes_json) {
      throw new RpcError('conflict', 'The managed API connection changed. Try again.');
    }
    if (auth.type !== 'managed_oauth') throw new RpcError('bad_request', 'Select an API connection that uses managed OAuth.');
    let base: URL;
    try { base = new URL((JSON.parse(row.config_json) as { base_url: string }).base_url); }
    catch { throw new RpcError('bad_request', 'The managed API connection has no valid vendor URL.'); }
    if (auth.target_origin !== targetFor(provider) || base.origin !== auth.target_origin
      || (provider === 'gcal' && !/^\/calendar(?:\/|$)/.test(base.pathname))) {
      throw new RpcError('bad_request', 'Select a managed API connection for this provider and service.');
    }
    const binding: ManagedOAuthCollectionBinding = { connection_name: name,
      broker_profile_id: auth.broker_profile_id, integration_id: auth.integration_id,
      connection_id: auth.connection_id, target_origin: auth.target_origin };
    if (expected !== undefined) {
      if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
        || Object.entries(binding).some(([key, value]) => (expected as Record<string, unknown>)[key] !== value)) {
        throw new RpcError('conflict', 'This collection uses a different broker account. Connect it again before changing accounts.');
      }
    }
    return { row, auth, binding };
  };
  const sourceName = (binding: unknown): string => {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)
      || typeof (binding as Record<string, unknown>).connection_name !== 'string') {
      throw new RpcError('not_configured', 'The collection has no managed API connection.');
    }
    return (binding as ManagedOAuthCollectionBinding).connection_name;
  };
  const fetchFor = (provider: ManagedOAuthCollectionProvider, binding: unknown): HttpFetcher =>
    makeBoundedOriginHttpFetcher({ timeoutMs: 30_000, redirectPolicy: 'error', fetchImpl: async (url, init) => {
      const live = await read(provider, sourceName(binding), binding);
      // Keep the same body ceiling/deadline as direct providers. No credential
      // follows an HTTP redirect; the broker also pins the authored origin.
      return deps.broker.fetch(live.auth, String(url), init ?? {});
    } });
  return {
    ...(deps.authentication ? { authentication: deps.authentication } : {}),
    async resolve(provider, name, expected) {
      const { row, binding } = await read(provider, name, expected);
      let grantedScopes: readonly string[] | null = null;
      if (row.granted_scopes_json != null) {
        try {
          const value: unknown = JSON.parse(row.granted_scopes_json);
          if (Array.isArray(value) && value.every(scope => typeof scope === 'string')) grantedScopes = value;
        } catch { /* Missing evidence stays unknown. */ }
      }
      return { binding, grantedScopes, fetch: fetchFor(provider, binding),
        assertCurrent: async () => {
          const current = await read(provider, name, binding);
          // Reconnect retires evidence before consent, without changing credentials.
          if (current.row.granted_scopes_json !== row.granted_scopes_json) {
            throw new RpcError('conflict', 'The managed API connection permissions changed. Try again.');
          }
        } };
    },
    fetch: fetchFor,
    assertUnreferenced(name) {
      const references = [...deps.instances.list('mail'), ...deps.instances.list('calendar')].filter(row => {
        return collectionOAuthSourceName(row.config) === name;
      });
      if (references.length) throw new RpcError('conflict',
        'This API connection is used by Mail or Calendar. Remove those accounts before removing the connection.');
    },
  };
};
