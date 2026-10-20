/** A complete, bounded snapshot of matching retained observations. No vendor work. */
import { isAuthenticationAccessVerification } from './authentication-access-verification.js';
import { authenticationIncidentScope, authenticationIncidentHistoryFilters, authenticationHistoryEntryType, authenticationHistoryEntryOutcome,
  authenticationHistoryEntryMatches, isAuthenticationIncidentScope, isAuthenticationIncidentHistoryFilters, isAuthenticationIncidentHistoryPage,
  isAuthenticationRepairAction, isAuthenticationRenewalHistory,
  type AuthenticationHistoryEntry, type AuthenticationIncidentHistoryFilters, type AuthenticationIncidentScope,
  type AuthenticationRepairMethod, type AuthenticationIncident, type AuthenticationRepairAction, type AuthenticationRenewalHistory } from './authentication-incident-history.js';
import type { AuthenticationRepairTarget, AuthenticationRepairGroup, AuthenticationRepairIssue } from './authentication-repair-worklist.js';
import type { AuthenticationAccessVerification, AuthenticationAccessResult } from './authentication-access-verification.js';
import type { ManagedOAuthConnectionUse } from './managed-oauth.js';
import type { OAuthAppRenewalResult } from './oauth-app-renewal.js';

export const AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES = 20_000;
export const AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
export interface AuthenticationHistoryExportQuery {
  scope: AuthenticationIncidentScope;
  filters?: AuthenticationIncidentHistoryFilters;
}
export interface AuthenticationHistoryExportEntry {
  type: ReturnType<typeof authenticationHistoryEntryType>;
  outcome: ReturnType<typeof authenticationHistoryEntryOutcome>;
  record: AuthenticationHistoryEntry;
}
export interface AuthenticationHistoryExport {
  format: 'recued.connection-history';
  version: 1;
  exported_at: number;
  scope: AuthenticationIncidentScope;
  filters: AuthenticationIncidentHistoryFilters;
  retention_days: 90;
  finished_record_limit: 10000;
  complete: true;
  evidence: 'retained_local_observations';
  current_authentication: 'not_checked';
  entry_count: number;
  /** Newest insertion first, including checks imported after their original start. */
  entries: AuthenticationHistoryExportEntry[];
}
export type AuthenticationHistoryExportCaller = (query: AuthenticationHistoryExportQuery) => Promise<AuthenticationHistoryExport>;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isAuthenticationHistoryExportQuery = (v: unknown): v is AuthenticationHistoryExportQuery => object(v)
  && Object.keys(v).every(k => ['scope', 'filters', 'action'].includes(k))
  && (v.action === undefined || v.action === 'authentication_history_export')
  && isAuthenticationIncidentScope(v.scope) && (v.filters === undefined || isAuthenticationIncidentHistoryFilters(v.filters));

const pick = <T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]])) as Pick<T, K>;
const target = (v: AuthenticationRepairTarget): AuthenticationRepairTarget => authenticationIncidentScope(v) as AuthenticationRepairTarget;
const method = (v: AuthenticationRepairMethod): AuthenticationRepairMethod => pick(v, ['type', 'app_id', 'broker_profile_id', 'broker_account_id', 'label', 'connection_name']);

/** Recursively select public receipt fields. Never spread a server/provider object
 * into an export. Omit fresh navigation, latest-check/recovery projections and
 * raw issue messages. Current-authentication flags are explicitly unknown. */
