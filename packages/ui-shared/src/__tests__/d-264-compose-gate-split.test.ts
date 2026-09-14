/** D-264 slice 2 — the compose dialog's two gates are two gates.
 *
 *  Before D-264 one `submitDisabled` drove all four controls, so a mailbox
 *  that could not send could not save a draft either. The split has to hold in
 *  both directions, and the interesting direction is the one that used to be
 *  wrong: **no send-capable Source ⇒ Save draft ENABLED, Send and Schedule
 *  disabled.**
 *
 *  ⚠ The Send gate is PER-SOURCE. An install-level check would leave Send
 *  enabled while a draft-only Source is selected and push the refusal down into
 *  `composeStateToSendPayload` — the same refusing-button failure, one layer
 *  lower. The mixed-set case below is what distinguishes the two.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_MESSAGE_SCHEMA,
  formFromCanonicalSchema,
  type MailComposeDialogState,
  type MailSenderSourceOption,
} from '@recued/contracts';
import { renderMailComposeDialog, SEND_UNAVAILABLE_ATTR } from '../mail-compose/dialog.js';

const def = formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA);

const source = (over: Partial<MailSenderSourceOption>): MailSenderSourceOption => ({
  id: 'work',
  label: 'me@example.com (IMAP)',
  account_email: 'me@example.com',
  send_capable: false,
  draft_capable: false,
  mail_instance_slug: 'work',
  ...over,
});

const state = (
  over: Partial<MailComposeDialogState> = {},
): MailComposeDialogState => ({
  mode: 'create',
  values: { ...EMPTY_MAIL_COMPOSE_VALUES },
  errors: {},
  submitting: false,
  submit_error: null,
  ...over,
});

const render = (
  sources: readonly MailSenderSourceOption[],
  values: Partial<MailComposeDialogState['values']> = {},
): string => renderMailComposeDialog({
  definition: def,
  state: state({ values: { ...EMPTY_MAIL_COMPOSE_VALUES, ...values } }),
  sources,
  savedDraft: { status: '', scheduling: false, runAt: '' },
});

/** `data-action="x" disabled` — the attribute order the renderer emits. */
const disabled = (html: string, action: string): boolean =>
  new RegExp(`data-action="${action}"[^>]*\\sdisabled`).test(html);
const present = (html: string, action: string): boolean =>
  html.includes(`data-action="${action}"`);

describe('D-264 — draft-only install: Save draft works, Send does not', () => {
  const draftOnly = [source({ id: 'imap', draft_capable: true })];

  it('enables Save draft while disabling Send and Schedule', () => {
    const html = render(draftOnly);
    expect(present(html, 'save-mail-draft')).toBe(true);
    expect(disabled(html, 'save-mail-draft')).toBe(false);
    expect(disabled(html, 'submit-mail-compose')).toBe(true);
    expect(disabled(html, 'schedule-mail-draft')).toBe(true);
  });

  it('says WHY Send is off rather than disabling it silently', () => {
    expect(render(draftOnly)).toContain(SEND_UNAVAILABLE_ATTR);
  });

  it('lists the draft-only mailbox in the From picker instead of the empty banner', () => {
    const html = render(draftOnly);
    expect(html).not.toContain('mail-compose-sender-readonly');
    expect(html).toContain('me@example.com');
  });
});

describe('D-264 — the Send gate is per-source, not per-install', () => {
  const mixed = [
    source({ id: 'gmail', send_capable: true, draft_capable: true }),
    source({ id: 'imap', draft_capable: true }),
  ];

  it('disables Send when the SELECTED source cannot send, though another can', () => {
    const html = render(mixed, { sender_source: 'imap' });
    expect(disabled(html, 'submit-mail-compose')).toBe(true);
    expect(disabled(html, 'save-mail-draft')).toBe(false);
    expect(html).toContain(SEND_UNAVAILABLE_ATTR);
  });

  it('enables Send when the selected source can send', () => {
    const html = render(mixed, { sender_source: 'gmail' });
    expect(disabled(html, 'submit-mail-compose')).toBe(false);
    expect(disabled(html, 'save-mail-draft')).toBe(false);
    expect(html).not.toContain(SEND_UNAVAILABLE_ATTR);
  });
});

describe('D-264 — the unchanged ends', () => {
  it('a fully send-capable install disables nothing and explains nothing', () => {
    const html = render([source({ send_capable: true, draft_capable: true })]);
    expect(disabled(html, 'submit-mail-compose')).toBe(false);
    expect(disabled(html, 'save-mail-draft')).toBe(false);
    expect(disabled(html, 'schedule-mail-draft')).toBe(false);
    expect(html).not.toContain(SEND_UNAVAILABLE_ATTR);
  });

  it('an install with nothing composable keeps the pre-D-264 banner and disables both', () => {
    const html = render([source({})]);
    expect(html).toContain('mail-compose-sender-readonly');
    expect(disabled(html, 'save-mail-draft')).toBe(true);
    expect(disabled(html, 'submit-mail-compose')).toBe(true);
    // Nothing works here, so the draft-only explanation would be a lie.
    expect(html).not.toContain(SEND_UNAVAILABLE_ATTR);
  });

  it('busy states still gate Save draft — it is a write in flight, not a send', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: state({ submitting: true }),
      sources: [source({ send_capable: true, draft_capable: true })],
      savedDraft: { status: '', scheduling: false, runAt: '' },
    });
    expect(disabled(html, 'save-mail-draft')).toBe(true);
  });
});


describe('D-264 — Save to mailbox is gated on the SELECTED source', () => {
  /** The exit the `draft_only` gate was always promising. Without this control
   *  the readiness tier opens compose on a capability the UI never offers —
   *  `draft_capable` measured and never used. */
  it('is live for a draft-capable sender that cannot send', () => {
    const html = render([source({ id: 'imap', draft_capable: true })]);
    expect(present(html, 'save-mail-draft-to-mailbox')).toBe(true);
    expect(disabled(html, 'save-mail-draft-to-mailbox')).toBe(false);
    // …while the two send paths stay shut.
    expect(disabled(html, 'submit-mail-compose')).toBe(true);
    expect(disabled(html, 'schedule-mail-draft')).toBe(true);
  });

  it('is dead for a send-only sender — the grants are independent', () => {
    // `gmail.send` without `gmail.modify`: can send, cannot hold a draft.
    const html = render([source({ id: 'gmail', send_capable: true })]);
    expect(disabled(html, 'save-mail-draft-to-mailbox')).toBe(true);
    expect(disabled(html, 'submit-mail-compose')).toBe(false);
  });

  it('follows the SELECTED source on a mixed install, both ways', () => {
    const mixed = [
      source({ id: 'gmail', send_capable: true }),
      source({ id: 'imap', draft_capable: true }),
    ];
    const onGmail = render(mixed, { sender_source: 'gmail' });
    expect(disabled(onGmail, 'save-mail-draft-to-mailbox')).toBe(true);
    expect(disabled(onGmail, 'submit-mail-compose')).toBe(false);

    const onImap = render(mixed, { sender_source: 'imap' });
    expect(disabled(onImap, 'save-mail-draft-to-mailbox')).toBe(false);
    expect(disabled(onImap, 'submit-mail-compose')).toBe(true);
  });

  it('carries its own outcome on the label — the dialog stays open', () => {
    const html = renderMailComposeDialog({
      definition: def,
      state: state(),
      sources: [source({ draft_capable: true })],
      savedDraft: { status: '', scheduling: false, runAt: '', mailboxStatus: 'Saved to mailbox ✓' },
    });
    expect(html).toContain('Saved to mailbox ✓');
  });
});
