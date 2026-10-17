/** Passive authentication inventory. No refresh, probe, consent or status writes. */
import { createHash } from 'node:crypto';
import { oauthAppSecretExpiry, RpcError,
  type AuthenticationRepairWorklist, type AuthenticationRepairGroup, type AuthenticationRepairIssueCode, type AuthenticationRepairTarget,
  type ConnectionAuth, type ConnectionRow, type ManagedOAuthConnectionUse, type SavedOAuthApp, type SourceRegistration, type CollectionHealth, type CollectionAuthenticationProvider } from '@recued/contracts';
import type { CollectionInstanceRecord } from './collections/instance-store.js';
import type { FileSourceSyncState } from './storage/file-source-sync-state.js';
import { collectionOAuthBinding, collectionOAuthServiceBase } from './collection-oauth-sources.js';
import { managedOAuthConnectionUsage } from './managed-oauth-account-usage.js';
import { sourceIdConnectionName } from './work-entity-source-boot.js';
import { connectionAccessAuthority, isConnectionAccessKey, readConnectionAccessEvidence } from './connection-access-evidence.js';
import { authenticationConnectionGroupKey, authenticationCollectionGroupKey } from './authentication-group-identity.js';

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v) ? v : undefined;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const jsonRecord = (v: string | undefined): Record<string, unknown> => { try { return record(JSON.parse(v ?? '{}')); } catch { return {}; } };
const time = (v: unknown, now: number): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= now ? v : undefined;
export interface AuthenticationRepairDeps {
  connections(): readonly ConnectionRow[];
  decode(row: ConnectionRow): Promise<ConnectionAuth>;
  instances?(): readonly CollectionInstanceRecord[];
  /** A local adapter getter, never a vendor probe. */
  health?(platform: 'mail' | 'calendar', slug: string): CollectionHealth | undefined;
  sources?(): readonly SourceRegistration[];
  fileState?(id: string): FileSourceSyncState | null;
  apps?(): readonly SavedOAuthApp[];
  /** Local profile validation only. Never discovers or contacts a broker. */
  brokerProfileSignature?(id: string): string | undefined;
  connectionUses?(name: string): { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean };
  now?(): number;
}
const collectionServiceMatches = (provider: CollectionAuthenticationProvider | undefined, saved: ConnectionRow, binding: Record<string, unknown>): boolean => {
  if (!provider) return false;
  try {
    const base = record(JSON.parse(saved.config_json)).base_url;
    if (typeof base !== 'string') return false;
    const expected = collectionOAuthServiceBase(provider);
    if (binding.target_origin !== new URL(expected).origin) return false;
    // Typed migration bindings pin the exact service. Older broker bindings
    // retain the provider/origin rules used by managed-oauth-consumers.
    return binding.type === undefined ? new URL(base).origin === new URL(expected).origin
      && (provider !== 'gcal' || /^\/calendar(?:\/|$)/.test(new URL(base).pathname)) : base.replace(/\/+$/, '') === expected;
  } catch { return false; }
};
/** Private evidence for the alert worker. A cleared issue alone is not proof
 * of recovery: an edit, missing inventory or a new credential can clear it. */
export interface AuthenticationRepairCheck {
  id: string;
  group_id: string;
  state: 'failed' | 'succeeded' | 'unknown';
  observed_at?: number;
  /** API method/resource identity. Other collection checks are already
   * identified by their saved account or source and need no extra context. */
  context?: string;
}
export interface AuthenticationRepairSnapshot {
  worklist: AuthenticationRepairWorklist;
  checks: AuthenticationRepairCheck[];
}
/** Issue IDs retain their local origin without adding identifiers or private
 * evidence to the public worklist. Use the same encoding to choose its repair. */
