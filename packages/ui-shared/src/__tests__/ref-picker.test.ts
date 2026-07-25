/** Shared name→id reference-picker — unit tests.
 *
 *  Three layers, matching the source split:
 *   1. `model.ts` — pure state transitions + the default client filter.
 *      No DOM.
 *   2. `render.ts` — pure HTML strings (shell + the surgical results body).
 *   3. `wire.ts` — DOM glue, exercised against a compact fake DOM
 *      (attribute-selector `querySelector` + bubbling dispatch + string
 *      `innerHTML`/`value`). The fake DOM does NOT parse `innerHTML` into
 *      nodes — the same constraint the `mountForm` tests work around — so
 *      where a test needs to click a rendered option it materializes the
 *      `<li>` node by hand (mirroring what the browser would parse).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  activeOption,
  clearSelection,
  closeList,
  commitOption,
  enterTarget,
  filterRefOptions,
  initialRefPickerState,
  moveActive,
  openList,
  REF_PICKER_CLEAR_ATTR,
  REF_PICKER_INPUT_ATTR,
  REF_PICKER_OPTION_INDEX_ATTR,
  REF_PICKER_RESULTS_ATTR,
  REF_PICKER_VALUE_ATTR,
  renderRefPicker,
  renderRefPickerResultRows,
  revertQuery,
  setError,
  setQuery,
  setResults,
  wireRefPicker,
  type RefPickerOption,
  type RefPickerRenderConfig,
  type RefPickerSelection,
} from '../ref-picker/index.js';

const OPTIONS: RefPickerOption[] = [
  { id: 'r-alpha', label: 'Alpha report', sublabel: 'recued-core' },
  { id: 'r-beta', label: 'Beta digest', sublabel: 'acme' },
  { id: 'r-gamma', label: 'Gamma alert' },
];

const CONFIG: RefPickerRenderConfig = { pickerId: 'demo', placeholder: 'Recipe' };

// ════════════════════════════════════════════════════════════════════
// 1. model.ts — pure transitions
// ════════════════════════════════════════════════════════════════════

describe('ref-picker model', () => {
  it('seeds from an initial selection (label shown, id committed)', () => {
    const s = initialRefPickerState({ id: 'r-alpha', label: 'Alpha report' });
    expect(s.query).toBe('Alpha report');
    expect(s.selectedId).toBe('r-alpha');
    expect(s.selectedLabel).toBe('Alpha report');
    expect(s.open).toBe(false);
    expect(s.activeIndex).toBe(-1);
  });

  it('setQuery opens, marks loading, resets highlight, keeps the committed id', () => {
    const seeded = initialRefPickerState({ id: 'r-alpha', label: 'Alpha report' });
    const s = setQuery({ ...seeded, activeIndex: 2 }, 'be');
    expect(s.query).toBe('be');
    expect(s.open).toBe(true);
    expect(s.loading).toBe(true);
    expect(s.activeIndex).toBe(-1);
    // The committed value survives a stray keystroke.
    expect(s.selectedId).toBe('r-alpha');
  });

  it('setResults clears loading and clamps a now-out-of-range highlight', () => {
    const typed = setQuery(initialRefPickerState(), 'x');
    // Highlight the last of 3 options…
    const withActive = moveActive(
      moveActive(moveActive(setResults(typed, OPTIONS), 1), 1),
      1,
    );
    expect(withActive.activeIndex).toBe(2);
    // …then a narrower result set drops the highlight (2 is out of range).
    const reduced = setResults(withActive, [OPTIONS[0]!]);
    expect(reduced.loading).toBe(false);
    expect(reduced.options).toHaveLength(1);
    expect(reduced.activeIndex).toBe(-1);
  });

  it('setError clears options + loading and surfaces the message', () => {
    const s = setError(setResults(setQuery(initialRefPickerState(), 'x'), OPTIONS), 'boom');
    expect(s.error).toBe('boom');
    expect(s.options).toHaveLength(0);
    expect(s.loading).toBe(false);
    expect(s.activeIndex).toBe(-1);
  });

  it('moveActive: opens + highlights first from closed, then clamps', () => {
    const withOpts = setResults(initialRefPickerState(), OPTIONS); // open:false
    const opened = moveActive(withOpts, 1);
    expect(opened.open).toBe(true);
    expect(opened.activeIndex).toBe(0);
    const down = moveActive(moveActive(opened, 1), 1); // 0→1→2
    expect(down.activeIndex).toBe(2);
    const clamped = moveActive(down, 1); // stays at last
    expect(clamped.activeIndex).toBe(2);
    const up = moveActive(clamped, -1);
    expect(up.activeIndex).toBe(1);
  });

  it('moveActive on an empty list only opens (no highlight)', () => {
    const s = moveActive(initialRefPickerState(), 1);
    expect(s.open).toBe(true);
    expect(s.activeIndex).toBe(-1);
  });

  it('commitOption stores the pick and closes; clearSelection empties', () => {
    const open = setResults(setQuery(initialRefPickerState(), 'al'), OPTIONS);
    const picked = commitOption(open, OPTIONS[1]!);
    expect(picked.selectedId).toBe('r-beta');
    expect(picked.selectedLabel).toBe('Beta digest');
    expect(picked.query).toBe('Beta digest');
    expect(picked.open).toBe(false);
    const cleared = clearSelection(picked);
    expect(cleared.selectedId).toBeNull();
    expect(cleared.query).toBe('');
    expect(cleared.options).toHaveLength(0);
  });

  it('revertQuery snaps the input text back to the committed label', () => {
    const picked = commitOption(setResults(initialRefPickerState(), OPTIONS), OPTIONS[0]!);
    const dirtied = setQuery(picked, 'garbage');
    expect(revertQuery(dirtied).query).toBe('Alpha report');
    // No committed selection → reverts to empty.
    expect(revertQuery(setQuery(initialRefPickerState(), 'x')).query).toBe('');
  });

  it('openList / closeList toggle without dropping the query', () => {
    const typed = setQuery(initialRefPickerState(), 'be');
    expect(openList(typed).open).toBe(true);
    const closed = closeList(openList(typed));
    expect(closed.open).toBe(false);
    expect(closed.activeIndex).toBe(-1);
    expect(closed.query).toBe('be');
  });

  it('activeOption / enterTarget: highlight wins, else the top match', () => {
    const open = setResults(setQuery(initialRefPickerState(), 'a'), OPTIONS);
    expect(activeOption(open)).toBeNull();
    // Enter with nothing highlighted commits the first row.
    expect(enterTarget(open)?.id).toBe('r-alpha');
    const highlighted = moveActive(open, 1); // index 0
    expect(activeOption(highlighted)?.id).toBe('r-alpha');
    expect(enterTarget(moveActive(highlighted, 1))?.id).toBe('r-beta');
    expect(enterTarget(initialRefPickerState())).toBeNull();
  });
});

describe('ref-picker default filter', () => {
  it('is case-insensitive and ranks label-prefix > substring > sublabel > id', () => {
    const ranked: RefPickerOption[] = [
      { id: 'a-borealis', label: 'Borealis', sublabel: 'north' }, // 'or' label substring
      { id: 'a-orion', label: 'Orion', sublabel: 'sky' }, // 'or' label prefix
      { id: 'a-zephyr', label: 'Zephyr', sublabel: 'corona' }, // 'or' in sublabel
      { id: 'or-mistral', label: 'Mistral', sublabel: 'wind' }, // 'or' in id only
    ];
    expect(filterRefOptions(ranked, 'OR').map((o) => o.id)).toEqual([
      'a-orion',
      'a-borealis',
      'a-zephyr',
      'or-mistral',
    ]);
  });

  it('matches sublabel and id, and drops non-matches', () => {
    expect(filterRefOptions(OPTIONS, 'acme').map((o) => o.id)).toEqual(['r-beta']);
    expect(filterRefOptions(OPTIONS, 'r-gamma').map((o) => o.id)).toEqual(['r-gamma']);
    expect(filterRefOptions(OPTIONS, 'zzz')).toHaveLength(0);
  });

  it('an empty query returns the head of the list, honouring the limit', () => {
    expect(filterRefOptions(OPTIONS, '')).toHaveLength(3);
    expect(filterRefOptions(OPTIONS, '   ')).toHaveLength(3);
    expect(filterRefOptions(OPTIONS, '', 2)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. render.ts — pure strings
// ════════════════════════════════════════════════════════════════════

describe('ref-picker render', () => {
  it('emits the shell: combobox marker, input value, hidden clear, closed list', () => {
    const html = renderRefPicker(
      setQuery(initialRefPickerState(), 'be'),
      CONFIG,
    );
    expect(html).toContain('data-ref-picker="demo"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain(`${REF_PICKER_INPUT_ATTR}`);
    expect(html).toContain('value="be"');
    expect(html).toContain('placeholder="Recipe"');
    // No committed selection → clear button hidden.
    expect(html).toMatch(/ref-picker-clear[^>]*hidden/);
  });

  it('shows the clear button once a value is committed', () => {
    const html = renderRefPicker(
      commitOption(setResults(initialRefPickerState(), OPTIONS), OPTIONS[0]!),
      CONFIG,
    );
    expect(html).not.toMatch(/ref-picker-clear[^>]*hidden/);
    expect(html).toContain('value="Alpha report"');
  });

  it('emits a hidden form-field mirror carrying the committed id when asked', () => {
    const picked = commitOption(setResults(initialRefPickerState(), OPTIONS), OPTIONS[2]!);
    const html = renderRefPicker(picked, {
      pickerId: 'p1',
      formFieldName: 'related_contact',
    });
    expect(html).toContain('data-form-field="related_contact"');
    expect(html).toContain('data-form-type="ref"');
    expect(html).toContain('value="r-gamma"');
    // Without formFieldName there is no hidden mirror.
    expect(renderRefPicker(picked, { pickerId: 'p1' })).not.toContain(
      'data-form-field',
    );
  });

  it('emits an array-addressed mirror (data-form-array-item/index) for array<ref> items', () => {
    const picked = commitOption(setResults(initialRefPickerState(), OPTIONS), OPTIONS[1]!);
    const html = renderRefPicker(picked, {
      pickerId: 'p2',
      arrayMirror: { field: 'related_contacts', index: 3 },
    });
    // Array-item addressing, NOT data-form-field — the form-renderer's
    // array reader walks data-form-array-item per index.
    expect(html).toContain('data-form-array-item="related_contacts"');
    expect(html).toContain('data-form-array-index="3"');
    expect(html).toContain('data-form-type="ref"');
    expect(html).toContain('data-ref-picker-value');
    expect(html).toContain('value="r-beta"');
    expect(html).not.toContain('data-form-field=');
    // formFieldName wins when both are (mis)configured.
    const both = renderRefPicker(picked, {
      pickerId: 'p3',
      formFieldName: 'single_ref',
      arrayMirror: { field: 'arr', index: 0 },
    });
    expect(both).toContain('data-form-field="single_ref"');
    expect(both).not.toContain('data-form-array-item');
  });

  it('result rows carry index + active markers + the sublabel', () => {
    const open = moveActive(setResults(setQuery(initialRefPickerState(), 'a'), OPTIONS), 1);
    const rows = renderRefPickerResultRows(open, CONFIG);
    expect(rows).toContain(`${REF_PICKER_OPTION_INDEX_ATTR}="0"`);
    expect(rows).toContain('ref-picker-option--active'); // index 0 highlighted
    expect(rows).toContain('Alpha report');
    expect(rows).toContain('recued-core'); // sublabel
  });

  it('surfaces loading / empty / error statuses', () => {
    const loading = { ...setQuery(initialRefPickerState(), 'a'), loading: true };
    expect(renderRefPickerResultRows(loading, CONFIG)).toContain('Searching');
    const empty = setResults(setQuery(initialRefPickerState(), 'zz'), []);
    expect(renderRefPickerResultRows(empty, CONFIG)).toContain('No matches');
    const errored = setError(setQuery(initialRefPickerState(), 'a'), 'offline');
    expect(renderRefPickerResultRows(errored, CONFIG)).toContain('offline');
  });

  it('escapes option labels (XSS defence)', () => {
    const evil = setResults(setQuery(initialRefPickerState(), 'x'), [
      { id: 'x', label: '<img src=x onerror=alert(1)>' },
    ]);
    const rows = renderRefPickerResultRows(evil, CONFIG);
    expect(rows).not.toContain('<img src=x');
    expect(rows).toContain('&lt;img');
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. wire.ts — DOM glue against a fake DOM
// ════════════════════════════════════════════════════════════════════

describe('ref-picker wire', () => {
  // The synchronous inventory the proof consumer (Runs recipe filter) uses:
  // an in-memory list filtered client-side. Resolves immediately.
  const syncSearch = (query: string) =>
    Promise.resolve(filterRefOptions(OPTIONS, query));
  // Run the debounce immediately. The search still resolves on a
  // microtask (it returns a Promise), so result-dependent assertions
  // `await flush()` after dispatching an `input`.
  const syncSchedule = (fn: () => void): (() => void) => {
    fn();
    return () => {};
  };
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('attaches without a value: input empty, clear hidden, list closed', () => {
    const { root, input, results, clear } = buildShell();
    wireRefPicker(asParent(root), { search: syncSearch, config: CONFIG, schedule: syncSchedule });
    expect(input.value).toBe('');
    expect(clear.getAttribute('hidden')).not.toBeNull();
    expect(results.getAttribute('hidden')).not.toBeNull();
  });

  it('typing repaints ONLY the results body and opens the list', async () => {
    const { root, input, results } = buildShell();
    wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      minChars: 1,
      schedule: syncSchedule,
    });
    input.value = 'beta';
    dispatch(input, 'input', {});
    await flush();
    expect(results.getAttribute('hidden')).toBeNull(); // open
    expect(results.innerHTML).toContain('Beta digest');
    expect(results.innerHTML).not.toContain('Alpha report');
    // The input element itself was never re-created → still our node.
    expect(input.value).toBe('beta');
  });

  it('selecting an option (mousedown) commits id, shows the label, fires onChange', async () => {
    const { root, input, results, clear } = buildShell();
    const onChange = vi.fn();
    const handle = wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      schedule: syncSchedule,
    });
    input.value = 'beta';
    dispatch(input, 'input', {});
    await flush();
    // Materialize the rendered option node so we can click it.
    const li = materializeOption(results, 0); // first match = Beta digest
    dispatch(li, 'mousedown', {});
    expect(onChange).toHaveBeenCalledWith({ id: 'r-beta', label: 'Beta digest' });
    expect(input.value).toBe('Beta digest');
    expect(clear.getAttribute('hidden')).toBeNull(); // now visible
    expect(handle.getValue()).toEqual({ id: 'r-beta', label: 'Beta digest' });
    expect(results.getAttribute('hidden')).not.toBeNull(); // closed after pick
  });

  it('keyboard: ArrowDown highlights, Enter commits the highlighted row', async () => {
    const { root, input, results } = buildShell();
    const onChange = vi.fn();
    wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      minChars: 0,
      schedule: syncSchedule,
    });
    input.value = '';
    dispatch(input, 'input', {}); // all options
    await flush();
    dispatch(input, 'keydown', { key: 'ArrowDown' }); // → index 0
    dispatch(input, 'keydown', { key: 'ArrowDown' }); // → index 1
    expect(results.innerHTML).toContain('ref-picker-option--active');
    dispatch(input, 'keydown', { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ id: 'r-beta', label: 'Beta digest' });
    expect(input.value).toBe('Beta digest');
  });

  it('Enter with nothing highlighted commits the top match', async () => {
    const { root, input } = buildShell();
    const onChange = vi.fn();
    wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      schedule: syncSchedule,
    });
    input.value = 'a';
    dispatch(input, 'input', {});
    await flush();
    dispatch(input, 'keydown', { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ id: 'r-alpha', label: 'Alpha report' });
  });

  it('clear button empties the field and fires onChange(null)', () => {
    const { root, input, clear } = buildShell();
    const onChange = vi.fn();
    const handle = wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      initialValue: { id: 'r-alpha', label: 'Alpha report' },
      schedule: syncSchedule,
    });
    expect(input.value).toBe('Alpha report');
    dispatch(clear, 'mousedown', {});
    expect(onChange).toHaveBeenCalledWith(null);
    expect(input.value).toBe('');
    expect(handle.getValue()).toBeNull();
  });

  it('blur reverts the input text to the committed label', () => {
    const { root, input } = buildShell();
    wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      initialValue: { id: 'r-alpha', label: 'Alpha report' },
      schedule: syncSchedule,
    });
    input.value = 'half-typed';
    dispatch(input, 'input', {});
    dispatch(input, 'focusout', {});
    expect(input.value).toBe('Alpha report');
  });

  it('rewire re-attaches to a fresh shell and repaints from JS state', async () => {
    const { root, input, clear } = buildShell();
    const onChange = vi.fn();
    const handle = wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      schedule: syncSchedule,
    });
    input.value = 'gamma';
    dispatch(input, 'input', {});
    await flush();
    const results = root.querySelector(`[${REF_PICKER_RESULTS_ATTR}]`)!;
    dispatch(materializeOption(results, 0), 'mousedown', {}); // pick Gamma
    onChange.mockClear();

    // Simulate a host full re-paint: a brand-new shell subtree under a new
    // root, then rewire. State (the Gamma selection) lives in JS, so the
    // fresh input must show the committed label + the clear must surface.
    const fresh = buildShell();
    handle.rewire(asParent(fresh.root));
    expect(fresh.input.value).toBe('Gamma alert');
    expect(fresh.clear.getAttribute('hidden')).toBeNull();
    // rewire must NOT re-fire onChange.
    expect(onChange).not.toHaveBeenCalled();
    expect(handle.getValue()).toEqual({ id: 'r-gamma', label: 'Gamma alert' });
    // The old shell's clear stayed where it was — proof we detached.
    expect(clear).not.toBe(fresh.clear);
  });

  it('writes the committed id through the hidden form-field mirror on pick + clear', async () => {
    // The form-renderer mirror (`data-ref-picker-value` + `data-form-field`)
    // is what `readFormValues` reads — paint() must keep it in lock-step with
    // the committed id, or a Save reads a stale/empty id (the owner's bug).
    const { root, input, results, mirror } = buildShell('demo', { withMirror: true });
    const handle = wireRefPicker(asParent(root), {
      search: syncSearch,
      config: { pickerId: 'demo', formFieldName: 'assigned_contact' },
      schedule: syncSchedule,
    });
    expect(mirror.value).toBe(''); // empty before any pick
    input.value = 'beta';
    dispatch(input, 'input', {});
    await flush();
    dispatch(materializeOption(results, 0), 'mousedown', {}); // pick Beta digest
    expect(handle.getValue()).toEqual({ id: 'r-beta', label: 'Beta digest' });
    expect(mirror.value).toBe('r-beta'); // ← the fix: id flows through to the mirror
    // setValue (programmatic) also reaches the mirror.
    handle.setValue({ id: 'r-alpha', label: 'Alpha report' });
    expect(mirror.value).toBe('r-alpha');
    // Clearing empties it.
    handle.setValue(null);
    expect(mirror.value).toBe('');
  });

  it('setValue updates programmatically without firing onChange; destroy unbinds', () => {
    const { root, input } = buildShell();
    const onChange = vi.fn();
    const handle = wireRefPicker(asParent(root), {
      search: syncSearch,
      config: CONFIG,
      onChange,
      schedule: syncSchedule,
    });
    handle.setValue({ id: 'r-beta', label: 'Beta digest' });
    expect(input.value).toBe('Beta digest');
    expect(onChange).not.toHaveBeenCalled();
    handle.setValue(null);
    expect(input.value).toBe('');

    handle.destroy();
    input.value = 'after destroy';
    dispatch(input, 'input', {});
    // No listener left → the value the test set is untouched by the picker.
    expect(input.value).toBe('after destroy');
  });

  it('drops a stale async result when a newer query has superseded it', async () => {
    const deferreds: Array<(v: readonly RefPickerOption[]) => void> = [];
    const slowSearch = (_query: string) =>
      new Promise<readonly RefPickerOption[]>((resolve) => {
        deferreds.push(resolve);
      });
    const { root, input, results } = buildShell();
    wireRefPicker(asParent(root), {
      search: slowSearch,
      config: CONFIG,
      minChars: 1,
      schedule: syncSchedule,
    });
    input.value = 'al';
    dispatch(input, 'input', {}); // search #1 (deferred)
    input.value = 'beta';
    dispatch(input, 'input', {}); // search #2 (deferred)

    // Resolve the NEWER one first, then the stale one.
    deferreds[1]!([OPTIONS[1]!]); // 'beta' → Beta digest
    deferreds[0]!([OPTIONS[0]!]); // stale 'al' → Alpha report
    await Promise.resolve();
    await Promise.resolve();
    expect(results.innerHTML).toContain('Beta digest');
    expect(results.innerHTML).not.toContain('Alpha report');
  });

  it('invalidates an already-fired search the moment a newer query is accepted', async () => {
    // The newer query is still inside its debounce window (its `fire` has
    // not run) when the older, already-issued request resolves — the gap
    // a fire-time-only seq bump would miss.
    const deferreds: Array<(v: readonly RefPickerOption[]) => void> = [];
    const slowSearch = (_query: string) =>
      new Promise<readonly RefPickerOption[]>((resolve) => {
        deferreds.push(resolve);
      });
    const scheduled: Array<() => void> = [];
    const captureSchedule = (fn: () => void): (() => void) => {
      scheduled.push(fn);
      return () => {};
    };
    const { root, input, results } = buildShell();
    wireRefPicker(asParent(root), {
      search: slowSearch,
      config: CONFIG,
      minChars: 1,
      schedule: captureSchedule,
    });
    input.value = 'al';
    dispatch(input, 'input', {});
    scheduled[0]!(); // FIRE search #1 ('al') — now in flight
    input.value = 'beta';
    dispatch(input, 'input', {}); // accept the newer query (fire #2 only scheduled)
    deferreds[0]!([OPTIONS[0]!]); // resolve the STALE 'al' request
    await flush();
    expect(results.innerHTML).not.toContain('Alpha report'); // dropped
    scheduled[1]!(); // fire #2 ('beta')
    deferreds[1]!([OPTIONS[1]!]);
    await flush();
    expect(results.innerHTML).toContain('Beta digest');
  });
});

// ════════════════════════════════════════════════════════════════════
// Fake DOM — attribute-selector querySelector + bubbling dispatch.
// Mirrors the form-renderer mount harness, trimmed to what wire needs.
// ════════════════════════════════════════════════════════════════════

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

/** The picker API takes a real `ParentNode`; our fake structurally
 *  satisfies the `querySelector` it actually uses, so cast at the
 *  boundary (keeping `FakeNode` typing for the fake-DOM method calls). */
