/** Token issuance receipts never update incident state or protected-access evidence. */
import type Database from 'better-sqlite3';
import { authenticationIncidentScope, isOAuthAppRenewalVerification, type AuthenticationRenewalHistory,
  type AuthenticationRepairTarget, type OAuthAppRenewalVerification } from '@recued/contracts';
import { authenticationAppHistoryGroupId } from './authentication-repair-action-store.js';
import { ensureAuthenticationHistorySchema } from './authentication-history-schema.js';

/** Caller includes these writes in the renewal reservation/update transaction. */
export const createOAuthAppRenewalHistory = (db: Database.Database) => {
  ensureAuthenticationHistorySchema(db);
  return {
    begin(v: OAuthAppRenewalVerification, at: number, context: {
      groups?: readonly string[]; targets?: readonly AuthenticationRepairTarget[]; references_incomplete?: boolean;
    } = {}): void {
      if (!isOAuthAppRenewalVerification(v)) throw new Error('Invalid OAuth app renewal receipt');
      const group = authenticationAppHistoryGroupId(v.issuer, v.app_id);
      const value: AuthenticationRenewalHistory = { ...v, history_started_at: Math.max(at, v.started_at), references_incomplete: context.references_incomplete === true };
      db.prepare("INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data, kind) VALUES (?, ?, ?, '', ?, 'renewal')")
        .run(v.id, group, v.finished_at ?? null, JSON.stringify(value));
      const targets: AuthenticationRepairTarget[] = [{ kind: 'oauth_apps' }, ...context.targets ?? []];
      for (const r of v.results) {
        for (const name of r.connections) targets.push({ kind: 'connection', name });
        for (const account of r.native_accounts) targets.push({ kind: 'collection', platform: account.platform, slug: account.slug });
      }
      const addTarget = db.prepare('INSERT OR IGNORE INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)');
      for (const t of targets) addTarget.run(v.id, JSON.stringify(authenticationIncidentScope(t)));
      const addGroup = db.prepare('INSERT OR IGNORE INTO authentication_history_groups (entry_id, group_id) VALUES (?, ?)');
      for (const id of context.groups ?? []) addGroup.run(v.id, id);
    },
    update(v: OAuthAppRenewalVerification): void {
      const old = db.prepare<[string], { data: string }>("SELECT data FROM authentication_incident_history WHERE id = ? AND kind = 'renewal'").get(v.id);
      // A retained source receipt must not resurrect history evicted by its shared cap.
      if (!old) return;
      const history = JSON.parse(old.data) as AuthenticationRenewalHistory;
      db.prepare("UPDATE authentication_incident_history SET data = ?, ended_at = ? WHERE id = ? AND kind = 'renewal'")
        .run(JSON.stringify({ ...v, history_started_at: history.history_started_at, references_incomplete: history.references_incomplete === true }), v.finished_at ?? null, v.id);
    },
  };
};
