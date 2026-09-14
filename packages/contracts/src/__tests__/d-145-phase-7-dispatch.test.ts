/** D-145 PA7 — compose-state → mail-send rpc payload.
 *
 *  Pin per § A.5.3:
 *    - happy path emits collection.mail.send rpc shape
 *    - empty `to` rejected
 *    - missing subject / body rejected
 *    - unresolved recipient ref rejected
 *    - sender_source missing / not found / not send_capable rejected
 *    - sender ≠ self self-loop guard on `to` (cc/bcc-self allowed)
 *    - cc / bcc populated when present
 *    - in_reply_to forwarded
 *    - sender source id → slug extraction (defaults to last-dot-segment)
 *    - host-supplied senderSourceToSlug override */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_MAIL_COMPOSE_VALUES,
  MAIL_MESSAGE_SUBJECT_MAX,
  composeStateToSendPayload,
  type ComposeDispatchHooks,
  type MailComposeValues,
  type MailSenderSourceOption,
} from '../index.js';

const senderRecued: MailSenderSourceOption = {
  id: 'recued.mail_message',
  label: 'Inbox (alice@example.com)',
  account_email: 'alice@example.com',
  send_capable: true,
  draft_capable: false,
  mail_instance_slug: 'primary',
};

const senderHubspot: MailSenderSourceOption = {
  id: 'hubspot.abc.mail_message',
  label: 'HubSpot (alice@example.com)',
  account_email: 'alice@example.com',
  send_capable: false,
  draft_capable: false,
  mail_instance_slug: 'hubspot-primary',
};

const senderRecuedAlt: MailSenderSourceOption = {
  id: 'recued.mail_message.work',
  label: 'Work (alice@work.com)',
  account_email: 'alice@work.com',
  send_capable: true,
  draft_capable: false,
  mail_instance_slug: 'work',
};

const baseValues: MailComposeValues = {
  ...EMPTY_MAIL_COMPOSE_VALUES,
  to: ['bob@example.com'],
  subject: 'Hello',
  body: 'Hi there',
  sender_source: senderRecued.id,
};

const baseHooks = (): ComposeDispatchHooks => ({
  resolveContactEmail: (ref) => {
    if (ref.includes('@')) return ref;
    if (ref === 'contact-9') return 'bob@example.com';
    return null;
  },
  findSenderSource: (id) => {
    if (id === senderRecued.id) return senderRecued;
    if (id === senderHubspot.id) return senderHubspot;
    if (id === senderRecuedAlt.id) return senderRecuedAlt;
    return null;
  },
});

describe('D-145 PA7 — composeStateToSendPayload (happy path)', () => {
  it('emits the rpc payload with the Source\'s mail_instance_slug verbatim', () => {
    const result = composeStateToSendPayload(baseValues, baseHooks());
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload).toEqual({
      instance: 'primary',
      to: ['bob@example.com'],
      subject: 'Hello',
      body_text: 'Hi there',
    });
  });

  it('disambiguates Sources whose ids differ but kind suffix collides', () => {
    // Pre-fold heuristic collapsed `recued.mail_message` and
    // `recued.mail_message.work` to the same trailing-segment slug;
    // post-fold the dispatch reads the explicit `mail_instance_slug`.
    const onPrimary = composeStateToSendPayload(
      { ...baseValues, sender_source: senderRecued.id },
      baseHooks(),
    );
    const onWork = composeStateToSendPayload(
      {
        ...baseValues,
        sender_source: senderRecuedAlt.id,
        to: ['carol@example.com'],
      },
      baseHooks(),
    );
    if (onPrimary.ok !== true || onWork.ok !== true)
      throw new Error('expected both ok');
    expect(onPrimary.payload.instance).toBe('primary');
    expect(onWork.payload.instance).toBe('work');
  });

  it('forwards cc / bcc / in_reply_to when present', () => {
    const result = composeStateToSendPayload(
      {
        ...baseValues,
        cc: ['carol@example.com'],
        bcc: ['dave@example.com'],
        in_reply_to: 'mail-99',
      },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.cc).toEqual(['carol@example.com']);
    expect(result.payload.bcc).toEqual(['dave@example.com']);
    expect(result.payload.in_reply_to).toBe('mail-99');
  });

  it('resolves contact-id refs to email via the host hook', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, to: ['contact-9'] },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.to).toEqual(['bob@example.com']);
  });

});

