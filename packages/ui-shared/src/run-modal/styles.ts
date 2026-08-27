/** Shared Run | Schedule modal — CSS.
 *
 *  Injected once by the host (same pattern as `REF_PICKER_STYLES`). The
 *  overlay carries `data-recued-run-modal`; everything else is scoped
 *  under `.run-modal-*`. The `.var-*` block re-declares the variable-widget
 *  rules (the widgets render generic `var-row`/`var-help`/… class names)
 *  scoped to the modal panel, so the modal is self-contained — it does not
 *  depend on the recipes-route stylesheet being present.
 */

import {
  RUN_MODAL_CONFIG_ATTR,
  RUN_MODAL_CONTEXT_ATTR,
  RUN_MODAL_FACTS_ATTR,
  RUN_MODAL_OVERLAY_ATTR,
  RUN_MODAL_RESULT_ATTR,
} from './render.js';

export const RUN_MODAL_STYLES = `
[${RUN_MODAL_OVERLAY_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: start center;
  padding: 56px 16px 16px;
  background: rgba(24, 33, 36, .28);
}
.run-modal-panel {
  box-sizing: border-box;
  width: min(720px, 100%);
  max-height: calc(100vh - 80px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
  padding: 14px;
}
.run-modal-header {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.run-modal-title {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.run-modal-recipe-id {
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.run-modal-recipe-id code {
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.run-modal-close {
  flex: 0 0 auto;
  margin-left: auto;
}
.run-modal-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.run-modal-tab {
  box-sizing: border-box;
  min-height: 36px;
  appearance: none;
  border: none;
  background: none;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  padding: 8px 12px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.run-modal-tab[data-active="true"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
.run-modal-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.run-modal-body {
  display: grid;
  min-width: 0;
  gap: 10px;
}
.run-modal-copy {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.run-modal-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.run-modal-meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.run-modal-button {
  box-sizing: border-box;
  appearance: none;
  min-width: 36px;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.run-modal-button:disabled,
.run-modal-button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}
.run-modal-button--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.run-modal-select {
  box-sizing: border-box;
  max-width: 100%;
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 9px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
[${RUN_MODAL_OVERLAY_ATTR}] [${RUN_MODAL_CONFIG_ATTR}] {
  box-sizing: border-box;
  width: 100%;
  min-height: 140px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.run-modal-context-review > summary {
  box-sizing: border-box;
  min-height: 36px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
[${RUN_MODAL_OVERLAY_ATTR}] [${RUN_MODAL_CONTEXT_ATTR}] {
  box-sizing: border-box;
  width: 100%;
  max-height: 180px;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-subtle);
  padding: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.run-modal-context-target {
  display: grid;
  gap: 3px;
}
.run-modal-context-target code {
  overflow-wrap: anywhere;
  font: 12px/1.45 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.run-modal-fields {
  display: grid;
  gap: 12px;
  margin-bottom: 4px;
}
.run-modal-target-warning {
  background: var(--warn-subtle);
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
}
.run-modal-advanced > summary {
  box-sizing: border-box;
  min-height: 36px;
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.run-modal-rule-list {
  list-style: none;
  min-width: 0;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.run-modal-rule-row {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.run-modal-rule-row code {
  overflow-wrap: anywhere;
  font: 11px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.run-modal-rule-row > div {
  min-width: 0;
}
[${RUN_MODAL_OVERLAY_ATTR}] [${RUN_MODAL_RESULT_ATTR}] {
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-subtle);
  padding: 9px;
  font-size: 12px;
  color: var(--muted);
}
[${RUN_MODAL_OVERLAY_ATTR}] [${RUN_MODAL_FACTS_ATTR}] {
  display: block;
  margin-top: 4px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}
/* Variable-widget rules — the widgets emit generic class names; re-scope
   them to the modal panel so the modal is self-contained. */
.run-modal-panel .var-row {
  display: grid;
  gap: 4px;
}
.run-modal-panel .var-row-inline {
  display: block;
}
.run-modal-panel .var-row > label,
.run-modal-panel .var-multi-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
}
.run-modal-panel .var-row-inline > label {
  display: flex;
  align-items: center;
  min-height: 36px;
  gap: 7px;
  font-weight: 500;
}
.run-modal-panel .var-help {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
}
.run-modal-panel .var-optional {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 500;
  color: var(--fg-subtle, var(--muted));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.run-modal-panel .var-row input[type="text"],
.run-modal-panel .var-row input[type="number"],
.run-modal-panel .var-row input[type="password"],
.run-modal-panel .var-row select {
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
.run-modal-panel .var-row input:focus,
.run-modal-panel .var-row select:focus {
  outline: none;
  border-color: var(--accent);
}
.run-modal-panel .var-multi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
}
.run-modal-panel .var-multi-opt {
  display: flex;
  align-items: center;
  min-height: 36px;
  gap: 6px;
  font-size: 12px;
  color: var(--fg);
}
.run-modal-actions > label.run-modal-copy {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
}
.run-modal-panel .ref-picker-input {
  min-height: 36px;
  padding-right: 40px;
}
.run-modal-panel .ref-picker-clear {
  right: 0;
  width: 36px;
  height: 36px;
}
.run-modal-panel .ref-picker-option {
  box-sizing: border-box;
  min-height: 36px;
  justify-content: center;
}
.run-modal-panel .var-file-refs-btn {
  width: 36px;
  height: 36px;
}
@media (max-width: 520px) {
  .run-modal-header {
    align-items: flex-start;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 10px;
  }
  .run-modal-title,
  .run-modal-recipe-id {
    grid-column: 1;
  }
  .run-modal-close {
    grid-column: 2;
    grid-row: 1 / span 2;
    margin-left: 0;
  }
  .run-modal-actions {
    min-width: 0;
  }
  .run-modal-actions > .run-modal-select {
    flex: 1 1 100%;
    min-width: 0;
  }
  .run-modal-rule-row {
    align-items: stretch;
    flex-direction: column;
  }
}
`;
