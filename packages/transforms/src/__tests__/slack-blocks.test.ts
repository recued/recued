import { describe, it, expect } from 'vitest';
import { to_slack_blocks } from '../slack-blocks.js';
import type { TransformContext } from '../types.js';

// Unused in this transform — only the input params matter.
const ctx = null as unknown as TransformContext;

describe('to_slack_blocks — input shape', () => {
  it('non-array input → empty array', () => {
    expect(to_slack_blocks({ blocks: null }, ctx)).toEqual([]);
    expect(to_slack_blocks({ blocks: 'not an array' }, ctx)).toEqual([]);
    expect(to_slack_blocks({ blocks: 42 }, ctx)).toEqual([]);
  });

  it('empty array → empty array', () => {
    expect(to_slack_blocks({ blocks: [] }, ctx)).toEqual([]);
  });
});

describe('to_slack_blocks — text block', () => {
  it('plain text becomes a mrkdwn section', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'text', data: 'hello world' }],
    }, ctx) as unknown[];
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'hello world' },
    });
  });

  it('null / empty text → dropped (no empty section)', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'text', data: null }, { type: 'text', data: '' }],
    }, ctx) as unknown[];
    expect(out).toEqual([]);
  });
});

describe('to_slack_blocks — summary block', () => {
  it('renders fields as mrkdwn *label*\\nvalue pairs inside one section', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'summary',
        data: { fields: [
          { label: 'Stage', value: 'closed_won' },
          { label: 'Amount', value: '$50,000' },
        ] },
      }],
    }, ctx) as unknown[];
    expect(out).toEqual([
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Stage*\nclosed_won' },
          { type: 'mrkdwn', text: '*Amount*\n$50,000' },
        ],
      },
    ]);
  });

  it('splits into multiple sections when >10 fields (Slack per-section cap)', () => {
    const fields = Array.from({ length: 23 }, (_, i) => ({ label: `F${i}`, value: `v${i}` }));
    const out = to_slack_blocks({
      blocks: [{ type: 'summary', data: { fields } }],
    }, ctx) as Array<{ type: string; fields: unknown[] }>;
    expect(out).toHaveLength(3);
    expect(out[0].fields).toHaveLength(10);
    expect(out[1].fields).toHaveLength(10);
    expect(out[2].fields).toHaveLength(3);
  });

  it('missing value renders as em dash placeholder', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'summary', data: { fields: [{ label: 'X' }] } }],
    }, ctx) as Array<{ fields: Array<{ text: string }> }>;
    expect(out[0].fields[0].text).toBe('*X*\n—');
  });
});

describe('to_slack_blocks — checklist block', () => {
  it('title → header; items → mrkdwn section with status icons', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'checklist',
        data: {
          title: 'Pre-flight',
          items: [
            { label: 'Has owner', status: 'ok' },
            { label: 'Close date set', status: 'issue' },
            { label: 'Next step logged', status: 'null' },
          ],
        },
      }],
    }, ctx) as unknown[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'Pre-flight' },
    });
    expect(out[1]).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          ':white_check_mark: Has owner\n' +
          ':x: Close date set\n' +
          ':grey_question: Next step logged',
      },
    });
  });

  it('detail is appended after an em dash', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'checklist',
        data: {
          items: [{ label: 'Has owner', status: 'issue', detail: 'Assign one' }],
        },
      }],
    }, ctx) as Array<{ text?: { text: string } }>;
    expect(out[0].text?.text).toBe(':x: Has owner — Assign one');
  });

  it('unknown status falls back to bullet', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'checklist',
        data: { items: [{ label: 'Partial', status: 'weird' }] },
      }],
    }, ctx) as Array<{ text?: { text: string } }>;
    expect(out[0].text?.text).toBe('• Partial');
  });
});

describe('to_slack_blocks — table block', () => {
  it('renders as aligned code-block with header + separator + rows', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'table',
        data: {
          columns: [
            { field: 'name', label: 'Name' },
            { field: 'stage', label: 'Stage' },
          ],
          rows: [
            { name: 'Acme', stage: 'won' },
            { name: 'Globex', stage: 'lost' },
          ],
        },
      }],
    }, ctx) as Array<{ text: { text: string } }>;
    const body = out[0].text.text;
    expect(body).toContain('Name   | Stage');
    expect(body).toContain('Acme   | won');
    expect(body).toContain('Globex | lost');
    expect(body.startsWith('```')).toBe(true);
    expect(body.endsWith('```')).toBe(true);
  });

  it('null cell → em dash', () => {
    const out = to_slack_blocks({
      blocks: [{
        type: 'table',
        data: {
          columns: [{ field: 'x', label: 'X' }],
          rows: [{ x: null }, { x: 'y' }],
        },
      }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text).toContain('—');
    expect(out[0].text.text).toContain('y');
  });

  it('empty rows array still emits header', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'table', data: { columns: [{ field: 'x', label: 'X' }], rows: [] } }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text).toContain('X');
  });
});

describe('to_slack_blocks — ai_analysis block', () => {
  it('object is JSON-stringified inside a code block', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'ai_analysis', data: { risk: 'high', score: 0.82 } }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text).toContain('"risk"');
    expect(out[0].text.text).toContain('"high"');
    expect(out[0].text.text.startsWith('```')).toBe(true);
  });

  it('string passes through inside code block', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'ai_analysis', data: 'Analysis: deal is at risk' }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text).toBe('```\nAnalysis: deal is at risk\n```');
  });
});

describe('to_slack_blocks — label + unknown types', () => {
  it('label above a block becomes a header', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'text', data: 'hi', label: 'Notification' }],
    }, ctx) as Array<{ type: string }>;
    expect(out[0].type).toBe('header');
    expect(out[1].type).toBe('section');
  });

  it('unknown block type falls back to text rendering', () => {
    const out = to_slack_blocks({
      blocks: [{ type: 'made_up_kind', data: 'still works' }],
    }, ctx) as Array<{ text?: { text: string } }>;
    expect(out).toHaveLength(1);
    expect(out[0].text?.text).toBe('still works');
  });
});

describe('to_slack_blocks — truncation + 50-block cap', () => {
  it('caps at 50 blocks (Slack hard limit)', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ type: 'text', data: `${i}` }));
    const out = to_slack_blocks({ blocks: many }, ctx) as unknown[];
    expect(out).toHaveLength(50);
  });

  it('long section text is truncated with ellipsis at 3000 chars', () => {
    const long = 'x'.repeat(4000);
    const out = to_slack_blocks({
      blocks: [{ type: 'text', data: long }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text.length).toBe(3000);
    expect(out[0].text.text.endsWith('…')).toBe(true);
  });

  it('long header text is truncated at 150 chars', () => {
    const long = 'h'.repeat(200);
    const out = to_slack_blocks({
      blocks: [{ type: 'text', data: 'x', label: long }],
    }, ctx) as Array<{ text: { text: string } }>;
    expect(out[0].text.text.length).toBe(150);
  });
});
