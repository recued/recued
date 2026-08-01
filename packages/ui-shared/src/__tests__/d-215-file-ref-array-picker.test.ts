/** D-215 slice 5 residual — the ORDERED `file_ref[]` picker.
 *
 *  Three layers, matching the source split:
 *   1. the pure list ops (`appendFileRef` / `moveFileRef` / `removeFileRef`)
 *      — where every ordering rule lives. No DOM.
 *   2. `renderFileRefArrayItems` + the `renderVariableWidget` branch — pure
 *      HTML strings, and `readWidgetValue` reading the value back.
 *   3. `wireFileRefArray` — DOM glue against the compact fake DOM this suite
 *      shares with `ref-picker.test.ts`. It does NOT parse `innerHTML` into
 *      nodes, so a test that needs to press a rendered `↑` materializes the
 *      button by hand (mirroring what a browser would parse).
 *
 *  ⚠ Ordering is the property under test throughout: a `file_ref[]` is a
 *  SEQUENCE (a carousel's images, `pdfunite`'s page order), so an assertion
 *  that only checks membership would pass on a picker that shuffled.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  appendFileRef,
  fileRefArrayIds,
  moveFileRef,
  removeFileRef,
  wireFileRefArray,
} from '../file-ref-array.js';
import {
  FILE_REF_ARRAY_ACTION_ATTR,
  FILE_REF_ARRAY_INDEX_ATTR,
  FILE_REF_ARRAY_ITEM_ATTR,
  FILE_REF_ARRAY_LIST_ATTR,
  FILE_REF_ARRAY_VARIABLE_ATTR,
  MISSING_FILE_PREFIX,
  fileRefArrayItem,
  fileRefArrayVariablePickerId,
  fileRefVariablePickerId,
  readWidgetValue,
  renderFileRefArrayItems,
  renderVariableWidget,
  toFileRefIds,
  toWidgetShape,
  validateWidgetValue,
  type FileRefArrayItem,
} from '../variable-widgets.js';
import {
  REF_PICKER_INPUT_ATTR,
  REF_PICKER_OPTION_INDEX_ATTR,
  REF_PICKER_RESULTS_ATTR,
} from '../ref-picker/index.js';

const ITEMS: FileRefArrayItem[] = [
  { id: 'file:a', label: 'a.png' },
  { id: 'file:b', label: 'b.png' },
  { id: 'file:c', label: 'c.png' },
];

// ════════════════════════════════════════════════════════════════════
// 1. pure list ops
// ════════════════════════════════════════════════════════════════════

describe('file_ref[] list ops', () => {
  it('appends to the END, so pick order is the value order', () => {
    const next = appendFileRef(ITEMS, { id: 'file:d', label: 'd.png' });
    expect(fileRefArrayIds(next)).toEqual(['file:a', 'file:b', 'file:c', 'file:d']);
  });

  it('keeps a duplicate pick — the value is a sequence, not a set', () => {
    const next = appendFileRef(ITEMS, { id: 'file:a', label: 'a.png' });
    expect(fileRefArrayIds(next)).toEqual(['file:a', 'file:b', 'file:c', 'file:a']);
  });

  it('moves an item up, swapping it with exactly its predecessor', () => {
    expect(fileRefArrayIds(moveFileRef(ITEMS, 2, -1)))
      .toEqual(['file:a', 'file:c', 'file:b']);
  });

  it('moves an item down, swapping it with exactly its successor', () => {
    expect(fileRefArrayIds(moveFileRef(ITEMS, 0, 1)))
      .toEqual(['file:b', 'file:a', 'file:c']);
  });

  it('moves across the list without dropping or duplicating anything', () => {
    // Two ups from the tail must walk the item to the head and leave the
    // others in their relative order — a swap implemented as an overwrite
    // would lose one.
    const once = moveFileRef(ITEMS, 2, -1);
    expect(fileRefArrayIds(moveFileRef(once, 1, -1)))
      .toEqual(['file:c', 'file:a', 'file:b']);
  });

  it('refuses a move off either end, returning the list unchanged', () => {
    expect(fileRefArrayIds(moveFileRef(ITEMS, 0, -1))).toEqual(fileRefArrayIds(ITEMS));
    expect(fileRefArrayIds(moveFileRef(ITEMS, 2, 1))).toEqual(fileRefArrayIds(ITEMS));
  });

  it('refuses a move at an out-of-range or non-integer index', () => {
    expect(fileRefArrayIds(moveFileRef(ITEMS, 7, -1))).toEqual(fileRefArrayIds(ITEMS));
    expect(fileRefArrayIds(moveFileRef(ITEMS, -1, 1))).toEqual(fileRefArrayIds(ITEMS));
    expect(fileRefArrayIds(moveFileRef(ITEMS, Number.NaN, 1))).toEqual(fileRefArrayIds(ITEMS));
  });

  it('removes by POSITION, so a duplicated id drops only the one pressed', () => {
    const dupes: FileRefArrayItem[] = [
      { id: 'file:a', label: 'a.png' },
      { id: 'file:b', label: 'b.png' },
      { id: 'file:a', label: 'a.png' },
    ];
    expect(fileRefArrayIds(removeFileRef(dupes, 0)))
      .toEqual(['file:b', 'file:a']);
  });

  it('refuses a remove at an out-of-range index', () => {
    expect(fileRefArrayIds(removeFileRef(ITEMS, 9))).toEqual(fileRefArrayIds(ITEMS));
  });

  it('never mutates the input list', () => {
    const source = [...ITEMS];
    moveFileRef(source, 0, 1);
    removeFileRef(source, 0);
    appendFileRef(source, { id: 'file:z', label: 'z.png' });
    expect(fileRefArrayIds(source)).toEqual(['file:a', 'file:b', 'file:c']);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. pure render + read
// ════════════════════════════════════════════════════════════════════

describe('toFileRefIds', () => {
  it('takes the array shape the picker writes', () => {
    expect(toFileRefIds(['file:a', 'file:b'])).toEqual(['file:a', 'file:b']);
  });

  it('takes the comma-separated shape the pasteable fallback writes', () => {
    expect(toFileRefIds('file:a, file:b')).toEqual(['file:a', 'file:b']);
  });

  it('drops blanks and non-strings rather than emitting empty refs', () => {
    expect(toFileRefIds(['file:a', '', '  ', 7, null])).toEqual(['file:a']);
    expect(toFileRefIds(',,file:a,')).toEqual(['file:a']);
  });

  it('reads an absent / wrong-typed value as empty', () => {
    expect(toFileRefIds(undefined)).toEqual([]);
    expect(toFileRefIds({ file: 'a' })).toEqual([]);
  });
});

describe('renderFileRefArrayItems', () => {
  it('renders each id in order with its 1-based position', () => {
    const html = renderFileRefArrayItems(ITEMS);
    expect(html).toContain(`${FILE_REF_ARRAY_ITEM_ATTR}="file:a"`);
    expect(html).toContain('>1</span>');
    expect(html).toContain('>3</span>');
    // Positional, not alphabetical: `a` must precede `b` precede `c`.
    expect(html.indexOf('file:a')).toBeLessThan(html.indexOf('file:b'));
    expect(html.indexOf('file:b')).toBeLessThan(html.indexOf('file:c'));
  });

  it('renders the pick order, NOT a sorted one', () => {
    const reversed = [...ITEMS].reverse();
    const html = renderFileRefArrayItems(reversed);
    expect(html.indexOf('file:c')).toBeLessThan(html.indexOf('file:a'));
  });

  it('disables ↑ on the first row and ↓ on the last, and neither in between', () => {
    const rows = renderFileRefArrayItems(ITEMS).split('<li').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(`${FILE_REF_ARRAY_ACTION_ATTR}="up" ${FILE_REF_ARRAY_INDEX_ATTR}="0" title="Move earlier" aria-label="Move earlier: a.png" disabled`);
    expect(rows[0]).not.toContain('"down" ' + `${FILE_REF_ARRAY_INDEX_ATTR}="0" title="Move later" aria-label="Move later: a.png" disabled`);
    expect(rows[1]).not.toContain('disabled');
    expect(rows[2]).toContain(`${FILE_REF_ARRAY_ACTION_ATTR}="down" ${FILE_REF_ARRAY_INDEX_ATTR}="2" title="Move later" aria-label="Move later: c.png" disabled`);
  });

  it('never disables Remove', () => {
    const rows = renderFileRefArrayItems([ITEMS[0]!]).split('<li').slice(1);
    expect(rows[0]).toContain(`${FILE_REF_ARRAY_ACTION_ATTR}="remove" ${FILE_REF_ARRAY_INDEX_ATTR}="0" title="Remove" aria-label="Remove: a.png">`);
  });

  it('renders an empty list as a stated absence, not blank markup', () => {
    const html = renderFileRefArrayItems([]);
    expect(html).toContain('No files chosen yet.');
    expect(html).not.toContain(FILE_REF_ARRAY_ITEM_ATTR);
  });

  it('flags a § 9e missing file on the ROW, not just in its label', () => {
    const html = renderFileRefArrayItems([
      { id: 'file:gone', label: `${MISSING_FILE_PREFIX}file:gone`, missing: true },
    ]);
    expect(html).toContain('var-file-refs-item--missing');
    expect(html).toContain(MISSING_FILE_PREFIX);
  });

  it('escapes an inventory label — it is user data', () => {
    const html = renderFileRefArrayItems([
      { id: 'file:x', label: '<img src=x onerror=evil()>' },
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('fileRefArrayItem (§ 9e verdict)', () => {
  it('takes the inventory label on a hit', () => {
    const item = fileRefArrayItem('file:a', [{ id: 'file:a', label: 'a.png' }]);
    expect(item).toEqual({ id: 'file:a', label: 'a.png' });
    expect(item.missing).toBeUndefined();
  });

  it('marks an id the inventory does not know as missing, keeping the id', () => {
    const item = fileRefArrayItem('file:gone', [{ id: 'file:a', label: 'a.png' }]);
    expect(item.missing).toBe(true);
    expect(item.id).toBe('file:gone');
    expect(item.label).toBe(`${MISSING_FILE_PREFIX}file:gone`);
  });

  it('counts a hit with an EMPTY label as missing — blank is what § 9e forbids', () => {
    expect(fileRefArrayItem('file:a', [{ id: 'file:a', label: '' }]).missing).toBe(true);
  });
});

describe('renderVariableWidget — file_ref[]', () => {
  const HINT = {
    label: 'Post images',
    type: 'file_ref[]' as const,
    default: ['file:a', 'file:b'],
  };

  it('renders the ordered list + an append combobox when an inventory is wired', () => {
    const html = renderVariableWidget(toWidgetShape('images', HINT), {
      fileRefPicker: true,
      idPrefix: 'run',
    });
    expect(html).toContain(`${FILE_REF_ARRAY_VARIABLE_ATTR}="images"`);
    expect(html).toContain(`${FILE_REF_ARRAY_LIST_ATTR}="images"`);
    expect(html).toContain(`data-ref-picker="${fileRefArrayVariablePickerId('images', 'run')}"`);
    expect(html).toContain('role="combobox"');
    // Seeded in declared order.
    expect(html.indexOf('file:a')).toBeLessThan(html.indexOf('file:b'));
    // The list carries the read contract.
    expect(html).toContain('data-var-key="images" data-var-type="file_ref_array"');
  });

  it('uses a picker id provably distinct from the singular row\'s', () => {
    expect(fileRefArrayVariablePickerId('images', 'run'))
      .not.toBe(fileRefVariablePickerId('images', 'run'));
  });

  it('degrades to a pasteable comma-separated box with no inventory', () => {
    const html = renderVariableWidget(toWidgetShape('images', HINT));
    expect(html).toContain('data-var-type="file_ref_array"');
    expect(html).toContain('value="file:a, file:b"');
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain(FILE_REF_ARRAY_LIST_ATTR);
  });

  it('renders an unset value as an empty list, never as an error row', () => {
    const html = renderVariableWidget(
      toWidgetShape('images', { label: 'Post images', type: 'file_ref[]' }),
      { fileRefPicker: true },
    );
    expect(html).toContain('No files chosen yet.');
  });
});

describe('readWidgetValue — file_ref_array', () => {
  it('reads the list rows in DOM ORDER', () => {
    const list = fakeList(['file:c', 'file:a', 'file:b']);
    expect(readWidgetValue(list)).toEqual(['file:c', 'file:a', 'file:b']);
  });

  it('resolves the list from a descendant, like the multi grid does', () => {
    const list = fakeList(['file:a']);
    const inner = fakeEl({
      dataset: { varKey: 'images', varType: 'file_ref_array' },
      matches: () => false,
      closest: (sel: string) =>
        sel === `[${FILE_REF_ARRAY_LIST_ATTR}]` ? list : null,
    });
    expect(readWidgetValue(inner)).toEqual(['file:a']);
  });

  it('reads the pasteable fallback box as an ARRAY, not a string', () => {
    const input = fakeEl({
      dataset: { varKey: 'images', varType: 'file_ref_array' },
      value: 'file:a, file:b',
    });
    expect(readWidgetValue(input)).toEqual(['file:a', 'file:b']);
  });

  it('reads an empty list as an empty array', () => {
    expect(readWidgetValue(fakeList([]))).toEqual([]);
  });
});

describe('validateWidgetValue — file_ref[]', () => {
  const required = toWidgetShape('images', { label: 'Post images', type: 'file_ref[]' });

  it('flags an empty required list', () => {
    expect(validateWidgetValue(required, [])).toBe('Choose at least one file');
  });

  it('flags a leftover STRING — the wrong shape reaching the recipe', () => {
    expect(validateWidgetValue(required, 'file:a')).toBe('Choose at least one file');
  });

  it('accepts a non-empty list, and anything at all when optional', () => {
    expect(validateWidgetValue(required, ['file:a'])).toBeNull();
    expect(validateWidgetValue(
      toWidgetShape('images', { label: 'i', type: 'file_ref[]', optional: true }),
      [],
    )).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. wireFileRefArray — DOM glue
// ════════════════════════════════════════════════════════════════════

describe('wireFileRefArray', () => {
  it('reports the reordered ids when ↑ is pressed, and repaints the list', () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b', 'file:c']);
    const onChange = vi.fn();
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:a', 'file:b', 'file:c'],
      onChange,
    });
    expect(handle).not.toBeNull();

    // Press the ↑ on row 2 (index 2 → index 1).
    dispatch(materializeControl(list, 'up', 2), 'click');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(['file:a', 'file:c', 'file:b']);
    expect(handle!.getValue()).toEqual(['file:a', 'file:c', 'file:b']);
    // The repaint reflects the new order — a handler that reported without
    // repainting would leave the user looking at the old sequence.
    expect(list.innerHTML.indexOf('file:c'))
      .toBeLessThan(list.innerHTML.indexOf('file:b'));
  });

  it('reports the reordered ids when ↓ is pressed', () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b']);
    const onChange = vi.fn();
    wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:a', 'file:b'],
      onChange,
    });
    dispatch(materializeControl(list, 'down', 0), 'click');
    expect(onChange.mock.calls[0]![0]).toEqual(['file:b', 'file:a']);
  });

  it('reports the shortened list when × is pressed', () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b', 'file:c']);
    const onChange = vi.fn();
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:a', 'file:b', 'file:c'],
      onChange,
    });
    dispatch(materializeControl(list, 'remove', 1), 'click');
    expect(onChange.mock.calls[0]![0]).toEqual(['file:a', 'file:c']);
    expect(handle!.getValue()).toEqual(['file:a', 'file:c']);
  });

  it('survives repeated presses — the listener is delegated, not per-button', () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b', 'file:c']);
    const onChange = vi.fn();
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:a', 'file:b', 'file:c'],
      onChange,
    });
    // Walk `file:c` from the tail to the head with two presses. A listener
    // bound to the button nodes would die with the first repaint.
    dispatch(materializeControl(list, 'up', 2), 'click');
    dispatch(materializeControl(list, 'up', 1), 'click');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(handle!.getValue()).toEqual(['file:c', 'file:a', 'file:b']);
  });

  it('appends a pick to the END and clears the combobox for the next search', async () => {
    const { root, list, input, results } = buildRow('images', ['file:a']);
    const onChange = vi.fn();
    wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [{ id: 'file:z', label: 'z.png' }],
      initialIds: ['file:a'],
      onChange,
      // (search is immediate on focus; the debounce path is the picker's own
      // tested behaviour)
    });

    dispatch(input, 'focusin');
    await Promise.resolve();
    await Promise.resolve();
    // The picker painted one option; materialize it so the fake DOM can be
    // clicked (it does not parse innerHTML).
    const option = makeNode('li', { [REF_PICKER_OPTION_INDEX_ATTR]: '0' });
    results.appendChild(option);
    dispatch(option, 'mousedown');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(['file:a', 'file:z']);
    expect(list.innerHTML).toContain('file:z');
    // Cleared, so picking a second file is one uninterrupted search.
    expect(input.value).toBe('');
  });

  it('relabels a stored id the inventory no longer knows, WITHOUT reporting an edit', async () => {
    const { root, list } = buildRow('images', ['file:gone']);
    const onChange = vi.fn();
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:gone'],
      onChange,
    });
    await flush();
    expect(list.innerHTML).toContain(MISSING_FILE_PREFIX);
    expect(list.innerHTML).toContain('var-file-refs-item--missing');
    // The stored id is untouched and nothing was persisted — a broken ref
    // stays exactly as saved and is merely SHOWN as broken.
    expect(handle!.getValue()).toEqual(['file:gone']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resolves a live id to its inventory label', async () => {
    const { root, list } = buildRow('images', ['file:a']);
    wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async (q) => (q === 'file:a' ? [{ id: 'file:a', label: 'poster.png' }] : []),
      initialIds: ['file:a'],
      onChange: () => {},
    });
    await flush();
    expect(list.innerHTML).toContain('poster.png');
    expect(list.innerHTML).not.toContain(MISSING_FILE_PREFIX);
  });

  it('lets a reorder made DURING resolution win over the resolved order', async () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b']);
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async (q) => [{ id: q, label: `${q.slice(5)}.png` }],
      initialIds: ['file:a', 'file:b'],
      onChange: () => {},
    });
    // Reorder before the inventory answers.
    dispatch(materializeControl(list, 'up', 1), 'click');
    await flush();
    expect(handle!.getValue()).toEqual(['file:b', 'file:a']);
    // …and both still picked up their resolved labels.
    expect(list.innerHTML.indexOf('b.png'))
      .toBeLessThan(list.innerHTML.indexOf('a.png'));
  });

  it('stops responding after destroy', () => {
    const { root, list } = buildRow('images', ['file:a', 'file:b']);
    const onChange = vi.fn();
    const handle = wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: ['file:a', 'file:b'],
      onChange,
    });
    handle!.destroy();
    dispatch(materializeControl(list, 'up', 1), 'click');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the row is absent', () => {
    const { root } = buildRow('other_key', ['file:a']);
    expect(wireFileRefArray(asParent(root), {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: [],
      onChange: () => {},
    })).toBeNull();
  });

  it('returns null on a root that cannot be queried at all', () => {
    expect(wireFileRefArray({} as unknown as ParentNode, {
      key: 'images',
      label: 'Post images',
      idPrefix: 'run',
      search: async () => [],
      initialIds: [],
      onChange: () => {},
    })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// helpers
// ════════════════════════════════════════════════════════════════════

/** Fake Element matching the shape `readWidgetValue` touches. */
const fakeEl = (
  opts: {
    dataset?: Record<string, string>;
    value?: string;
    matches?: (sel: string) => boolean;
    closest?: (sel: string) => unknown;
    querySelectorAll?: (sel: string) => ReadonlyArray<unknown>;
  },
): Element => ({
  ...opts,
  dataset: opts.dataset ?? {},
  matches: opts.matches ?? (() => false),
  closest: opts.closest ?? (() => null),
  querySelectorAll: opts.querySelectorAll ?? (() => []),
} as unknown as Element);

