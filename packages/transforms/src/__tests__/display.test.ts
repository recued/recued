import { describe, it, expect } from 'vitest';
import { to_checklist, to_table, to_summary, to_csv } from '../display.js';
import { ctx } from './helpers.js';

describe('to_checklist', () => {
  it('evaluates items', () => {
    let callCount = 0;
    const c = ctx({ evaluate: () => { callCount++; return callCount === 1; } });
    const r = to_checklist({
      title: 'Health',
      items: [
        { label: 'A', issue: 'cond1', detail_ok: 'good', detail_issue: 'bad' },
        { label: 'B', issue: 'cond2', detail_ok: 'fine', detail_issue: 'fail' },
      ],
    }, c) as { title: string; items: { label: string; status: string; detail: string }[] };
    expect(r.title).toBe('Health');
    expect(r.items[0]).toEqual({ label: 'A', status: 'issue', detail: 'bad' });
    expect(r.items[1]).toEqual({ label: 'B', status: 'ok', detail: 'fine' });
  });

  // ⛔ This used to stub `evaluate` to return null, which the engine's evaluator never
  // does, so it passed while no shipped `detail_null` could ever show. Unknown comes
  // from what the row judges being missing; the real evaluator drives it in
  // `packages/engine/src/__tests__/checklist-unknown-status.test.ts`.
  it('is unknown when what it judges is missing: detail_null, never detail_ok, and no comparison', () => {
    const evaluated: unknown[] = [];
    const c = ctx({
      resolve: (ref) => (ref === '{{step.days}}' ? null : 'present'),
      evaluate: (cond) => { evaluated.push(cond); return true; },
    });
    const r = to_checklist({
      title: 'T',
      items: [
        { label: 'X', issue: '{{step.days}} greater 14', detail_ok: 'Last activity  days ago', detail_issue: 'bad', detail_null: 'No activity' },
        { label: 'Y', issue: '{{step.days}} greater 14', detail_ok: 'Last activity  days ago', detail_issue: 'bad' },
      ],
    }, c) as { items: { label: string; status: string; detail?: string }[] };
    expect(r.items[0]).toEqual({ label: 'X', status: 'null', detail: 'No activity' });
    // No detail_null: the status says it; the detail_ok text would read the missing value.
    expect(r.items[1]).toEqual({ label: 'Y', status: 'null', detail: undefined });
    expect(evaluated).toEqual([]);
  });

  it('a row with no condition shows detail_ok, resolved once, or detail_null when a value it shows is missing', () => {
    const values: Record<string, unknown> = { '{{step.opener}}': 'Ask about the launch', '{{step.count:number}}': null };
    const c = ctx({
      resolve: (ref) => (ref in values ? values[ref] : `resolved(${ref})`),
      evaluate: () => { throw new Error('a row with no condition is never evaluated'); },
    });
    const r = to_checklist({
      title: 'T',
      items: [
        { label: 'Opener', detail_ok: '{{step.opener}}', detail_null: 'No opener' },
        { label: 'Count', detail_ok: '{{step.count:number}} objection(s) found', detail_null: 'Analysis unavailable' },
        { label: 'Static', detail_ok: 'Always here' },
      ],
    }, c) as { items: { label: string; status: string; detail?: unknown }[] };
    expect(r.items[0]).toEqual({ label: 'Opener', status: 'ok', detail: 'Ask about the launch' });
    expect(r.items[1]).toEqual({ label: 'Count', status: 'null', detail: 'Analysis unavailable' });
    expect(r.items[2]).toEqual({ label: 'Static', status: 'ok', detail: 'resolved(Always here)' });
  });

  it('passes action and actions through as output actions', () => {
    const first = { kind: 'recipe.run', label: 'Review', recipe_id: 'review-recipe' };
    const second = { kind: 'recipe.run', label: 'Close', recipe_id: 'close-recipe', variant: 'danger' };
    const r = to_checklist({
      title: 'T',
      items: [
        {
          label: 'X',
          issue: 'c',
          detail_ok: 'ok',
          detail_issue: 'bad',
          action: first,
          actions: [second],
        },
      ],
    }, ctx()) as { items: Array<{ actions?: unknown[] }> };
    expect(r.items[0].actions).toEqual([first, second]);
  });

  it('returns empty for invalid items', () => {
    const r = to_checklist({ title: 'T', items: null }, ctx()) as { items: unknown[] };
    expect(r.items).toEqual([]);
  });
});

