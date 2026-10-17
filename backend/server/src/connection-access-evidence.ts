/** Bounded private API observations and recovery evidence.
 * Keys are hashes of unsigned method/URL pairs, never URLs, bodies or tokens. */
import { createHash } from 'node:crypto';
import type { ConnectionAuth } from '@recued/contracts';
export interface ConnectionAccessCheck {
  key: string;
  status: 'ok' | 'auth_failed' | 'unreachable';
  at: number;
  /** A successful resource with no recorded failure. Keep it for ordering,
   * without displacing failed-resource observations or their recovery proof. */
  recent?: true;
}
export interface ConnectionAccessEvidence {
  checks: ConnectionAccessCheck[];
  complete: boolean;
}
const MAX_CHECKS = 64;
const MAX_RECENT_CHECKS = 64;
/** Completion order is only known to millisecond precision. A failure wins a
 * tie; only a later success may replace evidence of refused access. */
export const connectionAccessObservationWins = (previous: { at: number; status?: string }, next: { at: number; status: string }): boolean => {
  const rank = (status: string | undefined): number => status === 'auth_failed' ? 2 : status === 'unreachable' ? 1 : 0;
  return next.at > previous.at || next.at === previous.at && rank(next.status) >= rank(previous.status);
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Automatic token renewal keeps the authority; a new native family, app key,
 * broker account or service does not inherit another credential's history. */
export const connectionAccessAuthority = (auth: ConnectionAuth, baseUrl: string): string => {
  const stable: Record<string, unknown> = { ...auth };
  for (const field of ['current_access_token', 'expires_at', 'refresh_token', 'required_scopes', 'requested_scopes',
    'saved_oauth_app', 'imported', 'permission_cleanup_pending']) delete stable[field];
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  return createHash('sha256').update(JSON.stringify([sorted(stable), new URL(baseUrl).toString()])).digest('hex');
};
export const isConnectionAccessKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const readConnectionAccessEvidence = (json: string | undefined, authority: string): ConnectionAccessEvidence => {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(json ?? '{}')); } catch { return { checks: [], complete: false }; }
  if (raw.access_authority !== authority) return { checks: [], complete: true };
  if (raw.access_checks === undefined) return { checks: [], complete: raw.access_checks_complete !== false };
  if (!Array.isArray(raw.access_checks) || raw.access_checks.length > MAX_CHECKS + MAX_RECENT_CHECKS) return { checks: [], complete: false };
  const checks: ConnectionAccessCheck[] = [];
  for (const value of raw.access_checks) {
    const check = record(value);
    if (!isConnectionAccessKey(check.key) || !['ok', 'auth_failed', 'unreachable'].includes(String(check.status))
      || typeof check.at !== 'number' || !Number.isSafeInteger(check.at) || check.at < 0 || check.at > 8_640_000_000_000_000
      || check.recent !== undefined && (check.recent !== true || check.status !== 'ok')
      || checks.some(c => c.key === check.key)) return { checks: [], complete: false };
    checks.push({ key: check.key, at: check.at, status: check.status as ConnectionAccessCheck['status'], ...(check.recent ? { recent: true } : {}) });
  }
  if (checks.filter(check => !check.recent).length > MAX_CHECKS || checks.filter(check => check.recent).length > MAX_RECENT_CHECKS) {
    return { checks: [], complete: false };
  }
  return { checks, complete: raw.access_checks_complete !== false };
};
export const recordConnectionAccessEvidence = (json: string | undefined, authority: string, observation?: ConnectionAccessCheck & { verified: boolean }): {
  access_authority: string; access_checks?: ConnectionAccessCheck[]; access_checks_complete?: boolean;
} => {
  const previous = readConnectionAccessEvidence(json, authority); let complete = previous.complete;
  const checks = new Map(previous.checks.map(c => [c.key, c]));
  if (observation && isConnectionAccessKey(observation.key)) {
    const old = checks.get(observation.key);
    // Recent successes fence delayed failures, including success before the
    // first observed failure. They have their own bounded retention allowance.
    if ((!old || connectionAccessObservationWins(old, observation)) && (observation.status !== 'ok' || observation.verified)) {
      checks.set(observation.key, { key: observation.key, status: observation.status, at: observation.at,
        ...(observation.status === 'ok' && (!old || old.recent) ? { recent: true } : {}) });
    }
  }
  const ordered = [...checks.values()].filter(check => !check.recent)
    .sort((a, b) => Number(b.status !== 'ok') - Number(a.status !== 'ok') || b.at - a.at || a.key.localeCompare(b.key));
  const recent = [...checks.values()].filter(check => check.recent).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)).slice(0, MAX_RECENT_CHECKS);
  if (ordered.slice(MAX_CHECKS).some(c => c.status !== 'ok')) complete = false;
  // Explicit undefined fields remove an old authority's history when this is
  // merged into newer scalar health. JSON persistence omits the empty fields.
  const retained = [...ordered.slice(0, MAX_CHECKS), ...recent];
  return { access_authority: authority, access_checks: retained.length || !complete ? retained : undefined,
    access_checks_complete: retained.length || !complete ? complete : undefined };
};
