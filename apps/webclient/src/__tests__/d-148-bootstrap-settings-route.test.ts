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

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  bootstrapSettingsRoute,
  type BootstrapSettingsRouteOptions,
  SETTINGS_ROUTE_ACTIVE_ATTR,
  SETTINGS_ROUTE_DATA_LINK_ATTR,
  SETTINGS_ROUTE_PRIVACY_DIRECTORY_ATTR,
  SETTINGS_ROUTE_PRIVACY_TRANSPARENCY_ATTR,
  SETTINGS_ROUTE_PRIVACY_LEARNING_ATTR,
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
import {
  AI_MODELS_CHAT_SETUP_ATTR,
  AI_MODELS_MODEL_PREF_BUTTON_ATTR,
} from '../settings/ai-models-page.js';
import {
  UPDATES_PAGE_STYLES,
  UPDATES_ROLLBACK_BTN_ATTR,
  UPDATES_APPLY_BTN_ATTR,
} from '../settings/updates-page.js';
import type {
  TransparencyPrefsGetCaller,
  TransparencyPrefsSetCaller,
} from '../settings/transparency-panel.js';
import {
  LEARNING_PANEL_CASE_ATTR,
  LEARNING_PANEL_STYLES,
  LEARNING_PANEL_CASES_ATTR,
  LEARNING_PANEL_DRAFT_ATTR,
  LEARNING_PANEL_DRAFT_CONFIRM_ATTR,
  LEARNING_PANEL_FORGET_ATTR,
  type LearningCaseForgetCaller,
  type LearningCasesListCaller,
  type LearningDraftRecipeCaller,
  type LearningPrefsGetCaller,
  type LearningPrefsSetCaller,
} from '../settings/learning-panel.js';
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
  AccountBindResult,
  ArchiveImportRebind,
  RotationResult,
  SellerOverview,
  SellerTier,
  UpdateRollbackResponse,
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
  keydown(key: string): void;
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
    keydown: (key) => {
      const event = {
        target: el,
        key,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      const arr = listeners.get('keydown') ?? [];
      for (const fn of arr) fn(event);
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

  it('aggregates an unresolved AI model selection into the Settings leave guard', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let resolvePreference!: (value: {
      source_id: 'free_pool';
      updated_at: number;
    }) => void;
    const preferenceWrite = new Promise<{
      source_id: 'free_pool';
      updated_at: number;
    }>((resolve) => {
      resolvePreference = resolve;
    });
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'ai-models',
      aiModelsDefaultModelPrefGetCaller: async () => ({
        source_id: 'slot_1',
        updated_at: 1,
      }),
      aiModelsDefaultModelPrefSetCaller: () => preferenceWrite,
      aiModelsGetLLMConfigCaller: async () => ({
        config: {
          slot_1: {
            provider: 'openai',
            model: 'gpt-4.1-mini',
            has_key: true,
            speed: 'fast',
            supports_json: true,
          },
          free_pool: [{
            id: 'free-test',
            type: 'api',
            provider: 'openai',
            model: 'gpt-4.1-mini',
            has_key: true,
            speed: 'fast',
            supports_json: true,
            enabled: true,
          }],
        },
      }),
    });
    await route.aiModelsPage()!.whenLoaded();
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();

    findByAttrValue(host, AI_MODELS_MODEL_PREF_BUTTON_ATTR, 'free_pool')!.click();
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'An AI model setting is still updating. Leave Settings anyway?',
    );

    resolvePreference({ source_id: 'free_pool', updated_at: 2 });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
    route.dispose();
  });

  it('aggregates an unresolved account binding into the Settings leave guard', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let bound = false;
    let resolveBind!: (value: AccountBindResult) => void;
    const bindingWrite = new Promise<AccountBindResult>((resolve) => {
      resolveBind = resolve;
    });
    const binding = {
      account_id: 'acct-1',
      publisher_handle: 'mary',
      server_fingerprint: 'sha256:server',
      bound_at: 1_700_000_000_000,
    };
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'account',
      accountBindingStatusCaller: async () => bound
        ? { status: 'bound', binding }
        : { status: 'unbound', binding: null },
      accountBindCaller: () => bindingWrite,
      accountUnbindCaller: async () => ({ outcome: 'not_bound' }),
      accountProConvenienceStatusCaller: async () => ({
        entitlement: 'unbound',
        items: {
          handle: { state: 'awaiting-server', detail: 'no_binding' },
          ddns: { state: 'awaiting-server', detail: 'no_binding' },
          acme: { state: 'awaiting-server', detail: 'no_binding' },
        },
      }),
      accountBindingTokenMintCaller: async () => ({
        binding_token: 'binding-token-1',
        expires_at: 1_700_000_060_000,
      }),
    });
    const panel = route.accountBindingPanel()!;
    await panel.whenLoaded();
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();

    const pending = panel.connect();
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'An account setting is still updating. Leave Settings anyway?',
    );

    bound = true;
    resolveBind({ outcome: 'bound', binding });
    await pending;
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
    route.dispose();
  });

  it('aggregates an unresolved server rollback into the Settings leave guard', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let resolveRollback!: (value: UpdateRollbackResponse) => void;
    const rollback = new Promise<UpdateRollbackResponse>((resolve) => {
      resolveRollback = resolve;
    });
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'updates',
      updateCheckCaller: async () => ({
        status: 'up-to-date',
        current_version: '26.8.0',
        channel: 'stable',
      }),
      updateRollbackCaller: () => rollback,
    });
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();

    findByAttr(host, UPDATES_ROLLBACK_BTN_ATTR)!.click();
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'A server update change is still in progress. Leave Settings anyway?',
    );

    resolveRollback({ status: 'refused' });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
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
    expect(serverItem.scrollIntoViewCalls).toEqual([
      { block: 'nearest', inline: 'nearest' },
    ]);
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
      learningPrefsGetCaller:
        (async () => ({ prefs: {} })) as unknown as LearningPrefsGetCaller,
      learningPrefsSetCaller:
        (async () => ({ prefs: {} })) as unknown as LearningPrefsSetCaller,
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

    // D-219 slice 9c — Learning sits beside Transparency inside Privacy. ⛔ The
    // panel module having a test of its own proves nothing about the ROUTE
    // mounting it: this is the seam, and the accessor below is how a host
    // reaches it.
    expect(
      findByAttr(privacy, SETTINGS_ROUTE_PRIVACY_LEARNING_ATTR),
    ).not.toBeNull();
    expect(route.learningPanel()).not.toBeNull();

    // The "This browser" wipe panel still mounts (accessor stays live).
    expect(route.clearThisBrowserPanel().getState()).toBe('idle');

    route.dispose();
  });

  it('Server splits into Connect a device + Certificates sub-tabs; the TLS panel lives under Certificates', () => {
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

    // ⛔ NO REACHABILITY TAB. It was a destination for a diagnostic, mounted
    // only for probe-havers, and half its content had no producer.
    expect(findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'reachability'))
      .toBeNull();
    const certsTab = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_ATTR,
      'certificates',
    );
    expect(certsTab).not.toBeNull();
    expect(certsTab!.parent?.getAttribute('role')).toBe('tablist');
    expect(certsTab!.parent?.getAttribute('aria-label')).toBe(
      'Server sections',
    );
    // ⚠ D-272 — `connect-device` now LEADS the Server tabs, so it holds the
    // keyboard stop on a cold load and certificates does not. It is the first
    // question a beginner has ("port 7717, now what?") and the only Server tab
    // that needs no caller, so it always mounts.
    const connectTab = findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'connect-device');
    expect(connectTab).not.toBeNull();
    expect(connectTab!.getAttribute('tabindex')).toBe('0');
    expect(certsTab!.getAttribute('tabindex')).toBe('-1');

    const certsPanel = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_PANEL_ATTR,
      'certificates',
    )!;
    expect(certsTab!.getAttribute('aria-controls')).toBe(
      certsPanel.getAttribute('id'),
    );
    expect(certsPanel.getAttribute('role')).toBe('tabpanel');
    expect(certsPanel.getAttribute('aria-labelledby')).toBe(
      certsTab!.getAttribute('id'),
    );
    // First sub-tab (connect-device) active; certificates hidden until clicked.
    expect(certsPanel.getAttribute('data-active')).toBe('false');
    // The TLS renew panel is mounted inside the Certificates sub-tab panel.
    expect(findByAttr(certsPanel, TLS_RENEW_PANEL_ATTR)).not.toBeNull();

    certsTab!.click();
    expect(certsPanel.getAttribute('data-active')).toBe('true');
    expect(certsTab!.getAttribute('tabindex')).toBe('0');
    expect(connectTab!.getAttribute('tabindex')).toBe('-1');
    route.dispose();
  });

  it('gives Server sub-tabs one keyboard stop with wraparound and Home/End activation', () => {
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
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
    const certificates = findByAttrValue(
      host,
      SETTINGS_ROUTE_SUBTAB_ATTR,
      'certificates',
    )!;

    // ⚠ TWO tabs now: connect-device / certificates. Reachability is gone, and
    // wraparound is asserted against the REAL set rather than a remembered
    // count — the strip's whole contract is that it wraps whatever is mounted,
    // which is exactly the property a hard-coded three would have hidden.
    const connect = findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'connect-device')!;

    connect.keydown('ArrowRight');
    expect(certificates.getAttribute('aria-selected')).toBe('true');
    expect(certificates.getAttribute('tabindex')).toBe('0');
    expect(certificates.focusCalls).toEqual([undefined]);

    certificates.keydown('ArrowRight'); // wraps past the end
    expect(connect.getAttribute('aria-selected')).toBe('true');

    connect.keydown('End');
    expect(certificates.getAttribute('aria-selected')).toBe('true');
    certificates.keydown('Home');
    expect(connect.getAttribute('aria-selected')).toBe('true');
    route.dispose();
  });

  it('activates an exact Server sub-tab deep link and safely falls back when it is stale', () => {
    const mount = (initialServerTabId: string) => {
      const host = makeFakeElement('div');
      const route = bootstrapSettingsRoute({
        root: host as unknown as HTMLElement,
        document: makeFakeDocument() as unknown as Document,
        localStore: createInMemoryWebclientLocalStore(),
        initialSectionId: 'server',
        initialServerTabId,
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
      return { host, route };
    };

    const exact = mount('certificates');
    expect(
      findByAttrValue(
        exact.host,
        SETTINGS_ROUTE_SUBTAB_ATTR,
        'certificates',
      )?.getAttribute('aria-selected'),
    ).toBe('true');
    exact.route.dispose();

    // A stale deep link falls back to the FIRST tab, which D-272 made
    // `connect-device` — the fallback tracks the strip's order, so this asserts
    // the order rather than a remembered name.
    const stale = mount('removed-tab');
    expect(
      findByAttrValue(
        stale.host,
        SETTINGS_ROUTE_SUBTAB_ATTR,
        'connect-device',
      )?.getAttribute('aria-selected'),
    ).toBe('true');
    stale.route.dispose();
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
    expect(style.textContent).toContain(UPDATES_PAGE_STYLES.trim());
    expect(SETTINGS_ROUTE_STYLES).toMatch(
      /data-recued-settings-nav-item\]\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(SETTINGS_ROUTE_STYLES).toMatch(
      /\.settings-subtab\s*\{[^}]*min-height:\s*36px/s,
    );
    // ⛔ D-219 — the panel's own test proves its rules are complete and
    // host-scoped; only THIS proves they reach the document. The Learning
    // section shipped unstyled because the constant did not exist at all, and
    // dropping this one line reproduces exactly that from the user's side.
    expect(style.textContent).toContain(LEARNING_PANEL_STYLES.trim());
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
  it('reports the full clear-this-browser lifecycle as in-flight work', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
    });
    const panel = route.clearThisBrowserPanel();

    panel.clickClear();
    const clearing = panel.clickConfirm();
    expect(route.hasInFlightWork()).toBe(true);
    await clearing;
    expect(route.hasInFlightWork()).toBe(false);
    route.dispose();
  });

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

  it('⛔ mounts the Server section on a probe caller, but NO Reachability tab', () => {
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

    // ⛔ THE SERVER SECTION STILL MOUNTS ON A PROBE CALLER — there is something
    // to check — but the reachability panel is GONE, deleted rather than left
    // as dead code with green tests. Its one live artefact is folded into
    // Connect a device as detail under an answer the reader already has.
    expect(findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')).not.toBeNull();
    expect(findByAttrValue(host, SETTINGS_ROUTE_SUBTAB_ATTR, 'reachability'))
      .toBeNull();
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
    // ⛔ The reachability panel's CSS is not bundled — the panel is DELETED,
    // shipping the CSS for a panel that never mounts is weight with no reader.
    expect(style.textContent).not.toContain('reachability-probe-table');
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
      initialSellerAddress: { kind: 'setup', section: 'defaults' },
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
      initialSellerAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
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
      initialSellerAddress: { kind: 'setup', section: 'defaults' },
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
      // The bulk adjustment is the tier record's own `customers` screen now.
      initialSellerAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
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

  it('keeps a polled backup job in-flight until it reaches a terminal state', async () => {
    let statusCalls = 0;
    const { route } = mountRoute({
      archiveExportCaller: archiveExport,
      archiveImportCaller: archiveImport,
      archiveStatusCaller: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { state: 'running', bytes_written: 1, progress_pct: 25 }
          : {
              state: 'done',
              bytes_written: 4,
              progress_pct: 100,
              path: '/data/exports/backup.recued.archive',
            };
      },
    });
    const panel = route.archiveBackupPanel()!;

    panel.clickBackup();
    panel.setExportMnemonic(generateRecoveryKey().mnemonic);
    await panel.clickStartBackup();
    expect(route.hasInFlightWork()).toBe(true);
    await panel.tickPoll();
    expect(route.hasInFlightWork()).toBe(false);
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

// ──────────────────────────────────────────────────────────────────
// D-219 item 2/2b — the Learning CASE callers reach the panel
// ──────────────────────────────────────────────────────────────────

/** ⛔ The panel's own test proves the panel; the route test above proves the
 *  BLOCK mounts. Neither proves the route forwards the three CASE callers into
 *  it — that forwarding is four conditional spreads, and dropping any one of
 *  them leaves every other test green while the owner sees a Learning section
 *  with no list, no Forget, or a draft button that hands back nothing.
 *
 *  So each assertion below is the input that would DO THE THING if its forward
 *  were gone: a list that renders a row, a two-tap that reaches the forget
 *  caller, a two-press that reaches the draft caller, and the confirmation copy
 *  arriving verbatim from the host rather than the panel. */
describe('bootstrapSettingsRoute: D-219 — Learning case callers reach the panel', () => {
  const entry = {
    case_id: 'case_alpha',
    request: ['send a weekly summary'],
    flows: [],
    shown_to_model: false,
    request_observations: 3,
    last_seen_at: 1_750_000_000_000,
  };
  const CONFIRMATION = 'This spends your model quota and needs your review.';

  const build = (): {
    host: FakeElement;
    route: ReturnType<typeof bootstrapSettingsRoute>;
    forgot: string[];
    drafted: Array<{ case_id: string; prompt: string }>;
    handed: Array<{ case_id: string; recipe: unknown }>;
  } => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const forgot: string[] = [];
    const drafted: Array<{ case_id: string; prompt: string }> = [];
    const handed: Array<{ case_id: string; recipe: unknown }> = [];
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      learningPrefsGetCaller:
        (async () => ({ prefs: {} })) as unknown as LearningPrefsGetCaller,
      learningPrefsSetCaller:
        (async () => ({ prefs: {} })) as unknown as LearningPrefsSetCaller,
      learningCasesListCaller:
        (async () => ({ cases: [entry] })) as unknown as LearningCasesListCaller,
      learningCaseForgetCaller: (async (args: { case_id: string }) => {
        forgot.push(args.case_id);
        return { ok: true };
      }) as unknown as LearningCaseForgetCaller,
      learningDraftRecipeCaller: (async (args: {
        case_id: string;
        prompt: string;
      }) => {
        drafted.push(args);
        return { ok: true, recipe: { recipe_id: 'drafted' }, issues: [] };
      }) as unknown as LearningDraftRecipeCaller,
      onLearningDraftReady: (draft: {
        case_id: string;
        recipe: unknown;
        request_aliased: boolean;
      }) => {
        handed.push({ case_id: draft.case_id, recipe: draft.recipe });
        return true;
      },
      learningDraftConfirmation: CONFIRMATION,
    } as unknown as BootstrapSettingsRouteOptions);
    return { host, route, forgot, drafted, handed };
  };

  it('forwards runCasesList — the route renders the learned case, not just the toggle', async () => {
    const { host, route } = build();
    await route.learningPanel()!.whenLoaded();
    // Without the forward `runCasesList` is undefined and `renderCases`
    // returns before creating the block at all.
    expect(findByAttr(host, LEARNING_PANEL_CASES_ATTR)).not.toBeNull();
    expect(
      findByAttrValue(host, LEARNING_PANEL_CASE_ATTR, 'case_alpha'),
    ).not.toBeNull();
    route.dispose();
  });

  it('forwards runCaseForget — two taps reach the host caller with the case id', async () => {
    const { host, route, forgot } = build();
    const panel = route.learningPanel()!;
    await panel.whenLoaded();
    const press = (): void => {
      findByAttrValue(host, LEARNING_PANEL_FORGET_ATTR, 'case_alpha')!.click();
    };
    press();
    // ⚠ Still nothing after ONE tap: the arm is what makes this a guard, and a
    // test that only checked the end state could not tell the two apart.
    expect(forgot).toEqual([]);
    press();
    await panel.whenForgetSettled();
    expect(forgot).toEqual(['case_alpha']);
    route.dispose();
  });

  it('forwards runDraftRecipe + onDraftReady + the confirmation copy', async () => {
    const { host, route, drafted, handed } = build();
    const panel = route.learningPanel()!;
    await panel.whenLoaded();
    const press = (): void => {
      findByAttrValue(host, LEARNING_PANEL_DRAFT_ATTR, 'case_alpha')!.click();
    };
    press();
    expect(drafted).toEqual([]);
    // The host's wording, verbatim — the panel is given the server's copy
    // rather than writing its own, so a surface that could paraphrase the cost
    // could also soften it.
    const confirm = findByAttrValue(
      host, LEARNING_PANEL_DRAFT_CONFIRM_ATTR, 'case_alpha',
    );
    expect(confirm?.textContent).toContain(CONFIRMATION);
    press();
    await panel.whenDraftSettled();
    expect(drafted.map((d) => d.case_id)).toEqual(['case_alpha']);
    expect(handed).toEqual([
      { case_id: 'case_alpha', recipe: { recipe_id: 'drafted' } },
    ]);
    route.dispose();
  });
});

describe('bootstrapSettingsRoute: the rail is addressable', () => {
  it('reports #settings/<section> as a pushed entry when the rail switches', () => {
    const writes: Array<[string, string]> = [];
    const { host, route } = mountRoute({
      onAddressChange: (hash, mode) => { writes.push([hash, mode]); },
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });

    // Mounting must NOT write — only a user's rail click is navigation.
    expect(writes).toEqual([]);

    findByAttrValue(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'server')!.click();
    expect(writes).toEqual([['#settings/server', 'push']]);
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')
        ?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR),
    ).toBe('true');
    route.dispose();
  });

  it('switches sections in place, and refuses an id it never registered', () => {
    const { host, route } = mountRoute({
      initialSectionId: 'server',
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    const activeIds = (): string[] =>
      ['privacy', 'server'].filter((id) =>
        findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, id)
          ?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR) === 'true');
    expect(activeIds()).toEqual(['server']);

    expect(route.navigateToSection('privacy')).toBe(true);
    expect(activeIds()).toEqual(['privacy']);

    // `null` is the bare `#settings` landing — the first registered section.
    expect(route.navigateToSection('server')).toBe(true);
    expect(route.navigateToSection(null)).toBe(true);
    expect(activeIds()).toEqual(['privacy']);

    // An unknown id changes nothing and says so, so the shell can re-mount.
    expect(route.navigateToSection('seller')).toBe(false);
    expect(activeIds()).toEqual(['privacy']);

    route.dispose();
    expect(route.navigateToSection('privacy')).toBe(false);
  });

  it('leaves the rail in-page when the host wires no address seam', () => {
    const { host, route } = mountRoute({
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    findByAttrValue(host, SETTINGS_ROUTE_NAV_ITEM_ATTR, 'server')!.click();
    expect(
      findByAttrValue(host, SETTINGS_ROUTE_SECTION_ATTR, 'server')
        ?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR),
    ).toBe('true');
    route.dispose();
  });
});

describe('D-257 — the async apply outcome reaches the Updates page', () => {
  /** ⛔⛔ THIS IS A COMPOSITION TEST ON PURPOSE. The bootstrap BUILT the
   *  `updateProgress` seam and the Updates page DECLARED the option, and both
   *  were individually correct — the settings route in between simply never
   *  declared or forwarded it, so nothing ever called `subscribe`. Every unit
   *  test on either side passed, because each hand-built its own options.
   *
   *  A test that passes `updateProgress` straight to `mountUpdatesPage` would
   *  pass with the route broken. It has to go THROUGH `bootstrapSettingsRoute`. */
  it('the route forwards updateProgress, so the page actually subscribes', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const subscribe = vi.fn(() => () => {});
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'updates',
      updateCheckCaller: async () => ({
        status: 'up-to-date',
        current_version: '26.8.0',
        channel: 'stable',
      }),
      updateProgress: { subscribe },
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    route.dispose();
  });

  it('a terminal FAILURE on the bus is surfaced, not silently completed', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    let emit: ((e: {
      phase: string;
      status?: string;
      detail?: string;
      operation_id?: string;
    }) => void) | null = null;
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'updates',
      updateCheckCaller: async () => ({
        status: 'update-available',
        current_version: '26.8.0',
        channel: 'stable',
        available: {
          version: '26.9.0',
          migration: false,
          is_major: false,
          below_min_supported: false,
          in_rollout_cohort: true,
          auto_apply_eligible: true,
          notes_url: '',
        },
      }),
      // The server accepts and returns immediately; the outcome comes later.
      updateApplyCaller: async () => ({ status: 'applying' }),
      updateProgress: {
        subscribe: (cb: (e: {
          phase: string;
          status?: string;
          detail?: string;
          operation_id?: string;
        }) => void) => {
          emit = cb as typeof emit;
          return () => {};
        },
      },
    } as unknown as Parameters<typeof bootstrapSettingsRoute>[0]);

    await Promise.resolve();
    const btn = findByAttr(host, UPDATES_APPLY_BTN_ATTR);
    if (btn) {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
      // Still pending: `applying` is not a terminal status, so the run owns the
      // controls until the bus says otherwise.
      expect(route.hasInFlightWork()).toBe(true);
    }

    expect(emit).not.toBeNull();
    emit!({ phase: 'result', status: 'stage-failed', detail: 'disk full' });
    await Promise.resolve();
    // The failure ended the run. Before the wiring existed the page had already
    // called this done at the rpc reply and would never have seen this at all.
    expect(route.hasInFlightWork()).toBe(false);
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// D-272 — the check from outside reaches Connect a device
// ──────────────────────────────────────────────────────────────────

describe('D-272 — the router step is answered by the reachability probe', () => {
  const probeResponse = (
    port: number,
    outcome: 'reachable' | 'blocked' | 'no_response',
  ) => ({
    account_id: 'acct-1',
    hostname: 'alice.recued.cloud',
    detected_public_ip: '203.0.113.5',
    resolved_ips: ['203.0.113.5'],
    probed_at: 1_700_000_000_000,
    results: [{
      kind: 'port_reachability' as const,
      status: outcome === 'reachable' ? ('pass' as const) : ('fail' as const),
      payload: { kind: 'port_reachability' as const, port, outcome },
    }],
  });

  /** ⛔ THE JOIN, NOT EITHER HALF. The fold is tested in the reachability suite
   *  and the button in the panel suite, each against a stub of the other side.
   *  What neither can see is whether this route hands the panel the probe at
   *  all — and a step that renders "we cannot tell" forever because nobody wired
   *  the caller looks exactly like the honest answer. */
  const mountRoute = (over: Partial<BootstrapSettingsRouteOptions> = {}) => {
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      ...over,
    } as BootstrapSettingsRouteOptions);
    // ⚠ LAST, not first. This fake's `innerHTML = ''` does not drop children, so
    // a re-rendered panel sits after the one it replaced; in a browser only the
    // new one exists. Reading the first would assert against the state BEFORE
    // the thing under test happened, and pass while nothing worked.
    //
    // ⛔⛔ AND "LAST MATCH IN THE HOST" CANNOT SAY "THIS RENDER HAS NONE." Taking
    // the last button anywhere under the host answers "what is the newest button
    // that ever existed", which is the same thing right up until a render stops
    // drawing one — then it hands back a button from a render that is gone, and
    // an `toBeUndefined()` fails against a stale node. Every query is scoped to
    // the CURRENT panel root instead, so absence is expressible.
    const currentPanel = (): FakeElement => {
      const panels = findAllByAttr(host, 'data-recued-connect-device-panel');
      return panels[panels.length - 1]!;
    };
    const routerStep = (): FakeElement => {
      const steps = findAllByAttr(currentPanel(), 'data-recued-connect-device-step-key')
        .filter((el) => el.getAttribute('data-recued-connect-device-step-key') === 'router');
      return steps[steps.length - 1]!;
    };
    const checkButton = (): FakeElement | undefined =>
      findAllByAttr(currentPanel(), 'data-recued-connect-device-check')[0];
    return {
      host,
      route,
      checkButton,
      routerDone: (): string | null =>
        routerStep().getAttribute('data-recued-connect-device-step-done'),
    };
  };

  it('⛔ with no probe wired the step stays UNKNOWN and offers no check', () => {
    // The state this shipped in. It must remain reachable: a self-hoster with no
    // account has nothing that may ask from outside. `tlsRenewCaller` is here
    // only to bring the Server section up — Connect a device needs no caller of
    // its own, but it lives inside a section that does.
    const m = mountRoute({ tlsRenewCaller: async () => SUCCESS_RESULT });
    expect(m.routerDone()).toBe('unknown');
    expect(m.checkButton()).toBeUndefined();
    m.route.dispose();
  });

  it('renders a verdict the composition root already holds', () => {
    const m = mountRoute({
      reachabilityExternalProbeCaller: async () => probeResponse(443, 'reachable'),
      reachabilityLastProbe: () => probeResponse(443, 'reachable'),
    });
    expect(m.routerDone()).toBe('true');
    m.route.dispose();
  });

  it('and the check ON THIS PAGE reaches the same caller', async () => {
    let calls = 0;
    let last: ReturnType<typeof probeResponse> | null = null;
    const m = mountRoute({
      reachabilityExternalProbeCaller: async () => {
        calls += 1;
        last = probeResponse(443, 'blocked');
        return last;
      },
      reachabilityLastProbe: () => last,
    });
    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    // ⛔ `false`, not `unknown` — the probe answered, and it said no. Leaving it
    // unknown after a real refusal would be as wrong as ticking it.
    expect(m.routerDone()).toBe('false');
    m.route.dispose();
  });

  it('⛔⛔ D-272 — the check asks about ONE port, and it is THIS card\'s port', async () => {
    // ⛔ A STUB PROVES THE CALL, NOT THE MESSAGE. Every other test here answers
    // the probe with `async () => probeResponse(...)`, which DISCARDS the
    // override — so all of them pass whether this route narrows or sends the
    // whole listener set. This one reads what the route actually said.
    //
    // 🔑 The cost is wall clock, and it lands on the wrong person:
    // `runDiagnosticChecks` walks ports sequentially under a 5s timeout each, so
    // four ports plus a TLS handshake is up to ~25s — paid in full by the reader
    // whose router DROPs, the one this button exists for.
    const overrides: Array<unknown> = [];
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:9100', kind: 'loopback' as const }],
        lan_port: 9100,
        public_port: 8446,
      }),
      reachabilityExternalProbeCaller: async (override?: unknown) => {
        overrides.push(override);
        return probeResponse(8446, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // ⚠ THE RESOLVED PORT, not a second hardcoded 443. The card and the request
    // read one number; asking about 443 while the card names 8446 would report
    // another port's answer under this one's label.
    expect(overrides).toEqual([{ ports: [8446], checks: ['port_reachability'] }]);
    m.route.dispose();
  });

  it('⛔⛔ D-272 — a public port the probe MAY NOT BE ASKED ABOUT offers no check', async () => {
    // ⛔ `normalizePorts` in the worker THROWS `diagnostic_port_not_allowed` on
    // the first port outside the allowlist — it does not drop it — so narrowing
    // to a port like 8443 turns an honest "nobody asked" into a 400 the card
    // would have to render as a failure. 8443 is D-148's pre-amendment `ws`
    // port, so it is a plausible `public_port`, not a contrived one.
    let calls = 0;
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
        lan_port: 7717,
        public_port: 8443,
      }),
      reachabilityExternalProbeCaller: async () => {
        calls += 1;
        return probeResponse(8443, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    expect(m.checkButton()).toBeUndefined();
    // ⛔ `unknown`, never `false`. Nobody asked, and nobody could have.
    expect(m.routerDone()).toBe('unknown');
    expect(calls).toBe(0);
    m.route.dispose();
  });

  it('⛔⛔ the REAL ports reach the panel, and the verdict follows them', async () => {
    // The join neither side can see. The panel suite proves it USES a resolved
    // port; this proves the route SUPPLIES one — and a card that silently kept
    // quoting 443 would look identical from either side alone.
    const asked: number[] = [];
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:9100', kind: 'loopback' as const }],
        lan_port: 9100,
        public_port: 8446,
      }),
      reachabilityExternalProbeCaller: async () => probeResponse(8446, 'reachable'),
      reachabilityLastProbe: () => {
        asked.push(8446);
        return probeResponse(8446, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    const hrefs = findAllByAttr(m.host, 'href')
      .map((el) => el.getAttribute('href'))
      .filter((h): h is string => h !== null && h.includes('/webclient/'));
    expect(hrefs.some((h) => h.includes(':9100'))).toBe(true);
    // ⛔ The router step ticks only because the verdict was read for 8446. Read
    // for 443 it would be `unknown`, since this response says nothing about 443.
    expect(m.routerDone()).toBe('true');
    m.route.dispose();
  });

  /** A server whose LAN listener the bind put on a public address — the shape
   *  that makes the LAN port worth asking the probe about. ⚠ The FINDING itself
   *  now renders on Exposure; what stays here is only whether the check action
   *  includes that port. */
  const exposedUrls = (publicPort: number) => async () => ({
    urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
    lan_port: 7717,
    public_port: publicPort,
    lan_exposure: {
      publicly_routable: true,
      wildcard: true,
      public_addresses: ['203.0.113.7'],
    },
  });

  it('⛔⛔ D-272 — ONE probe carries BOTH ports, each by its own rule', async () => {
    // ⛔ THE LITERAL THE ROUTE HARDCODES. Every other test here answers the probe
    // with `async () => probeResponse(...)`, DISCARDING the override — so all of
    // them pass whether this sends one port, two, or none. This reads what the
    // route actually said.
    //
    // 🔑 `ports` is the CLOSED allowlist and `extra_port` is the one bounded door
    // past it: `public_port` must pass the first rule, `lan_port` the second.
    // Naming the LAN port in `ports` would fail the whole request.
    const overrides: Array<unknown> = [];
    const m = mountRoute({
      networkLocalUrlsCaller: exposedUrls(443),
      reachabilityExternalProbeCaller: async (override?: unknown) => {
        overrides.push(override);
        return probeResponse(443, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(overrides).toEqual([{
      ports: [443],
      checks: ['port_reachability'],
      extra_port: 7717,
    }]);
    m.route.dispose();
  });

  it('⚠ D-272 — an UNEXPOSED LAN port is left out of the request', async () => {
    // Each extra port is another SEQUENTIAL 5s timeout for the reader whose
    // firewall drops. Asking whether the internet reaches a listener that is not
    // on a public address spends that for an answer already known.
    const overrides: Array<unknown> = [];
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
        lan_port: 7717,
        public_port: 443,
        lan_exposure: {
          publicly_routable: false, wildcard: true, public_addresses: [],
        },
      }),
      reachabilityExternalProbeCaller: async (override?: unknown) => {
        overrides.push(override);
        return probeResponse(443, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();
    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(overrides).toEqual([{ ports: [443], checks: ['port_reachability'] }]);
    m.route.dispose();
  });

  it('⛔⛔ D-272 — an exposed LAN port is still asked about when `public_port` is NOT', async () => {
    // 🔑 THE COUPLING THIS REPLACED, now inside one action: 8443 is off the
    // closed list so the router half cannot run, and the operator whose LAN
    // listener IS on a public address is the one most likely to be exposed.
    const overrides: Array<unknown> = [];
    const m = mountRoute({
      networkLocalUrlsCaller: exposedUrls(8443),
      reachabilityExternalProbeCaller: async (override?: unknown) => {
        overrides.push(override);
        return probeResponse(7717, 'reachable');
      },
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    expect(m.checkButton()).toBeDefined();
    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // ⛔ `ports` EMPTY — 8443 fails the allowlist, so it is simply not asked
    // about, and its verdict stays `null` rather than becoming a 400.
    expect(overrides).toEqual([{
      ports: [], checks: ['port_reachability'], extra_port: 7717,
    }]);
    m.route.dispose();
  });

  it('⛔ D-272 — nothing askable ⇒ NO REQUEST AT ALL', async () => {
    // A probe with no ports spends the rate limit and the reader's wait to learn
    // nothing.
    const overrides: Array<unknown> = [];
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
        lan_port: 7717,
        public_port: 8443,
        lan_exposure: {
          publicly_routable: false, wildcard: true, public_addresses: [],
        },
      }),
      reachabilityExternalProbeCaller: async (override?: unknown) => {
        overrides.push(override);
        return probeResponse(443, 'reachable');
      },
      addressFromHereChecker: async () => true,
      tlsDomainListCaller: async () => ({
        entries: [{
          domain: 'home.example.com', expires_at: Date.now() + 86_400_000,
          fingerprint: 'fp', issuer: 'test',
        }],
      }),
    } as unknown as Partial<BootstrapSettingsRouteOptions>);
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();
    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(overrides).toEqual([]);
    m.route.dispose();
  });

  it('⛔⛔ D-272 — the from-this-device check rides the SAME action', async () => {
    // One press, both mechanisms. The reader should not have to know which one
    // answers their question.
    const asked: string[] = [];
    const m = mountRoute({
      tlsRenewCaller: async () => SUCCESS_RESULT,
      tlsDomainListCaller: async () => ({
        entries: [{
          domain: 'home.example.com', expires_at: Date.now() + 86_400_000,
          fingerprint: 'fp', issuer: 'test',
        }],
      }),
      addressFromHereChecker: async (url: string) => { asked.push(url); return true; },
    } as unknown as Partial<BootstrapSettingsRouteOptions>);
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    // ⚠ NO probe caller at all — the free self-hoster with no account still
    // gets the action, because the browser-side half needs neither.
    m.checkButton()!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['https://home.example.com/webclient/']);
    m.route.dispose();
  });

  it('⛔ D-272 — with NO probe and NO address, no action is offered', async () => {
    // ⚠ The premise this test used to have — "no exposure, so no exposure
    // check" — stopped being the question when the three buttons became one.
    // The action is offered when ANY half can run, so "nothing to check" now
    // means no probe caller AND no certified address to try from here.
    const m = mountRoute({ tlsRenewCaller: async () => SUCCESS_RESULT });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();
    expect(m.checkButton()).toBeUndefined();
    m.route.dispose();
  });

  it('⛔ D-272 — and a server that does not send it produces NO warning', async () => {
    // Self-hosted, no deploy order: the field is optional on the wire. Absent
    // must render as "nobody said", never as a reassurance nobody earned.
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
        lan_port: 7717,
      }),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    await new Promise((r) => { setTimeout(r, 0); });
    await Promise.resolve();

    const notes = findAllByAttr(m.host, 'data-recued-connect-device-note')
      .map((el) => el.textContent ?? '');
    expect(notes.some((n) => n.includes('also open on'))).toBe(false);
    m.route.dispose();
  });

  it('⚠ a server too old to report ports still renders, on the fallbacks', async () => {
    // Self-hosted: no deploy order, so the fields are optional on the wire.
    const m = mountRoute({
      networkLocalUrlsCaller: async () => ({
        urls: [{ url: 'http://localhost:7717', kind: 'loopback' as const }],
      }),
      tlsRenewCaller: async () => SUCCESS_RESULT,
    });
    await new Promise((r) => { setTimeout(r, 0); });
    const hrefs = findAllByAttr(m.host, 'href')
      .map((el) => el.getAttribute('href'))
      .filter((h): h is string => h !== null && h.includes('/webclient/'));
    expect(hrefs.some((h) => h.includes(':7717'))).toBe(true);
    m.route.dispose();
  });

  it('⛔ a probe that answers about ANOTHER port leaves this one unknown', () => {
    // The fold's trap, asserted through the real wiring: a response full of
    // passing checks for 8446 says nothing about whether 443 gets through.
    const m = mountRoute({
      reachabilityExternalProbeCaller: async () => probeResponse(8446, 'reachable'),
      reachabilityLastProbe: () => probeResponse(8446, 'reachable'),
    });
    expect(m.routerDone()).toBe('unknown');
    m.route.dispose();
  });
});

