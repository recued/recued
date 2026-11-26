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
  max-height: 90dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.mail-compose-header {
  flex: 0 0 auto;
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
  padding: 16px;
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scroll-padding-block: 12px;
}

.mail-compose-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  grid-template-rows: max-content 1fr;
  gap: 12px 16px;
  min-width: 0;
}

.mail-compose-message,
.mail-compose-fields,
.mail-compose-delivery {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.mail-compose-message { grid-area: 1 / 1; }
.mail-compose-fields,
.mail-compose-delivery { margin: 0; padding: 0; border: 0; }
.mail-compose-delivery { grid-area: 2 / 1; align-self: start; }
.mail-compose-side { display: contents; }
.mail-compose-copy-recipients { border: 1px solid var(--border); border-radius: 6px; padding: 0 10px; }
.mail-compose-copy-recipients summary { padding: 10px 0; color: var(--fg-muted); font-size: 13px; cursor: pointer; }
.mail-compose-copy-recipients[open] { padding-bottom: 12px; }
.mail-compose-fields [data-form-field="body"] { min-height: 144px; }
.mail-compose-fields:disabled,
.mail-compose-delivery:disabled { opacity: .75; }

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

.mail-compose-options {
  display: grid;
  gap: 8px;
  min-inline-size: 0;
  margin: 0;
  padding: 8px 12px 12px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 6px;
}
.mail-compose-options legend { padding-inline: 4px; font-size: 13px; font-weight: 600; }
.mail-compose-options p { margin: 0; color: var(--rx-muted, var(--fg-muted)); font-size: 13px; }
.mail-compose-option-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  overflow-wrap: anywhere;
}
.mail-compose-option-check input { flex: 0 0 auto; margin: 3px 0 0; }
.mail-compose-option-field {
  display: grid;
  gap: 4px;
  justify-items: start;
  min-inline-size: 0;
  font-size: 13px;
}
.mail-compose-option-field input, .mail-compose-option-field select {
  box-sizing: border-box;
  max-width: 100%;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--rx-divider, var(--border));
  border-radius: 4px;
  background: var(--rx-bg, var(--surface));
  color: inherit;
  font: inherit;
}
.mail-compose-actions, .mail-compose-draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mail-compose-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  padding: 10px 16px;
  border-top: 1px solid var(--rx-divider, var(--border));
}
[data-mail-draft-status] { margin: 0; }
[data-mail-draft-status]:empty { display: none; }

.mail-compose-cancel,
.mail-compose-submit,
.mail-compose-actions > button,
.mail-compose-draft-actions > button,
.mail-compose-attachment-add,
.mail-compose-ai-action {
  padding: 6px 12px;
  min-height: 36px;
  border-radius: 4px;
  border: 1px solid var(--rx-divider, var(--border));
  background: var(--rx-bg, var(--surface));
  color: var(--rx-fg, var(--fg));
  cursor: pointer;
}
.mail-compose-actions > .mail-compose-submit {
  background: var(--rx-accent, var(--accent));
  border-color: var(--rx-accent, var(--accent));
  color: var(--on-accent);
}
.mail-compose-actions > button[disabled],
.mail-compose-draft-actions > button[disabled],
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
  grid-area: 1 / 2 / span 2;
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

