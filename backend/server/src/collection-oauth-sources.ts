/** A collection pins a saved API grant; automatic renewal never changes its account. */
import { createHash, randomBytes } from 'node:crypto';
import { RpcError, getVendorProvider, managedOAuthScopeUnion,
  type ConnectionAuth, type ConnectionRow, type DirectOAuthAuth, type ManagedOAuthAuth,
  type CollectionAuthenticationProvider, type CollectionAuthenticationSource } from '@recued/contracts';
import { createEnsureFreshAuth, injectConnectionApiAuth, refreshOAuth2WithMetadata } from '@recued/ingredients';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
import type { HttpFetcher } from './collections/mail/oauth.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ManagedOAuthService } from './managed-oauth-service.js';
import { persistNativeOAuthRenewal, withCurrentConnectionRenewal } from './native-oauth-renewal.js';
import type { ManagedOAuthCollectionBinding } from './managed-oauth-consumers.js';

export type CollectionOAuthBinding =
  | ({ type: 'managed_oauth'; broker_profile_signature: string } & ManagedOAuthCollectionBinding)
  | { type: 'direct_oauth'; connection_name: string; native_credential_id: string; target_origin: string };
export interface CollectionOAuthTransport {
  binding: CollectionOAuthBinding; source: CollectionAuthenticationSource;
  grantedScopes: readonly string[] | null; fetch: HttpFetcher;
  assertCurrent(): Promise<void>;
  beforeSwap(): void;
}
export interface CollectionOAuthSources {
  candidates(provider: CollectionAuthenticationProvider): Promise<CollectionAuthenticationSource[]>;
  prepare(provider: CollectionAuthenticationProvider, name: string, needs: readonly string[]): Promise<CollectionOAuthTransport>;
  fetch(provider: CollectionAuthenticationProvider, binding: unknown): HttpFetcher;
  previousBrokerFetch(provider: CollectionAuthenticationProvider, binding: unknown): HttpFetcher;
}
export const collectionOAuthBinding = (config: Record<string, unknown>): unknown => config.oauth_connection ?? config.managed_oauth;
export const collectionOAuthSourceName = (config: Record<string, unknown>): string | undefined => {
  const value = collectionOAuthBinding(config);
  return value && typeof value === 'object' && 'connection_name' in value && typeof value.connection_name === 'string' ? value.connection_name : undefined;
};
export const collectionOAuthServiceBase = (p: CollectionAuthenticationProvider): string => p === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1'
  : p === 'gcal' ? 'https://www.googleapis.com/calendar/v3' : 'https://graph.microsoft.com/v1.0';
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bindingMatches = (actual: CollectionOAuthBinding, expected: unknown): boolean => !!expected && typeof expected === 'object'
  && !Array.isArray(expected) && Object.entries(actual).every(([key, value]) => (expected as Record<string, unknown>)[key] === value);
const changed = (): RpcError => new RpcError('conflict', 'The saved API authentication changed. Review the collection migration again.');

