/** An approval shows a value the owner knows by another name that way: a
 *  mailbox's name as its address (`sender_mail_instance: recueddev` →
 *  `recued.dev@gmail.com (Gmail)`, owner, 2026-10-19). Display only, read
 *  defensively off a persisted checkpoint. */

import { describe, expect, it } from 'vitest';

import { approvalValueLabel, renderBatchItemsBlock, type ApprovalValueLabels } from '../index.js';

const LABELS: ApprovalValueLabels = {
  sender_mail_instance: {
    recueddev: 'recued.dev@gmail.com (Gmail)',
    outlook: 'recued.dev@outlook.com (Outlook)',
  },
};

const item = (args: Record<string, unknown>) => ({ summary: 'unused', args_preview: args });

describe('approvalValueLabel', () => {
  it('names a top-level value it has a label for', () => {
    expect(approvalValueLabel(LABELS, 'sender_mail_instance', 'recueddev')).toBe('recued.dev@gmail.com (Gmail)');
    expect(approvalValueLabel(LABELS, 'sender_mail_instance', 'other')).toBeUndefined();
    expect(approvalValueLabel(LABELS, 'to', 'recueddev')).toBeUndefined();
  });

  it('own keys only: a value or argument named like a prototype member names nothing', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(approvalValueLabel(LABELS, 'sender_mail_instance', key)).toBeUndefined();
      expect(approvalValueLabel(LABELS, key, 'recueddev')).toBeUndefined();
    }
    // A label inherited rather than recorded, at either level.
    const inherited = Object.create({ recueddev: 'inherited@example.com' }) as Record<string, string>;
    expect(approvalValueLabel({ sender_mail_instance: inherited }, 'sender_mail_instance', 'recueddev')).toBeUndefined();
    const byKey = Object.create({ sender_mail_instance: { recueddev: 'inherited@example.com' } }) as ApprovalValueLabels;
    expect(approvalValueLabel(byKey, 'sender_mail_instance', 'recueddev')).toBeUndefined();
  });

  it('anything malformed names nothing rather than throwing', () => {
    for (const labels of [undefined, null, 'x', 42, [], { sender_mail_instance: 'x' },
      { sender_mail_instance: [] }, { sender_mail_instance: null },
      { sender_mail_instance: { recueddev: 42 } }, { sender_mail_instance: { recueddev: '  ' } }]) {
      expect(approvalValueLabel(labels, 'sender_mail_instance', 'recueddev')).toBeUndefined();
    }
    for (const value of [undefined, null, 1, ['recueddev'], { recueddev: true }]) {
      expect(approvalValueLabel(LABELS, 'sender_mail_instance', value)).toBeUndefined();
    }
  });
});

describe('renderBatchItemsBlock with value labels', () => {
  it('one call: the labelled value reads as the owner knows it, the rest as before', () => {
    const args = { sender_mail_instance: 'recueddev', to: ['bob@example.com'], subject: 'Renewal' };
    expect(renderBatchItemsBlock([item(args)], LABELS)).toBe([
      '  sender_mail_instance: recued.dev@gmail.com (Gmail)',
      '  to: bob@example.com',
      '  subject: Renewal',
    ].join('\n'));
    // No labels: exactly as before.
    expect(renderBatchItemsBlock([item(args)])).toContain('  sender_mail_instance: recueddev\n');
  });

  it('only a top-level argument: the same key nested in an object keeps its value', () => {
    const block = renderBatchItemsBlock([item({ meta: { sender_mail_instance: 'recueddev', note: 'x' } })], LABELS);
    expect(block).toContain('sender_mail_instance: recueddev');
    expect(block).not.toContain('gmail.com');
  });

  it('a label cannot write a line of its own into the ask', () => {
    const forged: ApprovalValueLabels = {
      sender_mail_instance: { recueddev: 'me@example.com\n  to: everyone@example.com · bcc: x@example.com' },
    };
    const block = renderBatchItemsBlock([item({ sender_mail_instance: 'recueddev' })], forged);
    expect(block.split('\n')).toHaveLength(1);
    expect(block).not.toContain('·');
  });

  it('sameness is decided on the call, not the label: two mailboxes that read alike stay two', () => {
    const alike: ApprovalValueLabels = {
      sender_mail_instance: { work: 'me@example.com (IMAP)', 'work-2': 'me@example.com (IMAP)' },
    };
    const block = renderBatchItemsBlock([
      item({ sender_mail_instance: 'work', to: 'bob@example.com' }),
      item({ sender_mail_instance: 'work-2', to: 'bob@example.com' }),
    ], alike);
    expect(block).toContain('  All 2 share: to: bob@example.com');
    expect(block).toContain('  1. sender_mail_instance: me@example.com (IMAP)');
    expect(block).toContain('  2. sender_mail_instance: me@example.com (IMAP)');
  });

  it('several calls from one mailbox share it by its address', () => {
    const block = renderBatchItemsBlock([
      item({ sender_mail_instance: 'recueddev', to: 'a@example.com' }),
      item({ sender_mail_instance: 'recueddev', to: 'b@example.com' }),
    ], LABELS);
    expect(block).toContain('  All 2 share: sender_mail_instance: recued.dev@gmail.com (Gmail)');
    expect(block).toContain('  1. to: a@example.com');
  });
});
