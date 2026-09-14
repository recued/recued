/** Shell-frame Step 4c — the [▶ Run a recipe] command-palette (§D.L1).
 *
 *  Pins:
 *   - the pure model: recipe classification (manual / autorun /
 *     managed-reactive) + the auto-run arm-state + toggle decision;
 *   - the wire: selecting a manual recipe offers Run/Schedule and opens the
 *     shared Run modal on the chosen tab; selecting an auto-run recipe shows
 *     the state-aware toggle and drives `auto_run.update`; a pure
 *     event-trigger recipe offers the Automation deep-link; Close / Escape /
 *     backdrop + dispose tear the palette down.
 *
 *  No jsdom — the ref-picker mounts INERT against the string-rendered fake
 *  host (it bails when its shell isn't found), so selection is driven through
 *  the imperative `selectRecipe` seam.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  AutoRunStatusEntry,
  RecipeDefinition,
  ServerExecuteResponse,
  ServerRecipeListEntry,
} from '@recued/contracts';

import {
  autoRunStateOf,
  autoRunToggle,
  classifyRecipeAction,
  wireRunPalette,
  RUN_PALETTE_ACTION_ATTR,
  RUN_PALETTE_CLOSE_ATTR,
  RUN_PALETTE_OVERLAY_ATTR,
  RUN_PALETTE_RETRY_ATTR,
  RUN_PALETTE_RESULT_ATTR,
  RUN_PALETTE_SEARCH_ATTR,
} from '../chat/run-palette.js';

// ── fake DOM ──────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  innerHTML: string;
  type: string;
  disabled: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  contains(el: FakeEl | null): boolean;
  focus(): void;
  click(): void;
}

const attrOnly = (sel: string): string | null => sel.match(/^\[([\w-]+)\]$/)?.[1] ?? null;

const makeEl = (tag: string, onFocus: (el: FakeEl) => void): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    type: '',
    disabled: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute: (k, v) => el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    removeAttribute: (k) => el.attrs.delete(k),
    appendChild: (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild: (c) => {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove: () => {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener: (t, fn) => {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    removeEventListener: (t, fn) => {
      const list = el.listeners.get(t);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    // Only `[attr]` selectors are supported; an `[attr="v"]` selector (the
    // ref-picker's shell lookup) returns null → the ref-picker bails inert.
    querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const attr = attrOnly(sel);
      if (attr === null) return [];
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          if (c.attrs.has(attr)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    contains: (candidate) => {
      let current = candidate;
      while (current !== null) {
        if (current === el) return true;
        current = current.parent;
      }
      return false;
    },
    focus: () => {
      if (!el.disabled) onFocus(el);
    },
    click: () => {
      if (el.disabled) return;
      for (const fn of [...(el.listeners.get('click') ?? [])]) fn({ target: el });
    },
  };
  return el;
};

interface FakeDoc {
  body: FakeEl;
  readonly activeElement: FakeEl | null;
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  styles: FakeEl[];
  createElement(tag: string): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  fireKeydown(key: string, isComposing?: boolean): void;
}

const makeDoc = (): FakeDoc => {
  const styles: FakeEl[] = [];
  const keydown: Array<(ev: unknown) => void> = [];
  let activeElement: FakeEl | null = null;
  const createElement = (tag: string): FakeEl => makeEl(tag, (el) => {
    activeElement = el;
  });
  return {
    body: createElement('body'),
    get activeElement() {
      return activeElement;
    },
    styles,
    head: {
      querySelector(sel) {
        const attr = sel.match(/^style\[([\w-]+)\]$/)?.[1];
        if (attr === undefined) return null;
        return styles.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styles.push(el);
        return el;
      },
    },
    createElement,
    addEventListener: (t, fn) => {
      if (t === 'keydown') keydown.push(fn);
    },
    removeEventListener: (t, fn) => {
      if (t !== 'keydown') return;
      const i = keydown.indexOf(fn);
      if (i >= 0) keydown.splice(i, 1);
    },
    fireKeydown(key, isComposing = false) {
      for (const fn of [...keydown]) fn({ key, isComposing });
    },
  };
};

const collectByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    if (n.attrs.has(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(allText)].join(' ');

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── fixtures ──────────────────────────────────────────────────────

const recipeEntry = (
  recipe_id: string,
  name: string,
  defOverrides: Partial<RecipeDefinition> = {},
): ServerRecipeListEntry => ({
  recipe_id,
  publisher_id: 'recued-core',
  version: 1,
  recipe_hash: `hash-${recipe_id}`,
  recipe: {
    recipe_id,
    version: 1,
    ttl: 0,
    metadata: {
      name,
      description: '',
      author: 'recued-core',
      supported_platforms: [],
      tags: [],
    },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
    requires: [],
    ...defOverrides,
  },
  source: 'pair-sync',
  installed_at: 1_700_000_000_000,
});

const MANUAL = recipeEntry('manual-1', 'Daily brief');
const AUTORUN = recipeEntry('autorun-1', 'Watch pipeline', {
  auto_run: { interval_ms: 60_000 },
} as unknown as Partial<RecipeDefinition>);
const TRIGGERED = recipeEntry('trigger-1', 'On new mail', {
  event_triggers: [{ pattern: 'data.mail.**.created' }],
} as unknown as Partial<RecipeDefinition>);

const executeResponse = (): ServerExecuteResponse => ({
  recipe_id: 'manual-1',
  recipe_hash: 'hash-manual-1',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 5,
});

const autoRunEntry = (
  recipe_id: string,
  over: Partial<AutoRunStatusEntry> = {},
): AutoRunStatusEntry => ({
  recipe_id,
  publisher_id: 'recued-core',
  recipe_name: null,
  interval_ms: 60_000,
  dynamic: false,
  enabled: true,
  auto_disabled: false,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: null,
  next_run_at: null,
  last_started_at: null,
  last_finished_at: null,
  config_overlay: {},
  variables: {},
  ...over,
});

// ── pure model ────────────────────────────────────────────────────

describe('run-palette model', () => {
  it('classifyRecipeAction: manual / autorun / managed-reactive', () => {
    expect(classifyRecipeAction({})).toBe('manual');
    expect(classifyRecipeAction({ auto_run: { interval_ms: 1 } })).toBe('autorun');
    expect(classifyRecipeAction({ event_triggers: [{}] })).toBe('managed-reactive');
    expect(classifyRecipeAction({ trigger_steps: [{}] })).toBe('managed-reactive');
    // auto_run wins over a coincident trigger list.
    expect(classifyRecipeAction({ auto_run: {}, event_triggers: [{}] })).toBe('autorun');
    expect(classifyRecipeAction({ event_triggers: [] })).toBe('manual');
  });

  it('autoRunStateOf maps the entry to an arm state', () => {
    expect(autoRunStateOf(undefined)).toBe('off');
    expect(autoRunStateOf(autoRunEntry('x'))).toBe('armed');
    expect(autoRunStateOf(autoRunEntry('x', { enabled: false }))).toBe('paused');
    expect(autoRunStateOf(autoRunEntry('x', { auto_disabled: true }))).toBe('tripped');
  });

  it('autoRunToggle picks the right label + next enabled', () => {
    expect(autoRunToggle('armed')).toEqual({ label: 'Pause', nextEnabled: false });
    expect(autoRunToggle('tripped')).toEqual({ label: 'Re-arm', nextEnabled: true });
    expect(autoRunToggle('paused')).toEqual({ label: 'Arm', nextEnabled: true });
    expect(autoRunToggle('off')).toEqual({ label: 'Arm', nextEnabled: true });
  });
});

// ── wire ──────────────────────────────────────────────────────────

const mount = (
  over: Partial<Parameters<typeof wireRunPalette>[0]> = {},
) => {
  const doc = makeDoc();
  const recipeList = vi.fn(async () => ({
    recipes: [MANUAL, AUTORUN, TRIGGERED],
  }));
  const handle = wireRunPalette({
    document: doc as unknown as Document,
    recipeList,
    automationHref: (id) => `#automation/${id}`,
    ...over,
  });
  doc.body.appendChild(handle.element as unknown as FakeEl);
  return { doc, handle, recipeList };
};

describe('run-palette wire', () => {
  it('injects contained mobile chrome with usable picker and action targets', () => {
    const { doc, handle } = mount();
    const styles = doc.styles[0]?.textContent ?? '';
    expect(styles).toContain(
      `[${RUN_PALETTE_OVERLAY_ATTR}] .run-palette-panel {\n  box-sizing: border-box;`,
    );
    expect(styles).toContain(
      `[${RUN_PALETTE_CLOSE_ATTR}] {\n  margin-left: auto;\n  appearance: none;\n  min-height: 36px;`,
    );
    expect(styles).toContain(
      `[${RUN_PALETTE_ACTION_ATTR}] {\n  appearance: none;\n  min-width: 36px;\n  min-height: 36px;`,
    );
    expect(styles).toContain(
      `[${RUN_PALETTE_OVERLAY_ATTR}] .ref-picker-input {\n  min-height: 36px;`,
    );
    expect(styles).toContain(
      `[${RUN_PALETTE_OVERLAY_ATTR}] .ref-picker-clear {\n  right: 0;\n  width: 36px;\n  height: 36px;`,
    );
    handle.destroy();
  });

  it('selecting a manual recipe offers Run + Schedule and opens the Run modal', async () => {
    const execute = vi.fn(async () => executeResponse());
    const { doc, handle } = mount({ execute });
    await tick();
    handle.selectRecipe('manual-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const actions = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR);
    const labels = actions.map((a) => a.textContent);
    expect(labels).toContain('Run');
    expect(labels).toContain('Schedule');

    actions.find((a) => a.textContent === 'Run')!.click();
    // The shared Run modal mounts (its own root carries this class).
    const runModalRoots = doc.body.children.filter(
      (c) => c.className === 'run-modal-overlay-root',
    );
    expect(runModalRoots).toHaveLength(1);
    expect(runModalRoots[0]!.innerHTML).toContain('Daily brief');
    handle.destroy();
  });

  it('selecting an armed auto-run recipe offers Pause and drives auto_run.update', async () => {
    const autoRunUpdate = vi.fn(async () => ({}));
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      autoRunUpdate,
    });
    await tick();
    handle.selectRecipe('autorun-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const toggle = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    expect(toggle.textContent).toBe('Pause'); // armed → Pause
    toggle.click();
    await tick();
    expect(autoRunUpdate).toHaveBeenCalledWith({
      recipe_id: 'autorun-1',
      enabled: false,
    });
    handle.destroy();
  });

  it('guards duplicate auto-run updates while the first mutation is pending', async () => {
    let resolveUpdate!: () => void;
    const updatePending = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    const autoRunUpdate = vi.fn(async () => updatePending);
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      autoRunUpdate,
    });
    await tick();
    handle.selectRecipe('autorun-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const toggle = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    expect(handle.hasInFlightWork()).toBe(false);
    toggle.focus();
    toggle.click();
    toggle.click();

    expect(autoRunUpdate).toHaveBeenCalledTimes(1);
    expect(handle.hasInFlightWork()).toBe(true);
    expect(
      collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.disabled,
    ).toBe(true);
    const close = collectByAttr(overlay, RUN_PALETTE_CLOSE_ATTR)[0]!;
    expect(close.getAttribute('aria-disabled')).toBe('true');
    expect(close.disabled).toBe(false);
    doc.fireKeydown('Escape');
    close.click();
    overlay.click();
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(1);
    resolveUpdate();
    await tick();
    expect(handle.hasInFlightWork()).toBe(false);
    const restored = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    expect(restored).not.toBe(toggle);
    expect(doc.activeElement).toBe(restored);
    expect(close.getAttribute('aria-disabled')).toBeNull();
    handle.destroy();
  });

  it('does not reclaim auto-run focus after the user moves within the palette', async () => {
    let resolveUpdate!: () => void;
    const updatePending = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      autoRunUpdate: vi.fn(async () => updatePending),
    });
    await tick();
    handle.selectRecipe('autorun-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const toggle = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    toggle.focus();
    toggle.click();
    const close = collectByAttr(overlay, RUN_PALETTE_CLOSE_ATTR)[0]!;
    close.focus();

    resolveUpdate();
    await tick();
    expect(doc.activeElement).toBe(close);
    handle.destroy();
  });

  it('keeps a pending auto-run write owned through the Automation link', async () => {
    let resolveUpdate!: () => void;
    const updatePending = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      autoRunUpdate: vi.fn(async () => updatePending),
    });
    await tick();
    handle.selectRecipe('autorun-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.click();
    expect(handle.hasInFlightWork()).toBe(true);
    handle.selectRecipe('trigger-1');
    collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.click();

    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(1);
    expect(handle.hasInFlightWork()).toBe(true);
    resolveUpdate();
    await tick();

    expect(handle.hasInFlightWork()).toBe(false);
    collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.click();
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('reports an auto-run update failure without dismissing the action', async () => {
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      autoRunUpdate: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await tick();
    handle.selectRecipe('autorun-1');

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const toggle = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    toggle.focus();
    toggle.click();
    await tick();

    const result = collectByAttr(overlay, RUN_PALETTE_RESULT_ATTR)[0]!;
    expect(result.getAttribute('role')).toBe('status');
    expect(result.textContent).toContain('Recued could not change that');
    expect(doc.activeElement).toBe(
      collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0],
    );
    handle.destroy();
  });

  it('a tripped auto-run recipe offers Re-arm', async () => {
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({
        entries: [autoRunEntry('autorun-1', { auto_disabled: true })],
      })),
      autoRunUpdate: vi.fn(async () => ({})),
    });
    await tick();
    handle.selectRecipe('autorun-1');
    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.textContent).toBe('Re-arm');
    handle.destroy();
  });

  it('a pure event-trigger recipe offers the Automation deep-link', async () => {
    const { doc, handle } = mount();
    await tick();
    handle.selectRecipe('trigger-1');
    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const link = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!;
    expect(link.textContent).toContain('Automation');
    // Deep-links to THIS recipe's rules (recipes-route parity).
    expect(link.getAttribute('href')).toBe('#automation/trigger-1');
    handle.destroy();
  });

  it('the auto-run toggle is disabled when no update caller is wired', async () => {
    const { doc, handle } = mount({
      autoRunList: vi.fn(async () => ({ entries: [autoRunEntry('autorun-1')] })),
      // no autoRunUpdate
    });
    await tick();
    handle.selectRecipe('autorun-1');
    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR)[0]!.disabled).toBe(true);
    handle.destroy();
  });

  it('Close / Escape / dispose tear the palette down (and fire onClose once)', async () => {
    const onClose = vi.fn();
    const { doc, handle } = mount({ onClose });
    await tick();
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(1);
    collectByAttr(doc.body, RUN_PALETTE_CLOSE_ATTR)[0]!.click();
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.destroy(); // idempotent
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the palette', async () => {
    const { doc, handle } = mount();
    await tick();
    doc.fireKeydown('Escape');
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(0);
    handle.destroy();
  });

  it('leaves a composing Escape to the active IME', async () => {
    const { doc, handle } = mount();
    await tick();
    doc.fireKeydown('Escape', true);
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(1);

    doc.fireKeydown('Escape');
    expect(collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)).toHaveLength(0);
    handle.destroy();
  });

  it('shows a hint before any recipe is selected', async () => {
    const { doc, handle } = mount();
    await tick();
    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(allText(overlay)).toContain('Find a Recipe');
    handle.destroy();
  });

  it('turns an empty recipe inventory into a starter-pack recovery path', async () => {
    const { doc, handle } = mount({
      recipeList: vi.fn(async () => ({ recipes: [] })),
      packsHref: '#packs',
    });
    await tick();

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(allText(overlay)).toContain('You have no Recipes yet.');
    expect(collectByAttr(overlay, RUN_PALETTE_SEARCH_ATTR)[0]!.innerHTML).toBe('');
    const browse = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR).find(
      (action) => action.getAttribute('href') === '#packs',
    );
    expect(browse?.textContent).toContain('Look through starter Packs');
    handle.destroy();
  });

  it('offers an in-place retry after the recipe inventory fails to load', async () => {
    const recipeList = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ recipes: [MANUAL] });
    const { doc, handle } = mount({ recipeList });
    await tick();

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(allText(overlay)).toContain('Recued could not load your Recipes.');
    const retry = collectByAttr(overlay, RUN_PALETTE_ACTION_ATTR).find(
      (action) => action.textContent === 'Try again',
    )!;
    retry.click();
    await tick();

    expect(recipeList).toHaveBeenCalledTimes(2);
    expect(allText(overlay)).toContain('Find a Recipe');
    expect(collectByAttr(overlay, RUN_PALETTE_SEARCH_ATTR)[0]!.innerHTML)
      .toContain('data-ref-picker');
    handle.destroy();
  });

  it('keeps the inventory retry visible and single-flight while it settles', async () => {
    let resolveRetry!: (value: { recipes: ServerRecipeListEntry[] }) => void;
    const retryPending = new Promise<{ recipes: ServerRecipeListEntry[] }>(
      (resolve) => { resolveRetry = resolve; },
    );
    const recipeList = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => retryPending);
    const { doc, handle } = mount({ recipeList });
    await tick();

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    expect(collectByAttr(overlay, 'role').some(
      (element) => element.getAttribute('role') === 'alert',
    )).toBe(true);
    const retry = collectByAttr(overlay, RUN_PALETTE_RETRY_ATTR)[0]!;
    retry.focus();
    retry.click();
    retry.click();

    expect(recipeList).toHaveBeenCalledTimes(2);
    const retrying = collectByAttr(overlay, RUN_PALETTE_RETRY_ATTR)[0]!;
    expect(retrying).toBeDefined();
    expect(retrying.textContent).toBe('Trying again…');
    expect(retrying.getAttribute('aria-disabled')).toBe('true');
    expect(retrying.getAttribute('aria-busy')).toBe('true');
    expect(retrying.disabled).toBe(false);
    expect(doc.activeElement).toBe(retrying);

    resolveRetry({ recipes: [MANUAL] });
    await tick();
    expect(recipeList).toHaveBeenCalledTimes(2);
    expect(collectByAttr(overlay, RUN_PALETTE_SEARCH_ATTR)[0]!.innerHTML)
      .toContain('data-ref-picker');
    handle.destroy();
  });

  it('returns a rejected inventory retry to its alert action', async () => {
    const recipeList = vi.fn(async () => { throw new Error('offline'); });
    const { doc, handle } = mount({ recipeList });
    await tick();

    const overlay = collectByAttr(doc.body, RUN_PALETTE_OVERLAY_ATTR)[0]!;
    const retry = collectByAttr(overlay, RUN_PALETTE_RETRY_ATTR)[0]!;
    retry.focus();
    retry.click();
    await tick();

    const restored = collectByAttr(overlay, RUN_PALETTE_RETRY_ATTR)[0]!;
    expect(recipeList).toHaveBeenCalledTimes(2);
    expect(restored.textContent).toBe('Try again');
    expect(restored.getAttribute('aria-disabled')).toBeNull();
    expect(doc.activeElement).toBe(restored);
    expect(collectByAttr(overlay, 'role').some(
      (element) => element.getAttribute('role') === 'alert',
    )).toBe(true);
    handle.destroy();
  });
});
