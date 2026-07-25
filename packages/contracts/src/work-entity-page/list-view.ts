/** D-145 PA6 — list-view filtering + sorting.
 *
 *  Pure: given a polymorphic union of entities returned by
 *  `WorkEntityResolver.listByKind` (or its scoped variant), apply the
 *  active search query + per-kind canonical sort, return a stable
 *  ordered list ready for rendering.
 *
 *  PA6 substrate ships per-kind sort defaults that mirror "what the
 *  user wants to act on first" — undone tasks ahead of done ones,
 *  pending commitments ahead of fulfilled ones, etc. A user-pickable
 *  sort menu is post-PA6 follow-up.
 *
 *  Spec: D-145 § Phase PA6 (List/search view per Source) +
 *  § A.1.6 ("All Sources" read-filter defaults — live + stale_unreachable;
 *  tombstoned + orphaned excluded; resolver applies).
 */

import {
  COMMITMENT_LIFECYCLE_LIST_ORDER,
  PROJECT_STATE_LIST_ORDER,
} from './types.js';
import type { WorkEntity, WorkEntityKind } from '../work-entities.js';

/** Trim + lowercase a search query. Empty string + whitespace-only
 *  return ''. */
const normalizeQuery = (q: string): string => q.trim().toLowerCase();

/** Per-kind set of fields the search query matches against. Unicode-
 *  aware: matching is `String.prototype.includes` on lowercased
 *  strings — accent / case differences are NOT folded out at PA6 (a
 *  later phase can layer NFC + diacritic-strip if user testing
 *  surfaces a need). */
const matchableFields: Readonly<Record<WorkEntityKind, readonly string[]>> = {
  task: ['title', 'body'],
  note: ['title', 'body'],
  commitment: ['statement'],
  project: ['title', 'description'],
  booking: ['title'],
};

/** Filter entities by the search query. Empty-or-whitespace query
 *  returns the input unchanged.  Matches the lowercased query against
 *  the per-kind matchable fields (case-insensitive substring). */
export const filterEntitiesBySearch = (
  kind: WorkEntityKind,
  entities: readonly WorkEntity[],
  query: string,
): readonly WorkEntity[] => {
  const q = normalizeQuery(query);
  if (q === '') return entities;
  const fields = matchableFields[kind];
  return entities.filter((entity) => {
    if (entity._kind !== kind) return false;
    for (const f of fields) {
      const v = (entity as unknown as Record<string, unknown>)[f];
      if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
    }
    return false;
  });
};

/** Per-kind canonical sort. Stable across `Array.prototype.sort` (V8
 *  stable since 2018; spec mandates stable since ECMAScript 2019). */
export const sortEntitiesByDefault = (
  kind: WorkEntityKind,
  entities: readonly WorkEntity[],
): readonly WorkEntity[] => {
  const out = entities.slice();
  switch (kind) {
    case 'task':
      // Undone first; among undone, due_at ASC (rows without due_at
      // sink); among done, completed_at DESC.
      out.sort((a, b) => {
        if (a._kind !== 'task' || b._kind !== 'task') return 0;
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (!a.done) {
          const ad = a.due_at ?? Number.POSITIVE_INFINITY;
          const bd = b.due_at ?? Number.POSITIVE_INFINITY;
          return ad - bd;
        }
        const ac = a.completed_at ?? 0;
        const bc = b.completed_at ?? 0;
        return bc - ac;
      });
      break;
    case 'note':
      out.sort((a, b) => {
        if (a._kind !== 'note' || b._kind !== 'note') return 0;
        return b.last_user_action_at - a.last_user_action_at;
      });
      break;
    case 'commitment':
      out.sort((a, b) => {
        if (a._kind !== 'commitment' || b._kind !== 'commitment') return 0;
        const al = COMMITMENT_LIFECYCLE_LIST_ORDER[a.lifecycle_state];
        const bl = COMMITMENT_LIFECYCLE_LIST_ORDER[b.lifecycle_state];
        if (al !== bl) return al - bl;
        const ad = a.promised_for_at ?? Number.POSITIVE_INFINITY;
        const bd = b.promised_for_at ?? Number.POSITIVE_INFINITY;
        return ad - bd;
      });
      break;
    case 'project':
      out.sort((a, b) => {
        if (a._kind !== 'project' || b._kind !== 'project') return 0;
        const as = PROJECT_STATE_LIST_ORDER[a.state];
        const bs = PROJECT_STATE_LIST_ORDER[b.state];
        if (as !== bs) return as - bs;
        return b.last_activity_at - a.last_activity_at;
      });
      break;
    // ⚠ This switch is `break`-style with no default, so a missing arm renders
    // the list in whatever order the store returned — no error, just a list
    // that looks arbitrary. Bookings sort NEWEST FIRST, matching
    // `listBookings`' own `ORDER BY created_at DESC`. The booking does own its
    // slot, but creation order keeps this owner inbox-like surface focused on
    // the newest accepted reservations.
    case 'booking':
      out.sort((a, b) => {
        if (a._kind !== 'booking' || b._kind !== 'booking') return 0;
        if (a.created_at !== b.created_at) return b.created_at - a.created_at;
        // Deterministic tiebreak so a same-millisecond pair does not reorder
        // between renders (the seeded / imported case).
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      break;
  }
  return out;
};

/** Compose: search filter + canonical sort. Common entry point for
 *  the host renderer. */
export const filterAndSortEntities = (
  kind: WorkEntityKind,
  entities: readonly WorkEntity[],
  query: string,
): readonly WorkEntity[] =>
  sortEntitiesByDefault(kind, filterEntitiesBySearch(kind, entities, query));