describe('D-272 follow-on — Devices points at where a device gets added', () => {
  it('⛔ links to Connect a device rather than duplicating the flow', () => {
    // Devices says what IS paired; "how do I add another" is the same
    // question's other half, and it lives with its prerequisites — a
    // certificate, a forwarded port, an address that resolves. Duplicating the
    // flow here would let a reader follow it and fail on a prerequisite this
    // page never mentions.
    const host = makeFakeElement('div');
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      pairListCaller: async () => ({ devices: [] }),
      pairRevokeCaller: async () => ({ ok: true as const }),
    } as unknown as BootstrapSettingsRouteOptions);

    const link = findAllByAttr(host, 'data-recued-settings-devices-add-link')[0];
    expect(link).toBeDefined();
    const anchors = findAllByAttr(link!, 'href').map((el) => el.getAttribute('href'));
    // ⚠ `#settings/server/<tab>` is the documented deep-link shape, and
    // `connect-device` is the tab id — a link to a route that does not exist
    // would look right and go nowhere.
    expect(anchors).toContain('#settings/server/connect-device');
    route.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// D-273 — the port-mapping seam, wired end to end.
//
// ⛔⛔ THIS EXISTS BECAUSE THE READ HALF SHIPPED DEAD. `networkPortMappingCaller`
// was declared on the route's options, the projection behind it was written and
// commented, and NOTHING EVER SUPPLIED ONE — not the production bootstrap, not a
// test. The option is optional, so `tsc` was happy; the panel falls back to "no
// router was asked", so its tests were happy. An entire decision's worth of copy
// (the CGNAT warning, "your router has this switched off", "Recued opened this
// port", "you set that up yourself") was unreachable in the shipped app for as
// long as it existed.
//
// ⇒ The lesson is not "wire it" but that NO LAYER'S OWN TESTS CAN SEE THIS. Only
// a test that spans the layers can, so both halves are asserted here: the route
// really mounts the control when given the callers, and the composition root
// really builds and forwards them.
// ──────────────────────────────────────────────────────────────────
describe('D-273 — the port-mapping seam is wired end to end', () => {
  const mountServerRoute = (over: Partial<BootstrapSettingsRouteOptions> = {}) => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      initialSectionId: 'server',
      // Any one Server gate opens the section the panel lives in.
      tlsRenewCaller: async () => ({ ok: true }),
      ...over,
    } as BootstrapSettingsRouteOptions);
    return { host, route };
  };

  it('the route mounts the control when BOTH callers are supplied', async () => {
    const { host, route } = mountServerRoute({
      networkPortMappingCaller: async () => ({ enabled: false, support: 'enabled' }),
      networkAutoPortMappingSetCaller: async () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      findByAttrValue(host, 'data-recued-connect-device-step-action', 'port_mapping'),
    ).not.toBeNull();
    route.dispose();
  });

  it('⚠ and does NOT when the write caller is missing — the read alone is not a control', async () => {
    const { host, route } = mountServerRoute({
      networkPortMappingCaller: async () => ({ enabled: false, support: 'enabled' }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      findByAttrValue(host, 'data-recued-connect-device-step-action', 'port_mapping'),
    ).toBeNull();
    route.dispose();
  });

  it('⛔ the composition root BUILDS both callers off the right rpcs', () => {
    // Source-level on purpose: the defect was a missing forward in a composition
    // root, and every layer below it passed its own tests without one.
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'webclient-bootstrap.ts'),
      'utf-8',
    );
    expect(src).toContain("rpcConn.call('network.port_mapping', undefined)");
    // ⛔ The WRITE goes through the generic config rpc, keyed to this one field.
    // A second door to the same key is what this deliberately does not build.
    expect(src).toMatch(/rpcConn\.call\('server\.setConfigField', \{\s*key: 'network\.auto_port_mapping'/);
  });

  it('⛔⛔ and FORWARDS them — a built-but-unpassed caller is the exact bug', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'webclient-bootstrap.ts'),
      'utf-8',
    );
    // Word-boundary matches, not bare substrings: the declaration sites contain
    // these names too, so a test looking for the name alone stays green against
    // the very deletion it exists to catch.
    expect(src).toMatch(/^\s*networkPortMappingCaller,\s*$/m);
    expect(src).toMatch(/^\s*networkAutoPortMappingSetCaller:\s*$/m);
  });
});