describe('to_table', () => {
  it('passes through data', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const cols = [{ field: 'a', label: 'Col A' }];
    const r = to_table({ array: rows, columns: cols }, ctx()) as { columns: unknown[]; rows: unknown[] };
    expect(r.columns).toEqual(cols);
    expect(r.rows).toEqual(rows);
  });

  it('handles null', () => {
    const r = to_table({ array: null, columns: null }, ctx()) as { columns: unknown[]; rows: unknown[] };
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it('preserves action column metadata and row action values', () => {
    const action = { kind: 'recipe.run', label: 'Review', recipe_id: 'review-recipe' };
    const rows = [{ subject: 'A', actions: [action] }];
    const cols = [
      { field: 'subject', label: 'Subject' },
      { field: 'actions', label: 'Actions', type: 'action' },
    ];
    const r = to_table({ array: rows, columns: cols }, ctx()) as { columns: unknown[]; rows: unknown[] };
    expect(r.columns).toEqual(cols);
    expect(r.rows).toEqual(rows);
  });
});

describe('to_summary', () => {
  it('passes through fields', () => {
    const fields = [{ label: 'Score', value: 42 }];
    const r = to_summary({ fields }, ctx()) as { fields: unknown[] };
    expect(r.fields).toEqual(fields);
  });
});

describe('to_csv', () => {
  it('derives columns from row keys (first-seen order) with a header', () => {
    const rows = [{ name: 'Ada', age: 36 }, { name: 'Linus', age: 54 }];
    const r = to_csv({ array: rows }, ctx());
    expect(r).toBe('name,age\nAda,36\nLinus,54');
  });

  it('honors explicit field-name string columns + ordering', () => {
    const rows = [{ name: 'Ada', age: 36, city: 'London' }];
    const r = to_csv({ array: rows, columns: ['age', 'name'] }, ctx());
    expect(r).toBe('age,name\n36,Ada');
  });

  it('honors {field,label} columns (to_table shape)', () => {
    const rows = [{ id: 'd1', amt: 100 }];
    const r = to_csv({ array: rows, columns: [{ field: 'amt', label: 'Amount' }, { field: 'id', label: 'Deal' }] }, ctx());
    expect(r).toBe('Amount,Deal\n100,d1');
  });

  it('resolves dot-path fields', () => {
    const rows = [{ contact: { email: 'a@x.com' } }];
    const r = to_csv({ array: rows, columns: [{ field: 'contact.email', label: 'email' }] }, ctx());
    expect(r).toBe('email\na@x.com');
  });

  it('escapes delimiter, quotes, and newlines (RFC 4180)', () => {
    const rows = [{ note: 'a,b', quote: 'say "hi"', multi: 'line1\nline2' }];
    const r = to_csv({ array: rows }, ctx());
    expect(r).toBe('note,quote,multi\n"a,b","say ""hi""","line1\nline2"');
  });

  it('renders nullish cells as empty and unions sparse keys', () => {
    const rows = [{ a: 1 }, { b: 2 }];
    const r = to_csv({ array: rows }, ctx());
    expect(r).toBe('a,b\n1,\n,2');
  });

  it('JSON-stringifies nested object/array cells', () => {
    const rows = [{ tags: ['x', 'y'] }];
    const r = to_csv({ array: rows }, ctx());
    expect(r).toBe('tags\n"[""x"",""y""]"');
  });

  it('omits the header when header:false', () => {
    const rows = [{ a: 1, b: 2 }];
    const r = to_csv({ array: rows, header: false }, ctx());
    expect(r).toBe('1,2');
  });

  it('supports a custom delimiter', () => {
    const rows = [{ a: 1, b: 2 }];
    const r = to_csv({ array: rows, delimiter: ';' }, ctx());
    expect(r).toBe('a;b\n1;2');
  });

  it('serializes primitive rows one-per-line with no header', () => {
    const r = to_csv({ array: ['ada', 'linus'] }, ctx());
    expect(r).toBe('ada\nlinus');
  });

  it('returns empty string for non-array / empty input', () => {
    expect(to_csv({ array: null }, ctx())).toBe('');
    expect(to_csv({ array: [] }, ctx())).toBe('');
  });

  it('tolerates malformed column entries (null / empty-field) without throwing', () => {
    const rows = [{ name: 'Ada', age: 36 }];
    const r = to_csv({ array: rows, columns: [null, 'name', { field: '' }] }, ctx());
    expect(r).toBe('name\nAda'); // null + empty-field skipped, only `name` projected
  });

  it('falls back to key derivation when every explicit column is invalid', () => {
    const rows = [{ a: 1, b: 2 }];
    const r = to_csv({ array: rows, columns: [null, {}, { field: '' }] }, ctx());
    expect(r).toBe('a,b\n1,2'); // not object-JSON-per-line
  });

  it('header:false over sparse derived columns keeps column alignment', () => {
    const rows = [{ a: 1 }, { b: 2 }];
    const r = to_csv({ array: rows, header: false }, ctx());
    expect(r).toBe('1,\n,2');
  });

  it('quotes cells containing a multi-character delimiter', () => {
    const rows = [{ a: 'x||y', b: 'z' }];
    const r = to_csv({ array: rows, delimiter: '||' }, ctx());
    expect(r).toBe('a||b\n"x||y"||z');
  });

  it('treats a regex-special delimiter literally (no regex interpretation)', () => {
    const rows = [{ a: 'p|q' }];
    const r = to_csv({ array: rows, delimiter: '|' }, ctx());
    expect(r).toBe('a\n"p|q"');
  });

  it('quotes a CR-only cell', () => {
    const rows = [{ a: 'x\ry' }];
    const r = to_csv({ array: rows }, ctx());
    expect(r).toBe('a\n"x\ry"');
  });

  it('returns empty for prototype-pollution dot paths (no traversal)', () => {
    const rows = [{ a: 1 }];
    const r = to_csv({ array: rows, columns: [{ field: '__proto__.x', label: 'p' }] }, ctx());
    expect(r).toBe('p\n');
  });
});
