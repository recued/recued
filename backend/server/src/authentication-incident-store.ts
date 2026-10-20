import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, oauthAppSecretExpiry, isAuthenticationIncidentHistoryQuery, authenticationIncidentScope,
  authenticationIncidentHistoryFilters, authenticationHistoryEntryMatches,
  isAuthenticationHistoryExportQuery, authenticationHistoryExportRecord, authenticationHistoryEntryType, authenticationHistoryEntryOutcome,
  AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES, AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES,
  type AuthenticationHistoryExportQuery, type AuthenticationHistoryExport,
  type AuthenticationIncident, type AuthenticationIncidentHistoryQuery, type AuthenticationIncidentHistoryPage,
  type AuthenticationIncidentScope, type AuthenticationIncidentLevel, type AuthenticationRepairAction,
  type AuthenticationIncidentHistoryFilters, type AuthenticationHistoryEntry } from '@recued/contracts';
import type { Episode } from './authentication-alert-store.js';
import { ensureAuthenticationHistorySchema } from './authentication-history-schema.js';

const RETENTION_DAYS = 90;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: AuthenticationIncidentScope): string => JSON.stringify(authenticationIncidentScope(scope));
const scopeHash = (scope: AuthenticationIncidentScope, renewals = false, filters: AuthenticationIncidentHistoryFilters = {}): string => {
  const base = renewals ? JSON.stringify([scopeKey(scope), 'renewals']) : scopeKey(scope);
  return digest(Object.keys(filters).length ? JSON.stringify([base, 'filters-v1', filters]) : base);
};
const unique = <T>(values: readonly T[], key: (v: T) => string): T[] => [...new Map(values.map(v => [key(v), v])).values()];
const incidentLevel = (episode: Episode, now: number, previous?: AuthenticationIncident): AuthenticationIncidentLevel => {
  // A closed alert retains its last known classification. Importing it later
  // must not create a new expiry warning using the import date.
  if (episode.status !== 'open') return previous?.level ?? episode.last_level
    ?? (episode.issues.some(i => i.code === 'credential_rejected') ? 'rejected' : 'review');
  if (episode.expiry_date) {
    const expiry = oauthAppSecretExpiry({ secret_expires_on: episode.expiry_date }, now);
    if (expiry.status === 'past_due' || expiry.status === 'due_today') return 'expiry_passed';
    if (expiry.status === 'due_soon') return expiry.days_remaining <= 7 ? 'expiry_7' : 'expiry_30';
  }
  return episode.group.issues.length ? episode.group.issues.some(i => i.code === 'credential_rejected') ? 'rejected' : 'review'
    : previous?.level ?? episode.last_level ?? 'review';
};

/** Separate retained history from the mutable, short-lived alert dedup state.
 * Every write is called inside that state's SQLite transaction. No credential,
 * resource hash, raw provider error or notification delivery claim is copied. */
