/** D-145 PA5 — DOM read-back for the form renderer.
 *
 *  jsdom-free: builds a thin fake `ParentNode` whose `querySelector` /
 *  `querySelectorAll` walk a name-keyed registry. The selectors the
 *  read path emits are well-shaped:
 *    `[data-form-field="<name>"]` for scalars
 *    `[data-form-array-item="<name>"]` for array items
 *
 *  The fake matches by parsing those exact selectors; field names with
 *  CSS-special chars are pre-escaped by `cssEscape` so the parser pulls
 *  the un-escaped form back out.
 */

import { describe, expect, it } from 'vitest';

import type { FormDefinition, FormField } from '@recued/contracts';

import { readField, readFormValues } from '../form-renderer/read.js';

interface FakeElement {
  value?: string;
  checked?: boolean;
  dataset: Record<string, string>;
}

const scalarEl = (
  field: string,
  type: string,
  value: string,
): FakeElement => ({
  value,
  dataset: { formField: field, formType: type },
});

const checkboxEl = (
  field: string,
  type: string,
  checked: boolean,
): FakeElement => ({
  checked,
  dataset: { formField: field, formType: type },
});

const arrayItemEl = (
  field: string,
  index: number,
  type: string,
  value: string,
): FakeElement => ({
  value,
  dataset: {
    formArrayItem: field,
    formArrayIndex: String(index),
    formType: type,
  },
});

interface FakeRoot {
  scalars: Map<string, FakeElement>;
  arrayItems: Map<string, FakeElement[]>;
}

const makeRoot = (
  scalars: Array<[string, FakeElement]>,
  arrayItems: Record<string, FakeElement[]> = {},
): ParentNode => {
  const root: FakeRoot = {
    scalars: new Map(scalars),
    arrayItems: new Map(Object.entries(arrayItems)),
  };
  // Selector parser — extracts the requested field/array-item name
  // from the `[data-form-field="..."]` / `[data-form-array-item="..."]`
  // shapes the read path emits.
  const parseSelector = (sel: string): { kind: 'scalar' | 'array'; name: string } | null => {
    const scalar = /\[data-form-field="((?:[^"\\]|\\.)*)"\]/.exec(sel);
    if (scalar) return { kind: 'scalar', name: unescapeCss(scalar[1]) };
    const array = /\[data-form-array-item="((?:[^"\\]|\\.)*)"\]/.exec(sel);
    if (array) return { kind: 'array', name: unescapeCss(array[1]) };
    return null;
  };
  const node = {
    querySelector(sel: string): Element | null {
      const parsed = parseSelector(sel);
      if (!parsed) return null;
      if (parsed.kind === 'scalar') {
        return (root.scalars.get(parsed.name) as unknown as Element) ?? null;
      }
      const list = root.arrayItems.get(parsed.name);
      return list?.[0] ? (list[0] as unknown as Element) : null;
    },
    querySelectorAll(sel: string): NodeListOf<Element> {
      const parsed = parseSelector(sel);
      if (!parsed) return [] as unknown as NodeListOf<Element>;
      if (parsed.kind === 'scalar') {
        const el = root.scalars.get(parsed.name);
        return (el ? [el] : []) as unknown as NodeListOf<Element>;
      }
      const list = root.arrayItems.get(parsed.name) ?? [];
      return list as unknown as NodeListOf<Element>;
    },
  };
  return node as unknown as ParentNode;
};

const unescapeCss = (s: string): string => s.replace(/\\(.)/g, '$1');

const f = (over: Partial<FormField> & Pick<FormField, 'type'>): FormField => ({
  name: 'x',
  label: 'X',
  required: true,
  hidden: false,
  origin: 'canonical' as const,
  ...over,
});

