/** `label` reaches every kind that can show a heading — no kind drops it silently.
 *
 *  ⛔ WHY. `label` is the only display field `OutputSection` has, and the dispatcher used to
 *  hand it to exactly two kinds (`copyable`, `json`) while `table` / `summary` / `ai_analysis`
 *  / `text` / `file_artifact` silently ignored it. 212 shipped sections declare one. The
 *  webclient masked the whole thing behind its own `<h3>`, so the drop surfaced only on a
 *  reception page: the same recipe, through the same package, showed its section titles to
 *  the owner and withheld them from a visitor.
 *
 *  This is the declared-is-not-backed shape again — the sibling of the `output_unknown_key`
 *  fence. The fence stops you AUTHORING a field nothing reads; this stops a field the
 *  contract really has from being read by only some of its readers.
 */

import { describe, it, expect } from 'vitest';
import { OUTPUT_TYPES } from '@recued/contracts';

import { renderSection } from '../index.js';
import { renderBlockLabel } from '../label.js';

/** A payload each kind renders successfully, so the label test exercises the real path
 *  rather than an empty-state row. */
const DATA: Record<string, unknown> = {
  summary: { fields: [{ label: 'Deal', value: 'Acme' }] },
  table: { columns: [{ field: 'a', label: 'A' }], rows: [{ a: 1 }] },
  checklist: { items: [{ label: 'Ready', status: 'ok' }] },
  ai_analysis: { summary: 'proceed' },
  text: 'hello',
  copyable: 'copy me',
  json: { stock: 4 },
  file_artifact: [{ file_id: 'f1', filename: 'a.pdf', size_bytes: 10, mime_type: 'application/pdf' }],
  filter: {
    section_index: 0,
    recipe_hash: 'stored-recipe-hash',
    fields: ['query'],
    hidden: [],
    submit: 'Search',
    definitions: { query: { label: 'Query', type: 'text', default: '' } },
    values: { query: '' },
  },
  record_fields: {
    entity: 'job',
    fields: [
      { key: 'title', label: 'Title', kind: 'string', present: true, value: 'Replace the pump' },
    ],
  },
  button: [{ kind: 'recipe.run', label: 'Run', recipe_id: 'r' }],
  link_button: [{ label: 'Pay', url: 'https://example.com/pay' }],
};

/** The kinds whose label lives per-ACTION inside the data, not on the section — a section
 *  heading is not theirs to render. Everything else must honour it. */
const ACTION_KINDS = new Set(['button', 'link_button']);

describe('renderBlockLabel', () => {
  it('escapes a hostile label', () => {
    expect(renderBlockLabel('<script>alert(1)</script>')).not.toContain('<script>');
    expect(renderBlockLabel('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('renders nothing for absent / blank labels — no empty heading', () => {
    expect(renderBlockLabel(undefined)).toBe('');
    expect(renderBlockLabel('')).toBe('');
    expect(renderBlockLabel('   ')).toBe('');
  });
});

describe('every kind that can show a heading honours `label`', () => {
  // The property, not a list: iterate the CONTRACT's vocabulary, so a kind added later
  // cannot quietly join the set that drops it.
  for (const kind of OUTPUT_TYPES) {
    if (ACTION_KINDS.has(kind)) continue;
    it(`${kind} renders its authored label`, () => {
      const html = renderSection({
        kind,
        data: DATA[kind],
        label: 'Previous Inventory',
        ...(kind === 'filter' ? { filter: DATA.filter } : {}),
        ...(kind === 'record_fields' ? { record_fields: DATA.record_fields } : {}),
      });
      expect(html, `${kind} dropped its label`).toContain('Previous Inventory');
    });
  }

  it('a section with no label renders no heading', () => {
    expect(renderSection({ kind: 'summary', data: DATA.summary })).not.toContain('block-label');
  });

  it('checklist: the section label takes the heading slot, data.title is the fallback', () => {
    const withBoth = renderSection({
      kind: 'checklist',
      data: { title: 'From data', items: [{ label: 'Ready', status: 'ok' }] },
      label: 'From section',
    });
    expect(withBoth).toContain('From section');
    expect(withBoth).not.toContain('From data');

    const dataOnly = renderSection({
      kind: 'checklist',
      data: { title: 'From data', items: [{ label: 'Ready', status: 'ok' }] },
    });
    expect(dataOnly).toContain('From data');
  });
});
