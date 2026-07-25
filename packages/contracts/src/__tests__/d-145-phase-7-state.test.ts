/** D-145 PA7 — mail-compose state machine.
 *
 *  Pin per § A.5 (Email compose UI):
 *    - initial state — dialog null
 *    - openCreateComposeTransition — empty values + default sender
 *    - openReplyComposeTransition — reply-context applied
 *    - setComposeValuesTransition / setComposeErrorsTransition /
 *      setComposeSubmittingTransition / setComposeSubmitErrorTransition
 *    - closeComposeTransition — locks while submitting
 *    - forceCloseComposeTransition — bypasses submitting lock
 *    - composeDialog accessor */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_MAIL_COMPOSE_VALUES,
  closeComposeTransition,
  composeDialog,
  forceCloseComposeTransition,
  initialMailComposeState,
  openCreateComposeTransition,
  openReplyComposeTransition,
  setComposeErrorsTransition,
  setComposeSubmitErrorTransition,
  setComposeSubmittingTransition,
  setComposeValuesTransition,
  type MailComposeState,
  type MailReplyContext,
} from '../index.js';

const replyContext: MailReplyContext = {
  original_message: {
    id: 'mail-123',
    subject: 'Q3 forecast',
    from: 'alice@example.com',
  },
  original_source_id: 'recued.mail_message',
};

describe('D-145 PA7 — initialMailComposeState', () => {
  it('seeds with dialog: null', () => {
    expect(initialMailComposeState()).toEqual({ dialog: null });
  });
});

describe('D-145 PA7 — openCreateComposeTransition', () => {
  it('opens a fresh dialog with empty values + default sender', () => {
    const state = openCreateComposeTransition(initialMailComposeState(), {
      default_sender_source_id: 'recued.mail_message',
    });
    expect(state.dialog).not.toBeNull();
    expect(state.dialog?.mode).toBe('create');
    expect(state.dialog?.values).toEqual({
      ...EMPTY_MAIL_COMPOSE_VALUES,
      sender_source: 'recued.mail_message',
    });
    expect(state.dialog?.errors).toEqual({});
    expect(state.dialog?.submitting).toBe(false);
    expect(state.dialog?.submit_error).toBeNull();
  });

  it('replaces an already-open dialog with a fresh state (no draft preservation at PA7)', () => {
    const open = openCreateComposeTransition(initialMailComposeState(), {
      default_sender_source_id: 'recued.mail_message',
    });
    const dirty = setComposeValuesTransition(open, {
      subject: 'Half-typed',
      body: 'wip',
    });
    const reopened = openCreateComposeTransition(dirty, {
      default_sender_source_id: 'hubspot.abc.mail_message',
    });
    expect(reopened.dialog?.values.subject).toBe('');
    expect(reopened.dialog?.values.body).toBe('');
    expect(reopened.dialog?.values.sender_source).toBe('hubspot.abc.mail_message');
  });
});

describe('D-145 PA7 — openReplyComposeTransition', () => {
  it('opens a dialog with reply-context applied', () => {
    const state = openReplyComposeTransition(initialMailComposeState(), replyContext);
    expect(state.dialog?.mode).toBe('reply');
    expect(state.dialog?.values.to).toEqual(['alice@example.com']);
    expect(state.dialog?.values.subject).toBe('Re: Q3 forecast');
    expect(state.dialog?.values.in_reply_to).toBe('mail-123');
    expect(state.dialog?.values.sender_source).toBe('recued.mail_message');
    expect(state.dialog?.values.body).toBe('');
  });
});

describe('D-145 PA7 — setComposeValuesTransition', () => {
  const open: MailComposeState = openCreateComposeTransition(initialMailComposeState(), {
    default_sender_source_id: 'recued.mail_message',
  });

  it('patches arbitrary fields on the open dialog', () => {
    const next = setComposeValuesTransition(open, {
      subject: 'Hello',
      to: ['alice@example.com'],
    });
    expect(next.dialog?.values.subject).toBe('Hello');
    expect(next.dialog?.values.to).toEqual(['alice@example.com']);
    // Unrelated values left intact.
    expect(next.dialog?.values.sender_source).toBe('recued.mail_message');
  });

  it('is a no-op when the dialog is closed', () => {
    const closed = initialMailComposeState();
    expect(setComposeValuesTransition(closed, { subject: 'x' })).toBe(closed);
  });

  it('clears submit_error when the user edits values after a failed submit', () => {
    const failed = setComposeSubmitErrorTransition(open, 'SMTP timeout');
    expect(failed.dialog?.submit_error).toBe('SMTP timeout');
    const retried = setComposeValuesTransition(failed, { subject: 'Retry' });
    expect(retried.dialog?.submit_error).toBeNull();
  });
});