/** A `<ol>` standing in for the rendered list, with `ids` as its rows. */
const fakeList = (ids: readonly string[]): Element =>
  fakeEl({
    dataset: { varKey: 'images', varType: 'file_ref_array' },
    matches: (sel) => sel === `[${FILE_REF_ARRAY_LIST_ATTR}]`,
    querySelectorAll: (sel) =>
      sel === `[${FILE_REF_ARRAY_ITEM_ATTR}]`
        ? ids.map((id) => ({ getAttribute: () => id }))
        : [],
  });

// ── the compact fake DOM (mirrors `ref-picker.test.ts`) ─────────────

interface FakeNode {
  tag: string;
  attrs: Map<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  listeners: Map<string, Array<(event: unknown) => void>>;
  value: string;
  innerHTML: string;
  focusCount: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): FakeNode | null;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  appendChild(child: FakeNode): FakeNode;
  focus(): void;
  readonly parentElement: FakeNode | null;
}

const asParent = (node: FakeNode): ParentNode => node as unknown as ParentNode;

const makeNode = (tag: string, attrs: Record<string, string> = {}): FakeNode => {
  const node: FakeNode = {
    tag,
    attrs: new Map(Object.entries(attrs)),
    children: [],
    parent: null,
    listeners: new Map(),
    value: '',
    innerHTML: '',
    focusCount: 0,
    getAttribute: (name) => node.attrs.get(name) ?? null,
    setAttribute: (name, value) => { node.attrs.set(name, value); },
    removeAttribute: (name) => { node.attrs.delete(name); },
    querySelector: (selector) => querySelector(node, selector),
    addEventListener: (type, fn) => {
      const list = node.listeners.get(type) ?? [];
      list.push(fn);
      node.listeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = node.listeners.get(type);
      if (list === undefined) return;
      node.listeners.set(type, list.filter((f) => f !== fn));
    },
    appendChild: (child) => {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    focus: () => { node.focusCount += 1; },
    get parentElement() { return node.parent; },
  };
  return node;
};

/** `[attr]` / `[attr="v"]`, optionally two of them concatenated (the
 *  `refocus` lookup uses `[action="up"][index="0"]`). */
const SELECTOR = /\[([a-z0-9-]+)(?:="([^"]*)")?\]/g;

const matchesSelector = (node: FakeNode, selector: string): boolean => {
  const clauses = [...selector.matchAll(SELECTOR)];
  if (clauses.length === 0) return false;
  return clauses.every(([, name, value]) => {
    const have = node.attrs.get(name!);
    if (have === undefined) return false;
    return value === undefined ? true : have === value;
  });
};

const querySelector = (root: FakeNode, selector: string): FakeNode | null => {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const nested = querySelector(child, selector);
    if (nested !== null) return nested;
  }
  return null;
};

