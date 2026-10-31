import { describe, expect, it } from 'vitest';
import { deriveForwardValues, MAIL_DRAFT_SOURCE_MAX, type MailForwardContext } from '../index.js';

const context = (): MailForwardContext => ({
  original_source_id: 'work', mailbox_address: 'owner@example.test',
  original_message: {
    from: 'Sender <sender@example.test>', to: ['owner@example.test'], cc: ['copy@example.test'],
    subject: 'Updated delivery date', received_at: 1_700_000_000_000,
    body: 'The date is Friday.\nPlease confirm. <literal markup>', body_truncated: false, has_attachments: true,
  },
});

describe('plain-text forward context', () => {
  it('quotes the complete original without inheriting recipients, attachment refs or reply headers', () => {
    const source = context();
    const input = { ...source, original_message: { ...source.original_message,
      bcc: ['blind@example.test'], attachments: ['file-1'], id: '<original@example.test>', references: ['<root@example.test>'],
    } };
    const values = deriveForwardValues(input)!;
    expect(values).toMatchObject({ to: [], cc: [], bcc: [], attachments: [], in_reply_to: null,
      subject: 'Fwd: Updated delivery date', sender_source: 'work' });
    expect(values.references).toBeUndefined();
    expect(values.body).toContain('From: Sender <sender@example.test>\nDate: Tue, 14 Nov 2023 22:13:20 GMT');
    expect(values.body).toContain('To: owner@example.test\nCc: copy@example.test');
    expect(values.body.endsWith(source.original_message.body)).toBe(true);
    expect(values.body).not.toContain('blind@example.test');
    expect(input.original_message.body).toBe(source.original_message.body);
  });

  it('keeps existing forward prefixes and flattens source header control characters', () => {
    for (const subject of ['Fwd: Delivery', 'fw: Delivery', 'FWD:Delivery']) {
      const source = context(); source.original_message.subject = subject;
      expect(deriveForwardValues(source)?.subject).toBe(subject);
    }
    const source = context(); source.original_message.from = 'Sender\r\nBcc: hidden@example.test';
    source.original_message.subject = 'Delivery\nSubject: altered';
    const values = deriveForwardValues(source)!;
    expect(values.subject).toBe('Fwd: Delivery Subject: altered');
    expect(values.body).toContain('From: Sender  Bcc: hidden@example.test\n');
    expect(values.body).not.toContain('\nBcc: hidden@example.test');
  });

  it('refuses partial, oversized or unrenderable originals, while allowing a complete empty body', () => {
    const source = context(); source.original_message.body_truncated = true;
    expect(deriveForwardValues(source)).toBeNull();
    source.original_message.body_truncated = false; source.original_message.body = 'x'.repeat(MAIL_DRAFT_SOURCE_MAX + 1);
    expect(deriveForwardValues(source)).toBeNull();
    source.original_message.body = ''; source.original_message.received_at = Number.NaN;
    expect(deriveForwardValues(source)).toBeNull();
    source.original_message.received_at = 1_700_000_000_000;
    expect(deriveForwardValues(source)?.to).toEqual([]);
  });
});