describe('D-145 PA7 — setComposeErrorsTransition', () => {
  const open = openCreateComposeTransition(initialMailComposeState(), {
    default_sender_source_id: 'recued.mail_message',
  });

  it('writes an errors object onto the dialog', () => {
    const next = setComposeErrorsTransition(open, {
      subject: 'Subject is required.',
    });
    expect(next.dialog?.errors).toEqual({ subject: 'Subject is required.' });
  });

  it('clears errors when passed an empty map', () => {
    const dirty = setComposeErrorsTransition(open, { body: 'Body is required.' });
    const cleared = setComposeErrorsTransition(dirty, {});
    expect(cleared.dialog?.errors).toEqual({});
  });

  it('is a no-op when the dialog is closed', () => {
    const closed = initialMailComposeState();
    expect(setComposeErrorsTransition(closed, { x: 'y' })).toBe(closed);
  });
});

describe('D-145 PA7 — setComposeSubmittingTransition', () => {
  const open = openCreateComposeTransition(initialMailComposeState(), {
    default_sender_source_id: 'recued.mail_message',
  });

  it('flips submitting to true', () => {
    const next = setComposeSubmittingTransition(open, true);
    expect(next.dialog?.submitting).toBe(true);
  });

  it('returns the same state when submitting is unchanged', () => {
    expect(setComposeSubmittingTransition(open, false)).toBe(open);
  });
});

describe('D-145 PA7 — setComposeSubmitErrorTransition', () => {
  const open = setComposeSubmittingTransition(
    openCreateComposeTransition(initialMailComposeState(), {
      default_sender_source_id: 'recued.mail_message',
    }),
    true,
  );

  it('sets submit_error and flips submitting back to false', () => {
    const next = setComposeSubmitErrorTransition(open, 'SMTP timeout');
    expect(next.dialog?.submit_error).toBe('SMTP timeout');
    expect(next.dialog?.submitting).toBe(false);
  });

  it('clears submit_error when passed null', () => {
    const dirty = setComposeSubmitErrorTransition(open, 'SMTP timeout');
    const cleared = setComposeSubmitErrorTransition(dirty, null);
    expect(cleared.dialog?.submit_error).toBeNull();
  });
});

describe('D-145 PA7 — closeComposeTransition', () => {
  const open = openCreateComposeTransition(initialMailComposeState(), {
    default_sender_source_id: 'recued.mail_message',
  });

  it('clears the dialog when not submitting', () => {
    const closed = closeComposeTransition(open);
    expect(closed.dialog).toBeNull();
  });

  it('locks closing while submitting is true', () => {
    const sending = setComposeSubmittingTransition(open, true);
    const attempted = closeComposeTransition(sending);
    expect(attempted).toBe(sending);
  });

  it('is a no-op when already closed', () => {
    const closed = initialMailComposeState();
    expect(closeComposeTransition(closed)).toBe(closed);
  });
});

describe('D-145 PA7 — forceCloseComposeTransition', () => {
  it('closes regardless of submitting state', () => {
    const sending = setComposeSubmittingTransition(
      openCreateComposeTransition(initialMailComposeState(), {
        default_sender_source_id: 'recued.mail_message',
      }),
      true,
    );
    const closed = forceCloseComposeTransition(sending);
    expect(closed.dialog).toBeNull();
  });

  it('returns the same state when already closed', () => {
    const closed = initialMailComposeState();
    expect(forceCloseComposeTransition(closed)).toBe(closed);
  });
});

describe('D-145 PA7 — composeDialog accessor', () => {
  it('returns the open dialog', () => {
    const open = openCreateComposeTransition(initialMailComposeState(), {
      default_sender_source_id: 'recued.mail_message',
    });
    expect(composeDialog(open)).toBe(open.dialog);
  });

  it('returns null when closed', () => {
    expect(composeDialog(initialMailComposeState())).toBeNull();
  });
});