describe('D-145 PA5 — readField scalar paths', () => {
  it('text → string passthrough', () => {
    const root = makeRoot([['title', scalarEl('title', 'text', 'walk dog')]]);
    expect(readField(root, f({ name: 'title', type: 'text' }))).toBe('walk dog');
  });

  it('textarea → string passthrough', () => {
    const root = makeRoot([['body', scalarEl('body', 'textarea', 'multi\nline')]]);
    expect(readField(root, f({ name: 'body', type: 'textarea' }))).toBe('multi\nline');
  });

  it('number → parsed; empty → null', () => {
    const numberRoot = makeRoot([['count', scalarEl('count', 'number', '42')]]);
    expect(readField(numberRoot, f({ name: 'count', type: 'number' }))).toBe(42);

    const emptyRoot = makeRoot([['count', scalarEl('count', 'number', '')]]);
    expect(readField(emptyRoot, f({ name: 'count', type: 'number' }))).toBeNull();
  });

  it('boolean → checkbox.checked', () => {
    const checked = makeRoot([['done', checkboxEl('done', 'boolean', true)]]);
    expect(readField(checked, f({ name: 'done', type: 'boolean' }))).toBe(true);

    const unchecked = makeRoot([['done', checkboxEl('done', 'boolean', false)]]);
    expect(readField(unchecked, f({ name: 'done', type: 'boolean' }))).toBe(false);
  });

  it('date → string passthrough', () => {
    const root = makeRoot([['when', scalarEl('when', 'date', '2026-05-09')]]);
    expect(readField(root, f({ name: 'when', type: 'date' }))).toBe('2026-05-09');
  });

  it('timestamp → ISO with TZ offset; empty → null', () => {
    const root = makeRoot([
      ['when', scalarEl('when', 'timestamp', '2026-05-09T12:00')],
    ]);
    const result = readField(root, f({ name: 'when', type: 'timestamp' }));
    expect(typeof result).toBe('string');
    expect(result).toMatch(
      /^2026-05-09T12:00:00(?:Z|[+-]\d{2}:\d{2})$/,
    );

    const empty = makeRoot([['when', scalarEl('when', 'timestamp', '')]]);
    expect(readField(empty, f({ name: 'when', type: 'timestamp' }))).toBeNull();
  });

  it('enum → string; empty → null', () => {
    const root = makeRoot([['priority', scalarEl('priority', 'enum', 'high')]]);
    expect(
      readField(root, f({ name: 'priority', type: 'enum' })),
    ).toBe('high');

    const empty = makeRoot([['priority', scalarEl('priority', 'enum', '')]]);
    expect(readField(empty, f({ name: 'priority', type: 'enum' }))).toBeNull();
  });

  it('ref → string passthrough', () => {
    const root = makeRoot([
      ['assigned_contact', scalarEl('assigned_contact', 'ref', 'contact-123')],
    ]);
    expect(
      readField(
        root,
        f({
          name: 'assigned_contact',
          type: 'ref',
          ref_target: 'data.contact',
        }),
      ),
    ).toBe('contact-123');
  });

  it('uuid → string passthrough', () => {
    const root = makeRoot([
      ['id', scalarEl('id', 'uuid', '550e8400-e29b-41d4-a716-446655440000')],
    ]);
    expect(readField(root, f({ name: 'id', type: 'uuid' }))).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('missing element → falls back to field default', () => {
    const root = makeRoot([]);
    expect(
      readField(root, f({ name: 'title', type: 'text', default: 'fallback' })),
    ).toBe('fallback');
  });
});

describe('D-145 PA5 — readField array paths', () => {
  it('walks every data-form-array-item under the field', () => {
    const root = makeRoot(
      [],
      {
        tags: [
          arrayItemEl('tags', 0, 'text', 'alpha'),
          arrayItemEl('tags', 1, 'text', 'beta'),
        ],
      },
    );
    expect(
      readField(root, f({ name: 'tags', type: 'array', item_type: 'text' })),
    ).toEqual(['alpha', 'beta']);
  });

  it('sorts array items by data-form-array-index (DOM order safe)', () => {
    const root = makeRoot(
      [],
      {
        tags: [
          arrayItemEl('tags', 2, 'text', 'gamma'),
          arrayItemEl('tags', 0, 'text', 'alpha'),
          arrayItemEl('tags', 1, 'text', 'beta'),
        ],
      },
    );
    expect(
      readField(root, f({ name: 'tags', type: 'array', item_type: 'text' })),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns empty array when no items present', () => {
    const root = makeRoot([]);
    expect(
      readField(root, f({ name: 'tags', type: 'array', item_type: 'text' })),
    ).toEqual([]);
  });

  it('item_type number → parsed', () => {
    const root = makeRoot(
      [],
      {
        scores: [
          arrayItemEl('scores', 0, 'number', '7'),
          arrayItemEl('scores', 1, 'number', '9'),
        ],
      },
    );
    expect(
      readField(root, f({ name: 'scores', type: 'array', item_type: 'number' })),
    ).toEqual([7, 9]);
  });
});

describe('D-145 PA5 — readFormValues composite', () => {
  it('walks every field in the definition', () => {
    const def: FormDefinition = {
      kind: 'task',
      fields: [
        f({ name: 'title', type: 'text' }),
        f({ name: 'done', type: 'boolean', required: false }),
        f({ name: 'priority', type: 'enum', required: false }),
        f({
          name: 'tags',
          type: 'array',
          item_type: 'text',
          required: false,
        }),
      ],
    };
    const root = makeRoot(
      [
        ['title', scalarEl('title', 'text', 'walk dog')],
        ['done', checkboxEl('done', 'boolean', true)],
        ['priority', scalarEl('priority', 'enum', 'high')],
      ],
      {
        tags: [
          arrayItemEl('tags', 0, 'text', 'alpha'),
          arrayItemEl('tags', 1, 'text', 'beta'),
        ],
      },
    );
    expect(readFormValues(root, def)).toEqual({
      title: 'walk dog',
      done: true,
      priority: 'high',
      tags: ['alpha', 'beta'],
    });
  });
});