export const authenticationHistoryExportRecord = (v: unknown): AuthenticationHistoryEntry | null => {
  if (!object(v) || typeof v.id !== 'string') return null;
  if (v.id.startsWith('repair-')) {
    if (!isAuthenticationRepairAction(v)) return null;
    return { ...pick(v, ['id', 'action', 'status', 'started_at', 'finished_at', 'reason', 'restart_required', 'targets_truncated', 'incidents_truncated']),
      ...(v.from ? { from: method(v.from) } : {}), ...(v.to ? { to: method(v.to) } : {}),
      targets: v.targets.map(target), incidents: v.incidents.map(i => pick(i, ['id', 'group_id', 'label'])) };
  }
  if (v.id.startsWith('verify-')) {
    if (!isAuthenticationAccessVerification(v)) return null;
    return { ...pick(v, ['id', 'status', 'started_at', 'finished_at', 'targets_truncated', 'usage_available']), selection: pick(v.selection, ['kind', 'id']),
      results: v.results.map(r => ({ ...pick(r, ['id', 'label', 'authentication_revision']), target: target(r.target), current: 'unknown',
        checks: r.checks.map(c => pick(c, ['kind', 'status', 'reason'])) })), uses: v.uses.map(u => pick(u, ['kind', 'id', 'label'])) };
  }
  if (v.id.startsWith('renewal-')) {
    if (!isAuthenticationRenewalHistory(v)) return null;
    return { ...pick(v, ['id', 'issuer', 'app_id', 'app_revision', 'app_label', 'status', 'started_at', 'finished_at', 'incomplete', 'history_started_at', 'references_incomplete']),
      results: v.results.map(r => ({ ...pick(r, ['id', 'revision', 'label', 'eligible', 'reason', 'status']), current: 'unknown',
        connections: [...r.connections], native_accounts: r.native_accounts.map(a => pick(a, ['platform', 'slug'])) })) };
  }
  if (!isAuthenticationIncidentHistoryPage({ scope: { kind: 'all' }, observed_at: 0, retention_days: 90, incidents: [v] })) return null;
  // The page guard above validates this one incident, including its lifecycle.
  const incident = v as unknown as import('./authentication-incident-history.js').AuthenticationIncident;
  return { ...pick(incident, ['id', 'status', 'started_at', 'last_problem_at', 'history_started_at', 'ended_at', 'retirement_reason', 'currently_reported', 'level', 'events_truncated', 'details_truncated']),
    ...(incident.recovery_evidence ? { recovery_evidence: pick(incident.recovery_evidence, ['earliest_at', 'latest_at']) } : {}),
    group: { ...pick(incident.group, ['id', 'kind', 'label', 'authentication', 'usage_available']), connection_names: [...incident.group.connection_names],
      targets: incident.group.targets.map(target), uses: incident.group.uses.map(u => pick(u, ['kind', 'id', 'label'])),
      issues: incident.group.issues.map(i => ({ ...pick(i, ['id', 'code', 'observed_at', 'secret_expires_on']), message: 'Recorded local issue: ' + i.code })) },
    events: incident.events.map(e => pick(e, ['kind', 'at', 'level'])) };
};

export const isAuthenticationHistoryExport = (v: unknown): v is AuthenticationHistoryExport => {
  if (!object(v) || v.format !== 'recued.connection-history' || v.version !== 1 || v.complete !== true
    || v.evidence !== 'retained_local_observations' || v.current_authentication !== 'not_checked'
    || typeof v.exported_at !== 'number' || !Number.isSafeInteger(v.exported_at) || v.exported_at < 0 || v.exported_at > 8_640_000_000_000_000
    || !isAuthenticationIncidentScope(v.scope) || !isAuthenticationIncidentHistoryFilters(v.filters)
    || v.retention_days !== 90 || v.finished_record_limit !== 10000 || !Array.isArray(v.entries)
    || v.entries.length > AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES || v.entry_count !== v.entries.length) return false;
  const ids = new Set<string>();
  return v.entries.every(e => {
    if (!object(e)) return false;
    const entry = authenticationHistoryExportRecord(e.record);
    if (!entry || ids.has(entry.id) || e.type !== authenticationHistoryEntryType(entry) || e.outcome !== authenticationHistoryEntryOutcome(entry)
      || !authenticationHistoryEntryMatches(entry, v.filters as AuthenticationIncidentHistoryFilters)) return false;
    ids.add(entry.id); return true;
  });
};