.mail-compose-ai-brief-label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.mail-compose-ai-brief-label textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 96px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; font: inherit; }
.mail-compose-ai-assist > .mail-compose-ai-action { width: 100%; margin: 8px 0; }
.mail-compose-discard { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.mail-compose-discard p { margin: 0 0 8px; }
.mail-compose-discard-actions { display:flex; flex-wrap:wrap; gap:8px; }
.mail-compose-discard button { min-height:44px; padding:8px 12px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:8px; }
.mail-compose-reply-context { margin: 0; overflow-wrap: anywhere; color: var(--fg-muted); }


.mail-compose-ai-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mail-compose-ai-action {
  text-align: left;
}

.mail-compose-ai-error {
  margin: 0;
  color: var(--rx-error-fg, var(--danger));
  font-size: 12px;
  line-height: 1.4;
}

.mail-compose-ai-undo {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--rx-accent, var(--accent));
  padding: 4px 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
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
@media (max-width: 680px) {
  .mail-compose-dialog { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
}
@media (max-width: 680px), (hover: none) and (pointer: coarse) {
  .mail-compose-form { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
  .mail-compose-message, .mail-compose-delivery { grid-area: auto / 1; }
  .mail-compose-ai-assist {
    grid-area: 1 / 1;
    margin-bottom: 4px;
    border-left: 0;
    border-bottom: 1px solid var(--border);
    padding: 0 0 16px;
  }
  [data-mode="forward"] .mail-compose-ai-assist {
    grid-row: auto;
    margin: 4px 0 0;
    border-top: 1px solid var(--border);
    border-bottom: 0;
    padding: 16px 0 0;
  }
  .mail-compose-ai-actions { flex-direction: row; flex-wrap: wrap; }
  .mail-compose-ai-actions button { flex: 1 1 auto; text-align: center; }
  .mail-compose-actions > button, .mail-compose-draft-actions > button,
  .mail-compose-option-field input, .mail-compose-option-field select { min-height: 44px; }
  .mail-compose-option-check { min-height: 44px; align-items: center; }
  .mail-compose-option-check input { margin-top: 0; }
}

@media (min-width: 1280px) and (hover: hover) and (pointer: fine) {
  .mail-compose-dialog { width: min(1120px, 90vw); border-radius: var(--wc-radius-lg, 14px); }
  .mail-compose-form {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 31%);
    grid-template-rows: auto;
    align-items: start;
    gap: var(--wc-space-lg, 24px);
  }
  .mail-compose-side {
    display: grid;
    grid-area: 1 / 2;
    gap: 16px;
    min-width: 0;
    padding-left: 16px;
    border-left: 1px solid var(--rx-divider, var(--border));
  }
  .mail-compose-delivery, .mail-compose-ai-assist { grid-area: auto; }
  .mail-compose-ai-assist { border-left: 0; padding-left: 0; }
  .mail-compose-delivery + .mail-compose-ai-assist {
    border-top: 1px solid var(--rx-divider, var(--border));
    padding-top: 16px;
  }
  .mail-compose-delivery .mail-compose-option-field :is(input, select) { width: 100%; min-width: 0; }
  .mail-compose-draft-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mail-compose-draft-actions > button { padding-inline: 8px; overflow-wrap: anywhere; }
  .mail-compose-draft-actions > button > svg { flex-shrink: 0; }

  .mail-compose-fields { gap: 10px; }
  .mail-compose-fields .form-renderer-form { gap: 8px; }
  .mail-compose-fields :is(.mail-compose-sender-picker, .mail-compose-sender-static,
    [data-form-row="to"], [data-form-row="subject"]):not([data-form-hidden="true"]) {
    display: grid;
    grid-template-columns: 5rem minmax(0, 1fr);
    align-items: start;
    column-gap: 12px;
  }
  .mail-compose-fields :is(.mail-compose-sender-picker, .mail-compose-sender-static) {
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
  }
  .mail-compose-fields .mail-compose-sender-label {
    color: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
  }
  .mail-compose-fields .mail-compose-sender-select { min-width: 0; min-height: var(--wc-control-h, 40px); }
  .mail-compose-fields .mail-compose-sender-value { overflow-wrap: anywhere; }
  .mail-compose-fields :is([data-form-row="to"], [data-form-row="subject"]) > .form-renderer-label {
    grid-area: 1 / 1;
    margin-top: 8px;
  }
  .mail-compose-fields :is([data-form-row="to"], [data-form-row="subject"]) > :is(.form-renderer-array, .form-renderer-input) {
    grid-area: 1 / 2;
  }
  .mail-compose-fields :is([data-form-row="to"], [data-form-row="subject"]) > :is(.form-renderer-help, .form-renderer-error) {
    grid-column: 2;
    margin: 0;
  }
  .mail-compose-copy-recipients > .form-renderer-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 12px;
  }
  .mail-compose-fields .form-renderer-array {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    padding: 0;
    border: 0;
  }
  .mail-compose-fields .form-renderer-array > :is(.form-renderer-array-item, .form-renderer-array-empty) { grid-column: 1; }
  .mail-compose-fields .form-renderer-array-add { grid-column: 2; }
  .mail-compose-fields .form-renderer-array-empty { align-self: center; }
  .mail-compose-fields :is(.form-renderer-array-add, .form-renderer-array-remove) { min-height: var(--wc-control-h, 40px); }
  .mail-compose-fields .form-renderer-array-item .form-renderer-input { min-width: 0; }
  .mail-compose-dialog .mail-compose-fields textarea[data-form-field="body"] { min-block-size: 144px; }
}
.mail-compose-actions > button, .mail-compose-draft-actions > button, .mail-compose-attachment-add, .mail-compose-close {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
`;
