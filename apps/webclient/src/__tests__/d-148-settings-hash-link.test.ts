/** D-148 § A.6.5 hash-link affordance (slice 112) acceptance + D-174 IA.
 *
 *  Reception still links INTO Settings via a discoverable anchor,
 *  mirroring the route registry in `webclient-bootstrap.ts`:
 *    - Reception side: `<a href="#settings">Settings</a>` rendered into
 *      the status header by `renderReceptionPage`.
 *
 *  Settings, however, is now a first-class workspace-rail route — not a
 *  child of Reception — so the old `<a href="#reception">← Back to
 *  Reception</a>` breadcrumb was removed. Its surface graduated to a
 *  left-rail subview shell (one section visible at a time). The
 *  Settings-side tests below assert that the back link is gone and that
 *  the subview rail mounts + activates its first section by default.
 *
 *  Why anchors (Reception side, not `data-action` buttons): the
 *  bootstrap's hashchange listener (`parseRouteFromHash`) is the
 *  existing wire format for route transitions — a plain anchor preserves
 *  native browser affordances (middle-click → new tab, right-click →
 *  copy link, screen-reader → "link" role) and needs no dispatch wiring.
 */

import { describe, expect, it } from 'vitest';
import type { RotationResult } from '@recued/contracts';
import type { ReceptionStatusInput } from '../settings/reception.js';
import type { ReceptionPageShellState } from '../settings/reception-page-shell.js';
import {
  renderReceptionPage,
  RECEPTION_COMPOSE_FAB_ATTR,
  RECEPTION_COMPOSE_LINK_ATTR,
  RECEPTION_SETTINGS_LINK_ATTR,
} from '../settings/reception-page-render.js';
import {
  bootstrapSettingsRoute,
  SETTINGS_ROUTE_ACTIVE_ATTR,
  SETTINGS_ROUTE_NAV_ATTR,
  SETTINGS_ROUTE_NAV_ITEM_ATTR,
  SETTINGS_ROUTE_ROOT_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
} from '../settings/bootstrap-settings-route.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

const NOW = 1_700_000_000_000;

/** A minimal successful `tls.renew` result — wiring `tlsRenewCaller`
 *  mounts the Server subview so the rail has a second item to assert
 *  against. */
const SUCCESS_RESULT: Extract<RotationResult, { ok: true }> = {
  ok: true,
  op: 'tls_renew',
  key_class: 'tls_private_key',
  new_fingerprint: 'sha256:CAFEF00D',
  rotated_at: 1_800_000_000_000,
};

// ──────────────────────────────────────────────────────────────────
// Reception side — status-header anchor
// ──────────────────────────────────────────────────────────────────

const status = (
  overrides: Partial<ReceptionStatusInput> = {},
): ReceptionStatusInput => ({
  emergency_disabled: false,
  reception_public: true,
  base_url: 'https://alice.recued.cloud',
  ...overrides,
});

const emptyState = (
  overrides: Partial<ReceptionPageShellState> = {},
): ReceptionPageShellState => ({
  page: null,
  detail: null,
  abuse_inbox: null,
  view_as_visitor: null,
  status: status(),
  last_error: null,
  loading: false,
  ...overrides,
});