describe('D-145 PA7 — composeStateToSendPayload (validation)', () => {
  it('rejects when sender_source is empty', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, sender_source: '   ' },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.sender_source).toBeTruthy();
  });

  it('rejects when sender_source is not found', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, sender_source: 'unknown' },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.sender_source).toMatch(/not found/i);
  });

  it('rejects when sender_source is not send-capable', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, sender_source: senderHubspot.id },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.sender_source).toMatch(/outbound send/i);
  });

  it('rejects when sender_source resolves but mail_instance_slug is empty', () => {
    const broken: MailSenderSourceOption = {
      ...senderRecued,
      mail_instance_slug: '   ',
    };
    const result = composeStateToSendPayload(
      { ...baseValues, sender_source: broken.id },
      {
        ...baseHooks(),
        findSenderSource: (id) => (id === broken.id ? broken : null),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.sender_source).toMatch(/mail-instance/i);
  });

  it('rejects when subject is empty / whitespace', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, subject: '   ' },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.subject).toBeTruthy();
  });

  it('rejects when body is empty / whitespace', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, body: '\n  ' },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.body).toBeTruthy();
  });

  it('rejects when subject exceeds MAIL_MESSAGE_SUBJECT_MAX', () => {
    const longSubject = 'x'.repeat(MAIL_MESSAGE_SUBJECT_MAX + 1);
    const result = composeStateToSendPayload(
      { ...baseValues, subject: longSubject },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.subject).toMatch(/exceeds/i);
  });

  it('accepts a subject exactly at MAIL_MESSAGE_SUBJECT_MAX', () => {
    const atLimit = 'x'.repeat(MAIL_MESSAGE_SUBJECT_MAX);
    const result = composeStateToSendPayload(
      { ...baseValues, subject: atLimit },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.subject.length).toBe(MAIL_MESSAGE_SUBJECT_MAX);
  });

  it('D-172 P2 — carries a non-empty attachments array into the payload (no longer rejected)', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, attachments: ['file-1', 'file-2'] },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.attachments).toEqual(['file-1', 'file-2']);
  });

  it('omits the attachments field on the payload when the array is empty', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, attachments: [] },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.attachments).toBeUndefined();
  });

  it('rejects when `to` is empty', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, to: [] },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.to).toMatch(/at least one/i);
  });

  it('rejects when a `to` ref is unresolvable', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, to: ['ghost-id'] },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.to).toMatch(/contact graph/i);
  });

  it('rejects when a cc ref is unresolvable', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, cc: ['ghost-id'] },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.cc).toMatch(/contact graph/i);
  });

  it('rejects sending to yourself on `to`', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, to: [senderRecued.account_email] },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.to).toMatch(/yourself/i);
  });

  it('rejects self-loop on case + whitespace variants of the sender email', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, to: [` ${senderRecued.account_email.toUpperCase()} `] },
      {
        ...baseHooks(),
        resolveContactEmail: (ref) =>
          ref.includes('@') ? ref : null,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.to).toMatch(/yourself/i);
  });

  it('allows the sender on cc and bcc (archival)', () => {
    const result = composeStateToSendPayload(
      {
        ...baseValues,
        cc: [senderRecued.account_email],
        bcc: [senderRecued.account_email],
      },
      baseHooks(),
    );
    expect(result.ok).toBe(true);
    if (result.ok !== true) throw new Error('expected ok');
    expect(result.payload.cc).toEqual([senderRecued.account_email]);
    expect(result.payload.bcc).toEqual([senderRecued.account_email]);
  });

  it('aggregates multiple per-field errors when the user has compounding gaps', () => {
    const result = composeStateToSendPayload(
      { ...baseValues, subject: '', body: '' },
      baseHooks(),
    );
    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error('expected error');
    expect(result.errors.subject).toBeTruthy();
    expect(result.errors.body).toBeTruthy();
  });
});
