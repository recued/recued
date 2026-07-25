/** D-145 PA7 — mail-compose dialog renderer.
 *
 *  Wraps the PA5 form-renderer with a sender-Source picker, an
 *  AI-assist sidebar slot, and a submit / cancel footer. Mirrors the
 *  PA6 work-entity-dialog patterns:
 *    - Backdrop carries `data-action="close-mail-compose-on-backdrop"`
 *      (distinct from the close X / Cancel `close-mail-compose`); host
 *      MUST check `event.target === event.currentTarget` before
 *      closing on the backdrop action — otherwise click-bubbling from
 *      form-field inputs dismisses the dialog (PA6 P1 fold replicated
 *      here).
 *    - Submit + close + cancel buttons disable while
 *      `state.submitting === true`; the close X carries an
 *      `aria-disabled` mirror so screen readers announce the lock.
 *    - The sender-Source picker filters to send-capable Sources only;
 *      when zero send-capable Sources are registered, the picker
 *      collapses to a guidance banner + the submit button is disabled
 *      (defense-in-depth — host normally suppresses the dialog mount
 *      in this state; the substrate enforces independently).
 *
 *  Spec: docs/d-145-spec.md § A.5 (Email compose UI). */

import type {
  FormDefinition,
  MailComposeDialogState,
  MailSenderSourceOption,
} from '@recued/contracts';
import { e } from '../template.js';
import { renderForm } from '../form-renderer/render.js';
import { renderAiAssistSidebar } from './ai-assist-sidebar.js';

/** Drop the `sender_source` ref input from the form-renderer's view of
 *  the mail_message schema — the dialog renders a dedicated From
 *  picker on top of the form, and the canonical-schema-derived ref
 *  control would create a parallel uncurated input that bypasses the
 *  picker's send_capable filter. Codex P2 fold.
 *
 *  The field-name match is exact — the schema's relationship is named
 *  `sender_source`; if a future schema renames the slot, this filter
 *  becomes a no-op (the form renders the new name) and the dialog's
 *  picker remains the single source of truth. */
const SENDER_SOURCE_FIELD_NAME = 'sender_source';
const stripSenderSource = (definition: FormDefinition): FormDefinition => ({
  kind: definition.kind,
  fields: definition.fields.filter((f) => f.name !== SENDER_SOURCE_FIELD_NAME),
});

export interface MailComposeDialogProps {
  /** PA5 `FormDefinition` produced by `formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA)`.
   *  Hosts can pass a customized definition (e.g. without the
   *  `attachments` field while attachment-send isn't shipped) — the
   *  renderer walks whatever is passed. */
  definition: FormDefinition;
  state: MailComposeDialogState;
  /** Sender-Source picker options. The dialog filters to entries
   *  where `send_capable === true`. */
  sources: readonly MailSenderSourceOption[];
}

const dialogTitle = (mode: MailComposeDialogState['mode']): string =>
  mode === 'reply' ? 'Reply' : 'New mail';

export const renderMailComposeDialog = (
  props: MailComposeDialogProps,
): string => {
  const sendCapable = props.sources.filter((s) => s.send_capable === true);
  const senderPicker = renderSenderSourcePicker(
    props.state.values.sender_source,
    sendCapable,
  );
  // No send-capable Source registered → submit must stay disabled
  // regardless of submitting state (defense-in-depth — page-level
  // gate normally hides the compose entry point in this state).
  const cannotSubmit = sendCapable.length === 0;
  const submitDisabled = props.state.submitting === true || cannotSubmit;
  const submittingAttr = submitDisabled ? ' disabled' : '';
  const submitLabel = props.state.submitting === true ? 'Sending…' : 'Send';
  const submitError = props.state.submit_error
    ? `<div class="mail-compose-submit-error" role="alert">${e(props.state.submit_error)}</div>`
    : '';
  // Lock close while sending — the rpc is in flight, dismissing would
  // strand the request mid-call.
  const closeLockAttr =
    props.state.submitting === true ? ' aria-disabled="true" disabled' : '';
  return `
    <div
      class="mail-compose-backdrop"
      data-action="close-mail-compose-on-backdrop"
      data-mode="${e(props.state.mode)}"
    >
      <div
        class="mail-compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-compose-title"
        data-mode="${e(props.state.mode)}"
      >
        <header class="mail-compose-header">
          <h2 class="mail-compose-title" id="mail-compose-title">${e(dialogTitle(props.state.mode))}</h2>
          <button
            type="button"
            class="mail-compose-close"
            data-action="close-mail-compose"
            aria-label="Close"${closeLockAttr}
          >×</button>
        </header>
        <div class="mail-compose-body">
          <form class="mail-compose-form" data-form-kind="mail_message">
            ${senderPicker}
            ${renderForm(stripSenderSource(props.definition), {
              values: props.state.values as unknown as Record<string, unknown>,
              errors: props.state.errors,
            })}
            ${submitError}
            <footer class="mail-compose-actions">
              <button
                type="button"
                class="mail-compose-cancel"
                data-action="close-mail-compose"${closeLockAttr}
              >Cancel</button>
              <button
                type="button"
                class="mail-compose-submit"
                data-action="submit-mail-compose"${submittingAttr}
              >${e(submitLabel)}</button>
            </footer>
          </form>
          ${renderAiAssistSidebar({ submitting: props.state.submitting })}
        </div>
      </div>
    </div>
  `;
};

const renderSenderSourcePicker = (
  selected_source_id: string,
  sendCapable: readonly MailSenderSourceOption[],
): string => {
  if (sendCapable.length === 0) {
    return `
      <div class="mail-compose-sender-readonly" role="status">
        <strong>No send-capable mail Source.</strong> Connect a mail Source with outbound send (Settings → Connections → Mail) before composing.
      </div>
    `;
  }
  if (sendCapable.length === 1) {
    const only = sendCapable[0];
    return `
      <div class="mail-compose-sender-static">
        <span class="mail-compose-sender-label">From</span>
        <span class="mail-compose-sender-value" data-source-id="${e(only.id)}">${e(only.label)}</span>
      </div>
    `;
  }
  const options = sendCapable
    .map((s) => {
      const sel = s.id === selected_source_id ? ' selected' : '';
      return `<option value="${e(s.id)}"${sel}>${e(s.label)}</option>`;
    })
    .join('');
  return `
    <div class="mail-compose-sender-picker">
      <label class="mail-compose-sender-label" for="mail-compose-sender-select">From</label>
      <select
        id="mail-compose-sender-select"
        class="mail-compose-sender-select"
        data-action="select-mail-compose-sender"
        aria-label="From"
      >${options}</select>
    </div>
  `;
};
