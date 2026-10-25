import { describe, expect, it, vi } from 'vitest';

import {
  mountPermissionsPanel,
  PERMISSIONS_CREATE_ACTOR_ATTR,
  PERMISSIONS_CREATE_APPROVAL_ATTR,
  PERMISSIONS_CREATE_DENIED_ATTR,
  PERMISSIONS_CREATE_ERROR_ATTR,
  PERMISSIONS_CREATE_FORM_ATTR,
  PERMISSIONS_CREATE_INGREDIENT_ATTR,
  PERMISSIONS_CREATE_MAXRISK_ATTR,
  PERMISSIONS_CREATE_OPERATION_ATTR,
  PERMISSIONS_CREATE_SAVE_ATTR,
  PERMISSIONS_DELETE_BUTTON_ATTR,
  PERMISSIONS_DELETE_CANCEL_ATTR,
  PERMISSIONS_DELETE_CONFIRM_ATTR,
  PERMISSIONS_OVERRIDE_CARD_ATTR,
  PERMISSIONS_OVERRIDE_ROW_ATTR,
  PERMISSIONS_PANEL_EMPTY_ATTR,
  PERMISSIONS_PANEL_ERROR_ATTR,
  PERMISSIONS_PANEL_HOST_ATTR,
  PERMISSIONS_PANEL_LOADING_ATTR,
  PERMISSIONS_ROW_ERROR_ATTR,
  type PermissionsDeleteOverrideCaller,
  type PermissionsListCatalogOperationsCaller,
  type PermissionsListOverridesCaller,
  type PermissionsUpsertOverrideCaller,
} from '../settings/permissions-panel.js';
import type {
  Actor,
  CatalogIngredientView,
  OverridePolicyInput,
  OverrideView,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Interactive fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  focus(): void;
  click(): void;
  remove(): void;
}

interface FakeDocument {
  createElement(tag: string): FakeEl;
  activeElement: FakeEl | null;
  head: {
    appendChild(el: FakeEl): FakeEl;
    querySelector(selector: string): FakeEl | null;
  };
  styleTags: FakeEl[];
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    hidden: false,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      el.children.push(c);
      c.parent = el;
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    focus() {
      // Contract detail now moves focus to its asynchronous heading. These
      // tests only need the browser method to exist; focus ownership is pinned
      // by the route-specific accessibility suite.
    },
    click() {
      // A disabled button fires no click. The panel sets disabled by
      // attribute, so checking the attr keeps the fake honest.
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeEl[] = [];
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    createElement: makeFakeElement,
    activeElement: null,
    head: {
      appendChild(el) {
        styleTags.push(el);
        return el;
      },
      querySelector(selector) {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ════════════════════════════════════════════════════════════════
// Fixtures + mount helper
// ════════════════════════════════════════════════════════════════

const DEALS = 'hubspot.deals';
const CONTACTS = 'hubspot.contacts';
const DEALS_WRITE = `${DEALS}.write`;
const DEALS_READ = `${DEALS}.read`;
const CONTACTS_WRITE = `${CONTACTS}.write`;

const catalogFixture = (): CatalogIngredientView[] => [
  {
    ingredient_id: DEALS,
    name: 'HubSpot Deals',
    operations: [
      { operation_id: DEALS_READ, operation_key: 'read', risk_tier: 'read', groups: ['crm'] },
      { operation_id: DEALS_WRITE, operation_key: 'write', risk_tier: 'write', groups: ['crm'] },
    ],
  },
  {
    ingredient_id: CONTACTS,
    name: 'HubSpot Contacts',
    operations: [
      { operation_id: CONTACTS_WRITE, operation_key: 'write', risk_tier: 'write', groups: ['crm'] },
    ],
  },
];

const overrideView = (
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
  policy: OverridePolicyInput = { approval: 'ask' },
  over: Partial<OverrideView> = {},
): OverrideView => ({
  actor,
  ingredient_id: ingredientId,
  operation_id: operationId,
  policy,
  written_at: 1,
  ...over,
});

interface MountForOptions {
  overrides?: ReadonlyArray<OverrideView>;
  catalog?: CatalogIngredientView[];
  withCreate?: boolean;
  runListOverrides?: PermissionsListOverridesCaller;
  runDeleteOverride?: PermissionsDeleteOverrideCaller;
  runUpsertOverride?: PermissionsUpsertOverrideCaller;
  runListCatalogOperations?: PermissionsListCatalogOperationsCaller;
}

const mountFor = (opts: MountForOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');

  const runListOverrides = vi.fn<PermissionsListOverridesCaller>();
  runListOverrides.mockImplementation(
    opts.runListOverrides
      ?? (async () => ({ overrides: opts.overrides ?? [] })),
  );

  const runDeleteOverride = vi.fn<PermissionsDeleteOverrideCaller>();
  runDeleteOverride.mockImplementation(
    opts.runDeleteOverride
      ?? (async () => ({ deleted: true })),
  );

  const runUpsertOverride = vi.fn<PermissionsUpsertOverrideCaller>();
  runUpsertOverride.mockImplementation(
    opts.runUpsertOverride
      ?? (async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy)),
  );

  const runListCatalogOperations = vi.fn<PermissionsListCatalogOperationsCaller>();
  runListCatalogOperations.mockImplementation(
    opts.runListCatalogOperations
      ?? (async () => ({ ingredients: opts.catalog ?? [] })),
  );

  const includeUpsert =
    opts.withCreate === true || opts.runUpsertOverride !== undefined;
  const includeCatalog =
    opts.withCreate === true
    || opts.catalog !== undefined
    || opts.runListCatalogOperations !== undefined;

  const mount = mountPermissionsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runListOverrides,
    runDeleteOverride,
    ...(includeUpsert ? { runUpsertOverride } : {}),
    ...(includeCatalog ? { runListCatalogOperations } : {}),
  });

  return {
    doc,
    host,
    mount,
    calls: {
      runListOverrides,
      runDeleteOverride,
      runUpsertOverride,
      runListCatalogOperations,
    },
  };
};

const findByAttrValue = (
  root: FakeEl,
  attr: string,
  value: string,
): FakeEl | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit !== null) return hit;
  }
  return null;
};