const asParent = (node: FakeNode): ParentNode =>
  node as unknown as ParentNode;

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
    setAttribute: (name, value) => {
      node.attrs.set(name, value);
    },
    removeAttribute: (name) => {
      node.attrs.delete(name);
    },
    querySelector: (selector) => querySelector(node, selector),
    addEventListener: (type, fn) => {
      const list = node.listeners.get(type) ?? [];
      list.push(fn);
      node.listeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = node.listeners.get(type);
      if (list === undefined) return;
      node.listeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
    appendChild: (child) => {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    focus: () => {
      node.focusCount += 1;
    },
    get parentElement() {
      return node.parent;
    },
  };
  return node;
};

const SELECTOR = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/;

const matches = (node: FakeNode, selector: string): boolean => {
  const m = SELECTOR.exec(selector);
  if (m === null) return false;
  const [, name, value] = m;
  const have = node.attrs.get(name!);
  if (have === undefined) return false;
  return value === undefined ? true : have === value;
};

const querySelector = (root: FakeNode, selector: string): FakeNode | null => {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = querySelector(child, selector);
    if (nested !== null) return nested;
  }
  return null;
};

/** Dispatch `type` at `target` and bubble up the parent chain, invoking
 *  every listener with one event whose `.target` stays the origin. */
const dispatch = (
  target: FakeNode,
  type: string,
  props: { key?: string },
): void => {
  const event = {
    target,
    key: props.key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  let node: FakeNode | null = target;
  while (node !== null) {
    for (const fn of node.listeners.get(type) ?? []) fn(event);
    node = node.parent;
  }
};

/** Build a resting shell subtree matching `renderRefPicker`'s structure
 *  (the fake DOM can't parse `innerHTML`, so we hand-build the nodes wire
 *  queries: shell → field → [input, clear] + results). */
const buildShell = (
  pickerId = 'demo',
  opts: { withMirror?: boolean } = {},
): {
  root: FakeNode;
  shell: FakeNode;
  input: FakeNode;
  clear: FakeNode;
  results: FakeNode;
  mirror: FakeNode;
} => {
  const root = makeNode('div');
  const shell = makeNode('div', { 'data-ref-picker': pickerId });
  // The hidden form-field mirror sits first inside the shell (mirrors
  // `renderRefPicker`'s structure), present only when the picker backs a
  // form-renderer `ref` field.
  const mirror = makeNode('input', {
    [REF_PICKER_VALUE_ATTR]: '',
    'data-form-field': 'assigned_contact',
    'data-form-type': 'ref',
  });
  const field = makeNode('div');
  const input = makeNode('input', { [REF_PICKER_INPUT_ATTR]: '' });
  const clear = makeNode('button', { [REF_PICKER_CLEAR_ATTR]: '', hidden: '' });
  const results = makeNode('ul', { [REF_PICKER_RESULTS_ATTR]: '', hidden: '' });
  if (opts.withMirror === true) shell.appendChild(mirror);
  field.appendChild(input);
  field.appendChild(clear);
  shell.appendChild(field);
  shell.appendChild(results);
  root.appendChild(shell);
  return { root, shell, input, clear, results, mirror };
};

/** Materialize a rendered option `<li>` as a real fake node under the
 *  results list so a test can dispatch on it (wire sets the results
 *  `innerHTML` to a string the fake DOM won't parse into nodes). */
const materializeOption = (results: FakeNode, index: number): FakeNode => {
  const li = makeNode('li', { [REF_PICKER_OPTION_INDEX_ATTR]: String(index) });
  results.appendChild(li);
  return li;
};