const dispatch = (target: FakeNode, type: string): void => {
  const event = { target, preventDefault() { /* noop */ } };
  let node: FakeNode | null = target;
  while (node !== null) {
    for (const fn of node.listeners.get(type) ?? []) fn(event);
    node = node.parent;
  }
};

/** Build the subtree `renderVariableWidget`'s `file_ref[]` branch paints:
 *  row → [list, picker shell → [field → input, results]]. */
const buildRow = (
  key: string,
  _ids: readonly string[],
): { root: FakeNode; row: FakeNode; list: FakeNode; input: FakeNode; results: FakeNode } => {
  const root = makeNode('div');
  const row = makeNode('div', { [FILE_REF_ARRAY_VARIABLE_ATTR]: key });
  const list = makeNode('ol', {
    [FILE_REF_ARRAY_LIST_ATTR]: key,
    'data-var-key': key,
    'data-var-type': 'file_ref_array',
  });
  const shell = makeNode('div', {
    'data-ref-picker': fileRefArrayVariablePickerId(key, 'run'),
  });
  const field = makeNode('div');
  const input = makeNode('input', { [REF_PICKER_INPUT_ATTR]: '' });
  const results = makeNode('ul', { [REF_PICKER_RESULTS_ATTR]: '', hidden: '' });
  field.appendChild(input);
  shell.appendChild(field);
  shell.appendChild(results);
  row.appendChild(list);
  row.appendChild(shell);
  root.appendChild(row);
  return { root, row, list, input, results };
};

/** The fake DOM does not parse `innerHTML`, so materialize the control the
 *  repaint "rendered" as a real node under the list. */
const materializeControl = (
  list: FakeNode,
  action: 'up' | 'down' | 'remove',
  index: number,
): FakeNode => {
  const button = makeNode('button', {
    [FILE_REF_ARRAY_ACTION_ATTR]: action,
    [FILE_REF_ARRAY_INDEX_ATTR]: String(index),
  });
  list.appendChild(button);
  return button;
};

/** Drain the microtask queue so the seeded-id resolution lands. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
