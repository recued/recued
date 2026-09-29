/** D-315 §6.1 — turning the owner's clicks on an email into a template's rules. */

import { describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailTemplateRule } from '@recued/contracts';

import {
  defaultEntranceVariables,
  describeRule,
  lineSpans,
  ruleFromPick,
  shapeOf,
  textSpans,
} from '../mail-fact-template-rules.js';

const shipment = getMailFactBuiltinType('shipment')!;

describe('the values an email offers', () => {
  it('offers the text after a label as one value', () => {
    expect(lineSpans('  Tracking Number: 1Z999AA10123456784')).toEqual([
      { kind: 'text', text: '  Tracking Number: ' },
      { kind: 'value', text: '1Z999AA10123456784', label: 'Tracking Number:' },
    ]);
    expect(lineSpans('Order #A-77')[1]).toEqual({ kind: 'value', text: 'A-77', label: 'Order #' });
  });

  it('does not take a time or a link for a label', () => {
    expect(lineSpans('10:30 at the door').some((span) => span.kind === 'value' && span.label !== undefined)).toBe(false);
    expect(lineSpans('https://example.com/track').some((span) => span.kind === 'value' && span.label !== undefined))
      .toBe(false);
  });

  it('offers amounts, dates, codes and long numbers inside a line, anchored on the words before them', () => {
    const values = lineSpans('Your total is $12.50, due 2026-10-01 for invoice 4471902').filter((s) => s.kind === 'value');
    expect(values).toEqual([
      { kind: 'value', text: '$12.50', context: 'Your total is' },
      { kind: 'value', text: '2026-10-01', context: 'due' },
      { kind: 'value', text: '4471902', context: 'for invoice' },
    ]);
  });

  it('offers nothing a line opens with: there are no words to anchor it', () => {
    expect(lineSpans('4471902 is your number').filter((s) => s.kind === 'value')).toEqual([]);
  });

  it('keeps every line, and caps a very long email', () => {
    expect(textSpans('a\r\nb\nc')).toHaveLength(3);
    expect(textSpans('x\n'.repeat(1_000))).toHaveLength(400);
  });
});

describe('a pick becomes a rule', () => {
  it('after a label', () => {
    const rules = ruleFromPick(
      { source: 'body', text: '1Z9', label: 'Tracking Number:' },
      { variable: 'tracking_number' },
      [],
    );
    expect(rules).toEqual([{
      target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' },
    }]);
  });

  it('by a pattern with one group, which finds the value again in its line', () => {
    const [rule] = ruleFromPick({ source: 'body', text: '$12.50', context: 'Your total is' }, { data: 'total_text' }, []);
    expect(rule?.find.kind).toBe('pattern');
    const pattern = rule!.find.kind === 'pattern' ? rule!.find.pattern : '';
    expect(pattern).toBe('Your total is\\s*(\\$\\d+\\.\\d+)');
    expect(new RegExp(pattern).exec('Your total is $104.99, thanks')?.[1]).toBe('$104.99');
  });

  it('whole, for the subject or the sender', () => {
    expect(ruleFromPick({ source: 'from_name', text: 'UPS' }, { variable: 'carrier' }, [])).toEqual([
      { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    ]);
  });

  it('replaces how a value was read, one rule per value', () => {
    const first = ruleFromPick({ source: 'body', text: 'x', label: 'Ref:' }, { variable: 'order_id' }, []);
    const second = ruleFromPick({ source: 'body', text: 'y', label: 'Order:' }, { variable: 'order_id' }, first);
    expect(second).toHaveLength(1);
    expect(second[0]?.find).toEqual({ kind: 'after_label', label: 'Order:' });
  });

  it('reads an enum from words: each pick adds what its words mean', () => {
    let rules: MailTemplateRule[] = ruleFromPick(
      { source: 'subject', text: 'Delivered' }, { variable: 'state', means: 'delivered' }, [],
    );
    rules = ruleFromPick({ source: 'subject', text: 'On the way' }, { variable: 'state', means: 'in_transit' }, rules);
    rules = ruleFromPick({ source: 'subject', text: 'delivered' }, { variable: 'state', means: 'returned' }, rules);
    expect(rules).toEqual([{
      target: { variable: 'state' },
      source: 'subject',
      find: {
        kind: 'keyword_map',
        cases: [{ contains: 'On the way', value: 'in_transit' }, { contains: 'delivered', value: 'returned' }],
      },
    }]);
  });

  it('shapes a value by its runs of digits and letters', () => {
    expect(shapeOf('1Z 999')).toBe('\\d[A-Za-z]\\s+\\d+');
    expect(shapeOf('A-77')).toBe('[A-Za-z]-\\d+');
  });
});

describe('in the owner’s words, and the default entrance', () => {
  it('describes each kind of rule', () => {
    expect(describeRule({ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking:' } }))
      .toEqual({ target: 'Tracking number', how: 'the text after “Tracking:” in the text' });
    expect(describeRule({ target: { variable: 'carrier' }, source: 'subject', find: { kind: 'constant', value: 'UPS' } }).how)
      .toBe('always “UPS”');
    expect(describeRule({ target: { data: 'items' }, source: 'html', find: { kind: 'whole' } }))
      .toEqual({ target: 'Data: items', how: 'all of the HTML' });
  });

  it('requires the type’s required values a rule reads from the email — not a constant', () => {
    expect(defaultEntranceVariables(shipment, [
      { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'T:' } },
      { target: { variable: 'carrier' }, source: 'subject', find: { kind: 'constant', value: 'UPS' } },
      { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Shop:' } },
    ])).toEqual(['tracking_number']);
  });
});
