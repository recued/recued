/** D-145 PA5 — form-renderer CSS.
 *
 *  Single style block injected once by the host surface. Class names
 *  are scoped under `form-renderer-*` so they don't collide with
 *  variable-widgets, connection-schemas, or any pre-PA5 form CSS.
 *
 *  Spec: D-145 § A.3.
 */

export const FORM_RENDERER_STYLES = `
.form-renderer-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-renderer-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-renderer-row[data-form-row-inline="true"] {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.form-renderer-label {
  font-weight: 600;
  font-size: 0.85rem;
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.form-renderer-required {
  color: var(--color-warning, var(--danger));
  font-weight: 700;
}

.form-renderer-origin-chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: 0.7rem;
  border-radius: 8px;
  background: var(--color-chip-bg, var(--surface-sunk));
  color: var(--color-chip-fg, inherit);
  text-transform: lowercase;
}

.form-renderer-help {
  font-size: 0.75rem;
  color: var(--color-text-secondary, var(--fg-muted));
  margin: 0;
}

.form-renderer-input,
.form-renderer-textarea,
.form-renderer-select {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: var(--color-input-bg, var(--surface));
  color: inherit;
  width: 100%;
  box-sizing: border-box;
}

.form-renderer-input[type="checkbox"] {
  width: auto;
  flex: 0 0 auto;
}

.form-renderer-input[aria-invalid="true"],
.form-renderer-textarea[aria-invalid="true"],
.form-renderer-select[aria-invalid="true"] {
  border-color: var(--color-warning, var(--danger));
}

.form-renderer-textarea {
  min-height: 80px;
  resize: vertical;
}

.form-renderer-error {
  font-size: 0.75rem;
  color: var(--color-warning, var(--danger));
}

.form-renderer-array {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px dashed var(--color-border, var(--border));
  border-radius: 4px;
  padding: 8px;
}

.form-renderer-array-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.form-renderer-array-item .form-renderer-input,
.form-renderer-array-item .form-renderer-select {
  flex: 1;
}

.form-renderer-array-empty {
  font-size: 0.75rem;
  color: var(--color-text-secondary, var(--fg-muted));
  padding: 4px 8px;
}

.form-renderer-array-add,
.form-renderer-array-remove {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.form-renderer-row[data-form-hidden="true"] {
  display: none;
}

/* Slice 2a — composition primitives. */

.form-renderer-object {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  padding: 10px 12px;
  background: var(--color-object-bg, transparent);
}

.form-renderer-object-scope {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-renderer-union {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-renderer-union-select {
  align-self: flex-start;
  min-width: 200px;
}

.form-renderer-union-variant {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  padding: 10px 12px;
  background: var(--color-union-variant-bg, transparent);
}

/* Show only the active variant. Inactive variants stay in the DOM so
 * the read path can switch on the discriminant without a re-render. */
.form-renderer-union-variant[data-form-variant-active="false"] {
  display: none;
}

.form-renderer-union-empty {
  font-size: 0.75rem;
  color: var(--color-text-secondary, var(--fg-muted));
  padding: 4px 8px;
}

.form-renderer-array-item-composite {
  align-items: stretch;
  flex-direction: column;
  gap: 8px;
}

.form-renderer-array-item-composite > .form-renderer-array-remove {
  align-self: flex-end;
}
`;
