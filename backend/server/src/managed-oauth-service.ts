/** D-322 — one owner-bound broker service shared by enrollment and execution. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  RpcError, managedOAuthProvidersForTarget, managedOAuthScopeUnion,
  type ConnectionAuth, type ConnectionRow, type ManagedOAuthAuth,
  type ManagedOAuthRequest, type ManagedOAuthResponse, type ManagedOAuthProfileView,
} from '@recued/contracts';
import type { ManagedOAuthProfile, ManagedOAuthProfileStore } from './managed-oauth-profile-store.js';
import { createNangoOAuthAdapter, managedOAuthServerUrl } from './managed-oauth-nango.js';
import { IngredientError } from '@recued/ingredients';

interface Flow {
  claim: string; expires: number; profile: ManagedOAuthProfileView; integration: string;
  target: string; scopes: string[]; remoteId?: string; name?: string; revision?: number; row_fingerprint?: string;
  requiredScopes?: string[]; snapshot?: string; grantedScopes?: string[];
  packRequirements?: { vendor: string; baseUrl: string; scopes: string[] };
  auth?: ManagedOAuthAuth; busy: boolean;
}
interface Receipt { flow: Flow; expires: number }
export interface ManagedOAuthService {
  handle(args: ManagedOAuthRequest): Promise<ManagedOAuthResponse>;
  /** Verify after encryption, immediately before the synchronous write. Returns receipt-free auth. */
  authorizeForSave(auth: ManagedOAuthAuth, baseUrl: string, name: string, existing?: ConnectionRow): {
    auth: ManagedOAuthAuth; granted_scopes?: readonly string[];
  };
  fetch(auth: ManagedOAuthAuth, target: string, init: RequestInit): Promise<Response>;
}
export interface ManagedOAuthServiceDeps {
  profiles: ManagedOAuthProfileStore;
  listConnections(): ConnectionRow[];
  decodeAuth(row: ConnectionRow): Promise<ConnectionAuth>;
  /** Synchronous: grant evidence becomes unknown before a reconnect can change consent. */
  clearGrantedScopes?(names: readonly string[]): void;
  requiredScopes?(vendor: string, baseUrl: string): readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const nonce = (): string => randomBytes(32).toString('base64url');
const connectionFingerprint = (row: ConnectionRow): string => createHash('sha256').update(JSON.stringify([
  row.pk, row.kind, row.name, row.updated_at, row.enrolled_at, row.auth_ciphertext, row.config_json,
  row.display_name, row.subtype, row.subresource_path, row.granted_scopes_json,
])).digest('hex');
const connectionSignature = (rows: readonly ConnectionRow[]): string => JSON.stringify(rows.map(connectionFingerprint).sort());
const same = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2048 || /[\r\n\0]/.test(value)) {
    throw new RpcError('bad_request', `${label} is required and must be valid text.`);
  }
  return value.trim();
};
const targetOrigin = (raw: string): string => {
  const canonical = managedOAuthServerUrl(raw);
  return new URL(canonical).origin;
};

