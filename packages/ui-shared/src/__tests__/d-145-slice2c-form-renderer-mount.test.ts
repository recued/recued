/** D-145 § B.11.7 Slice 2c — form-renderer Add/Remove substrate.
 *
 *  Three layers:
 *
 *   1. `__internal__` ratchet tests — pure helpers, no DOM round-trip:
 *      `computeArrayItemDefault` per item_type, `resolveFieldAtPath`
 *      walking through array<union> / object / discriminator descents,
 *      `mutateArrayAtPath` in-place semantics, `computeArrayPathFromButton`
 *      against hand-stitched FakeNode chains (the renderer's DOM
 *      shape is mirrored only for the markers the walker reads).
 *
 *   2. `mountForm` integration tests — fake DOM with addEventListener
 *      + click bubble-up + innerHTML capture. The fake mirrors the
 *      slice2a-form-composition-read harness for the read path so
 *      `readFormValues` walks the same shape it would in production;
 *      the innerHTML setter captures the post-paint render so we can
 *      assert on the renderer's output for the new item.
 *
 *   3. Folds — the Codex review findings (MAJOR 1 stale-union repaint,
 *      MAJOR 2 dispose hygiene) get explicit ratchets so a regression
 *      shows up before it lands. */

import { describe, expect, it } from 'vitest';
import type {
  DiscriminatedUnionVariant,
  FormDefinition,
  FormField,
} from '@recued/contracts';

import { mountForm, type FormMount } from '../form-renderer/mount.js';
import { __internal__ } from '../form-renderer/mount.js';

const {
  computeArrayItemDefault,
  resolveFieldAtPath,
  mutateArrayAtPath,
  computeArrayPathFromButton,
} = __internal__;

// ════════════════════════════════════════════════════════════════════
// Fake DOM
// ════════════════════════════════════════════════════════════════════
//
// Mirrors the slice2a-form-composition-read harness for the read path
// (querySelector / querySelectorAll / classList / children / attrs)
// AND adds the bits mountForm needs: addEventListener / event bubble-up
// / innerHTML setter capture / parentElement walking.

interface FakeNode {
  tagName?: string;
  value?: string;
  checked?: boolean;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: FakeNode[];
  parent: FakeNode | null;
  classList: { contains: (s: string) => boolean };
  listeners: Map<string, Array<(event: unknown) => void>>;
  innerHtmlValue: string;
  parentElement: FakeNode | null;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  hasAttribute(k: string): boolean;
  querySelector(sel: string): FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  dispatchClick(): void;
  set innerHTML(v: string);
  get innerHTML(): string;
}

