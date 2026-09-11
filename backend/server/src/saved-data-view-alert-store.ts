/** Durable membership transitions and pending owner notifications. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RpcError, type SavedDataView, type SavedDataViewAlert, type SavedDataViewAlertSettings,
} from '@recued/contracts';
import type { SavedTaskViewReader } from './saved-data-view-task-reader.js';

export interface SavedDataViewAlertNotice {
  id: string;
  view_id: string;
  view_name: string;
  count: number;
  /** Bounded notification preview; the complete result stays in Data. */
  titles: string[];
  created_at: number;
}
export interface SavedDataViewAlertStore {
  clear(view_id: string): void;
  configure(view: SavedDataView, settings: SavedDataViewAlertSettings): SavedDataViewAlert;
  evaluate(): void;
  pending(): SavedDataViewAlertNotice[];
  claim(id: string): boolean;
}

export const createSavedDataViewAlertStore = (
  db: Database.Database,
  readTasks: SavedTaskViewReader | undefined,
  now: () => number = Date.now,
): SavedDataViewAlertStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS saved_data_view_alert_members (
    view_id TEXT PRIMARY KEY NOT NULL, members TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS saved_data_view_alert_notices (
    id TEXT PRIMARY KEY NOT NULL, view_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_saved_view_alert_notices_view ON saved_data_view_alert_notices(view_id);`);
  const clear = (view_id: string): void => {
    db.prepare('DELETE FROM saved_data_view_alert_members WHERE view_id = ?').run(view_id);
    db.prepare('DELETE FROM saved_data_view_alert_notices WHERE view_id = ?').run(view_id);
  };
  const writeMembers = (view_id: string, members: string[]): void => {
    db.prepare('INSERT OR REPLACE INTO saved_data_view_alert_members (view_id, members) VALUES (?, ?)')
      .run(view_id, JSON.stringify(members));
  };
  const writeView = (view: SavedDataView): void => {
    db.prepare('UPDATE saved_data_views SET data = ? WHERE id = ?').run(JSON.stringify(view), view.id);
  };
  return {
    clear,
    /** Runs inside the settings write transaction. Enabling/resuming and
     * changing filters establish their baseline before the RPC returns. */
    configure(view: SavedDataView, settings: SavedDataViewAlertSettings): SavedDataViewAlert {
      if (view.definition.tab !== 'task') throw new RpcError('bad_request', 'Alerts are available for task views only.', 400);
      if (!settings.enabled) {
        clear(view.id);
        return { ...settings, status: 'paused', last_checked_at: view.alert?.last_checked_at ?? null,
          last_notified_at: view.alert?.last_notified_at ?? null };
      }
      if (!readTasks) throw new RpcError('not_configured', 'Task alerts are unavailable on this server.', 503);
      const checked = now();
      let members: string[];
      try { members = readTasks(view.definition, settings.time_zone, checked).map(task => task.id); }
      catch { throw new RpcError('bad_request', 'The saved task source is unavailable for alerts. Refresh its source before enabling alerts.', 400); }
      clear(view.id);
      writeMembers(view.id, members);
      return { ...settings, status: 'watching', last_checked_at: checked,
        last_notified_at: view.alert?.last_notified_at ?? null };
    },
    evaluate(): void {
      const rows = db.prepare(`SELECT id FROM saved_data_views WHERE json_extract(data, '$.alert.enabled') = 1`)
        .all() as Array<{ id: string }>;
      for (const { id } of rows) {
        db.transaction(() => {
          const row = db.prepare('SELECT data FROM saved_data_views WHERE id = ?').get(id) as { data: string } | undefined;
          if (!row) return;
          const view: SavedDataView = JSON.parse(row.data);
          if (!view.alert?.enabled) return;
          let matches: ReturnType<SavedTaskViewReader>;
          const checked = now();
          try {
            if (!readTasks) throw new Error('Task reader unavailable');
            matches = readTasks(view.definition, view.alert.time_zone, checked);
          } catch {
            // Keep the last successful membership through source outages.
            writeView({ ...view, alert: { ...view.alert, status: 'unavailable' } });
            return;
          }
          const prior = db.prepare('SELECT members FROM saved_data_view_alert_members WHERE view_id = ?')
            .get(id) as { members: string } | undefined;
          const members = matches.map(task => task.id);
          const before = new Set<string>(prior ? JSON.parse(prior.members) : members);
          const entered = matches.filter(task => !before.has(task.id));
          const count = entered.length;
          if (count > 0) {
            const notice: SavedDataViewAlertNotice = { id: `saved-view-alert:${randomUUID()}`,
              view_id: view.id, view_name: view.name, count, created_at: checked,
              titles: entered.slice(0, 3).map(task => task.title.slice(0, 160)) };
            db.prepare('INSERT INTO saved_data_view_alert_notices (id, view_id, data) VALUES (?, ?, ?)')
              .run(notice.id, id, JSON.stringify(notice));
          }
          writeMembers(id, members);
          writeView({ ...view, alert: { ...view.alert, status: 'watching', last_checked_at: checked } });
        }).immediate();
      }
    },
    pending(): SavedDataViewAlertNotice[] {
      return (db.prepare('SELECT data FROM saved_data_view_alert_notices ORDER BY rowid').all() as Array<{ data: string }>)
        .map(row => JSON.parse(row.data) as SavedDataViewAlertNotice);
    },
    /** Claim after durable notification-history persistence, before any push.
     * Push is best-effort and attempted at most once, even across restarts. */
    claim: db.transaction((id: string): boolean => {
      const row = db.prepare('SELECT view_id FROM saved_data_view_alert_notices WHERE id = ?').get(id) as { view_id: string } | undefined;
      if (!row) return false;
      const stored = db.prepare('SELECT data FROM saved_data_views WHERE id = ?').get(row.view_id) as { data: string } | undefined;
      if (!stored) return false;
      const view: SavedDataView = JSON.parse(stored.data);
      if (!view.alert?.enabled) return false;
      db.prepare('DELETE FROM saved_data_view_alert_notices WHERE id = ?').run(id);
      writeView({ ...view, alert: { ...view.alert, last_notified_at: now() } });
      return true;
    }).immediate,
  };
};