const onlyByAttr = (root: FakeEl, attr: string): FakeEl => {
  const matches = collectByAttr(root, attr);
  if (matches.length !== 1) {
    throw new Error(`expected one ${attr}, found ${matches.length}`);
  }
  return matches[0]!;
};

const selectOptions = (
  root: FakeEl,
  attr: string,
): Array<{ value: string; label: string }> =>
  onlyByAttr(root, attr).children.map((c) => ({
    value: c.getAttribute('value') ?? '',
    label: c.textContent,
  }));

const selectedOptionValue = (root: FakeEl, attr: string): string | null => {
  const selected = onlyByAttr(root, attr).children.find((c) =>
    c.hasAttribute('selected'),
  );
  return selected?.getAttribute('value') ?? null;
};

const cardFor = (root: FakeEl, ingredientId: string): FakeEl => {
  const card = collectByAttr(root, PERMISSIONS_OVERRIDE_CARD_ATTR).find(
    (c) => c.getAttribute('data-ingredient-id') === ingredientId,
  );
  if (card === undefined) throw new Error(`missing card ${ingredientId}`);
  return card;
};

const rowFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_OVERRIDE_ROW_ATTR).find(
    (r) =>
      r.getAttribute('data-actor') === actor
      && r.getAttribute('data-ingredient-id') === ingredientId
      && r.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const deleteButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_BUTTON_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const confirmButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_CONFIRM_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const cancelButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_CANCEL_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-166 Permissions override inventory panel', () => {
  it('renders loading, then groups one card per ingredient', async () => {
    const list = deferred<{ overrides: OverrideView[] }>();
    const dealsWide = overrideView('user_self', DEALS, null);
    const dealsWrite = overrideView('system', DEALS, DEALS_WRITE);
    const contactsWrite = overrideView('contracted_user', CONTACTS, CONTACTS_WRITE);
    const { host, mount, calls } = mountFor({
      runListOverrides: () => list.promise,
    });

    expect(mount.getState()).toBe('loading');
    expect(collectByAttr(host, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_LOADING_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('Loading permissions');

    list.resolve({ overrides: [contactsWrite, dealsWide, dealsWrite] });
    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getOverrides()).toHaveLength(3);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(2);
    expect(cardFor(host, DEALS).getAttribute('data-ingredient-id')).toBe(DEALS);
    expect(cardFor(host, CONTACTS).getAttribute('data-ingredient-id')).toBe(CONTACTS);
    expect(collectByAttr(cardFor(host, DEALS), PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(2);
    expect(collectByAttr(cardFor(host, CONTACTS), PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('renders only present policy facets', async () => {
    const fullPolicy = overrideView('user_self', DEALS, DEALS_WRITE, {
      denied: true,
      approval: 'always',
      max_risk_without_approval: 'write',
      timeout_ms: 2500,
      cache_ttl_ms: 15000,
    });
    const sparsePolicy = overrideView('system', CONTACTS, CONTACTS_WRITE, {
      denied: true,
    });
    const { host, mount } = mountFor({
      overrides: [fullPolicy, sparsePolicy],
    });

    await mount.whenLoaded();

    const fullText = allText(rowFor(host, 'user_self', DEALS, DEALS_WRITE)!).join(' ');
    expect(fullText).toContain('denied');
    expect(fullText).toContain('approval: always');
    expect(fullText).toContain('how risky it may get before asking you: write');
    expect(fullText).toContain('timeout: 2500 ms');
    expect(fullText).toContain('cache TTL: 15000 ms');

    const sparseText = allText(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)!).join(' ');
    expect(sparseText).toContain('denied');
    expect(sparseText).not.toContain('approval:');
    expect(sparseText).not.toContain('max risk without approval:');
    expect(sparseText).not.toContain('timeout:');
    expect(sparseText).not.toContain('cache TTL:');
    mount.dispose();
  });

  it('renders ingredient-wide and operation-specific labels', async () => {
    const wide = overrideView('user_self', DEALS, null);
    const specific = overrideView('system', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      overrides: [specific, wide],
    });

    await mount.whenLoaded();

    const wideRow = rowFor(host, 'user_self', DEALS, null)!;
    const specificRow = rowFor(host, 'system', DEALS, DEALS_WRITE)!;
    expect(wideRow.getAttribute('data-operation-id')).toBe('');
    expect(specificRow.getAttribute('data-operation-id')).toBe(DEALS_WRITE);
    expect(allText(wideRow).join(' ')).toContain('All operations');
    expect(allText(specificRow).join(' ')).toContain('write');
    expect(allText(specificRow).join(' ')).not.toContain(DEALS_WRITE);
    mount.dispose();
  });

  it('renders the empty state when listOverrides returns no rows', async () => {
    const { host, mount, calls } = mountFor({
      overrides: [],
    });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getOverrides()).toHaveLength(0);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_EMPTY_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(0);
    expect(allText(host).join(' ')).toContain('No rules yet');
    mount.dispose();
  });

  it('requires a two-stage delete and re-lists after confirm', async () => {
    const deleted = overrideView('user_self', DEALS, null);
    const remaining = overrideView('system', DEALS, DEALS_WRITE);
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [deleted, remaining] : [remaining] };
      },
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, null)!.click();

    expect(confirmButtonFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, null)).toBeUndefined();
    expect(calls.runDeleteOverride).not.toHaveBeenCalled();

    confirmButtonFor(host, 'user_self', DEALS, null)!.click();
    await tick();

    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(calls.runDeleteOverride.mock.calls[0]![0]).toEqual({
      actor: 'user_self',
      ingredient_id: DEALS,
    });
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(rowFor(host, 'user_self', DEALS, null)).toBeUndefined();
    expect(rowFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(mount.getOverrides()).toEqual([remaining]);
    mount.dispose();
  });

  it('cancel disarms delete without calling the rpc', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount, calls } = mountFor({
      overrides: [row],
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!.click();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    cancelButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!.click();

    expect(calls.runDeleteOverride).not.toHaveBeenCalled();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('keeps only one row armed at a time', async () => {
    const rowA = overrideView('user_self', DEALS, DEALS_READ);
    const rowB = overrideView('system', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      overrides: [rowA, rowB],
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, DEALS_READ)!.click();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();

    deleteButtonFor(host, 'system', DEALS, DEALS_WRITE)!.click();

    expect(confirmButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(cancelButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(deleteButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeUndefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();
    mount.dispose();
  });

  it('keeps an optimistically deleted row gone when the follow-up list rejects', async () => {
    const deleted = overrideView('user_self', DEALS, DEALS_WRITE);
    const remaining = overrideView('system', CONTACTS, CONTACTS_WRITE);
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [deleted, remaining] };
        throw new Error('post-delete list down');
      },
    });
    await mount.whenLoaded();

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);

    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('post-delete list down');
    expect(mount.getOverrides()).toEqual([remaining]);
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('surfaces per-row delete errors and re-enables that row', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount, calls } = mountFor({
      overrides: [row],
      runDeleteOverride: async () => {
        throw new Error('delete denied');
      },
    });
    await mount.whenLoaded();

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);

    const errors = collectByAttr(rowFor(host, 'user_self', DEALS, DEALS_WRITE)!, PERMISSIONS_ROW_ERROR_ATTR);
    const del = deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!;
    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain('delete denied');
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    expect(del.textContent).toBe('Delete');
    expect(del.getAttribute('disabled')).toBeNull();
    mount.dispose();
  });

  it('serializes deletes per row while a delete is in flight', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const deleting = deferred<{ deleted: boolean }>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [row] : [] };
      },
      runDeleteOverride: () => deleting.promise,
    });
    await mount.whenLoaded();

    const first = mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    await tick();

    const disabled = deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!;
    expect(disabled.textContent).toContain('Removing');
    expect(disabled.getAttribute('disabled')).toBe('');
    expect(mount.hasInFlightWork()).toBe(true);

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);

    deleting.resolve({ deleted: true });
    await first;
    await tick();

    expect(mount.hasInFlightWork()).toBe(false);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    mount.dispose();
  });

  it('drops a stale in-flight refresh after a delete re-list wins', async () => {
    const deleted = overrideView('user_self', DEALS, DEALS_WRITE);
    const remaining = overrideView('system', CONTACTS, CONTACTS_WRITE);
    const staleRefresh = deferred<{ overrides: OverrideView[] }>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [deleted, remaining] };
        if (listCall === 2) return staleRefresh.promise;
        return { overrides: [remaining] };
      },
    });
    await mount.whenLoaded();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();

    const stale = mount.refresh();
    await tick();
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(3);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(mount.getOverrides()).toEqual([remaining]);

    staleRefresh.resolve({ overrides: [deleted, remaining] });
    await stale;
    await tick();

    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)).toBeDefined();
    expect(mount.getOverrides()).toEqual([remaining]);
    mount.dispose();
  });

  it('dispose removes the wrapper, is idempotent, and ignores late rpc resolution', async () => {
    const list = deferred<{ overrides: OverrideView[] }>();
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      runListOverrides: () => list.promise,
    });

    expect(host.children).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
    mount.dispose();
    expect(host.children).toHaveLength(0);
    expect(() => mount.dispose()).not.toThrow();

    list.resolve({ overrides: [row] });
    await mount.whenLoaded();
    await tick();

    expect(host.children).toHaveLength(0);
    expect(mount.getState()).toBe('loading');
    expect(mount.getOverrides()).toHaveLength(0);
  });

});


