/** Owner view settings in the realm database; its normal encryption/backup applies. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  RpcError, SAVED_DATA_VIEW_LIMIT, SAVED_DATA_VIEW_NAME_LIMIT,
  parseSavedDataViewDefinition, parseSavedDataViewAlertSettings, sameSavedDataViewDefinition, savedDataViewSupportsAlerts, type SavedDataView,
  type SavedDataViewCreateRequest, type SavedDataViewRenameRequest,
  type SavedDataViewDeleteRequest, type SavedDataViewUpdateRequest,
} from '@recued/contracts';
import { createSavedDataViewAlertStore, type SavedDataViewAlertStore, type SavedDataViewMatchReader } from './saved-data-view-alert-store.js';

export interface SavedDataViewStore {
  alerts: SavedDataViewAlertStore;
  list(): SavedDataView[];
  get(id: string): SavedDataView | null;
  create(request: SavedDataViewCreateRequest): SavedDataView;
  update(request: SavedDataViewUpdateRequest): SavedDataView;
  rename(request: SavedDataViewRenameRequest): SavedDataView;
  delete(request: SavedDataViewDeleteRequest): void;
}

const nameOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > SAVED_DATA_VIEW_NAME_LIMIT
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RpcError('bad_request', `View name must be 1–${SAVED_DATA_VIEW_NAME_LIMIT} characters.`, 400);
  }
  return value.trim();
};
const requireId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^view_[a-f0-9-]{36}$/.test(id)) {
    throw new RpcError('bad_request', 'Invalid saved view id.', 400);
  }
  return id;
};
const decode = (row: unknown): SavedDataView | null => {
  if (row === undefined) return null;
  const stored = row as { data: string };
  const parsed: SavedDataView = JSON.parse(stored.data);
  const definition = parseSavedDataViewDefinition(parsed.definition);
  if (definition === null) throw new RpcError('bad_request', 'This saved view is not supported by this server version.', 400);
  return { ...parsed, definition };
};

export const createSavedDataViewStore = (
  db: Database.Database,
  options: { readTasks?: SavedDataViewMatchReader; readRecords?: SavedDataViewMatchReader; now?: () => number } = {},
): SavedDataViewStore => {
  db.exec('CREATE TABLE IF NOT EXISTS saved_data_views (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)');
  const alerts = createSavedDataViewAlertStore(db, { task: options.readTasks, records: options.readRecords }, options.now);
  const get = (id: string): SavedDataView | null =>
    decode(db.prepare('SELECT data FROM saved_data_views WHERE id = ?').get(requireId(id)));
  const write = (view: SavedDataView): void => {
    db.prepare('UPDATE saved_data_views SET data = ? WHERE id = ?').run(JSON.stringify(view), view.id);
  };
  const current = (request: SavedDataViewDeleteRequest): SavedDataView => {
    const view = get(request.id);
    if (view === null) throw new RpcError('not_found', 'This saved view was deleted. Refresh your saved views.', 404);
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision !== view.revision) {
      throw new RpcError('conflict', 'This saved view changed in another browser. Refresh it before trying again.', 409);
    }
    return view;
  };
  return {
    alerts,
    get,
    list: () => db.prepare('SELECT data FROM saved_data_views ORDER BY id').all()
      .map((row) => decode(row)!).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    create: db.transaction((request: SavedDataViewCreateRequest) => {
      const name = nameOf(request.name);
      const definition = parseSavedDataViewDefinition(request.definition);
      if (definition === null) throw new RpcError('bad_request', 'Invalid saved view settings.', 400);
      const count = db.prepare('SELECT COUNT(*) AS count FROM saved_data_views').get() as { count: number };
      if (count.count >= SAVED_DATA_VIEW_LIMIT) throw new RpcError('bad_request', `You can save up to ${SAVED_DATA_VIEW_LIMIT} views. Delete a view to make room.`, 400);
      const now = Date.now();
      const view: SavedDataView = { id: `view_${randomUUID()}`, name, definition, revision: 1, created_at: now, updated_at: now };
      db.prepare('INSERT INTO saved_data_views (id, data) VALUES (?, ?)').run(view.id, JSON.stringify(view));
      return view;
    }),
    update: db.transaction((request: SavedDataViewUpdateRequest) => {
      const view = current(request);
      if (!Object.hasOwn(request, 'definition') && !Object.hasOwn(request, 'alert')) {
        throw new RpcError('bad_request', 'Provide saved view settings or alert settings.', 400);
      }
      const definition = Object.hasOwn(request, 'definition')
        ? parseSavedDataViewDefinition(request.definition) : view.definition;
      if (definition === null) throw new RpcError('bad_request', 'Invalid saved view settings.', 400);
      const updated: SavedDataView = { ...view, definition, revision: view.revision + 1, updated_at: Date.now() };
      if (Object.hasOwn(request, 'alert')) {
        const settings = parseSavedDataViewAlertSettings(request.alert);
        if (settings === null) throw new RpcError('bad_request', 'Invalid alert settings.', 400);
        updated.alert = alerts.configure(updated, settings);
      } else if (!savedDataViewSupportsAlerts(definition)) {
        delete updated.alert;
        alerts.clear(view.id);
      } else if (view.alert?.enabled && !sameSavedDataViewDefinition(view.definition, definition)) {
        updated.alert = alerts.configure(updated, view.alert);
      }
      write(updated);
      return updated;
    }),
    rename: db.transaction((request: SavedDataViewRenameRequest) => {
      const view = current(request);
      const renamed = { ...view, name: nameOf(request.name), revision: view.revision + 1, updated_at: Date.now() };
      write(renamed);
      return renamed;
    }),
    delete: db.transaction((request: SavedDataViewDeleteRequest) => {
      current(request);
      alerts.clear(request.id);
      db.prepare('DELETE FROM saved_data_views WHERE id = ?').run(request.id);
    }),
  };
};
