/** D-148 § A.4.1 — Settings route bootstrap (slice 110) acceptance.
 *
 *  Drives `bootstrapSettingsRoute` through a fake Document so the test
 *  needs no jsdom — same pattern as the panel test's fake DOM,
 *  extended with `firstChild` / `removeChild` plumbing the panel's
 *  render-rebuild relies on. The bootstrap composes the Privacy panel,
 *  injects styles once (marker-guarded), and tears the route down on
 *  dispose.
 *
 *  Covers:
 *   - construction throws when no document is available.
 *   - the route root carries `data-recued-settings-route` + one
 *     section per shipped surface (Privacy only at v1).
 *   - the route style tag is injected once with the marker; a second
 *     bootstrap on the same document does not stack it.
 *   - the bundled style tag carries BOTH the route's own CSS + the
 *     panel's CSS so a host can inject one tag for the whole shell.
 *   - the Privacy panel mounts inside the route + starts in `idle`.
 *   - `cryptoKeysWiper` is threaded through to the panel.
 *   - `reloader` is threaded through to the panel.
 *   - `onCleared` is threaded through to the panel.
 *   - `clearThisBrowserPanel()` accessor returns the "This browser" wipe mount handle.
 *   - dispose tears the panel down + removes the route root from the
 *     host. */

import { describe, expect, it } from 'vitest';

import {
  bootstrapSettingsRoute,
  type BootstrapSettingsRouteOptions,
  SETTINGS_ROUTE_ACTIVE_ATTR,
  SETTINGS_ROUTE_DATA_LINK_ATTR,
  SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR,
  SETTINGS_ROUTE_PRIVACY_TRANSPARENCY_ATTR,
  SETTINGS_ROUTE_NAV_ITEM_ATTR,
  SETTINGS_ROUTE_ROOT_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
  SETTINGS_ROUTE_STYLES_MARKER,
  SETTINGS_ROUTE_STYLES,
  SETTINGS_ROUTE_SUBTAB_ATTR,
  SETTINGS_ROUTE_SUBTAB_PANEL_ATTR,
  SETTINGS_ROUTE_VIEWS_ATTR,
} from '../settings/bootstrap-settings-route.js';
import {
  CLEAR_THIS_BROWSER_PANEL_ATTR,
  CLEAR_THIS_BROWSER_PANEL_STATE_ATTR,
  CLEAR_THIS_BROWSER_PANEL_STYLES,
  CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR,
} from '../settings/clear-this-browser-panel.js';
import { AI_MODELS_CHAT_SETUP_ATTR } from '../settings/ai-models-page.js';
import type {
  TransparencyPrefsGetCaller,
  TransparencyPrefsSetCaller,
} from '../settings/transparency-panel.js';
import {
  PERMISSIONS_DOORS_SECTION_ATTR,
  PERMISSIONS_MCP_DOOR_CONTROLS_ATTR,
} from '../settings/permissions-panel.js';
import {
  TLS_RENEW_PANEL_ATTR,
  TLS_RENEW_PANEL_STATE_ATTR,
  TLS_RENEW_PANEL_STYLES,
  TLS_RENEW_RENEW_BTN_ATTR,
  type TlsRenewCaller,
} from '../settings/tls-renew-panel.js';
import {
  REACHABILITY_PANEL_ATTR,
  REACHABILITY_PANEL_STYLES,
} from '../settings/reachability.js';
import {
  CERT_PIN_STALE_PANEL_ATTR,
  CERT_PIN_STALE_PANEL_STYLES,
} from '../settings/cert-pin-stale-panel.js';
import {
  ARCHIVE_BACKUP_PANEL_ATTR,
  ARCHIVE_PASSPORT_START_BTN_ATTR,
  type ArchiveExportCaller,
  type ArchiveImportCaller,
  type ArchivePassportExportCaller,
  type ArchiveStatusCaller,
} from '../settings/archive-backup-panel.js';
import {
  SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR,
  SELLER_CUSTOMER_FORM_ATTR,
  SELLER_PAGE_STYLES,
  SELLER_PAGE_STATE_ATTR,
  SELLER_PAGE_SUBPAGE_ATTR,
  SELLER_COLLECTION_LIST_ATTR,
  SELLER_DIRECTORY_ATTR,
  SELLER_SETTINGS_FORM_ATTR,
  SELLER_TIER_BULK_ADJUST_FORM_ATTR,
  SELLER_TIER_FORM_ATTR,
} from '../settings/seller-page.js';
import { createCertPinStateWatcher } from '../realtime/cert-pin-state-watcher.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type {
  ArchiveImportRebind,
  RotationResult,
  SellerOverview,
  SellerTier,
  WebclientCertPinState,
} from '@recued/contracts';
import { generateRecoveryKey } from '@recued/crypto';