const node = (init: {
  tag?: string;
  attrs?: Record<string, string>;
  classes?: string[];
  value?: string;
  checked?: boolean;
  children?: FakeNode[];
}): FakeNode => {
  const attrs = { ...(init.attrs ?? {}) };
  const classes = new Set(init.classes ?? []);
  const children = init.children ?? [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  let html = '';
  const n: FakeNode = {
    tagName: init.tag,
    attrs,
    classes,
    listeners,
    classList: { contains: (s) => classes.has(s) },
    children,
    parent: null,
    parentElement: null,
    innerHtmlValue: '',
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    hasAttribute: (k) => k in attrs,
    querySelector(sel) {
      return findFirst(this, sel);
    },
    querySelectorAll(sel) {
      return findAll(this, sel);
    },
    addEventListener(type, fn) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    appendChild(child) {
      children.push(child);
      child.parent = this;
      child.parentElement = this;
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      child.parent = null;
      child.parentElement = null;
      return child;
    },
    dispatchClick() {
      // Walk up the parent chain firing 'click' listeners on each
      // ancestor (matches DOM bubble-up semantics — production
      // mountForm registers on the host, not the button).
      const event = { target: n, type: 'click' } as unknown;
      let cur: FakeNode | null = n;
      while (cur !== null) {
        const arr = cur.listeners.get('click') ?? [];
        for (const fn of arr) fn(event);
        cur = cur.parent;
      }
    },
    set innerHTML(v: string) {
      html = v;
      // Tests do not require innerHTML to re-parse into children;
      // assertions inspect the captured string instead.
    },
    get innerHTML() {
      return html;
    },
  };
  // Propagate value / checked off the init descriptor — readScalar +
  // readDiscriminatedUnion's `.value` access reads these directly.
  if (init.value !== undefined) n.value = init.value;
  if (init.checked !== undefined) n.checked = init.checked;
  // Wire parent links for the initial children list. The walker for
  // computeArrayPathFromButton relies on `parentElement`.
  for (const c of children) {
    c.parent = n;
    c.parentElement = n;
  }
  return n;
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

// ════════════════════════════════════════════════════════════════════
// Test definitions
// ════════════════════════════════════════════════════════════════════

const atomicVariants: readonly DiscriminatedUnionVariant[] = [
  {
    kind: 'topic_match',
    label: 'Topic match',
    fields: [
      {
        name: 'topic',
        type: 'text',
        label: 'Topic',
        required: true,
        hidden: false,
        origin: 'canonical',
      },
    ],
  },
  {
    kind: 'request_kind',
    label: 'Request kind',
    fields: [
      {
        name: 'equals',
        type: 'enum',
        label: 'Equals',
        required: true,
        hidden: false,
        origin: 'canonical',
        enum_values: ['compose_email', 'social_lookup'],
        default: 'compose_email',
      },
    ],
  },
];

const conditionVariantsDepth1: readonly DiscriminatedUnionVariant[] = [
  ...atomicVariants,
  {
    kind: 'all',
    label: 'All',
    fields: [
      {
        name: 'conditions',
        type: 'array',
        label: 'Inner conditions',
        required: true,
        hidden: false,
        origin: 'canonical',
        item_type: 'discriminated_union',
        item_variants: atomicVariants,
        discriminant_field: 'op',
      },
    ],
  },
];

const actionVariants: readonly DiscriminatedUnionVariant[] = [
  { kind: 'require_approval', label: 'Require approval', fields: [] },
  {
    kind: 'redact_context',
    label: 'Redact context',
    fields: [
      {
        name: 'sources',
        type: 'array',
        label: 'Sources',
        required: true,
        hidden: false,
        origin: 'canonical',
        item_type: 'text',
      },
    ],
  },
  {
    kind: 'min_tier',
    label: 'Min tier',
    fields: [
      {
        name: 'tier',
        type: 'enum',
        label: 'Tier',
        required: true,
        hidden: false,
        origin: 'canonical',
        enum_values: ['fast', 'mid', 'top'],
      },
    ],
  },
];

const siLikeDefinition: FormDefinition = {
  kind: 'si_like',
  fields: [
    {
      name: 'conditions',
      type: 'discriminated_union',
      label: 'Conditions',
      required: true,
      hidden: false,
      origin: 'canonical',
      variants: conditionVariantsDepth1,
      discriminant_field: 'op',
    },
    {
      name: 'actions',
      type: 'array',
      label: 'Actions',
      required: true,
      hidden: false,
      origin: 'canonical',
      item_type: 'discriminated_union',
      item_variants: actionVariants,
      discriminant_field: 'kind',
    },
  ],
};

const objectArrayDefinition: FormDefinition = {
  kind: 'object_array',
  fields: [
    {
      name: 'entries',
      type: 'array',
      label: 'Entries',
      required: true,
      hidden: false,
      origin: 'canonical',
      item_type: 'object',
      item_object_fields: [
        {
          name: 'label',
          type: 'text',
          label: 'Label',
          required: true,
          hidden: false,
          origin: 'canonical',
          default: 'default-label',
        },
        {
          name: 'count',
          type: 'number',
          label: 'Count',
          required: false,
          hidden: false,
          origin: 'canonical',
        },
      ],
    },
  ],
};

// ════════════════════════════════════════════════════════════════════
// Layer 1 — __internal__ pure helpers
// ════════════════════════════════════════════════════════════════════

describe('D-145 Slice 2c — computeArrayItemDefault', () => {
  it('discriminated_union → { discriminant: firstVariant.kind, ...sub-defaults }', () => {
    const arrField = siLikeDefinition.fields[1] as FormField;
    expect(computeArrayItemDefault(arrField)).toEqual({
      kind: 'require_approval',
    });
  });

  it('discriminated_union with sub-defaults pulls them through', () => {
    // The min_tier variant carries an enum sub-field but no default;
    // pivot to topic_match-first variants to surface a real default
    // propagation case.
    const arrField: FormField = {
      name: 'actions',
      type: 'array',
      label: 'Actions',
      required: true,
      hidden: false,
      origin: 'canonical',
      item_type: 'discriminated_union',
      discriminant_field: 'kind',
      item_variants: [
        {
          kind: 'tag_response',
          label: 'Tag',
          fields: [
            {
              name: 'tag',
              type: 'text',
              label: 'Tag',
              required: true,
              hidden: false,
              origin: 'canonical',
              default: 'urgent',
            },
          ],
        },
      ],
    };
    expect(computeArrayItemDefault(arrField)).toEqual({
      kind: 'tag_response',
      tag: 'urgent',
    });
  });

  it('object items seed from item_object_fields defaults', () => {
    const arrField = objectArrayDefinition.fields[0] as FormField;
    expect(computeArrayItemDefault(arrField)).toEqual({
      label: 'default-label',
    });
  });

  it('scalar enum items default to first enum_value', () => {
    const arrField: FormField = {
      name: 'tags',
      type: 'array',
      label: 'Tags',
      required: false,
      hidden: false,
      origin: 'canonical',
      item_type: 'enum',
      item_enum_values: ['low', 'medium', 'high'],
    };
    expect(computeArrayItemDefault(arrField)).toBe('low');
  });

  it('scalar number items default to null', () => {
    const arrField: FormField = {
      name: 'nums',
      type: 'array',
      label: 'Numbers',
      required: false,
      hidden: false,
      origin: 'canonical',
      item_type: 'number',
    };
    expect(computeArrayItemDefault(arrField)).toBeNull();
  });

  it('scalar boolean items default to false', () => {
    const arrField: FormField = {
      name: 'flags',
      type: 'array',
      label: 'Flags',
      required: false,
      hidden: false,
      origin: 'canonical',
      item_type: 'boolean',
    };
    expect(computeArrayItemDefault(arrField)).toBe(false);
  });

  it('scalar text items default to empty string', () => {
    const arrField: FormField = {
      name: 'names',
      type: 'array',
      label: 'Names',
      required: false,
      hidden: false,
      origin: 'canonical',
      item_type: 'text',
    };
    expect(computeArrayItemDefault(arrField)).toBe('');
  });

  it('empty item_variants returns null (substrate misconfiguration)', () => {
    const arrField: FormField = {
      name: 'broken',
      type: 'array',
      label: 'Broken',
      required: false,
      hidden: false,
      origin: 'canonical',
      item_type: 'discriminated_union',
      item_variants: [],
    };
    expect(computeArrayItemDefault(arrField)).toBeNull();
  });
});

describe('D-145 Slice 2c — resolveFieldAtPath', () => {
  it('resolves top-level array field', () => {
    const field = resolveFieldAtPath(
      siLikeDefinition,
      { actions: [] },
      ['actions'],
    );
    expect(field).not.toBeNull();
    expect(field?.name).toBe('actions');
    expect(field?.type).toBe('array');
  });

  it('resolves nested array inside discriminated_union variant', () => {
    const field = resolveFieldAtPath(
      siLikeDefinition,
      {
        conditions: {
          op: 'all',
          conditions: [],
        },
      },
      ['conditions', 'conditions'],
    );
    expect(field).not.toBeNull();
    expect(field?.name).toBe('conditions');
    expect(field?.type).toBe('array');
  });

  it('resolves array<union> item field via runtime kind lookup', () => {
    const field = resolveFieldAtPath(
      siLikeDefinition,
      {
        actions: [
          { kind: 'redact_context', sources: [] },
        ],
      },
      ['actions', 0, 'sources'],
    );
    expect(field).not.toBeNull();
    expect(field?.name).toBe('sources');
    expect(field?.type).toBe('array');
  });

  it('returns null when path traverses a kind no variant carries (stale)', () => {
    // The user picked `min_tier` (which has no `sources` array) but the
    // DOM still shows the Add button from the previous `redact_context`
    // variant. Field resolution refuses to lie — null surfaces back to
    // mountForm's MAJOR 1 fold.
    const field = resolveFieldAtPath(
      siLikeDefinition,
      {
        actions: [{ kind: 'min_tier', tier: 'fast' }],
      },
      ['actions', 0, 'sources'],
    );
    expect(field).toBeNull();
  });

  it('returns null when an unknown field name appears in the path', () => {
    const field = resolveFieldAtPath(
      siLikeDefinition,
      { actions: [] },
      ['unknown_field'],
    );
    expect(field).toBeNull();
  });
});

describe('D-145 Slice 2c — mutateArrayAtPath', () => {
  it('appends to a top-level array', () => {
    const values = { actions: [{ kind: 'require_approval' }] };
    mutateArrayAtPath(values, ['actions'], (arr) => [...arr, { kind: 'tag_response', tag: 't' }]);
    expect(values.actions).toEqual([
      { kind: 'require_approval' },
      { kind: 'tag_response', tag: 't' },
    ]);
  });

  it('mutates an array nested inside an array<union> item', () => {
    const values = {
      actions: [
        { kind: 'redact_context', sources: ['hubspot'] },
      ],
    };
    mutateArrayAtPath(values, ['actions', 0, 'sources'], (arr) => [
      ...arr,
      'salesforce',
    ]);
    expect((values.actions[0] as { sources: string[] }).sources).toEqual([
      'hubspot',
      'salesforce',
    ]);
  });

  it('removes by filter at nested path', () => {
    const values = {
      conditions: {
        op: 'all',
        conditions: [
          { op: 'topic_match', topic: 'a' },
          { op: 'topic_match', topic: 'b' },
        ],
      },
    };
    mutateArrayAtPath(values, ['conditions', 'conditions'], (arr) =>
      arr.filter((_, i) => i !== 0),
    );
    expect((values.conditions as { conditions: unknown[] }).conditions).toEqual([
      { op: 'topic_match', topic: 'b' },
    ]);
  });

  it('treats a missing target array as empty + writes back', () => {
    const values: Record<string, unknown> = {};
    mutateArrayAtPath(values, ['actions'], (arr) => [...arr, 'x']);
    expect(values.actions).toEqual(['x']);
  });

  it('refuses to mutate when path ends in a numeric segment (arrays-of-arrays not supported)', () => {
    const values = { actions: [{ kind: 'a' }] };
    const before = JSON.stringify(values);
    mutateArrayAtPath(values, ['actions', 0], (arr) => [...arr, 'new']);
    expect(JSON.stringify(values)).toBe(before);
  });

  it('refuses to mutate when an intermediate node is missing', () => {
    const values = { actions: [{ kind: 'redact_context' }] };
    const before = JSON.stringify(values);
    mutateArrayAtPath(values, ['unknown', 0, 'sources'], (arr) => [...arr, 'x']);
    expect(JSON.stringify(values)).toBe(before);
  });
});

describe('D-145 Slice 2c — computeArrayPathFromButton', () => {
  // The walker reads `parentElement` / `getAttribute` / `classList`;
  // hand-stitched nodes mirror the renderer's data-* markers so we can
  // exercise every interesting nesting shape.

  const formRoot = (children: FakeNode[]): FakeNode =>
    node({ tag: 'div', classes: ['form-renderer-form'], children });

  it('top-level array Add → [arrayName]', () => {
    const addBtn = node({
      tag: 'button',
      attrs: { 'data-form-array-add': 'actions' },
    });
    const arrayWrapper = node({
      tag: 'div',
      attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
      children: [addBtn],
    });
    const row = node({
      tag: 'div',
      attrs: { 'data-form-row': 'actions' },
      children: [arrayWrapper],
    });
    const root = formRoot([row]);
    expect(computeArrayPathFromButton(addBtn as unknown as Element, root as unknown as Element)).toEqual(['actions']);
  });

  it('Remove inside array item walks back to the array (depth 2)', () => {
    const removeBtn = node({
      tag: 'button',
      attrs: {
        'data-form-array-remove': 'actions',
        'data-form-array-index': '2',
      },
    });
    const item = node({
      tag: 'div',
      attrs: {
        'data-form-array-item': 'actions',
        'data-form-array-index': '2',
        'data-form-type': 'discriminated_union',
      },
      children: [removeBtn],
    });
    const arrayWrapper = node({
      tag: 'div',
      attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
      children: [item],
    });
    const row = node({
      tag: 'div',
      attrs: { 'data-form-row': 'actions' },
      children: [arrayWrapper],
    });
    const root = formRoot([row]);
    expect(computeArrayPathFromButton(removeBtn as unknown as Element, root as unknown as Element)).toEqual(['actions']);
  });

  it('nested array inside union variant body → [outerUnionField, innerArrayField]', () => {
    // Mirrors SI's `conditions` discriminated_union → `all` variant →
    // inner `conditions` array. The inner Add must resolve to a path
    // that descends through the outer union (no array-item segment
    // because the outer is a single union, not an array<union>).
    const addBtn = node({
      tag: 'button',
      attrs: { 'data-form-array-add': 'conditions' },
    });
    const innerArrayWrapper = node({
      tag: 'div',
      attrs: { 'data-form-field': 'conditions', 'data-form-type': 'array' },
      children: [addBtn],
    });
    const innerRow = node({
      tag: 'div',
      attrs: { 'data-form-row': 'conditions' },
      children: [innerArrayWrapper],
    });
    const variantBody = node({
      tag: 'div',
      classes: ['form-renderer-union-variant'],
      attrs: {
        'data-form-union-scope': 'conditions',
        'data-form-union-variant': 'all',
        'data-form-variant-active': 'true',
      },
      children: [innerRow],
    });
    const outerUnion = node({
      tag: 'div',
      attrs: {
        'data-form-field': 'conditions',
        'data-form-type': 'discriminated_union',
      },
      children: [variantBody],
    });
    const outerRow = node({
      tag: 'div',
      attrs: { 'data-form-row': 'conditions' },
      children: [outerUnion],
    });
    const root = formRoot([outerRow]);
    expect(computeArrayPathFromButton(addBtn as unknown as Element, root as unknown as Element)).toEqual([
      'conditions',
      'conditions',
    ]);
  });

  it('array-of-union item with nested array → [outerArray, index, innerArray]', () => {
    // Mirrors SI's `actions[0].sources` (redact_context variant). The
    // path must thread the outer array index between the outer + inner
    // array names.
    const addBtn = node({
      tag: 'button',
      attrs: { 'data-form-array-add': 'sources' },
    });
    const innerArrayWrapper = node({
      tag: 'div',
      attrs: { 'data-form-field': 'sources', 'data-form-type': 'array' },
      children: [addBtn],
    });
    const innerRow = node({
      tag: 'div',
      attrs: { 'data-form-row': 'sources' },
      children: [innerArrayWrapper],
    });
    const variantBody = node({
      tag: 'div',
      classes: ['form-renderer-union-variant'],
      attrs: {
        'data-form-union-scope': 'actions',
        'data-form-union-variant': 'redact_context',
        'data-form-variant-active': 'true',
      },
      children: [innerRow],
    });
    const outerItem = node({
      tag: 'div',
      attrs: {
        'data-form-array-item': 'actions',
        'data-form-array-index': '0',
        'data-form-type': 'discriminated_union',
      },
      children: [variantBody],
    });
    const outerArrayWrapper = node({
      tag: 'div',
      attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
      children: [outerItem],
    });
    const outerRow = node({
      tag: 'div',
      attrs: { 'data-form-row': 'actions' },
      children: [outerArrayWrapper],
    });
    const root = formRoot([outerRow]);
    expect(computeArrayPathFromButton(addBtn as unknown as Element, root as unknown as Element)).toEqual([
      'actions',
      0,
      'sources',
    ]);
  });

  it('returns null when the button is not inside any array wrapper', () => {
    const orphanBtn = node({
      tag: 'button',
      attrs: { 'data-form-array-add': 'phantom' },
    });
    const root = formRoot([orphanBtn]);
    expect(computeArrayPathFromButton(orphanBtn as unknown as Element, root as unknown as Element)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// Layer 2 — mountForm integration
// ════════════════════════════════════════════════════════════════════

const buildEmptyHost = (): FakeNode =>
  node({ tag: 'div', classes: ['si-editor-form'] });

const mountAgainst = (
  definition: FormDefinition,
  initialValues: Record<string, unknown>,
): { host: FakeNode; mount: FormMount } => {
  const host = buildEmptyHost();
  const mount = mountForm(host as unknown as HTMLElement, definition, {
    values: initialValues,
  });
  return { host, mount };
};

describe('D-145 Slice 2c — mountForm initial paint + dispose', () => {
  it('initial paint writes the rendered form HTML to host', () => {
    const { host } = mountAgainst(siLikeDefinition, {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [{ kind: 'require_approval' }],
    });
    expect(host.innerHTML).toContain('data-form-field="actions"');
    expect(host.innerHTML).toContain('data-form-type="array"');
    expect(host.innerHTML).toContain('data-form-array-add="actions"');
  });

  it('dispose removes the click listener (subsequent click is a no-op)', () => {
    const { host, mount } = mountAgainst(siLikeDefinition, {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [{ kind: 'require_approval' }],
    });
    const htmlBefore = host.innerHTML;
    mount.dispose();
    // Synthesize a click that would have triggered an Add if the
    // listener were still installed; verify innerHTML stays put.
    const addBtn = node({
      tag: 'button',
      attrs: { 'data-form-array-add': 'actions' },
    });
    // The Add button needs to live inside the host so that
    // dispatchClick's bubble walk hits the host's (now-empty) listener
    // map. Stitch it in as a temporary child.
    host.appendChild(addBtn);
    addBtn.dispatchClick();
    // innerHTML still equals the post-mount paint — no re-paint fired
    // because dispose released the listener.
    expect(host.innerHTML).toBe(htmlBefore);
  });

  it('dispose is idempotent', () => {
    const { mount } = mountAgainst(siLikeDefinition, {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [{ kind: 'require_approval' }],
    });
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
  });
});

describe('D-145 Slice 2c — Add click extends the target array', () => {
  it('Add click appends the seeded default item + repaints', () => {
    // The fake host's children are an empty actions array (we don't
    // parse the renderer's HTML into the fake — innerHTML is a string
    // capture). readFormValues observes actions=[]; the mutator
    // appends; paint renders an actions array with the first item.
    const initial = {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [],
    };
    const { host } = mountAgainst(siLikeDefinition, initial);
    const addBtn = buildAddButtonForActions(host);
    addBtn.dispatchClick();
    const post = host.innerHTML;
    expect(post).toContain('data-form-array-index="0"');
    // Default item for array<discriminated_union> seeds the first
    // variant's kind — `require_approval` here — so the rendered
    // item carries an active variant body for that kind.
    expect(post).toContain('data-form-union-variant="require_approval"');
  });
});

describe('D-145 Slice 2c — Remove click splices the target array', () => {
  it('removing the only action leaves an empty array', () => {
    const initial = {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [{ kind: 'require_approval' }],
    };
    const { host } = mountAgainst(siLikeDefinition, initial);
    const removeBtn = buildRemoveButtonForActionsAt(host, 0);
    removeBtn.dispatchClick();
    const post = host.innerHTML;
    // No array items rendered; renderer surfaces an empty placeholder
    // div (`form-renderer-array-empty`) for zero-length arrays.
    expect(post).not.toContain('data-form-array-index="0"');
    expect(post).toContain('form-renderer-array-empty');
  });
});

describe('D-145 Slice 2c — getValues reads through to readFormValues', () => {
  it('mount.getValues snapshots the live DOM via readFormValues', () => {
    // The fake DOM's children tree is the initial layout we hand to
    // mountForm via the manual node stitching. readFormValues walks
    // that tree; we just verify the round-trip works.
    const initial = {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [],
    };
    const { host, mount } = mountAgainst(siLikeDefinition, initial);
    // Build a deterministic children tree under the host so the
    // readFormValues walk lands on known shape.
    seedSiLikeChildren(host, {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [],
    });
    const values = mount.getValues();
    expect(values).toMatchObject({
      conditions: { op: 'request_kind', equals: 'compose_email' },
    });
  });
});

describe('D-145 Slice 2c — Codex MAJOR 1 fold (stale-union Add repaints)', () => {
  it('Add on an orphaned variant body still triggers a paint to align DOM with values', () => {
    // Set up: user "picked" min_tier in the DOM (the select.value is
    // min_tier) but the form was last painted with redact_context, so
    // the redact_context body — including the `sources` Add button —
    // is still in the DOM. User clicks the orphaned Add.
    //
    // Pre-fold the handler would silently bail (resolveFieldAtPath
    // returns null because min_tier carries no `sources` field), and
    // the DOM would stay stuck on the old variant body. Post-fold
    // the handler triggers paint() with the freshly-read values map,
    // so the active-variant marker flips to min_tier + the orphaned
    // button drops out of the rendered HTML.
    const initial = {
      conditions: { op: 'request_kind', equals: 'compose_email' },
      actions: [{ kind: 'redact_context', sources: [] }],
    };
    const { host } = mountAgainst(siLikeDefinition, initial);
    // Build a children tree where the action item's union <select>
    // reads `min_tier` (user clicked the select), but the variant
    // body in the DOM is the old redact_context body with its
    // sources Add button.
    const initialHtml = host.innerHTML;
    seedStaleUnionDom(host);
    const orphanAddBtn = findFirst(host, '[data-form-array-add="sources"]');
    expect(orphanAddBtn).not.toBeNull();
    orphanAddBtn!.dispatchClick();
    // Paint fired — the host.innerHTML is the freshly-rendered form
    // for the post-snapshot values (kind = min_tier). The renderer
    // still emits all variants for the read path to switch on, so
    // the redact_context body + its sources Add button stay in the
    // HTML (CSS hides them via `data-form-variant-active="false"`).
    // The behavioral signal of the fold is: the paint fired AT ALL
    // (without the fold the handler bailed silently) + the now-active
    // variant body is min_tier, not redact_context.
    expect(host.innerHTML).not.toBe(initialHtml);
    // min_tier body is now marked active.
    expect(host.innerHTML).toMatch(
      /data-form-union-variant="min_tier"[\s\S]*?data-form-variant-active="true"/,
    );
    // redact_context body is now marked inactive (renderer always
    // paints it but the active marker flips on kind change).
    expect(host.innerHTML).toMatch(
      /data-form-union-variant="redact_context"[\s\S]*?data-form-variant-active="false"/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Test helpers — fake DOM tree builders
// ════════════════════════════════════════════════════════════════════

const buildAddButtonForActions = (host: FakeNode): FakeNode => {
  const addBtn = node({
    tag: 'button',
    attrs: { 'data-form-array-add': 'actions' },
  });
  const wrapper = node({
    tag: 'div',
    attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
    children: [addBtn],
  });
  const row = node({
    tag: 'div',
    attrs: { 'data-form-row': 'actions' },
    children: [wrapper],
  });
  const formRootNode = node({
    tag: 'div',
    classes: ['form-renderer-form'],
    children: [row],
  });
  host.appendChild(formRootNode);
  return addBtn;
};

const buildRemoveButtonForActionsAt = (
  host: FakeNode,
  index: number,
): FakeNode => {
  // Minimal layout — the actions array has one item at the given index
  // whose kind == require_approval (no inner content). The Remove
  // button is the item's only child for path-walk purposes.
  const removeBtn = node({
    tag: 'button',
    attrs: {
      'data-form-array-remove': 'actions',
      'data-form-array-index': String(index),
    },
  });
  // Stub union select so readFormValues finds `kind: 'require_approval'`
  // when walking the item.
  const unionSelect = node({
    tag: 'select',
    attrs: {
      'data-form-union-select': 'actions',
      'data-form-discriminant-field': 'kind',
    },
    value: 'require_approval',
  });
  const variantBody = node({
    tag: 'div',
    classes: ['form-renderer-union-variant'],
    attrs: {
      'data-form-union-scope': 'actions',
      'data-form-union-variant': 'require_approval',
      'data-form-variant-active': 'true',
    },
  });
  const item = node({
    tag: 'div',
    classes: ['form-renderer-array-item'],
    attrs: {
      'data-form-array-item': 'actions',
      'data-form-array-index': String(index),
      'data-form-type': 'discriminated_union',
    },
    children: [unionSelect, variantBody, removeBtn],
  });
  const wrapper = node({
    tag: 'div',
    classes: ['form-renderer-array'],
    attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
    children: [item],
  });
  const conditionsField = node({
    tag: 'div',
    attrs: {
      'data-form-field': 'conditions',
      'data-form-type': 'discriminated_union',
    },
    children: [
      node({
        tag: 'select',
        attrs: {
          'data-form-union-select': 'conditions',
          'data-form-discriminant-field': 'op',
        },
        value: 'request_kind',
      }),
      node({
        tag: 'div',
        classes: ['form-renderer-union-variant'],
        attrs: {
          'data-form-union-scope': 'conditions',
          'data-form-union-variant': 'request_kind',
          'data-form-variant-active': 'true',
        },
        children: [
          node({
            tag: 'div',
            attrs: { 'data-form-row': 'equals' },
            children: [
              node({
                tag: 'select',
                attrs: { 'data-form-field': 'equals', 'data-form-type': 'enum' },
                value: 'compose_email',
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const condRow = node({
    tag: 'div',
    attrs: { 'data-form-row': 'conditions' },
    children: [conditionsField],
  });
  const actionsRow = node({
    tag: 'div',
    attrs: { 'data-form-row': 'actions' },
    children: [wrapper],
  });
  const formRootNode = node({
    tag: 'div',
    classes: ['form-renderer-form'],
    children: [condRow, actionsRow],
  });
  host.appendChild(formRootNode);
  return removeBtn;
};

/** Seed a minimal tree shaped like renderForm's output for the
 *  siLikeDefinition. Just enough for readFormValues to extract the
 *  passed-in initial values. */
const seedSiLikeChildren = (
  host: FakeNode,
  values: { conditions: { op: string; equals: string }; actions: unknown[] },
): void => {
  const conditionsField = node({
    tag: 'div',
    attrs: {
      'data-form-field': 'conditions',
      'data-form-type': 'discriminated_union',
    },
    children: [
      node({
        tag: 'select',
        attrs: {
          'data-form-union-select': 'conditions',
          'data-form-discriminant-field': 'op',
        },
        value: values.conditions.op,
      }),
      node({
        tag: 'div',
        classes: ['form-renderer-union-variant'],
        attrs: {
          'data-form-union-scope': 'conditions',
          'data-form-union-variant': values.conditions.op,
          'data-form-variant-active': 'true',
        },
        children: [
          node({
            tag: 'div',
            attrs: { 'data-form-row': 'equals' },
            children: [
              node({
                tag: 'select',
                attrs: { 'data-form-field': 'equals', 'data-form-type': 'enum' },
                value: values.conditions.equals,
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const actionsArr = node({
    tag: 'div',
    attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
  });
  const formRootNode = node({
    tag: 'div',
    classes: ['form-renderer-form'],
    children: [
      node({
        tag: 'div',
        attrs: { 'data-form-row': 'conditions' },
        children: [conditionsField],
      }),
      node({
        tag: 'div',
        attrs: { 'data-form-row': 'actions' },
        children: [actionsArr],
      }),
    ],
  });
  host.appendChild(formRootNode);
};

/** Build a fake DOM where the actions[0] union <select> says
 *  `min_tier` but the rendered variant body is `redact_context` (with
 *  its `sources` Add button). Mirrors the stale-DOM scenario the
 *  MAJOR 1 fold protects against. */
const seedStaleUnionDom = (host: FakeNode): void => {
  const sourcesAdd = node({
    tag: 'button',
    attrs: { 'data-form-array-add': 'sources' },
  });
  const sourcesWrapper = node({
    tag: 'div',
    attrs: { 'data-form-field': 'sources', 'data-form-type': 'array' },
    children: [sourcesAdd],
  });
  const sourcesRow = node({
    tag: 'div',
    attrs: { 'data-form-row': 'sources' },
    children: [sourcesWrapper],
  });
  // Stale redact_context body — still in the DOM even though the
  // discriminant select now says min_tier.
  const redactBody = node({
    tag: 'div',
    classes: ['form-renderer-union-variant'],
    attrs: {
      'data-form-union-scope': 'actions',
      'data-form-union-variant': 'redact_context',
      'data-form-variant-active': 'true',
    },
    children: [sourcesRow],
  });
  // Discriminant select now reads min_tier.
  const select = node({
    tag: 'select',
    attrs: {
      'data-form-union-select': 'actions',
      'data-form-discriminant-field': 'kind',
    },
    value: 'min_tier',
  });
  const item = node({
    tag: 'div',
    attrs: {
      'data-form-array-item': 'actions',
      'data-form-array-index': '0',
      'data-form-type': 'discriminated_union',
    },
    children: [select, redactBody],
  });
  const actionsArr = node({
    tag: 'div',
    attrs: { 'data-form-field': 'actions', 'data-form-type': 'array' },
    children: [item],
  });
  // Minimal conditions row so readFormValues finds the top-level
  // conditions field (it returns undefined for missing fields, which
  // is OK — the test only inspects the actions resolution path).
  const conditionsField = node({
    tag: 'div',
    attrs: {
      'data-form-field': 'conditions',
      'data-form-type': 'discriminated_union',
    },
    children: [
      node({
        tag: 'select',
        attrs: {
          'data-form-union-select': 'conditions',
          'data-form-discriminant-field': 'op',
        },
        value: 'request_kind',
      }),
      node({
        tag: 'div',
        classes: ['form-renderer-union-variant'],
        attrs: {
          'data-form-union-scope': 'conditions',
          'data-form-union-variant': 'request_kind',
          'data-form-variant-active': 'true',
        },
        children: [
          node({
            tag: 'div',
            attrs: { 'data-form-row': 'equals' },
            children: [
              node({
                tag: 'select',
                attrs: { 'data-form-field': 'equals', 'data-form-type': 'enum' },
                value: 'compose_email',
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const formRootNode = node({
    tag: 'div',
    classes: ['form-renderer-form'],
    children: [
      node({
        tag: 'div',
        attrs: { 'data-form-row': 'conditions' },
        children: [conditionsField],
      }),
      node({
        tag: 'div',
        attrs: { 'data-form-row': 'actions' },
        children: [actionsArr],
      }),
    ],
  });
  host.appendChild(formRootNode);
};
