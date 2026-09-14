/** Saved Data views contain settings, never result rows or executable queries. */
import {
  BOOKING_LIFECYCLE_STATES, type BookingLifecycleState,
  WORK_ENTITY_KINDS, type WorkEntityKind,
} from './work-entities.js';
import type { RecordsPackRef } from './records.js';
import { parseRecordsViewSettings, type RecordsViewSettings } from './records-view.js';
import { parseTaskViewFilters, type TaskViewFilters } from './task-data-view.js';

export const SAVED_DATA_VIEW_LIMIT = 100;
export const SAVED_DATA_VIEW_NAME_LIMIT = 100;
export const SAVED_DATA_VIEW_QUERY_LIMIT = 2000;

export type SavedDataViewDefinition =
  | { tab: 'search' | 'contact'; query: string }
  | {
      tab: WorkEntityKind;
      query: string;
      source_id: string | null;
      booking_lifecycle: BookingLifecycleState | 'all';
      /** Only valid on Tasks. Absent on older views means the default settings. */
      task_filters?: TaskViewFilters;
    }
  | { tab: 'mail' | 'calendar' | 'files' | 'webhook'; collection_slug: string | null }
  | { tab: 'memory'; origin: 'all' | 'user_self' | 'contracted_user' | 'system' }
  | ({ tab: 'records'; owner: RecordsPackRef | null; entity: string | null } & RecordsViewSettings)
  | { tab: 'today' | 'form_response' | 'annotation' | 'link' | 'shared' };

export interface SavedDataView {
  id: string;
  name: string;
  definition: SavedDataViewDefinition;
  revision: number;
  created_at: number;
  updated_at: number;
  /** Task-only monitoring, evaluated by the server even with no browser open. */
  alert?: SavedDataViewAlert;
}

export interface SavedDataViewAlertSettings {
  enabled: boolean;
  /** Calendar-date filters use the owner's zone captured when enabling. */
  time_zone: string;
}
export interface SavedDataViewAlert extends SavedDataViewAlertSettings {
  status: 'watching' | 'paused' | 'unavailable';
  last_checked_at: number | null;
  last_notified_at: number | null;
}

export interface SavedDataViewCreateRequest {
  name: string;
  definition: SavedDataViewDefinition;
}
export interface SavedDataViewDeleteRequest {
  id: string;
  expected_revision: number;
}
export interface SavedDataViewRenameRequest extends SavedDataViewDeleteRequest {
  name: string;
}
export interface SavedDataViewUpdateRequest extends SavedDataViewDeleteRequest {
  definition?: SavedDataViewDefinition;
  alert?: SavedDataViewAlertSettings;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const locator = (value: unknown): value is string | null =>
  value === null || (boundedString(value, 512) && value.trim().length > 0);
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const parseSavedDataViewAlertSettings = (value: unknown): SavedDataViewAlertSettings | null => {
  if (!isObject(value) || !keysAre(value, ['enabled', 'time_zone'])
    || typeof value.enabled !== 'boolean' || !boundedString(value.time_zone, 100)
    || value.time_zone.length === 0) return null;
  try {
    const time_zone = new Intl.DateTimeFormat('en-US', { timeZone: value.time_zone }).resolvedOptions().timeZone;
    return { enabled: value.enabled, time_zone };
  } catch { return null; }
};

/** Strict decoding prevents a future/invalid filter from quietly becoming All. */
export const parseSavedDataViewDefinition = (value: unknown): SavedDataViewDefinition | null => {
  if (!isObject(value)) return null;
  const { tab } = value;
  if (tab === 'search' || tab === 'contact') {
    if (!keysAre(value, ['tab', 'query']) || !boundedString(value.query, SAVED_DATA_VIEW_QUERY_LIMIT)) return null;
    return { tab, query: value.query };
  }
  if (typeof tab === 'string' && WORK_ENTITY_KINDS.some((kind) => kind === tab)) {
    const keys = ['tab', 'query', 'source_id', 'booking_lifecycle'];
    if (tab === 'task' && Object.hasOwn(value, 'task_filters')) keys.push('task_filters');
    if (!keysAre(value, keys)
      || !boundedString(value.query, SAVED_DATA_VIEW_QUERY_LIMIT) || !locator(value.source_id)) return null;
    const lifecycle = value.booking_lifecycle;
    if (lifecycle !== 'all' && (tab !== 'booking' || !BOOKING_LIFECYCLE_STATES.some((state) => state === lifecycle))) return null;
    const definition: SavedDataViewDefinition = { tab: tab as WorkEntityKind,
      query: value.query, source_id: value.source_id,
      booking_lifecycle: lifecycle as BookingLifecycleState | 'all' };
    if (Object.hasOwn(value, 'task_filters')) {
      const filters = parseTaskViewFilters(value.task_filters);
      if (filters === null) return null;
      // Canonical defaults preserve equality and the old stored shape.
      if (filters.completion !== 'all' || filters.due !== 'all' || filters.sort !== 'default') {
        definition.task_filters = filters;
      }
    }
    return definition;
  }
  if (tab === 'mail' || tab === 'calendar' || tab === 'files' || tab === 'webhook') {
    if (!keysAre(value, ['tab', 'collection_slug']) || !locator(value.collection_slug)) return null;
    return { tab, collection_slug: value.collection_slug };
  }
  if (tab === 'memory') {
    const { origin } = value;
    if (!keysAre(value, ['tab', 'origin'])
      || (origin !== 'all' && origin !== 'user_self' && origin !== 'contracted_user' && origin !== 'system')) return null;
    return { tab, origin };
  }
  if (tab === 'records') {
    const keys = ['tab', 'owner', 'entity'];
    if (Object.hasOwn(value, 'filters')) keys.push('filters');
    if (Object.hasOwn(value, 'sort')) keys.push('sort');
    if (!keysAre(value, keys) || !locator(value.entity)) return null;
    const settings = parseRecordsViewSettings({
      ...(Object.hasOwn(value, 'filters') ? { filters: value.filters } : {}),
      ...(Object.hasOwn(value, 'sort') ? { sort: value.sort } : {}),
    });
    if (settings === null || (value.entity === null && Object.keys(settings).length > 0)) return null;
    if (value.owner === null) return value.entity === null ? { tab, owner: null, entity: null } : null;
    if (!isObject(value.owner) || !keysAre(value.owner, ['publisher', 'pack_slug'])) return null;
    const { publisher, pack_slug } = value.owner;
    if (typeof publisher !== 'string' || !locator(publisher)
      || typeof pack_slug !== 'string' || !locator(pack_slug)) return null;
    return { tab, owner: { publisher, pack_slug }, entity: value.entity, ...settings };
  }
  if (tab === 'today' || tab === 'form_response' || tab === 'annotation' || tab === 'link' || tab === 'shared') {
    return keysAre(value, ['tab']) ? { tab } : null;
  }
  return null;
};

export const sameSavedDataViewDefinition = (
  left: SavedDataViewDefinition, right: SavedDataViewDefinition,
): boolean => JSON.stringify(parseSavedDataViewDefinition(left))
  === JSON.stringify(parseSavedDataViewDefinition(right));
