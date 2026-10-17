import type Database from 'better-sqlite3';

/** One insertion order for passive incidents, repairs and explicit check receipts. */
export const ensureAuthenticationHistorySchema = (db: Database.Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS authentication_incident_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL,
      ended_at INTEGER, signature TEXT NOT NULL, data TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'incident');
    CREATE INDEX IF NOT EXISTS idx_auth_incidents_group ON authentication_incident_history(group_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_auth_incidents_ended ON authentication_incident_history(ended_at);
    CREATE TABLE IF NOT EXISTS authentication_incident_targets (incident_id TEXT NOT NULL, scope_key TEXT NOT NULL,
      PRIMARY KEY (incident_id, scope_key));
    CREATE INDEX IF NOT EXISTS idx_auth_incident_scope ON authentication_incident_targets(scope_key, incident_id);
    CREATE TABLE IF NOT EXISTS authentication_repair_incidents (repair_id TEXT NOT NULL, incident_id TEXT NOT NULL,
      group_id TEXT NOT NULL, PRIMARY KEY (repair_id, incident_id));
    CREATE INDEX IF NOT EXISTS idx_auth_repair_incident_group ON authentication_repair_incidents(group_id, repair_id);
    CREATE TABLE IF NOT EXISTS authentication_history_groups (entry_id TEXT NOT NULL, group_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, group_id));
    CREATE INDEX IF NOT EXISTS idx_auth_history_group ON authentication_history_groups(group_id, entry_id);`);
  const columns = db.prepare('PRAGMA table_info(authentication_incident_history)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'kind')) db.exec("ALTER TABLE authentication_incident_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'incident'");
};
