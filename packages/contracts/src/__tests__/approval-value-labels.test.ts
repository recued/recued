/** An approval shows a value the owner knows by another name that way: a
 *  mailbox's name as its address (`sender_mail_instance: recueddev` →
 *  `recued.dev@gmail.com (Gmail)`, owner, 2026-10-19). Display only, read
 *  defensively off a persisted checkpoint. */

import { describe, expect, it } from 'vitest';

import {
  ANY_ARGUMENT, approvalValueLabel, mergeValueLabels, nameValuesIn, renderBatchItemsBlock, type ApprovalValueLabels,
} from '../index.js';

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
    for (const value of [undefined, null, 1, [], ['recueddev', 1], [['recueddev']], { recueddev: true }]) {
      expect(approvalValueLabel(LABELS, 'sender_mail_instance', value)).toBeUndefined();
    }
  });

  // D-336 (spec §40) — a recipient reads as the contact it is, in a list as alone.
  const TO: ApprovalValueLabels = { to: { 'mia@example.com': 'Mia Whitfield <mia@example.com>' } };

  it('a list reads each member as the owner knows it, the count first when it has more than one', () => {
    expect(approvalValueLabel(TO, 'to', ['mia@example.com'])).toBe('Mia Whitfield <mia@example.com>');
    expect(approvalValueLabel(TO, 'to', 'mia@example.com')).toBe('Mia Whitfield <mia@example.com>');
    expect(approvalValueLabel(TO, 'to', ['bob@example.com', 'mia@example.com']))
      .toBe('2: bob@example.com, Mia Whitfield <mia@example.com>');
    // No member known: the line reads as it always did.
    expect(approvalValueLabel(TO, 'to', ['bob@example.com', 'eve@example.com'])).toBeUndefined();
    // Own keys only, member by member.
    expect(approvalValueLabel(TO, 'to', ['toString'])).toBeUndefined();
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

  it('a list of recipients: each known one by name, and a long list keeps its count when clipped', () => {
    const labels: ApprovalValueLabels = { to: { 'mia@example.com': 'Mia Whitfield <mia@example.com>' } };
    expect(renderBatchItemsBlock([item({ to: ['mia@example.com'], subject: 'Late' })], labels))
      .toBe('  to: Mia Whitfield <mia@example.com>\n  subject: Late');
    const many = Array.from({ length: 30 }, (_, i) => `person${String(i)}@example.com`);
    const block = renderBatchItemsBlock([item({ to: ['mia@example.com', ...many] })], labels);
    expect(block).toMatch(/^ {2}to: 31: Mia Whitfield <mia@example\.com>, person0@example\.com, /);
    expect(block.split('\n')).toHaveLength(1);
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

// D-336 (spec §41) — a person named wherever the call carries them.
describe('labels that name a value anywhere (`ANY_ARGUMENT`)', () => {
  const MIA = 'Mia Whitfield <mia@example.com>';
  const PEOPLE: ApprovalValueLabels = { [ANY_ARGUMENT]: { 'mia@example.com': MIA, '0123456789abcdef0123456789abcdef': 'Mia Whitfield' } };

  it('name a value under any argument; the argument\'s own label wins', () => {
    expect(approvalValueLabel(PEOPLE, 'attendee', 'mia@example.com')).toBe(MIA);
    expect(approvalValueLabel(PEOPLE, 'to', ['mia@example.com', 'bob@example.com'])).toBe(`2: ${MIA}, bob@example.com`);
    const both: ApprovalValueLabels = { ...PEOPLE, to: { 'mia@example.com': 'Mia at work' } };
    expect(approvalValueLabel(both, 'to', 'mia@example.com')).toBe('Mia at work');
    expect(approvalValueLabel(both, 'cc', 'mia@example.com')).toBe(MIA);
  });

  it('the ask names them at any depth: a nested field, and inside a list of objects', () => {
    const block = renderBatchItemsBlock([{ summary: 'x', args_preview: {
      event: { title: 'Dinner', attendees: [{ email: 'mia@example.com' }, { email: 'bob@example.com' }] },
      commitment: { counterparty_contact_id: '0123456789abcdef0123456789abcdef' },
      owner: 'mia@example.com',
    } }], PEOPLE);
    expect(block).toContain(`    attendees: 2: {email: ${MIA}}, {email: bob@example.com}`);
    // A name is never shortened as the id it stands for.
    expect(block).toContain('counterparty_contact_id: Mia Whitfield');
    expect(block).toContain(`  owner: ${MIA}`);
  });

  it('nameValuesIn copies only what it names, own keys only', () => {
    const value = { a: ['mia@example.com', 1, null], b: { c: 'bob@example.com' } };
    const named = nameValuesIn(value, PEOPLE) as typeof value;
    expect(named).toEqual({ a: [MIA, 1, null], b: { c: 'bob@example.com' } });
    expect(named.b).toBe(value.b);
    expect(value.a[0]).toBe('mia@example.com');
    const untouched = { b: { c: 'bob@example.com' } };
    expect(nameValuesIn(untouched, PEOPLE)).toBe(untouched);
    // A `__proto__` key stays a key of the copy, never its prototype.
    const proto = JSON.parse('{"__proto__": {"x": "mia@example.com"}}') as Record<string, unknown>;
    const copy = nameValuesIn(proto, PEOPLE) as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(nameValuesIn('toString', PEOPLE)).toBe('toString');
  });

  it('mergeValueLabels keeps the first\'s label, adds the second\'s, and skips what is malformed', () => {
    expect(mergeValueLabels(
      { to: { 'a@x.com': 'A' }, [ANY_ARGUMENT]: { 'b@x.com': 'B' } },
      { to: { 'a@x.com': 'Other A', 'c@x.com': 'C' }, [ANY_ARGUMENT]: { 'd@x.com': 'D' }, bad: 'x', worse: { e: 1 } },
    )).toEqual({ to: { 'a@x.com': 'A', 'c@x.com': 'C' }, [ANY_ARGUMENT]: { 'b@x.com': 'B', 'd@x.com': 'D' } });
    expect(mergeValueLabels(undefined, null)).toBeUndefined();
    expect(mergeValueLabels({ to: { x: '  ' } }, 'x')).toBeUndefined();
  });
});
