/** D-145 PA7 — mail-compose CSS.
 *
 *  Scoped under `mail-compose-*` to avoid colliding with PA6
 *  (`work-entity-*`), PA5 (`form-renderer-*`), or any pre-PA7 page
 *  CSS. Host concatenates this string into the page stylesheet.
 *
 *  Light visual baseline only — host stylesheets layer on theme
 *  values via the same `--rx-*` custom properties PA6 uses. */

export const MAIL_COMPOSE_STYLES = `
.mail-compose-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.mail-compose-dialog {
  background: var(--rx-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  border-radius: 8px;
  width: min(960px, 90vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.mail-compose-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--rx-divider, var(--border));
}

.mail-compose-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.mail-compose-close {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
}
.mail-compose-close:hover { background: var(--rx-hover-bg, var(--surface-sunk)); }
.mail-compose-close[disabled] { cursor: not-allowed; opacity: 0.55; }

.mail-compose-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 16px;
  padding: 16px;
  /* Scrolls on its own. No min-height:0 needed despite being a flex child of a
     column parent: the usual flexbox min-height:auto trap does not apply to an
     item whose own overflow is not visible — the automatic minimum size
     resolves to zero. Verified by measuring the real dialog in Chromium
     (clientHeight 757 vs scrollHeight 929, last row reachable) both with and
     without min-height:0, which changed nothing. */
  overflow: auto;
}

.mail-compose-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.mail-compose-sender-picker,
.mail-compose-sender-static,
.mail-compose-sender-readonly {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
  background: var(--rx-input-bg, var(--surface-sunk));
}

.mail-compose-sender-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--rx-muted, var(--fg-muted));
  min-width: 48px;
}

.mail-compose-sender-select {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-bg, var(--surface));
}

.mail-compose-sender-readonly {
  color: var(--rx-warning-fg, var(--fg));
  background: var(--rx-warning-bg, var(--surface-sunk));
}

.mail-compose-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.mail-compose-cancel,
.mail-compose-submit,
.mail-compose-ai-action {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--rx-divider, var(--border));
  background: var(--rx-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  cursor: pointer;
}
.mail-compose-submit {
  background: var(--rx-accent, var(--accent));
  border-color: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.mail-compose-submit[disabled],
.mail-compose-cancel[disabled],
.mail-compose-ai-action[disabled] {
  cursor: not-allowed;
  opacity: 0.55;
}

.mail-compose-submit-error {
  padding: 8px 12px;
  border: 1px solid var(--rx-error-border, var(--danger));
  border-radius: 4px;
  background: var(--rx-error-bg, var(--danger-weak));
  color: var(--rx-error-fg, var(--danger));
}

.mail-compose-ai-assist {
  border-left: 1px solid var(--rx-divider, var(--border));
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.mail-compose-ai-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--rx-muted, var(--fg-muted));
}

.mail-compose-ai-help {
  margin: 0;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}

.mail-compose-ai-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mail-compose-ai-action {
  text-align: left;
}

/* D-172 P2 — attachment picker. */
.mail-compose-attachments {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mail-compose-attachment-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mail-compose-attachment-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--rx-muted, var(--fg-muted));
}

.mail-compose-attachment-empty {
  margin: 0;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}

.mail-compose-attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mail-compose-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--rx-border, var(--border));
  border-radius: 4px;
}

/* The filename is the one part allowed to truncate — size and the remove
   control must stay legible, since the over-cap note is the whole reason the
   row is worth reading. */
.mail-compose-attachment-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.mail-compose-attachment-size,
.mail-compose-attachment-note {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}

.mail-compose-attachment[data-attachment-over-cap='true'] {
  border-color: var(--rx-danger, var(--danger, #b3261e));
}

/* Colour is a REINFORCEMENT here, never the signal — the note already says
   "over the 3.0 MB limit, will not be sent" in words, so the row still reads
   correctly in monochrome or to a screen reader. */
.mail-compose-attachment-note[data-attachment-state='over-cap'] {
  color: var(--rx-danger, var(--danger, #b3261e));
}

.mail-compose-attachment-remove {
  flex: 0 0 auto;
  line-height: 1;
}

.mail-compose-attachment-cap {
  margin: 0;
  font-size: 12px;
  color: var(--rx-muted, var(--fg-muted));
}
`;
