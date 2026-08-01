/** Shared config-editor overlay — one modal for editing a config overlay
 *  (a recipe's variable widgets, pre-filled). Used by the automation
 *  route's auto-run Config editor, the run modal's per-row Schedule/Trigger
 *  Config editor, and the recipe-detail install-config editor.
 *
 *  Self-contained: injects its own styles, owns a focus trap + Escape, and
 *  reads widget values into a config object (touched widgets only, so an
 *  untouched field never churns a redundant key). The overlay renders ONCE
 *  — no repaint / caret dance. The host wires `onConfirm` (which persists)
 *  and `onClose` (cleanup, e.g. re-arming a parent modal's trap).
 */

import type { VariableDefault } from '@recued/contracts';

import {
  FILE_REF_VARIABLE_ATTR,
  fileRefDisplayLabel,
  fileRefVariablePickerId,
  readWidgetValue,
  renderVariableWidget,
  toFileRefIds,
  toWidgetShape,
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

const STYLES_MARKER = 'data-recued-config-editor-styles';
const ACTION_ATTR = 'data-recued-config-editor-action';

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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.config-editor-title { margin: 0; font-size: 15px; font-weight: 600; }
.config-editor-copy { margin: 0; font-size: 12px; color: var(--muted); }
.config-editor-fields { display: grid; gap: 12px; }
.config-editor-actions { display: flex; justify-content: flex-end; }
.config-editor-button {
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
.config-editor-panel .var-row { display: grid; gap: 4px; }
.config-editor-panel .var-row-inline { display: block; }
.config-editor-panel .var-row > label,
.config-editor-panel .var-multi-label {
  font-size: 12px; font-weight: 600; color: var(--fg);
}
.config-editor-panel .var-row-inline > label {
  display: flex; align-items: center; gap: 7px; font-weight: 500;
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
  box-sizing: border-box; width: 100%; border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 9px; background: var(--surface); color: var(--fg); font: inherit;
}
.config-editor-panel .var-row input:focus,
.config-editor-panel .var-row select:focus { outline: none; border-color: var(--accent); }
.config-editor-panel .var-multi-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px;
}
.config-editor-panel .var-multi-opt { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg); }
${FILE_REF_ARRAY_STYLES}
`;

const injectStyles = (doc: Document): void => {
  if (doc.head.querySelector(`style[${STYLES_MARKER}]`) !== null) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLES_MARKER, '');
  style.textContent = `${CONFIG_EDITOR_STYLES}\n${REF_PICKER_STYLES}`;
  doc.head.appendChild(style);
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
  /** Fired on confirm with the collected config. The host persists it. */
  onConfirm: (config: Record<string, unknown>) => void;
  /** Fired after the overlay detaches (any path) — host cleanup. */
  onClose?: () => void;
}

export interface ConfigEditorOverlayHandle {
  element: HTMLElement;
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
            idPrefix: 'cfg-edit-var',
          });
    })
    .join('');

  const overlay = doc.createElement('div');
  overlay.className = 'config-editor-overlay';
  overlay.innerHTML = `
    <section class="config-editor-panel" role="dialog" aria-modal="true"
      aria-label="Edit config">
      <header class="config-editor-header">
        <h2 class="config-editor-title">${e(opts.title)}</h2>
        <button type="button" class="config-editor-button" ${ACTION_ATTR}="cancel">Close</button>
      </header>
      ${opts.copy !== undefined ? `<p class="config-editor-copy">${e(opts.copy)}</p>` : ''}
      <div class="config-editor-fields">${widgetRows}</div>
      <div class="config-editor-actions">
        <button type="button" class="config-editor-button config-editor-button--primary"
          ${ACTION_ATTR}="confirm">${e(opts.confirmLabel)}</button>
      </div>
    </section>`;

  let trap: FocusTrapHandle | null = null;
  const refPickers: RefPickerHandle[] = [];
  const fileRefArrays: FileRefArrayHandle[] = [];
  let destroyed = false;

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const picker of refPickers) picker.destroy();
    refPickers.length = 0;
    for (const list of fileRefArrays) list.destroy();
    fileRefArrays.length = 0;
    trap?.release();
    trap = null;
    overlay.remove();
    opts.onClose?.();
  };

  const onInput = (ev: Event): void => {
    const t = ev.target as HTMLElement | null;
    const key = t?.dataset.varKey;
    if (t !== null && key !== undefined && key.length > 0) {
      config[key] = readWidgetValue(t);
    }
  };
  overlay.addEventListener('input', onInput);
  overlay.addEventListener('change', onInput);
  overlay.addEventListener('click', (ev) => {
    const actor = (ev.target as (Element & {
      closest?: (s: string) => Element | null;
    }) | null)?.closest?.(`[${ACTION_ATTR}]`);
    const action = actor?.getAttribute(ACTION_ATTR);
    if (action === 'cancel') {
      destroy();
      return;
    }
    if (action === 'confirm') {
      opts.onConfirm(config);
      destroy();
    }
  });
  // Escape closes only this overlay — stop it before it reaches a parent
  // modal's document-level keydown.
  overlay.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') {
      ev.stopPropagation();
      destroy();
    }
  });

  doc.body.appendChild(overlay);

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

  return { element: overlay, destroy };
};
