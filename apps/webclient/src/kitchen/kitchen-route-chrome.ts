/**
 * Kitchen route chrome — the visible `[ Recipe | Ingredient pack ]` tab bar
 * shared by the two `#kitchen` authoring surfaces (recipe editor + ingredient-
 * pack builder).
 *
 * The bootstrap's kitchen branch mounts this FIRST (into the shell content
 * slot), then mounts the active surface into the returned `contentRoot`, so the
 * tab bar persists across the editor's loading / not-found / error states and
 * lets the user switch surfaces (or step back to the `#recipes` library).
 *
 * Mirrors the reception / connections route-tab pattern: a `nav` of `<a>` links
 * whose href is a shell deep link; a click changes the hash and the shell
 * re-mounts the (deep-link) kitchen route on the new surface. The two surfaces
 * share a 1200px workbench width, so the bar and both editors keep one stable
 * left edge while the route background still fills the scroll surface.
 */
import { serializeShellRoute } from '../shell/route.js';

export const KITCHEN_ROUTE_HOST_ATTR = 'data-recued-kitchen-route';
export const KITCHEN_ROUTE_TABS_ATTR = 'data-recued-kitchen-route-tabs';
export const KITCHEN_ROUTE_CONTENT_ATTR = 'data-recued-kitchen-route-content';
/** Visible workspace label that keeps the two editor tabs anchored to Kitchen. */
export const KITCHEN_ROUTE_LABEL_ATTR = 'data-recued-kitchen-route-label';
/** Per-tab marker; value is the surface id (`'recipe' | 'pack'`). */
export const KITCHEN_ROUTE_TAB_ATTR = 'data-recued-kitchen-route-tab';
const KITCHEN_ROUTE_STYLES_MARKER = 'data-recued-kitchen-route-styles';

export type KitchenSurface = 'recipe' | 'pack';

export interface MountKitchenChromeOptions {
  root: HTMLElement;
  /** Which surface is currently mounted — drives the active tab. */
  active: KitchenSurface;
  /** The open recipe id (recipe surface only). The Recipe tab points back to
   *  it; absent on the pack surface, where the Recipe tab links to `#recipes`. */
  recipeId?: string;
  /** Exact self-link for a contextual new-recipe route whose seed needs more
   *  than a recipe id (for example `#kitchen/new/form-response/<id>`). */
  recipeHref?: string;
  document?: Document;
}

export interface KitchenChromeMount {
  /** Mount the active surface (recipe editor / pack builder) into this slot. */
  contentRoot: HTMLElement;
  /** Keep the active Recipe tab canonical when a contextual new draft saves. */
  setRecipeHref(href: string): void;
  dispose(): void;
}

const KITCHEN_TABS: ReadonlyArray<{ id: KitchenSurface; label: string }> = [
  { id: 'recipe', label: 'Recipe' },
  { id: 'pack', label: 'Ingredient pack' },
];

const KITCHEN_ROUTE_STYLES = `
[${KITCHEN_ROUTE_HOST_ATTR}] {
  min-height: 100vh;
  background: var(--bg);
}
[data-recued-webclient-content] [${KITCHEN_ROUTE_HOST_ATTR}] {
  min-height: 100%;
}
[${KITCHEN_ROUTE_TABS_ATTR}] {
  display: flex;
  gap: 6px;
  align-items: center;
  box-sizing: border-box;
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
[${KITCHEN_ROUTE_LABEL_ATTR}] {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  margin-right: 8px;
  padding-right: 16px;
  border-right: 1px solid var(--border);
  color: var(--fg-strong);
  font-size: 14px;
  font-weight: 720;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
[${KITCHEN_ROUTE_TABS_ATTR}] .kitchen-route-tab {
  appearance: none;
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 10px 14px 12px;
  font-weight: 600;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
[${KITCHEN_ROUTE_TABS_ATTR}] .kitchen-route-tab:hover {
  color: var(--fg);
  background: var(--surface-sunk);
}
[${KITCHEN_ROUTE_TABS_ATTR}] .kitchen-route-tab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
  background: var(--accent-weak);
}
@media (max-width: 560px) {
  [${KITCHEN_ROUTE_TABS_ATTR}] {
    gap: 2px;
    padding-inline: 12px;
  }
  [${KITCHEN_ROUTE_LABEL_ATTR}] {
    margin-right: 2px;
    padding-right: 10px;
  }
  [${KITCHEN_ROUTE_TABS_ATTR}] .kitchen-route-tab {
    padding-inline: 10px;
    font-size: 13px;
  }
}
`;

/** Where each tab navigates. Pack → the pack editor. Recipe → the open recipe
 *  when one is (recipe surface); otherwise the `#recipes` library to pick one
 *  (Kitchen deliberately doesn't duplicate a recipe browser). Pure — unit
 *  tested directly. */
export const kitchenTabHref = (
  tab: KitchenSurface,
  active: KitchenSurface,
  recipeId: string | undefined,
  recipeHref?: string,
): string => {
  if (tab === 'pack') return serializeShellRoute('kitchen', 'pack');
  if (active === 'recipe' && recipeHref !== undefined) return recipeHref;
  if (active === 'recipe' && recipeId !== undefined) {
    return serializeShellRoute('kitchen', 'recipe', recipeId);
  }
  return serializeShellRoute('recipes');
};

export const mountKitchenChrome = (
  opts: MountKitchenChromeOptions,
): KitchenChromeMount => {
  const doc = opts.document ?? globalThis.document;

  if (
    doc.head !== undefined
    && doc.head !== null
    && doc.head.querySelector(`style[${KITCHEN_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(KITCHEN_ROUTE_STYLES_MARKER, '');
    style.textContent = KITCHEN_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  const host = doc.createElement('div');
  host.setAttribute(KITCHEN_ROUTE_HOST_ATTR, '');

  const tabBar = doc.createElement('nav');
  tabBar.setAttribute(KITCHEN_ROUTE_TABS_ATTR, '');
  tabBar.setAttribute('aria-label', 'Kitchen pages');

  const kitchenLabel = doc.createElement('span');
  kitchenLabel.setAttribute(KITCHEN_ROUTE_LABEL_ATTR, '');
  kitchenLabel.textContent = 'Kitchen';
  tabBar.appendChild(kitchenLabel);

  let recipeTab: HTMLAnchorElement | null = null;
  for (const tab of KITCHEN_TABS) {
    const isActive = tab.id === opts.active;
    const link = doc.createElement('a');
    link.className = 'kitchen-route-tab' + (isActive ? ' kitchen-route-tab--active' : '');
    link.setAttribute(KITCHEN_ROUTE_TAB_ATTR, tab.id);
    link.setAttribute(
      'href',
      kitchenTabHref(tab.id, opts.active, opts.recipeId, opts.recipeHref),
    );
    link.textContent = tab.label;
    if (isActive) link.setAttribute('aria-current', 'page');
    if (tab.id === 'recipe') recipeTab = link;
    tabBar.appendChild(link);
  }
  host.appendChild(tabBar);

  const content = doc.createElement('div');
  content.setAttribute(KITCHEN_ROUTE_CONTENT_ATTR, '');
  host.appendChild(content);

  opts.root.appendChild(host);

  let disposed = false;
  return {
    contentRoot: content,
    setRecipeHref(href: string): void {
      if (disposed || recipeTab === null) return;
      recipeTab.setAttribute('href', href);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        opts.root.removeChild(host);
      } catch {
        /* already detached */
      }
    },
  };
};
