import { authenticationAccessRecheckResults, authenticationIncidentScope,
  type AuthenticationAccessSummaryEvidence, type AuthenticationAccessVerification,
  type AuthenticationRepairWorklist } from '@recued/contracts';

/** One retained source check; only its latest non-passing resources are selected. */
export interface BulkAuthenticationAccessRecheck {
  id: string; label: string; connection_names: string[]; account_labels: string[];
  evidence: AuthenticationAccessSummaryEvidence[];
}
export const accessEvidenceVerification = (entry: AuthenticationAccessSummaryEvidence): AuthenticationAccessVerification => ({
  id: entry.id, selection: entry.selection, status: entry.status, started_at: entry.started_at,
  ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}), results: [entry.result],
  targets_truncated: false, uses: [], usage_available: true,
});
const resourceKey = (target: AuthenticationAccessSummaryEvidence['result']['target']): string => JSON.stringify(authenticationIncidentScope(target));
const sourceKey = (entry: AuthenticationAccessSummaryEvidence): string => JSON.stringify([entry.id, entry.selection, entry.status, entry.started_at, entry.finished_at]);
const evidenceKey = (entry: AuthenticationAccessSummaryEvidence | undefined): string => entry
  ? JSON.stringify([sourceKey(entry), entry.result.id, entry.result.authentication_revision, entry.result.checks]) : 'unavailable';
export const bulkAuthenticationAccessRecheckSignature = (check: BulkAuthenticationAccessRecheck): string =>
  JSON.stringify(check.evidence.map(e => JSON.stringify([resourceKey(e.result.target), evidenceKey(e)])).sort());

/** Reads the local projection. Never falls back from a newer pass to an older failure. */
export const bulkAuthenticationAccessRechecks = (worklist: AuthenticationRepairWorklist): { checks: BulkAuthenticationAccessRecheck[]; unavailable: string[] } => {
  const observations = new Map<string, { evidence?: AuthenticationAccessSummaryEvidence; signature: string; conflict: boolean; labels: Set<string>; names: Set<string> }>();
  const sources = new Map<string, string>(); const conflicts = new Set<string>();
  let incomplete = false; let running = false;
  const observe = (entry: AuthenticationAccessSummaryEvidence | undefined, target: AuthenticationAccessSummaryEvidence['result']['target'], label: string, names: string[]): void => {
    if (entry) {
      if (sources.has(entry.id) && sources.get(entry.id) !== sourceKey(entry)) conflicts.add(entry.id);
      sources.set(entry.id, sourceKey(entry));
    }
    const key = resourceKey(target); const signature = evidenceKey(entry); const old = observations.get(key);
    if (old) { old.conflict ||= old.signature !== signature; old.labels.add(label); names.forEach(name => old.names.add(name)); }
    else observations.set(key, { ...(entry ? { evidence: entry } : {}), signature, conflict: false, labels: new Set([label]), names: new Set(names) });
  };
  const groups = worklist.groups.filter(g => g.kind === 'account');
  for (const group of groups) if (group.access_summary) {
    const summary = group.access_summary; incomplete ||= summary.lookup_incomplete || summary.targets_truncated;
    for (const target of summary.targets) {
      incomplete ||= target.state === 'unavailable'; running ||= target.latest?.status === 'checking';
      observe(target.latest, target.target, group.label, group.connection_names);
    }
    const listed = new Set(summary.targets.map(t => resourceKey(t.target)));
    for (const target of group.targets) if (target.kind !== 'oauth_apps' && !listed.has(resourceKey(target))) {
      incomplete = true; observe(undefined, target, group.label, group.connection_names);
    }
  }
  // Compatibility for a server with the older full-group receipt only. A modern
  // observation of this resource, including an unavailable lookup, takes priority.
  const modern = new Set(observations.keys());
  for (const group of groups) if (!group.access_summary && group.access_verification) {
    const value = group.access_verification; const allowed = new Set(group.targets.map(resourceKey));
    incomplete ||= value.targets_truncated; running ||= value.status === 'checking';
    for (const result of value.results) if (result.target.kind !== 'oauth_apps' && allowed.has(resourceKey(result.target)) && !modern.has(resourceKey(result.target))) {
      observe({ id: value.id, selection: value.selection, status: value.status, started_at: value.started_at,
        ...(value.finished_at !== undefined ? { finished_at: value.finished_at } : {}), result }, result.target, group.label, group.connection_names);
    }
  }
  const checks = new Map<string, BulkAuthenticationAccessRecheck>();
  for (const observation of observations.values()) {
    const entry = observation.evidence;
    if (observation.conflict) { incomplete = true; continue; }
    if (!entry || !authenticationAccessRecheckResults(accessEvidenceVerification(entry)).length || entry.result.target.kind === 'oauth_apps') continue;
    const check = checks.get(entry.id) ?? { id: entry.id, label: '', connection_names: [], account_labels: [], evidence: [] };
    check.evidence.push(structuredClone(entry)); check.connection_names = [...new Set([...check.connection_names, ...observation.names])];
    check.account_labels = [...new Set([...check.account_labels, ...observation.labels])];
    check.label = check.account_labels[0]! + (check.account_labels.length > 1 ? ' · +' + (check.account_labels.length - 1) + (check.account_labels.length === 2 ? ' account' : ' accounts') : ''); checks.set(entry.id, check);
  }
  for (const check of checks.values()) if (check.evidence.length > 32 || new Set(check.evidence.map(e => e.result.id)).size !== check.evidence.length) conflicts.add(check.id);
  for (const id of conflicts) { checks.delete(id); incomplete = true; }
  return { checks: [...checks.values()], unavailable: [
    ...(incomplete ? ['Some latest saved checks are unavailable, inconsistent or omitted. Refresh the list or review those accounts separately.'] : []),
    ...(running ? ['Some saved checks are still running. Refresh after they finish to review their results.'] : []),
  ] };
};
