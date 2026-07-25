/** D-145 PA7 — reply-context derivation.
 *
 *  Pin per § A.5.4:
 *    - to = sender of original
 *    - subject = "Re: <original>" (no double-Re)
 *    - in_reply_to = original message id
 *    - sender_source = original_source_id */

import { describe, expect, it } from 'vitest';

import { addReReplyPrefix, deriveReplyValues } from '../index.js';

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

describe('D-145 PA7 — deriveReplyValues', () => {
  it('populates to / subject / in_reply_to / sender_source from the context', () => {
    const result = deriveReplyValues({
      original_message: {
        id: 'mail-555',
        subject: 'Lunch?',
        from: 'bob@example.com',
      },
      original_source_id: 'recued.mail_message',
    });
    expect(result).toEqual({
      to: ['bob@example.com'],
      subject: 'Re: Lunch?',
      in_reply_to: 'mail-555',
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
