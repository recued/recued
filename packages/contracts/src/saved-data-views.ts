/** Saved Data views contain settings, never result rows or executable queries. */
import {
  BOOKING_LIFECYCLE_STATES, type BookingLifecycleState,
  WORK_ENTITY_KINDS, type WorkEntityKind,
} from './work-entities.js';
import type { RecordsChangeCursor, RecordsPackRef } from './records.js';
import { parseRecordsViewSettings, type RecordsViewSettings } from './records-view.js';
import { parseTaskViewFilters, type TaskViewFilters } from './task-data-view.js';

export const SAVED_DATA_VIEW_LIMIT = 100;
export const SAVED_DATA_VIEW_NAME_LIMIT = 100;
export const SAVED_DATA_VIEW_QUERY_LIMIT = 2000;

/** D-289 — how many views ONE pack may ship.
 *
 *  ⛔ A SEPARATE ALLOWANCE, NOT A SHARE OF `SAVED_DATA_VIEW_LIMIT` (owner's
 *  ruling, 2026-09-22). Counting pack views against the owner's 100 means
 *  installing a pack silently spends slots they did not choose to spend, and
 *  the refusal they eventually hit — *"You can save up to 100 views. Delete a
 *  view to make room."* — blames them for a pack's decision. Per-PACK rather
 *  than global so one greedy pack cannot crowd out every other pack's views,
 *  and so the refusal can name the pack that overran. */
export const PACK_SAVED_VIEWS_PER_PACK_LIMIT = 20;

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
  /** ⛔ `today` IS LEGACY AND UNCREATABLE — READ PATH ONLY. D-290 moved Today
   *  to its own `#today` route, so there is no Today tab to press "Save current
   *  view" on and no new row can carry it. The arm stays because rows created
   *  BEFORE that move are on owners' disks right now.
   *
   *  ⛔⛔ DO NOT "TIDY" IT OUT OF THIS UNION. `parseSavedDataViewDefinition`
   *  returning null makes `saved-data-view-store.ts` `decode` THROW, and `list`
   *  maps decode over every row — so one legacy Today view would take the
   *  owner's ENTIRE saved-view list with it, not just itself. Retiring the
   *  vocabulary member and retiring the stored rows are separate decisions, and
   *  only the first one is free.
   *
   *  Opening such a view routes to `#today` (`saved-data-route.ts`), which is
   *  what its owner meant by it. */
  | { tab: 'today' | 'form_response' | 'annotation' | 'link' | 'shared' };

export interface SavedDataView {
  id: string;
  name: string;
  definition: SavedDataViewDefinition;
  revision: number;
  created_at: number;
  updated_at: number;
  /** Saved task/Records membership monitoring, even with no browser open. */
  alert?: SavedDataViewAlert;
  /** P2/F2 — how far the owner has reviewed this Records view's changes. */
  review?: SavedDataViewReview;
  /** D-289 — the pack that ships this view. Absent ⇒ owner-authored.
   *
   *  🔑 THE FIELD IS THE OWNERSHIP SPLIT, and every consumer reads it that
   *  way: the PACK owns `name` and `definition` (a reinstall re-asserts both),
   *  the OWNER owns {@link hidden}, {@link alert} and {@link review}. Rename,
   *  edit and delete are refused on a pack view — not out of strictness, but
   *  because the next install would silently undo them, and D-145 PA10 settled
   *  that a control the substrate reverses must not be rendered at all. */
  pack?: SavedDataViewPackRef;
  /** D-289 — the owner hid a pack view.
   *
   *  ⛔ OWNER-OWNED, AND THE REINSTALL MUST STEP AROUND IT. The sibling
   *  precedent (`pack-reception-templates.ts`) is REPLACE-CLEAN per pack, which
   *  is safe only because its rows carry nothing the owner authored. This one
   *  does, so a blind replace would un-hide, on every reinstall, a view the
   *  owner deliberately dismissed — and they would have no way to tell it
   *  apart from a fresh one. */
  hidden?: boolean;
  /** D-300 — a pack view the pack's update stopped shipping, kept because the owner had
   *  set it up (hidden it, put an alert on it, reviewed it). A rename is exactly this: the
   *  identity is publisher + slug + name, so the renamed view is a new one. Present ⇒ the
   *  view is out of every listing and no alert watches it; it waits for the owner. */
  retired?: SavedDataViewRetirement;
}

