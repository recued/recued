/** Shared ref-picker — CSS.
 *
 *  Single block injected once by the host surface (same pattern as
 *  `FORM_RENDERER_STYLES`). Classes are scoped under `ref-picker-*`. The
 *  dropdown is absolutely positioned, so the host element carrying the
 *  shell must establish a positioning context — `.ref-picker` does.
 */

export const REF_PICKER_STYLES = `
.ref-picker {
  position: relative;
  display: block;
  width: 100%;
}

.ref-picker-field {
  position: relative;
  display: flex;
  align-items: center;
}

.ref-picker-input {
  font: inherit;
  min-height: 36px;
  padding: 6px 8px;
  padding-right: 40px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: var(--color-input-bg, var(--surface));
  color: inherit;
  width: 100%;
  box-sizing: border-box;
}

.ref-picker-input:focus {
  outline: none;
  border-color: var(--color-accent, var(--accent));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent, var(--accent)) 18%, transparent);
}

.ref-picker-clear {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary, var(--fg-muted));
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.ref-picker-clear:hover {
  background: var(--color-chip-bg, var(--surface-sunk));
  color: inherit;
}

.ref-picker-clear:focus-visible {
  outline: 2px solid var(--color-accent, var(--accent));
  outline-offset: 1px;
}

.ref-picker-clear[hidden] {
  display: none;
}

.ref-picker-results {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: var(--color-input-bg, var(--surface));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
}

.ref-picker-results[hidden] {
  display: none;
}

.ref-picker-option {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  min-height: 36px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.ref-picker-option--active,
.ref-picker-option:hover {
  background: var(--color-chip-bg, var(--surface-sunk));
}

.ref-picker-option--selected .ref-picker-option-label {
  font-weight: 600;
}

.ref-picker-option-label {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.85rem;
}

.ref-picker-option-sub {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 0.72rem;
  color: var(--color-text-secondary, var(--fg-muted));
}

.ref-picker-status {
  padding: 6px 8px;
  overflow-wrap: anywhere;
  font-size: 0.78rem;
  color: var(--color-text-secondary, var(--fg-muted));
}

.ref-picker-status--error {
  color: var(--color-warning, var(--danger));
}

/* ⛔ The truncation note is a FOOTNOTE ABOUT THE LIST, not another row in it —
   and it frequently sits directly under "No matches", the line it exists to
   correct. Styled identically it would read as more of the same muted chrome
   and be skipped, which is the failure it was added to prevent. A rule above it
   separates it from the results; italic marks it as commentary. NOT the error
   colour: a capped read is not a fault, and spending alarm here would blunt the
   colour where it means something. */
.ref-picker-status--truncated {
  border-top: 1px solid var(--color-border, var(--border));
  font-style: italic;
}
`;