// ──────────────────────────────────────────────────────────────────
// Minimal fake DOM — extends the panel test's pattern with the
// document head + style-element bookkeeping the route depends on.
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  value: string;
  readOnly: boolean;
  innerHTML: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  scrollIntoViewCalls: unknown[];
  focusCalls: unknown[];
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
  scrollIntoView(opts?: unknown): void;
  focus(opts?: unknown): void;
  click(): void;
  type: string;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const scrollIntoViewCalls: unknown[] = [];
  const focusCalls: unknown[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    value: '',
    readOnly: false,
    innerHTML: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    scrollIntoViewCalls,
    focusCalls,
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
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    scrollIntoView: (opts) => {
      scrollIntoViewCalls.push(opts);
    },
    focus: (opts) => {
      focusCalls.push(opts);
    },
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  head: {
    appendChild(el: FakeElement): FakeElement;
    querySelector(selector: string): FakeElement | null;
  };
  /** Test-only: list of `<style>` tags appended via `head.appendChild`. */
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

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Construction
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.4.1 — bootstrapSettingsRoute: construction', () => {
  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    const originalDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(() =>
        bootstrapSettingsRoute({
          root: host as unknown as HTMLElement,
          localStore: createInMemoryWebclientLocalStore(),
        }),
      ).toThrow(/no document available/);
    } finally {
      (globalThis as { document?: unknown }).document = originalDoc;
    }
  });

  it('appends a single route-root child carrying data-recued-settings-route', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(host.children.length).toBe(1);
    const root = host.children[0]!;
    expect(root.hasAttribute(SETTINGS_ROUTE_ROOT_ATTR)).toBe(true);
    expect(host.hasAttribute(SETTINGS_ROUTE_ROOT_ATTR)).toBe(false); // DD#5 — never on opts.root
    route.dispose();
  });

  it('renders the Settings heading + Privacy section', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const root = findByAttr(host, SETTINGS_ROUTE_ROOT_ATTR)!;
    const h1 = root.children.find((c) => c.tagName === 'H1');
    expect(h1?.textContent).toBe('Settings');
    const privacy = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'privacy');
    expect(privacy).not.toBeNull();
    const h2 = privacy?.children.find((c) => c.tagName === 'H2');
    expect(h2?.textContent).toBe('Privacy');
    route.dispose();
  });

  it('mounts the intent-specific Set up Chat view for the AI deep link', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'ai-models',
      initialAiModelsView: 'chat-setup',
      aiModelsDefaultModelPrefGetCaller: async () => ({
        source_id: null,
        updated_at: 0,
      }),
      aiModelsGetLLMConfigCaller: async () => ({ config: {} }),
      aiModelsSetLLMSlotCaller: async () => ({ ok: true }),
      aiModelsDefaultModelPrefSetCaller: async ({ source_id }) => ({
        source_id,
        updated_at: 1,
      }),
    });
    await route.aiModelsPage()!.whenLoaded();

    const section = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'ai-models')!;
    expect(section.children[0]?.textContent).toBe('Set up Chat');
    expect(findByAttr(section, AI_MODELS_CHAT_SETUP_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('renders a Settings -> Data pointer for cold-start #data discovery', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const dataLink = findByAttr(host, SETTINGS_ROUTE_DATA_LINK_ATTR);
    expect(dataLink).not.toBeNull();
    expect(dataLink?.getAttribute('href')).toBe('#data');
    // R29 — the directory row's label lives in a title span inside the link.
    const dataTitle = dataLink?.children.find(
      (c) => c.className === 'privacy-directory-title',
    );
    expect(dataTitle?.textContent).toBe('Data');
    // The link sits inside the Privacy directory list.
    expect(findByAttr(host, SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('activates + scroll-focuses a deep-linked initial section, and falls back to the first subview for absent / unknown ids', () => {
    const doc = makeFakeDocument();

    // Deep link to a known section → that subview is active + scroll-focused.
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
      initialSectionId: 'server',
    });

    const server = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')!;
    const privacy = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'privacy')!;
    expect(server.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(privacy.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('false');
    // Its rail item carries the active marker + aria-current.
    const serverItem = findByAttrValue(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'server')!;
    expect(serverItem.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(serverItem.getAttribute('aria-current')).toBe('page');
    // A deep link scroll-focuses the section for accessibility.
    expect(server.scrollIntoViewCalls).toEqual([
      { block: 'start', inline: 'nearest' },
    ]);
    expect(server.focusCalls).toEqual([{ preventScroll: true }]);
    expect(server.getAttribute('tabindex')).toBe('-1');
    route.dispose();

    // Unknown id → first subview (Privacy) active; Server inactive + not scrolled.
    const unknownHost = makeFakeElement('div');
    const unknownRoute = bootstrapSettingsRoute({
      root: unknownHost as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
      initialSectionId: 'not-a-section',
    });
    const unknownServer = findByAttrValue(
      unknownHost,
      SETTINGS_ROUTE_SECTION_ATTR,
      'server',
    )!;
    const unknownPrivacy = findByAttrValue(
      unknownHost,
      SETTINGS_ROUTE_SECTION_ATTR,
      'privacy',
    )!;
    expect(unknownPrivacy.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(unknownServer.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('false');
    expect(unknownServer.scrollIntoViewCalls).toHaveLength(0);
    expect(unknownServer.focusCalls).toHaveLength(0);
    unknownRoute.dispose();

    // Absent id → same first-subview fallback, no scroll on Server.
    const absentHost = makeFakeElement('div');
    const absentRoute = bootstrapSettingsRoute({
      root: absentHost as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    const absentServer = findByAttrValue(
      absentHost,
      SETTINGS_ROUTE_SECTION_ATTR,
      'server',
    )!;
    const absentPrivacy = findByAttrValue(
      absentHost,
      SETTINGS_ROUTE_SECTION_ATTR,
      'privacy',
    )!;
    expect(absentPrivacy.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('true');
    expect(absentServer.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR)).toBe('false');
    expect(absentServer.scrollIntoViewCalls).toHaveLength(0);
    expect(absentServer.focusCalls).toHaveLength(0);
    absentRoute.dispose();
  });

  it('no longer renders an Approvals section (it graduated to the top-level #approvals route, D-169 P2)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    // The D-158 ask surface lives only at the top-level `#approvals` route
    // now — the Settings route never carries an `approvals` section.
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'approvals')).toBeNull();
    route.dispose();
  });

  it('does not mount the legacy Settings MCP-token credential surface', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });

    expect(route.permissionsPanel()).toBeNull();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'permissions')).toBeNull();
    expect(findByAttr(host, PERMISSIONS_DOORS_SECTION_ATTR)).toBeNull();
    expect(findByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toBeNull();
    route.dispose();
  });

  it('mounts the Privacy panel inside the Privacy section', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const panel = findByAttr(host, CLEAR_THIS_BROWSER_PANEL_ATTR);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute(CLEAR_THIS_BROWSER_PANEL_STATE_ATTR)).toBe('idle');
    expect(route.clearThisBrowserPanel().getState()).toBe('idle');
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// In-section sub-tabs (Privacy / Server)
// ──────────────────────────────────────────────────────────────────

describe('bootstrapSettingsRoute: Privacy directory + Server in-section sub-tabs', () => {
  it('Privacy is a directory (5 links, no sub-tabs) with Transparency folded in', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      transparencyPrefsGetCaller:
        (async () => ({ prefs: {} })) as unknown as TransparencyPrefsGetCaller,
      transparencyPrefsSetCaller:
        (async () => ({ prefs: {} })) as unknown as TransparencyPrefsSetCaller,
    });

    // R29 — Privacy is a directory, NOT a sub-tab strip: the old
    // "This browser" / "Related" / "egress" sub-tabs are gone.
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'this-browser'),
    ).toBeNull();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'related')).toBeNull();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'egress')).toBeNull();

    // The directory lists all five control links in order (contracts /
    // connections / data carry marker attrs; ai-models + runs are plain).
    const directory = findByAttr(host, SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR);
    expect(directory).not.toBeNull();
    const hrefs = directory!.children.map(
      (li) => li.children[0]?.getAttribute('href') ?? null,
    );
    expect(hrefs).toEqual([
      '#contracts',
      '#connections',
      '#data',
      '#settings/ai-models',
      '#logs',
    ]);

    // Transparency is folded INTO the Privacy section — not a standalone
    // top-level rail section anymore.
    const privacy = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'privacy')!;
    expect(
      findByAttr(privacy, SETTINGS_ROUTE_PRIVACY_TRANSPARENCY_ATTR),
    ).not.toBeNull();
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'transparency'),
    ).toBeNull();

    // The "This browser" wipe panel still mounts (accessor stays live).
    expect(route.clearThisBrowserPanel().getState()).toBe('idle');

    route.dispose();
  });

  it('Server splits into Reachability + Certificates sub-tabs; the TLS panel lives under Certificates', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      reachabilityExternalProbeCaller: async () => ({
        account_id: 'acct-1',
        hostname: 'alice.recued.cloud',
        detected_public_ip: '203.0.113.5',
        resolved_ips: ['203.0.113.5'],
        probed_at: 1_700_000_000_000,
        results: [],
      }),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });

    const reachabilityTab = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_ATTR,
      'reachability',
    );
    const certsTab = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_ATTR,
      'certificates',
    );
    expect(reachabilityTab).not.toBeNull();
    expect(certsTab).not.toBeNull();

    const certsPanel = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_PANEL_ATTR,
      'certificates',
    )!;
    // First sub-tab (reachability) active; certificates hidden until clicked.
    expect(certsPanel.getAttribute('data-active')).toBe('false');
    // The TLS renew panel is mounted inside the Certificates sub-tab panel.
    expect(findByAttr(certsPanel, TLS_RENEW_PANEL_ATTR)).not.toBeNull();

    certsTab!.click();
    expect(certsPanel.getAttribute('data-active')).toBe('true');
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Style injection
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.4.1 — bootstrapSettingsRoute: style injection', () => {
  it('injects one style tag carrying both the route + panel CSS payloads', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    expect(style.hasAttribute(SETTINGS_ROUTE_STYLES_MARKER)).toBe(true);
    // Bundled payload includes BOTH CSS blocks (DD#3).
    expect(style.textContent).toContain(SETTINGS_ROUTE_STYLES.trim());
    expect(style.textContent).toContain(CLEAR_THIS_BROWSER_PANEL_STYLES.trim());
    expect(style.textContent).toContain(SELLER_PAGE_STYLES.trim());
  });

  it('Codex slice-110 P2 fold — bundle includes PRIMITIVE_STYLES so direct #settings loads are styled', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    // PRIMITIVE_STYLES ships the `.rx-btn` base class the panel's
    // buttons depend on. Pre-fold the cold-load bundle omitted this,
    // so direct #settings loads rendered unstyled buttons until the
    // user navigated through #reception.
    expect(style.textContent).toContain('.rx-btn');
    expect(style.textContent).toContain('.rx-btn-primary');
    expect(style.textContent).toContain('.rx-btn-secondary');
  });

  it('skips duplicate style injection on a re-bootstrap of the same document', () => {
    const host1 = makeFakeElement('div');
    const host2 = makeFakeElement('div');
    const doc = makeFakeDocument();
    const a = bootstrapSettingsRoute({
      root: host1 as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const b = bootstrapSettingsRoute({
      root: host2 as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(doc.styleTags).toHaveLength(1);
    a.dispose();
    b.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Forwarded seams
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.4.1 — bootstrapSettingsRoute: forwarded seams', () => {
  it('threads cryptoKeysWiper through to the panel (DD#2)', async () => {
    let wiped = 0;
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      cryptoKeysWiper: async () => {
        wiped += 1;
      },
    });
    const panel = route.clearThisBrowserPanel();
    // Drive the panel through the full success path; the wiper is
    // called once by `clearThisBrowser` when `crypto_keys_wiper` is
    // supplied.
    panel.clickClear();
    await panel.clickConfirm();
    expect(panel.getState()).toBe('done');
    expect(wiped).toBe(1);
    route.dispose();
  });

  it('threads reloader through to the panel', async () => {
    let reloaded = 0;
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      cryptoKeysWiper: async () => undefined,
      reloader: () => {
        reloaded += 1;
      },
    });
    const panel = route.clearThisBrowserPanel();
    panel.clickClear();
    await panel.clickConfirm();
    expect(panel.getState()).toBe('done');
    expect(findByAttr(host, CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR)).not.toBeNull();
    panel.clickReload();
    expect(reloaded).toBe(1);
    route.dispose();
  });

  it('threads onCleared through to the panel', async () => {
    const calls: Array<{ sw_unregistered: boolean }> = [];
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      cryptoKeysWiper: async () => undefined,
      onCleared: (_result, sw_unregistered) => {
        calls.push({ sw_unregistered });
      },
    });
    const panel = route.clearThisBrowserPanel();
    panel.clickClear();
    await panel.clickConfirm();
    expect(panel.getState()).toBe('done');
    expect(calls).toHaveLength(1);
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Dispose
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.4.1 — bootstrapSettingsRoute: dispose', () => {
  it('removes the route root from the host', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(host.children.length).toBe(1);
    route.dispose();
    expect(host.children.length).toBe(0);
  });

  it('dispose is idempotent', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    route.dispose();
    expect(() => route.dispose()).not.toThrow();
  });

  it('update is a no-op at v1', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(() => route.update()).not.toThrow();
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Slice 111 — Server section (TLS renew panel) gated mount
// ──────────────────────────────────────────────────────────────────

const SUCCESS_RESULT: Extract<RotationResult, { ok: true }> = {
  ok: true,
  op: 'tls_renew',
  key_class: 'tls_private_key',
  new_fingerprint: 'sha256:CAFEF00D',
  rotated_at: 1_800_000_000_000,
};

describe('D-148 § A.6.5 — bootstrapSettingsRoute: Server section (slice 111)', () => {
  it('does NOT mount the Server section when tlsRenewCaller is omitted', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    // Server section attribute absent.
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).toBeNull();
    // Panel attribute absent.
    expect(findByAttr(host, TLS_RENEW_PANEL_ATTR)).toBeNull();
    // Accessor reports null.
    expect(route.tlsRenewPanel()).toBeNull();
    route.dispose();
  });

  it('mounts the Server section + TLS panel when tlsRenewCaller is supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const caller: TlsRenewCaller = async () => SUCCESS_RESULT;
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: caller,
    });
    const server = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server');
    expect(server).not.toBeNull();
    // Section header "Server".
    const h2 = server?.children.find((c) => c.tagName === 'H2');
    expect(h2?.textContent).toBe('Server');
    // TLS panel mounted inside the section.
    const panel = findByAttr(host, TLS_RENEW_PANEL_ATTR);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute(TLS_RENEW_PANEL_STATE_ATTR)).toBe('idle');
    // Renew button present.
    expect(findByAttr(host, TLS_RENEW_RENEW_BTN_ATTR)).not.toBeNull();
    // Accessor returns the mount handle.
    expect(route.tlsRenewPanel()?.getState()).toBe('idle');
    route.dispose();
  });

  it('mounts the Server section + Reachability Doctor when external probe caller is supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      reachabilityExternalProbeCaller: async () => ({
        account_id: 'acct-1',
        hostname: 'alice.recued.cloud',
        detected_public_ip: '203.0.113.5',
        resolved_ips: ['203.0.113.5'],
        probed_at: 1_700_000_000_000,
        results: [],
      }),
    });

    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).not.toBeNull();
    expect(findByAttr(host, REACHABILITY_PANEL_ATTR)).not.toBeNull();
    expect(route.reachabilityPanel()).not.toBeNull();
    route.dispose();
  });

  it('threads tlsRenewCaller through — clicking renew calls the seam', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const callerLog: Array<{ reason?: string }> = [];
    const caller: TlsRenewCaller = async (input) => {
      callerLog.push(input);
      return SUCCESS_RESULT;
    };
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: caller,
    });
    const tls = route.tlsRenewPanel()!;
    tls.clickRenew();
    await tls.clickConfirm();
    expect(tls.getState()).toBe('done');
    expect(callerLog).toEqual([{}]);
    route.dispose();
  });

  it('threads onTlsRenewed through to the panel', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const renewed: Array<Extract<RotationResult, { ok: true }>> = [];
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
      onTlsRenewed: (r) => {
        renewed.push(r);
      },
    });
    const tls = route.tlsRenewPanel()!;
    tls.clickRenew();
    await tls.clickConfirm();
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toEqual(SUCCESS_RESULT);
    route.dispose();
  });

  it('threads `now` through for deterministic flip-time formatting', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const fixedNow = 1_799_396_000_000;
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
      now: () => fixedNow,
    });
    const tls = route.tlsRenewPanel()!;
    tls.clickRenew();
    await tls.clickConfirm();
    expect(tls.getState()).toBe('done');
    // The rendered flip-time contains the ISO + `~Nd` hint computed
    // against the injected `now`. We only check the hint shape since
    // ISO formatting is platform-stable.
    let foundHint = false;
    const walk = (n: FakeElement): void => {
      if (
        n.getAttribute('data-recued-tls-renew-rotated-at') !== null &&
        n.textContent.includes('in ~')
      ) {
        foundHint = true;
      }
      for (const c of n.children) walk(c);
    };
    walk(host);
    expect(foundHint).toBe(true);
    route.dispose();
  });

  it('bundle injects TLS_RENEW_PANEL_STYLES alongside the Privacy + primitive styles', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      // Caller omitted — styles are still bundled because the route
      // injects every section's CSS up-front so a hot-mount of the
      // section later picks them up without re-injection. Mirrors the
      // Privacy bundle: the styles ship regardless of whether the
      // crypto wiper / reloader / onCleared are supplied.
    });
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    expect(style.textContent).toContain(SETTINGS_ROUTE_STYLES.trim());
    expect(style.textContent).toContain(CLEAR_THIS_BROWSER_PANEL_STYLES.trim());
    expect(style.textContent).toContain(TLS_RENEW_PANEL_STYLES.trim());
    expect(style.textContent).toContain(REACHABILITY_PANEL_STYLES.trim());
  });

  it('dispose tears the TLS panel down + removes the Server section', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).not.toBeNull();
    route.dispose();
    expect(host.children.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Slice 113 — cert-pin overlap panel gated mount
// ──────────────────────────────────────────────────────────────────

const FIXED_NOW_113 = 1_799_000_000_000;
const FLIP_AT_FUTURE_113 = FIXED_NOW_113 + 3 * 24 * 60 * 60 * 1000;
const ACTIVE_PIN_STATE: WebclientCertPinState = {
  current_fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  next_fingerprint:
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  current_valid_until: FLIP_AT_FUTURE_113,
};

describe('D-148 § A.6.5 — bootstrapSettingsRoute: cert-pin overlap panel (slice 113)', () => {
  it('does NOT mount the cert-pin panel when certPinWatcher is omitted', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    expect(route.certPinStalePanel()).toBeNull();
    route.dispose();
  });

  it('mounts the Server section + cert-pin panel when only certPinWatcher is supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(ACTIVE_PIN_STATE);
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      certPinWatcher: watcher,
      now: () => FIXED_NOW_113,
    });
    // Server section header is present even without TLS renew caller.
    const server = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server');
    expect(server).not.toBeNull();
    const h2 = server?.children.find((c) => c.tagName === 'H2');
    expect(h2?.textContent).toBe('Server');
    // Cert-pin panel mounted, TLS panel absent.
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    expect(findByAttr(host, TLS_RENEW_PANEL_ATTR)).toBeNull();
    expect(route.certPinStalePanel()?.getViewState()).not.toBeNull();
    expect(route.tlsRenewPanel()).toBeNull();
    route.dispose();
    watcher.dispose();
  });

  it('mounts BOTH panels under one Server section when both inputs are supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(ACTIVE_PIN_STATE);
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      tlsRenewCaller: async () => SUCCESS_RESULT,
      certPinWatcher: watcher,
      now: () => FIXED_NOW_113,
    });
    // Both panels mounted inside a single Server section.
    const serverSections: FakeElement[] = [];
    const collectServer = (n: FakeElement): void => {
      if (n.getAttribute(SETTINGS_ROUTE_SECTION_ATTR) === 'server') {
        serverSections.push(n);
      }
      for (const c of n.children) collectServer(c);
    };
    collectServer(host);
    expect(serverSections).toHaveLength(1);
    expect(findByAttr(host, TLS_RENEW_PANEL_ATTR)).not.toBeNull();
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    expect(route.tlsRenewPanel()).not.toBeNull();
    expect(route.certPinStalePanel()).not.toBeNull();
    route.dispose();
    watcher.dispose();
  });

  it('bundle injects CERT_PIN_STALE_PANEL_STYLES alongside the other panel styles', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      // Bundle ships even without a watcher — the selectors scope to
      // the panel attribute, so the rules are inert without a mount.
    });
    expect(doc.styleTags).toHaveLength(1);
    const style = doc.styleTags[0]!;
    expect(style.textContent).toContain(CERT_PIN_STALE_PANEL_STYLES.trim());
  });

  it('re-renders the panel after a watcher.notify() transition', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      certPinWatcher: watcher,
      now: () => FIXED_NOW_113,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    watcher.notify(ACTIVE_PIN_STATE);
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    route.dispose();
    watcher.dispose();
  });

  it('dispose tears the cert-pin panel down + removes the Server section', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(ACTIVE_PIN_STATE);
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      certPinWatcher: watcher,
      now: () => FIXED_NOW_113,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    route.dispose();
    expect(host.children.length).toBe(0);
    watcher.dispose();
  });
});

