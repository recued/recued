/** D-145 § B.11.7 Slice 2b — nested same-named array round-trip ratchet.
 *
 *  Codex review Blocker #1 — pre-fold, `readArrayField` used
 *  `querySelectorAll` against the row scope, which walks every
 *  descendant. A nested same-named array (e.g. SI's `conditions`
 *  inside `all → conditions`) leaked its items into the outer
 *  array's read. The Slice 2b fold added a scope-narrowed walk
 *  against the array wrapper's direct children, falling back to
 *  the original descendant scan for flat-map fake DOMs that do not
 *  model hierarchy.
 *
 *  This test reproduces the depth-2 condition tree the SI edit form
 *  produces + round-trips it through the real renderer + reader.
 *
 *  Hand-rolled fake DOM mirrors the renderer's output structure
 *  (no jsdom dependency); the same fake-DOM helper shape as
 *  `d-145-slice2a-form-composition-read.test.ts` so the harness +
 *  selector parser stay in lock-step with the existing Slice 2a
 *  contract. */

import { describe, expect, it } from 'vitest';
import type { FormDefinition } from '@recued/contracts';

import { renderForm } from '../form-renderer/render.js';
import { readFormValues } from '../form-renderer/read.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors slice2a-form-composition-read's harness)
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
    classList: { contains: (s) => classes.has(s) },
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
  const parts: Array<{ kind: 'attr' | 'class'; name: string; value?: string }> = [];
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
// Form definition under test — a depth-2 conditions tree
// ──────────────────────────────────────────────────────────────────

const atomicVariants = [
  {
    kind: 'topic_match',
    label: 'Topic match',
    fields: [
      {
        name: 'topic',
        type: 'text' as const,
        label: 'Topic',
        required: true,
        hidden: false,
        origin: 'canonical' as const,
      },
    ],
  },
];

const depth1Variants = [
  ...atomicVariants,
  {
    kind: 'all',
    label: 'All',
    fields: [
      {
        name: 'conditions',
        type: 'array' as const,
        label: 'Inner conditions',
        required: true,
        hidden: false,
        origin: 'canonical' as const,
        item_type: 'discriminated_union' as const,
        item_variants: atomicVariants,
        discriminant_field: 'op',
      },
    ],
  },
];

const definition: FormDefinition = {
  kind: 'nested_array',
  fields: [
    {
      name: 'conditions',
      type: 'array',
      label: 'Conditions',
      required: true,
      hidden: false,
      origin: 'canonical',
      item_type: 'discriminated_union',
      item_variants: depth1Variants,
      discriminant_field: 'op',
    },
  ],
};

// ──────────────────────────────────────────────────────────────────
// Builders — produce a FakeNode tree that mirrors renderForm's HTML
// ──────────────────────────────────────────────────────────────────

/** Build a `data-form-array-item` node for the union shape the
 *  renderer emits. Slim — only the attributes / classes / children
 *  the read path consults. */
const unionArrayItem = (params: {
  outerArrayField: string;
  index: number;
  variantKind: string;
  variantFields: FakeNode[];
}): FakeNode =>
  node({
    tag: 'div',
    classes: ['form-renderer-array-item', 'form-renderer-array-item-composite'],
    attrs: {
      'data-form-array-item': params.outerArrayField,
      'data-form-array-index': String(params.index),
      'data-form-type': 'discriminated_union',
    },
    children: [
      // The union body — select + per-variant bodies.
      node({
        tag: 'select',
        attrs: {
          'data-form-union-select': params.outerArrayField,
          'data-form-discriminant-field': 'op',
        },
        value: params.variantKind,
      }),
      node({
        tag: 'div',
        classes: ['form-renderer-union-variant'],
        attrs: {
          'data-form-union-scope': params.outerArrayField,
          'data-form-union-variant': params.variantKind,
          'data-form-variant-active': 'true',
        },
        children: params.variantFields,
      }),
    ],
  });

const rowFor = (name: string, child: FakeNode): FakeNode =>
  node({
    tag: 'div',
    classes: ['form-renderer-row'],
    attrs: { 'data-form-row': name },
    children: [child],
  });

const formRoot = (children: FakeNode[]): FakeNode =>
  node({
    tag: 'div',
    classes: ['form-renderer-form'],
    attrs: { 'data-form-kind': 'nested_array' },
    children,
  });

// ──────────────────────────────────────────────────────────────────
// The ratchet
// ──────────────────────────────────────────────────────────────────

