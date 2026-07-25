import { describe, it, expect } from 'vitest';
import { renderSection, type SectionKind } from '../index.js';

describe('renderSection', () => {
  const cases: Array<{ kind: SectionKind; data: unknown; match: string | RegExp }> = [
    { kind: 'text',        data: 'hello',                                           match: 'hello' },
    { kind: 'summary',     data: { fields: [{ label: 'L', value: 'V' }] },          match: 'summary-block' },
    { kind: 'checklist',   data: { items: [{ label: 'A', status: 'ok' }] },         match: 'checklist-block' },
    { kind: 'table',       data: { columns: [{ field: 'f' }], rows: [{ f: 1 }] },   match: 'table-block' },
    { kind: 'ai_analysis', data: { summary: 'done' },                               match: 'ai-block' },
    { kind: 'copyable',    data: 'snippet',                                         match: 'copyable-block' },
    { kind: 'button',      data: { kind: 'recipe.run', label: 'Run', recipe_id: 'r' }, match: 'button-block' },
    { kind: 'file_artifact', data: { record_id: 'file:abc', filename: 'document.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: 'a'.repeat(64), generated_at: 1 }, match: 'file-artifact-block' },
  ];

  for (const c of cases) {
    it(`routes ${c.kind} blocks to the right renderer`, () => {
      const html = renderSection({ kind: c.kind, data: c.data });
      expect(html).toMatch(c.match);
    });
  }

  it('propagates context into copyable (strips Copy button)', () => {
    const html = renderSection(
      { kind: 'copyable', data: 'snippet' },
      { interactive: false },
    );
    expect(html).not.toContain('<button');
  });

  it('passes label through for copyable blocks', () => {
    const html = renderSection({ kind: 'copyable', data: 'x', label: 'Subject' });
    expect(html).toContain('Subject');
  });

  it('renders unknown section kinds as safe unsupported blocks', () => {
    const html = renderSection({ kind: 'future_kind', data: { x: 1 } });
    expect(html).toContain('block-error');
    expect(html).toContain('future_kind');
    expect(html).toContain('unsupported section type');
  });
});