describe('D-166 Permissions create form', () => {
  it('renders only when both create callers are supplied', async () => {
    const withoutCreate = mountFor();
    await withoutCreate.mount.whenLoaded();

    expect(collectByAttr(withoutCreate.host, PERMISSIONS_CREATE_FORM_ATTR)).toHaveLength(0);
    withoutCreate.mount.dispose();

    const withCreate = mountFor({ withCreate: true, catalog: catalogFixture() });
    await withCreate.mount.whenLoaded();
    await withCreate.mount.whenCatalogLoaded();

    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_FORM_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_ACTOR_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_OPERATION_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_DENIED_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_APPROVAL_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_MAXRISK_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_SAVE_ATTR)).toHaveLength(1);
    withCreate.mount.dispose();
  });

  it('populates ingredient options from the loaded catalog', async () => {
    const catalog = catalogFixture();
    const { host, mount } = mountFor({ withCreate: true, catalog });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    expect(mount.getCatalog()).toEqual(catalog);
    expect(selectOptions(host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toEqual([
      { value: '', label: 'Choose an Ingredient…' },
      { value: DEALS, label: 'HubSpot Deals' },
      { value: CONTACTS, label: 'HubSpot Contacts' },
    ]);
    mount.dispose();
  });

  it('updates operation options for the selected ingredient', async () => {
    const { host, mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    mount.setCreateField('ingredient_id', DEALS);

    expect(selectOptions(host, PERMISSIONS_CREATE_OPERATION_ATTR)).toEqual([
      { value: '', label: 'Everything this Ingredient does' },
      { value: DEALS_READ, label: 'read (read)' },
      { value: DEALS_WRITE, label: 'write (write)' },
    ]);

    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('ingredient_id', CONTACTS);

    const operationOptions = selectOptions(host, PERMISSIONS_CREATE_OPERATION_ATTR);
    expect(operationOptions).toEqual([
      { value: '', label: 'Everything this Ingredient does' },
      { value: CONTACTS_WRITE, label: 'write (write)' },
    ]);
    expect(operationOptions.map((o) => o.value)).not.toContain(DEALS_WRITE);
    mount.dispose();
  });

  it('submits an ingredient-wide denied override and omits operation_id', async () => {
    const created = overrideView('user_self', DEALS, null, { denied: true }, { written_at: 2 });
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [] : [created] };
      },
      runUpsertOverride: async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy, { written_at: 2 }),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    const args = calls.runUpsertOverride.mock.calls[0]![0];
    expect(args).toEqual({
      actor: 'user_self',
      ingredient_id: DEALS,
      policy: { denied: true },
    });
    expect(args).not.toHaveProperty('operation_id');
    expect(rowFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(mount.getCreateError()).toBeNull();
    mount.dispose();
  });

  it('submits a specific operation override', async () => {
    const created = overrideView(
      'contracted_user',
      DEALS,
      DEALS_WRITE,
      { approval: 'ask' },
      { written_at: 2 },
    );
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [] : [created] };
      },
      runUpsertOverride: async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy, { written_at: 2 }),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'contracted_user');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('approval', 'ask');

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    expect(calls.runUpsertOverride.mock.calls[0]![0]).toEqual({
      actor: 'contracted_user',
      ingredient_id: DEALS,
      operation_id: DEALS_WRITE,
      policy: { approval: 'ask' },
    });
    expect(rowFor(host, 'contracted_user', DEALS, DEALS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('guards against submitting an empty policy', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe(
      'Set at least one rule: block it, ask you first, or cap how risky it may get.',
    );
    expect(collectByAttr(host, PERMISSIONS_CREATE_ERROR_ATTR)[0]!.textContent).toBe(
      'Set at least one rule: block it, ask you first, or cap how risky it may get.',
    );
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('requires both actor and ingredient before upserting', async () => {
    const { mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose who to put a rule on.');

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', '');

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose an Ingredient.');
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('surfaces contract_write_loosens rejections without clearing the draft', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runUpsertOverride: async () => {
        throw {
          code: 'contract_write_loosens',
          message: 'loosened policy',
          details: { loosened_fields: ['approval', 'max_risk_without_approval'] },
        };
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('approval', 'always');

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    expect(mount.getCreateError()).toContain('can only make rules stricter');
    expect(mount.getCreateError()).toContain('approval');
    expect(mount.getCreateError()).toContain('max_risk_without_approval');
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_ACTOR_ATTR)).toBe('user_self');
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toBe(DEALS);
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_APPROVAL_ATTR)).toBe('always');
    mount.dispose();
  });

  it('surfaces bad_request rejections as the server message', async () => {
    const { mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runUpsertOverride: async () => {
        throw {
          code: 'bad_request',
          message: 'operation is not available for that ingredient',
          details: {},
        };
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('operation is not available for that ingredient');
    mount.dispose();
  });

  it('does not resurrect an override when a same-key delete wins the race', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE, { approval: 'ask' });
    const upsert = deferred<OverrideView>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [row] : [] };
      },
      runUpsertOverride: () => upsert.promise,
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('denied', true);
    const submit = mount.submitCreate();
    await tick();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);

    await mount.deleteOverride(row.actor, row.ingredient_id, row.operation_id ?? undefined);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();

    upsert.resolve(row);
    await submit;
    await tick();

    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(
      mount.getOverrides().some(
        (v) =>
          v.actor === row.actor
          && v.ingredient_id === row.ingredient_id
          && v.operation_id === row.operation_id,
      ),
    ).toBe(false);
    mount.dispose();
  });

  it('keeps the optimistic create when the post-create re-list fails', async () => {
    const created = overrideView('contracted_user', CONTACTS, null, {
      max_risk_without_approval: 'read',
    });
    let listCall = 0;
    const { host, mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [] };
        throw new Error('post-create list down');
      },
      runUpsertOverride: async () => created,
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'contracted_user');
    mount.setCreateField('ingredient_id', CONTACTS);
    mount.setCreateField('max_risk_without_approval', 'read');

    await mount.submitCreate();

    expect(rowFor(host, 'contracted_user', CONTACTS, null)).toBeDefined();
    expect(mount.getOverrides()).toEqual([created]);
    expect(mount.getCreateError()).toBeNull();
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)[0]!.textContent).toContain(
      'post-create list down',
    );
    mount.dispose();
  });

  it('disables the ingredient picker when the catalog load fails', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      runListCatalogOperations: async () => {
        throw new Error('catalog down');
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    expect(onlyByAttr(host, PERMISSIONS_CREATE_INGREDIENT_ATTR).getAttribute('disabled')).toBe('');
    expect(mount.getCatalog()).toEqual([]);

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('denied', true);
    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose an Ingredient.');
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });
});
