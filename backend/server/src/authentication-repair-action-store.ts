import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { authenticationIncidentScope, isAuthenticationRepairAction, type AuthenticationRepairAction,
  type AuthenticationRepairTarget, type AuthenticationRepairMethod, type ConnectionAuth } from '@recued/contracts';
import { ensureAuthenticationHistorySchema } from './authentication-history-schema.js';

export type AuthenticationRepairSource = 'connection_credentials' | 'managed_reauthorization' | 'collection_authentication' | 'collection_oauth_app' | 'oauth_app_secret';
export interface AuthenticationRepairStart {
  action: AuthenticationRepairAction['action'];
  targets: readonly AuthenticationRepairTarget[];
  from?: AuthenticationRepairMethod;
  to?: AuthenticationRepairMethod;
  group_ids?: readonly string[];
}
type RepairOutcome = { status: 'applied'; restart_required?: boolean } | { status: 'failed'; reason: NonNullable<AuthenticationRepairAction['reason']> };
export interface AuthenticationRepairActionStore {
  begin(source: AuthenticationRepairSource, attempt: string, input: AuthenticationRepairStart, at: number): void;
  finish(source: AuthenticationRepairSource, attempt: string, outcome: RepairOutcome, at: number): void;
  interrupt(source: AuthenticationRepairSource, at: number): void;
}
const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
export const authenticationAppHistoryGroupId = (issuer: string, id: string): string => hash(JSON.stringify(JSON.stringify(['app', issuer, id])));
const key = (target: AuthenticationRepairTarget): string => JSON.stringify(authenticationIncidentScope(target));
const actionId = (source: AuthenticationRepairSource, attempt: string): string => 'repair-' + hash(JSON.stringify([source, attempt]));
const safeLabel = (value: string | undefined): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
const method = (value: AuthenticationRepairMethod | undefined): AuthenticationRepairMethod | undefined => value && ({ type: value.type,
  ...(safeLabel(value.label) ? { label: value.label } : {}), ...(value.connection_name ? { connection_name: value.connection_name } : {}),
  ...(value.type === 'direct_oauth' && value.app_id ? { app_id: value.app_id } : {}),
  ...(value.type === 'broker' && value.broker_account_id ? { broker_account_id: value.broker_account_id } : {}),
  ...(value.type === 'broker' && value.broker_profile_id ? { broker_profile_id: value.broker_profile_id } : {}) });
export const authenticationRepairMethod = (auth: ConnectionAuth, label?: string): AuthenticationRepairMethod => ({ ...(auth.type === 'managed_oauth'
  ? { type: 'broker' as const, broker_profile_id: auth.broker_profile_id, broker_account_id: auth.connection_id } : auth.type === 'oauth2_refresh'
    ? { type: 'direct_oauth' as const, ...(auth.saved_oauth_app ? { app_id: auth.saved_oauth_app.id } : {}) } : { type: 'other' as const }), ...(label ? { label } : {}) });

/** Whitelisted local receipts only. Caller writes share the original apply transaction. */
export const createAuthenticationRepairActionStore = (db: Database.Database): AuthenticationRepairActionStore => {
  ensureAuthenticationHistorySchema(db);
  const read = (id: string): AuthenticationRepairAction | undefined => {
    const row = db.prepare<[string], { data: string }>("SELECT data FROM authentication_incident_history WHERE kind = 'repair' AND id = ?").get(id);
    return row ? JSON.parse(row.data) as AuthenticationRepairAction : undefined;
  };
  const write = (value: AuthenticationRepairAction, source: AuthenticationRepairSource): void => {
    if (!isAuthenticationRepairAction(value)) throw new Error('Invalid local authentication repair receipt');
    db.prepare(`INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data, kind) VALUES (?, ?, ?, '', ?, 'repair')
      ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, data = excluded.data`)
      .run(value.id, source, value.finished_at ?? null, JSON.stringify(value));
  };
  const finish = db.transaction((source: AuthenticationRepairSource, attempt: string,
    outcome: RepairOutcome, at: number): void => {
    const old = read(actionId(source, attempt)); if (!old || old.status !== 'checking' && old.status !== outcome.status) return;
    const next: AuthenticationRepairAction = { ...old, ...outcome, finished_at: old.finished_at ?? Math.max(old.started_at, at) };
    if (outcome.status === 'applied') {
      delete next.reason; if (outcome.restart_required === undefined) delete next.restart_required;
    } else delete next.restart_required;
    write(next, source);
  });
  return {
    begin: db.transaction((source: AuthenticationRepairSource, attempt: string, input: AuthenticationRepairStart, at: number): void => {
      const id = actionId(source, attempt); if (read(id)) return;
      const targets = [...new Map(input.targets.map(target => [key(target), authenticationIncidentScope(target) as AuthenticationRepairTarget])).values()];
      const linked = new Map<string, { id: string; group_id: string; label: string }>();
      const associate = (rows: { id: string; group_id: string; data: string }[]): void => {
        for (const row of rows) { const incident = JSON.parse(row.data) as { group: { label: string } }; linked.set(row.id, { id: row.id, group_id: row.group_id, label: incident.group.label }); }
      };
      // The saved-app page is a broad navigation target, never an account identity.
      for (const target of targets) if (target.kind !== 'oauth_apps') associate(db.prepare(`SELECT h.id, h.group_id, h.data FROM authentication_incident_history h
        JOIN authentication_incident_targets t ON t.incident_id = h.id WHERE h.kind = 'incident' AND h.ended_at IS NULL AND t.scope_key = ?`).all(key(target)) as { id: string; group_id: string; data: string }[]);
      for (const groupId of input.group_ids ?? []) associate(db.prepare("SELECT id, group_id, data FROM authentication_incident_history WHERE kind = 'incident' AND ended_at IS NULL AND group_id = ?").all(groupId) as { id: string; group_id: string; data: string }[]);
      const incidents = [...linked.values()]; const from = method(input.from); const to = method(input.to);
      write({ id, action: input.action, status: 'checking', started_at: at, ...(from ? { from } : {}), ...(to ? { to } : {}),
        targets: targets.slice(0, 64), targets_truncated: targets.length > 64, incidents: incidents.slice(0, 64), incidents_truncated: incidents.length > 64 }, source);
      const addTarget = db.prepare('INSERT OR IGNORE INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)');
      for (const target of targets) addTarget.run(id, key(target));
      const addIncident = db.prepare('INSERT OR IGNORE INTO authentication_repair_incidents (repair_id, incident_id, group_id) VALUES (?, ?, ?)');
      for (const incident of incidents) addIncident.run(id, incident.id, incident.group_id);
    }),
    finish,
    interrupt(source: AuthenticationRepairSource, at: number): void {
      const rows = db.prepare<[string], { data: string }>("SELECT data FROM authentication_incident_history WHERE kind = 'repair' AND group_id = ? AND ended_at IS NULL").all(source);
      db.transaction(() => { for (const row of rows) {
        const old = JSON.parse(row.data) as AuthenticationRepairAction;
        write({ ...old, status: 'failed', reason: 'interrupted', finished_at: Math.max(old.started_at, at) }, source);
      } })();
    },
  };
};
