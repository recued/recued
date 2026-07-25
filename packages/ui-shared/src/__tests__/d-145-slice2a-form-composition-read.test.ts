/** D-145 § B.11.7 Slice 2a — form-renderer composition primitives, read.
 *
 *  Covers the read path for the new nested types — object,
 *  discriminated_union, and array<object> / array<discriminated_union>.
 *  Also pins the post-fold behaviors:
 *    - scope-aware row lookup (fold #1) — top-level read does not
 *      collide with a nested same-named field.
 *    - two-pass show_if read (fold #2) — fields referencing a sibling
 *      declared LATER in the definition list are still visible at
 *      read time.
 *    - read returns null on unknown / unrecognized discriminant
 *      (fold #4 — no silent variant rewrite).
 *
 *  Hand-rolled fake DOM mirroring the renderer's output structure
 *  (no jsdom dependency). The fake exposes only what the read path
 *  actually consults: `children`, `getAttribute`, `value`/`checked`,
 *  `classList.contains`, and a `querySelector` that walks descendants. */

import { describe, expect, it } from 'vitest';

import type {
  DiscriminatedUnionVariant,
  FormDefinition,
  FormField,
} from '@recued/contracts';

import { readField, readFormValues } from '../form-renderer/read.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM
// ──────────────────────────────────────────────────────────────────

interface FakeNode {
  tagName?: string;
  value?: string;
  checked?: boolean;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: FakeNode[];
  classList: { contains: (s: string) => boolean };
  getAttribute(k: string): string | null;
  querySelector(sel: string): FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
  dataset: Record<string, string>;
}

const node = (init: {
  tag?: string;
  attrs?: Record<string, string>;
  classes?: string[];
  value?: string;
  checked?: boolean;
  children?: FakeNode[];
}): FakeNode => {
  const attrs = init.attrs ?? {};
  const classes = new Set(init.classes ?? []);
  const children = init.children ?? [];
  const n: FakeNode = {
    tagName: init.tag,
    attrs,
    classes,
    classList: {
      contains: (s) => classes.has(s),
    },
    children,
    dataset: dataAttrsAsDataset(attrs),
    getAttribute: (k) => attrs[k] ?? null,
    querySelector(sel) {
      return findFirst(this, sel);
    },
    querySelectorAll(sel) {
      return findAll(this, sel);
    },
  };
  if (init.value !== undefined) n.value = init.value;
  if (init.checked !== undefined) n.checked = init.checked;
  return n;
};

const dataAttrsAsDataset = (
  attrs: Record<string, string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith('data-')) continue;
    const camel = k
      .slice('data-'.length)
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
};

const SELECTOR_PARTS_RE = /\[([a-z-]+)(?:="([^"]*)")?\]|\.([a-zA-Z0-9_-]+)/g;

const parseSelector = (
  sel: string,
): Array<{ kind: 'attr' | 'class'; name: string; value?: string }> => {
  const parts: Array<{ kind: 'attr' | 'class'; name: string; value?: string }> =
    [];
  for (const m of sel.matchAll(SELECTOR_PARTS_RE)) {
    if (m[3] !== undefined) {
      parts.push({ kind: 'class', name: m[3] });
    } else {
      const attr = m[1]!;
      const value = m[2];
      parts.push({
        kind: 'attr',
        name: attr,
        ...(value !== undefined ? { value: unescapeCss(value) } : {}),
      });
    }
  }
  return parts;
};

const matches = (
  n: FakeNode,
  parts: ReturnType<typeof parseSelector>,
): boolean =>
  parts.every((p) => {
    if (p.kind === 'class') return n.classes.has(p.name);
    if (p.value === undefined) return p.name in n.attrs;
    return n.attrs[p.name] === p.value;
  });

