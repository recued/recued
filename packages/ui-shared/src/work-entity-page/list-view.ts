/** D-145 PA6 — list-view renderer.
 *
 *  Pure HTML. Walks the host-supplied `WorkEntityListRow[]` and emits
 *  one row per entity with a primary-text + secondary-text + metadata
 *  triple per kind. In All-Sources mode (`show_source_label: true`),
 *  each row carries the Source's display label so the user knows
 *  which Source each entity came from.
 *
 *  The host wires:
 *    - `data-action="search-work-entities"` on the search input
 *      (`change` / `input` event)
 *    - `data-action="open-edit-work-entity"` on each row
 *      (`click` event); `data-entity-id` carries the row id;
 *      `data-source-id` carries the row's Source id.
 *
 *  Spec: D-145 § Phase PA6 (List/search view per Source).
 */

import {
  BOOKING_LIFECYCLE_STATES,
  type WorkEntity,
  type WorkEntityKind,
  type WorkEntityListRow,
  type WorkEntityListViewProps,
} from '@recued/contracts';
import { e, timeAgo } from '../template.js';

const formatDate = (ts: number | undefined): string => {
  if (ts === undefined || ts === 0) return '';
  // YYYY-MM-DD — locale-stable for list rendering.
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/** D-210 A.2 — a booking's slot, for a human reading their own list.
 *
 *  ⚠ LOCAL zone, unlike `formatDate` above, and deliberately. That helper
 *  chose UTC for locale-stable list rendering, which is right for a due
 *  DATE. A booking is an APPOINTMENT: showing 14:00 to an owner whose
 *  appointment is at 16:00 does not make the list stable, it makes it
 *  wrong, and wrong in the direction where somebody misses a customer.
 *
 *  ⏭ The row carries no timezone of its own — only the endpoint's
 *  `available_window_definition.tz` does, and it is never copied onto the
 *  booking. So this renders the VIEWER's wall clock, which is correct for
 *  the single-owner case and is the open question for any other.
 *
 *  The end is rendered time-only when it lands on the same local day —
 *  "14:00–15:00" is how an appointment reads; repeating the date is noise. */
const formatSlot = (start: number, end: number): string => {
  const s = new Date(start);
  const eD = new Date(end);
  const day = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  const clock = (d: Date): string =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = day(s) === day(eD);
  return sameDay
    ? `${day(s)} ${clock(s)}–${clock(eD)}`
    : `${day(s)} ${clock(s)} – ${day(eD)} ${clock(eD)}`;
};

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
};

interface RowText {
  primary: string;
  secondary?: string;
  meta?: string;
}

const rowTextForTask = (entity: WorkEntity & { _kind: 'task' }): RowText => ({
  primary: entity.title,
  secondary: entity.body !== undefined ? truncate(entity.body, 80) : undefined,
  meta: [
    entity.done ? 'Done' : '',
    entity.due_at !== undefined ? `Due ${formatDate(entity.due_at)}` : '',
    entity.priority !== undefined ? `Priority ${entity.priority}` : '',
  ]
    .filter((s) => s !== '')
    .join(' · '),
});

const rowTextForNote = (entity: WorkEntity & { _kind: 'note' }): RowText => ({
  primary: entity.title ?? truncate(entity.body, 60),
  secondary:
    entity.title !== undefined && entity.body !== ''
      ? truncate(entity.body, 80)
      : undefined,
  meta: `Updated ${timeAgo(entity.last_user_action_at)}`,
});

const rowTextForCommitment = (
  entity: WorkEntity & { _kind: 'commitment' },
): RowText => ({
  primary: entity.statement,
  secondary: undefined,
  meta: [
    `${entity.direction}`,
    `${entity.lifecycle_state}`,
    entity.due_status !== 'no_deadline' ? `${entity.due_status}` : '',
    entity.monetary_value !== undefined
      ? `${entity.monetary_value.amount} ${entity.monetary_value.currency}`
      : '',
  ]
    .filter((s) => s !== '')
    .join(' · '),
});

const rowTextForProject = (
  entity: WorkEntity & { _kind: 'project' },
): RowText => ({
  primary: entity.title,
  secondary:
    entity.description !== undefined
      ? truncate(entity.description, 100)
      : undefined,
  meta: [
    entity.state,
    entity.last_activity_at > 0
      ? `Active ${timeAgo(entity.last_activity_at)}`
      : '',
  ]
    .filter((s) => s !== '')
    .join(' · '),
});

const rowTextForBooking = (
  entity: WorkEntity & { _kind: 'booking' },
): RowText => ({
  primary: entity.title,
  secondary: undefined,
  // The slot leads (D-210 A.2). It is this row's own fact now, so
  // rendering it is a claim the row can stand behind — which is exactly
  // what the previous "no time here" rule was protecting against when the
  // calendar owned it. An absent pair says "no time agreed", a real state,
  // never a lookup that failed.
  meta: [
    entity.slot_start_at !== undefined && entity.slot_end_at !== undefined
      ? formatSlot(entity.slot_start_at, entity.slot_end_at)
      : 'no time agreed',
    entity.lifecycle_state,
    entity.monetary_value !== undefined
      ? `${entity.monetary_value.amount} ${entity.monetary_value.currency}`
      : '',
    // ⛔ A `'no calendar event'` note used to sit here. D-210 A.2 made booking ⟂
    // calendar, so the line rendered on EVERY booking — telling the owner a
    // reservation was missing a link that no longer exists. A row's meta is a
    // CLAIM about the record. The column it read is gone as of slice 3c.
  ]
    .filter((s) => s !== '')
    .join(' · '),
});

