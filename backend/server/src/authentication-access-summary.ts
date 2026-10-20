/** Local index and projection of retained access attempts; no provider operations. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { authenticationIncidentScope, isAuthenticationAccessVerification, isAuthenticationAccessSummary,
  type AuthenticationAccessSummary, type AuthenticationAccessSummaryTarget, type AuthenticationAccessVerification,
  type AuthenticationAccessSelection, type AuthenticationRepairTarget } from '@recued/contracts';
import type { PreparedAuthenticationAccess } from './authentication-access-verification.js';

const key = (target: AuthenticationRepairTarget): string => JSON.stringify(authenticationIncidentScope(target));
const id = (target: AuthenticationRepairTarget): string => createHash('sha256').update(JSON.stringify(key(target))).digest('hex');
const canonical = (target: AuthenticationRepairTarget): AuthenticationRepairTarget => {
  const scope = authenticationIncidentScope(target);
  if (scope.kind === 'all' || scope.kind === 'group') throw new Error('Invalid access resource target');
  return scope;
};
const label = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2048) || 'Saved account';
export interface AuthenticationAccessSummaryInput {
  selection: AuthenticationAccessSelection; targets: AuthenticationRepairTarget[]; targets_truncated?: boolean;
}
export type AuthenticationAccessComparison = (target: AuthenticationRepairTarget) => Promise<PreparedAuthenticationAccess['descriptor'] | undefined>;
/** One bounded local comparison scope for a whole response, including legacy DTOs. */
export const createAuthenticationAccessComparison = (prepare: (target: AuthenticationRepairTarget) => Promise<PreparedAuthenticationAccess>): AuthenticationAccessComparison => {
  const pending = new Map<string, ReturnType<AuthenticationAccessComparison>>();
  return target => {
    const resource = key(target); const existing = pending.get(resource); if (existing) return existing;
    if (pending.size >= 512) return Promise.resolve(undefined);
    const comparison = Promise.resolve().then(() => prepare(target)).then(p => p.descriptor, () => undefined);
    pending.set(resource, comparison); return comparison;
  };
};
export const createAuthenticationAccessSummaries = (deps: {
  db: Database.Database; now(): number; prepare(target: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess>;
}) => {
  const db = deps.db;
  db.exec(`CREATE TABLE IF NOT EXISTS authentication_access_targets (
    verification_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (verification_id, target_id));
    CREATE INDEX IF NOT EXISTS idx_auth_access_target ON authentication_access_targets(target_id, verification_id);`);
  const insert = db.prepare('INSERT OR IGNORE INTO authentication_access_targets (verification_id, target_id) VALUES (?, ?)');
  const register: (value: AuthenticationAccessVerification) => void = db.transaction((value: AuthenticationAccessVerification): void => {
    if (!isAuthenticationAccessVerification(value) || value.results.some(r => r.id !== id(r.target))) throw new Error('Invalid indexed access receipt');
    for (const row of value.results) insert.run(value.id, row.id);
  });
  const unindexed = new Set<string>();
  // Backfill only retained receipts missing the index. Reservation writes all
  // target entries in the same transaction as the job, so a partial index cannot
  // be created by an interrupted reservation. Never replay a check during boot.
  db.transaction(() => {
    const rows = db.prepare(`SELECT id, data FROM authentication_access_verifications v WHERE (finished_at IS NULL OR finished_at >= ?)
      AND NOT EXISTS (SELECT 1 FROM authentication_access_targets t WHERE t.verification_id = v.id)`)
      .all(deps.now() - 90 * 86_400_000) as { id: string; data: string }[];
    for (const row of rows) {
      try {
        const value: unknown = JSON.parse(row.data);
        if (!isAuthenticationAccessVerification(value) || value.id !== row.id) throw new Error('Unreadable access receipt');
        register(value);
      } catch { unindexed.add(row.id); }
    }
  })();
  const indexAvailable = (): boolean => {
    // A bad legacy row blocks unknown target coverage only while it remains
    // retained and unindexed. Expiry/pruning must not require a server restart.
    const ids = [...unindexed];
    for (let start = 0; start < ids.length; start += 256) {
      const chunk = ids.slice(start, start + 256);
      const rows = db.prepare(`SELECT id FROM authentication_access_verifications v WHERE id IN (${chunk.map(() => '?').join(',')})
        AND (finished_at IS NULL OR finished_at >= ?) AND NOT EXISTS (SELECT 1 FROM authentication_access_targets t WHERE t.verification_id = v.id)`)
        .all(...chunk, deps.now() - 90 * 86_400_000) as { id: string }[];
      const retained = new Set(rows.map(r => r.id)); for (const id of chunk) if (!retained.has(id)) unindexed.delete(id);
    }
    return !unindexed.size;
  };
  const lookup = (ids: string[]): Map<string, { id: string; data: string }> => {
    const found = new Map<string, { id: string; data: string }>();
    for (let start = 0; start < ids.length; start += 256) {
      const chunk = ids.slice(start, start + 256);
      const rows = db.prepare(`WITH latest AS (
        SELECT t.target_id, MAX(v.sequence) AS sequence FROM authentication_access_targets t
        JOIN authentication_access_verifications v ON v.id = t.verification_id
        WHERE t.target_id IN (${chunk.map(() => '?').join(',')}) AND (v.finished_at IS NULL OR v.finished_at >= ?)
        GROUP BY t.target_id)
        SELECT latest.target_id, v.id, v.data FROM latest JOIN authentication_access_verifications v ON v.sequence = latest.sequence`)
        .all(...chunk, deps.now() - 90 * 86_400_000) as { target_id: string; id: string; data: string }[];
      for (const row of rows) found.set(row.target_id, { id: row.id, data: row.data });
    }
    return found;
  };
  return {
    register,
    prune(): void { db.exec('DELETE FROM authentication_access_targets WHERE verification_id NOT IN (SELECT id FROM authentication_access_verifications)'); },
    async project(inputs: AuthenticationAccessSummaryInput[], compare = createAuthenticationAccessComparison(deps.prepare)): Promise<AuthenticationAccessSummary[]> {
      const plans = inputs.map(input => {
        const targets = [...new Map(input.targets.filter(t => t.kind !== 'oauth_apps').map(t => [key(t), t])).values()];
        return { ...input, targets: targets.slice(0, 32), truncated: input.targets_truncated === true || targets.length > 32 };
      });
      const targets = new Map(plans.flatMap(p => p.targets.map(t => [id(t), t] as const)));
      const prepared = new Map<string, PreparedAuthenticationAccess['descriptor']>();
      let found = new Map<string, { id: string; data: string }>(); let available = false;
      try {
        available = indexAvailable();
        if (available) {
          found = lookup([...targets.keys()]);
          // One comparison per distinct target across app/account groups. The
          // request budget is bounded; the rest explicitly remain unknown.
          for (const [targetId, target] of targets) if (found.has(targetId)) {
            const descriptor = await compare(target); if (descriptor) prepared.set(targetId, descriptor);
          }
          // A new job or retention change during local reads must be reflected.
          found = lookup([...targets.keys()]);
        }
      } catch { available = false; }
      const decoded = new Map<string, AuthenticationAccessVerification | null>();
      return plans.map(plan => {
        let incomplete = !available;
        const rows: AuthenticationAccessSummaryTarget[] = plan.targets.map(target => {
          const targetId = id(target); const saved = available ? found.get(targetId) : undefined;
          const descriptor = prepared.get(targetId);
          const resource = canonical(target); if (resource.kind === 'oauth_apps') throw new Error('Invalid access resource target');
          const base = { id: targetId, target: resource,
            label: label(descriptor?.label ?? (target.kind === 'connection' ? 'API: ' + target.name : target.kind === 'collection'
              ? (target.platform === 'mail' ? 'Mail: ' : 'Calendar: ') + target.slug : 'Files: ' + target.source_id)) };
          if (!available) return { ...base, state: 'unavailable' };
          if (!saved) return { ...base, state: 'not_checked' };
          if (!decoded.has(saved.id)) {
            try { const value: unknown = JSON.parse(saved.data); decoded.set(saved.id, isAuthenticationAccessVerification(value) && value.id === saved.id ? value : null); }
            catch { decoded.set(saved.id, null); }
          }
          const value = decoded.get(saved.id); const result = value?.results.find(r => r.id === targetId && key(r.target) === key(target));
          if (!value || !result) { incomplete = true; return { ...base, state: 'unavailable' }; }
          if (!descriptor) incomplete = true;
          return { ...base, label: label(descriptor?.label ?? result.label), state: 'checked', latest: {
            id: value.id, selection: { kind: value.selection.kind, id: value.selection.id }, status: value.status, started_at: value.started_at,
            ...(value.finished_at !== undefined ? { finished_at: value.finished_at } : {}),
            result: { id: result.id, target: canonical(result.target), label: result.label, authentication_revision: result.authentication_revision,
              current: !descriptor ? 'unknown' : descriptor.authentication_revision === result.authentication_revision ? 'yes' : 'no',
              checks: result.checks.map(c => ({ kind: c.kind, status: c.status, ...(c.reason ? { reason: c.reason } : {}) })) },
          } };
        });
        const summary: AuthenticationAccessSummary = { selection: { kind: plan.selection.kind, id: plan.selection.id }, observed_at: deps.now(),
          targets: rows, targets_truncated: plan.truncated, lookup_incomplete: incomplete };
        if (!isAuthenticationAccessSummary(summary)) throw new Error('Invalid access summary');
        return summary;
      });
    },
  };
};