// D-156 P8: the slice 129 (pair-mint panel) + slice 131 (devices-
// history list) describe blocks retired alongside their modules.
// Devices-section coverage now flows entirely through the D-156 P5
// "Devices roster" describe block below.

describe('D-148 P8 — slice 129 + 131 deletion marker', () => {
  it('Devices section pair-mint + history surface retired in D-156 P8', () => {
    expect(true).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// D-156 P5 — Devices roster + revoke
// ════════════════════════════════════════════════════════════════

describe('D-156 P5 — bootstrapSettingsRoute: Devices roster (pair.list + pair.revoke)', () => {
  it('does NOT mount the new Devices roster when only pairListCaller is supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      pairListCaller: async () => ({ devices: [] }),
      // pairRevokeCaller intentionally omitted.
    });
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'devices')).toBeNull();
    expect(route.devicesPage()).toBeNull();
    route.dispose();
  });

  it('mounts the Devices section + roster when both pairListCaller + pairRevokeCaller are supplied', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      pairListCaller: async () => ({ devices: [] }),
      pairRevokeCaller: async () => ({ ok: true as const }),
    });
    const devices = findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'devices');
    expect(devices).not.toBeNull();
    // The `renderDevicesPage` renderer supplies its own "Devices" section
    // title (via the rx-section primitive), so the route no longer stamps
    // a redundant section-level <h2> (would be a double heading).
    expect(devices?.children.find((c) => c.tagName === 'H2')).toBeUndefined();
    expect(route.devicesPage()).not.toBeNull();
    route.dispose();
    expect(host.children.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// D-187 §6 follow-on — Packs + Local tools graduated out of Settings
// into the top-level `#packs` route. The Settings route no longer mounts
// either section (nor the install-time cli grant dialog). The packs.* +
// cli.reachability callers are no longer accepted by bootstrapSettingsRoute
// (the option type dropped them), so this only guards the negative: even a
// fully-wired Settings route never stamps a Packs or Local tools section.
// Their behaviour is now covered by d-187-packs-route.test.ts.
// ════════════════════════════════════════════════════════════════

describe('D-187 §6 — bootstrapSettingsRoute: Packs + Local tools moved to #packs', () => {
  it('never mounts a Packs or Local tools section', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'packs')).toBeNull();
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'local-tools'),
    ).toBeNull();
    route.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// R26.4 Backup & Migration Unification (M1 slice 4) — the consolidated
