/** D-145 PA6 — composite work-entity page renderer.
 *
 *  Composes the three PA6 sub-renderers (Source dropdown + list view +
 *  dialog) into one page-level surface. Pure HTML — every state input
 *  arrives via `props`. The host wires `data-action` clicks to rpcs
 *  (`workEntity.list / create / update / delete` etc.) and patches the
 *  page state back through.
 *
 *  (R18 — the kind nav strip was DROPPED: this page is embedded only in the
 *  webclient Data route, whose own grouped tabs already switch kind, so the
 *  nested nav was redundant. The host owns kind selection.)
 *
 *  Spec wireframe:
 *    Tasks                                       ← work-entity-page-header
 *      Source: [All Sources ▾]   [+ New Task]    ← source dropdown + create button
 *
 *    [Search…]                                   ← search input
 *      ▸ Buy groceries — Due 2026-05-10           ← list rows
 *      ▸ Email Bob — Done
 *      ▸ …
 *
 *  Spec: D-145 § Phase PA6.
 */

import {
  workEntityNavSpec,
  type BookingLifecycleState,
  type FormDefinition,
  type SourceDropdownOption,
  type WorkEntityListRow,
  type WorkEntityPageState,
} from '@recued/contracts';
import { e } from '../template.js';
import {
  renderSourceAffordanceChips,
  renderSourceDropdown,
} from './source-dropdown.js';
import { renderWorkEntityListView } from './list-view.js';
import { renderWorkEntityDialog } from './dialog.js';

export interface WorkEntityPageProps {
  state: WorkEntityPageState;
  /** Source dropdown options for the active kind, including the
   *  All-Sources sentinel. */
  source_options: readonly SourceDropdownOption[];
  /** Already filtered + sorted entity rows for the list view, with
   *  per-row Source attached so All-Sources mode can label rows. */
  rows: readonly WorkEntityListRow[];
  /** PA5 form definition for the active kind, used by the dialog.
   *  Caller passes whichever generator output applies (canonical-only
   *  or canonical+extension when an extension Source is selected). */
  form_definition: FormDefinition;
  /** When true, the user has at least one write-capable Source for
   *  the active kind — the [+ New <Kind>] button is rendered.
   *  When false, the create button collapses to a hint pointing
   *  at Settings. */
  can_create: boolean;
  /** Forwarded to the dialog: render `data.contact` ref fields as live
   *  name→id pickers the host wires after render. Default false. */
  ref_picker?: boolean;
  /** Optional HTML rendered directly under the list body — the host's
   *  load-more footer ("Showing N of M" + Load more). The host owns the
   *  pagination state + action wiring; the page just gives it a slot. */
  footer_html?: string;
  /** Booking-only server-side lifecycle filter echoed into the list control. */
  booking_lifecycle_filter?: BookingLifecycleState | 'all';
  /** Exact row whose edit detail is loading. It remains focusable while busy. */
  opening_entity_id?: string;
  /** Forwarded to an open dialog when user dismissal needs confirmation. */
  discard_guard?: boolean;
}

export const renderWorkEntityPage = (props: WorkEntityPageProps): string => {
  const { state } = props;
  const spec = workEntityNavSpec(state.kind);
  const showSourceLabel = state.selected_source_id === null;
  const headingId = `work-entity-page-${state.kind}-heading`;

  const dropdownHtml = renderSourceDropdown({
    options: props.source_options,
    selected_source_id: state.selected_source_id,
  });

  const activeOption =
    state.selected_source_id === null
      ? props.source_options[0] // sentinel
      : props.source_options.find((opt) => opt.id === state.selected_source_id);
  const chipsHtml = renderSourceAffordanceChips(activeOption);

  const createButtonHtml = props.can_create
    ? `
        <button
          type="button"
          class="work-entity-page-create"
          data-action="open-create-work-entity-dialog"
          data-kind="${e(state.kind)}"
        >+ New ${e(spec.singular_label)}</button>
      `
    : `
        <p class="work-entity-page-create-disabled" role="status">
          No write-capable Source — add one in Settings to create ${e(state.kind)}s.
        </p>
      `;

  const listHtml = renderWorkEntityListView({
    kind: state.kind,
    rows: props.rows,
    show_source_label: showSourceLabel,
    empty_state_copy: spec.empty_state_copy,
    search_query: state.search_query,
    ...(state.kind === 'booking'
      ? { booking_lifecycle_filter: props.booking_lifecycle_filter ?? 'all' }
      : {}),
    ...(props.opening_entity_id !== undefined
      ? { opening_entity_id: props.opening_entity_id }
      : {}),
  });

  const dialogHtml =
    state.dialog === null
      ? ''
      : renderWorkEntityDialog({
          kind: state.kind,
          definition: props.form_definition,
          state: state.dialog,
          sources: props.source_options,
          ref_picker: props.ref_picker === true,
          discard_guard: props.discard_guard === true,
        });

  return `
    <section class="work-entity-page" data-kind="${e(state.kind)}"
             aria-labelledby="${e(headingId)}">
      <header class="work-entity-page-header">
        <h2 class="work-entity-page-title" id="${e(headingId)}">${e(spec.plural_label)}</h2>
        <div class="work-entity-page-source-row">
          ${dropdownHtml}
          ${chipsHtml}
          ${createButtonHtml}
        </div>
      </header>
      <div class="work-entity-page-body">
        ${listHtml}
        ${props.footer_html ?? ''}
      </div>
      ${dialogHtml}
    </section>
  `;
};
