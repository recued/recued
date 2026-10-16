/** D-322 — one owner-bound broker service shared by enrollment and execution. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  RpcError, managedOAuthProvidersForTarget, managedOAuthScopeUnion,
  type ConnectionAuth, type ConnectionRow, type ManagedOAuthAuth,
  type ManagedOAuthRequest, type ManagedOAuthResponse, type ManagedOAuthProfileView, type ManagedOAuthPermissionPreview,
  type ManagedOAuthConnectionUse, type ManagedOAuthImpactPreview, type ManagedOAuthAccountPreview,
  type ManagedOAuthMigrationCandidate,
  managedOAuthDefaultVerificationUrl, MANAGED_OAUTH_MIGRATION_LIMIT,
} from '@recued/contracts';
import type { ManagedOAuthProfile, ManagedOAuthProfileStore } from './managed-oauth-profile-store.js';
import { createNangoOAuthAdapter, managedOAuthServerUrl } from './managed-oauth-nango.js';
import { IngredientError } from '@recued/ingredients';
import { managedOAuthConnectionUsage } from './managed-oauth-account-usage.js';
import { readManagedOAuthAccountIdentity } from './managed-oauth-account-preview.js';
import { createFileSourceAuthentication, type FileSourceAuthenticationDeps } from './file-source-authentication.js';
import { managedOAuthImpact, managedOAuthImpactSignature } from './managed-oauth-impact.js';

interface Flow {
  claim: string; expires: number; profile: ManagedOAuthProfileView; integration: string;
  target: string; scopes: string[]; remoteId?: string; name?: string; revision?: number; row_fingerprint?: string;
  requiredScopes?: string[]; snapshot?: string; grantedScopes?: string[];
  packRequirements?: { vendor: string; baseUrl: string; scopes: string[] };
  auth?: ManagedOAuthAuth; busy: boolean;
  switchAuthentication?: true;
  remoteIdentity?: string;
  baseUrl?: string;
  impactConsent?: 'reuse' | 'request';
  impactNames?: string[];
  impactSnapshot?: string;
}
interface Receipt { flow: Flow; expires: number }
const switchAccountRefused = (message: string, unavailable = false): RpcError => new RpcError(
  'credential_verification_failed', `${message} Your saved authentication was kept.`, 422, 'collection.connection.managedOAuth', {
    verification_status: unavailable ? 'unreachable' : 'unknown',
    reason: unavailable ? 'broker_account_check_unavailable' : 'broker_account_changed', existing_credential_preserved: true,
  },
);
export interface ManagedOAuthService {
  handle(args: ManagedOAuthRequest): Promise<ManagedOAuthResponse>;
  /** Verify after encryption. Deferred consumption follows the durable switch commit. */
  authorizeForSave(auth: ManagedOAuthAuth, baseUrl: string, name: string, existing?: ConnectionRow,
    options?: { consume?: false; switchAuthentication?: true }): {
    auth: ManagedOAuthAuth; granted_scopes?: readonly string[]; consume(): void;
  };
  verifySwitchAccount(auth: ManagedOAuthAuth): Promise<void>;
  verifyFileSourceSwitch?(name: string, auth: ConnectionAuth): Promise<import('@recued/contracts').ConnectionHealth | undefined>;
  assertFileSourceSwitchCurrent?(name: string): void;
  isFileSourceSwitch?(name: string): boolean;
  verifyImpact?(auth: ManagedOAuthAuth, fingerprint: string): Promise<void>;
  /** Current declared permissions only; no broker or vendor request. */
  reauthorizationScopes?(name: string): readonly string[];
  migrationCandidates?(names?: readonly string[]): Promise<ManagedOAuthMigrationCandidate[]>;
  migrationSignature?(names: readonly string[]): string;
  claimMigration?(auth: ManagedOAuthAuth, names: readonly string[]): Promise<ManagedOAuthMigrationAuthority>;
  directMigrationSignature?(names: readonly string[]): string;
  previewDirectImpact?(name: string, auth: import('@recued/contracts').DirectOAuthAuth,
    members?: readonly string[]): Promise<ManagedOAuthImpactPreview>;
  /** D-322 §24 — read-only diagnostic fences, independent of consent receipts. */
  diagnosticProfileSignature?(): string;
  collectionProfileSignature?(id: string): string;
  inspectAccount?(auth: ManagedOAuthAuth): Promise<{ identity?: string; profile_revision: number; auth_error: boolean }>;
  fetch(auth: ManagedOAuthAuth, target: string, init: RequestInit): Promise<Response>;
}
/** Backend-only authority transferred from one reviewed consent to its selected rows. */
export interface ManagedOAuthMigrationAuthority {
  expires_at: number;
  names: readonly string[];
  signature: string;
  issue(name: string): Promise<{ auth: ManagedOAuthAuth; impact: ManagedOAuthImpactPreview; retire(): void }>;
  close(): void;
}
export interface ManagedOAuthServiceDeps {
  profiles: ManagedOAuthProfileStore;
  listConnections(): ConnectionRow[];
  decodeAuth(row: ConnectionRow): Promise<ConnectionAuth>;
  /** Synchronous: grant evidence becomes unknown before a reconnect can change consent. */
  clearGrantedScopes?(names: readonly string[]): void;
  requiredScopes?(vendor: string, baseUrl: string): readonly string[];
  requiredScopeSources?(vendor: string, baseUrl: string): readonly { slug: string; name: string; scopes: readonly string[] }[];
  connectionUses?(name: string): { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean };
  fileSources?: Omit<FileSourceAuthenticationDeps, 'rows' | 'unlock' | 'managedFetch' | 'fetch' | 'now'>;
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
export const oauthScopesCover = (target: string, tracked: readonly string[], required: readonly string[]): boolean => {
  const host = new URL(target).hostname;
  const canonical = (scope: string): string => {
    if (host === 'graph.microsoft.com') return scope.replace(/^https:\/\/graph\.microsoft\.com\//, '');
    if (host.endsWith('.googleapis.com') && scope === 'https://www.googleapis.com/auth/userinfo.email') return 'email';
    if (host.endsWith('.googleapis.com') && scope === 'https://www.googleapis.com/auth/userinfo.profile') return 'profile';
    return scope;
  };
  const implies = (prior: string, wanted: string): boolean => {
    if (host === 'graph.microsoft.com') return prior === 'Mail.ReadWrite' && wanted === 'Mail.Read'
      || prior === 'Calendars.ReadWrite' && wanted === 'Calendars.Read';
    if (!host.endsWith('.googleapis.com')) return false;
    const prefix = 'https://www.googleapis.com/auth/';
    return prior === prefix + 'calendar' && [prefix + 'calendar.readonly', prefix + 'calendar.events'].includes(wanted)
      || (prior === 'https://mail.google.com/' || prior === prefix + 'gmail.modify')
        && ['gmail.readonly', 'gmail.modify', 'gmail.send'].some(s => wanted === prefix + s)
      || host === 'sheets.googleapis.com' && prior === prefix + 'spreadsheets' && wanted === prefix + 'spreadsheets.readonly';
  };
  return required.every(scope => tracked.some(prior => canonical(prior) === canonical(scope) || implies(canonical(prior), canonical(scope))));
};
const covers = oauthScopesCover;
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
  const migrationAccounts = new Map<string, { expires: number }>();
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
  const publicProfile = (value: ManagedOAuthProfile): ManagedOAuthProfileView => {
    const { api_key: ignored, ...view } = value; void ignored; return view;
  };
  const accountPreview = async (auth: ConnectionAuth | undefined, baseUrl: string,
    selected?: { profile: ManagedOAuthProfile; integration: string; id?: string }): Promise<ManagedOAuthAccountPreview> => {
    const identity = await readManagedOAuthAccountIdentity({ auth, base_url: baseUrl, now: now(),
      fetch: deps.fetchImpl ?? globalThis.fetch.bind(globalThis),
      managedFetch: (value, url, init) => adapter.fetch(profile(value.broker_profile_id), value, url, init) });
    if (selected) return { authentication: 'broker', broker: publicProfile(selected.profile),
      integration_id: selected.integration, ...(selected.id ? { connection_id: selected.id } : {}), identity };
    if (auth?.type !== 'managed_oauth') return { authentication: auth?.type === 'oauth2_refresh' ? 'direct_oauth' : 'token', identity };
    const saved = deps.profiles.get(auth.broker_profile_id);
    return { authentication: 'broker', ...(saved ? { broker: publicProfile(saved) } : {}),
      integration_id: auth.integration_id, connection_id: auth.connection_id, identity };
  };
  const fileSources = deps.fileSources ? createFileSourceAuthentication({ ...deps.fileSources, rows: deps.listConnections,
    brokerSignature: id => { const saved = deps.profiles.list().find(p=>p.id===id);
      return saved ? JSON.stringify([saved.id,saved.revision,saved.base_url]) : undefined; },
    unlock: deps.decodeAuth, managedFetch: (auth, url, init) => adapter.fetch(profile(auth.broker_profile_id), auth, url, init),
    ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}), now }) : undefined;
  const impactFor = async (input: {
    phase: ManagedOAuthImpactPreview['phase']; mode: ManagedOAuthImpactPreview['mode']; consent: 'reuse' | 'request';
    row?: ConnectionRow; old?: ConnectionAuth; profile: ManagedOAuthProfile; integration: string; id?: string;
    targetAuth?: ManagedOAuthAuth; baseUrl: string; members: readonly ConnectionRow[]; membership_known?: boolean;
  }): Promise<ManagedOAuthImpactPreview> => {
    const names = [...new Set([...input.members.map(row => row.name), ...(input.row ? [input.row.name] : [])])];
    const before = managedOAuthImpactSignature(names, deps.connectionUses);
    const current = input.row ? await accountPreview(input.old, input.baseUrl) : undefined;
    const identical = input.old?.type === 'managed_oauth' && input.old.broker_profile_id === input.profile.id
      && input.old.integration_id === input.integration && input.old.connection_id === input.id;
    const target = identical && current ? current : await accountPreview(input.targetAuth, input.baseUrl,
      { profile: input.profile, integration: input.integration, id: input.id });
    if (before !== managedOAuthImpactSignature(names, deps.connectionUses)) throw new RpcError('conflict', 'Local usage changed. Refresh the account and impact preview.');
    const fileSource = input.mode === 'switch' && input.row ? await fileSources?.preview(input.row, input.targetAuth) : undefined;
    return managedOAuthImpact({ ...input,
      ...(fileSource ? { file_source: fileSource } : {}),
      current: current && fileSource ? { ...current, identity: fileSource.current } : current,
      target: fileSource?.target ? { ...target, identity: fileSource.target } : target, read: deps.connectionUses });
  };
  const accountScopes = async (saved: ManagedOAuthProfile, integration: string, id: string, selected?: { identity?: string }) => {
    const snapshot = scopeSnapshot();
    const members: { row: ConnectionRow; auth: ManagedOAuthAuth }[] = [];
    const identities = new Map<string, string>();
    const identity = async (p: ManagedOAuthProfile): Promise<string> => {
      if (p.id === saved.id && selected !== undefined) {
        if (selected.identity === undefined) throw new RpcError('bad_request', 'Nango did not expose a stable identity for this saved account.');
        return selected.identity;
      }
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
    if (flow.impactSnapshot !== undefined && flow.impactSnapshot !== managedOAuthImpactSignature(flow.impactNames ?? [], deps.connectionUses)) {
      throw new RpcError('conflict', 'Local usage changed after review. Refresh the account and impact preview.');
    }
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
    if (flow.switchAuthentication && completed.identity === undefined) throw new RpcError('conflict',
      'Nango did not expose a stable account identity. Refresh accounts and review authorization again.');
    flow.remoteIdentity = completed.identity;
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

  // Preview and start deliberately share discovery and policy. Preview never issues a claim,
  // clears grants, records history, or sends a mutation to the broker.
  const start = async (a: Extract<ManagedOAuthRequest, { action: 'start' | 'preview' }>): Promise<ManagedOAuthResponse> => {
    const readOnly = a.action === 'preview';
    if (!readOnly) prune();
    const accountVersion = accountRevision;
    if (!readOnly && flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
    const initialSnapshot = scopeSnapshot();
    const requested = scopeList(a.scopes);
    if (a.switch_authentication !== undefined && a.switch_authentication !== true) throw new RpcError('bad_request', 'Choose a valid authentication switch.');
    if (a.reauthorize_current !== undefined && (a.reauthorize_current !== true || !a.switch_authentication)) {
      throw new RpcError('bad_request', 'Permission repair requires a verified reauthorization.');
    }
    if (a.force_reauthorization !== undefined && typeof a.force_reauthorization !== 'boolean') throw new RpcError('bad_request', 'Choose a valid reauthorization option.');
    if (a.include_account_impact !== undefined && a.include_account_impact !== true) throw new RpcError('bad_request', 'Choose a valid account and impact preview.');
    const saved = profile(a.profile_id);
    const target = targetOrigin(text(a.base_url, 'Vendor API URL'));
    const row = a.name === undefined ? undefined : deps.listConnections().find((row) => row.kind === 'api' && row.name === a.name);
    if (a.name !== undefined && row === undefined) throw new RpcError('not_found', 'The connection to reauthorize no longer exists.');
    const config = row === undefined ? undefined : JSON.parse(row.config_json) as { base_url?: string; vendor?: string };
    if (a.switch_authentication) {
      if (!row || !Number.isSafeInteger(a.expected_updated_at) || a.expected_updated_at !== row.updated_at) {
        throw new RpcError('conflict', 'The saved connection changed. Reopen it before switching authentication.');
      }
      if (typeof config?.base_url !== 'string' || managedOAuthServerUrl(config.base_url) !== managedOAuthServerUrl(a.base_url)
        || (a.vendor !== undefined && a.vendor !== config.vendor)) throw new RpcError('bad_request', 'Switch authentication keeps the saved vendor API and connection name.');
    }
    const packs = packRequirements(a.switch_authentication ? config?.vendor : a.vendor, a.base_url);
    const integration = await adapter.integration(saved, text(a.integration_id, 'Integration'));
    const old = row === undefined ? undefined : await deps.decodeAuth(row);
    if (a.switch_authentication && (!old || !['oauth2_refresh', 'bearer', 'managed_oauth'].includes(old.type))) {
      throw new RpcError('bad_request', 'Switch authentication supports API connections using OAuth, bearer tokens or a broker account.');
    }
    if (old !== undefined && !a.switch_authentication && (old.type !== 'managed_oauth' || old.broker_profile_id !== saved.id || old.integration_id !== integration.id || old.target_origin !== target)) {
      throw new RpcError('bad_request', 'Reauthorization must keep the saved broker, integration and vendor. Create another connection to change them.');
    }
    const previous = (!a.switch_authentication || a.reauthorize_current) && old?.type === 'managed_oauth' ? old : undefined;
    if (a.reauthorize_current && (old?.type !== 'managed_oauth' || old.broker_profile_id !== saved.id
      || old.integration_id !== integration.id || old.connection_id !== a.connection_id)) {
      throw new RpcError('bad_request', 'Permission repair keeps the saved broker, integration and Nango account.');
    }
    if (a.switch_authentication && !a.reauthorize_current && old?.type === 'managed_oauth' && old.broker_profile_id === saved.id
      && old.integration_id === integration.id && old.connection_id === a.connection_id) {
      throw new RpcError('bad_request', 'Choose another broker account, or use the current connection’s reauthorization flow.');
    }
    if (previous !== undefined && a.connection_id !== undefined && a.connection_id !== previous.connection_id) {
      throw new RpcError('bad_request', 'Reauthorization must keep the saved Nango account.');
    }
    const remoteId = previous?.connection_id ?? (a.connection_id === undefined ? undefined : text(a.connection_id, 'Nango account'));
    const key = remoteId === undefined ? undefined : accountKey(saved.base_url, integration.id, remoteId);
    const assertNotDeleting = (): void => {
      if (key !== undefined && deletingAccounts.has(key)) throw new RpcError('conflict', 'This Nango account is being deleted. Refresh accounts before authorizing.');
    };
    assertNotDeleting();
    if (key !== undefined && ((migrationAccounts.get(key)?.expires ?? 0) > now() || startingAccounts.has(key) || [...flows.values()].some((flow) => flow.remoteId !== undefined
      && flow.expires > now() && accountKey(flow.profile.base_url, flow.integration, flow.remoteId) === key))) {
      throw new RpcError('conflict', 'Authorization for this Nango account is already pending. Complete or cancel it before authorizing again.');
    }
    if (key !== undefined && !readOnly) startingAccounts.add(key);
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
      if (scopeSnapshot() !== initialSnapshot) throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
      const requiredScopes = managedOAuthScopeUnion(requested, packs?.scopes ?? [],
        ...(a.switch_authentication && row ? [requirements(row), old?.type === 'managed_oauth'
          ? old.required_scopes ?? old.requested_scopes : []] : []));
      const needed = managedOAuthScopeUnion(requiredScopes, integration.default_scopes,
        ...(account?.members.filter(m => m.row.name !== row?.name).map(m => managedOAuthScopeUnion(
          m.auth.required_scopes ?? m.auth.requested_scopes, requirements(m.row))) ?? []));
      const granted = managedOAuthScopeUnion(...(account?.grants ?? []));
      const staticGraph = new URL(target).hostname === 'graph.microsoft.com'
        && integration.default_scopes.some((scope) => scope === '.default' || scope.endsWith('/.default'));
      const reuse = remote !== undefined && !remote.auth_error && !a.force_reauthorization && !staticGraph
        && integration.scope_metadata === 'available' && account!.completed !== undefined
        && covers(target, account!.completed, needed);
      const wanted = managedOAuthScopeUnion(requiredScopes, integration.default_scopes,
        account?.required ?? [], account?.requested ?? [], granted);
      // Unknown defaults and Entra's static profile must never be replaced by a union.
      const requestScopes = staticGraph ? [...integration.default_scopes]
        : integration.scope_metadata === 'available' ? authorizationScopes(target, wanted) : [];
      let blocked: string | undefined;
      let blockedCode: 'bad_request' | 'not_configured' = 'bad_request';
      if (!reuse) {
        if (remoteId !== undefined && !account!.known) {
          blocked = 'Recued does not know this account’s previous scopes. Reuse its current authorization, manage consent in Nango with its existing scope profile, or authorize a new account here.';
        } else if (account !== undefined && account.requested.length > 0 && integration.scope_metadata === 'unknown') {
          blocked = 'The broker did not expose its app scopes. Reconnecting could remove previous account permissions. Use a key that can read integration scopes, or manage consent in Nango with the existing scope profile.';
        } else if (!staticGraph && new URL(target).hostname === 'graph.microsoft.com'
          && integration.scope_metadata === 'available'
          && wanted.some(scope => scope === '.default' || scope.endsWith('/.default'))
          && wanted.some(scope => !['openid', 'offline_access', 'profile', 'email'].includes(scope)
            && scope !== '.default' && !scope.endsWith('/.default'))) {
          blocked = 'Do not combine .default with individual Microsoft Graph scopes. Configure a static scope profile in the broker or remove .default from the requested scopes.';
        } else if (account?.members.some(m => m.row.granted_scopes_json !== undefined) && deps.clearGrantedScopes === undefined) {
          blockedCode = 'not_configured';
          blocked = 'The server cannot invalidate shared grant evidence. Upgrade before reauthorizing.';
        }
      }
      const sources: ManagedOAuthPermissionPreview['sources'][number][] = [];
      const source = (kind: ManagedOAuthPermissionPreview['sources'][number]['kind'], label: string, scopes: readonly string[]): void => {
        if (scopes.length) sources.push({ kind, label, scopes: [...scopes] });
      };
      const packSources = (vendor: string | undefined, baseUrl: string, connection?: string): void => {
        if (vendor === undefined) return;
        for (const pack of deps.requiredScopeSources?.(vendor, baseUrl) ?? []) {
          source('pack', `${pack.name} (${pack.slug})${connection ? ` · ${connection}` : ''}`, scopeList(pack.scopes));
        }
      };
      source('request', 'This connection', requested);
      source('integration', 'Broker app defaults', integration.default_scopes);
      source('history', 'Previous requested permissions', account?.requested ?? []);
      if (!reuse) source('grants', 'Previously reported permissions', granted);
      packSources(a.switch_authentication ? config?.vendor : a.vendor, a.base_url);
      for (const member of account?.members ?? []) {
        if (member.row.name === row?.name) continue;
        source('connection', member.row.display_name || member.row.name,
          managedOAuthScopeUnion(member.auth.required_scopes ?? member.auth.requested_scopes, requirements(member.row)));
        const config = JSON.parse(member.row.config_json) as { vendor?: string; base_url?: string };
        if (config.base_url !== undefined) packSources(config.vendor, config.base_url, member.row.display_name || member.row.name);
      }
      const warnings = ['Requested permissions are not proof of vendor-granted access.'];
      if (staticGraph) warnings.push('This Microsoft app uses a fixed .default profile. Additional permissions must be configured in the broker app and may need administrator consent.');
      else if (integration.scope_metadata === 'unknown') warnings.push('The broker did not expose its app scopes. Its existing scope profile will be preserved; additional permissions may need an app change in Nango.');
      if (remote?.auth_error) warnings.push('This account needs sign-in again to repair its authorization.');
      const effective = reuse ? account!.requested : requestScopes;
      const impactNames = [...new Set([...(account?.members.map(m => m.row.name) ?? []), ...(row ? [row.name] : [])])];
      const impactSnapshot = a.include_account_impact ? managedOAuthImpactSignature(impactNames, deps.connectionUses) : undefined;
      const accountImpact = a.include_account_impact ? await impactFor({ phase: 'before_authorization',
        mode: a.switch_authentication ? 'switch' : row ? 'reauthorize' : 'create', consent: reuse ? 'reuse' : 'request',
        row, old, profile: saved, integration: integration.id, id: remoteId, baseUrl: a.base_url,
        members: account?.members.map(m => m.row) ?? [], membership_known: remoteId === undefined ? undefined : account?.remoteIdentity !== undefined,
        targetAuth: remoteId === undefined ? undefined : { type: 'managed_oauth', broker_profile_id: saved.id,
          integration_id: integration.id, connection_id: remoteId, target_origin: target, requested_scopes: [] } }) : undefined;
      if (impactSnapshot !== undefined && impactSnapshot !== managedOAuthImpactSignature(impactNames, deps.connectionUses)) {
        throw new RpcError('conflict', 'Local usage changed. Refresh the account and impact preview.');
      }
      assertPackRequirements(packs);
      if (scopeSnapshot() !== initialSnapshot) throw new RpcError('conflict', 'Connections or scope requirements changed. Refresh before authorizing.');
      assertNotDeleting();
      const preview: ManagedOAuthPermissionPreview = {
        fingerprint: '', decision: blocked ? 'blocked' : reuse ? 'reuse' : remoteId === undefined ? 'authorize' : 'reconnect',
        ...(accountImpact ? { account_impact: accountImpact } : {}),
        scope_metadata: staticGraph ? 'fixed' : integration.scope_metadata,
        required_scopes: requiredScopes, previous_scopes: account?.requested ?? [], sources, warnings,
        ...(integration.scope_metadata === 'unknown' ? {} : { requested_scopes: effective,
          added_scopes: effective.filter(scope => !covers(target, account?.requested ?? [], [scope])),
          retained_scopes: effective.filter(scope => !covers(target, requiredScopes, [scope])) }),
        ...(blocked === undefined ? {} : { blocked_reason: blocked }),
      };
      // A fingerprint carries no authority. Start recomputes it from current local and broker state.
      preview.fingerprint = createHash('sha256').update(JSON.stringify([
        preview, initialSnapshot, accountVersion, saved.id, saved.revision, integration, target,
        a.base_url, a.vendor, row?.name, remoteId, remote?.auth_error, account?.remoteIdentity, !!a.force_reauthorization,
        !!a.switch_authentication, a.expected_updated_at,
      ])).digest('hex');
      if (readOnly) return { action: 'preview', preview };
      if (a.switch_authentication && a.preview_fingerprint === undefined) throw new RpcError('bad_request',
        'Review permissions before authorizing an authentication switch.');
      if (a.preview_fingerprint !== undefined && (typeof a.preview_fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(a.preview_fingerprint)
        || !same(a.preview_fingerprint, preview.fingerprint))) {
        throw new RpcError('conflict', 'Permissions changed after review. Review permissions again before authorizing.');
      }
      if (blocked !== undefined) throw new RpcError(blockedCode, blocked);
      if (reuse) {
        const flowId = nonce(); const receipt = nonce();
        const { api_key: ignored, ...view } = saved; void ignored;
        // Completed requests avoid duplicate consent; they never prove vendor grants.
        const flow: Flow = { claim: nonce(), expires: now() + 10 * 60_000, profile: view,
          baseUrl: a.base_url, impactConsent: 'reuse', ...(impactSnapshot ? { impactNames, impactSnapshot } : {}),
          integration: integration.id, target, scopes: account!.requested, requiredScopes,
          packRequirements: packs,
          snapshot: account!.snapshot, remoteId, remoteIdentity: account!.remoteIdentity, busy: false,
          ...(a.switch_authentication ? { switchAuthentication: true as const } : {}),
          ...(row === undefined ? {} : { name: row.name, revision: row.updated_at, row_fingerprint: connectionFingerprint(row) }) };
        const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: saved.id, integration_id: integration.id,
          connection_id: remote.id, target_origin: target, requested_scopes: flow.scopes, required_scopes: requiredScopes,
          ...(account!.known ? {} : { imported: true as const }), authorization_receipt: receipt };
        flow.auth = auth; assertCurrent(flow);
        prune();
        if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
        flows.set(flowId, flow); receipts.set(receipt, { flow, expires: flow.expires });
        return { action: 'reuse', flow_id: flowId, claim_secret: flow.claim, auth, expires_at: flow.expires, impact_available: true };
      }
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
        baseUrl: a.base_url, impactConsent: 'request', ...(impactSnapshot ? { impactNames, impactSnapshot } : {}),
        integration: integration.id, target, scopes: requestScopes, requiredScopes, busy: false,
        packRequirements: packs,
        ...(a.switch_authentication ? { switchAuthentication: true as const } : {}),
        ...(snapshot === undefined ? {} : { snapshot }),
        ...(remoteId === undefined ? {} : { remoteId }),
        ...(row === undefined ? {} : { name: row.name, revision: row.updated_at, row_fingerprint: connectionFingerprint(currentRow!) }) };
      assertCurrent(flow);
      prune();
      if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many OAuth authorizations are pending. Cancel one or wait for it to expire.');
      flows.set(flowId, flow);
      return { action: 'start', flow_id: flowId, claim_secret: claim, connect_link: link.connect_link, impact_available: true,
        expires_at: flow.expires, requested_scopes: requestScopes, scope_metadata: staticGraph ? 'fixed' : integration.scope_metadata };
    } finally { if (key !== undefined && !readOnly) startingAccounts.delete(key); }
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
    const flow: Flow = { claim: nonce(), expires: now() + 10 * 60_000, profile: view, baseUrl: a.base_url, impactConsent: 'reuse',
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
    return { action: 'attach', flow_id: flowId, claim_secret: flow.claim, auth, expires_at: flow.expires, impact_available: true };
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
      impact_available: true, ...(flow.grantedScopes === undefined ? {} : { granted_scopes: flow.grantedScopes }) };
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
      return { action: 'status', status: 'authorized', auth, impact_available: true };
    } finally { flow.busy = false; }
  };

  const accountUsage = async (a: Extract<ManagedOAuthRequest, { action: 'account_usage' }>): Promise<ManagedOAuthResponse> => {
    const saved = profile(a.profile_id); const integration = text(a.integration_id, 'Integration');
    const id = text(a.connection_id, 'Nango account'); const revision = accountRevision;
    const key = accountKey(saved.base_url, integration, id);
    if (deletingAccounts.has(key)) throw new RpcError('conflict', 'This Nango account is being deleted. Refresh accounts.');
    const remote = await adapter.accountSnapshot(saved, integration, id);
    if (deletingAccounts.has(key)) throw new RpcError('conflict', 'This Nango account is being deleted. Refresh accounts.');
    const account = await accountScopes(saved, integration, id, remote);
    if (profile(saved.id).revision !== saved.revision || revision !== accountRevision || deletingAccounts.has(key)) {
      throw new RpcError('conflict', 'The broker or accounts changed. Refresh account usage.');
    }
    const current = deps.listConnections();
    const connections = account.members.map(({ row }) => managedOAuthConnectionUsage(
      current.find(candidate => candidate.pk === row.pk) ?? row, now(), deps.connectionUses?.(row.name)));
    const warnings = ['Usage covers this Recued server. Other tools may also use this Nango account.'];
    if (connections.some(connection => !connection.usage_available)) warnings.push('Some local usage could not be read. Open the connection to review its bindings.');
    if (account.remoteIdentity === undefined) warnings.push('Nango did not expose a stable account identity. Usage is limited to this broker profile.');
    return { action: 'account_usage', usage: { connection_id: id, auth_error: remote.connection.auth_error,
      connections: connections.sort((a, b) => a.name.localeCompare(b.name)), warnings } };
  };

  const completedImpact = async (flow: Flow): Promise<ManagedOAuthImpactPreview> => {
    assertCurrent(flow);
    if (!flow.auth || flow.expires <= now()) throw new RpcError('conflict', 'Authorization expired. Review it again before checking the account.');
    const saved = profile(flow.profile.id);
    const remote = await adapter.accountSnapshot(saved, flow.integration, flow.auth.connection_id);
    if (remote.connection.auth_error || flow.remoteIdentity !== undefined && remote.identity !== flow.remoteIdentity) {
      throw new RpcError('conflict', 'The broker account changed after authorization. Review it again.');
    }
    const account = await accountScopes(saved, flow.integration, flow.auth.connection_id, remote);
    const row = flow.name ? deps.listConnections().find(r => r.kind === 'api' && r.name === flow.name) : undefined;
    const old = row ? await deps.decodeAuth(row) : undefined;
    const impact = await impactFor({ phase: 'before_save', mode: flow.switchAuthentication ? 'switch' : row ? 'reauthorize' : 'create',
      consent: flow.impactConsent ?? 'reuse', row, old, profile: saved, integration: flow.integration, id: flow.auth.connection_id,
      targetAuth: flow.auth, baseUrl: flow.baseUrl ?? flow.target, members: account.members.map(m => m.row), membership_known: remote.identity !== undefined });
    const after = await adapter.accountSnapshot(saved, flow.integration, flow.auth.connection_id);
    assertCurrent(flow);
    if (after.identity !== remote.identity || after.connection.auth_error) throw new RpcError('conflict', 'The broker account changed while checking its impact. Review it again.');
    return impact;
  };
  const migrationCandidates = async (names?: readonly string[]): Promise<ManagedOAuthMigrationCandidate[]> => {
    const candidates: ManagedOAuthMigrationCandidate[] = [];
    for (const row of deps.listConnections().filter(r => r.kind === 'api')) {
      if (names && !names.includes(row.name)) continue;
      try {
        const auth = await deps.decodeAuth(row);
        if (!['managed_oauth', 'oauth2_refresh', 'bearer'].includes(auth.type)) continue;
        const config = JSON.parse(row.config_json) as { base_url?: string; vendor?: string };
        if (typeof config.base_url !== 'string') continue;
        const base = managedOAuthServerUrl(config.base_url);
        candidates.push({ name: row.name, display_name: row.display_name || row.name, updated_at: row.updated_at,
          base_url: base, ...(config.vendor ? { vendor: config.vendor } : {}),
          authentication: auth.type === 'managed_oauth' ? 'broker' : auth.type === 'oauth2_refresh' ? 'direct_oauth' : 'token',
          required_scopes: managedOAuthScopeUnion(requirements(row), auth.type === 'managed_oauth' ? auth.required_scopes ?? auth.requested_scopes
            : auth.type === 'oauth2_refresh' ? auth.required_scopes ?? [] : []),
          verification_url: managedOAuthDefaultVerificationUrl(base),
          ...(names ? { current: await accountPreview(auth, base) } : {}) });
      } catch { /* Invalid or unsupported saved credentials cannot join a migration. */ }
    }
    return candidates.sort((a, b) => a.name.localeCompare(b.name));
  };
  const migrationSignature = (names: readonly string[]): string => createHash('sha256').update(JSON.stringify([
    managedOAuthImpactSignature(names, deps.connectionUses), names.map(name => {
      const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
      return [name, row ? requirements(row) : null];
    }).sort(), deps.profiles.scopeHistorySignature(), deps.profiles.list().map(p => [p.id, p.revision]).sort(),
  ])).digest('hex');
  const directMigrationSignature = (names: readonly string[]): string => createHash('sha256').update(JSON.stringify([
    managedOAuthImpactSignature(names, deps.connectionUses), names.map(name => {
      const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
      return [name, row ? requirements(row) : null];
    }).sort(),
  ])).digest('hex');
  const previewDirectImpact: NonNullable<ManagedOAuthService['previewDirectImpact']> = async (name, auth, members = []) => {
    const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
    if (!row) throw new RpcError('conflict', 'The connection changed. Review it again.');
    const base = String(JSON.parse(row.config_json).base_url ?? '');
    const names = [...new Set([name, ...members])];
    const signature = directMigrationSignature(names);
    const current = await accountPreview(await deps.decodeAuth(row), base);
    const target = await accountPreview(auth, base);
    if (signature !== directMigrationSignature(names)) throw new RpcError('conflict', 'Local usage changed. Review the impact again.');
    const fileSource = await fileSources?.preview(row, auth);
    return managedOAuthImpact({ phase: 'before_save', mode: 'switch', consent: 'reuse', row,
      current: fileSource ? { ...current, identity: fileSource.current } : current,
      target: fileSource?.target ? { ...target, identity: fileSource.target } : target, ...(fileSource ? { file_source: fileSource } : {}),
      members: deps.listConnections().filter(r => r.kind === 'api' && members.includes(r.name)), read: deps.connectionUses });
  };
  const claimMigration: NonNullable<ManagedOAuthService['claimMigration']> = async (auth, names) => {
    const receipt = auth.authorization_receipt ? receipts.get(auth.authorization_receipt) : undefined;
    const source = receipt?.flow;
    if (!source?.auth || !source.switchAuthentication || !source.remoteIdentity || names.length === 0
      || names.length > MANAGED_OAUTH_MIGRATION_LIMIT || source.name !== names[0] || new Set(names).size !== names.length) {
      throw new RpcError('bad_request', 'Review authorization for the first selected connection before preparing this migration.');
    }
    const rows = names.map(name => deps.listConnections().find(r => r.kind === 'api' && r.name === name));
    if (rows.some(r => !r)) throw new RpcError('conflict', 'A selected connection is no longer available.');
    const candidates = await migrationCandidates();
    const selected = names.map(name => candidates.find(c => c.name === name));
    if (selected.some(c => !c || c.base_url !== source.baseUrl || c.vendor !== selected[0]?.vendor
      || c.required_scopes.some(scope => !source.requiredScopes?.includes(scope)))) {
      throw new RpcError('conflict', 'Review all selected permission needs for one vendor API before migrating.');
    }
    const first = rows[0]!;
    const saved = authorizeForSave(auth, source.baseUrl!, first.name, first, { consume: false, switchAuthentication: true });
    await verifySwitchAccount(auth);
    if (receipts.get(auth.authorization_receipt!) !== receipt) throw new RpcError('conflict', 'Authorization was retired during migration review.');
    const key = accountKey(source.profile.base_url, source.integration, auth.connection_id);
    if ((migrationAccounts.get(key)?.expires ?? 0) > now()) throw new RpcError('conflict', 'Another migration uses this broker account.');
    const allowed = new Map(rows.map(row => [row!.name, connectionFingerprint(row!)]));
    const rowScopes = new Map(selected.map(c => [c!.name, [...c!.required_scopes]]));
    const expires = now() + 30 * 60_000; const issued = new Map<string, Flow>(); let closed = false;
    const reservation = { expires }; migrationAccounts.set(key, reservation); saved.consume();
    const retire = (id: string, flow: Flow): void => {
      flows.delete(id); issued.delete(id);
      if (flow.auth?.authorization_receipt) receipts.delete(flow.auth.authorization_receipt);
    };
    const allNames = [...new Set([...names, ...(source.impactNames ?? [])])];
    return { expires_at: expires, names: allNames, signature: migrationSignature(allNames),
      close: () => { closed = true; if (migrationAccounts.get(key) === reservation) migrationAccounts.delete(key); for (const [id, flow] of issued) retire(id, flow); },
      issue: async name => {
        if (closed || now() >= expires) throw new RpcError('conflict', 'This migration review expired. Review the remaining connections again.');
        const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
        if (!row || connectionFingerprint(row) !== allowed.get(name) || profile(source.profile.id).revision !== source.profile.revision) {
          throw new RpcError('conflict', 'The selected connection or broker changed after migration review.');
        }
        prune();
        if (flows.size + receipts.size >= 128) throw new RpcError('conflict', 'Too many authorizations are pending.');
        const id = nonce(); const receiptId = nonce();
        const flow: Flow = { claim: nonce(), expires: Math.min(expires, now() + 10 * 60_000), profile: source.profile,
          integration: source.integration, target: source.target, scopes: [...source.scopes], requiredScopes: rowScopes.get(name),
          remoteId: auth.connection_id, remoteIdentity: source.remoteIdentity, name, revision: row.updated_at,
          row_fingerprint: connectionFingerprint(row), snapshot: scopeSnapshot(), busy: false, switchAuthentication: true,
          baseUrl: source.baseUrl, impactConsent: 'reuse', packRequirements: packRequirements(selected[0]?.vendor, source.baseUrl!) };
        flow.auth = { ...saved.auth, required_scopes: flow.requiredScopes, authorization_receipt: receiptId };
        flows.set(id, flow); issued.set(id, flow); receipts.set(receiptId, { flow, expires: flow.expires });
        try {
          const impact = await completedImpact(flow);
          if (closed || now() >= expires || flows.get(id) !== flow) throw new RpcError('conflict', 'Migration was stopped during account review.');
          flow.impactNames = impact.connections.map(c => c.name);
          flow.impactSnapshot = managedOAuthImpactSignature(flow.impactNames, deps.connectionUses);
          return { auth: flow.auth, impact, retire: () => retire(id, flow) };
        } catch (error) { retire(id, flow); throw error; }
      },
    };
  };
  const handle = async (a: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (a === null || typeof a !== 'object') throw new RpcError('bad_request', 'Managed OAuth request is required.');
    if (a.action !== 'preview' && a.action !== 'account_usage') prune();
    switch (a.action) {
      case 'account_usage': return accountUsage(a);
      case 'file_authentication_files': {
        if (!fileSources) throw new RpcError('not_configured','File-source authentication migration is unavailable on this server.');
        return {action:a.action,choices:await fileSources.files(text(a.name,'Saved file connection'),a.expected_updated_at,a.query,a.after)};
      }
      case 'file_authentication_prepare': {
        const name = text(a.name, 'Saved file connection');
        const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
        if (!row || row.updated_at !== a.expected_updated_at) throw new RpcError('conflict', 'The saved file connection changed. Refresh and retry.');
        if (!fileSources) throw new RpcError('not_configured', 'File-source authentication migration is unavailable on this server.');
        const file_source = await fileSources.prepare(name, a.expected_updated_at, a.verification_file_id);
        const current = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
        if (!current) throw new RpcError('conflict', 'The saved file connection was removed.');
        return { action: a.action, name, updated_at: current.updated_at, file_source };
      }
      case 'preview': return start(a);
      case 'profiles': return { action: 'profiles', profiles: deps.profiles.list() };
      case 'account_impact': {
        const flow = flows.get(text(a.flow_id, 'Authorization flow'));
        if (!flow || !same(flow.claim, text(a.claim_secret, 'Authorization claim'))) throw new RpcError('conflict', 'The authorization claim is unavailable. Review authorization again.');
        const impact = await completedImpact(flow);
        if (flows.get(a.flow_id) !== flow || flow.expires <= now()) throw new RpcError('conflict', 'The authorization was retired while reading its impact.');
        return { action: 'account_impact', impact };
      }
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

  const authorizeForSave: ManagedOAuthService['authorizeForSave'] = (auth, baseUrl, name, existing, options) => {
    prune();
    const receipt = auth.authorization_receipt === undefined ? undefined : receipts.get(auth.authorization_receipt);
    if (receipt === undefined) throw new RpcError('bad_request', 'Authorize this managed OAuth connection before saving.');
    const flow = receipt.flow;
    if (flow.switchAuthentication !== options?.switchAuthentication) throw new RpcError('bad_request',
      'Use the reviewed authentication switch and verify API access before applying this authorization.');
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
    const receiptId = auth.authorization_receipt!;
    const consume = (): void => {
      receipts.delete(receiptId);
      for (const [id, value] of flows) if (value === flow) flows.delete(id);
    };
    if (options?.consume !== false) consume();
    const { authorization_receipt: ignored, ...stored } = expected; void ignored;
    return { auth: stored, consume, ...(flow.grantedScopes === undefined ? {} : { granted_scopes: flow.grantedScopes }) };
  };

  /** Public-row identity must still match the reviewed account around the native resource check. */
  const verifySwitchAccount = async (auth: ManagedOAuthAuth): Promise<void> => {
    prune(); const receipt = auth.authorization_receipt === undefined ? undefined : receipts.get(auth.authorization_receipt);
    const flow = receipt?.flow;
    if (!flow?.switchAuthentication || !flow.remoteIdentity || flow.auth?.connection_id !== auth.connection_id) {
      throw switchAccountRefused('The reviewed Nango account cannot be verified. Review authorization again.');
    }
    assertCurrent(flow);
    let remote: Awaited<ReturnType<typeof adapter.accountSnapshot>>;
    try { remote = await adapter.accountSnapshot(profile(flow.profile.id), flow.integration, auth.connection_id); }
    catch (error) {
      if (error instanceof RpcError && error.code === 'broker_unavailable') throw switchAccountRefused('The Nango account check could not be reached. Try again.', true);
      throw switchAccountRefused('The Nango account changed or cannot be verified. Refresh accounts and review authorization again.');
    }
    prune(); assertCurrent(flow);
    if (receipts.get(auth.authorization_receipt!) !== receipt || remote.identity !== flow.remoteIdentity || remote.connection.auth_error) {
      throw switchAccountRefused('The Nango account changed after authorization. Refresh accounts and review authorization again.');
    }
  };

  return {
    handle, authorizeForSave, verifySwitchAccount, migrationCandidates, migrationSignature, claimMigration,
    isFileSourceSwitch: name => fileSources?.supported(name) ?? false,
    assertFileSourceSwitchCurrent: name => { fileSources?.assertCurrent(name); },
    verifyFileSourceSwitch: async (name, auth) => {
      const row = deps.listConnections().find(r => r.kind === 'api' && r.name === name);
      if (!row) throw new RpcError('conflict', 'The saved connection was removed.');
      const checked = await fileSources?.preview(row, auth);
      return checked?.status === 'verified' ? { status: 'ok', last_probed_at: now() } : undefined;
    },
    directMigrationSignature, previewDirectImpact,
    reauthorizationScopes: name => {
      const row = deps.listConnections().find(row => row.kind === 'api' && row.name === name);
      if (!row) throw new RpcError('not_found', 'The connection to reauthorize no longer exists.');
      return requirements(row);
    },
    verifyImpact: async (auth, fingerprint) => {
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new RpcError('bad_request', 'Review the account and impact before saving.');
      const receipt = auth.authorization_receipt ? receipts.get(auth.authorization_receipt) : undefined;
      const flow = receipt?.flow;
      if (!flow?.auth || flow.auth.connection_id !== auth.connection_id) throw new RpcError('conflict', 'Authorization is no longer current. Review it again.');
      const impact = await completedImpact(flow);
      if (receipts.get(auth.authorization_receipt!) !== receipt) throw new RpcError('conflict', 'Authorization was retired while checking its impact.');
      if (impact.fingerprint !== fingerprint) throw new RpcError('conflict', 'The account or its local usage changed. Review the impact again before saving.');
      flow.impactNames = impact.connections.map(c => c.name);
      flow.impactSnapshot = managedOAuthImpactSignature(flow.impactNames, deps.connectionUses);
    },
    collectionProfileSignature: id => { const p = profile(id);
      return createHash('sha256').update(JSON.stringify([p.id, p.broker, p.base_url])).digest('hex'); },
    diagnosticProfileSignature: () => JSON.stringify(deps.profiles.list().map(p => [p.id, p.revision]).sort()),
    inspectAccount: async (auth) => {
      const saved = profile(auth.broker_profile_id);
      const remote = await adapter.accountSnapshot(saved, auth.integration_id, auth.connection_id);
      if (profile(auth.broker_profile_id).revision !== saved.revision) throw new RpcError('conflict', 'The broker profile changed during the access check.');
      return { identity: remote.identity, profile_revision: saved.revision, auth_error: remote.connection.auth_error };
    },
    fetch: (auth, target, init) => {
    let saved: ManagedOAuthProfile;
    try { saved = profile(auth.broker_profile_id); }
    catch { throw new IngredientError('CONNECTION_REFUSED', 'The managed OAuth broker profile is unavailable. Check it in Connections.'); }
    return adapter.fetch(saved, auth, target, init);
  } };
};
