/** D-145 PA6 — work-entity page CSS.
 *
 *  Scoped under `work-entity-*` so it doesn't collide with form-renderer
 *  (`form-renderer-*`), variable-widgets (`var-row`), connection-schemas,
 *  or any pre-PA6 page CSS.
 *
 *  Per project convention: rendering primitives ship a self-contained
 *  CSS string the host concatenates into the page stylesheet. The
 *  styling is intentionally minimal — visual polish is host
 *  responsibility; PA6 supplies enough structure for the
 *  composition to work without further config.
 */

export const WORK_ENTITY_PAGE_STYLES = `
.work-entity-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.work-entity-page-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.work-entity-page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.work-entity-page-source-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.work-entity-page-create {
  margin-left: auto;
  padding: 6px 12px;
  border: 1px solid var(--rx-accent, var(--accent));
  border-radius: 6px;
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
  cursor: pointer;
  font: inherit;
}
.work-entity-page-create:hover {
  filter: brightness(1.05);
}
.work-entity-page-create-disabled {
  margin: 0 0 0 auto;
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}

.work-entity-source-dropdown {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.work-entity-source-dropdown-label {
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-source-dropdown-select {
  padding: 4px 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}

.work-entity-source-chips {
  display: inline-flex;
  gap: 4px;
}
.work-entity-source-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 500;
  background: var(--rx-chip-bg, var(--surface-sunk));
  color: var(--rx-fg, var(--fg));
}
.work-entity-source-chip-write {
  background: var(--surface-sunk);
  color: var(--fg);
}
.work-entity-source-chip-readonly {
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
.work-entity-source-chip-mcp {
  background: var(--accent-weak);
  color: var(--accent);
}

.work-entity-list-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.work-entity-list-search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}
.work-entity-list-search {
  display: flex;
  gap: 10px;
  align-items: end;
}
.work-entity-list-filter-label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 150px;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-filter {
  padding: 6px 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  font: inherit;
}

.work-entity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.work-entity-list-row {
  margin: 0;
}
.work-entity-list-row-button {
  width: 100%;
  text-align: left;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  background: var(--rx-input-bg, var(--surface));
  padding: 10px 12px;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.work-entity-list-row-button:hover {
  border-color: var(--rx-accent, var(--accent));
}
.work-entity-list-row-primary {
  font-weight: 500;
  font-size: 14px;
}
.work-entity-list-row-secondary {
  font-size: 13px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-row-footer {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-list-row-source {
  background: var(--surface-sunk);
  padding: 1px 6px;
  border-radius: 9px;
  font-weight: 500;
}
.work-entity-list-empty {
  padding: 24px;
  text-align: center;
  color: var(--rx-muted, var(--fg-muted));
}

.work-entity-booking-detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px;
}
.work-entity-booking-detail-nav {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.work-entity-booking-detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.work-entity-booking-back,
.work-entity-booking-manage,
.work-entity-booking-edit {
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  padding: 7px 11px;
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  cursor: pointer;
  font: inherit;
}
.work-entity-booking-edit {
  border-color: var(--rx-accent, var(--accent));
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.work-entity-booking-manage:disabled {
  cursor: wait;
  opacity: .7;
}
.work-entity-booking-manage-notice {
  margin: -8px 0 0;
  overflow-wrap: anywhere;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-booking-manage-notice--error {
  color: var(--rx-danger, var(--danger));
}
.work-entity-booking-detail h1,
.work-entity-booking-detail h2,
.work-entity-booking-kicker { margin: 0; }
.work-entity-booking-kicker {
  color: var(--rx-muted, var(--fg-muted));
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .08em;
}
.work-entity-booking-state {
  display: inline-block;
  margin-top: 8px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--surface-sunk);
}
.work-entity-booking-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 0;
}
.work-entity-booking-facts div {
  padding: 10px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
}
.work-entity-booking-facts dt {
  color: var(--rx-muted, var(--fg-muted));
  font-size: 12px;
}
.work-entity-booking-facts dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.work-entity-booking-history-section { display: flex; flex-direction: column; gap: 10px; }
.work-entity-booking-history { list-style: none; margin: 0; padding: 0; }
.work-entity-booking-history li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rx-divider, var(--border));
}
.work-entity-booking-history-empty { color: var(--rx-muted, var(--fg-muted)); }

.work-entity-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 100;
}
.work-entity-dialog {
  background: var(--rx-input-bg, var(--surface));
  border-radius: 8px;
  width: min(560px, 100%);
  max-height: 90vh;
  overflow: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
}
.work-entity-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--rx-divider, var(--border));
}
.work-entity-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.work-entity-dialog-close {
  background: transparent;
  border: 0;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--rx-muted, var(--fg-muted));
}
.work-entity-dialog-form {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.work-entity-dialog-source-picker,
.work-entity-dialog-source-static {
  display: flex;
  align-items: center;
  gap: 8px;
}
.work-entity-dialog-source-readonly {
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--rx-fg, var(--fg));
}
.work-entity-dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--rx-divider, var(--border));
}
.work-entity-dialog-cancel,
.work-entity-dialog-submit {
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.work-entity-dialog-cancel {
  border: 1px solid var(--rx-divider, var(--border));
  background: var(--rx-input-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
}
.work-entity-dialog-submit {
  border: 1px solid var(--rx-accent, var(--accent));
  background: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.work-entity-dialog-submit[disabled] {
  opacity: 0.6;
  cursor: not-allowed;
}
.work-entity-dialog-submit-error {
  background: var(--danger-weak);
  border: 1px solid var(--danger);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--danger);
  font-size: 13px;
}
`;