const findFirst = (root: FakeNode, sel: string): FakeNode | null => {
  const parts = parseSelector(sel);
  const walk = (n: FakeNode): FakeNode | null => {
    for (const c of n.children) {
      if (matches(c, parts)) return c;
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
};

const findAll = (root: FakeNode, sel: string): FakeNode[] => {
  const parts = parseSelector(sel);
  const out: FakeNode[] = [];
  const walk = (n: FakeNode): void => {
    for (const c of n.children) {
      if (matches(c, parts)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
};

const unescapeCss = (s: string): string => s.replace(/\\(.)/g, '$1');

// ──────────────────────────────────────────────────────────────────
// Convenience builders matching the renderer's output structure
// ──────────────────────────────────────────────────────────────────

const formRoot = (rows: FakeNode[]): FakeNode =>
  node({
    classes: ['form-renderer-form'],
    children: rows,
  });

const row = (name: string, inner: FakeNode[], hidden = false): FakeNode =>
  node({
    attrs: hidden
      ? { 'data-form-row': name, 'data-form-hidden': 'true' }
      : { 'data-form-row': name },
    children: inner,
  });

const textInput = (name: string, value: string): FakeNode =>
  node({
    tag: 'INPUT',
    attrs: { 'data-form-field': name, 'data-form-type': 'text' },
    value,
  });

const checkbox = (name: string, checked: boolean): FakeNode =>
  node({
    tag: 'INPUT',
    attrs: { 'data-form-field': name, 'data-form-type': 'boolean' },
    checked,
  });

const objectWrapper = (name: string, children: FakeNode[]): FakeNode =>
  node({
    attrs: { 'data-form-field': name, 'data-form-type': 'object' },
    children: [
      node({
        attrs: { 'data-form-object-scope': name },
        children,
      }),
    ],
  });

const unionSelect = (
  fieldName: string,
  selectedKind: string,
  discriminantField = 'kind',
): FakeNode =>
  node({
    tag: 'SELECT',
    attrs: {
      'data-form-union-select': fieldName,
      'data-form-discriminant-field': discriminantField,
      'data-form-type': 'enum',
    },
    value: selectedKind,
  });

const unionVariantBody = (
  fieldName: string,
  kind: string,
  active: boolean,
  children: FakeNode[],
): FakeNode =>
  node({
    attrs: {
      'data-form-union-scope': fieldName,
      'data-form-union-variant': kind,
      'data-form-variant-active': active ? 'true' : 'false',
    },
    children,
  });

const unionWrapper = (
  fieldName: string,
  select: FakeNode,
  bodies: FakeNode[],
  discriminantField = 'kind',
): FakeNode =>
  node({
    attrs: {
      'data-form-field': fieldName,
      'data-form-type': 'discriminated_union',
      'data-form-discriminant-field': discriminantField,
    },
    children: [select, ...bodies],
  });

const arrayWrapper = (
  fieldName: string,
  itemType: string,
  items: FakeNode[],
): FakeNode =>
  node({
    attrs: {
      'data-form-field': fieldName,
      'data-form-type': 'array',
      'data-form-item-type': itemType,
    },
    children: items,
  });

const arrayItem = (
  fieldName: string,
  index: number,
  type: string,
  children: FakeNode[],
  value?: string,
): FakeNode =>
  node({
    attrs: {
      'data-form-array-item': fieldName,
      'data-form-array-index': String(index),
      'data-form-type': type,
    },
    ...(value !== undefined ? { value } : {}),
    children,
  });

// ──────────────────────────────────────────────────────────────────
// FormField builders
// ──────────────────────────────────────────────────────────────────

const baseField = (
  over: Partial<FormField> & Pick<FormField, 'type' | 'name'>,
): FormField => ({
  label: over.label ?? over.name,
  required: true,
  hidden: false,
  origin: 'canonical' as const,
  ...over,
});

// ══════════════════════════════════════════════════════════════════
// Object read
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — read type=object', () => {
  it('walks object_fields into a nested values map', () => {
    const root = formRoot([
      row('address', [
        objectWrapper('address', [
          row('city', [textInput('city', 'Lisbon')]),
          row('country', [textInput('country', 'PT')]),
        ]),
      ]),
    ]);
    const field = baseField({
      type: 'object',
      name: 'address',
      object_fields: [
        baseField({ type: 'text', name: 'city' }),
        baseField({ type: 'text', name: 'country' }),
      ],
    });
    expect(readField(root as unknown as ParentNode, field)).toEqual({
      city: 'Lisbon',
      country: 'PT',
    });
  });

  it('returns null when the object wrapper is absent', () => {
    const root = formRoot([]);
    const field = baseField({
      type: 'object',
      name: 'address',
      object_fields: [baseField({ type: 'text', name: 'city' })],
    });
    expect(readField(root as unknown as ParentNode, field)).toBeNull();
  });

  it('scope-aware lookup — top-level object does NOT collide with a nested same-named field (fold #1)', () => {
    // Top-level `foo` is an object containing only `inner: "outer"`.
    // Also has top-level `bar` (object) containing nested `foo` (object)
    // with inner: "stolen". Read of top-level `foo` should return
    // "outer", not "stolen", regardless of document order.
    const root = formRoot([
      // bar appears FIRST in document order — without scope-aware
      // lookup, root.querySelector would match its inner foo.
      row('bar', [
        objectWrapper('bar', [
          row('foo', [
            objectWrapper('foo', [
              row('inner', [textInput('inner', 'stolen')]),
            ]),
          ]),
        ]),
      ]),
      row('foo', [
        objectWrapper('foo', [
          row('inner', [textInput('inner', 'outer')]),
        ]),
      ]),
    ]);
    const innerField = baseField({
      type: 'object',
      name: 'foo',
      object_fields: [baseField({ type: 'text', name: 'inner' })],
    });
    const barField = baseField({
      type: 'object',
      name: 'bar',
      object_fields: [innerField],
    });
    const definition: FormDefinition = {
      kind: 'test',
      fields: [innerField, barField],
    };
    const values = readFormValues(root as unknown as ParentNode, definition);
    expect(values.foo).toEqual({ inner: 'outer' });
    expect((values.bar as { foo: { inner: string } }).foo.inner).toBe('stolen');
  });
});

// ══════════════════════════════════════════════════════════════════
// Discriminated union read
// ══════════════════════════════════════════════════════════════════

const ACTION_VARIANTS: DiscriminatedUnionVariant[] = [
  { kind: 'require_approval', label: 'Require approval', fields: [] },
  {
    kind: 'min_tier',
    label: 'Min tier',
    fields: [baseField({ type: 'text', name: 'tier' })],
  },
];

describe('D-145 Slice 2a — read type=discriminated_union', () => {
  it('reads { kind, ...variant_fields }', () => {
    const root = formRoot([
      row('action', [
        unionWrapper(
          'action',
          unionSelect('action', 'min_tier'),
          [
            unionVariantBody('action', 'require_approval', false, []),
            unionVariantBody('action', 'min_tier', true, [
              row('tier', [textInput('tier', 'mid')]),
            ]),
          ],
        ),
      ]),
    ]);
    const field = baseField({
      type: 'discriminated_union',
      name: 'action',
      variants: ACTION_VARIANTS,
    });
    expect(readField(root as unknown as ParentNode, field)).toEqual({
      kind: 'min_tier',
      tier: 'mid',
    });
  });

  it('honors discriminant_field override', () => {
    const root = formRoot([
      row('condition', [
        unionWrapper(
          'condition',
          unionSelect('condition', 'min_tier', 'op'),
          [
            unionVariantBody('condition', 'min_tier', true, [
              row('tier', [textInput('tier', 'reasoning')]),
            ]),
          ],
          'op',
        ),
      ]),
    ]);
    const field = baseField({
      type: 'discriminated_union',
      name: 'condition',
      discriminant_field: 'op',
      variants: ACTION_VARIANTS,
    });
    expect(readField(root as unknown as ParentNode, field)).toEqual({
      op: 'min_tier',
      tier: 'reasoning',
    });
  });

  it('returns { kind: <unknown> } only when the kind does not match a variant — does NOT silently rewrite (fold #4)', () => {
    const root = formRoot([
      row('action', [
        unionWrapper(
          'action',
          unionSelect('action', 'retired_variant'),
          [
            unionVariantBody('action', 'require_approval', false, []),
            unionVariantBody('action', 'min_tier', false, []),
          ],
        ),
      ]),
    ]);
    const field = baseField({
      type: 'discriminated_union',
      name: 'action',
      variants: ACTION_VARIANTS,
    });
    // Note: kind survives unchanged (no silent rewrite to variants[0]);
    // the validator will surface "Must be one of …" on this read result.
    expect(readField(root as unknown as ParentNode, field)).toEqual({
      kind: 'retired_variant',
    });
  });

  it('returns null when variants is empty', () => {
    const root = formRoot([
      row('action', [
        unionWrapper('action', unionSelect('action', 'anything'), []),
      ]),
    ]);
    const field = baseField({
      type: 'discriminated_union',
      name: 'action',
      variants: [],
    });
    expect(readField(root as unknown as ParentNode, field)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Array<object> + array<discriminated_union> read
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — read type=array with composite items', () => {
  it('reads array<object> items via the nested scope walker', () => {
    const root = formRoot([
      row('people', [
        arrayWrapper('people', 'object', [
          arrayItem('people', 0, 'object', [
            node({
              attrs: { 'data-form-object-scope': 'people' },
              children: [row('name', [textInput('name', 'Alice')])],
            }),
          ]),
          arrayItem('people', 1, 'object', [
            node({
              attrs: { 'data-form-object-scope': 'people' },
              children: [row('name', [textInput('name', 'Bob')])],
            }),
          ]),
        ]),
      ]),
    ]);
    const field = baseField({
      type: 'array',
      name: 'people',
      item_type: 'object',
      item_object_fields: [baseField({ type: 'text', name: 'name' })],
    });
    expect(readField(root as unknown as ParentNode, field)).toEqual([
      { name: 'Alice' },
      { name: 'Bob' },
    ]);
  });

  it('reads array<discriminated_union> items via the union body walker', () => {
    const root = formRoot([
      row('actions', [
        arrayWrapper('actions', 'discriminated_union', [
          arrayItem('actions', 0, 'discriminated_union', [
            unionSelect('actions', 'min_tier'),
            unionVariantBody('actions', 'min_tier', true, [
              row('tier', [textInput('tier', 'fast')]),
            ]),
          ]),
          arrayItem('actions', 1, 'discriminated_union', [
            unionSelect('actions', 'require_approval'),
            unionVariantBody('actions', 'require_approval', true, []),
          ]),
        ]),
      ]),
    ]);
    const field = baseField({
      type: 'array',
      name: 'actions',
      item_type: 'discriminated_union',
      item_variants: ACTION_VARIANTS,
    });
    expect(readField(root as unknown as ParentNode, field)).toEqual([
      { kind: 'min_tier', tier: 'fast' },
      { kind: 'require_approval' },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
// show_if read symmetry (fold #2)
// ══════════════════════════════════════════════════════════════════

describe('D-145 Slice 2a — show_if read symmetry (fold #2)', () => {
  it('reads ALL fields first, then applies show_if — a field declared BEFORE its gate sibling is still read when visible at render', () => {
    // Field order: `detail` (gated on `mode === 'advanced'`), then `mode`.
    // Single-pass evaluation would skip `detail` (gate evaluated against
    // partial map → undefined !== 'advanced' → hide → undefined).
    // Two-pass evaluation reads both, then evaluates gate against the
    // full map → mode='advanced' → detail visible → present.
    const root = formRoot([
      row('detail', [textInput('detail', 'expert input')]),
      row('mode', [textInput('mode', 'advanced')]),
    ]);
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        baseField({
          type: 'text',
          name: 'detail',
          show_if: { field: 'mode', equals: 'advanced' },
        }),
        baseField({ type: 'text', name: 'mode' }),
      ],
    };
    expect(
      readFormValues(root as unknown as ParentNode, definition),
    ).toEqual({
      detail: 'expert input',
      mode: 'advanced',
    });
  });

  it('hides + drops a field whose gate evaluates false against the full values map', () => {
    const root = formRoot([
      row('detail', [textInput('detail', 'stale')]),
      row('mode', [textInput('mode', 'simple')]),
    ]);
    const definition: FormDefinition = {
      kind: 'test',
      fields: [
        baseField({
          type: 'text',
          name: 'detail',
          show_if: { field: 'mode', equals: 'advanced' },
        }),
        baseField({ type: 'text', name: 'mode' }),
      ],
    };
    expect(
      readFormValues(root as unknown as ParentNode, definition),
    ).toEqual({
      mode: 'simple',
    });
  });
});
