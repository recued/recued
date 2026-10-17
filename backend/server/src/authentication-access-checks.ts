/** The same saved credentials and bounded provider reads used by migrations. */
import { createHash } from 'node:crypto';
import { injectConnectionApiAuth } from '@recued/ingredients';
import { RpcError, managedOAuthDefaultVerificationUrl, managedOAuthVerificationUrl,
  type AuthenticationRepairTarget, type AuthenticationAccessCheck, type SourceRegistration } from '@recued/contracts';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ManagedOAuthService } from './managed-oauth-service.js';
import type { CollectionAuthenticationService } from './collection-authentication-service.js';
import type { PreparedAuthenticationAccess } from './authentication-access-verification.js';
import { connectionAccessAuthority } from './connection-access-evidence.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from './connection-auth-storage.js';
import { createFileSourceConnectionResolver } from './file-source-connection-resolver.js';
import { assertPersistedOAuthAccess } from './native-oauth-renewal.js';
import { sourceIdConnectionName } from './work-entity-source-boot.js';
import { collectionOAuthSourceName } from './collection-oauth-sources.js';
import type { CollectionInstanceStore } from './collections/instance-store.js';

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unknownWrites: AuthenticationAccessCheck = { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' };
const changed = (): RpcError => new RpcError('conflict', 'Saved authentication changed during the access check. Review again.');
export const createAuthenticationAccessChecks = (deps: {
  store: ConnectionStoreSqlite; key?: Parameters<typeof decodeAuthFromStorage>[2]; broker?: ManagedOAuthService;
  collections?: CollectionAuthenticationService; instances: CollectionInstanceStore;
  source(id: string): SourceRegistration | undefined; fetchImpl?: typeof fetch; now?(): number;
}) => {
  const now = deps.now ?? Date.now; const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolve = createFileSourceConnectionResolver({ connectionStore: deps.store, decodeAuthFromStorage, encodeAuthForStorage,
    keyProvider: deps.key, ...(deps.broker ? { managedOAuth: deps.broker } : {}), fetchImpl, now });
  const connection = async (name: string) => {
    const row = deps.store.get('api', name); if (!row) return;
    const sourceId = deps.store.getAuthSourceId?.('api', name); const cleanupId = deps.store.permissionCleanupId?.(name);
    const auth = await decodeAuthFromStorage(row.auth_ciphertext, row, deps.key);
    const config = JSON.parse(row.config_json) as { base_url?: string };
    const base = typeof config.base_url === 'string' ? config.base_url : '';
    const signature = auth.type === 'managed_oauth' ? deps.broker?.savedAccessProfileSignature?.(auth.broker_profile_id) : undefined;
    const revision = hash([row.pk, row.enrolled_at, row.config_json, row.granted_scopes_json,
      sourceId, cleanupId, base ? connectionAccessAuthority(auth, base) : row.auth_ciphertext,
      auth.type === 'managed_oauth' || auth.type === 'oauth2_refresh' ? auth.required_scopes : undefined, signature]);
    const latest = deps.store.get('api', name);
    if (!latest || latest.pk !== row.pk || latest.enrolled_at !== row.enrolled_at || latest.auth_ciphertext !== row.auth_ciphertext || latest.config_json !== row.config_json
      || latest.granted_scopes_json !== row.granted_scopes_json || deps.store.getAuthSourceId?.('api', name) !== sourceId
      || deps.store.permissionCleanupId?.(name) !== cleanupId) throw changed();
    return { row, auth, base, revision };
  };
  const missing = (target: AuthenticationRepairTarget): PreparedAuthenticationAccess => ({ descriptor: {
    label: target.kind === 'connection' ? 'API: ' + target.name : target.kind === 'collection' ? target.platform + ': ' + target.slug
      : target.kind === 'file_source' ? 'Files: ' + target.source_id : 'Saved OAuth app settings',
    authentication_revision: hash([target, 'unavailable']), check: 'unsupported' },
    run: async () => [{ kind: target.kind === 'collection' ? 'collection_read' : target.kind === 'file_source' ? 'file_metadata' : 'api_read', status: 'unconfirmed', reason: 'unsupported' }] });
  const prepare = async (target: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess> => {
    if (target.kind === 'oauth_apps') return missing(target);
    if (target.kind === 'collection') {
      const row = deps.instances.get(target.platform, target.slug);
      if (!row || !deps.collections?.prepareSavedAccess || !['gmail', 'gcal', 'graph'].includes(row.adapter_type)) return missing(target);
      const saved = await deps.collections.prepareSavedAccess(target.platform, target.slug);
      const name = collectionOAuthSourceName(row.config); const api = name ? await connection(name) : undefined;
      if (name && !api) return missing(target);
      return { descriptor: { ...saved.descriptor, authentication_revision: hash([saved.descriptor.authentication_revision, api?.revision]) },
        run: async (choice, signal) => {
          const revision = (await prepare(target)).descriptor.authentication_revision;
          if (revision !== hash([saved.descriptor.authentication_revision, api?.revision])) throw changed();
          const checks = await saved.run(choice, signal);
          if ((await prepare(target)).descriptor.authentication_revision !== revision) throw changed();
          return checks;
        } };
    }
    if (target.kind === 'file_source') {
      const source = deps.source(target.source_id); const name = source && sourceIdConnectionName(source.id);
      if (!source || source.source_kind !== 'connection' || source.top_tier_kind !== 'file' || !name || !deps.broker?.verifySavedFileAccess) return missing(target);
      const saved = await connection(name);
      if (!saved || !deps.broker.isFileSourceSwitch?.(name)) return missing(target);
      const revision = hash([saved.revision, source.id, source.registered_at]);
      return { descriptor: { label: 'Files: ' + source.source_label, check: 'file_metadata', authentication_revision: revision,
        file_connection: { name, updated_at: saved.row.updated_at } }, run: async (choice, signal) => {
          if ((await prepare(target)).descriptor.authentication_revision !== revision) throw changed();
          return deps.broker!.verifySavedFileAccess!(name, choice?.file_id, signal);
        } };
    }
    const saved = await connection(target.name);
    if (!saved || !saved.base || !['oauth2_refresh', 'managed_oauth', 'bearer'].includes(saved.auth.type)) return missing(target);
    const assertCurrent = async (): Promise<void> => { if ((await connection(target.name))?.revision !== saved.revision) throw changed(); };
    return { descriptor: { label: 'API: ' + (saved.row.display_name || target.name), check: 'api_read', authentication_revision: saved.revision,
      base_url: saved.base, ...(managedOAuthDefaultVerificationUrl(saved.base) ? { default_url: managedOAuthDefaultVerificationUrl(saved.base) } : {}) },
      run: async (choice, signal) => {
        const url = managedOAuthVerificationUrl(saved.base, choice?.url ?? '');
        if (!url) return [{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }, unknownWrites];
        if (signal?.aborted) throw new Error('Access check cancelled'); await assertCurrent();
        const cred = await resolve(target.name); if (!cred) throw changed();
        const current = await connection(target.name); if (!current || current.revision !== saved.revision) throw changed();
        assertPersistedOAuthAccess(cred.auth, current.auth);
        const boundedSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
        const request: RequestInit = { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: boundedSignal() };
        let response: Response;
        if (cred.auth.type === 'managed_oauth') {
          if (!deps.broker) throw new RpcError('not_configured', 'The saved broker is unavailable.');
          response = await deps.broker.fetch(cred.auth, url, request);
        } else {
          const headers = new Headers(request.headers); const destination = new URL(url);
          injectConnectionApiAuth(cred.auth, headers, destination, { method: 'GET', nowMs: now() });
          response = await fetchImpl(destination, { ...request, headers });
        }
        await response.body?.cancel().catch(() => {}); if (signal?.aborted) throw new Error('Access check cancelled'); await assertCurrent();
        if (!response.ok || response.redirected) return [{ kind: 'api_read', status: [401, 403].includes(response.status) ? 'failed' : 'unconfirmed',
          reason: [401, 403].includes(response.status) ? 'access_rejected' : 'inconclusive' }, unknownWrites];
        // A public endpoint cannot prove that these credentials work.
        const control = await fetchImpl(url, { ...request, signal: boundedSignal() });
        await control.body?.cancel().catch(() => {}); await assertCurrent();
        return [{ kind: 'api_read', ...([401, 403].includes(control.status) && !control.redirected
          ? { status: 'passed' as const } : { status: 'unconfirmed' as const, reason: 'inconclusive' as const }) }, unknownWrites];
      } };
  };
  return prepare;
};