// Backup & Recovery surface wiring.
//
// What were three independently-gated sibling blocks (recovery re-verify ·
// archive · passport) are now ONE surface: the three `archive*Caller`s are the
// spine; `passportExportCaller` rides alongside as the optional standalone
// "Export identity passport only" action. The section mounts iff the archive
// callers are wired; the recovery re-verify block + passport paste-import are
// retired.
// ════════════════════════════════════════════════════════════════

const archiveExport: ArchiveExportCaller = async () => ({ job_id: 'job-x' });
const archiveStatus: ArchiveStatusCaller = async () => ({
  state: 'done',
  bytes_written: 0,
  progress_pct: 100,
});
const archiveImport: ArchiveImportCaller = async () => ({
  manifest: {
    format_version: 1,
    schema_version: 1,
    exported_at: '',
    record_count: 0,
    tables: {},
    includes_blobs: false,
    includes_passport: false,
  },
  restored_at: null,
  realm: 'same',
});

const passportExport: ArchivePassportExportCaller = async (input) =>
  ({ passport: { profile: input.profile } }) as never;

const mountRoute = (
  extra: Partial<BootstrapSettingsRouteOptions>,
): { host: FakeElement; route: ReturnType<typeof bootstrapSettingsRoute> } => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const route = bootstrapSettingsRoute({
    root: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    localStore: createInMemoryWebclientLocalStore(),
    ...extra,
  });
  return { host, route };
};