export const createCollectionOAuthSources = (deps: {
  store: ConnectionStoreSqlite; broker: Pick<ManagedOAuthService, 'fetch' | 'collectionProfileSignature' | 'diagnosticProfileSignature'>;
  decode: typeof import('./connection-handler.js').decodeAuthFromStorage;
  encode: typeof import('./connection-handler.js').encodeAuthForStorage;
  key?: Parameters<typeof import('./connection-handler.js').decodeAuthFromStorage>[2];
  fetchImpl?: typeof fetch; now?(): number;
}): CollectionOAuthSources => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch; const now = deps.now ?? Date.now;
  const decode = (row: ConnectionRow): Promise<ConnectionAuth> => deps.decode(row.auth_ciphertext, row, deps.key);
  const read = async (p: CollectionAuthenticationProvider, name: string) => {
    const row = deps.store.get('api', name); if (!row) throw changed();
    const config = JSON.parse(row.config_json) as { base_url?: string; vendor?: string };
    if (config.base_url?.replace(/\/+$/, '') !== collectionOAuthServiceBase(p)) throw new RpcError('bad_request', 'Choose a saved API connection for this exact provider and service.');
    const auth = await decode(row);
    if (auth.type !== 'managed_oauth' && auth.type !== 'oauth2_refresh') throw new RpcError('bad_request', 'Choose direct OAuth or a broker API connection.');
    const current = deps.store.get('api', name);
    if (!current || current.auth_ciphertext !== row.auth_ciphertext || current.config_json !== row.config_json) throw changed();
    if (auth.type === 'managed_oauth' && auth.target_origin !== new URL(collectionOAuthServiceBase(p)).origin) throw changed();
    return { row, auth, config };
  };
  const brokerSignature = (id: string): string => {
    const value = deps.broker.collectionProfileSignature?.(id);
    if (!value) throw new RpcError('not_configured', 'This server cannot pin a broker profile for collection migration.');
    return value;
  };
  const bindingFor = (name: string, auth: DirectOAuthAuth | ManagedOAuthAuth, p: CollectionAuthenticationProvider): CollectionOAuthBinding =>
    auth.type === 'managed_oauth' ? { type: 'managed_oauth', connection_name: name, broker_profile_id: auth.broker_profile_id,
      broker_profile_signature: brokerSignature(auth.broker_profile_id),
      integration_id: auth.integration_id, connection_id: auth.connection_id, target_origin: auth.target_origin }
      : { type: 'direct_oauth', connection_name: name, native_credential_id: auth.native_credential_id!, target_origin: new URL(collectionOAuthServiceBase(p)).origin };
  const material = (row: ConnectionRow, auth: DirectOAuthAuth | ManagedOAuthAuth): string => hash([
    row.pk, row.enrolled_at, row.config_json, row.granted_scopes_json,
    auth.type === 'oauth2_refresh' ? [auth.type, auth.native_credential_id, auth.client_id, auth.client_secret, auth.token_endpoint, auth.token_auth_style, auth.required_scopes]
      : [auth.type, auth.broker_profile_id, brokerSignature(auth.broker_profile_id), deps.broker.diagnosticProfileSignature?.(), auth.integration_id, auth.connection_id, auth.target_origin, auth.requested_scopes, auth.required_scopes],
  ]);
  // Runtime cache rotation preserves the binding, but invalidates the exact
  // token response whose permissions an outstanding owner review displayed.
  const credentialEvidence = (auth: DirectOAuthAuth | ManagedOAuthAuth): string | undefined => auth.type === 'oauth2_refresh'
    ? hash([auth.current_access_token, auth.refresh_token, auth.expires_at]) : undefined;
  const grantList = (row: ConnectionRow): readonly string[] | null => {
    try { const v: unknown = JSON.parse(row.granted_scopes_json ?? 'null');
      return Array.isArray(v) && v.length <= 256 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048) ? v : null; } catch { return null; }
  };
  const fresh = createEnsureFreshAuth({ fetchImpl, now,
    withAuthRenewal: (row, run) => withCurrentConnectionRenewal(deps.store, row, run),
    persistAuth: (row, auth, patch) => persistNativeOAuthRenewal({ store: deps.store, decode: deps.decode, encode: deps.encode, key: deps.key, now }, row, auth, patch) });
  const sourceFetch = (p: CollectionAuthenticationProvider, raw: unknown): HttpFetcher => makeBoundedOriginHttpFetcher({
    timeoutMs: 15_000, redirectPolicy: 'error', fetchImpl: async (url, init) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('connection_name' in raw) || typeof raw.connection_name !== 'string') throw changed();
      const live = await read(p, raw.connection_name); const expected = raw as CollectionOAuthBinding;
      if (!bindingMatches(bindingFor(raw.connection_name, live.auth, p), expected)) throw changed();
      const destination = new URL(String(url)); const base = new URL(collectionOAuthServiceBase(p));
      if (destination.origin !== base.origin || destination.username || destination.password
        || destination.pathname !== base.pathname && !destination.pathname.startsWith(base.pathname + '/')) throw changed();
      if (live.auth.type === 'managed_oauth') return deps.broker.fetch(live.auth, destination.toString(), init ?? {});
      const auth = await fresh(live.row, live.auth);
      const latest = await read(p, raw.connection_name);
      if (!bindingMatches(bindingFor(raw.connection_name, latest.auth, p), expected)
        || material(latest.row, latest.auth) !== material(live.row, live.auth)) throw changed();
      const headers = new Headers(init?.headers); injectConnectionApiAuth(auth, headers, destination, { method: init?.method ?? 'GET', nowMs: now() });
      return fetchImpl(destination, { ...init, headers, credentials: 'omit', redirect: 'error' });
    } });
  return {
    async candidates(p) {
      const results: CollectionAuthenticationSource[] = [];
      for (const row of deps.store.list({ kind: 'api' })) {
        try { const live = await read(p, row.name); results.push({ name: row.name, display_name: row.display_name,
          authentication: live.auth.type === 'oauth2_refresh' ? 'direct_oauth' : 'broker' }); } catch { /* Incompatible or locked sources are not selectable. */ }
      }
      return results.sort((a, b) => Number(a.authentication === 'broker') - Number(b.authentication === 'broker') || a.display_name.localeCompare(b.display_name));
    },
    async prepare(p, name, needs) {
      let live = await read(p, name); let grants = grantList(live.row);
      const original = live;
      const nativeId = live.auth.type === 'oauth2_refresh' ? live.auth.native_credential_id ?? randomBytes(32).toString('base64url') : undefined;
      const required = managedOAuthScopeUnion(live.auth.required_scopes ?? [], needs);
      if (required.length > 256) throw new RpcError('bad_request', 'The combined permission needs are too large.');
      if (live.auth.type === 'oauth2_refresh') {
        const native = { ...live.auth, native_credential_id: nativeId, required_scopes: live.auth.required_scopes };
        const source = live;
        const renewed = await withCurrentConnectionRenewal(deps.store, source.row, async () => {
          const result = await refreshOAuth2WithMetadata(native, fetchImpl, now, source.config.vendor ? getVendorProvider(source.config.vendor) : undefined);
          await persistNativeOAuthRenewal({ store: deps.store, decode: deps.decode, encode: deps.encode, key: deps.key, now }, source.row, result.auth);
          return result;
        });
        // A successful rotating token must survive even when runtime metadata is incompatible.
        if (renewed.runtime_base.status === 'missing' || renewed.runtime_base.status === 'invalid'
          || renewed.runtime_base.status === 'valid' && new URL(renewed.runtime_base.base_url).origin !== new URL(collectionOAuthServiceBase(p)).origin) throw changed();
        grants = renewed.granted_scopes ?? null;
      }
      live = await read(p, name);
      const adjusted = { ...original.auth, ...(original.auth.type === 'oauth2_refresh' ? { native_credential_id: nativeId } : {}) };
      if (material(original.row, adjusted) !== material(live.row, live.auth)) throw changed();
      let checkedRow = live.row; const reviewedProfiles = live.auth.type === 'managed_oauth' ? deps.broker.diagnosticProfileSignature?.() : undefined;
      let needsCiphertext: string | undefined; const binding = bindingFor(name, live.auth, p); const expected = material(live.row, live.auth);
      const evidence = credentialEvidence(live.auth);
      const expiresAt = live.auth.type === 'oauth2_refresh' ? live.auth.expires_at : undefined;
      const assertEvidence = (): void => {
        if (binding.type === 'direct_oauth' && (typeof expiresAt !== 'number' || expiresAt <= now())) throw changed();
      };
      return { binding, source: { name, display_name: live.row.display_name, authentication: live.auth.type === 'oauth2_refresh' ? 'direct_oauth' : 'broker' },
        grantedScopes: grants, fetch: sourceFetch(p, binding), assertCurrent: async () => { const current = await read(p, name);
          assertEvidence();
          if (material(current.row, current.auth) !== expected || credentialEvidence(current.auth) !== evidence) throw changed(); checkedRow = current.row;
          needsCiphertext = JSON.stringify(current.auth.required_scopes ?? []) === JSON.stringify(required) ? undefined
            : await deps.encode({ ...current.auth, required_scopes: required }, current.row, deps.key); },
        beforeSwap: () => { const row = deps.store.get('api', name);
          assertEvidence();
          if (binding.type === 'managed_oauth' && (brokerSignature(binding.broker_profile_id) !== binding.broker_profile_signature
            || deps.broker.diagnosticProfileSignature?.() !== reviewedProfiles)) throw changed();
          if (!row || row.pk !== checkedRow.pk || row.enrolled_at !== checkedRow.enrolled_at
            || row.auth_ciphertext !== checkedRow.auth_ciphertext || row.config_json !== checkedRow.config_json
            || row.granted_scopes_json !== checkedRow.granted_scopes_json) throw changed();
          // Runs inside the collection/receipt SQLite transaction, after final proof.
          if (needsCiphertext && !deps.store.persistRefreshedAuth?.(row, needsCiphertext, Math.max(now(), row.updated_at + 1))) throw changed(); } };
    },
    fetch: sourceFetch,
    previousBrokerFetch(p, raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw changed();
      const b = raw as ManagedOAuthCollectionBinding;
      if ('broker_profile_signature' in b && b.broker_profile_signature !== brokerSignature(b.broker_profile_id)) throw changed();
      if (b.target_origin !== new URL(collectionOAuthServiceBase(p)).origin || !b.broker_profile_id || !b.integration_id || !b.connection_id) throw changed();
      const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: b.broker_profile_id,
        integration_id: b.integration_id, connection_id: b.connection_id, target_origin: b.target_origin, requested_scopes: [] };
      return makeBoundedOriginHttpFetcher({ timeoutMs: 15_000, redirectPolicy: 'error', fetchImpl: (url, init) => {
        // This path reads identity only for a previously pinned broker account.
        const target = new URL(String(url));
        const allowed = p === 'gmail' ? target.pathname === '/gmail/v1/users/me/profile'
          : p === 'gcal' ? target.pathname === '/calendar/v3/calendars/primary'
          : target.pathname === '/v1.0/me/mailFolders/inbox' || target.pathname === '/v1.0/me/calendar'
            || target.pathname === '/v1.0/me' && target.search === '?$select=mail,userPrincipalName';
        if ((init?.method ?? 'GET') !== 'GET' || target.origin !== b.target_origin || target.username || target.password || !allowed) throw changed();
        return deps.broker.fetch(auth, target.toString(), init ?? {});
      } });
    },
  };
};
