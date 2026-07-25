import { describe, expect, it } from 'vitest';

import {
  KITCHEN_ROUTE_CONTENT_ATTR,
  KITCHEN_ROUTE_HOST_ATTR,
  KITCHEN_ROUTE_TAB_ATTR,
  KITCHEN_ROUTE_TABS_ATTR,
  kitchenTabHref,
  mountKitchenChrome,
} from '../kitchen-route-chrome.js';

// ────────────────────────────────────────────────────────────────
// Minimal fake DOM (same shape as the recipe-editor route tests).
// ────────────────────────────────────────────────────────────────
interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  attrs: Map<string, string>;
  children: FakeElement[];
  parent: FakeElement | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
}

interface FakeDocument {
  styleElements: FakeElement[];
  head: {
    querySelector(sel: string): FakeElement | null;
    appendChild(el: FakeElement): FakeElement;
  };
  createElement(tag: string): FakeElement;
}

const makeFakeElement = (tag: string): FakeElement => {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    attrs: new Map(),
    children: [],
    parent: null,
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleElements: FakeElement[] = [];
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const m = sel.match(/^style\[([\w-]+)\]$/);
        if (m === null) return null;
        return styleElements.find((s) => s.hasAttribute(m[1]!)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeElement(tag),
  };
};

const findByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    if (el.hasAttribute(attr)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
};

const tabBysurface = (root: FakeElement, surface: string): FakeElement | undefined =>
  findByAttr(root, KITCHEN_ROUTE_TAB_ATTR).find(
    (el) => el.getAttribute(KITCHEN_ROUTE_TAB_ATTR) === surface,
  );

const mount = (
  active: 'recipe' | 'pack',
  recipeId?: string,
  recipeHref?: string,
) => {
  const doc = makeFakeDocument();
  const root = makeFakeElement('main');
  const handle = mountKitchenChrome({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    active,
    ...(recipeId !== undefined ? { recipeId } : {}),
    ...(recipeHref !== undefined ? { recipeHref } : {}),
  });
  return { doc, root, handle };
};

// ────────────────────────────────────────────────────────────────
// kitchenTabHref — the pure navigation rule
// ────────────────────────────────────────────────────────────────
describe('kitchenTabHref', () => {
  it('Pack tab always opens the pack editor', () => {
    expect(kitchenTabHref('pack', 'pack', undefined)).toBe('#kitchen/pack');
    expect(kitchenTabHref('pack', 'recipe', 'daily-brief')).toBe('#kitchen/pack');
  });

  it('Recipe tab points at the open recipe on the recipe surface', () => {
    expect(kitchenTabHref('recipe', 'recipe', 'daily-brief')).toBe(
      '#kitchen/recipe/daily-brief',
    );
  });

  it('Recipe tab preserves an exact contextual new-recipe route', () => {
    expect(
      kitchenTabHref(
        'recipe',
        'recipe',
        undefined,
        '#kitchen/new/form-response/project-intake',
      ),
    ).toBe('#kitchen/new/form-response/project-intake');
  });

  it('Recipe tab falls back to the #recipes library when no recipe is open', () => {
    // pack surface — nothing open.
    expect(kitchenTabHref('recipe', 'pack', undefined)).toBe('#recipes');
    // edge: recipe surface but somehow no id → still the library, never a
    // broken `#kitchen/recipe` (which the route treats as the pack editor).
    expect(kitchenTabHref('recipe', 'recipe', undefined)).toBe('#recipes');
  });
});

// ────────────────────────────────────────────────────────────────
// mountKitchenChrome
// ────────────────────────────────────────────────────────────────
describe('mountKitchenChrome', () => {
  it('renders exactly the two surface tabs in order with a content slot', () => {
    const { root, handle } = mount('pack');
    const host = findByAttr(root, KITCHEN_ROUTE_HOST_ATTR)[0]!;
    expect(host).toBeDefined();
    const tabs = findByAttr(root, KITCHEN_ROUTE_TAB_ATTR);
    expect(tabs.map((t) => t.getAttribute(KITCHEN_ROUTE_TAB_ATTR))).toEqual([
      'recipe',
      'pack',
    ]);
    expect(tabs.map((t) => t.textContent)).toEqual(['Recipe', 'Ingredient pack']);
    // The returned contentRoot IS the content-slot element inside the host.
    const content = findByAttr(root, KITCHEN_ROUTE_CONTENT_ATTR)[0]!;
    expect(handle.contentRoot).toBe(content as unknown as HTMLElement);
    expect(content.parent).toBe(host);
  });

  it('marks the recipe tab active on the recipe surface (aria-current + class + self href)', () => {
    const { root } = mount('recipe', 'daily-brief');
    const recipe = tabBysurface(root, 'recipe')!;
    const pack = tabBysurface(root, 'pack')!;
    expect(recipe.getAttribute('aria-current')).toBe('page');
    expect(recipe.className).toContain('kitchen-route-tab--active');
    expect(recipe.getAttribute('href')).toBe('#kitchen/recipe/daily-brief');
    // Inactive Pack tab still links to the pack editor.
    expect(pack.getAttribute('aria-current')).toBeNull();
    expect(pack.className).not.toContain('--active');
    expect(pack.getAttribute('href')).toBe('#kitchen/pack');
  });

  it('keeps a contextual recipe seed as the active tab self-link', () => {
    const href = '#kitchen/new/form-response/project-intake';
    const { root, handle } = mount('recipe', undefined, href);
    const recipe = tabBysurface(root, 'recipe')!;
    expect(recipe.getAttribute('aria-current')).toBe('page');
    expect(recipe.getAttribute('href')).toBe(href);

    handle.setRecipeHref('#kitchen/recipe/handle-project-intake-responses');
    expect(recipe.getAttribute('href')).toBe(
      '#kitchen/recipe/handle-project-intake-responses',
    );
  });

  it('marks the pack tab active on the pack surface; recipe tab links to #recipes', () => {
    const { root } = mount('pack');
    const recipe = tabBysurface(root, 'recipe')!;
    const pack = tabBysurface(root, 'pack')!;
    expect(pack.getAttribute('aria-current')).toBe('page');
    expect(pack.className).toContain('kitchen-route-tab--active');
    expect(pack.getAttribute('href')).toBe('#kitchen/pack');
    // No recipe open → the Recipe tab is a doorway to the library, not a dead
    // `#kitchen/recipe`.
    expect(recipe.getAttribute('aria-current')).toBeNull();
    expect(recipe.getAttribute('href')).toBe('#recipes');
  });

  it('injects its styles once (marker-guarded) across remounts', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    mountKitchenChrome({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      active: 'pack',
    });
    mountKitchenChrome({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      active: 'recipe',
      recipeId: 'x',
    });
    expect(doc.styleElements.length).toBe(1);
  });

  it('dispose removes the host from the root (idempotent)', () => {
    const { root, handle } = mount('pack');
    expect(findByAttr(root, KITCHEN_ROUTE_HOST_ATTR).length).toBe(1);
    handle.dispose();
    expect(findByAttr(root, KITCHEN_ROUTE_HOST_ATTR).length).toBe(0);
    // Second dispose is a no-op, not a throw.
    expect(() => handle.dispose()).not.toThrow();
  });
});