/** D-300 — see {@link SavedDataView.retired}. */
export interface SavedDataViewRetirement {
  /** When the update stopped shipping it. */
  at: number;
  /** The views the same update added — what it was most likely renamed to. */
  replacements: Array<{ id: string; name: string }>;
  /** The owner's alert as it was. A retired view no longer watches. */
  alert?: SavedDataViewAlertSettings;
}

/** D-300 — the owner's answer to a retired pack view. */
export type SavedDataViewRetiredResolveRequest =
  /** Set up `to_id` (a view the update added) the way this one was, then drop this one. */
  | { id: string; action: 'apply'; to_id: string }
  /** Keep it as the owner's own view (a copy with a new id), then drop this one. */
  | { id: string; action: 'keep' }
  /** Drop it. */
  | { id: string; action: 'dismiss' };

/** The pack a view came from — `publisher` + the pack's own `slug`. Two packs
 *  may share a slug under different publishers, so both segments are identity. */
export interface SavedDataViewPackRef {
  publisher: string;
  slug: string;
}

/** Records alerts need one concrete pack and kind, just like its saved query. */
export const savedDataViewSupportsAlerts = (definition: SavedDataViewDefinition): boolean =>
  definition.tab === 'task' || (definition.tab === 'records'
    && definition.owner !== null && definition.entity !== null);

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

/** Review needs one concrete pack AND entity — STRICTLY NARROWER than alerts,
 *  which also accept a task view. The change feed reads a pack's outbox, and a
 *  task view has no pack to read. */
export const savedDataViewSupportsReview = (definition: SavedDataViewDefinition): boolean =>
  definition.tab === 'records' && definition.owner !== null && definition.entity !== null;

export interface SavedDataViewReview {
  /** The last change the owner has SEEN.
   *
   *  ⛔ THE CLIENT SUPPLIES THIS, AND THE SERVER NEVER STAMPS "NOW". The owner
   *  reviewed what was on their screen; anything that landed between that render
   *  and the click has NOT been seen. A server-side `Date.now()` here would mark
   *  those changes reviewed and the owner would never learn they existed. */
  reviewed_through: RecordsChangeCursor;
  /** When the mark was made. ⚠ DISPLAY ONLY — never compared against event time.
   *  It is a different clock from the one inside `reviewed_through`. */
  reviewed_at: number;
}

/** Does a definition edit keep an existing review mark meaningful?
 *
 *  ⛔ SCOPE, NOT EQUALITY — deliberately not {@link sameSavedDataViewDefinition}.
 *  The cursor is a position in ONE pack's event stream, so narrowing a filter or
 *  flipping the sort leaves it perfectly valid, while changing pack or entity
 *  makes it point into a stream it was never taken from. Comparing whole
 *  definitions would throw away a good mark every time the owner adjusted a
 *  filter; comparing nothing would keep a nonsense one. */
export const sameSavedDataViewReviewScope = (
  left: SavedDataViewDefinition, right: SavedDataViewDefinition,
): boolean => left.tab === 'records' && right.tab === 'records'
  && left.entity === right.entity
  && left.owner?.publisher === right.owner?.publisher
  && left.owner?.pack_slug === right.owner?.pack_slug;

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
  /** P2/F2 — set the review mark to the cursor the reviewer actually saw, or
   *  `null` to clear it and re-surface the whole history. */
  review?: RecordsChangeCursor | null;
  /** D-289 — dismiss (or restore) a PACK view. Rides `data_views.update`
   *  rather than earning its own method for the same reason `review` does:
   *  it is owner-owned state ON a view, and the update path already CASes on
   *  the revision that protects it. ⛔ Refused on an owner-authored view —
   *  those have Delete, and two ways to make one row disappear is how a list
   *  grows entries nobody can account for. */
  hidden?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const locator = (value: unknown): value is string | null =>
  value === null || (boundedString(value, 512) && value.trim().length > 0);
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** ⚠ Lives here, not beside the type in `records.ts`, because the strict
 *  object helpers this file already owns (`keysAre` rejects an unknown key
 *  outright) are the decoding posture saved views use — a cursor that quietly
 *  accepted an extra field would let a future shape round-trip through storage
 *  unvalidated. */
export const parseRecordsChangeCursor = (value: unknown): RecordsChangeCursor | null => {
  if (!isObject(value) || !keysAre(value, ['at', 'event_id'])) return null;
  const { at, event_id } = value;
  if (!Number.isSafeInteger(at) || (at as number) < 0) return null;
  if (!boundedString(event_id, 200) || event_id.length === 0) return null;
  return { at: at as number, event_id };
};

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