/** Reapply the allowlist at the download boundary, including report metadata. */
export const authenticationHistoryExportReport = (v: AuthenticationHistoryExport): AuthenticationHistoryExport => ({
  format: 'recued.connection-history', version: 1, complete: true, exported_at: v.exported_at,
  scope: authenticationIncidentScope(v.scope), filters: authenticationIncidentHistoryFilters(v.filters),
  retention_days: 90, finished_record_limit: 10000, evidence: 'retained_local_observations', current_authentication: 'not_checked',
  entry_count: v.entries.length, entries: v.entries.map(e => {
    const record = authenticationHistoryExportRecord(e.record);
    if (!record) throw new Error('Invalid retained history observation.');
    return { type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record };
  }),
});

export type AuthenticationHistoryExportMode = 'aliases' | 'full';
type AliasKind = 'incident' | 'repair' | 'access-check' | 'token-renewal' | 'group' | 'connection' | 'mail-account' | 'calendar-account' | 'file-source'
  | 'issue' | 'access-target' | 'authentication-revision' | 'oauth-app' | 'app-reference' | 'broker-profile' | 'broker-account' | 'unqualified-broker-account'
  | 'authorization' | 'authorization-revision' | `use-${ManagedOAuthConnectionUse['kind']}`;
type Alias<K extends AliasKind = AliasKind> = `${K}-${number}`;
type PrivateTarget = { kind: 'connection'; name: Alias<'connection'> } | { kind: 'file_source'; source_id: Alias<'file-source'> }
  | { kind: 'collection'; platform: 'mail' | 'calendar'; slug: Alias<'mail-account' | 'calendar-account'> } | { kind: 'oauth_apps' };
type PrivateScope = PrivateTarget | { kind: 'all' } | { kind: 'group'; id: Alias<'group'> };
type PrivateUse = { kind: ManagedOAuthConnectionUse['kind']; id: Alias<`use-${ManagedOAuthConnectionUse['kind']}`> };
type PrivateMethod = Omit<AuthenticationRepairMethod, 'label' | 'app_id' | 'broker_profile_id' | 'broker_account_id' | 'connection_name'> & {
  /** The original method did not record an issuer; this reference cannot join a qualified app. */
  app_reference?: Alias<'app-reference'>;
  broker_profile_id?: Alias<'broker-profile'>;
  broker_account_id?: Alias<'broker-account' | 'unqualified-broker-account'>;
  connection_name?: Alias<'connection'>;
};
type PrivateIncident = Omit<AuthenticationIncident, 'id' | 'group'> & { id: Alias<'incident'>;
  group: Omit<AuthenticationRepairGroup, 'id' | 'label' | 'connection_names' | 'targets' | 'uses' | 'issues' | 'access_summary' | 'access_verification'> & {
    id: Alias<'group'>; connection_names: Alias<'connection'>[]; targets: PrivateTarget[]; uses: PrivateUse[];
    issues: (Omit<AuthenticationRepairIssue, 'id' | 'message'> & { id: Alias<'issue'> })[];
  } };
type PrivateRepair = Omit<AuthenticationRepairAction, 'id' | 'from' | 'to' | 'targets' | 'incidents' | 'access_summary' | 'access_verification' | 'recovery_confirmed_at'> & {
  id: Alias<'repair'>; from?: PrivateMethod; to?: PrivateMethod; targets: PrivateTarget[];
  incidents: { id: Alias<'incident'>; group_id: Alias<'group'> }[];
};
type PrivateAccess = Omit<AuthenticationAccessVerification, 'id' | 'selection' | 'results' | 'uses'> & {
  id: Alias<'access-check'>; selection: { kind: 'group' | 'repair' | 'verification' | 'renewal'; id: Alias<'group' | 'repair' | 'access-check' | 'token-renewal'> };
  results: (Omit<AuthenticationAccessResult, 'id' | 'label' | 'target' | 'authentication_revision' | 'file_connection'> & {
    id: Alias<'access-target'>; target: PrivateTarget; authentication_revision: Alias<'authentication-revision'>;
  })[]; uses: PrivateUse[];
};
type PrivateRenewal = Omit<AuthenticationRenewalHistory, 'id' | 'app_id' | 'app_label' | 'results'> & {
  id: Alias<'token-renewal'>; app_id: Alias<'oauth-app'>;
  results: (Omit<OAuthAppRenewalResult, 'id' | 'revision' | 'label' | 'connections' | 'native_accounts'> & {
    id: Alias<'authorization'>; revision: Alias<'authorization-revision'>; connections: Alias<'connection'>[];
    native_accounts: { platform: 'mail' | 'calendar'; slug: Alias<'mail-account' | 'calendar-account'> }[];
  })[];
};
export type AuthenticationHistoryPrivateEntry = { outcome: AuthenticationHistoryExportEntry['outcome'] } & (
  { type: 'incident'; record: PrivateIncident } | { type: 'repair'; record: PrivateRepair }
  | { type: 'verification'; record: PrivateAccess } | { type: 'renewal'; record: PrivateRenewal });