export const authenticationRepairTargetHasIssue = (group: AuthenticationRepairGroup, target: AuthenticationRepairTarget,
  issues: AuthenticationRepairGroup['issues'] = group.issues): boolean => {
  const origins: unknown[] = target.kind === 'connection' ? [target.name, ['api-history', target.name]]
    : target.kind === 'collection' ? [[target.platform, target.slug], ['runtime', target.platform, target.slug]]
    : target.kind === 'file_source' ? [target.source_id] : [];
  return issues.some(issue => origins.some(origin => issue.id === hash([group.id, issue.code, origin])));
};
export const createAuthenticationRepairSnapshot = (deps: AuthenticationRepairDeps) => async (): Promise<AuthenticationRepairSnapshot> => {
  const unavailable = new Set<string>();
  const read = <T>(get: (() => readonly T[]) | undefined, label: string): readonly T[] => {
    if (!get) { unavailable.add(label); return []; }
    try { const values = get(); if (values.length > 512) throw new Error('limit'); return values; }
    catch { unavailable.add(label); return []; }
  };
  let rows = read(() => deps.connections().filter(r => r.kind === 'api'), 'Saved connection status is unavailable.');
  // Health and last-use observations can change during asynchronous vault
  // reads. Freeze definitions first, then project the latest observations.
  const definitions = (values: readonly ConnectionRow[]) => hash(values.map(({ health_json: _health, last_used_at: _used, ...definition }) => definition));
  const initialDefinitions = definitions(rows);
  const auths = new Map<string, ConnectionAuth>();
  const profileSignatures = new Map<string, string | undefined>();
  const readProfileSignature = (id: string): string | undefined => {
    try { return deps.brokerProfileSignature?.(id); } catch { return undefined; }
  };
  const profileSignature = (id: string): string | undefined => {
    if (!profileSignatures.has(id)) {
      const value = readProfileSignature(id); profileSignatures.set(id, value);
      if (value === undefined) unavailable.add('Some broker profile status could not be read.');
    }
    return profileSignatures.get(id);
  };
  for (const row of rows) {
    try {
      const auth = await deps.decode(row); auths.set(row.name, auth);
      if (auth.type === 'managed_oauth') profileSignature(auth.broker_profile_id);
    } catch { unavailable.add('Some credential details could not be read. Unlock Recued or review the saved connection.'); }
  }
  if (!unavailable.has('Saved connection status is unavailable.')) {
    rows = read(() => deps.connections().filter(r => r.kind === 'api'), 'Saved connection status is unavailable.');
    if (!unavailable.has('Saved connection status is unavailable.') && definitions(rows) !== initialDefinitions) {
      throw new RpcError('conflict', 'Saved accounts changed while reading authentication repairs. Refresh the worklist.');
    }
  }
  const now = (deps.now ?? Date.now)();
  const instances = read(deps.instances, 'Mail and Calendar status is unavailable.').filter(r => r.platform === 'mail' || r.platform === 'calendar');
  const sources = read(deps.sources, 'File-source status is unavailable.').filter(r => r.top_tier_kind === 'file' && r.source_kind === 'connection');
  const apps = read(deps.apps, 'Saved OAuth app status is unavailable.');
  const groups = new Map<string, AuthenticationRepairGroup>(); const byName = new Map<string, AuthenticationRepairGroup>();
  const checks = new Map<string, AuthenticationRepairCheck>();
  const savedByName = new Map(rows.map(row => [row.name, row]));
  const connectionsAvailable = !unavailable.has('Saved connection status is unavailable.');
  const group = (key: string, label: string, authentication: AuthenticationRepairGroup['authentication'], kind: 'account' | 'app' = 'account') => {
    let found = groups.get(key);
    if (!found) { found = { id: hash(key), kind, label, authentication, connection_names: [], issues: [], uses: [], usage_available: true, targets: [] }; groups.set(key, found); }
    return found;
  };
  const use = (g: AuthenticationRepairGroup, u: ManagedOAuthConnectionUse): void => {
    if (g.uses.length >= 10000) { g.usage_available = false; return; }
    if (!g.uses.some(old => old.kind === u.kind && old.id === u.id)) g.uses.push(u);
  };
  const target = (g: AuthenticationRepairGroup, t: AuthenticationRepairTarget): void => {
    if (!g.targets.some(old => JSON.stringify(old) === JSON.stringify(t))) g.targets.push(t);
  };
  const issue = (g: AuthenticationRepairGroup, code: AuthenticationRepairIssueCode, message: string, origin: unknown, at?: number): void => {
    const id = hash([g.id, code, origin]);
    if (!g.issues.some(i => i.id === id)) g.issues.push({ id, code, message, ...(at === undefined ? {} : { observed_at: at }) });
    checks.set(id, { id, group_id: g.id, state: 'failed', ...(at === undefined ? {} : { observed_at: at }) });
  };
  const success = (g: AuthenticationRepairGroup, code: AuthenticationRepairIssueCode, origin: unknown, at: unknown): void => {
    const id = hash([g.id, code, origin]); const verified = time(at, now);
    if (checks.get(id)?.state === 'failed') return;
    checks.set(id, { id, group_id: g.id, state: verified === undefined ? 'unknown' : 'succeeded',
      ...(verified === undefined ? {} : { observed_at: verified }) });
  };
  for (const row of rows) {
    const auth = auths.get(row.name);
    // A native grant ID is server-owned. Never group unrelated connections by email, client ID or app ID.
    const g = group(authenticationConnectionGroupKey(row, auth), text(row.display_name) ?? row.name, auth?.type === 'oauth2_refresh' ? 'direct_oauth'
      : auth?.type === 'managed_oauth' ? 'broker' : auth ? 'other' : 'unknown');
    if (auth?.type === 'managed_oauth' && profileSignature(auth.broker_profile_id) === undefined) issue(g, 'access_unconfirmed',
      'The saved broker profile could not be read. Unlock Recued or review this connection’s broker settings.', ['profile', auth.broker_profile_id]);
    g.connection_names.push(row.name); byName.set(row.name, g); target(g, { kind: 'connection', name: row.name });
    try { const references = deps.connectionUses?.(row.name); g.usage_available &&= references?.complete ?? false;
      for (const u of references?.uses ?? []) if (text(u.id) && text(u.label)) use(g, u); }
    catch { g.usage_available = false; }
    const health = managedOAuthConnectionUsage(row, now).health;
    // Only a completed API operation or an authenticated vendor probe writes
    // this marker. A generic public-root HEAD must never close an auth alert.
    const storedHealth = jsonRecord(row.health_json);
    const verified = storedHealth.status === 'ok' && time(storedHealth.last_probed_at, now) !== undefined
      && typeof storedHealth.access_verified_at === 'number' && storedHealth.access_verified_at <= Number(storedHealth.last_probed_at)
      ? time(storedHealth.access_verified_at, now) : undefined;
    success(g, 'credential_rejected', row.name, verified);
    success(g, 'access_unconfirmed', row.name, verified);
    if (auth?.type === 'managed_oauth' && profileSignature(auth.broker_profile_id) !== undefined) {
      success(g, 'access_unconfirmed', ['profile', auth.broker_profile_id], verified);
    }
    if (health.status === 'auth_failed') issue(g, 'credential_rejected', row.name + ': the last connection check rejected the saved authentication.', row.name, time(health.last_probed_at, now));
    else if (health.permissions_unverified) issue(g, 'access_unconfirmed', row.name + ': the last connection check could not confirm vendor permissions.', row.name, time(health.last_probed_at, now));
    else if (health.status === 'unreachable') issue(g, 'access_unconfirmed', row.name + ': the last check could not reach the service. An authentication cause is unconfirmed.', row.name, time(health.last_probed_at, now));
    // Preserve per-resource recovery proofs through later unrelated calls.
    // Scalar health still describes the latest call; these private records
    // retain access failures which that call could not have verified.
    const base = jsonRecord(row.config_json).base_url;
    let evidence: ReturnType<typeof readConnectionAccessEvidence> = { checks: [], complete: true };
    if (auth && typeof base === 'string') {
      try { evidence = readConnectionAccessEvidence(row.health_json, connectionAccessAuthority(auth, base)); }
      catch { evidence.complete = false; }
    }
    const failed = evidence.checks.filter(check => check.status !== 'ok' && time(check.at, now) !== undefined);
    for (const code of ['credential_rejected', 'access_unconfirmed'] as const) {
      const failures = failed.filter(check => code === 'credential_rejected' ? check.status === 'auth_failed' : check.status === 'unreachable');
      if (failures.length) issue(g, code, row.name + (code === 'credential_rejected'
        ? ': a recorded API check or operation rejected access. That resource has not passed a matching access check.'
        : ': a recorded API resource check failed. A service or network cause is unconfirmed.'), row.name, Math.max(...failures.map(check => check.at)));
      const id = hash([g.id, code, row.name]);
      const context = isConnectionAccessKey(storedHealth.access_check_key) ? storedHealth.access_check_key : undefined;
      const current = context ? { id, group_id: g.id, context,
        state: (health.status === (code === 'credential_rejected' ? 'auth_failed' : 'unreachable') ? 'failed' : verified === undefined ? 'unknown' : 'succeeded') as AuthenticationRepairCheck['state'],
        ...(verified !== undefined ? { observed_at: verified }
          : time(health.last_probed_at, now) === undefined ? {} : { observed_at: time(health.last_probed_at, now) }) } : undefined;
      if (current) {
        // Older saved health has no resource identity. Keep its connection-
        // level positive monitor, while new failures require matching keys.
        if (checks.get(id)?.state === 'failed') checks.delete(id);
        checks.set(id + ':' + context, current);
      }
      for (const check of evidence.checks) {
        if (check.recent || time(check.at, now) === undefined) continue;
        const key = id + ':' + check.key;
        checks.set(key, { id, group_id: g.id, context: check.key, observed_at: check.at,
          state: check.status === 'ok' ? 'succeeded' : check.status === (code === 'credential_rejected' ? 'auth_failed' : 'unreachable') ? 'failed' : 'unknown' });
      }
    }
    if (!evidence.complete) issue(g, 'access_unconfirmed', row.name + ': API access history is incomplete. Review this connection before trusting its access.', ['api-history', row.name]);
  }
  for (const row of instances) {
    const binding = record(collectionOAuthBinding(row.config)); const name = text(binding.connection_name);
    const provider = row.adapter_type === 'gmail' || row.adapter_type === 'gcal' || row.adapter_type === 'graph' ? row.adapter_type : undefined;
    const native = provider !== undefined;
    const key = authenticationCollectionGroupKey(row);
    const address = typeof row.config.account_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.config.account_email) ? text(row.config.account_email) : undefined;
    const label = text(row.config.display_name) ?? address ?? row.slug;
    const g = name && byName.get(name) || group(key, label,
      binding.type === 'managed_oauth' ? 'broker' : native ? 'direct_oauth' : 'other');
    const origin = [row.platform, row.slug];
    const verified = row.auth_state === 'healthy' ? row.last_synced_at : undefined;
    for (const code of ['credential_rejected', 'access_unconfirmed', 'connection_missing', 'binding_changed', 'app_missing'] as const) success(g, code, origin, verified);
    success(g, 'access_unconfirmed', ['runtime', row.platform, row.slug], verified);
    if (!name || !byName.has(name)) g.usage_available = false;
    use(g, { kind: row.platform as 'mail' | 'calendar', id: row.slug, label });
    target(g, { kind: 'collection', platform: row.platform as 'mail' | 'calendar', slug: row.slug });
    if (name) {
      if (!byName.has(name)) issue(g, connectionsAvailable ? 'connection_missing' : 'access_unconfirmed', connectionsAvailable
        ? 'The saved API connection used by this account is missing. Review this collection’s authentication.'
        : 'The saved connection used by this account could not be checked because its inventory is unavailable.', [row.platform, row.slug]);
      else {
        const auth = auths.get(name);
        let matches = auth?.type === 'oauth2_refresh' ? binding.type === 'direct_oauth' && !!text(auth.native_credential_id) && binding.native_credential_id === auth.native_credential_id
          : auth?.type === 'managed_oauth' ? (binding.type === undefined || binding.type === 'managed_oauth') && binding.broker_profile_id === auth.broker_profile_id && binding.integration_id === auth.integration_id
            && binding.connection_id === auth.connection_id && binding.target_origin === auth.target_origin : auth === undefined;
        if (auth) matches &&= collectionServiceMatches(provider, savedByName.get(name)!, binding);
        if (auth?.type === 'managed_oauth' && binding.type === 'managed_oauth') {
          const signature = profileSignature(auth.broker_profile_id);
          if (signature !== undefined && signature !== binding.broker_profile_signature) matches = false;
        }
        if (!matches) issue(g, 'binding_changed', 'The saved connection’s authentication changed. This collection still pins its previous authorization; review and reconnect the collection.', [row.platform, row.slug]);
      }
    } else if (native) {
      const issuer = row.adapter_type === 'graph' ? 'microsoft' : 'google';
      if (deps.apps && !unavailable.has('Saved OAuth app status is unavailable.') && !apps.some(a => a.issuer === issuer && a.id === (row.config.oauth_app_id ?? 'default') && a.has_secret)) {
        issue(g, 'app_missing', 'This native account’s saved OAuth app or app secret is unavailable. Review its app settings.', [row.platform, row.slug]);
        target(g, { kind: 'oauth_apps' });
      }
    }
    if (row.auth_state === 'expired') issue(g, 'credential_rejected', row.platform + ' ' + row.slug + ': this collection reports expired authentication. Open the account to reconnect.', [row.platform, row.slug], time(row.updated_at, now));
    else if (row.auth_state === 'unauthorized') issue(g, 'credential_rejected', row.platform + ' ' + row.slug + ': this collection reports rejected authorization. Review the account and its access.', [row.platform, row.slug], time(row.updated_at, now));
    else if (row.auth_state !== 'healthy') issue(g, 'access_unconfirmed', row.platform + ' ' + row.slug + ': authentication needs review; the cause is unconfirmed.', [row.platform, row.slug], time(row.updated_at, now));
    if (deps.health) {
      try {
        const health = deps.health(row.platform as 'mail' | 'calendar', row.slug);
        if (health?.auth_state && health.auth_state !== 'healthy' && row.auth_state === 'healthy') issue(g, 'access_unconfirmed',
          'The running collection reports an authentication problem. Open the account to review its current status.', ['runtime', row.platform, row.slug]);
        else if (health?.state === 'error' && row.auth_state === 'healthy') issue(g, 'access_unconfirmed',
          'The running collection reports a problem. An authentication cause is unconfirmed.', ['runtime', row.platform, row.slug]);
      } catch { unavailable.add('Some running collection status could not be read.'); }
    }
  }
  for (const source of sources) {
    const name = sourceIdConnectionName(source.id);
    const g = name && byName.get(name) || group(JSON.stringify(['orphan-file', source.id]), text(source.source_label) ?? source.id, 'unknown');
    if (!name || !byName.has(name)) {
      g.usage_available = false;
      issue(g, connectionsAvailable ? 'connection_missing' : 'access_unconfirmed', connectionsAvailable
        ? 'The saved connection used by this file source is missing. Review the source before reconnecting.'
        : 'The saved connection used by this file source could not be checked because its inventory is unavailable.', source.id);
    }
    use(g, { kind: 'file', id: source.id, label: text(source.source_label) ?? source.id }); target(g, { kind: 'file_source', source_id: source.id });
    success(g, 'source_check_failed', source.id, undefined);
    success(g, 'connection_missing', source.id, undefined);
    if (!deps.fileState) { unavailable.add('File-source sync observations are unavailable.'); continue; }
    try { const state = deps.fileState(source.id);
      if (state && !state.degraded) {
        success(g, 'source_check_failed', source.id, state.last_success_at);
        success(g, 'connection_missing', source.id, state.last_success_at);
      }
      if (state?.degraded && state.last_error_code?.startsWith('fetch_')) issue(g, 'source_check_failed',
        'The last file-source read failed. Authentication, service access or source configuration may need repair; the cause is unconfirmed.', source.id, time(state.last_sync_completed_at, now));
    } catch { unavailable.add('File-source sync observations are unavailable.'); }
  }
  for (const app of apps) {
    const expiry = oauthAppSecretExpiry(app, now);
    if (expiry.status === 'unknown' || expiry.status === 'scheduled') continue;
    const g = group(JSON.stringify(['app', app.issuer, app.id]), app.label, 'direct_oauth', 'app');
    // Native collection references are known; recipe references to those lanes
    // and any unreadable API copies are not a complete impact inventory.
    g.usage_available = false;
    target(g, { kind: 'oauth_apps' });
    const message = 'Owner-recorded app secret expiry: ' + expiry.date + '. This date does not prove that the vendor rejected the secret.';
    issue(g, 'secret_expiry', message, [app.issuer, app.id]); g.issues[0]!.secret_expires_on = expiry.date;
    for (const row of instances) if (collectionOAuthBinding(row.config) === undefined && ['gmail', 'gcal', 'graph'].includes(row.adapter_type)
      && (row.adapter_type === 'graph' ? 'microsoft' : 'google') === app.issuer && (row.config.oauth_app_id ?? 'default') === app.id) {
      use(g, { kind: row.platform as 'mail' | 'calendar', id: row.slug, label: row.slug });
      target(g, { kind: 'collection', platform: row.platform as 'mail' | 'calendar', slug: row.slug });
    }
    for (const row of rows) { const auth = auths.get(row.name);
      if (auth?.type !== 'oauth2_refresh' || auth.saved_oauth_app?.id !== app.id || auth.saved_oauth_app.issuer !== app.issuer) continue;
      const account = byName.get(row.name)!; g.usage_available &&= account.usage_available;
      for (const u of account.uses) use(g, u); target(g, { kind: 'connection', name: row.name });
    }
  }
  // Projection is synchronous after decryption. Fence any local getter that
  // changes its inventory or broker profile while that projection is read.
  if (!unavailable.has('Saved connection status is unavailable.') && hash(rows) !== hash(deps.connections().filter(r => r.kind === 'api'))
    || deps.instances && !unavailable.has('Mail and Calendar status is unavailable.') && hash(instances) !== hash(deps.instances().filter(r => r.platform === 'mail' || r.platform === 'calendar'))
    || deps.sources && !unavailable.has('File-source status is unavailable.') && hash(sources) !== hash(deps.sources().filter(r => r.top_tier_kind === 'file' && r.source_kind === 'connection'))
    || deps.apps && !unavailable.has('Saved OAuth app status is unavailable.') && hash(apps) !== hash(deps.apps())
    || [...profileSignatures].some(([id, signature]) => readProfileSignature(id) !== signature)) {
    throw new RpcError('conflict', 'Saved accounts changed while reading authentication repairs. Refresh the worklist.');
  }
  return { checks: [...checks.values()], worklist: { observed_at: now, groups: [...groups.values()].map(g => ({ ...g,
    connection_names: g.connection_names.sort(), uses: g.uses.sort((a,b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
  })).sort((a,b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), unavailable: [...unavailable] } };
};

export const createAuthenticationRepairWorklist = (deps: AuthenticationRepairDeps) => {
  const read = createAuthenticationRepairSnapshot(deps);
  return async (): Promise<AuthenticationRepairWorklist> => (await read()).worklist;
};