describe('D-148 hash-link affordance — Reception → Settings', () => {
  it('renders a Settings anchor inside the status header', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain('class="reception-status-nav-link"');
    expect(html).toContain('>Settings<');
  });

  it('the Settings anchor points to #settings', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain('href="#settings"');
  });

  it('the Settings anchor carries the documented attribute marker', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain(RECEPTION_SETTINGS_LINK_ATTR);
  });

  it('the Settings anchor is present whether the page is loaded or unloaded', () => {
    // Unloaded view (no page model populated).
    const unloaded = renderReceptionPage(emptyState(), NOW);
    expect(unloaded).toContain('href="#settings"');
    // The same anchor lives in the status header regardless of which
    // body view (`unloaded` / `list` / `detail` / `view_as_visitor`) is
    // active because the header renders before the body branch.
    expect(unloaded).toMatch(/reception-status-header[\s\S]*href="#settings"/);
  });

  it('the renderer ships CSS for the nav link', () => {
    // Pulled from `RECEPTION_PAGE_STYLES` indirectly: a synthesized
    // render must place the link with the class the styles target.
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain('reception-status-nav-link');
  });

  // D-169 P2 — the top-level Approvals route nav link, alongside Settings.
  it('renders an Approvals anchor pointing at #approvals before the Settings link', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain('href="#approvals"');
    expect(html).toContain('data-recued-approvals-link');
    expect(html).toContain('>Approvals<');
    // It sits before Settings in the header (the more actionable entry).
    expect(html).toMatch(/href="#approvals"[\s\S]*href="#settings"/);
  });

  it('renders the + New desktop link and mobile FAB as reception-open-templates action controls', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    // D-149 § A.10 follow-on — the "+ New" entry + FAB now open the
    // standalone templates-browser gallery via the host-forwarded
    // `reception-open-templates` action (they used to dead-link `#compose`).
    expect(html).not.toContain('href="#compose"');
    expect(html).toContain(RECEPTION_COMPOSE_LINK_ATTR);
    expect(html).toContain(RECEPTION_COMPOSE_FAB_ATTR);
    // Both compose entries carry the action; the responsive markers + the
    // FAB's aria-label / title are preserved.
    expect(html).toContain('aria-label="New endpoint"');
    expect(html).toContain('title="New endpoint"');
    expect(html).toContain('>+ New<');
    // The desktop link carries the action.
    expect(html).toMatch(
      new RegExp(`${RECEPTION_COMPOSE_LINK_ATTR}[^>]*data-action="reception-open-templates"`),
    );
    // The FAB carries the action.
    expect(html).toMatch(
      new RegExp(`${RECEPTION_COMPOSE_FAB_ATTR}[^>]*data-action="reception-open-templates"`),
    );
    // The Approvals nav link still hash-routes.
    expect(html).toContain('href="#approvals"');
  });
});

// ──────────────────────────────────────────────────────────────────
// Settings side — heading-area back anchor
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    children,
    parent: null,
    attrs,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  head: {
    appendChild(el: FakeElement): FakeElement;
    querySelector(selector: string): FakeElement | null;
  };
  styleTags: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeElement[] = [];
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    createElement: (tag) => makeFakeElement(tag),
    head: {
      appendChild: (next) => {
        styleTags.push(next);
        return next;
      },
      querySelector: (selector) => {
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

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

/** Walk the tree for any `<a href="…">` matching `href`. */
const findAnchorByHref = (
  root: FakeElement,
  href: string,
): FakeElement | null => {
  if (root.tagName === 'A' && root.getAttribute('href') === href) return root;
  for (const c of root.children) {
    const hit = findAnchorByHref(c, href);
    if (hit) return hit;
  }
  return null;
};

describe('D-148 IA — Settings is a top-level route (no Reception back link)', () => {
  it('renders no "← Back to Reception" anchor — the h1 is the route root first child', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const root = findByAttr(host, SETTINGS_ROUTE_ROOT_ATTR);
    expect(root).not.toBeNull();
    // The Settings title leads — no breadcrumb anchor above it.
    expect(root?.firstChild?.tagName).toBe('H1');
    // And nothing in the tree links back up to Reception.
    expect(findAnchorByHref(host, '#reception')).toBeNull();
    route.dispose();
  });

  it('builds a left-rail nav with one button per mounted subview', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      // Privacy always mounts; tlsRenewCaller adds the Server subview.
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    expect(findByAttr(host, SETTINGS_ROUTE_NAV_ATTR)).not.toBeNull();
    const privacyItem = findByAttrValue(
      host,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'privacy',
    );
    expect(privacyItem).not.toBeNull();
    expect(privacyItem?.tagName).toBe('BUTTON');
    expect(privacyItem?.textContent).toBe('Privacy');
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'server'),
    ).not.toBeNull();
    route.dispose();
  });

  it('activates the first registered subview by default', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    // Privacy registers first (always-on), so it is active; Server hides.
    const privacy = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'privacy');
    const server = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server');
    expect(privacy?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(server?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('false');
    const privacyItem = findByAttrValue(
      host,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'privacy',
    );
    expect(privacyItem?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(privacyItem?.getAttribute('aria-current')).toBe('page');
    route.dispose();
  });

  it('disposing the route detaches the whole tree', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(findByAttr(host, SETTINGS_ROUTE_ROOT_ATTR)).not.toBeNull();
    route.dispose();
    expect(findByAttr(host, SETTINGS_ROUTE_ROOT_ATTR)).toBeNull();
  });
});
