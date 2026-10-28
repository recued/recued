/** A mail recipient is one address, bounded before anything parses it.
 *
 *  `mailRecipientUnsafeReason` is what every send refuses; the mail-send input
 *  contract (`normalizeMailSend`) adds one address per entry on top. The bound
 *  comes first because the parsers after it are quadratic on a long crafted
 *  string (nodemailer 9's addressparser, the collection's `extractAddress`). */

import { describe, expect, it } from 'vitest';
import { RpcError } from '../rpc/types.js';
import {
  MAIL_RECIPIENT_MAX_LENGTH,
  mailRecipientInvalidReason,
  mailRecipientUnsafeReason,
} from '../mail.js';
import { normalizeMailSend } from '../mail-compose/normalize.js';

/** An address exactly at the bound: a 64-character local part and a 255-character domain. */
const longest = `${'a'.repeat(64)}@${'b'.repeat(251)}.com`;

const send = (over: Record<string, unknown>) => normalizeMailSend({
  sender_mail_instance: 'work', to: ['ann@example.com'], subject: 'Hello', body: 'Hi.', ...over,
});

const refusal = (run: () => unknown): RpcError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('one mail recipient', () => {
  it('takes an address bare, with a display name, quoted with a comma, or with a comment', () => {
    expect(longest).toHaveLength(MAIL_RECIPIENT_MAX_LENGTH);
    for (const recipient of [
      'ann@example.com', 'Ann Lee <ann@example.com>', '"Lee, Ann" <ann@example.com>',
      'ann@example.com (Ann)', longest,
    ]) {
      expect(mailRecipientInvalidReason(recipient), recipient).toBeNull();
    }
  });

  it('refuses a list in one entry, a non-address, and whitespace inside the address', () => {
    expect(mailRecipientInvalidReason('ann@example.com, bob@example.com')).toMatch(/more than one address/);
    expect(mailRecipientInvalidReason('Ann <ann@example.com>; Bob <bob@example.com>')).toMatch(/more than one address/);
    for (const recipient of ['', 'ann', 'ann@', '@example.com', 'ann lee@example.com']) {
      expect(mailRecipientInvalidReason(recipient), recipient).toBe('is not an email address');
    }
  });

  it('⛔ refuses a line break: SMTP and Gmail write recipients into the headers as given', () => {
    expect(mailRecipientUnsafeReason('ann@example.com\r\nBcc: eve@example.com')).toMatch(/line break/);
    expect(mailRecipientUnsafeReason('ann@example.com\u0000')).toMatch(/control character/);
    expect(mailRecipientUnsafeReason('Ann Lee <ann@example.com>')).toBeNull();
  });

  it('⛔ checks the length before anything parses the string', () => {
    // One over the bound and well formed: a parse would accept it, so only a
    // length check that runs first can give this answer.
    expect(mailRecipientInvalidReason(`${longest}x`)).toBe(`is longer than ${MAIL_RECIPIENT_MAX_LENGTH} characters`);
    for (const crafted of ['[x]'.repeat(100_000), '<'.repeat(300_000)]) {
      expect(mailRecipientUnsafeReason(crafted)).toBe(`is longer than ${MAIL_RECIPIENT_MAX_LENGTH} characters`);
    }
  });
});

describe('normalizeMailSend', () => {
  it('names the entry it refuses, in to, cc, bcc and reply_to', () => {
    expect(refusal(() => send({ to: ['ann@example.com', 'x'.repeat(400)] })).message)
      .toBe(`mail-send: to[1] is longer than ${MAIL_RECIPIENT_MAX_LENGTH} characters`);
    expect(refusal(() => send({ to: 'not an address' })).message).toBe('mail-send: to is not an email address');
    expect(refusal(() => send({ cc: ['ann@example.com, bob@example.com'] })).message)
      .toMatch(/^mail-send: cc\[0\] holds more than one address/);
    expect(refusal(() => send({ bcc: ['bob@example.com\nX-Extra: 1'] })).message)
      .toMatch(/^mail-send: bcc\[0\] contains a line break/);
    expect(refusal(() => send({ reply_to: 'the desk' })).message).toBe('mail-send: reply_to is not an email address');
    expect(refusal(() => send({ to: ['x'.repeat(400)] })).code).toBe('BAD_INPUT');
  });

  it('passes accepted recipients through unchanged, and leaves references alone', () => {
    expect(send({
      to: ['Ann Lee <ann@example.com>'], cc: 'bob@example.com', reply_to: 'desk@example.com',
      references: ['<m1@example.com>', 'not-an-address'],
    })).toMatchObject({
      to: ['Ann Lee <ann@example.com>'], cc: ['bob@example.com'], reply_to: 'desk@example.com',
      references: ['<m1@example.com>', 'not-an-address'],
    });
  });
});