describe('D-145 Slice 2b — nested same-named array round-trip', () => {
  it('reads depth-2 outer array without picking up inner array items (Codex Blocker #1)', () => {
    // DOM mirrors what renderForm produces for:
    //   conditions: [
    //     { op: 'topic_match', topic: 'outer-1' },
    //     { op: 'all',
    //       conditions: [
    //         { op: 'topic_match', topic: 'inner-a' },
    //         { op: 'topic_match', topic: 'inner-b' },
    //       ] },
    //     { op: 'topic_match', topic: 'outer-3' },
    //   ]
    //
    // Pre-fold the outer `readArrayField` querySelectorAll-collided
    // with the inner items, returning 5 items in the outer array
    // (3 outer + 2 inner) and losing the nested structure.
    const innerArrayWrapper = node({
      tag: 'div',
      classes: ['form-renderer-array'],
      attrs: {
        'data-form-field': 'conditions',
        'data-form-type': 'array',
      },
      children: [
        unionArrayItem({
          outerArrayField: 'conditions',
          index: 0,
          variantKind: 'topic_match',
          variantFields: [
            rowFor(
              'topic',
              node({
                tag: 'input',
                attrs: { 'data-form-field': 'topic', 'data-form-type': 'text' },
                value: 'inner-a',
              }),
            ),
          ],
        }),
        unionArrayItem({
          outerArrayField: 'conditions',
          index: 1,
          variantKind: 'topic_match',
          variantFields: [
            rowFor(
              'topic',
              node({
                tag: 'input',
                attrs: { 'data-form-field': 'topic', 'data-form-type': 'text' },
                value: 'inner-b',
              }),
            ),
          ],
        }),
      ],
    });

    const innerVariantBody = node({
      tag: 'div',
      classes: ['form-renderer-union-variant'],
      attrs: {
        'data-form-union-scope': 'conditions',
        'data-form-union-variant': 'all',
        'data-form-variant-active': 'true',
      },
      children: [
        rowFor(
          'conditions',
          node({
            tag: 'div',
            classes: ['form-renderer-array'],
            attrs: {
              'data-form-field': 'conditions',
              'data-form-type': 'array',
            },
            children: innerArrayWrapper.children, // share the inner items
          }),
        ),
      ],
    });

    const outerArray = node({
      tag: 'div',
      classes: ['form-renderer-array'],
      attrs: {
        'data-form-field': 'conditions',
        'data-form-type': 'array',
      },
      children: [
        unionArrayItem({
          outerArrayField: 'conditions',
          index: 0,
          variantKind: 'topic_match',
          variantFields: [
            rowFor(
              'topic',
              node({
                tag: 'input',
                attrs: { 'data-form-field': 'topic', 'data-form-type': 'text' },
                value: 'outer-1',
              }),
            ),
          ],
        }),
        unionArrayItem({
          outerArrayField: 'conditions',
          index: 1,
          variantKind: 'all',
          variantFields: [
            // The 'all' variant's body carries a NESTED `conditions`
            // array. The fake mirrors the renderer's wrapper +
            // direct-child layout so the read path's wrapper-narrowed
            // walk lands on these items, not the outer's.
            innerVariantBody,
          ],
        }),
        unionArrayItem({
          outerArrayField: 'conditions',
          index: 2,
          variantKind: 'topic_match',
          variantFields: [
            rowFor(
              'topic',
              node({
                tag: 'input',
                attrs: { 'data-form-field': 'topic', 'data-form-type': 'text' },
                value: 'outer-3',
              }),
            ),
          ],
        }),
      ],
    });

    const root = formRoot([rowFor('conditions', outerArray)]);
    const result = readFormValues(root as unknown as ParentNode, definition);
    expect(result.conditions).toEqual([
      { op: 'topic_match', topic: 'outer-1' },
      {
        op: 'all',
        conditions: [
          { op: 'topic_match', topic: 'inner-a' },
          { op: 'topic_match', topic: 'inner-b' },
        ],
      },
      { op: 'topic_match', topic: 'outer-3' },
    ]);
  });

  it('renderer emits a wrapper carrying data-form-field + data-form-type="array" (sanity ratchet)', () => {
    // Defends the Slice 2b fold against a future renderer refactor
    // that drops the wrapper attributes the scope-narrowed reader
    // depends on. Pre-fold the reader was wrapper-agnostic; post-fold
    // a renderer that elides the wrapper attributes would silently
    // degrade to the flat-map fallback path.
    const html = renderForm(definition);
    expect(html).toContain('data-form-field="conditions"');
    expect(html).toContain('data-form-type="array"');
  });
});