const authorizationScopes = (target: string, wanted: string[]): string[] => {
  if (new URL(target).hostname !== 'sheets.googleapis.com'
    || !wanted.includes('https://www.googleapis.com/auth/spreadsheets')) return wanted;
  // Full Sheets access already permits reads. Google verifies the readonly URI
  // separately; adding it can block a shared app approved for the full scope.
  return wanted.filter((scope) => scope !== 'https://www.googleapis.com/auth/spreadsheets.readonly');
};
const scopeList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 256 || value.some(scope => typeof scope !== 'string'
    || scope.length > 2048 || /[\r\n\0]/.test(scope))) {
    throw new RpcError('bad_request', 'OAuth scopes must be a bounded list of valid strings.');
  }
  return managedOAuthScopeUnion(value);
};
const recordedGrants = (row: ConnectionRow): string[] | undefined => {
  if (row.granted_scopes_json === undefined) return undefined;
  try { return scopeList(JSON.parse(row.granted_scopes_json)); }
  catch { return undefined; }
};
const covers = (target: string, tracked: readonly string[], required: readonly string[]): boolean => {
  const host = new URL(target).hostname;
  const canonical = (scope: string): string => {
    if (host === 'graph.microsoft.com') return scope.replace(/^https:\/\/graph\.microsoft\.com\//, '');
    if (host.endsWith('.googleapis.com') && scope === 'https://www.googleapis.com/auth/userinfo.email') return 'email';
    if (host.endsWith('.googleapis.com') && scope === 'https://www.googleapis.com/auth/userinfo.profile') return 'profile';
    return scope;
  };
  return required.every(scope => tracked.some(prior => canonical(prior) === canonical(scope))
    || (host === 'sheets.googleapis.com' && scope === 'https://www.googleapis.com/auth/spreadsheets.readonly'
      && tracked.includes('https://www.googleapis.com/auth/spreadsheets')));
};
const missingPublicIdentity = (error: unknown): boolean => error instanceof RpcError
  && error.message === 'Nango did not expose a stable identity for this saved account.';

export const createManagedOAuthService = (deps: ManagedOAuthServiceDeps): ManagedOAuthService => {
  const now = deps.now ?? Date.now;
  const adapter = createNangoOAuthAdapter(deps.fetchImpl);
  const flows = new Map<string, Flow>();
  const receipts = new Map<string, Receipt>();
  const deletingAccounts = new Set<string>();
  const startingAccounts = new Set<string>();
  let accountRevision = 0;
  const accountKey = (base: string, integration: string, id: string): string => JSON.stringify([base, integration, id]);
  const prune = (): void => {
    for (const [id, value] of flows) if (value.expires <= now()) flows.delete(id);
    for (const [id, value] of receipts) if (value.expires <= now()) receipts.delete(id);
  };
  const profile = (id: string): ManagedOAuthProfile => {
    const found = deps.profiles.get(text(id, 'Broker profile'));
    if (found === undefined) throw new RpcError('not_configured', 'The saved OAuth broker profile is unavailable.');
    if (found.broker !== 'nango') throw new RpcError('not_configured', 'This OAuth broker adapter is not available.');
    return found;
  };
  const requirements = (row: ConnectionRow): string[] => {
    const config = JSON.parse(row.config_json) as { vendor?: string; base_url?: string };
    return typeof config.vendor === 'string' && typeof config.base_url === 'string'
      ? scopeList(deps.requiredScopes?.(config.vendor, config.base_url) ?? []) : [];
  };
  // D-322 — a new/attached service has no saved row for scopeSnapshot to inspect.
  const packRequirements = (vendor: string | undefined, baseUrl: string): Flow['packRequirements'] => {
    if (vendor === undefined) return undefined;
    const selected = text(vendor, 'Vendor');
    return { vendor: selected, baseUrl, scopes: scopeList(deps.requiredScopes?.(selected, baseUrl) ?? []) };
  };
  const assertPackRequirements = (expected: Flow['packRequirements']): void => {
    if (expected !== undefined && JSON.stringify(expected.scopes)
      !== JSON.stringify(scopeList(deps.requiredScopes?.(expected.vendor, expected.baseUrl) ?? []))) {
      throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
    }
  };
  const scopeSnapshot = (): string => {
    const rows = deps.listConnections().filter(row => row.kind === 'api');
    return JSON.stringify([connectionSignature(rows), deps.profiles.list().map(p => [p.id, p.revision]).sort(), deps.profiles.scopeHistorySignature(),
      rows.map(row => [row.name, requirements(row)]).sort()]);
  };
  const accountScopes = async (saved: ManagedOAuthProfile, integration: string, id: string) => {
    const snapshot = scopeSnapshot();
    const members: { row: ConnectionRow; auth: ManagedOAuthAuth }[] = [];
    const identities = new Map<string, string>();
    const identity = async (p: ManagedOAuthProfile): Promise<string> => {
      const known = identities.get(p.id);
      if (known !== undefined) return known;
      const value = await adapter.connectionIdentity(p, integration, id);
      identities.set(p.id, value); return value;
    };
    for (const row of deps.listConnections().filter(row => row.kind === 'api')) {
      const auth = await deps.decodeAuth(row);
      if (auth.type !== 'managed_oauth' || auth.integration_id !== integration || auth.connection_id !== id) continue;
      const other = profile(auth.broker_profile_id);
      if (other.base_url !== saved.base_url) continue;
      // IDs are environment-local. Two profiles at api.nango.dev can name different accounts.
      if (other.id !== saved.id && await identity(other) !== await identity(saved)) continue;
      members.push({ row, auth });
    }
    let remoteIdentity: string | undefined;
    // Legacy/self-hosted metadata can omit public identity. Keep saved-row
    // preservation, but never key durable history on an environment-local ID.
    try { remoteIdentity = await identity(saved); }
    catch (error) { if (!missingPublicIdentity(error)) throw error; }
    const history = remoteIdentity === undefined ? undefined : deps.profiles.accountScopes(saved.base_url, integration, remoteIdentity);
    if (scopeSnapshot() !== snapshot) throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
    return { snapshot, members, remoteIdentity, completed: history, known: history !== undefined || members.some(m => m.auth.imported !== true),
      requested: managedOAuthScopeUnion(history ?? [], ...members.map(m => scopeList(m.auth.requested_scopes))),
      required: managedOAuthScopeUnion(...members.map(m => managedOAuthScopeUnion(
        m.auth.required_scopes ?? m.auth.requested_scopes, requirements(m.row)))),
      grants: members.flatMap(m => { const grants = recordedGrants(m.row); return grants === undefined ? [] : [grants]; }) };
  };
  const assertCurrent = (flow: Flow): void => {
    assertPackRequirements(flow.packRequirements);
    if (flow.remoteId !== undefined && deletingAccounts.has(accountKey(flow.profile.base_url, flow.integration, flow.remoteId))) {
      throw new RpcError('conflict', 'This Nango account is being deleted. Refresh accounts before saving.');
    }
    if (profile(flow.profile.id).revision !== flow.profile.revision) {
      throw new RpcError('conflict', 'The OAuth broker profile changed. Authorize again.');
    }
    if (flow.name !== undefined) {
      const row = deps.listConnections().find((row) => row.kind === 'api' && row.name === flow.name);
      if (row === undefined || row.updated_at !== flow.revision || connectionFingerprint(row) !== flow.row_fingerprint) {
        throw new RpcError('conflict', 'The saved connection changed. Open it again before authorizing.');
      }
    }
    if (flow.snapshot !== undefined && flow.snapshot !== scopeSnapshot()) {
      throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
    }
  };
  const rememberCompleted = async (flow: Flow, completed: { connection_id: string; identity?: string }, checkCurrent = true): Promise<void> => {
    const saved = profile(flow.profile.id);
    let identity: string | undefined;
    try { identity = await adapter.connectionIdentity(saved, flow.integration, completed.connection_id); }
    catch (error) { if (!missingPublicIdentity(error)) throw error; }
    if (completed.identity !== undefined && identity !== completed.identity) {
      throw new RpcError('conflict', 'The Nango account changed while verifying completed consent. Refresh accounts and authorize again.');
    }
    if (checkCurrent) assertCurrent(flow);
    // A later row cannot supply the identity missing from the tagged completion.
    if (completed.identity !== undefined) deps.profiles.rememberAccountScopes(saved.base_url, flow.integration, completed.identity, flow.scopes);
    flow.snapshot = scopeSnapshot();
  };

  const verifyKeyRotation = async (previous: ManagedOAuthProfile, candidate: ManagedOAuthProfile): Promise<string | undefined> => {
    if (previous.api_key === candidate.api_key) return undefined;
    const rows = deps.listConnections(); const before = connectionSignature(rows);
    for (const row of rows) {
      const auth = await deps.decodeAuth(row);
      if (auth.type !== 'managed_oauth' || auth.broker_profile_id !== previous.id) continue;
      let original: string;
      try { original = await adapter.connectionIdentity(previous, auth.integration_id, auth.connection_id); }
      catch { throw new RpcError('bad_request', 'The existing key must verify saved Nango accounts before rotation. Rotate before revoking it, or create a new broker profile and connect its accounts again.'); }
      let updated: string;
      try { updated = await adapter.connectionIdentity(candidate, auth.integration_id, auth.connection_id); }
      catch { throw new RpcError('bad_request', 'The new key must list and verify the same Nango accounts. Check its environment and connection-list permission.'); }
      if (original !== updated) {
        throw new RpcError('bad_request', 'The new key must access the same Nango accounts. Create a new broker profile for another environment.');
      }
    }
    if (connectionSignature(deps.listConnections()) !== before) throw new RpcError('conflict', 'Connections changed while verifying the new broker key. Try again.');
    return before;
  };

  const saveProfile = async (a: Extract<ManagedOAuthRequest, { action: 'save_profile' }>): Promise<ManagedOAuthResponse> => {
    if (a.broker !== 'nango') throw new RpcError('bad_request', 'Only the Nango broker adapter is available.');
    const id = a.id === undefined ? nonce() : text(a.id, 'Broker profile');
    const previous = deps.profiles.get(id);
    if (a.id !== undefined && previous === undefined) throw new RpcError('not_found', 'The broker profile no longer exists.');
    const base_url = managedOAuthServerUrl(text(a.base_url, 'Broker URL'));
    const connect_ui_origin = a.connect_ui_origin === undefined ? previous?.connect_ui_origin : targetOrigin(text(a.connect_ui_origin, 'Connect UI origin'));
    if (previous !== undefined && previous.base_url !== base_url) throw new RpcError('bad_request', 'Create another broker profile to use a different server URL.');
    if (previous !== undefined && previous.connect_ui_origin !== connect_ui_origin) throw new RpcError('bad_request', 'Create another broker profile to use a different Connect UI origin.');
    const api_key = a.api_key === undefined ? previous?.api_key : text(a.api_key, 'Nango API key');
    if (api_key === undefined) throw new RpcError('bad_request', 'Enter the Nango API key for this server and environment.');
    const candidate: ManagedOAuthProfile = { id, label: text(a.label, 'Broker name'), broker: 'nango', base_url, api_key,
      ...(connect_ui_origin === undefined ? {} : { connect_ui_origin }),
      revision: Math.max(now(), (previous?.revision ?? 0) + 1) };
    const integrations = await adapter.integrations(candidate); // Test before writing any secret.
    const connectionsVersion = previous === undefined ? undefined : await verifyKeyRotation(previous, candidate);
    if (connectionsVersion !== undefined && connectionSignature(deps.listConnections()) !== connectionsVersion) throw new RpcError('conflict', 'Connections changed while verifying the new broker key. Try again.');
    if (deps.profiles.get(id)?.revision !== previous?.revision) throw new RpcError('conflict', 'The broker profile changed while it was being tested. Try again.');
    deps.profiles.save(candidate);
    const { api_key: ignored, ...view } = candidate; void ignored;
    return { action: 'save_profile', profile: view, integrations };
  };

  const start = async (a: Extract<ManagedOAuthRequest, { action: 'start' }>): Promise<ManagedOAuthResponse> => {
    prune();
    const accountVersion = accountRevision;
    if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
    const requested = scopeList(a.scopes);
    if (a.force_reauthorization !== undefined && typeof a.force_reauthorization !== 'boolean') throw new RpcError('bad_request', 'Choose a valid reauthorization option.');
    const saved = profile(a.profile_id);
    const target = targetOrigin(text(a.base_url, 'Vendor API URL'));
    const packs = packRequirements(a.vendor, a.base_url);
    const integration = await adapter.integration(saved, text(a.integration_id, 'Integration'));
    const row = a.name === undefined ? undefined : deps.listConnections().find((row) => row.kind === 'api' && row.name === a.name);
    if (a.name !== undefined && row === undefined) throw new RpcError('not_found', 'The connection to reauthorize no longer exists.');
    const old = row === undefined ? undefined : await deps.decodeAuth(row);
    if (old !== undefined && (old.type !== 'managed_oauth' || old.broker_profile_id !== saved.id || old.integration_id !== integration.id || old.target_origin !== target)) {
      throw new RpcError('bad_request', 'Reauthorization must keep the saved broker, integration and vendor. Create another connection to change them.');
    }
    const previous = old?.type === 'managed_oauth' ? old : undefined;
    if (previous !== undefined && a.connection_id !== undefined && a.connection_id !== previous.connection_id) {
      throw new RpcError('bad_request', 'Reauthorization must keep the saved Nango account.');
    }
    const remoteId = previous?.connection_id ?? (a.connection_id === undefined ? undefined : text(a.connection_id, 'Nango account'));
    const key = remoteId === undefined ? undefined : accountKey(saved.base_url, integration.id, remoteId);
    if (key !== undefined && (startingAccounts.has(key) || [...flows.values()].some((flow) => flow.remoteId !== undefined
      && accountKey(flow.profile.base_url, flow.integration, flow.remoteId) === key))) {
      throw new RpcError('conflict', 'Authorization for this Nango account is already pending. Complete or cancel it before authorizing again.');
    }
    if (key !== undefined) startingAccounts.add(key);
    try {
      const remote = remoteId === undefined ? undefined : await adapter.existing(saved, integration.id, remoteId);
      const account = remoteId === undefined ? undefined : await accountScopes(saved, integration.id, remoteId);
      const latest = row === undefined ? undefined : deps.listConnections().find(r => r.kind === 'api' && r.name === row.name);
      if (row !== undefined && (latest === undefined || connectionFingerprint(latest) !== connectionFingerprint(row))) {
        throw new RpcError('conflict', 'The saved connection changed. Open it again before authorizing.');
      }
      if (accountRevision !== accountVersion) throw new RpcError('conflict', 'Nango accounts changed while verifying authorization. Refresh and authorize again.');
      if (profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The OAuth broker profile changed. Authorize again.');
      assertPackRequirements(packs);
      const requiredScopes = managedOAuthScopeUnion(requested, packs?.scopes ?? []);
      const needed = managedOAuthScopeUnion(requiredScopes, integration.default_scopes,
        ...(account?.members.filter(m => m.row.name !== row?.name).map(m => managedOAuthScopeUnion(
          m.auth.required_scopes ?? m.auth.requested_scopes, requirements(m.row))) ?? []));
      const granted = managedOAuthScopeUnion(...(account?.grants ?? []));
      const staticGraph = new URL(target).hostname === 'graph.microsoft.com'
        && integration.default_scopes.some((scope) => scope === '.default' || scope.endsWith('/.default'));
      if (remote !== undefined && !remote.auth_error && !a.force_reauthorization && !staticGraph
        && integration.scope_metadata === 'available' && account!.completed !== undefined
        && covers(target, account!.completed, needed)) {
        const flowId = nonce(); const receipt = nonce();
        const { api_key: ignored, ...view } = saved; void ignored;
        // Completed requests avoid duplicate consent; they never prove vendor grants.
        const flow: Flow = { claim: nonce(), expires: now() + 10 * 60_000, profile: view,
          integration: integration.id, target, scopes: account!.requested, requiredScopes,
          packRequirements: packs,
          snapshot: account!.snapshot, remoteId, busy: false,
          ...(row === undefined ? {} : { name: row.name, revision: row.updated_at, row_fingerprint: connectionFingerprint(row) }) };
        const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: saved.id, integration_id: integration.id,
          connection_id: remote.id, target_origin: target, requested_scopes: flow.scopes, required_scopes: requiredScopes,
          ...(account!.known ? {} : { imported: true as const }), authorization_receipt: receipt };
        flow.auth = auth; assertCurrent(flow);
        prune();
        if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
        flows.set(flowId, flow); receipts.set(receipt, { flow, expires: flow.expires });
        return { action: 'reuse', flow_id: flowId, claim_secret: flow.claim, auth, expires_at: flow.expires };
      }
      // Nango reconnect replaces a per-account override. Its token-free list does
      // not expose that history, so an imported account must not lose permissions.
      if (remoteId !== undefined && !account!.known) {
        throw new RpcError('bad_request', 'Recued does not know this account’s previous scopes. Reuse its current authorization, manage consent in Nango with its existing scope profile, or authorize a new account here.');
      }
      if (account !== undefined && account.requested.length > 0 && integration.scope_metadata === 'unknown') {
        throw new RpcError('bad_request', 'The broker did not expose its app scopes. Reconnecting could remove previous account permissions. Use a key that can read integration scopes, or manage consent in Nango with the existing scope profile.');
      }
      const wanted = managedOAuthScopeUnion(requiredScopes, integration.default_scopes,
        account?.required ?? [], account?.requested ?? [], granted);
      // Entra's static .default profile cannot be combined with dynamic Graph scopes.
      if (!staticGraph && new URL(target).hostname === 'graph.microsoft.com'
        && integration.scope_metadata === 'available'
        && wanted.some((scope) => scope === '.default' || scope.endsWith('/.default'))
        && wanted.some((scope) => !['openid', 'offline_access', 'profile', 'email'].includes(scope)
          && scope !== '.default' && !scope.endsWith('/.default'))) {
        throw new RpcError('bad_request', 'Do not combine .default with individual Microsoft Graph scopes. Configure a static scope profile in the broker or remove .default from the requested scopes.');
      }
      // Unknown defaults must not be replaced: that could drop a shared app's required permissions.
      const requestScopes = staticGraph ? [...integration.default_scopes]
        : integration.scope_metadata === 'available' ? authorizationScopes(target, wanted) : [];
      const flowId = nonce(); const claim = nonce();
      const defaults = requestScopes.length === 0 || staticGraph ? {} : { integrations_config_defaults: {
        [integration.id]: { connection_config: { oauth_scopes_override: requestScopes.join(',') } },
      } };
      const body = { ...defaults, tags: { recued_flow: flowId },
        ...(remoteId === undefined ? { allowed_integrations: [integration.id] }
          : { connection_id: remoteId, integration_id: integration.id }) };
      let snapshot = account?.snapshot;
      if (account !== undefined) {
        if (scopeSnapshot() !== snapshot) throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
        const names = account.members.filter(m => m.row.granted_scopes_json !== undefined).map(m => m.row.name);
        if (names.length > 0) {
          if (deps.clearGrantedScopes === undefined) throw new RpcError('not_configured', 'The server cannot invalidate shared grant evidence. Upgrade before reauthorizing.');
          // Consent may finish even if the popup is closed or the broker reply is lost.
          // Clear every sibling before starting the external flow, without changing credentials.
          deps.clearGrantedScopes(names); snapshot = scopeSnapshot();
        }
      }
      const currentRow = row === undefined ? undefined : deps.listConnections().find(r => r.kind === 'api' && r.name === row.name);
      const link = await adapter.start(saved, body, remoteId !== undefined);
      if (accountRevision !== accountVersion) throw new RpcError('conflict', 'Nango accounts changed while creating this authorization. Refresh and authorize again.');
      const { api_key: ignored, ...view } = saved; void ignored;
      const flow: Flow = { claim, expires: Math.min(link.expires_at, now() + 10 * 60_000), profile: view,
        integration: integration.id, target, scopes: requestScopes, requiredScopes, busy: false,
        packRequirements: packs,
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(remoteId === undefined ? {} : { remoteId }),
        ...(row === undefined ? {} : { name: row.name, revision: row.updated_at, row_fingerprint: connectionFingerprint(currentRow!) }) };
      assertCurrent(flow);
      prune();
      if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
      flows.set(flowId, flow);
      return { action: 'start', flow_id: flowId, claim_secret: claim, connect_link: link.connect_link,
        expires_at: flow.expires, requested_scopes: requestScopes, scope_metadata: staticGraph ? 'fixed' : integration.scope_metadata };
    } finally { if (key !== undefined) startingAccounts.delete(key); }
  };

  const attach = async (a: Extract<ManagedOAuthRequest, { action: 'attach' }>): Promise<ManagedOAuthResponse> => {
    prune();
    const accountVersion = accountRevision;
    if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
    const saved = profile(a.profile_id);
    const target = targetOrigin(text(a.base_url, 'Vendor API URL'));
    const packs = packRequirements(a.vendor, a.base_url);
    const integration = await adapter.integration(saved, text(a.integration_id, 'Integration'));
    const connection = await adapter.existing(saved, integration.id, text(a.connection_id, 'Nango account'));
    const account = await accountScopes(saved, integration.id, connection.id);
    const requiredScopes = managedOAuthScopeUnion(scopeList(a.scopes ?? []), packs?.scopes ?? []);
    if (accountRevision !== accountVersion) throw new RpcError('conflict', 'Nango accounts changed while verifying this authorization. Refresh accounts and try again.');
    if (connection.auth_error) throw new RpcError('bad_request', 'This Nango account needs reauthorization. Reauthorize the selected account before saving.');
    const { api_key: ignored, ...view } = saved; void ignored;
    const flow: Flow = { claim: nonce(), expires: now() + 10 * 60_000, profile: view,
      integration: integration.id, target, scopes: account.known ? account.requested : [], requiredScopes,
      packRequirements: packs,
      snapshot: account.snapshot, remoteId: connection.id, busy: false };
    assertCurrent(flow);
    prune();
    if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
    const flowId = nonce(); const receipt = nonce();
    const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: view.id, integration_id: integration.id,
      connection_id: connection.id, target_origin: target, requested_scopes: flow.scopes, required_scopes: requiredScopes,
      ...(account.known ? {} : { imported: true as const }), authorization_receipt: receipt };
    flow.auth = auth; flows.set(flowId, flow); receipts.set(receipt, { flow, expires: flow.expires });
    return { action: 'attach', flow_id: flowId, claim_secret: flow.claim, auth, expires_at: flow.expires };
  };

  const deleteRemote = async (a: Extract<ManagedOAuthRequest, { action: 'delete_remote_connection' }>): Promise<ManagedOAuthResponse> => {
    const saved = profile(a.profile_id); const integration = text(a.integration_id, 'Integration');
    const id = text(a.connection_id, 'Nango account');
    if (a.confirmation !== id) throw new RpcError('bad_request', 'Type the Nango account ID to confirm deletion. Other tools using this account will lose access.');
    const key = accountKey(saved.base_url, integration, id);
    if (deletingAccounts.has(key)) throw new RpcError('conflict', 'This Nango account is already being deleted.');
    deletingAccounts.add(key);
    try {
      const rows = deps.listConnections();
      const signature = (list: ConnectionRow[]) => JSON.stringify(list.map(connectionFingerprint).sort());
      const before = signature(rows);
      for (const row of rows) {
        const auth = await deps.decodeAuth(row);
        if (auth.type === 'managed_oauth' && auth.integration_id === integration && auth.connection_id === id
          && profile(auth.broker_profile_id).base_url === saved.base_url) {
          throw new RpcError('conflict', 'Remove the Recued connections using this Nango account before deleting it from Nango.');
        }
      }
      if (signature(deps.listConnections()) !== before || profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker or connections changed. Refresh before deleting this account.');
      await adapter.existing(saved, integration, id);
      if (signature(deps.listConnections()) !== before || profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker or connections changed. Refresh before deleting this account.');
      await adapter.deleteRemoteConnection(saved, integration, id);
      accountRevision += 1;
      for (const [flowId, flow] of flows) if (flow.profile.base_url === saved.base_url && flow.integration === integration && flow.remoteId === id) {
        flows.delete(flowId);
        if (flow.auth?.authorization_receipt !== undefined) receipts.delete(flow.auth.authorization_receipt);
      }
      return { action: 'delete_remote_connection' };
    } finally { deletingAccounts.delete(key); }
  };

  const status = async (a: Extract<ManagedOAuthRequest, { action: 'status' }>): Promise<ManagedOAuthResponse> => {
    prune();
    const flow = flows.get(a.flow_id);
    if (flow === undefined || !same(flow.claim, text(a.claim_secret, 'Authorization claim'))) return { action: 'status', status: 'expired' };
    assertCurrent(flow);
    if (flow.auth !== undefined) return { action: 'status', status: 'authorized', auth: flow.auth,
      ...(flow.grantedScopes === undefined ? {} : { granted_scopes: flow.grantedScopes }) };
    if (flow.busy) return { action: 'status', status: 'pending' };
    flow.busy = true;
    const accountVersion = accountRevision;
    try {
      const completed = await adapter.completed(profile(flow.profile.id), a.flow_id, flow.integration, flow.remoteId);
      if (accountRevision !== accountVersion) throw new RpcError('conflict', 'Nango accounts changed while verifying this authorization. Refresh accounts and authorize again.');
      assertCurrent(flow);
      if (flow.expires <= now() || flows.get(a.flow_id) !== flow) return { action: 'status', status: 'expired' };
      if (completed === undefined) return { action: 'status', status: 'pending' };
      flow.remoteId = completed.connection_id;
      assertCurrent(flow);
      // Retain completed requests independently of Save. A rejected consent
      // must not force its unsupported scope into every subsequent sign-in.
      await rememberCompleted(flow, completed);
      if (flow.expires <= now() || flows.get(a.flow_id) !== flow) return { action: 'status', status: 'expired' };
      const receipt = nonce();
      const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: flow.profile.id,
        integration_id: flow.integration, connection_id: completed.connection_id, target_origin: flow.target,
        requested_scopes: flow.scopes, required_scopes: flow.requiredScopes, authorization_receipt: receipt };
      flow.auth = auth;
      receipts.set(receipt, { flow, expires: flow.expires });
      // Tags prove new consent, not which permissions the vendor actually granted.
      return { action: 'status', status: 'authorized', auth };
    } finally { flow.busy = false; }
  };

  const handle = async (a: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (a === null || typeof a !== 'object') throw new RpcError('bad_request', 'Managed OAuth request is required.');
    prune();
    switch (a.action) {
      case 'profiles': return { action: 'profiles', profiles: deps.profiles.list() };
      case 'save_profile': return saveProfile(a);
      case 'delete_profile': {
        const saved = profile(a.id);
        const rows = deps.listConnections();
        const signature = (list: ConnectionRow[]) => JSON.stringify(list.map((row) => [row.pk, row.updated_at, row.auth_ciphertext]).sort());
        const before = signature(rows);
        for (const row of rows) {
          const auth = await deps.decodeAuth(row);
          if (auth.type === 'managed_oauth' && auth.broker_profile_id === saved.id) throw new RpcError('conflict', 'Remove this broker’s vendor connections before deleting its profile.');
        }
        // Recheck after asynchronous decrypts, before mutating.
        if (signature(deps.listConnections()) !== before) throw new RpcError('conflict', 'The connections changed while checking this profile. Try again.');
        if (profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker profile changed. Try again.');
        deps.profiles.delete(saved.id);
        return { action: 'delete_profile' };
      }
      case 'integrations': {
        const choices = await adapter.integrations(profile(a.profile_id));
        const providers = a.base_url === undefined ? [] : managedOAuthProvidersForTarget(text(a.base_url, 'Vendor API URL'), a.vendor);
        const matches = choices.filter((choice) => providers.includes(choice.provider));
        const integrations = matches.length === 0 ? choices : matches;
        const required_scopes = a.vendor === undefined || a.base_url === undefined ? [] : deps.requiredScopes?.(text(a.vendor, 'Vendor'), a.base_url) ?? [];
        return { action: 'integrations', integrations, required_scopes, ...(matches.length === 1 ? { selected_id: matches[0]!.id } : {}) };
      }
      case 'providers': {
        const choices = await adapter.providers(profile(a.profile_id));
        const expected = a.base_url === undefined ? [] : managedOAuthProvidersForTarget(text(a.base_url, 'Vendor API URL'), a.vendor);
        const matches = choices.filter((choice) => expected.includes(choice.id));
        return { action: 'providers', providers: matches.length === 0 ? choices : matches,
          ...(matches.length === 1 ? { selected_id: matches[0]!.id } : {}) };
      }
      case 'create_integration': {
        const saved = profile(a.profile_id);
        if (!['shared', 'custom'].includes(a.app) || !Array.isArray(a.scopes) || a.scopes.length > 256
          || a.scopes.some((scope) => typeof scope !== 'string' || scope.length > 2048)) throw new RpcError('bad_request', 'Choose a shared or custom OAuth app and valid scopes.');
        const provider = text(a.provider, 'Provider');
        if (!(await adapter.providers(saved)).some((choice) => choice.id === provider)) throw new RpcError('bad_request', 'Select an OAuth 2.0 provider from this Nango server.');
        if (profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker profile changed. Refresh before creating an integration.');
        const integration = await adapter.createIntegration(saved, { ...a, provider, integration_id: text(a.integration_id, 'Integration ID'),
          label: text(a.label, 'Integration name'), scopes: managedOAuthScopeUnion(a.scopes),
          ...(a.app === 'custom' ? { client_id: text(a.client_id, 'OAuth client ID'), client_secret: text(a.client_secret, 'OAuth client secret') } : {}) });
        if (profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker changed while creating the integration. Refresh integrations; it may already have been created in Nango.');
        return { action: 'create_integration', integration };
      }
      case 'remote_connections': {
        const saved = profile(a.profile_id); const id = text(a.integration_id, 'Integration');
        const page = a.page ?? 0;
        if (!Number.isSafeInteger(page) || page < 0 || page > 10000) throw new RpcError('bad_request', 'Enter a valid account page.');
        await adapter.integration(saved, id);
        const result = await adapter.remoteConnections(saved, id, page);
        if (profile(saved.id).revision !== saved.revision) throw new RpcError('conflict', 'The broker profile changed. Refresh accounts.');
        return { action: 'remote_connections', ...result };
      }
      case 'attach': return attach(a);
      case 'delete_remote_connection': return deleteRemote(a);
      case 'start': return start(a);
      case 'status': return status(a);
      case 'cancel': {
        const flow = flows.get(a.flow_id);
        if (flow !== undefined && same(flow.claim, text(a.claim_secret, 'Authorization claim'))) {
          if (flow.auth === undefined) {
            try {
              const completed = await adapter.completed(profile(flow.profile.id), a.flow_id, flow.integration, flow.remoteId);
              if (completed !== undefined) await rememberCompleted(flow, completed, false);
            } catch { /* Cancellation retires the claim even when completion cannot be confirmed. */ }
          }
          flows.delete(a.flow_id);
          if (flow.auth?.authorization_receipt !== undefined) receipts.delete(flow.auth.authorization_receipt);
        }
        return { action: 'cancel' };
      }
      default: throw new RpcError('bad_request', 'Unknown managed OAuth action.');
    }
  };

  const authorizeForSave: ManagedOAuthService['authorizeForSave'] = (auth, baseUrl, name, existing) => {
    prune();
    const receipt = auth.authorization_receipt === undefined ? undefined : receipts.get(auth.authorization_receipt);
    if (receipt === undefined) throw new RpcError('bad_request', 'Authorize this managed OAuth connection before saving.');
    const flow = receipt.flow;
    assertCurrent(flow);
    if (existing !== undefined && flow.name === undefined) throw new RpcError('conflict', 'That connection name already exists. Reauthorize it from its editor or choose another name.');
    const expected = flow.auth;
    if (expected === undefined || auth.broker_profile_id !== expected.broker_profile_id || auth.integration_id !== expected.integration_id
      || auth.connection_id !== expected.connection_id || auth.target_origin !== expected.target_origin || targetOrigin(baseUrl) !== flow.target
      || JSON.stringify(auth.requested_scopes) !== JSON.stringify(flow.scopes)
      || JSON.stringify(auth.required_scopes) !== JSON.stringify(flow.requiredScopes)
      || auth.imported !== expected.imported
      || (flow.name !== undefined && (flow.name !== name || existing?.updated_at !== flow.revision))) {
      throw new RpcError('bad_request', 'The connection changed after authorization. Authorize again before saving.');
    }
    receipts.delete(auth.authorization_receipt!);
    for (const [id, value] of flows) if (value === flow) flows.delete(id);
    const { authorization_receipt: ignored, ...stored } = expected; void ignored;
    return { auth: stored, ...(flow.grantedScopes === undefined ? {} : { granted_scopes: flow.grantedScopes }) };
  };

  return { handle, authorizeForSave, fetch: (auth, target, init) => {
    let saved: ManagedOAuthProfile;
    try { saved = profile(auth.broker_profile_id); }
    catch { throw new IngredientError('CONNECTION_REFUSED', 'The managed OAuth broker profile is unavailable. Check it in Connections.'); }
    return adapter.fetch(saved, auth, target, init);
  } };
};
