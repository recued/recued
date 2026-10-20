/** Latest retained attempt per resource. A projection never replaces a saved check. */
import { isAuthenticationAccessSelection, isAuthenticationAccessVerification,
  type AuthenticationAccessResult, type AuthenticationAccessSelection } from './authentication-access-verification.js';
import { authenticationIncidentScope, isAuthenticationIncidentScope } from './authentication-incident-history.js';
import type { AuthenticationRepairTarget } from './authentication-repair-worklist.js';

export interface AuthenticationAccessSummaryEvidence {
  id: string;
  selection: AuthenticationAccessSelection;
  status: 'checking' | 'completed'; started_at: number; finished_at?: number;
  result: AuthenticationAccessResult;
}
export interface AuthenticationAccessSummaryTarget {
  id: string; target: Exclude<AuthenticationRepairTarget, { kind: 'oauth_apps' }>; label: string;
  state: 'checked' | 'not_checked' | 'unavailable';
  latest?: AuthenticationAccessSummaryEvidence;
}
export interface AuthenticationAccessSummary {
  selection: AuthenticationAccessSelection; observed_at: number;
  targets: AuthenticationAccessSummaryTarget[]; targets_truncated: boolean;
  lookup_incomplete: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
export const isAuthenticationAccessSummary = (value: unknown): value is AuthenticationAccessSummary => record(value)
  && isAuthenticationAccessSelection(value.selection) && time(value.observed_at) && typeof value.targets_truncated === 'boolean'
  && typeof value.lookup_incomplete === 'boolean' && Array.isArray(value.targets) && value.targets.length <= 32
  && new Set(value.targets.map(t => record(t) ? t.id : null)).size === value.targets.length && Array.from(value.targets).every(row => {
    if (!record(row) || !hash(row.id) || !text(row.label) || !isAuthenticationIncidentScope(row.target)
      || row.target.kind === 'all' || row.target.kind === 'group' || row.target.kind === 'oauth_apps') return false;
    if (row.state !== 'checked') return (row.state === 'not_checked' || row.state === 'unavailable') && row.latest === undefined;
    const latest = row.latest;
    return record(latest) && isAuthenticationAccessVerification({ id: latest.id, selection: latest.selection, status: latest.status,
      started_at: latest.started_at, finished_at: latest.finished_at, results: [latest.result], targets_truncated: false, uses: [], usage_available: true })
      && record(latest.result) && latest.result.id === row.id && isAuthenticationIncidentScope(latest.result.target)
      && JSON.stringify(authenticationIncidentScope(latest.result.target)) === JSON.stringify(authenticationIncidentScope(row.target));
  });
/** Bind a valid projection to its containing worklist group or repair. */
export const authenticationAccessSummaryMatchesTargets = (value: AuthenticationAccessSummary, targets: unknown): boolean => {
  if (!Array.isArray(targets) || !Array.from(targets).every(t => isAuthenticationIncidentScope(t) && t.kind !== 'all' && t.kind !== 'group')) return false;
  const keys = new Set(targets.map(t => JSON.stringify(authenticationIncidentScope(t))));
  return value.targets.every(row => keys.has(JSON.stringify(authenticationIncidentScope(row.target))));
};
