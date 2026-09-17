/** Browser fixture only. Real database durability/authority is exercised by server tests. */
import { parseSavedDataViewDefinition, parseSavedDataViewAlertSettings, savedDataViewSupportsAlerts, type SavedDataView } from '@recued/contracts';

export const savedViewsDemoReply = (method: string, args: unknown): {
  result?: unknown; error?: { code: string; message: string };
} | null => {
  if (!method.startsWith('data_views.')) return null;
  const key = 'recued-test-saved-data-views';
  const views: SavedDataView[] = JSON.parse(sessionStorage.getItem(key) ?? '[]');
  const input = (args ?? {}) as Record<string, unknown>;
  const index = views.findIndex((view) => view.id === input.id);
  const view = views[index];
  if (method === 'data_views.list') return { result: { views } };
  if (method === 'data_views.get') {
    if (new URLSearchParams(location.search).get('saved_views_get') === 'fail') {
      return { error: { code: 'unavailable', message: 'Saved views are temporarily unavailable.' } };
    }
    return { result: { view: view ?? null } };
  }
  if (method === 'data_views.create') {
    const definition = parseSavedDataViewDefinition(input.definition);
    if (definition === null || typeof input.name !== 'string') throw new Error('Invalid view fixture request');
    const created: SavedDataView = { id: `view_${crypto.randomUUID()}`, name: input.name.trim(), definition,
      revision: 1, created_at: Date.now(), updated_at: Date.now() };
    views.push(created);
    sessionStorage.setItem(key, JSON.stringify(views));
    return { result: { view: created } };
  }
  if (view === undefined) return { error: { code: 'not_found', message: 'This saved view was deleted.' } };
  if (view.revision !== input.expected_revision) return { error: { code: 'conflict', message: 'This saved view changed in another browser. Refresh it before trying again.' } };
  if (method === 'data_views.update') {
    if (new URLSearchParams(location.search).get('saved_views_update') === 'fail') {
      return { error: { code: 'unavailable', message: 'Saved view settings are temporarily unavailable.' } };
    }
    const definition = Object.hasOwn(input, 'definition') ? parseSavedDataViewDefinition(input.definition) : view.definition;
    if (definition === null) return { error: { code: 'bad_request', message: 'Invalid saved view settings.' } };
    const updated: SavedDataView = { ...view, definition, revision: view.revision + 1, updated_at: Date.now() };
    if (Object.hasOwn(input, 'alert')) {
      const alert = parseSavedDataViewAlertSettings(input.alert);
      if (!alert || !savedDataViewSupportsAlerts(definition)) return { error: { code: 'bad_request', message: 'Invalid alert settings.' } };
      updated.alert = { ...alert, status: alert.enabled ? 'watching' : 'paused', last_checked_at: Date.now(), last_notified_at: null };
    } else if (!savedDataViewSupportsAlerts(definition)) delete updated.alert;
    views[index] = updated;
    sessionStorage.setItem(key, JSON.stringify(views));
    return { result: { view: updated } };
  }
  if (method === 'data_views.rename') {
    if (typeof input.name !== 'string') throw new Error('Invalid rename');
    const renamed = { ...view, name: input.name.trim(), revision: view.revision + 1 };
    views[index] = renamed;
    sessionStorage.setItem(key, JSON.stringify(views));
    return { result: { view: renamed } };
  }
  if (method !== 'data_views.delete') throw new Error(`Unknown saved view fixture method: ${method}`);
  views.splice(index, 1);
  sessionStorage.setItem(key, JSON.stringify(views));
  return { result: { deleted: true } };
};
