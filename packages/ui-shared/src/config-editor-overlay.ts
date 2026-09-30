/** Shared config-editor overlay — one modal for editing a config overlay
 *  (a recipe's variable widgets, pre-filled). Used by the automation
 *  route's auto-run Config editor, the run modal's per-row Schedule/Trigger
 *  Config editor, and the recipe-detail install-config editor.
 *
 *  D-319 — it is also the switch-on form: a dish is a recipe switched on
 *  with its settings, so the same editor can ask for the dish's NAME, say in
 *  one sentence what will start it, offer "also on a schedule", and refuse to
 *  confirm while a required setting is empty (`name`, `lead`, `schedules`,
 *  `requireSettings`). Each is optional; a host that passes none gets the
 *  editor it had.
 *
 *  Self-contained: injects its own styles, owns a focus trap + Escape, and
 *  reads widget values into a config object (touched widgets only, so an
 *  untouched field never churns a redundant key). The overlay renders ONCE
 *  — no repaint / caret dance. The host wires `onConfirm` (which persists)
 *  and `onClose` (cleanup, e.g. re-arming a parent modal's trap).
 */

import type { VariableDefault } from '@recued/contracts';

import {
  choiceListProblem,
  FILE_REF_VARIABLE_ATTR,
  fileRefDisplayLabel,
  fileRefVariablePickerId,
  readWidgetValue,
  renderVariableWidget,
  toFileRefIds,
  isValidValueHint,
  toWidgetShape,
  validateWidgetValue,
} from './variable-widgets.js';
import {
  FILE_REF_ARRAY_STYLES,
  wireFileRefArray,
  type FileRefArrayHandle,
} from './file-ref-array.js';
import {
  REF_PICKER_STYLES,
  wireRefPicker,
  type RefPickerHandle,
  asRefPickerSearchPage,
  type RefPickerSearchCaller,
} from './ref-picker/index.js';
import {
  wireRecordRefVariables,
  type RecordRefVariableSearch,
} from './record-ref-variable.js';
import { wireFocusTrap, type FocusTrapHandle } from './focus-trap.js';
import {
  wireMailTemplateVariables,
  type MailTemplateVariableCallers,
  type MailTemplateVariablesHandle,
} from './mail-template-variable.js';

const STYLES_MARKER = 'data-recued-config-editor-styles';
const ACTION_ATTR = 'data-recued-config-editor-action';
/** D-319 — the dish's name box, when the form asks for one. */
export const CONFIG_EDITOR_NAME_ATTR = 'data-recued-config-editor-name';
/** D-319 — the "Also on a schedule" choice, when the form offers one. */
export const CONFIG_EDITOR_SCHEDULE_ATTR = 'data-recued-config-editor-schedule';

