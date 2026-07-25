/** D-145 PA6 — create / edit dialog renderer.
 *
 *  Wraps the PA5 form-renderer with:
 *    - per-kind dialog title (singular_label)
 *    - Source picker (create mode — read-only Source label in edit
 *      mode since we don't move rows between Sources at PA6)
 *    - submit-error banner
 *    - submit + cancel buttons
 *
 *  Host event wiring:
 *    - `data-action="select-create-source"` on the Source `<select>`
 *      in create mode — host must pipe the chosen value through
 *      `setDialogSourceTransition` so the next submit dispatches
 *      against the right Source.
 *    - `data-action="submit-work-entity-dialog"` on the submit button.
 *    - `data-action="close-work-entity-dialog"` on the close X button
 *      and the Cancel button — UNCONDITIONAL close.
 *    - `data-action="close-work-entity-dialog-on-backdrop"` on the
 *      modal backdrop. The host MUST check `event.target ===
 *      event.currentTarget` before closing — otherwise click-bubbling
 *      from form fields / buttons inside the dialog dismisses the
 *      dialog (Codex P1 fold).
 *
 *  Spec: D-145 § Phase PA6 (Create-new flow uses form
 *  renderer / Per-item edit flow).
 */

import {
  workEntityNavSpec,
  type FormDefinition,
  type SourceDropdownOption,
  type WorkEntityKind,
  type WorkEntityPageDialogState,
} from '@recued/contracts';
import { e } from '../template.js';
import { renderForm } from '../form-renderer/render.js';

export interface WorkEntityDialogProps {
  kind: WorkEntityKind;
  /** PA5 `FormDefinition` — caller passes whichever generator output
   *  applies (canonical-only or canonical+extension). */
  definition: FormDefinition;
  state: WorkEntityPageDialogState;
  /** Sources available for the create dialog's Source picker. The
   *  dialog filters to write-capable Sources matching `kind`. Edit
   *  mode renders the Source label for `state.source_id` from this
   *  list as well; a missing entry surfaces the raw id. */
  sources: readonly SourceDropdownOption[];
  /** Render `data.contact` ref fields as live name→id pickers (the host
   *  must ATTACH them after render via `wireRefPicker`). Default false
   *  — only the data route, which wires the pickers, opts in. */
  ref_picker?: boolean;
}

/** Render the dialog. The dialog body is wrapped in a backdrop +
 *  modal envelope; the host portals or appends as needed. */
export const renderWorkEntityDialog = (props: WorkEntityDialogProps): string => {
  const spec = workEntityNavSpec(props.kind);
  const title =
    props.state.mode === 'create'
      ? `New ${spec.singular_label}`
      : `Edit ${spec.singular_label}`;
  const writableForCreate = props.sources.filter(
    (s) => s.source_kind !== 'sentinel' && s.write_capable,
  );
  const sourcePicker =
    props.state.mode === 'create'
      ? renderCreateSourcePicker(props.state.source_id, props.sources, props.kind)
      : renderEditSourceLabel(props.state.source_id, props.sources);
  const submitError = props.state.submit_error
    ? `<div class="work-entity-dialog-submit-error" role="alert">${e(props.state.submit_error)}</div>`
    : '';
  // Codex P2 fold — disable submit when create-mode dialog has no
  // writable Source. The dialog can still mount in this state
  // (defense-in-depth — page-level `can_create` guard normally hides
  // the create button) but the user must not be able to dispatch
  // against a missing target.
  const cannotSubmitForCreate =
    props.state.mode === 'create' && writableForCreate.length === 0;
  const submitDisabled =
    props.state.submitting === true || cannotSubmitForCreate;
  const submittingAttr = submitDisabled ? ' disabled' : '';
  const submitLabel = props.state.submitting === true ? 'Saving…' : 'Save';
  return `
    <div
      class="work-entity-dialog-backdrop"
      data-action="close-work-entity-dialog-on-backdrop"
      data-mode="${e(props.state.mode)}"
    >
      <div
        class="work-entity-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-entity-dialog-title"
        data-mode="${e(props.state.mode)}"
        data-kind="${e(props.kind)}"
      >
        <header class="work-entity-dialog-header">
          <h2 class="work-entity-dialog-title" id="work-entity-dialog-title">${e(title)}</h2>
          <button
            type="button"
            class="work-entity-dialog-close"
            data-action="close-work-entity-dialog"
            aria-label="Close"
          >×</button>
        </header>
        <form class="work-entity-dialog-form" data-form-kind="${e(props.kind)}">
          ${sourcePicker}
          ${renderForm(props.definition, {
            values: props.state.values,
            errors: props.state.errors,
            refPicker: props.ref_picker === true,
          })}
          ${submitError}
          <footer class="work-entity-dialog-actions">
            <button
              type="button"
              class="work-entity-dialog-cancel"
              data-action="close-work-entity-dialog"
            >Cancel</button>
            <button
              type="button"
              class="work-entity-dialog-submit"
              data-action="submit-work-entity-dialog"${submittingAttr}
            >${e(submitLabel)}</button>
          </footer>
        </form>
      </div>
    </div>
  `;
};

const renderCreateSourcePicker = (
  selected_source_id: string,
  sources: readonly SourceDropdownOption[],
  kind: WorkEntityKind,
): string => {
  const writable = sources.filter(
    (s) => s.source_kind !== 'sentinel' && s.write_capable,
  );
  if (writable.length === 0) {
    return `
      <div class="work-entity-dialog-source-readonly" role="status">
        <strong>No write-capable Source for ${e(kind)}.</strong> Connect a Source in Settings before creating ${e(kind)}s.
      </div>
    `;
  }
  if (writable.length === 1) {
    // Single-Source case: render a static label rather than a
    // pointless one-option dropdown.
    const only = writable[0];
    return `
      <div class="work-entity-dialog-source-static">
        <span class="work-entity-dialog-source-label">Source</span>
        <span class="work-entity-dialog-source-value" data-source-id="${e(only.id)}">${e(only.label)}</span>
      </div>
    `;
  }
  const options = writable
    .map((s) => {
      const sel = s.id === selected_source_id ? ' selected' : '';
      return `<option value="${e(s.id)}" data-source-kind="${e(s.source_kind)}"${sel}>${e(s.label)}</option>`;
    })
    .join('');
  return `
    <div class="work-entity-dialog-source-picker">
      <label class="work-entity-dialog-source-label" for="work-entity-dialog-source-select">Source</label>
      <select
        id="work-entity-dialog-source-select"
        class="work-entity-dialog-source-select"
        data-action="select-create-source"
        aria-label="Source"
      >${options}</select>
    </div>
  `;
};

const renderEditSourceLabel = (
  source_id: string,
  sources: readonly SourceDropdownOption[],
): string => {
  const found = sources.find((s) => s.id === source_id);
  const label = found?.label ?? source_id;
  return `
    <div class="work-entity-dialog-source-static" data-source-id="${e(source_id)}">
      <span class="work-entity-dialog-source-label">Source</span>
      <span class="work-entity-dialog-source-value">${e(label)}</span>
    </div>
  `;
};
