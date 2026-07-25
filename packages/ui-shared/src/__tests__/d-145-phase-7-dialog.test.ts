/** D-145 PA7 — mail-compose dialog rendering.
 *
 *  Pin per § A.5:
 *    - Create dialog renders title "New mail" + sender picker +
 *      form-renderer body + Send / Cancel buttons.
 *    - Reply dialog renders title "Reply".
 *    - Single send-capable Source → sender rendered as static value.
 *    - Multiple send-capable Sources → sender rendered as <select>.
 *    - Zero send-capable Sources → guidance banner + submit disabled.
 *    - Submit-error banner renders when submit_error is set.
 *    - Submitting state: submit / cancel / close all disabled +
 *      "Sending…" label.
 *    - Backdrop carries close-on-backdrop action distinct from close X.
 *    - AI-assist sidebar slot present.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_MESSAGE_SCHEMA,
  formFromCanonicalSchema,
  type MailComposeDialogState,
  type MailSenderSourceOption,
} from '@recued/contracts';

import { renderMailComposeDialog } from '../mail-compose/dialog.js';

const def = formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA);

const senderRecued: MailSenderSourceOption = {
  id: 'recued.mail_message',
  label: 'Inbox (alice@example.com)',
  account_email: 'alice@example.com',
  send_capable: true,
  mail_instance_slug: 'primary',
};

const senderHubspot: MailSenderSourceOption = {
  id: 'hubspot.acme.mail_message',
  label: 'HubSpot (alice@example.com)',
  account_email: 'alice@example.com',
  send_capable: true,
  mail_instance_slug: 'hubspot-primary',
};

const senderNoSend: MailSenderSourceOption = {
  id: 'recued.mail_message',
  label: 'Inbox (alice@example.com)',
  account_email: 'alice@example.com',
  send_capable: false,
  mail_instance_slug: 'primary',
};

const baseState = (
  over: Partial<MailComposeDialogState> = {},
): MailComposeDialogState => ({
  mode: 'create',
  values: { ...EMPTY_MAIL_COMPOSE_VALUES, sender_source: senderRecued.id },
  errors: {},
  submitting: false,
  submit_error: null,
  ...over,
});

describe('D-145 PA7 — renderMailComposeDialog', () => {
  it('renders with the create-mode title and Send button', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued],
    });
    expect(html).toContain('id="mail-compose-title"');
    expect(html).toMatch(/>New mail</);
    expect(html).toContain('data-action="submit-mail-compose"');
    expect(html).toMatch(/>Send</);
  });

  it('renders with the reply-mode title', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState({ mode: 'reply' }),
      sources: [senderRecued],
    });
    expect(html).toMatch(/>Reply</);
    expect(html).toContain('data-mode="reply"');
  });

  it('renders the sender picker as a static label when only one send-capable Source', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued],
    });
    expect(html).toContain('mail-compose-sender-static');
    expect(html).not.toContain('data-action="select-mail-compose-sender"');
  });

  it('renders the sender picker as a <select> when multiple send-capable Sources', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued, senderHubspot],
    });
    expect(html).toContain('data-action="select-mail-compose-sender"');
    expect(html).toContain(senderRecued.label);
    expect(html).toContain(senderHubspot.label);
  });

  it('renders a guidance banner + disables submit when no send-capable Source', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderNoSend],
    });
    expect(html).toContain('mail-compose-sender-readonly');
    expect(html).toMatch(/data-action="submit-mail-compose"\s+disabled/);
  });

  it('paints submit-error banner', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState({ submit_error: 'SMTP timeout' }),
      sources: [senderRecued],
    });
    expect(html).toContain('mail-compose-submit-error');
    expect(html).toContain('SMTP timeout');
  });

  it('locks submit / cancel / close while submitting', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState({ submitting: true }),
      sources: [senderRecued],
    });
    expect(html).toMatch(/>Sending…</);
    // submit button has the disabled attr after the data-action
    expect(html).toMatch(/data-action="submit-mail-compose"\s+disabled/);
    // close X carries aria-disabled while submitting
    expect(html).toContain('aria-disabled="true"');
  });

  it('uses distinct close vs close-on-backdrop data-action values', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued],
    });
    expect(html).toContain('data-action="close-mail-compose-on-backdrop"');
    expect(html).toContain('data-action="close-mail-compose"');
  });

  it('mounts the AI-assist sidebar slot', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued],
    });
    expect(html).toContain('mail-compose-ai-assist');
    expect(html).toContain('data-stub="pa7"');
  });

  it('escapes user-controlled values in the dialog', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState({ submit_error: '<script>alert(1)</script>' }),
      sources: [senderRecued],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('strips the schema-derived sender_source ref so only the From picker is rendered', () => {
    // Codex P2 fold — pre-fold the form-renderer rendered a parallel
    // sender_source ref input alongside the dialog's curated From
    // picker. The dialog filters the field out of the FormDefinition
    // before passing it to renderForm.
    const html = renderMailComposeDialog({
      definition: def,
      state: baseState(),
      sources: [senderRecued, senderHubspot],
    });
    expect(html).not.toContain('data-form-field="sender_source"');
    // The curated picker is the only sender control.
    expect(html).toContain('data-action="select-mail-compose-sender"');
  });
});