/** A download format, deliberately distinct from runtime IDs and the full v1 report. */
export interface AuthenticationHistoryPrivateExport extends Omit<AuthenticationHistoryExport, 'format' | 'scope' | 'filters' | 'entries'> {
  format: 'recued.connection-history.aliases';
  alias_scope: 'this_file';
  scope: PrivateScope;
  filters: Omit<AuthenticationIncidentHistoryFilters, 'search'> & { search_applied: boolean };
  entries: AuthenticationHistoryPrivateEntry[];
}

/** Replace all names, identifiers and fingerprints. Each call owns its maps;
 * no source mapping, hash of an original ID or runtime navigation is exported.
 * Equal aliases mean equal recorded references only within this one file. */
export const authenticationHistoryPrivateExport = (value: AuthenticationHistoryExport): AuthenticationHistoryPrivateExport => {
  if (!isAuthenticationHistoryExport(value)) throw new Error('Invalid history export.');
  const report = authenticationHistoryExportReport(value);
  const namespaces = new Map<AliasKind, Map<string, number>>();
  const alias = <K extends AliasKind>(kind: K, key: string): Alias<K> => {
    let map = namespaces.get(kind); if (!map) { map = new Map(); namespaces.set(kind, map); }
    let ordinal = map.get(key); if (ordinal === undefined) { ordinal = map.size + 1; map.set(key, ordinal); }
    return `${kind}-${ordinal}`;
  };
  const privateTarget = (t: AuthenticationRepairTarget): PrivateTarget => {
    switch (t.kind) {
      case 'connection': return { kind: t.kind, name: alias('connection', t.name) };
      case 'file_source': return { kind: t.kind, source_id: alias('file-source', t.source_id) };
      case 'collection': return { kind: t.kind, platform: t.platform, slug: alias(`${t.platform}-account`, t.slug) };
      case 'oauth_apps': return { kind: t.kind };
    }
  };
  const privateScope = (s: AuthenticationIncidentScope): PrivateScope => s.kind === 'all' ? { kind: s.kind }
    : s.kind === 'group' ? { kind: s.kind, id: alias('group', s.id) } : privateTarget(s);
  const privateUse = (u: ManagedOAuthConnectionUse): PrivateUse => ({ kind: u.kind, id: alias(`use-${u.kind}`, u.id) });
  const privateMethod = (m: AuthenticationRepairMethod, context: string): PrivateMethod => ({ type: m.type,
    ...(m.app_id ? { app_reference: alias('app-reference', JSON.stringify([context, m.app_id])) } : {}),
    ...(m.broker_profile_id ? { broker_profile_id: alias('broker-profile', m.broker_profile_id) } : {}),
    ...(m.broker_account_id ? { broker_account_id: m.broker_profile_id
      ? alias('broker-account', JSON.stringify([m.broker_profile_id, m.broker_account_id]))
      : alias('unqualified-broker-account', JSON.stringify([context, m.broker_account_id])) } : {}),
    ...(m.connection_name ? { connection_name: alias('connection', m.connection_name) } : {}),
  });
  const scope = privateScope(report.scope);
  const entries = report.entries.map((entry): AuthenticationHistoryPrivateEntry => {
    const r = entry.record; const outcome = entry.outcome;
    if (isAuthenticationRepairAction(r)) return { type: 'repair', outcome, record: {
      ...pick(r, ['action', 'status', 'started_at', 'finished_at', 'reason', 'restart_required', 'targets_truncated', 'incidents_truncated']), id: alias('repair', r.id),
      ...(r.from ? { from: privateMethod(r.from, r.id + ':from') } : {}), ...(r.to ? { to: privateMethod(r.to, r.id + ':to') } : {}),
      targets: r.targets.map(privateTarget), incidents: r.incidents.map(i => ({ id: alias('incident', i.id), group_id: alias('group', i.group_id) })),
    } };
    if (isAuthenticationAccessVerification(r)) return { type: 'verification', outcome, record: {
      ...pick(r, ['status', 'started_at', 'finished_at', 'targets_truncated', 'usage_available']), id: alias('access-check', r.id),
      selection: { kind: r.selection.kind, id: alias(r.selection.kind === 'verification' ? 'access-check' : r.selection.kind === 'renewal' ? 'token-renewal' : r.selection.kind, r.selection.id) },
      results: r.results.map(result => ({ id: alias('access-target', result.id), target: privateTarget(result.target),
        authentication_revision: alias('authentication-revision', result.authentication_revision), current: 'unknown', checks: result.checks.map(c => pick(c, ['kind', 'status', 'reason'])) })),
      uses: r.uses.map(privateUse),
    } };
    if (isAuthenticationRenewalHistory(r)) return { type: 'renewal', outcome, record: {
      ...pick(r, ['issuer', 'app_revision', 'status', 'started_at', 'finished_at', 'incomplete', 'history_started_at', 'references_incomplete']), id: alias('token-renewal', r.id),
      app_id: alias('oauth-app', JSON.stringify([r.issuer, r.app_id])),
      results: r.results.map(result => ({ ...pick(result, ['eligible', 'reason', 'status']), id: alias('authorization', result.id),
        revision: alias('authorization-revision', result.revision), current: 'unknown', connections: result.connections.map(name => alias('connection', name)),
        native_accounts: result.native_accounts.map(a => ({ platform: a.platform, slug: alias(`${a.platform}-account`, a.slug) })) })),
    } };
    // Full-report validation and the other three guards leave only an incident.
    const incident = r as AuthenticationIncident;
    return { type: 'incident', outcome, record: {
      ...pick(incident, ['status', 'started_at', 'last_problem_at', 'history_started_at', 'ended_at', 'retirement_reason', 'currently_reported', 'level', 'events_truncated', 'details_truncated']), id: alias('incident', incident.id),
      ...(incident.recovery_evidence ? { recovery_evidence: pick(incident.recovery_evidence, ['earliest_at', 'latest_at']) } : {}),
      events: incident.events.map(e => pick(e, ['kind', 'at', 'level'])),
      group: { ...pick(incident.group, ['kind', 'authentication', 'usage_available']), id: alias('group', incident.group.id),
        connection_names: incident.group.connection_names.map(name => alias('connection', name)), targets: incident.group.targets.map(privateTarget), uses: incident.group.uses.map(privateUse),
        issues: incident.group.issues.map(i => ({ ...pick(i, ['code', 'observed_at', 'secret_expires_on']), id: alias('issue', i.id) })) },
    } };
  });
  return { format: 'recued.connection-history.aliases', version: 1, alias_scope: 'this_file', complete: true, exported_at: report.exported_at,
    scope, filters: { ...pick(report.filters, ['type', 'outcome', 'from', 'through']), search_applied: report.filters.search !== undefined },
    retention_days: 90, finished_record_limit: 10000, evidence: 'retained_local_observations', current_authentication: 'not_checked', entry_count: entries.length, entries };
};