const e = (v: unknown): string =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CONFIG_EDITOR_STYLES = `
.config-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(24, 33, 36, 0.32);
}
.config-editor-panel {
  box-sizing: border-box;
  width: min(460px, 100%);
  max-height: 85vh;
  overflow-y: auto;
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg);
}
.config-editor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
  gap: 12px;
}
.config-editor-title {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 15px;
  font-weight: 600;
}
.config-editor-copy { margin: 0; overflow-wrap: anywhere; font-size: 12px; color: var(--muted); }
.config-editor-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b42318);
}
.config-editor-error[hidden] { display: none; }
.config-editor-fields { display: grid; min-width: 0; gap: 12px; }
.config-editor-actions { display: flex; justify-content: flex-end; }
.config-editor-header .config-editor-button { flex: 0 0 auto; }
.config-editor-button {
  box-sizing: border-box;
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font: inherit;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
}
.config-editor-button--primary {
  background: var(--accent);
  color: var(--on-accent, #fff);
  border-color: var(--accent);
}
.config-editor-button[aria-disabled="true"] {
  cursor: wait;
  opacity: 0.72;
}
.config-editor-panel .var-row { display: grid; gap: 4px; }
.config-editor-panel .var-row-inline { display: block; }
.config-editor-panel .var-row > label,
.config-editor-panel .var-multi-label {
  font-size: 12px; font-weight: 600; color: var(--fg);
}
.config-editor-panel .var-row-inline > label {
  display: flex; align-items: center; min-height: 36px; gap: 7px; font-weight: 500;
}
.config-editor-panel .var-help { margin: 0; font-size: 11px; line-height: 1.4; color: var(--muted); }
.config-editor-panel .var-optional {
  margin-left: 6px; font-size: 10px; font-weight: 500; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.config-editor-panel .var-row input[type="text"],
.config-editor-panel .var-row input[type="number"],
.config-editor-panel .var-row input[type="password"],
.config-editor-panel .var-row select {
  box-sizing: border-box; width: 100%; min-height: 36px; border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 9px; background: var(--surface); color: var(--fg); font: inherit;
}
.config-editor-panel .var-row input:focus,
.config-editor-panel .var-row select:focus { outline: none; border-color: var(--accent); }
.config-editor-panel .var-multi-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px;
}
/* D-314 — short choices (weekdays) take narrow columns: a week is one or two rows. */
.config-editor-panel .var-multi-grid--compact { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); }
.config-editor-panel .var-multi-opt { display: flex; align-items: center; min-height: 36px; gap: 6px; font-size: 12px; color: var(--fg); }
.config-editor-panel .ref-picker-input {
  min-height: 36px;
  padding-right: 40px;
}
.config-editor-panel .ref-picker-clear {
  right: 0;
  width: 36px;
  height: 36px;
}
.config-editor-panel .ref-picker-option {
  box-sizing: border-box;
  min-height: 36px;
  justify-content: center;
}
.config-editor-panel .var-file-refs-btn {
  width: 36px;
  height: 36px;
}
/* D-315 — a template setting's own actions: open it, duplicate it to edit. */
.config-editor-panel .var-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.config-editor-panel .var-actions [hidden] { display: none; }
/* D-319 — the switch-on form: the dish's name, what starts it, a schedule. */
.config-editor-panel .config-editor-name,
.config-editor-panel .config-editor-schedule { display: grid; gap: 4px; font-size: 12px; font-weight: 600; color: var(--fg); }
.config-editor-panel .config-editor-name input,
.config-editor-panel .config-editor-schedule select {
  box-sizing: border-box; width: 100%; min-height: 36px; border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 9px; background: var(--surface); color: var(--fg); font: inherit; font-weight: 400;
}
.config-editor-panel .config-editor-name input:focus,
.config-editor-panel .config-editor-schedule select:focus { outline: none; border-color: var(--accent); }
.config-editor-panel .config-editor-lead { margin: 0; overflow-wrap: anywhere; font-size: 13px; color: var(--fg); }
${FILE_REF_ARRAY_STYLES}
`;

const injectStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${STYLES_MARKER}]`) !== null) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLES_MARKER, '');
  style.textContent = `${CONFIG_EDITOR_STYLES}\n${REF_PICKER_STYLES}`;
  doc.head.appendChild(style);
};

/** D-319 — the first required setting left empty, said as the owner would
 *  fix it; `null` when every one is filled. Required is what the recipe
 *  DECLARES as asked for: a labelled setting not marked optional (a
 *  connection, a mail template), or one declared with no value (`null`). A
 *  plain default — `''`, `0` — is the recipe's own value and never blocks. A
 *  value not in the form's config is its declared default, as a run would
 *  take it. */
export const requiredSettingProblem = (
  variables: Record<string, VariableDefault>,
  config: Record<string, unknown>,
): string | null => {
  for (const [key, def] of Object.entries(variables)) {
    const asked = def === null || (isValidValueHint(def) && def.optional !== true);
    if (!asked) continue;
    const shape = toWidgetShape(key, def ?? { label: key, type: 'text' } as VariableDefault, config[key]);
    const value = Object.prototype.hasOwnProperty.call(config, key)
      ? config[key]
      : def !== null ? (def as { default?: unknown }).default : undefined;
    const problem = validateWidgetValue(shape, value ?? '');
    if (problem !== null) return `${shape.label}: ${problem}`;
  }
  return null;
};

// D-215 § 9e — `MISSING_FILE_PREFIX` / `fileRefDisplayLabel` moved to
// `variable-widgets.js`. The rule gained a second consumer
// (`file-ref-array.ts`, which this module imports), so a home here would be
// a cycle. NOT re-exported: the root barrel `export *`s both modules, and
// two stars offering one name is a trap worth not laying.

export interface ConfigEditorOverlayOptions {
  document: Document;
  /** Dialog heading (e.g. the recipe name). */
  title: string;
  /** Sub-heading line describing where the config applies. */
  copy?: string;
  /** Confirm-button label ("Save" / "Resume" / …). */
  confirmLabel: string;
  /** Busy label while an async confirmation is settling. */
  confirmingLabel?: string;
  /** Safe inline copy when an async confirmation rejects. */
  confirmFailureCopy?: string;
  /** The recipe's variable DEFINITIONS (drives the widgets). */
  variables: Record<string, VariableDefault>;
  /** Current overlay to pre-fill from + the base the edits accumulate onto. */
  currentOverlay: Record<string, unknown>;
  /** Optional owner-file inventory. Present upgrades `type:'file_ref'`
   * variables from a pasteable ref box to the shared name→id picker. */
  fileRefSearch?: RefPickerSearchCaller;
  /** Optional stored-record inventory, per ENTITY. Present upgrades
   *  `type:'record_ref'` variables from a raw-id text box to the shared
   *  name→id picker — the same two-step `fileRefSearch` uses.
   *
   *  ⚠ Keyed by entity because one form can reference more than one kind (a
   *  tenancy names a customer AND a unit), so a single caller would have to
   *  guess which inventory the box means. */
  recordRefSearch?: RecordRefVariableSearch;
  /** D-315 — the owner's mail templates. Present, a `mail_template` setting is
   *  a list of them with "Open it" and "Duplicate to edit"; absent, a text box.
   *  Opening one closes the editor: it leads away from it. */
  mailTemplates?: MailTemplateVariableCallers;
  /** D-319 — ask for the dish's name. `required` refuses an empty one (a
   *  second dish of a recipe needs one to be told apart); otherwise an empty
   *  name is `''`. Absent ⇒ no name box. */
  name?: { readonly value: string; readonly required: boolean };
  /** D-319 — one sentence under the settings saying what will start it
   *  ("It starts when a parcel's state changes."). */
  lead?: string;
  /** D-319 — "Also on a schedule": the cadences offered, `No schedule` first.
   *  Absent or empty ⇒ not offered. */
  schedules?: ReadonlyArray<{ readonly label: string; readonly cron: string }>;
  /** D-319 — refuse to confirm while a required setting is empty (a
   *  connection, a mail template) — the dish would run without it. */
  requireSettings?: boolean;
  /** Fired on confirm with a snapshot of the collected config — and, for the
   *  D-319 switch-on form, the name given and the schedule chosen. A returned
   *  promise keeps the editor open, locked, and focus-owned until it settles. */
  onConfirm: (
    config: Record<string, unknown>,
    extras: { readonly name?: string; readonly cron?: string },
  ) => void | Promise<void>;
  /** Fired after the overlay detaches (any path) — host cleanup. */
  onClose?: () => void;
}

export interface ConfigEditorOverlayHandle {
  element: HTMLElement;
  /** True while an async confirmation has no terminal result yet. */
  hasInFlightWork(): boolean;
  /** Detach the overlay + release its trap. Idempotent. Fires `onClose`. */
  destroy: () => void;
}

/** Mount the editor over the current document. The host is responsible for
 *  any parent-modal trap juggling via `onClose`. */
export const wireConfigEditorOverlay = (
  opts: ConfigEditorOverlayOptions,
): ConfigEditorOverlayHandle => {
  const doc = opts.document;
  injectStyles(doc);

  // Pre-fill from the current overlay; edits accumulate here (touched
  // widgets only, read on input). Namespace widget `id`/`for` so they never
  // collide with a background copy of the same widgets (e.g. an Add form).
  const config: Record<string, unknown> = { ...opts.currentOverlay };
  const widgetRows = Object.keys(opts.variables)
    .map((key) => {
      const def = opts.variables[key];
      return def === undefined
        ? ''
        : renderVariableWidget(toWidgetShape(key, def, config[key]), {
            fileRefPicker: opts.fileRefSearch !== undefined,
            recordRefPicker: opts.recordRefSearch !== undefined,
            mailTemplatePicker: opts.mailTemplates !== undefined,
            idPrefix: 'cfg-edit-var',
          });
    })
    .join('');

  const overlay = doc.createElement('div');
  overlay.className = 'config-editor-overlay';
  overlay.innerHTML = `
    <section class="config-editor-panel" role="dialog" aria-modal="true" tabindex="-1"
      aria-label="Edit config">
      <header class="config-editor-header">
        <h2 class="config-editor-title">${e(opts.title)}</h2>
        <button type="button" class="config-editor-button" ${ACTION_ATTR}="cancel">Close</button>
      </header>
      ${opts.copy !== undefined ? `<p class="config-editor-copy">${e(opts.copy)}</p>` : ''}
      ${opts.name !== undefined ? `<label class="config-editor-name">Name
        <input type="text" ${CONFIG_EDITOR_NAME_ATTR} value="${e(opts.name.value)}" maxlength="120"
          autocomplete="off"${opts.name.required ? ' required aria-required="true"' : ''}></label>` : ''}
      <div class="config-editor-fields">${widgetRows}</div>
      ${opts.lead !== undefined ? `<p class="config-editor-lead">${e(opts.lead)}</p>` : ''}
      ${opts.schedules !== undefined && opts.schedules.length > 0 ? `<label class="config-editor-schedule">Also on a schedule
        <select ${CONFIG_EDITOR_SCHEDULE_ATTR}>
          <option value="" selected>No schedule</option>
          ${opts.schedules.map((option) => `<option value="${e(option.cron)}">${e(option.label)}</option>`).join('')}
        </select></label>` : ''}
      <p class="config-editor-error" role="alert" hidden></p>
      <div class="config-editor-actions">
        <button type="button" class="config-editor-button config-editor-button--primary"
          ${ACTION_ATTR}="confirm">${e(opts.confirmLabel)}</button>
      </div>
    </section>`;

  let trap: FocusTrapHandle | null = null;
  const refPickers: RefPickerHandle[] = [];
  const fileRefArrays: FileRefArrayHandle[] = [];
  let mailTemplates: MailTemplateVariablesHandle | null = null;
  let destroyed = false;
  let confirming = false;

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const picker of refPickers) picker.destroy();
    refPickers.length = 0;
    for (const list of fileRefArrays) list.destroy();
    fileRefArrays.length = 0;
    mailTemplates?.destroy();
    mailTemplates = null;
    trap?.release();
    trap = null;
    overlay.remove();
    opts.onClose?.();
  };

  const onInput = (ev: Event): void => {
    if (confirming) return;
    const t = ev.target as HTMLElement | null;
    const key = t?.dataset.varKey;
    if (t !== null && key !== undefined && key.length > 0) {
      config[key] = readWidgetValue(t);
    }
  };
  overlay.addEventListener('input', onInput);
  overlay.addEventListener('change', onInput);

  // Some route unit rigs deliberately provide a minimal DOM without selector
  // APIs. Synchronous confirms still work there; ownership controls activate
  // in real DOM hosts where the rendered elements can be addressed.
  const queryOverlay = <T extends Element>(selector: string): T | null =>
    typeof overlay.querySelector === 'function'
      ? overlay.querySelector<T>(selector)
      : null;
  const panel = queryOverlay<HTMLElement>('.config-editor-panel');
  const fields = queryOverlay<HTMLElement>('.config-editor-fields');
  const confirmButton = queryOverlay<HTMLButtonElement>(
    `[${ACTION_ATTR}="confirm"]`,
  );
  const closeButton = queryOverlay<HTMLButtonElement>(
    `[${ACTION_ATTR}="cancel"]`,
  );
  const error = queryOverlay<HTMLElement>('.config-editor-error');
  type LockableControl =
    | HTMLButtonElement
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
  const priorDisabled = new Map<LockableControl, boolean>();

  const setConfirming = (next: boolean): void => {
    confirming = next;
    if (next) {
      panel?.setAttribute('aria-busy', 'true');
      for (const control of Array.from(
        fields?.querySelectorAll<LockableControl>(
          'button, input, select, textarea',
        ) ?? [],
      )) {
        priorDisabled.set(control, control.disabled);
        control.disabled = true;
      }
      confirmButton?.setAttribute('aria-disabled', 'true');
      confirmButton?.setAttribute('aria-busy', 'true');
      closeButton?.setAttribute('aria-disabled', 'true');
      if (confirmButton !== null) {
        confirmButton.textContent =
          opts.confirmingLabel ?? `${opts.confirmLabel}…`;
      }
      return;
    }
    panel?.removeAttribute('aria-busy');
    for (const [control, disabled] of priorDisabled) {
      control.disabled = disabled;
    }
    priorDisabled.clear();
    confirmButton?.removeAttribute('aria-disabled');
    confirmButton?.removeAttribute('aria-busy');
    closeButton?.removeAttribute('aria-disabled');
    if (confirmButton !== null) confirmButton.textContent = opts.confirmLabel;
  };

  const showConfirmFailure = (): void => {
    if (destroyed) return;
    const active = doc.activeElement;
    setConfirming(false);
    if (error !== null) {
      error.hidden = false;
      error.textContent = opts.confirmFailureCopy
        ?? "Recued could not save that. What you typed is still here. Try again.";
    }
    if (active === confirmButton) {
      confirmButton?.focus({ preventScroll: true });
    }
  };

  const confirm = async (): Promise<void> => {
    if (confirming) return;
    if (error !== null) {
      error.hidden = true;
      error.textContent = '';
    }
    // D-314 — a required list with every box unticked is not saved: dropped, its
    // default would come back ticked; kept, the recipe would get no days.
    const listProblem = choiceListProblem(opts.variables, config);
    // D-319 — a dish without a required setting would run without it.
    const settingProblem = opts.requireSettings === true ? requiredSettingProblem(opts.variables, config) : null;
    const nameBox = queryOverlay<HTMLInputElement>(`[${CONFIG_EDITOR_NAME_ATTR}]`);
    const name = nameBox?.value.trim() ?? opts.name?.value.trim() ?? '';
    const nameProblem = opts.name?.required === true && name === '' ? 'Give it a name to tell it apart.' : null;
    const problem = listProblem ?? nameProblem ?? settingProblem;
    if (problem !== null) {
      if (error !== null) {
        error.hidden = false;
        error.textContent = problem;
      }
      return;
    }
    const cron = queryOverlay<HTMLSelectElement>(`[${CONFIG_EDITOR_SCHEDULE_ATTR}]`)?.value ?? '';
    let outcome: void | Promise<void>;
    try {
      outcome = opts.onConfirm({ ...config }, {
        ...(opts.name !== undefined ? { name } : {}),
        ...(cron !== '' ? { cron } : {}),
      });
    } catch {
      showConfirmFailure();
      return;
    }
    if (
      outcome === undefined
      || typeof (outcome as PromiseLike<void>).then !== 'function'
    ) {
      destroy();
      return;
    }
    setConfirming(true);
    try {
      await outcome;
      destroy();
    } catch {
      showConfirmFailure();
    }
  };

  overlay.addEventListener('click', (ev) => {
    const actor = (ev.target as (Element & {
      closest?: (s: string) => Element | null;
    }) | null)?.closest?.(`[${ACTION_ATTR}]`);
    const action = actor?.getAttribute(ACTION_ATTR);
    if (action === 'cancel') {
      if (confirming) return;
      destroy();
      return;
    }
    if (action === 'confirm') {
      void confirm();
    }
  });
  // Escape closes only this overlay — stop it before it reaches a parent
  // modal's document-level keydown.
  overlay.addEventListener('keydown', (ev) => {
    const event = ev as KeyboardEvent;
    if (event.key !== 'Escape') return;
    ev.stopPropagation();
    if (event.isComposing) return;
    if (!confirming) destroy();
  });

  doc.body.appendChild(overlay);

  if (opts.mailTemplates !== undefined) {
    const callers = opts.mailTemplates;
    mailTemplates = wireMailTemplateVariables(overlay, {
      callers: {
        ...callers,
        ...(callers.open !== undefined
          ? { open: (template_id: string) => { destroy(); callers.open!(template_id); } }
          : {}),
      },
      onChange: (key, value) => { config[key] = value; },
    });
  }

  // `record_ref` is independent of the owner's file inventory. Keep its one
  // upgrade path in the shared helper so a record-only host still gets a live
  // picker (and every host applies entity_filter + label hydration alike).
  if (opts.recordRefSearch !== undefined) {
    refPickers.push(...wireRecordRefVariables(overlay, {
      variables: opts.variables,
      values: config,
      idPrefix: 'cfg-edit-var',
      search: opts.recordRefSearch,
      onChange: (key, value) => { config[key] = value; },
    }));
  }

  // Upgrade file-ref rows only when the host can search the owner's file
  // inventory. The hidden `data-var-*` input remains the committed authority;
  // labels typed into the combobox never leak into config as fake refs.
  if (opts.fileRefSearch !== undefined && typeof overlay.querySelector === 'function') {
    const fileRefSearch = opts.fileRefSearch;
    for (const [key, def] of Object.entries(opts.variables)) {
      if (
        def === null
        || typeof def !== 'object'
        || Array.isArray(def)
        || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
      ) continue;
      const hintType = (def as { type?: unknown }).type;

      // D-215 slice 5 residual — the ORDERED list row. Its own wire module:
      // the value is a sequence, so an append box plus reorder controls, not
      // one combobox. Dispatched on the DECLARED type, per § 4.6's rule that
      // the control follows the type and never the recipe.
      if (hintType === 'file_ref[]') {
        const list = wireFileRefArray(overlay, {
          key,
          label: String((def as { label?: unknown }).label ?? key),
          idPrefix: 'cfg-edit-var',
          search: fileRefSearch,
          initialIds: toFileRefIds(
            Object.prototype.hasOwnProperty.call(config, key)
              ? config[key]
              : (def as { default?: unknown }).default,
          ),
          onChange: (ids) => { config[key] = ids; },
        });
        if (list !== null) fileRefArrays.push(list);
        continue;
      }

      if (hintType !== 'file_ref') continue;
      const pickerId = fileRefVariablePickerId(key, 'cfg-edit-var');
      if (overlay.querySelector(`[data-ref-picker="${pickerId}"]`) === null) continue;
      const raw = Object.prototype.hasOwnProperty.call(config, key)
        ? config[key]
        : (def as { default?: unknown }).default;
      const initialValue = typeof raw === 'string' && raw.length > 0
        ? { id: raw, label: raw }
        : null;
      const hidden = overlay.querySelector(
        `[${FILE_REF_VARIABLE_ATTR}="${key}"] [data-var-key="${key}"][data-var-type="file_ref"]`,
      ) as HTMLInputElement | null;
      const picker = wireRefPicker(overlay, {
        search: opts.fileRefSearch,
        config: {
          pickerId,
          placeholder: 'Search files',
          ariaLabel: `Choose ${(def as { label?: unknown }).label ?? key}`,
          emptyText: 'No matching files.',
        },
        minChars: 0,
        initialValue,
        onChange: (selection) => {
          const value = selection?.id ?? '';
          config[key] = value;
          if (hidden !== null) hidden.value = value;
        },
      });
      refPickers.push(picker);

      // D-215 § 9e — a dish (or an auto-run row) can hold a `file_ref` whose
      // underlying `data.file` was deleted. Nothing refcounts that: the
      // eviction cascade's keepsets are `cache ∪ collection refs` and
      // `shared ∪ annotation refs` — a config overlay is NOT a reference
      // root. Until this, the stale id rendered as its own label, i.e. as an
      // ordinary (if ugly) value, so a broken argument looked fine right up
      // until the run failed.
      //
      // Resolve the current id against the owner's inventory and RELABEL it
      // when absent. `setValue` deliberately does not fire `onChange`, so
      // this never rewrites the committed value — a broken ref stays exactly
      // as stored and is merely SHOWN as broken. Best-effort: a failing
      // search leaves the raw id, which is the pre-existing rendering.
      if (initialValue !== null) {
        const storedId = initialValue.id;
        void Promise.resolve(opts.fileRefSearch(storedId))
          .then((result) => {
            picker.setValue({
              id: storedId,
              label: fileRefDisplayLabel(storedId, asRefPickerSearchPage(result).options),
            });
          })
          .catch(() => { /* leave the raw id — no worse than before */ });
      }
    }
  }

  trap = wireFocusTrap({
    document: doc,
    getContainer: () => overlay,
    initialFocus: false,
  });
  trap.focusInitial();

  return {
    element: overlay,
    hasInFlightWork: () => !destroyed && confirming,
    destroy,
  };
};