export const createAuthenticationIncidentStore = (db: Database.Database) => {
  ensureAuthenticationHistorySchema(db);
  const candidates = (scope: AuthenticationIncidentScope, filters: AuthenticationIncidentHistoryFilters, renewals: boolean, before: number, now: number) => {
    const predicate = scope.kind === 'all' ? '' : scope.kind === 'group' ? ` AND (h.group_id = @group_id OR EXISTS
      (SELECT 1 FROM authentication_repair_incidents r WHERE r.repair_id = h.id AND r.group_id = @group_id) OR EXISTS
      (SELECT 1 FROM authentication_history_groups g WHERE g.entry_id = h.id AND g.group_id = @group_id))`
      : ' AND EXISTS (SELECT 1 FROM authentication_incident_targets t WHERE t.incident_id = h.id AND t.scope_key = @scope_key)';
    return db.prepare(`SELECT h.sequence, h.id, h.kind, h.data FROM authentication_incident_history h WHERE h.sequence < @before
      AND (h.ended_at IS NULL OR h.ended_at >= @cutoff)${renewals ? '' : " AND h.kind <> 'renewal'"}${predicate}
      ${filters.type ? ' AND h.kind = @kind' : ''} ORDER BY h.sequence DESC`)
      .iterate({ before, cutoff: now - RETENTION_DAYS * 86_400_000, group_id: scope.kind === 'group' ? scope.id : null,
        scope_key: scopeKey(scope), ...(filters.type ? { kind: filters.type } : {}) }) as Iterable<{ sequence: number; id: string; kind: string; data: string }>;
  };
  return {
    record(episode: Episode, now: number, onlyIfMissing = false): void {
      const stored = db.prepare('SELECT data, signature FROM authentication_incident_history WHERE id = ?').get(episode.id) as { data: string; signature: string } | undefined;
      const oldSignature = stored && (/^[a-f0-9]{64}$/.test(stored.signature) ? stored.signature : digest(stored.signature));
      if (stored && onlyIfMissing) {
        if (oldSignature !== stored.signature) db.prepare('UPDATE authentication_incident_history SET signature = ? WHERE id = ?').run(oldSignature, episode.id);
        return;
      }
      const old = stored ? JSON.parse(stored.data) as AuthenticationIncident : undefined;
      const g = episode.group;
      const names = unique([...(old?.group.connection_names ?? []), ...g.connection_names], v => v);
      const uses = unique([...(old?.group.uses ?? []), ...g.uses], u => JSON.stringify([u.kind, u.id]));
      const targets = unique([...(old?.group.targets ?? []), ...g.targets], t => JSON.stringify(t));
      const issues = unique([...(old?.group.issues ?? []), ...episode.issues, ...g.issues], i => i.id);
      const current = episode.status === 'open' && episode.present;
      const level = incidentLevel(episode, now, old);
      const signature = digest(JSON.stringify([current, level, g.label, g.authentication, g.connection_names, g.uses, g.usage_available, g.targets,
        g.issues.map(i => [i.id, i.code, i.secret_expires_on ?? null])]));
      const events = [...old?.events ?? []];
      const at = Math.max(now, episode.first_seen_at, events.at(-1)?.at ?? 0);
      const kind = !old ? episode.first_seen_at === now && episode.status === 'open' ? 'opened' : 'recorded'
        : old.status !== episode.status ? episode.status === 'recovered' ? 'recovered' : 'retired'
        : old.currently_reported && !current && episode.status === 'open' ? 'awaiting_confirmation'
        : oldSignature !== signature ? 'changed' : undefined;
      if (kind) events.push({ kind, at, level });
      // A legacy closed row's last_seen_at is its closure time, not a retained
      // negative observation. Keep that date unknown instead of inventing it.
      const lastProblem = current || !old && episode.status === 'open'
        ? Math.max(episode.first_seen_at, episode.last_seen_at, old?.last_problem_at ?? 0) : old?.last_problem_at;
      const ended = episode.status === 'open' ? undefined
        : Math.max(episode.first_seen_at, episode.last_seen_at, lastProblem ?? 0, old?.events.at(-1)?.at ?? 0);
      const checks = episode.required_checks ?? [];
      const recoveryEvidence = episode.status === 'recovered' && !episode.verification_incomplete && !episode.removed_uses && ended !== undefined && checks.length
        && checks.every(check => Number.isSafeInteger(check.succeeded_at) && check.succeeded_at! > Math.max(episode.first_seen_at, check.failed_at) && check.succeeded_at! <= ended)
        ? { earliest_at: Math.min(...checks.map(check => check.succeeded_at!)), latest_at: Math.max(...checks.map(check => check.succeeded_at!)) } : undefined;
      const incident: AuthenticationIncident = {
        id: episode.id, status: episode.status, started_at: episode.first_seen_at,
        ...(lastProblem === undefined ? {} : { last_problem_at: lastProblem }),
        history_started_at: old?.history_started_at ?? at,
        ...(ended === undefined ? {} : { ended_at: ended }),
        ...(recoveryEvidence ? { recovery_evidence: recoveryEvidence } : {}),
        ...(episode.status === 'retired' ? { retirement_reason: episode.retirement_reason ?? (episode.expiry_date ? 'expiry_changed_or_removed' : 'use_removed_or_changed') } : {}),
        currently_reported: current, level,
        group: { id: g.id, kind: g.kind, label: g.label, authentication: g.authentication,
          connection_names: names.slice(0, 64), issues: issues.slice(0, 32), uses: uses.slice(0, 50),
          usage_available: g.usage_available && (old?.group.usage_available ?? true), targets: targets.slice(0, 64) },
        events: events.length > 32 ? [events[0]!, ...events.slice(-31)] : events,
        events_truncated: old?.events_truncated === true || events.length > 32,
        details_truncated: old?.details_truncated === true || names.length > 64 || issues.length > 32 || uses.length > 50 || targets.length > 64,
      };
      db.prepare(`INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, signature = excluded.signature, data = excluded.data`)
        .run(incident.id, g.id, incident.ended_at ?? null, signature, JSON.stringify(incident));
      // Retain exact target associations even when the displayed use list is bounded.
      const add = db.prepare('INSERT OR IGNORE INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)');
      for (const target of g.targets) add.run(incident.id, scopeKey(target));
      for (const name of g.connection_names) add.run(incident.id, scopeKey({ kind: 'connection', name }));
    },
    prune(now: number): void {
      db.prepare('DELETE FROM authentication_incident_history WHERE ended_at IS NOT NULL AND ended_at < ?').run(now - RETENTION_DAYS * 86_400_000);
      db.exec(`DELETE FROM authentication_incident_history WHERE sequence IN
        (SELECT sequence FROM authentication_incident_history WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, sequence DESC LIMIT -1 OFFSET 10000);
        DELETE FROM authentication_incident_targets WHERE incident_id NOT IN (SELECT id FROM authentication_incident_history);
        DELETE FROM authentication_repair_incidents WHERE repair_id NOT IN (SELECT id FROM authentication_incident_history);
        DELETE FROM authentication_history_groups WHERE entry_id NOT IN (SELECT id FROM authentication_incident_history);`);
    },
    history(query: AuthenticationIncidentHistoryQuery, now = Date.now()): AuthenticationIncidentHistoryPage {
      if (!isAuthenticationIncidentHistoryQuery(query)) throw new RpcError('bad_request', 'Choose a valid incident history filter and page.');
      const scope = authenticationIncidentScope(query.scope);
      const filters = authenticationIncidentHistoryFilters(query.filters); const filtered = Object.keys(filters).length > 0;
      let before = Number.MAX_SAFE_INTEGER;
      if (query.cursor) {
        try {
          const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
          if (!value || typeof value !== 'object' || !('before' in value) || !Number.isSafeInteger(value.before) || Number(value.before) <= 0
            || !('scope' in value) || value.scope !== scopeHash(scope, query.include_renewals, filters)) throw new Error('cursor');
          before = Number(value.before);
        } catch { throw new RpcError('bad_request', 'This history page is invalid for the selected connection. Refresh the history.'); }
      }
      const limit = query.limit ?? 20;
      const rows: Array<{ sequence: number; id: string; kind: string; data: string }> = [];
      // Scan retained candidates before paging, stopping after one lookahead
      // match. Never filter only a fetched page or load the whole corpus into memory.
      for (const row of candidates(scope, filters, query.include_renewals === true, before, now)) {
        if (filtered && !authenticationHistoryEntryMatches(JSON.parse(row.data) as AuthenticationHistoryEntry, filters)) continue;
        rows.push(row); if (rows.length > limit) break;
      }
      const page = rows.slice(0, limit);
      const repair = (row: { data: string }): AuthenticationRepairAction => {
        const value = JSON.parse(row.data) as AuthenticationRepairAction;
        // A saved change is not recovery. Read only later, explicitly recovered
        // incident receipts, requiring every exact association to remain known.
        if (value.status === 'applied' && value.finished_at !== undefined && value.incidents.length && !value.incidents_truncated) {
          const related = db.prepare<[string], { data: string | null }>(`SELECT h.data FROM authentication_repair_incidents r
            LEFT JOIN authentication_incident_history h ON h.id = r.incident_id AND h.kind = 'incident' WHERE r.repair_id = ?`).all(value.id);
          const incidents = related.map(r => r.data ? JSON.parse(r.data) as AuthenticationIncident : undefined);
          const finished = value.finished_at;
          if (incidents.length === value.incidents.length && incidents.every(i => i?.status === 'recovered' && i.recovery_evidence !== undefined && i.recovery_evidence.earliest_at > finished)) {
            value.recovery_confirmed_at = Math.max(...incidents.map(i => i!.recovery_evidence!.latest_at));
          }
        }
        return value;
      };
      return { scope, ...(filtered ? { filters } : {}), observed_at: now, incidents: page.filter(row => row.kind === 'incident').map(row => JSON.parse(row.data) as AuthenticationIncident),
        repairs: page.filter(row => row.kind === 'repair').map(repair),
        verifications: page.filter(row => row.kind === 'verification').map(row => JSON.parse(row.data) as import('@recued/contracts').AuthenticationAccessVerification),
        ...(query.include_renewals ? { renewals: page.filter(row => row.kind === 'renewal').map(row => JSON.parse(row.data) as import('@recued/contracts').AuthenticationRenewalHistory) } : {}),
        order: page.map(row => row.id), retention_days: RETENTION_DAYS,
        ...(rows.length > limit ? { next_cursor: Buffer.from(JSON.stringify({ before: page.at(-1)!.sequence, scope: scopeHash(scope, query.include_renewals, filters) })).toString('base64url') } : {}) };
    },
    export(query: AuthenticationHistoryExportQuery, now = Date.now()): AuthenticationHistoryExport {
      if (!isAuthenticationHistoryExportQuery(query)) throw new RpcError('bad_request', 'Choose a valid history scope and filters to export.');
      const scope = authenticationIncidentScope(query.scope); const filters = authenticationIncidentHistoryFilters(query.filters);
      const entries: AuthenticationHistoryExport['entries'] = []; let bytes = 0;
      const tooLarge = (): never => { throw new RpcError('payload_too_large', 'This history export is too large. Narrow the applied filters and try again.', 413); };
      // One SELECT holds a SQLite read snapshot until its iterator closes. No
      // paged RPC traversal, current-auth projection, credential decode or writes.
      for (const row of candidates(scope, filters, true, Number.MAX_SAFE_INTEGER, now)) {
        if (Buffer.byteLength(row.data, 'utf8') > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) tooLarge();
        let record: AuthenticationHistoryEntry | null;
        try { record = authenticationHistoryExportRecord(JSON.parse(row.data)); }
        catch { record = null; }
        if (!record || record.id !== row.id || authenticationHistoryEntryType(record) !== row.kind) {
          throw new RpcError('internal_error', 'Retained history could not be exported. No partial report was created.');
        }
        if (!authenticationHistoryEntryMatches(record, filters)) continue;
        const entry = { type: authenticationHistoryEntryType(record), outcome: authenticationHistoryEntryOutcome(record), record };
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (entries.length >= AUTHENTICATION_HISTORY_EXPORT_MAX_ENTRIES || bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) tooLarge();
        entries.push(entry);
      }
      const report: AuthenticationHistoryExport = { format: 'recued.connection-history', version: 1, exported_at: now, scope, filters,
        retention_days: 90, finished_record_limit: 10000, complete: true, evidence: 'retained_local_observations', current_authentication: 'not_checked',
        entry_count: entries.length, entries };
      if (Buffer.byteLength(JSON.stringify(report), 'utf8') > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) tooLarge();
      return report;
    },
  };
};
