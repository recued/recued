/** D-145 PA7 — reply-context derivation.
 *
 *  Pin per § A.5.4:
 *    - to = sender of original
 *    - subject = "Re: <original>" (no double-Re)
 *    - in_reply_to = original message id
 *    - sender_source = original_source_id */

import { describe, expect, it } from 'vitest';

import { addReReplyPrefix, deriveReplyValues, deriveReplyAllValues, type MailReplyContext } from '../index.js';

describe('D-145 PA7 — addReReplyPrefix', () => {
  it('adds "Re: " when subject has no Re-prefix', () => {
    expect(addReReplyPrefix('Quarterly review')).toBe('Re: Quarterly review');
  });

  it('does not double-prefix when subject already starts with "Re: "', () => {
    expect(addReReplyPrefix('Re: Quarterly review')).toBe('Re: Quarterly review');
  });

  it('does not double-prefix on uppercase or mixed-case "RE: " / "rE: "', () => {
    expect(addReReplyPrefix('RE: Quarterly')).toBe('RE: Quarterly');
    expect(addReReplyPrefix('rE: Quarterly')).toBe('rE: Quarterly');
  });

  it('treats subjects starting with "Re:" without trailing space as needing a prefix', () => {
    // Mainstream clients converge on "Re: " (with space). A "Re:foo"
    // (no space) is not a valid Re-prefix; substrate adds "Re: " to be
    // unambiguous.
    expect(addReReplyPrefix('Re:Quarterly')).toBe('Re: Re:Quarterly');
  });

  it('handles empty subjects by emitting "Re: "', () => {
    expect(addReReplyPrefix('')).toBe('Re: ');
  });

  it('handles subjects that include "Re:" mid-string but do not start with it', () => {
    expect(addReReplyPrefix('FYI: Re: forwarded thread')).toBe(
      'Re: FYI: Re: forwarded thread',
    );
  });
});

describe('Reply all recipients', () => {
  const context: MailReplyContext = {
    mailbox_address: 'Owner@Example.test', original_source_id: 'work',
    original_message: { id: '<group@example.test>', subject: 'Delivery date', from: 'lead@example.test',
      reply_to: ['Desk <desk@example.test>'],
      to: ['owner@example.test', 'Colleague <COLLEAGUE@example.test>', 'desk@example.test'],
      cc: ['colleague@example.test', 'Copy <copy@example.test>', 'OWNER@example.test', 'copy@example.test'],
      references: ['<root@example.test>'], body: 'Please confirm.',
    },
  };

  it('keeps Reply-To and To/Cc roles, excludes the mailbox and duplicates, and preserves the thread', () => {
    const values = deriveReplyAllValues(context);
    expect(values).toEqual({ to: ['desk@example.test', 'colleague@example.test'], cc: ['copy@example.test'], bcc: [],
      subject: 'Re: Delivery date', sender_source: 'work', in_reply_to: '<group@example.test>',
      references: ['<root@example.test>', '<group@example.test>'] });
    expect(values).not.toHaveProperty('body');
    expect(values).not.toHaveProperty('attachments');
    expect(context.original_message.cc).toHaveLength(4);
    expect(deriveReplyValues(context).to).toEqual(['Desk <desk@example.test>']);
    expect(deriveReplyValues(context)).not.toHaveProperty('cc');
  });

  it('does not offer an identical Reply action or guess missing older-server metadata', () => {
    const { mailbox_address: _mailbox, ...legacy } = context;
    expect(deriveReplyAllValues(legacy)).toBeNull();
    const { cc: _cc, ...missingCopies } = context.original_message;
    expect(deriveReplyAllValues({ ...context, original_message: missingCopies })).toBeNull();
    expect(deriveReplyAllValues({ ...context, original_message: { ...context.original_message,
      to: ['owner@example.test', 'desk@example.test'], cc: ['DESK@example.test', 'owner@example.test'] } })).toBeNull();
    expect(deriveReplyAllValues({ ...context, original_message: { ...context.original_message,
      reply_to: ['owner@example.test'] } })).toBeNull();
  });

  it('refuses the whole group when a recipient is unsafe or contains a hidden address list', () => {
    for (const invalid of ['copy@example.test\r\nBcc: private@example.test', 'copy@example.test, private@example.test',
      'Hidden list <first,second@example.test>']) {
      expect(deriveReplyAllValues({ ...context, original_message: { ...context.original_message,
        cc: ['safe@example.test', invalid] } })).toBeNull();
    }
  });

  it('never copies an original blind recipient into the reply', () => {
    const original = { ...context.original_message, bcc: ['private@example.test'] };
    const values = deriveReplyAllValues({ ...context, original_message: original });
    expect(values?.bcc).toEqual([]);
    expect([...values!.to, ...values!.cc]).not.toContain('private@example.test');
  });
});

describe('D-145 PA7 — deriveReplyValues', () => {
  it('populates to / subject / in_reply_to / sender_source from the context', () => {
    const result = deriveReplyValues({
      original_message: {
        id: '<original@example.test>',
        subject: 'Lunch?',
        from: 'bob@example.com',
      },
      original_source_id: 'recued.mail_message',
    });
    expect(result).toEqual({
      to: ['bob@example.com'],
      subject: 'Re: Lunch?',
      in_reply_to: '<original@example.test>',
      references: ['<original@example.test>'],
      sender_source: 'recued.mail_message',
    });
  });

  it('does not populate cc / bcc / body / attachments — those stay user-driven', () => {
    const result = deriveReplyValues({
      original_message: { id: 'm', subject: 's', from: 'a@b.com' },
      original_source_id: 'src',
    }) as Record<string, unknown>;
    expect(result.cc).toBeUndefined();
    expect(result.bcc).toBeUndefined();
    expect(result.body).toBeUndefined();
    expect(result.attachments).toBeUndefined();
  });
});