const ARCHIVE_CALLERS = {
  archiveExportCaller: archiveExport,
  archiveStatusCaller: archiveStatus,
  archiveImportCaller: archiveImport,
} as const;

const sellerOverview = (): SellerOverview => ({
  settings: {
    default_grace_hours: 72,
    sender_mail_instance_id: null,
    status_policy_json: {},
    email_policy_json: {},
    llm_gateway_paid_ack_at: null,
    llm_gateway_paid_ack_version: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
  },
  counts: {
    tiers: 0,
    active_tiers: 0,
    customers: 0,
    active_customers: 0,
    grace_customers: 0,
    closed_customers: 0,
  },
  readiness: [
    {
      key: 'llm_gateway',
      state: 'needs_setup',
      label: 'LLM gateway',
      detail: 'Configure the route first.',
      href: '#settings/ai-models',
    },
  ],
  llm_gateway: {
    configured: false,
    config_readable: true,
    default_route: null,
    model_alias: null,
    paid_ack_at: null,
    paid_acknowledged: false,
  },
  tiers: [],
  customers: [],
  usage_rollups: [],
});

const sellerTier = (): SellerTier => ({
  tier_id: 'tier-1',
  door_id: 'door-mcp',
  lifecycle_source: 'manual',
  entitlement_key: 'consulting-basic',
  display_name: 'Consulting Basic',
  template_contract_id: 'contract-template-1',
  external_entitlement_id: null,
  usage_policy_json: {},
  pass_duration_seconds: null,
  customer_status_enabled_default: true,
  active: true,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

describe('D-196 S2 - Settings route Seller section: wiring', () => {
  it('omits Seller when the overview caller is absent', () => {
    const { host, route } = mountRoute({});
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'seller')).toBeNull();
    expect(route.sellerPage()).toBeNull();
    route.dispose();
  });

  it('mounts Seller when the overview caller is supplied', async () => {
    const { host, route } = mountRoute({
      sellerOverviewCaller: async () => sellerOverview(),
    });

    await route.sellerPage()?.whenLoaded();

    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'seller'),
    ).not.toBeNull();
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'seller'),
    ).not.toBeNull();
    expect(route.sellerPage()?.getState().phase).toBe('ready');
    expect(route.sellerPage()?.getState().subpage).toBeNull();
    expect(findByAttr(host, SELLER_DIRECTORY_ATTR)).not.toBeNull();
    expect(
      findByAttr(host, SELLER_PAGE_STATE_ATTR)?.getAttribute(
        SELLER_PAGE_STATE_ATTR,
      ),
    ).toBe('ready');
    route.dispose();
  });

  it('passes the addressable Seller sub-page through the Settings route', async () => {
    const { host, route } = mountRoute({
      initialSectionId: 'seller',
      initialSellerSubpage: 'customers',
      sellerOverviewCaller: async () => sellerOverview(),
    });

    await route.sellerPage()?.whenLoaded();

    expect(route.sellerPage()?.getState().subpage).toBe('customers');
    expect(findByAttr(host, SELLER_PAGE_SUBPAGE_ATTR)?.getAttribute(
      SELLER_PAGE_SUBPAGE_ATTR,
    )).toBe('customers');
    expect(findByAttrValue(host, SELLER_COLLECTION_LIST_ATTR, 'customers'))
      .not.toBeNull();
    route.dispose();
  });

  it('passes the optional Seller mail-list caller into the Seller page', async () => {
    let mailListCalls = 0;
    const { route } = mountRoute({
      initialSellerSubpage: 'setup',
      sellerOverviewCaller: async () => sellerOverview(),
      sellerMailListCaller: async () => {
        mailListCalls += 1;
        return {
          instances: [{
            slug: 'seller-smtp',
            send_capable: true,
            account_email: 'seller@example.com',
          }],
        };
      },
    });

    await route.sellerPage()?.whenLoaded();

    expect(mailListCalls).toBe(1);
    route.dispose();
  });

  it('passes the optional manual tier caller into the Seller page', async () => {
    const { host, route } = mountRoute({
      initialSellerSubpage: 'tiers',
      sellerOverviewCaller: async () => sellerOverview(),
      sellerManualTierUpsertCaller: async (input) => ({
        tier: {
          tier_id: input.tier_id,
          door_id: input.door_id,
          lifecycle_source: 'manual',
          entitlement_key: input.entitlement_key,
          display_name: input.display_name ?? 'Basic',
          template_contract_id: input.template_contract_id ?? 'ct_template_basic',
          external_entitlement_id: null,
          usage_policy_json: input.usage_policy_json ?? {},
          pass_duration_seconds: input.pass_duration_seconds ?? null,
          customer_status_enabled_default:
            input.customer_status_enabled_default === true,
          active: input.active !== false,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        overview: sellerOverview(),
      }),
    });

    await route.sellerPage()?.whenLoaded();

    expect(findByAttr(host, SELLER_TIER_FORM_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('passes the optional seller settings caller into the Seller page', async () => {
    const { host, route } = mountRoute({
      initialSellerSubpage: 'setup',
      sellerOverviewCaller: async () => sellerOverview(),
      sellerSettingsUpdateCaller: async () => ({
        settings: {
          ...sellerOverview().settings,
          default_grace_hours: 24,
        },
        overview: sellerOverview(),
      }),
    });

    await route.sellerPage()?.whenLoaded();

    expect(findByAttr(host, SELLER_SETTINGS_FORM_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('passes the optional manual tier bulk-adjust caller into the Seller page', async () => {
    const { host, route } = mountRoute({
      initialSellerSubpage: 'tiers',
      initialSellerItemId: 'tier-1',
      sellerOverviewCaller: async () => ({
        ...sellerOverview(),
        tiers: [sellerTier()],
        counts: {
          tiers: 1,
          active_tiers: 1,
          customers: 0,
          active_customers: 0,
          grace_customers: 0,
          closed_customers: 0,
        },
      }),
      sellerManualTierBulkAdjustCaller: async () => ({
        tier: sellerTier(),
        adjusted_customers: [],
        skipped_closed_customers: [],
        overview: {
          ...sellerOverview(),
          tiers: [sellerTier()],
        },
      }),
    });

    await route.sellerPage()?.whenLoaded();

    expect(findByAttr(host, SELLER_TIER_BULK_ADJUST_FORM_ATTR)).not.toBeNull();
    route.dispose();
  });

  it('passes the optional manual customer caller into the Seller page', async () => {
    const { host, route } = mountRoute({
      initialSellerSubpage: 'customers',
      initialSellerItemId: 'customer-1',
      sellerOverviewCaller: async () => ({
        ...sellerOverview(),
        tiers: [sellerTier()],
        counts: {
          tiers: 1,
          active_tiers: 1,
          customers: 1,
          active_customers: 1,
          grace_customers: 0,
          closed_customers: 0,
        },
        customers: [{
          customer_id: 'customer-1',
          lifecycle_source: 'manual',
          source_customer_id: 'manual-cus-1',
          door_id: 'door-mcp',
          email: null,
          tier_id: 'tier-1',
          contract_id: 'contract-customer-1',
          inbound_token_id: 'token-1',
          mcp_token_id: 'token-1',
          external_subscription_id: null,
          source_status: 'paid',
          current_period_end: null,
          grace_until: null,
          access_state: 'active',
          claim_email_sent_at: null,
          claim_email_marker: null,
          status_email_sent_at: null,
          status_email_marker: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        }],
      }),
      sellerManualCustomerIssueCaller: async (input) => ({
        result: 'created',
        customer: {
          customer_id: 'customer-1',
          lifecycle_source: 'manual',
          source_customer_id: input.source_customer_id,
          door_id: input.door_id,
          email: input.email ?? null,
          tier_id: 'tier-1',
          contract_id: 'contract-customer-1',
          inbound_token_id: 'token-1',
          mcp_token_id: 'token-1',
          external_subscription_id: null,
          source_status: input.source_status ?? null,
          current_period_end: input.current_period_end ?? null,
          grace_until: null,
          access_state: 'active',
          claim_email_sent_at: null,
          claim_email_marker: null,
          status_email_sent_at: null,
          status_email_marker: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        claim: null,
        claim_email_delivery: null,
        overview: {
          ...sellerOverview(),
          tiers: [sellerTier()],
        },
      }),
      sellerManualCustomerExtendCaller: async (input) => ({
        customer: {
          customer_id: input.customer_id ?? 'customer-1',
          lifecycle_source: 'manual',
          source_customer_id: 'manual-cus-1',
          door_id: 'door-mcp',
          email: input.email ?? null,
          tier_id: 'tier-1',
          contract_id: 'contract-customer-1',
          inbound_token_id: 'token-1',
          mcp_token_id: 'token-1',
          external_subscription_id: null,
          source_status: input.source_status ?? null,
          current_period_end: input.current_period_end ?? null,
          grace_until: null,
          access_state: 'active',
          claim_email_sent_at: null,
          claim_email_marker: null,
          status_email_sent_at: null,
          status_email_marker: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        overview: {
          ...sellerOverview(),
          tiers: [sellerTier()],
          customers: [{
            customer_id: 'customer-1',
            lifecycle_source: 'manual',
            source_customer_id: 'manual-cus-1',
            door_id: 'door-mcp',
            email: null,
            tier_id: 'tier-1',
            contract_id: 'contract-customer-1',
            inbound_token_id: 'token-1',
            mcp_token_id: 'token-1',
            external_subscription_id: null,
            source_status: input.source_status ?? null,
            current_period_end: input.current_period_end ?? null,
            grace_until: null,
            access_state: 'active',
            claim_email_sent_at: null,
            claim_email_marker: null,
            status_email_sent_at: null,
            status_email_marker: null,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
          }],
        },
      }),
      sellerManualCustomerSwapTierCaller: async (input) => ({
        customer: {
          customer_id: input.customer_id ?? 'customer-1',
          lifecycle_source: 'manual',
          source_customer_id: 'manual-cus-1',
          door_id: 'door-mcp',
          email: null,
          tier_id: 'tier-1',
          contract_id: 'contract-customer-1',
          inbound_token_id: 'token-1',
          mcp_token_id: 'token-1',
          external_subscription_id: null,
          source_status: input.source_status ?? null,
          current_period_end: input.current_period_end ?? null,
          grace_until: null,
          access_state: 'active',
          claim_email_sent_at: null,
          claim_email_marker: null,
          status_email_sent_at: null,
          status_email_marker: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        overview: sellerOverview(),
      }),
      sellerManualCustomerCloseCaller: async (input) => ({
        customer: {
          customer_id: input.customer_id ?? 'customer-1',
          lifecycle_source: 'manual',
          source_customer_id: 'manual-cus-1',
          door_id: 'door-mcp',
          email: null,
          tier_id: 'tier-1',
          contract_id: 'contract-customer-1',
          inbound_token_id: 'token-1',
          mcp_token_id: 'token-1',
          external_subscription_id: null,
          source_status: input.source_status ?? null,
          current_period_end: null,
          grace_until: null,
          access_state: 'closed',
          claim_email_sent_at: null,
          claim_email_marker: null,
          status_email_sent_at: null,
          status_email_marker: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
        overview: sellerOverview(),
      }),
    });

    await route.sellerPage()?.whenLoaded();

    expect(findByAttr(host, SELLER_CUSTOMER_FORM_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR)).not.toBeNull();
    route.dispose();
  });
});

describe('R26.4 M1 — consolidated Backup & Recovery surface: wiring', () => {
  it('no archive callers → no backup section, accessor null', () => {
    const { host, route } = mountRoute({});
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'backup')).toBeNull();
    expect(route.archiveBackupPanel()).toBeNull();
    route.dispose();
  });

  it('all three archive callers → section + the unified surface mounts', () => {
    const { host, route } = mountRoute({ ...ARCHIVE_CALLERS });
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'backup'),
    ).not.toBeNull();
    expect(findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR)).not.toBeNull();
    expect(route.archiveBackupPanel()).not.toBeNull();
    route.dispose();
  });

  it('partial archive (two of three callers) → surface does NOT mount', () => {
    const { host, route } = mountRoute({
      archiveExportCaller: archiveExport,
      archiveStatusCaller: archiveStatus,
      // archiveImportCaller deliberately omitted → spine incomplete
    });
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'backup')).toBeNull();
    expect(route.archiveBackupPanel()).toBeNull();
    route.dispose();
  });

  it('passport caller WITHOUT the archive spine → no section', () => {
    // The passport-export action is an adjunct to the archive spine; without it
    // there is no surface to host the action, so the whole section stays absent.
    const { host, route } = mountRoute({ passportExportCaller: passportExport });
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'backup')).toBeNull();
    expect(route.archiveBackupPanel()).toBeNull();
    route.dispose();
  });

  it('archive spine WITHOUT passport caller → surface mounts, no passport action', () => {
    const { host, route } = mountRoute({ ...ARCHIVE_CALLERS });
    expect(findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR)).not.toBeNull();
    // The standalone passport-export action is gated on the passport caller.
    expect(findByAttr(host, ARCHIVE_PASSPORT_START_BTN_ATTR)).toBeNull();
    route.dispose();
  });

  it('archive spine + passport caller → surface mounts WITH the passport action', () => {
    const { host, route } = mountRoute({
      ...ARCHIVE_CALLERS,
      passportExportCaller: passportExport,
    });
    expect(findByAttr(host, ARCHIVE_BACKUP_PANEL_ATTR)).not.toBeNull();
    expect(findByAttr(host, ARCHIVE_PASSPORT_START_BTN_ATTR)).not.toBeNull();
    expect(route.archiveBackupPanel()).not.toBeNull();
    route.dispose();
  });

  // M5 S2b — the route forwards `archiveRebindStash` into the panel as
  // `stashRebind`; a committing restore that returns a `rebind` invokes it.
  // This pins the settings-route → panel forwarding hop (the panel-level test
  // injects the seam directly + can't see whether the route threads it).
  it('forwards archiveRebindStash → panel stashRebind, invoked on a committing restore with a rebind', async () => {
    const KNOWN = generateRecoveryKey().mnemonic;
    const REBIND: ArchiveImportRebind = {
      token_id: 'tok-rebind',
      bearer: 'fresh-rebind-bearer',
      instance_id: 'inst-driving',
    };
    const emptyManifest = {
      format_version: 1 as const,
      schema_version: 1,
      exported_at: '',
      record_count: 0,
      tables: {},
      includes_blobs: false,
      includes_passport: false,
    };
    const importWithRebind: ArchiveImportCaller = async (input) =>
      input.dry_run
        ? { manifest: emptyManifest, restored_at: null, realm: 'same' }
        : { manifest: emptyManifest, restored_at: 1, realm: 'same', rebind: REBIND };
    const stashed: ArchiveImportRebind[] = [];
    const { route } = mountRoute({
      archiveExportCaller: archiveExport,
      archiveStatusCaller: archiveStatus,
      archiveImportCaller: importWithRebind,
      archiveRebindStash: async (r) => {
        stashed.push(r);
      },
    });
    const panel = route.archiveBackupPanel();
    expect(panel).not.toBeNull();
    panel!.clickRestore();
    panel!.setRestorePath('/data/exports/x.recued.archive');
    panel!.setRestoreMnemonic(KNOWN);
    await panel!.clickPreview();
    expect(panel!.getView()).toBe('restore-preview');
    panel!.setArmed(true);
    await panel!.clickCommit();
    expect(stashed).toEqual([REBIND]);
    expect(panel!.getView()).toBe('restore-committed');
    route.dispose();
  });
});