/** Per-kind row-text projection. */
export const projectRowText = (entity: WorkEntity): RowText => {
  switch (entity._kind) {
    case 'task':
      return rowTextForTask(entity);
    case 'note':
      return rowTextForNote(entity);
    case 'commitment':
      return rowTextForCommitment(entity);
    case 'project':
      return rowTextForProject(entity);
    case 'booking':
      return rowTextForBooking(entity);
  }
};

/** Render the list view (search input + entity rows or empty state). */
export const renderWorkEntityListView = (
  props: WorkEntityListViewProps & { opening_entity_id?: string },
): string => {
  const search = renderSearchInput(
    props.search_query,
    props.kind,
    props.booking_lifecycle_filter ?? 'all',
  );
  const body =
    props.rows.length === 0
      ? renderEmptyState(props.kind, props.empty_state_copy, props.search_query)
      : renderRows(
          props.rows,
          props.show_source_label,
          props.opening_entity_id,
        );
  return `
    <div class="work-entity-list-view" data-kind="${e(props.kind)}">
      ${search}
      ${body}
    </div>
  `;
};

const renderSearchInput = (
  search_query: string,
  kind: WorkEntityKind,
  booking_lifecycle_filter: WorkEntityListViewProps['booking_lifecycle_filter'],
): string => `
    <div class="work-entity-list-search">
      <input
        type="search"
        class="work-entity-list-search-input"
        data-action="search-work-entities"
        data-kind="${e(kind)}"
        placeholder="Search ${e(kind)}s"
        value="${e(search_query)}"
        aria-label="Search ${e(kind)}s"
      />
      ${kind === 'booking' ? `
        <label class="work-entity-list-filter-label">
          Status
          <select
            class="work-entity-list-filter"
            data-action="filter-booking-lifecycle"
            aria-label="Filter bookings by status"
          >
            ${['all', ...BOOKING_LIFECYCLE_STATES]
              .map((state) => `<option value="${state}"${state === booking_lifecycle_filter ? ' selected' : ''}>${
                state === 'all' ? 'All statuses' : e(state.replace('_', ' '))
              }</option>`)
              .join('')}
          </select>
        </label>
      ` : ''}
    </div>
  `;

const renderRows = (
  rows: readonly WorkEntityListRow[],
  show_source_label: boolean,
  opening_entity_id: string | undefined,
): string => {
  const items = rows
    .map((row) => renderRow(
      row,
      show_source_label,
      row.entity.id === opening_entity_id,
    ))
    .join('');
  return `<ul class="work-entity-list" role="list">${items}</ul>`;
};

const renderRow = (
  row: WorkEntityListRow,
  show_source_label: boolean,
  opening: boolean,
): string => {
  const text = projectRowText(row.entity);
  const sourceLabel = show_source_label
    ? `<span class="work-entity-list-row-source" data-source-id="${e(row.source.id)}">${e(row.source.label)}</span>`
    : '';
  const secondary =
    text.secondary !== undefined && text.secondary !== ''
      ? `<div class="work-entity-list-row-secondary">${e(text.secondary)}</div>`
      : '';
  const meta =
    text.meta !== undefined && text.meta !== ''
      ? `<div class="work-entity-list-row-meta">${e(text.meta)}</div>`
      : '';
  const openingStatus = opening
    ? '<span class="work-entity-list-row-opening" role="status">Opening…</span>'
    : '';
  return `
    <li class="work-entity-list-row">
      <button
        type="button"
        class="work-entity-list-row-button"
        data-action="${row.entity._kind === 'booking' ? 'open-work-entity-detail' : 'open-edit-work-entity'}"
        data-entity-id="${e(row.entity.id)}"
        data-source-id="${e(row.entity.source_id)}"
        data-kind="${e(row.entity._kind)}"
        ${opening ? 'aria-disabled="true" aria-busy="true"' : ''}
      >
        <div class="work-entity-list-row-primary">${e(text.primary)}</div>
        ${secondary}
        <div class="work-entity-list-row-footer">
          ${sourceLabel}
          ${meta}
          ${openingStatus}
        </div>
      </button>
    </li>
  `;
};

const renderEmptyState = (
  kind: WorkEntityKind,
  empty_state_copy: string | undefined,
  search_query: string,
): string => {
  // Distinguish "no rows at all" from "no rows match the query"; the
  // user gets concrete guidance either way.
  if (search_query.trim() !== '') {
    return `
      <div class="work-entity-list-empty work-entity-list-empty-no-match" role="status">
        <p>No ${e(kind)}s match <strong>${e(search_query)}</strong>.</p>
      </div>
    `;
  }
  return `
    <div class="work-entity-list-empty work-entity-list-empty-default" role="status">
      <p>${e(empty_state_copy ?? `No ${kind}s yet.`)}</p>
    </div>
  `;
};
