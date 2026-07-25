/** D-148 § A.4 — PWA-wide webclient bootstrap acceptance.
 *
 *  `bootstrapWebclient` composes pair-state hydration, the WS client,
 *  the broadcast subscriber, the typed rpc conn, the Reception shell,
 *  the URL-hash route discriminator, and the Reception route mount.
 *  These tests drive it through deterministic fakes for every seam:
 *
 *    - Fake `WebclientLocalStore` seeded with various pair-state shapes
 *      (paired / unpaired / partially paired).
 *    - Fake `WebclientTokenStore` whose `unwrap` echoes the record's
 *      `token_id` (so the resolver chain is observable).
 *    - Fake `WebclientWsTransport` that records `open()` calls + lets
 *      the test fire inbound messages.
 *    - Fake `WebclientHashSource` that supports `getHash` + manual
 *      `setHash` + listener firing.
 *    - Fake `Document` + `HTMLElement` (the same pattern as
 *      `d-149-settings-reception-bootstrap.test.ts`).
 *
 *  The acceptance surface covers:
 *
 *    - Pair-state hydration: paired ⇒ bootstrap succeeds + opens a
 *      WS connection; partially-paired ⇒ `WebclientUnpairedError`.
 *    - Route discriminator: `#reception` ⇒ Reception; `#unknown` ⇒
 *      Reception (the default); empty hash ⇒ Reception.
 *    - Route re-mount on hashchange to an unknown route.
 *    - Bearer resolution: WS client's `resolveBearer` calls
 *      `tokenStore.unwrap` with the active record (so a rotated
 *      token in the store is observed on reconnect).
 *    - Dispose tears down in reverse construction order: route mount
 *      removed, shell unsubscribed, conn rejects in-flight, ws
 *      transport closed.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  SellerOverview,
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import { RunModal } from '@recued/ui-shared';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from '../storage/token-store.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../realtime/ws-client.js';
import { CONNECTION_CHIP_ATTR } from '../shell/connection-indicator.js';
import { INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR } from '../kitchen/ingredient-builder/operation-family-table.js';
import { KITCHEN_ROUTE_TAB_ATTR } from '../kitchen/kitchen-route-chrome.js';
import {
  DATA_ROUTE_FORM_RESPONSE_RUN_ATTR,
  DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR,
  DATA_ROUTE_HOST_ATTR,
  DATA_ROUTE_LOGS_RETURN_ATTR,
  DATA_ROUTE_TAB_ATTR,
  DATA_ROUTE_VERIFICATION_ACTION_ATTR,
  DATA_ROUTE_VERIFICATION_NEXT_ATTR,
} from '../data/bootstrap-data-route.js';
import {
  RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
  RECIPE_EDITOR_RECIPE_ID_ATTR,
  RECIPE_EDITOR_SAVE_ATTR,
  RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
} from '../kitchen/recipe-editor/recipe-editor-route.js';
import { SERVER_PILL_HOST_ATTR } from '../shell/server-pill-host.js';
import {
  WEBCLIENT_DEFAULT_ROUTE,
  WEBCLIENT_ROUTE_IDS,
  WEBCLIENT_SHELL_CONTENT_ATTR,
  WEBCLIENT_SHELL_HOST_ATTR,
  WEBCLIENT_SHELL_ACCOUNT_ATTR,
  WEBCLIENT_SHELL_DRAWER_ACTION_ATTR,
  WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR,
  WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR,
  WEBCLIENT_SHELL_DRAWER_LINK_ATTR,
  WEBCLIENT_SHELL_DRAWER_OPEN_ATTR,
  WEBCLIENT_SHELL_DRAWER_STUB_ATTR,
  WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR,
  WEBCLIENT_SHELL_STYLES_MARKER,
  WebclientUnpairedError,
  bootstrapWebclient,
  deriveComposeReceptionStatusFromHostnames,
  parseRouteFromHash,
  type WebclientHashSource,
} from '../webclient-bootstrap.js';
import { WEBCLIENT_POLISH_STYLES } from '../shell/webclient-polish-styles.js';
import {
  ATTENTION_TOPBAR_HOST_ATTR,
} from '../attention/approval-attention-popover.js';
import {
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_PLAN_CONTINUE_ATTR,
  CHAT_ROUTE_PLAN_TARGET_ATTR,
} from '../chat/bootstrap-chat-route.js';
import {
  LOGS_ROUTE_CHAT_RETURN_ATTR,
  LOGS_ROUTE_HOST_ATTR,
} from '../logs/bootstrap-logs-route.js';
import {
  SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
  SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR,
  SELLER_CUSTOMER_FORM_FIELD_ATTR,
  SELLER_CUSTOMER_FORM_SUBMIT_ATTR,
  SELLER_OFFER_STATE_ACTION_ATTR,
  SELLER_SETTINGS_FORM_FIELD_ATTR,
  SELLER_SETTINGS_FORM_SUBMIT_ATTR,
  SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR,
} from '../settings/seller-page.js';

// ──────────────────────────────────────────────────────────────────
// Fake element / document — same shape as the reception-bootstrap
// tests; verbatim is fine because the route still mounts into them.
// ──────────────────────────────────────────────────────────────────

interface FakeElement extends HTMLElement {
  attrs: Map<string, string>;
  childList: FakeElement[];
  parentRef: FakeElement | null;
  value: string;
  fireAttributeClick(attrs: Record<string, string>): void;
  fireInput(value: string): void;
  /** Synthesize a delegated click on this element, matching the
   *  `createActionDispatcher` listener contract: the target carries
   *  the supplied dataset + its `closest()` returns itself. Used by
   *  the § A.6.5 banner integration tests to drive the bootstrap's
   *  banner mount through the same click path the production
   *  dispatcher follows. */
  fireClick(dataset: Record<string, string>): void;
}

const makeFakeElement = (tag: string): FakeElement => {
  let html = '';
  let textContent = '';
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const attrs = new Map<string, string>();
  const childList: FakeElement[] = [];
  const el: Partial<FakeElement> & { _ref?: FakeElement } = {
    tagName: tag.toUpperCase(),
    attrs,
    childList,
    parentRef: null,
    value: '',
    get children(): HTMLCollection {
      return childList as unknown as HTMLCollection;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
    },
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
    contains: (): boolean => true,
    setAttribute: (name: string, value: string): void => {
      attrs.set(name, value);
    },
    getAttribute: (name: string): string | null => attrs.get(name) ?? null,
    hasAttribute: (name: string): boolean => attrs.has(name),
    removeAttribute: (name: string): void => {
      attrs.delete(name);
    },
    appendChild: ((child: FakeElement): FakeElement => {
      childList.push(child);
      child.parentRef = el as FakeElement;
      return child;
    }) as unknown as HTMLElement['appendChild'],
    // Slice 114 — cert-pin panel's `clearChildren()` walks `firstChild`
    // + `removeChild`; without these the wrapper accumulates stale
    // panel elements across re-renders.
    get firstChild(): FakeElement | null {
      return childList[0] ?? null;
    },
    removeChild: ((target: FakeElement): FakeElement => {
      const idx = childList.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      childList.splice(idx, 1);
      target.parentRef = null;
      return target;
    }) as unknown as HTMLElement['removeChild'],
    remove: (): void => {
      if (el.parentRef !== null && el.parentRef !== undefined) {
        const idx = el.parentRef.childList.indexOf(el as FakeElement);
        if (idx >= 0) el.parentRef.childList.splice(idx, 1);
      }
      el.parentRef = null;
    },
    fireClick: (dataset: Record<string, string>): void => {
      const click = listeners.click;
      if (!click) return;
      const target = {
        dataset,
        getAttribute: (name: string): string | null => {
          if (!name.startsWith('data-')) return null;
          const key = name
            .slice('data-'.length)
            .replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
          return dataset[key] ?? null;
        },
        closest: (): unknown => target,
      } as unknown as HTMLElement;
      for (const fn of [...click]) {
        fn({ target, preventDefault: (): void => {} } as unknown as Event);
      }
    },
    fireAttributeClick: (targetAttrs: Record<string, string>): void => {
      const click = listeners.click;
      if (!click) return;
      const target = {
        getAttribute: (name: string): string | null => targetAttrs[name] ?? null,
        closest: (selector: string): unknown => {
          const match = selector.match(/^\[([\w-]+)\]$/);
          return match !== null && targetAttrs[match[1]!] !== undefined
            ? target
            : null;
        },
      } as unknown as HTMLElement;
      for (const fn of [...click]) {
        fn({ target, preventDefault: (): void => {} } as unknown as Event);
      }
    },
    fireInput: (value: string): void => {
      (el as FakeElement & { value: string }).value = value;
      for (const fn of [...listeners.input ?? []]) {
        fn({ target: el as FakeElement } as unknown as Event);
      }
    },
    // Slice 110 — the settings route's Privacy panel uses native
    // `click()` rather than the delegated `data-action` dispatcher
    // (each rendered state's buttons attach their own listener).
    // Standard DOM contract: `.click()` fires every `click` listener
    // with the element itself as `target`. Distinct from `fireClick`
    // above which threads a synthesised dataset for the delegated path.
    click: (): void => {
      const arr = listeners.click;
      if (!arr) return;
      for (const fn of [...arr]) {
        fn({ target: el as FakeElement, preventDefault: (): void => {} } as unknown as Event);
      }
    },
  };
  return el as FakeElement;
};

interface FakeDocument extends Document {
  styleElements: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleElements: FakeElement[] = [];
  // The D-188 controllable server pill registers outside-click (capture-phase)
  // + Escape listeners on the document and removes them on dispose; store them
  // so add/remove is symmetric and neither throws.
  const docListeners: Record<string, Set<(event: Event) => void>> = {};
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    if (m === null) return null;
    return { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  const head: Partial<HTMLHeadElement> = {
    querySelector: (selector: string): FakeElement | null => {
      const parsed = matchSelector(selector);
      if (parsed === null) return null;
      return (
        styleElements.find((s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr)) ?? null
      );
    },
    appendChild: ((el: FakeElement): FakeElement => {
      styleElements.push(el);
      return el;
    }) as unknown as HTMLHeadElement['appendChild'],
  };
  const doc: Partial<FakeDocument> = {
    head: head as HTMLHeadElement,
    styleElements,
    // Real-DOM semantics: a created element's `ownerDocument` is its creator.
    // The D-188 pill reaches back through `host.ownerDocument.createElement(...)`
    // to build its anchor + popover host, so every element the shell mints via
    // this document must carry the back-reference (else `createElement` on
    // `undefined` throws and the whole bootstrap dies at pill mount).
    createElement: ((tag: string): FakeElement => {
      const el = makeFakeElement(tag);
      (el as { ownerDocument: Document }).ownerDocument = doc as FakeDocument;
      return el;
    }) as unknown as FakeDocument['createElement'],
    addEventListener: ((evt: string, fn: (event: Event) => void): void => {
      (docListeners[evt] ??= new Set()).add(fn);
    }) as unknown as Document['addEventListener'],
    removeEventListener: ((evt: string, fn: (event: Event) => void): void => {
      docListeners[evt]?.delete(fn);
    }) as unknown as Document['removeEventListener'],
  };
  return doc as FakeDocument;
};

// ──────────────────────────────────────────────────────────────────
// Fake local store — pair-state holder.
// ──────────────────────────────────────────────────────────────────

const sampleToken = (token_id = 'tok-abc'): WebclientTokenRecord => ({
  token_id,
  ciphertext_b64: 'ZmFrZS1jaXBoZXJ0ZXh0', // base64('fake-ciphertext')
  iv_b64: 'ZmFrZS1pdg==', // base64('fake-iv')
  issued_at: 1_700_000_000_000,
});

const buildPairedStore = (
  overrides?: Partial<WebclientLocalStorage>,
): WebclientLocalStore => {
  const data: Partial<WebclientLocalStorage> = {
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-base64',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: 1_700_000_000_000,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
    },
    cert_pin_state: null,
    ...overrides,
  };
  const store: WebclientLocalStore = {
    async get<K extends WebclientLocalKey>(key: K) {
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      (data as Record<string, unknown>)[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
    async inspect() {
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
    },
  };
  return store;
};

const buildUnpairedStore = (): WebclientLocalStore =>
  buildPairedStore({
    server_url: null,
    webclient_token: null,
    server_public_key: null,
  });

// ──────────────────────────────────────────────────────────────────
// Fake token store — `unwrap` echoes "bearer-<token_id>".
// ──────────────────────────────────────────────────────────────────

interface FakeTokenStoreControls {
  store: WebclientTokenStore;
  unwrapCalls(): Array<{ record_id: string; aad: WebclientTokenAad }>;
}

const buildFakeTokenStore = (): FakeTokenStoreControls => {
  const calls: Array<{ record_id: string; aad: WebclientTokenAad }> = [];
  return {
    store: {
      async wrap() {
        throw new Error('not used');
      },
      async unwrap(record, aad) {
        calls.push({ record_id: record.token_id, aad });
        return `bearer-${record.token_id}`;
      },
    },
    unwrapCalls: () => calls.slice(),
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake WS transport.
// ──────────────────────────────────────────────────────────────────

interface FakeTransportControls {
  transport: WebclientWsTransport;
  openCount(): number;
  lastOpenArgs(): { server_url: string; bearer: string } | null;
  closeCount(): number;
  fireState(state: WebclientWsState): void;
  fireMessage(message: unknown): void;
  /** Slice 111 — every send through the transport gets recorded so
   *  rpc-dispatch tests can assert which method names traveled the
   *  wire without subclassing the conn. The bootstrap composes its
   *  own `tls.renew` caller from the conn; this accessor verifies
   *  the composition reaches `transport.send`. */
  sendCalls(): unknown[];
}

const buildFakeTransport = (): FakeTransportControls => {
  let opens = 0;
  let closes = 0;
  let last: { server_url: string; bearer: string } | null = null;
  const sends: unknown[] = [];
  const states = new Set<(s: WebclientWsState) => void>();
  const messages = new Set<(m: unknown) => void>();
  return {
    transport: {
      async open(args) {
        opens += 1;
        last = args;
        // Drive the state to `connected` synchronously to mirror the
        // production transport's handshake-complete signal.
        for (const l of [...states]) l('connected');
      },
      async close() {
        closes += 1;
      },
      async send(payload) {
        sends.push(payload);
      },
      onMessage(listener) {
        messages.add(listener);
        return () => messages.delete(listener);
      },
      onState(listener) {
        states.add(listener);
        return () => states.delete(listener);
      },
    },
    openCount: () => opens,
    lastOpenArgs: () => last,
    closeCount: () => closes,
    fireState: (state) => {
      for (const l of [...states]) l(state);
    },
    fireMessage: (msg) => {
      for (const l of [...messages]) l(msg);
    },
    sendCalls: () => sends.slice(),
  };
};

// ──────────────────────────────────────────────────────────────────
// Fake hash source.
// ──────────────────────────────────────────────────────────────────

interface FakeHashSource extends WebclientHashSource {
  setHash(hash: string): void;
  listenerCount(): number;
}

const buildFakeHashSource = (initial = ''): FakeHashSource => {
  let current = initial;
  const listeners = new Set<(h: string) => void>();
  return {
    getHash: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHash(hash) {
      current = hash;
      for (const l of [...listeners]) l(hash);
    },
    listenerCount: () => listeners.size,
  };
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

const buildOpts = () => {
  const localStore = buildPairedStore();
  const tokenStoreControls = buildFakeTokenStore();
  const transportControls = buildFakeTransport();
  const hashSource = buildFakeHashSource('#reception');
  const fakeDoc = makeFakeDocument();
  const root = makeFakeElement('div');
  return {
    localStore,
    tokenStoreControls,
    transportControls,
    hashSource,
    fakeDoc,
    root,
    opts: {
      root,
      localStore,
      tokenStore: tokenStoreControls.store,
      transport: transportControls.transport,
      exposureProfile: 'community-shareable',
      hashSource,
      document: fakeDoc,
      now: () => 1_700_000_000_000,
    },
  };
};

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const answerSellerMailList = (
  controls: FakeTransportControls,
  instances: ReadonlyArray<{
    slug: string;
    send_capable: boolean;
    account_email: string;
  }> = [],
): void => {
  const mailListCall = controls.sendCalls().find(
    (s) =>
      s !== null
      && typeof s === 'object'
      && (s as { type?: unknown }).type === 'rpc'
      && (s as { method?: unknown }).method === 'collection.mail.list',
  ) as { request_id?: unknown } | undefined;
  if (typeof mailListCall?.request_id !== 'string') {
    throw new Error('missing collection.mail.list request');
  }
  controls.fireMessage({
    type: 'rpc_result',
    request_id: mailListCall.request_id,
    result: { instances },
  });
};

// Orders are lazy and load only for `#settings/seller/orders`.
const answerSellerListOrders = (controls: FakeTransportControls): void => {
  const listOrdersCall = controls.sendCalls().find(
    (s) =>
      s !== null
      && typeof s === 'object'
      && (s as { type?: unknown }).type === 'rpc'
      && (s as { method?: unknown }).method === 'server.seller.listOrders',
  ) as { request_id?: unknown } | undefined;
  if (typeof listOrdersCall?.request_id !== 'string') {
    throw new Error('missing server.seller.listOrders request');
  }
  controls.fireMessage({
    type: 'rpc_result',
    request_id: listOrdersCall.request_id,
    result: { orders: [], truncated: false },
  });
};

const findChildByAttr = (
  root: FakeElement,
  attr: string,
): FakeElement | null => {
  if (root.attrs.has(attr)) return root;
  for (const c of root.childList) {
    const hit = findChildByAttr(c, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const findChildrenByAttr = (
  root: FakeElement,
  attr: string,
  found: FakeElement[] = [],
): FakeElement[] => {
  if (root.attrs.has(attr)) found.push(root);
  for (const c of root.childList) findChildrenByAttr(c, attr, found);
  return found;
};

const findChildByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null =>
  findChildrenByAttr(root, attr).find((el) => el.getAttribute(attr) === value) ?? null;

const routeContentRoot = (root: FakeElement): FakeElement => {
  const content = findChildByAttr(root, WEBCLIENT_SHELL_CONTENT_ATTR);
  if (content === null) throw new Error('webclient shell content root missing');
  return content;
};

// Is the #reception route mounted in the shell content slot? The D-173/D-174
// tabbed-inbox restructure moved the route under its OWN root (marked
// `data-recued-reception-route`, appended into the content slot like every
// other route) — earlier it stamped `data-reception-shell` directly on the
// slot. This predicate tracks the current marker; the route's internals are
// covered by `d-149-settings-reception-bootstrap.test.ts`.
const receptionMounted = (root: FakeElement): boolean =>
  findChildByAttr(routeContentRoot(root), 'data-recued-reception-route') !== null;

// Concatenate an element's `innerHTML` with every descendant's — the fake
// element's `innerHTML` is a per-node string that (unlike real DOM) does NOT
// serialize children, and the D-188 controllable pill renders into an inner
// span nested under its host anchor, so pill markup lives below the host node.
const subtreeInnerHtml = (el: FakeElement): string =>
  el.innerHTML + el.childList.map(subtreeInnerHtml).join('');

const exposureResolution = (receptionPublic: boolean) => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: receptionPublic },
  oauth: { lan: false, public: false },
});

// ══════════════════════════════════════════════════════════════════
// parseRouteFromHash
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 — parseRouteFromHash', () => {
  it('strips a leading # + matches a known route id', () => {
    expect(parseRouteFromHash('#reception')).toBe('reception');
    expect(parseRouteFromHash('reception')).toBe('reception');
  });

  it('falls back to the default for an unknown hash', () => {
    expect(parseRouteFromHash('#unknown')).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('falls back to the default for an empty hash', () => {
    expect(parseRouteFromHash('')).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseRouteFromHash('#')).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('drops a query-style suffix before matching', () => {
    expect(parseRouteFromHash('#reception?foo=bar')).toBe('reception');
  });

  it('default route is in the closed list of known route ids', () => {
    expect(WEBCLIENT_ROUTE_IDS).toContain(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('uses the chat home as the default landing and degrades the retired cockpit', () => {
    // §D.L1 (shell-frame Step 5) — chat is the default; `home`/`compose` were
    // retired, so their old hashes fall through to the default rather than
    // resolving (no compat shim, pre-launch).
    expect(WEBCLIENT_DEFAULT_ROUTE).toBe('chat');
    expect(WEBCLIENT_ROUTE_IDS).toContain('chat');
    expect(WEBCLIENT_ROUTE_IDS).not.toContain('home');
    expect(parseRouteFromHash('#home')).toBe('chat');
    expect(parseRouteFromHash('home')).toBe('chat');
  });

  it('parses #settings as the settings route (slice 110)', () => {
    expect(parseRouteFromHash('#settings')).toBe('settings');
    expect(parseRouteFromHash('settings')).toBe('settings');
    expect(WEBCLIENT_ROUTE_IDS).toContain('settings');
  });

  it('parses #approvals as the approvals route (D-169 P2)', () => {
    expect(parseRouteFromHash('#approvals')).toBe('approvals');
    expect(parseRouteFromHash('approvals')).toBe('approvals');
    expect(WEBCLIENT_ROUTE_IDS).toContain('approvals');
  });

  it('degrades the retired #compose route to the default (absorbed by the Create overlay)', () => {
    // §D.L1 (shell-frame Step 5) — `#compose` retired; the 4-kind capture is now
    // the shared Create overlay (the L1 composer button + the §D.L2 drawer seat).
    expect(WEBCLIENT_ROUTE_IDS).not.toContain('compose');
    expect(parseRouteFromHash('#compose')).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseRouteFromHash('#/compose')).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseRouteFromHash('/compose')).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('parses #contracts, #connections, #recipes, #data, #logs, and #chat as live D-174 routes', () => {
    expect(parseRouteFromHash('#contracts')).toBe('contracts');
    expect(parseRouteFromHash('contracts')).toBe('contracts');
    expect(parseRouteFromHash('#connections')).toBe('connections');
    expect(parseRouteFromHash('connections')).toBe('connections');
    expect(parseRouteFromHash('#recipes')).toBe('recipes');
    expect(parseRouteFromHash('recipes')).toBe('recipes');
    expect(parseRouteFromHash('#data')).toBe('data');
    expect(parseRouteFromHash('data')).toBe('data');
    expect(parseRouteFromHash('#logs')).toBe('logs');
    expect(parseRouteFromHash('logs')).toBe('logs');
    expect(parseRouteFromHash('#chat')).toBe('chat');
    expect(parseRouteFromHash('chat')).toBe('chat');
    expect(WEBCLIENT_ROUTE_IDS).toContain('contracts');
    expect(WEBCLIENT_ROUTE_IDS).toContain('connections');
    expect(WEBCLIENT_ROUTE_IDS).toContain('recipes');
    expect(WEBCLIENT_ROUTE_IDS).toContain('data');
    expect(WEBCLIENT_ROUTE_IDS).toContain('logs');
    expect(WEBCLIENT_ROUTE_IDS).toContain('chat');
  });

  it('resolves the surface from a §D.shell path-style deep link (R16)', () => {
    // The segment tail (run id / recipe id / section) is parsed by
    // `parseShellRoute` — covered in shell/__tests__/route.test.ts. The route
    // discriminator only cares about the surface.
    expect(parseRouteFromHash('#logs/run-1')).toBe('logs');
    expect(parseRouteFromHash('#recipes/mail%2Fsend')).toBe('recipes');
    expect(parseRouteFromHash('#settings/server')).toBe('settings');
    expect(parseRouteFromHash('#automation/deal-watch')).toBe('automation');
    expect(parseRouteFromHash('#contracts/<id>/ops')).toBe('contracts');
  });

  it('drops a retired Compose template query tail and degrades to the default', () => {
    expect(
      parseRouteFromHash('#compose?template=app%2Frecued-core%2Ffeedback-collect'),
    ).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });
});

describe('D-151 — Compose Reception status from hostnames', () => {
  it('derives a public Reception base URL from the first bindable hostname', () => {
    expect(
      deriveComposeReceptionStatusFromHostnames(
        [
          {
            hostname_id: 'disabled',
            hostname: 'disabled.recued.cloud',
            cert_source: 'recued_acme',
            ownership_status: 'verified',
            listener_ports: [443],
            ddns_managed: true,
            enabled: false,
            tls_topology: 'server_terminated',
          },
          {
            hostname_id: 'ready',
            hostname: 'ready.recued.cloud',
            cert_source: 'recued_acme',
            ownership_status: 'verified',
            listener_ports: [8446],
            ddns_managed: true,
            enabled: true,
            tls_topology: 'server_terminated',
          },
        ],
        {
          reception_public: false,
          emergency_disabled: true,
          base_url: null,
        },
      ),
    ).toEqual({
      reception_public: true,
      emergency_disabled: true,
      base_url: 'https://ready.recued.cloud:8446/reception/',
      reachable: false,
    });
  });

  it('marks the derived Reception URL reachable only from a matching probe result', () => {
    const rows = [
      {
        hostname_id: 'ready',
        hostname: 'ready.recued.cloud',
        cert_source: 'recued_acme' as const,
        ownership_status: 'verified' as const,
        listener_ports: [443] as const,
        ddns_managed: true,
        enabled: true,
        tls_topology: 'server_terminated' as const,
      },
    ];

    expect(
      deriveComposeReceptionStatusFromHostnames(rows, undefined, {
        account_id: 'acct-1',
        hostname: 'other.recued.cloud',
        detected_public_ip: '203.0.113.5',
        resolved_ips: ['203.0.113.5'],
        probed_at: 1_700_000_000_000,
        results: [],
      })?.reachable,
    ).toBe(false);

    expect(
      deriveComposeReceptionStatusFromHostnames(rows, undefined, {
        account_id: 'acct-1',
        hostname: 'ready.recued.cloud',
        detected_public_ip: '203.0.113.5',
        resolved_ips: ['203.0.113.5'],
        probed_at: 1_700_000_000_000,
        results: [
          {
            kind: 'port_reachability',
            status: 'pass',
            payload: {
              kind: 'port_reachability',
              port: 443,
              outcome: 'reachable',
            },
          },
          {
            kind: 'tls_handshake',
            status: 'pass',
            payload: {
              kind: 'tls_handshake',
              cert_valid: true,
              cert_matches_hostname: true,
              cert_expires_at: null,
              cert_issuer: null,
            },
          },
        ],
      })?.reachable,
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// Pair-state hydration
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 — bootstrapWebclient: pair-state hydration', () => {
  it('throws WebclientUnpairedError when the store has no pair state', async () => {
    const fixture = buildOpts();
    const opts = { ...fixture.opts, localStore: buildUnpairedStore() };
    await expect(bootstrapWebclient(opts)).rejects.toBeInstanceOf(
      WebclientUnpairedError,
    );
  });

  it.each([
    ['server_url', { server_url: null }],
    ['server_public_key', { server_public_key: null }],
    ['webclient_token', { webclient_token: null }],
  ] as const)(
    'throws WebclientUnpairedError when %s is missing',
    async (_field, override) => {
      const fixture = buildOpts();
      const opts = { ...fixture.opts, localStore: buildPairedStore(override) };
      await expect(bootstrapWebclient(opts)).rejects.toBeInstanceOf(
        WebclientUnpairedError,
      );
    },
  );

  it('hydrates the pair state + opens the WS transport with the resolved bearer', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(fixture.transportControls.openCount()).toBe(1);
    const args = fixture.transportControls.lastOpenArgs()!;
    expect(args.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    // D-148 § A.2.1 — structured `<token_id>.<bearer>` shape. The
    // server-side `parseStructuredBearer` splits on the first `.` +
    // calls `clientTokens.verify(token_id, bearer)` BEFORE socket
    // acceptance; populating `token_id` on the wire unlocks the
    // `pair.mint` webclient gate. The fake unwrap returns
    // `bearer-${token_id}` so the structured form is
    // `${token_id}.bearer-${token_id}`.
    expect(args.bearer).toBe('tok-abc.bearer-tok-abc');
    // Unwrap AAD carries the pair-context fields.
    const call = fixture.tokenStoreControls.unwrapCalls()[0]!;
    expect(call.record_id).toBe('tok-abc');
    expect(call.aad.token_id).toBe('tok-abc');
    expect(call.aad.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    expect(call.aad.server_public_key).toBe('spki-base64');
    const shellStyle = fixture.fakeDoc.styleElements.find((style) =>
      style.attrs.has(WEBCLIENT_SHELL_STYLES_MARKER),
    );
    expect(shellStyle?.textContent).toContain('height: 100dvh');
    expect(shellStyle?.textContent).toContain('backdrop-filter: blur(14px)');
    expect(WEBCLIENT_POLISH_STYLES).toContain('--wc-content-max: 1160px');
    expect(WEBCLIENT_POLISH_STYLES).toContain(
      '@media (prefers-reduced-motion: reduce)',
    );
    await handle.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Route discriminator
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 — bootstrapWebclient: route discriminator', () => {
  it('mounts Reception when the hash is #reception', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('reception');
    // The persistent shell owns the app root; Reception stamps its
    // layout marker on the shell content slot.
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).not.toBeNull();
    expect(receptionMounted(fixture.root)).toBe(true);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(
      findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('keeps D-200 pair invalidations live when the separate Approvals route is disabled', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#reception/endpoints/pair/intake-1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableApprovalsRoute: false,
    });
    await flush();

    const rpcCalls = (): Array<{
      method?: unknown;
      request_id?: unknown;
    }> => fixture.transportControls.sendCalls().filter(
      (call): call is { method?: unknown; request_id?: unknown } =>
        call !== null
        && typeof call === 'object'
        && (call as { type?: unknown }).type === 'rpc',
    );
    const initialPairGet = rpcCalls().find(
      (call) => call.method === 'reception.intake_recipe_pair.get',
    );
    const initialRecipeList = rpcCalls().find(
      (call) => call.method === 'recipe.list',
    );
    expect(typeof initialPairGet?.request_id).toBe('string');
    expect(typeof initialRecipeList?.request_id).toBe('string');
    expect(rpcCalls().some(
      (call) => call.method === 'notification.pending_asks',
    )).toBe(false);

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialPairGet!.request_id,
      result: {
        endpoint_id: 'intake-1',
        status: 'unpaired',
        binding: null,
        created_at: null,
        updated_at: null,
      },
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRecipeList!.request_id,
      result: { recipes: [] },
    });
    await flush();

    const getsBefore = rpcCalls().filter(
      (call) => call.method === 'reception.intake_recipe_pair.get',
    ).length;
    fixture.transportControls.fireMessage({
      type: 'server_event',
      event: {
        kind: 'reception.endpoint_changed',
        op: 'pair_bind',
        endpoint_id: 'intake-1',
        cursor: 42,
      },
    });
    await flush();

    expect(rpcCalls().filter(
      (call) => call.method === 'reception.intake_recipe_pair.get',
    )).toHaveLength(getsBefore + 1);

    await handle.dispose();
  });

  it('keeps the global attention popover reachable from a non-approvals route', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('reception');
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR);
    expect(topbar).toBeDefined();

    topbar!.fireClick({ action: 'open-attention' });

    expect(topbar!.innerHTML).toContain('attention-popover');
    expect(topbar!.innerHTML).toContain('href="#approvals"');
    expect(handle.activeRoute()).toBe('reception');
    await handle.dispose();
  });

  it('mounts the chat home when the hash is empty (default)', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('');
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('chat');
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('mounts the chat home when the hash is unknown (default-fallback)', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#unknown');
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('chat');
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('lands an approval deep link on its exact resolved Chat action card', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#chat/session/chat_1/plan/plan_approved/answer/msg_action',
    );
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    const rpcCalls = (): Array<{
      method?: unknown;
      request_id?: unknown;
      args?: unknown;
    }> => fixture.transportControls.sendCalls().filter(
      (call): call is {
        method?: unknown;
        request_id?: unknown;
        args?: unknown;
      } =>
        call !== null
        && typeof call === 'object'
        && (call as { type?: unknown }).type === 'rpc',
    );
    const sessionsList = rpcCalls().find(
      (call) => call.method === 'chat.sessions.list',
    );
    expect(typeof sessionsList?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessionsList!.request_id,
      result: {
        sessions: [{
          id: 'chat_1',
          title: 'Ops chat',
          created_at: 1_000,
          last_active_at: 2_000,
          message_count: 1,
          archived: false,
          picker_state: { current: 'self' },
          model_routing: {
            current: 'byok',
            provider: 'local',
            overridden: false,
          },
        }],
      },
    });
    await flush();

    const sessionGet = rpcCalls().find(
      (call) => call.method === 'chat.session.get',
    );
    expect(sessionGet?.args).toEqual({ session_id: 'chat_1' });
    expect(typeof sessionGet?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessionGet!.request_id,
      result: {
        id: 'chat_1',
        title: 'Ops chat',
        created_at: 1_000,
        last_active_at: 2_000,
        archived: false,
        picker_state: { current: 'self' },
        model_routing: {
          current: 'byok',
          provider: 'local',
          model_id: 'local-default',
          overridden: false,
        },
        messages: [{
          id: 'msg_action',
          session_id: 'chat_1',
          role: 'assistant',
          content: 'The reviewed action is ready.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: '1',
              instance_id: 'server_1',
            },
          },
          model_used: { provider: 'local', model_id: 'local-default' },
          contributor: 'assistant',
          ts: 2_000,
        }],
        plans: [{
          plan: {
            plan_id: 'plan_approved',
            session_id: 'chat_1',
            turn_id: 'turn_action',
            tool: 'mail.send',
            tier: 2,
            classification: 'write',
            args: { to: 'mary@example.com', subject: 'Hello' },
            args_hash: 'hash-approved',
            status: 'approved',
            created_at: 1_700_000_000_000,
            resolved_at: 1_700_000_001_000,
          },
          message_id: 'msg_action',
          payload_available: true,
        }, {
          plan: {
            plan_id: 'plan_cancelled',
            session_id: 'chat_1',
            turn_id: 'turn_cancelled',
            tool: 'mail.send',
            tier: 2,
            classification: 'write',
            args: { to: 'mary@example.com', subject: 'Never mind' },
            args_hash: 'hash-cancelled',
            status: 'cancelled',
            created_at: 1_700_000_002_000,
            resolved_at: 1_700_000_003_000,
          },
          message_id: 'msg_action',
          payload_available: true,
        }],
      },
    });
    await flush();

    const content = routeContentRoot(fixture.root);
    const exactCard = findChildByAttr(content, CHAT_ROUTE_PLAN_TARGET_ATTR);
    expect(exactCard?.getAttribute('data-plan-id')).toBe('plan_approved');
    expect(
      findChildByAttr(exactCard!, CHAT_ROUTE_PLAN_CONTINUE_ATTR),
    ).not.toBeNull();
    expect(
      rpcCalls().some((call) => call.method === 'chat.send'),
    ).toBe(false);

    const chatRoute = findChildByAttr(content, 'data-recued-chat-route');
    const draft = findChildByAttr(content, CHAT_ROUTE_INPUT_ATTR);
    expect(draft).not.toBeNull();
    draft!.fireInput('Keep this draft while I inspect the action');
    const sessionReads = rpcCalls().filter(
      (call) => call.method === 'chat.session.get',
    ).length;
    fixture.hashSource.setHash(
      '#chat/session/chat_1/plan/plan_cancelled/answer/msg_action',
    );
    const nextTarget = findChildByAttr(content, CHAT_ROUTE_PLAN_TARGET_ATTR);
    expect(nextTarget?.getAttribute('data-plan-id')).toBe('plan_cancelled');
    expect(findChildByAttr(content, 'data-recued-chat-route')).toBe(chatRoute);
    expect(findChildByAttr(content, CHAT_ROUTE_INPUT_ATTR)?.value).toBe(
      'Keep this draft while I inspect the action',
    );
    expect(
      rpcCalls().filter((call) => call.method === 'chat.session.get'),
    ).toHaveLength(sessionReads);
    expect(
      rpcCalls().some((call) => call.method === 'chat.send'),
    ).toBe(false);

    await handle.dispose();
  });

  it('subscribes to hashchange and re-mounts when the route flips', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(fixture.hashSource.listenerCount()).toBe(1);
    // A no-op flip (#reception → #reception) leaves the slot count
    // unchanged.
    const shellBefore = findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR);
    const childCountBefore = routeContentRoot(fixture.root).childList.length;
    fixture.hashSource.setHash('#reception');
    expect(routeContentRoot(fixture.root).childList.length).toBe(childCountBefore);
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(shellBefore);
    // A flip to an unknown route falls back to the chat home (the default).
    fixture.hashSource.setHash('#unknown');
    expect(handle.activeRoute()).toBe('chat');
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(shellBefore);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('mounts one persistent §D.L2 drawer in the locked order and tracks the active route on content swaps', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const shellBefore = findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR);
    expect(shellBefore).not.toBeNull();
    // Drawer defaults closed — the host carries no open-state attr.
    expect(shellBefore!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(false);

    // Seats are addressed by their unique seat id (two seats can share a
    // route), in the locked frequency+action order. D-187 §6 — Packs is now
    // a real `#packs` route link between Connections and Contracts.
    const drawerLinks = findChildrenByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_LINK_ATTR,
    );
    expect(
      drawerLinks.map((link) =>
        link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      ),
    ).toEqual([
      'new-chat',
      'chats',
      'data',
      'recipes',
      'automation',
      'connections',
      'packs',
      'contracts',
      'reception',
      'log',
      'settings',
      'account',
    ]);
    // Wiring: New chat/Chats → #chat, Log → #logs, Account → #settings. "Create"
    // is NOT a nav link — it's an action seat (opens the shared Create overlay),
    // asserted separately below.
    expect(drawerLinks.map((link) => link.getAttribute('href'))).toEqual([
      '#chat',
      '#chat',
      '#data',
      '#recipes',
      '#automation',
      '#connections',
      '#packs',
      '#contracts',
      '#reception',
      '#logs',
      '#settings',
      '#settings',
    ]);
    // The §D.L2 "Create" seat is an ACTION button (no href) between Chats and
    // Data — it opens the shared Create overlay rather than navigating.
    const actionSeats = findChildrenByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_ACTION_ATTR,
    );
    expect(
      actionSeats.map((seat) =>
        seat.getAttribute(WEBCLIENT_SHELL_DRAWER_ACTION_ATTR),
      ),
    ).toEqual(['create']);
    expect(actionSeats[0]!.getAttribute('href')).toBeNull();

    // Initial hash is #reception (buildOpts) → only the Reception seat is lit
    // (exactly one highlight owner per route).
    expect(
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      ),
    ).toEqual(['reception']);

    fixture.hashSource.setHash('#data');
    expect(handle.activeRoute()).toBe('data');
    // Same shell host — the drawer is persistent chrome; only content swaps.
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(
      shellBefore,
    );
    expect(
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      ),
    ).toEqual(['data']);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-data-route'),
    ).not.toBeNull();

    // D-187 §6 — #packs mounts the promoted Packs route + lights its seat.
    fixture.hashSource.setHash('#packs');
    expect(handle.activeRoute()).toBe('packs');
    expect(
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      ),
    ).toEqual(['packs']);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-packs-route'),
    ).not.toBeNull();

    // #logs lights the renamed "Log" seat (no "runs" seat exists).
    fixture.hashSource.setHash('#logs');
    expect(
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      ),
    ).toEqual(['log']);
    await handle.dispose();
  });

  it('lights exactly one seat per route despite the interim duplicate wirings', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const activeSeatIds = (): Array<string | null> =>
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      );
    // #settings lights "Settings" only — never the "Account" seat (both wire
    // to #settings).
    fixture.hashSource.setHash('#settings');
    expect(activeSeatIds()).toEqual(['settings']);
    // #chat lights "Chats" only — never the "New chat" seat (both wire to #chat).
    fixture.hashSource.setHash('#chat');
    expect(activeSeatIds()).toEqual(['chats']);
    // A route with NO drawer seat (Kitchen → reached via Recipes/Packs
    // [Author/Edit]) lights nothing — and the "Create" action seat never
    // highlights (it's not a nav link).
    fixture.hashSource.setHash('#kitchen');
    expect(activeSeatIds()).toEqual([]);
    await handle.dispose();
  });

  it('opens and closes the §D.L2 drawer via the ☰ toggle, backdrop, and nav links', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const host = findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR);
    expect(host).not.toBeNull();
    const toggle = findChildByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR,
    );
    expect(toggle).not.toBeNull();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(false);
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    // ☰ opens.
    toggle!.click();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(true);
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');

    // ☰ toggles closed again.
    toggle!.click();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(false);

    // Backdrop click closes an open drawer.
    toggle!.click();
    const backdrop = findChildByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR,
    );
    expect(backdrop).not.toBeNull();
    backdrop!.click();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(false);

    // A nav link closes the drawer on navigate.
    toggle!.click();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(true);
    const dataLink = findChildrenByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_LINK_ATTR,
    ).find((l) => l.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR) === 'data');
    expect(dataLink).not.toBeUndefined();
    dataLink!.click();
    expect(host!.attrs.has(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR)).toBe(false);
    await handle.dispose();
  });

  it('omits home/kitchen/approvals from the drawer; Packs is its own #packs route link', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const seatIds = findChildrenByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_LINK_ATTR,
    ).map((l) => l.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR));
    // Approvals → the top-bar bell; Kitchen → Recipes/Packs [Author/Edit];
    // the cockpit (home) was retired — the chat home is the default landing
    // (none of them is a nav-link seat).
    expect(seatIds).not.toContain('home');
    expect(seatIds).not.toContain('kitchen');
    expect(seatIds).not.toContain('approvals');
    // D-187 §6 — Packs graduated from a disabled "Soon" stub to a real
    // `#packs` route link; no drawer seat is a stub any more.
    expect(seatIds).toContain('packs');
    expect(
      findChildByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_STUB_ATTR),
    ).toBeNull();
    await handle.dispose();
  });

  it('mounts the §D.L1 `●` account control deep-linking to Settings ▸ Account', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const account = findChildByAttr(fixture.root, WEBCLIENT_SHELL_ACCOUNT_ATTR);
    expect(account).not.toBeNull();
    expect(account!.getAttribute('href')).toBe('#settings/account');
    expect(account!.getAttribute('aria-label')).toBe('Account');
    await handle.dispose();
  });

  it('re-mounts Runs when only the run-id segment changes on the same route', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#logs/run-1');
    const handle = await bootstrapWebclient(fixture.opts);
    const shellBefore = findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR);
    const firstRunsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-logs-route',
    );
    expect(firstRunsRoot).not.toBeNull();

    fixture.hashSource.setHash('#logs/run-2');

    expect(handle.activeRoute()).toBe('logs');
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(shellBefore);
    const secondRunsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-logs-route',
    );
    expect(secondRunsRoot).not.toBeNull();
    expect(secondRunsRoot).not.toBe(firstRunsRoot);
    await handle.dispose();
  });

  // ── Slice 110 — Settings route arm ───────────────────────────────

  it('mounts the Settings route when the hash is #settings', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('settings');
    // The Reception layout marker is NOT stamped (settings root does
    // not invoke `bootstrapReceptionRoute`).
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-settings-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('flipping the hash #reception → #settings re-mounts via the discriminator', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('reception');
    const shellBefore = findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    // Flip to settings.
    fixture.hashSource.setHash('#settings');
    expect(handle.activeRoute()).toBe('settings');
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(shellBefore);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-settings-route'),
    ).not.toBeNull();
    // Flip back to reception.
    fixture.hashSource.setHash('#reception');
    expect(handle.activeRoute()).toBe('reception');
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).toBe(shellBefore);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    await handle.dispose();
  });

  it('settingsRoute() handle returns null on reception + the route on settings', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    // This fixture starts on #reception.
    expect(handle.settingsRoute()).toBeNull();
    // Flip to settings; accessor returns the mount handle with the
    // Privacy panel accessor.
    fixture.hashSource.setHash('#settings');
    const settings = handle.settingsRoute();
    expect(settings).not.toBeNull();
    expect(settings!.clearThisBrowserPanel().getState()).toBe('idle');
    // Flip back; accessor returns null again.
    fixture.hashSource.setHash('#reception');
    expect(handle.settingsRoute()).toBeNull();
    await handle.dispose();
  });

  it('D-196 S2 wires Settings -> Seller to server.seller.getOverview by default', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient(fixture.opts);

    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    const inflight = sellerPage!.refresh();
    await flush();

    const sellerCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    );
    expect(sellerCall).toBeDefined();
    expect(fixture.transportControls.sendCalls().some(
      (s) => s !== null
        && typeof s === 'object'
        && (s as { method?: unknown }).method === 'server.seller.listOrders',
    )).toBe(false);
    expect(fixture.transportControls.sendCalls().some(
      (s) => s !== null
        && typeof s === 'object'
        && (s as { method?: unknown }).method === 'collection.mail.list',
    )).toBe(false);
    await handle.dispose();
    await inflight;
  });

  it('routes a Seller page segment and lazy-loads the requested Orders page', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/orders/page/2');
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage?.getState().subpage).toBe('orders');
    expect(sellerPage?.getState().page).toBe(2);
    await flush();

    const listOrdersCall = fixture.transportControls.sendCalls().find(
      (s) => s !== null
        && typeof s === 'object'
        && (s as { method?: unknown }).method === 'server.seller.listOrders',
    ) as { args?: unknown } | undefined;
    expect(listOrdersCall?.args).toEqual({ limit: 25, offset: 25 });
    expect(fixture.transportControls.sendCalls().some(
      (s) => s !== null
        && typeof s === 'object'
        && (s as { method?: unknown }).method === 'collection.mail.list',
    )).toBe(false);
    answerSellerListOrders(fixture.transportControls);

    await handle.dispose();
    await sellerPage?.whenLoaded();
  });

  it('re-mounts Settings when navigating between Seller sub-pages', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/offers');
    const handle = await bootstrapWebclient(fixture.opts);
    const offersPage = handle.settingsRoute()?.sellerPage();
    expect(offersPage?.getState().subpage).toBe('offers');

    fixture.hashSource.setHash('#settings/seller/usage');

    const usagePage = handle.settingsRoute()?.sellerPage();
    expect(usagePage).not.toBe(offersPage);
    expect(usagePage?.getState().subpage).toBe('usage');
    await handle.dispose();
    await usagePage?.whenLoaded();
  });

  it('D-196 §4.7 wires Seller mail listing independently of Connections enrollment', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/setup');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableConnectionsEnrollPanel: false,
    });
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const mailListCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'collection.mail.list',
    );
    expect(mailListCall).toBeDefined();

    await handle.dispose();
    await sellerPage!.whenLoaded();
  });

  it('D-196 §4.7 does not wire Seller mail listing when Seller is disabled', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/setup');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableConnectionsEnrollPanel: false,
      enableSellerPage: false,
    });
    await flush();

    const mailListCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'collection.mail.list',
    );
    expect(mailListCall).toBeUndefined();

    await handle.dispose();
  });

  it('D-200 Slice 6e wires owner offer transitions to the reserved Seller RPC', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#settings/seller/offers/detail/paid-document.outcome',
    );
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const overviewCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    ) as { request_id?: unknown } | undefined;
    if (typeof overviewCall?.request_id !== 'string') {
      throw new Error('missing Seller overview request');
    }
    const initial: SellerOverview = {
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: null,
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: 0,
        updated_at: 0,
      },
      counts: {
        tiers: 0,
        active_tiers: 0,
        customers: 0,
        active_customers: 0,
        grace_customers: 0,
        closed_customers: 0,
      },
      readiness: [],
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
      offers: [{
        offer_id: 'paid-document.outcome',
        kind: 'document',
        display_name: 'Paid document',
        description: '',
        pricing_kind: 'fixed',
        amount_minor: 12_500,
        currency: 'USD',
        fulfillment_recipe_id: null,
        checkout_url: null,
        fulfillment_config: null,
        state: 'draft',
        created_by_recipe_id: 'start-paid-document-fulfillment',
        created_at: 1,
        updated_at: 1,
      }],
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: overviewCall.request_id,
      result: initial,
    });
    await sellerPage!.whenLoaded();

    findChildByAttrValue(
      fixture.root,
      SELLER_OFFER_STATE_ACTION_ATTR,
      'active',
    )?.click();
    await flush();

    const transitionCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.transitionOfferState',
    ) as { request_id?: unknown; args?: unknown } | undefined;
    expect(transitionCall?.args).toEqual({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: 1,
      next_state: 'active',
    });
    if (typeof transitionCall?.request_id === 'string') {
      const activeOffer = {
        ...initial.offers![0]!,
        state: 'active' as const,
        updated_at: 2,
      };
      fixture.transportControls.fireMessage({
        type: 'rpc_result',
        request_id: transitionCall.request_id,
        result: {
          result: 'updated',
          offer: activeOffer,
          overview: { ...initial, offers: [activeOffer] },
        },
      });
    }
    await flush();
    await handle.dispose();
  });

  it('D-196 S2 wires Settings -> Seller settings update by default', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/setup');
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const overviewCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    ) as { request_id?: unknown } | undefined;
    expect(overviewCall).toBeDefined();
    expect(typeof overviewCall?.request_id).toBe('string');
    const overview: SellerOverview = {
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: null,
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: null,
        updated_at: null,
      },
      counts: {
        tiers: 0,
        active_tiers: 0,
        customers: 0,
        active_customers: 0,
        grace_customers: 0,
        closed_customers: 0,
      },
      readiness: [],
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
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: overviewCall!.request_id,
      result: overview,
    });
    answerSellerMailList(fixture.transportControls, [{
      slug: 'mail-primary',
      send_capable: true,
      account_email: 'seller@example.com',
    }]);
    await sellerPage!.whenLoaded();

    const setField = (name: string, value: string): void => {
      const field = findChildByAttrValue(
        fixture.root,
        SELLER_SETTINGS_FORM_FIELD_ATTR,
        name,
      );
      if (field === null) throw new Error(`missing seller settings field ${name}`);
      (field as unknown as { value: string }).value = value;
    };
    setField('default_grace_hours', '24');
    setField('sender_mail_instance_id', 'mail-primary');
    setField('status_policy_json', '{"past_due":"grace"}');
    setField('email_policy_json', '{"claim":{"enabled":true}}');
    findChildByAttr(fixture.root, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flush();

    const settingsCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.updateSettings',
    ) as { args?: unknown } | undefined;
    expect(settingsCall).toBeDefined();
    expect(settingsCall?.args).toEqual({
      default_grace_hours: 24,
      sender_mail_instance_id: 'mail-primary',
      status_policy_json: { past_due: 'grace' },
      email_policy_json: { claim: { enabled: true } },
    });

    await handle.dispose();
  });

  it('D-196 S2 wires Settings -> Seller manual customer issue by default', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/customers');
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const overviewCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    ) as { request_id?: unknown } | undefined;
    expect(overviewCall).toBeDefined();
    expect(typeof overviewCall?.request_id).toBe('string');
    const overview: SellerOverview = {
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: null,
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: null,
        updated_at: null,
      },
      counts: {
        tiers: 1,
        active_tiers: 1,
        customers: 0,
        active_customers: 0,
        grace_customers: 0,
        closed_customers: 0,
      },
      readiness: [],
      llm_gateway: {
        configured: false,
        config_readable: true,
        default_route: null,
        model_alias: null,
        paid_ack_at: null,
        paid_acknowledged: false,
      },
      tiers: [
        {
          tier_id: 'tier-basic',
          door_id: 'door-mcp',
          lifecycle_source: 'manual',
          entitlement_key: 'basic',
          display_name: 'Basic',
          template_contract_id: 'ct-template-basic',
          external_entitlement_id: null,
          usage_policy_json: {},
          pass_duration_seconds: null,
          customer_status_enabled_default: true,
          active: true,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
      ],
      customers: [],
      usage_rollups: [],
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: overviewCall!.request_id,
      result: overview,
    });
    await sellerPage!.whenLoaded();

    const setField = (name: string, value: string): void => {
      const field = findChildByAttrValue(
        fixture.root,
        SELLER_CUSTOMER_FORM_FIELD_ATTR,
        name,
      );
      if (field === null) throw new Error(`missing seller field ${name}`);
      (field as unknown as { value: string }).value = value;
    };
    setField('source_customer_id', 'manual-cus-boot');
    setField('email', 'boot@example.com');
    setField('source_status', 'paid');
    findChildByAttr(fixture.root, SELLER_CUSTOMER_FORM_SUBMIT_ATTR)?.click();
    await flush();

    const issueCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.issueManualCustomer',
    ) as { args?: unknown } | undefined;
    expect(issueCall).toBeDefined();
    expect(issueCall?.args).toEqual({
      door_id: 'door-mcp',
      entitlement_key: 'basic',
      source_customer_id: 'manual-cus-boot',
      email: 'boot@example.com',
      source_status: 'paid',
    });

    await handle.dispose();
  });

  it('D-196 S2 wires Settings -> Seller manual tier bulk adjust by default', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/tiers/detail/tier-basic');
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const overviewCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    ) as { request_id?: unknown } | undefined;
    expect(overviewCall).toBeDefined();
    expect(typeof overviewCall?.request_id).toBe('string');
    const overview: SellerOverview = {
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: null,
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: null,
        updated_at: null,
      },
      counts: {
        tiers: 1,
        active_tiers: 1,
        customers: 0,
        active_customers: 0,
        grace_customers: 0,
        closed_customers: 0,
      },
      readiness: [],
      llm_gateway: {
        configured: false,
        config_readable: true,
        default_route: null,
        model_alias: null,
        paid_ack_at: null,
        paid_acknowledged: false,
      },
      tiers: [
        {
          tier_id: 'tier-basic',
          door_id: 'door-mcp',
          lifecycle_source: 'manual',
          entitlement_key: 'basic',
          display_name: 'Basic',
          template_contract_id: 'ct-template-basic',
          external_entitlement_id: null,
          usage_policy_json: {},
          pass_duration_seconds: null,
          customer_status_enabled_default: true,
          active: true,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
      ],
      customers: [],
      usage_rollups: [],
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: overviewCall!.request_id,
      result: overview,
    });
    await sellerPage!.whenLoaded();

    findChildByAttr(fixture.root, SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR)?.click();
    await flush();

    const bulkAdjustCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method
          === 'server.seller.bulkAdjustManualTierCustomers',
    ) as { args?: unknown } | undefined;
    expect(bulkAdjustCall).toBeDefined();
    expect(bulkAdjustCall?.args).toEqual({
      tier_id: 'tier-basic',
    });

    await handle.dispose();
  });

  it('D-196 S2 wires Settings -> Seller manual customer reissue and close by default', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/customers/detail/customer-boot');
    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();
    expect(sellerPage).not.toBeNull();
    await flush();

    const overviewCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method === 'server.seller.getOverview',
    ) as { request_id?: unknown } | undefined;
    expect(overviewCall).toBeDefined();
    expect(typeof overviewCall?.request_id).toBe('string');
    const overview: SellerOverview = {
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: null,
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: null,
        updated_at: null,
      },
      counts: {
        tiers: 1,
        active_tiers: 1,
        customers: 1,
        active_customers: 1,
        grace_customers: 0,
        closed_customers: 0,
      },
      readiness: [],
      llm_gateway: {
        configured: false,
        config_readable: true,
        default_route: null,
        model_alias: null,
        paid_ack_at: null,
        paid_acknowledged: false,
      },
      tiers: [
        {
          tier_id: 'tier-basic',
          door_id: 'door-mcp',
          lifecycle_source: 'manual',
          entitlement_key: 'basic',
          display_name: 'Basic',
          template_contract_id: 'ct-template-basic',
          external_entitlement_id: null,
          usage_policy_json: {},
          pass_duration_seconds: null,
          customer_status_enabled_default: true,
          active: true,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
      ],
      customers: [
        {
          customer_id: 'customer-boot',
          lifecycle_source: 'manual',
          source_customer_id: 'manual-cus-boot',
          door_id: 'door-mcp',
          email: 'boot@example.com',
          tier_id: 'tier-basic',
          contract_id: 'ct-customer-boot',
          inbound_token_id: 'tok-boot',
          mcp_token_id: 'tok-boot',
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
        },
      ],
      usage_rollups: [],
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: overviewCall!.request_id,
      result: overview,
    });
    await sellerPage!.whenLoaded();

    const reissueCustomer = findChildByAttrValue(
      fixture.root,
      SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
      'reissue.customer_id',
    );
    if (reissueCustomer === null) {
      throw new Error('missing seller reissue customer field');
    }
    for (const field of [
      'reissue.token_label',
      'reissue.token_expires_at',
      'reissue.token_grants',
      'reissue.source_status',
    ]) {
      expect(findChildByAttrValue(
        fixture.root,
        SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
        field,
      )).toBeNull();
    }
    findChildByAttrValue(
      fixture.root,
      SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR,
      'reissue',
    )?.click();
    await flush();

    const reissueCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method
          === 'server.seller.reissueManualCustomerToken',
    ) as { args?: unknown; request_id?: unknown } | undefined;
    expect(reissueCall).toBeDefined();
    expect(reissueCall?.args).toEqual({
      customer_id: 'customer-boot',
    });

    const reissuedCustomer = {
      ...overview.customers[0]!,
      inbound_token_id: 'tok-reissued',
      mcp_token_id: 'tok-reissued',
      updated_at: 1_700_000_100_000,
    };
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: reissueCall!.request_id,
      result: {
        customer: reissuedCustomer,
        claim: {
          claim_url: 'https://seller.example/reception/claim?t=boot-reissued-claim',
          expires_at: 1_700_003_700_000,
        },
        overview: {
          ...overview,
          customers: [reissuedCustomer],
        },
      },
    });
    await flush();

    const sourceStatus = findChildByAttrValue(
      fixture.root,
      SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
      'close.source_status',
    );
    if (sourceStatus === null) throw new Error('missing seller close status field');
    (sourceStatus as unknown as { value: string }).value = 'closed_by_owner';
    findChildByAttrValue(
      fixture.root,
      SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR,
      'close',
    )?.click();
    await flush();

    const closeCall = fixture.transportControls.sendCalls().find(
      (s) =>
        s !== null
        && typeof s === 'object'
        && (s as { type?: unknown }).type === 'rpc'
        && (s as { method?: unknown }).method
          === 'server.seller.closeManualCustomer',
    ) as { args?: unknown } | undefined;
    expect(closeCall).toBeDefined();
    expect(closeCall?.args).toEqual({
      customer_id: 'customer-boot',
      reason: 'seller_manual',
      source_status: 'closed_by_owner',
    });

    await handle.dispose();
  });

  // ── D-169 P2 — Approvals route arm ───────────────────────────────

  it('mounts the Approvals route when the hash is #approvals', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#approvals');
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('approvals');
    // Not reception — the approvals branch does not stamp the layout marker.
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-approvals-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('flipping #reception → #approvals → #reception re-mounts via the discriminator', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('reception');
    fixture.hashSource.setHash('#approvals');
    expect(handle.activeRoute()).toBe('approvals');
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-approvals-route'),
    ).not.toBeNull();
    expect(receptionMounted(fixture.root)).toBe(false);
    fixture.hashSource.setHash('#reception');
    expect(handle.activeRoute()).toBe('reception');
    expect(receptionMounted(fixture.root)).toBe(true);
    await handle.dispose();
  });

  it('falls back to Home for #approvals when the approvals route is disabled (enableApprovalsRoute: false)', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#approvals');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableApprovalsRoute: false,
    });
    // `#approvals` needs the pending-decision callers; with
    // `enableApprovalsRoute: false` the route is disabled, so the resolver
    // degrades the hash to the default chat-home mount (rather than a dead
    // surface) AND keeps the tracked active route consistent with what
    // actually mounted (no stuck 'approvals' id while the chat home is on
    // screen).
    expect(handle.activeRoute()).toBe('chat');
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-approvals-route'),
    ).toBeNull();
    await handle.dispose();
  });

  // ── §D.L1 Step 5 — the retired Compose route degrades to the chat home ──

  it('degrades the retired #compose hash to the chat home (no Compose route)', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#compose');
    const handle = await bootstrapWebclient(fixture.opts);
    // #compose was absorbed by the shared Create overlay; the hash now falls
    // through to the default chat home rather than mounting a Compose route.
    expect(handle.activeRoute()).toBe('chat');
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-compose-route'),
    ).toBeNull();
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('flipping #reception → #compose (degraded) → #reception re-mounts via the discriminator', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('reception');
    fixture.hashSource.setHash('#compose');
    // Degrades to the chat home — there is no Compose route to mount.
    expect(handle.activeRoute()).toBe('chat');
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-chat-route'),
    ).not.toBeNull();
    expect(receptionMounted(fixture.root)).toBe(false);
    fixture.hashSource.setHash('#reception');
    expect(handle.activeRoute()).toBe('reception');
    expect(receptionMounted(fixture.root)).toBe(true);
    await handle.dispose();
  });

  it('mounts the Runs route when the hash is #logs', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#logs/run-1');
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.activeRoute()).toBe('logs');
    expect(receptionMounted(fixture.root)).toBe(false);
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-logs-route'),
    ).not.toBeNull();
    await handle.dispose();
  });

  it('hydrates a Logs run with its exact Chat-plan return after reload', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#logs/run%2Fone/return/chat/session/chat%2Fone/plan/plan%20one/'
      + 'answer/answer%20%231',
    );
    const handle = await bootstrapWebclient(fixture.opts);

    const logs = findChildByAttr(
      routeContentRoot(fixture.root),
      LOGS_ROUTE_HOST_ATTR,
    );
    expect(logs).not.toBeNull();
    expect(logs!.innerHTML).toContain(LOGS_ROUTE_CHAT_RETURN_ATTR);
    expect(logs!.innerHTML).toContain(
      'href="#chat/session/chat%2Fone/plan/plan%20one/answer/answer%20%231"',
    );
    expect(logs!.innerHTML).toContain('Back to this Chat action');

    await handle.dispose();
  });

  it('hydrates a source-record verification handoff with its exact run return after reload', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#data/calendar/verify/event-1/relationship/involved/return/logs/'
      + 'run%2Fone/return/chat/session/chat%2Fone/plan/plan%20one/'
      + 'answer/answer%20%231',
    );
    const handle = await bootstrapWebclient(fixture.opts);

    const data = findChildByAttr(
      routeContentRoot(fixture.root),
      DATA_ROUTE_HOST_ATTR,
    );
    expect(data).not.toBeNull();
    expect(data!.innerHTML).toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(data!.innerHTML).toContain(
      'Check the item involved in the change',
    );
    expect(data!.innerHTML).toContain(DATA_ROUTE_VERIFICATION_NEXT_ATTR);
    expect(data!.innerHTML).toContain(
      'Loading the linked item before next steps become available',
    );
    expect(data!.innerHTML).not.toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );

    const answerRpc = (method: string, result: unknown): void => {
      const call = fixture.transportControls.sendCalls().find(
        (candidate) =>
          candidate !== null
          && typeof candidate === 'object'
          && (candidate as { method?: unknown }).method === method,
      ) as { request_id?: unknown } | undefined;
      expect(call, `missing ${method} request`).toBeDefined();
      expect(typeof call?.request_id).toBe('string');
      fixture.transportControls.fireMessage({
        type: 'rpc_result',
        request_id: call!.request_id,
        result,
      });
    };
    await flush();
    answerRpc('collection.listInstances', {
      instances: [{
        slug: 'work',
        platform: 'calendar',
        adapter_type: 'gcal',
        caps: {},
        auth_state: 'healthy',
        last_synced_at: 1,
      }],
    });
    await flush();
    answerRpc('collection.list', {
      records: [{
        record_id: 'event-1',
        received_at: 1,
        modified_at: 1,
        hot_fields: { summary: 'Customer review' },
        size_bytes: 0,
        source_id: 'provider-event-1',
      }],
    });
    await flush();
    answerRpc('collection.get', {
      record: {
        record_id: 'event-1',
        received_at: 1,
        modified_at: 1,
        hot_fields: { summary: 'Customer review' },
        size_bytes: 0,
        source_id: 'provider-event-1',
      },
    });
    await flush();
    await flush();

    expect(data!.innerHTML).toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );
    expect(data!.innerHTML).toContain(
      'href="#chat/session/chat%2Fone/plan/plan%20one/answer/'
      + 'answer%20%231/verification/reviewed/run/run%2Fone/'
      + 'relationship/involved"',
    );
    expect(data!.innerHTML).toContain(
      'href="#logs/run%2Fone/return/chat/session/chat%2Fone/plan/'
      + 'plan%20one/answer/answer%20%231"',
    );
    expect(data!.innerHTML).toContain('Back to run outcome');
    expect(data!.innerHTML).toMatch(
      new RegExp(
        `${DATA_ROUTE_TAB_ATTR}="calendar"[\\s\\S]*?aria-selected="true"`,
      ),
    );

    await handle.dispose();
  });

  it('threads cryptoKeysWiper through to the Settings route Privacy panel', async () => {
    let wiped = 0;
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      cryptoKeysWiper: async () => {
        wiped += 1;
      },
    });
    const settings = handle.settingsRoute()!;
    const panel = settings.clearThisBrowserPanel();
    panel.clickClear();
    await panel.clickConfirm();
    expect(panel.getState()).toBe('done');
    expect(wiped).toBe(1);
    await handle.dispose();
  });

  it('Codex slice-110 P3 fold — Reception dispose clears the reception route mount on route flip', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    // Reception is the default → its route root is mounted.
    expect(receptionMounted(fixture.root)).toBe(true);
    // Flip to settings → the reception root MUST be torn down so the settings
    // route mounts under a content slot that matches a cold #settings boot
    // byte-identically.
    fixture.hashSource.setHash('#settings');
    expect(receptionMounted(fixture.root)).toBe(false);
    // Flip back to reception → the route root re-mounts.
    fixture.hashSource.setHash('#reception');
    expect(receptionMounted(fixture.root)).toBe(true);
    await handle.dispose();
    // Post-dispose the reception route root is gone for good.
    expect(findChildByAttr(fixture.root, 'data-recued-reception-route')).toBeNull();
  });

  // ── Slice 111 — Server section gated mount + rpc composition ─────

  it('slice 111 — Server section mounts by default on the Settings route', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient(fixture.opts);
    const settings = handle.settingsRoute()!;
    // The Server section's TLS renew panel mount handle is non-null
    // because `enableTlsRenewPanel` defaults to truthy in the bootstrap
    // composer.
    expect(settings.tlsRenewPanel()).not.toBeNull();
    expect(settings.tlsRenewPanel()!.getState()).toBe('idle');
    await handle.dispose();
  });

  it('slice 111 — enableTlsRenewPanel: false opts the Server section out', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableTlsRenewPanel: false,
    });
    const settings = handle.settingsRoute()!;
    expect(settings.tlsRenewPanel()).toBeNull();
    await handle.dispose();
  });

  it('slice 111 — clicking "Renew now" dispatches a tls.renew rpc envelope', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient(fixture.opts);
    const tls = handle.settingsRoute()!.tlsRenewPanel()!;

    // Reset send tracker — the bootstrap's `events.subscribe` rpc
    // already landed during construction; we only care about the
    // envelope the "Renew now" button drives.
    const baseline = fixture.transportControls.sendCalls().length;

    tls.clickRenew();
    // Don't await clickConfirm() — the fake transport's `send` is a
    // no-op so the rpc never resolves; verifying the envelope reached
    // the transport is enough. The pending promise stays open until
    // dispose() rejects it via `rpcConn.dispose()`.
    const inflight = tls.clickConfirm();

    // Find the new send call carrying the `tls.renew` method.
    const allSends = fixture.transportControls.sendCalls();
    const newSends = allSends.slice(baseline);
    const tlsCall = newSends.find(
      (s) =>
        s !== null &&
        typeof s === 'object' &&
        (s as { type?: unknown }).type === 'rpc' &&
        (s as { method?: unknown }).method === 'tls.renew',
    ) as { type: 'rpc'; method: 'tls.renew'; args: Record<string, unknown> } | undefined;
    expect(tlsCall).toBeDefined();
    // No reason / offset → empty args (DD#4 — the rpc lets the engine
    // default to its 7d lead).
    expect(tlsCall!.args).toEqual({});

    await handle.dispose();
    // Rebind the inflight rejection so the test doesn't surface as an
    // unhandled rejection. Disposing the conn rejects pending rpcs
    // with `transport_disposed`.
    await inflight.catch(() => undefined);
  });
});

// ══════════════════════════════════════════════════════════════════
// Handle accessors
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 — bootstrapWebclient: handle accessors', () => {
  it('exposes the constructed Reception shell + conn for downstream callers', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const shell = handle.receptionShell();
    expect(typeof shell.loadPage).toBe('function');
    const conn = handle.conn();
    expect(typeof conn).toBe('function');
    await handle.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// D-156 P8 Codex P1 fold — onReauthRequired funnel
// ══════════════════════════════════════════════════════════════════

describe('D-156 P8 — bootstrapWebclient: onReauthRequired funnel', () => {
  // The fake transport's raw `fireState` doesn't propagate through
  // the ws-client's wrapped state machine (the wrapped state goes to
  // `reauth_required` only when `isReauthError` lands on send/open).
  // Drive the production path by injecting a `WebclientReauthRequired
  // Error` from `transport.send`; the bootstrap's `events.subscribe`
  // rpc hits send → ws-client transitions to `reauth_required` → the
  // bootstrap's `onState` listener fires the callback.
  const buildReauthOnSendFixture = async (): Promise<{
    fixture: ReturnType<typeof buildOpts>;
  }> => {
    const { WebclientReauthRequiredError } = await import(
      '../realtime/ws-client.js'
    );
    const fixture = buildOpts();
    fixture.transportControls.transport.send = async (): Promise<void> => {
      throw new WebclientReauthRequiredError('test_reauth');
    };
    return { fixture };
  };

  it('fires onReauthRequired exactly once when ws-client transitions to reauth_required', async () => {
    const { fixture } = await buildReauthOnSendFixture();
    let fired = 0;
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      onReauthRequired: () => {
        fired += 1;
      },
    });
    // `events.subscribe` rpc fires from inside bootstrap → send →
    // reauth → state transition → callback. Flush microtasks twice
    // to let the rpc-conn surface the error + the state listener
    // process.
    await flush();
    await flush();
    expect(fired).toBe(1);
    await handle.dispose();
  });

  it('omitted onReauthRequired is a no-op (bootstrap does not crash on transition)', async () => {
    const { fixture } = await buildReauthOnSendFixture();
    // No onReauthRequired wired.
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    await flush();
    await handle.dispose();
  });

  it('detaches the reauth listener on dispose', async () => {
    // Use a fresh non-rejecting fixture so initial setup doesn't
    // pre-trigger the callback before the test gets to disposal.
    const fixture = buildOpts();
    let fired = 0;
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      onReauthRequired: () => {
        fired += 1;
      },
    });
    await handle.dispose();
    // Post-dispose: even a raw transport state transition wouldn't
    // reach the listener since the bootstrap detached. Wrapped-state
    // transitions also can't fire because the ws-client is closed.
    fixture.transportControls.fireState('reauth_required');
    expect(fired).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// Dispose teardown order
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 — bootstrapWebclient: dispose', () => {
  it('reverses construction: detach hash listener → unmount route → dispose shell → dispose conn → close ws', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).not.toBeNull();
    expect(routeContentRoot(fixture.root).childList.length).toBe(1);
    expect(fixture.hashSource.listenerCount()).toBe(1);
    await handle.dispose();
    // Toast overlay + persistent shell disposed → root fully drained.
    expect(fixture.root.childList.length).toBe(0);
    expect(fixture.hashSource.listenerCount()).toBe(0);
    expect(fixture.transportControls.closeCount()).toBe(1);
  });

  it('is idempotent', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});


// ══════════════════════════════════════════════════════════════════
// Bearer-rotation discipline
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// DD#8 — events.subscribe wiring
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4 DD#8 — bootstrapWebclient: events.subscribe wiring', () => {
  it('fires events.subscribe rpc with WEBCLIENT_DEFAULT_SUBSCRIPTIONS after ws.connect()', async () => {
    const fixture = buildOpts();
    const sent: unknown[] = [];
    fixture.transportControls.transport.send = async (m: unknown): Promise<void> => {
      sent.push(m);
    };
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    const subEnv = sent.find(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as { method?: unknown }).method === 'events.subscribe',
    ) as { args?: { kinds?: unknown } } | undefined;
    expect(subEnv).toBeDefined();
    expect(Array.isArray(subEnv?.args?.kinds)).toBe(true);
    expect((subEnv?.args?.kinds as string[]).length).toBeGreaterThan(0);
    expect((subEnv?.args?.kinds as string[])).toContain('approval');
    expect((subEnv?.args?.kinds as string[])).toContain('token.rotated');
    await handle.dispose();
  });

  it('onSubscribeError fires when the subscribe rpc rejects (reauth-required at send time)', async () => {
    // The bootstrap's `events.subscribe` rpc reaches `ws.send` which
    // re-throws a `WebclientReauthRequiredError` (the one transport-send
    // error path the ws-client propagates instead of enqueueing). The
    // rpc-conn then rejects the pending entry, the bootstrap's catch
    // fires, and `onSubscribeError` is invoked.
    const { WebclientReauthRequiredError } = await import(
      '../realtime/ws-client.js'
    );
    const fixture = buildOpts();
    let onSubscribeErr: Error | null = null;
    fixture.transportControls.transport.send = async (): Promise<void> => {
      throw new WebclientReauthRequiredError('test_reauth');
    };
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      onSubscribeError: (err) => {
        onSubscribeErr = err;
      },
    });
    await flush();
    await flush();
    expect(onSubscribeErr).not.toBeNull();
    expect((onSubscribeErr as unknown as Error).message).toMatch(/reauth required/);
    await handle.dispose();
  });

  it('a missing onSubscribeError still swallows subscribe failures (no crash)', async () => {
    const { WebclientReauthRequiredError } = await import(
      '../realtime/ws-client.js'
    );
    const fixture = buildOpts();
    fixture.transportControls.transport.send = async (): Promise<void> => {
      throw new WebclientReauthRequiredError('test_reauth');
    };
    // No onSubscribeError supplied — bootstrap must not crash.
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    await flush();
    expect(handle.activeRoute()).toBe('reception');
    await handle.dispose();
  });
});

describe('M-XSURF-1 — bootstrapWebclient: exposure_changed consumer', () => {
  it('updates the Reception shell status from exposure_changed', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      initialReceptionStatus: {
        emergency_disabled: false,
        reception_public: true,
        base_url: 'https://ready.recued.cloud/reception/',
      },
    });

    fixture.transportControls.fireMessage({
      type: 'server_event',
      event: {
        kind: 'exposure_changed',
        resolution: exposureResolution(false),
        derived_preset_label: 'lan_only',
        public_mcp_acknowledgement: { acknowledged: false },
        changed_at: 1_700_000_000_001,
        changed_by_client_id: 'client-A',
        cursor: 42,
      },
    });

    expect(handle.receptionShell().getState().status).toEqual({
      emergency_disabled: false,
      reception_public: false,
      base_url: null,
    });
    await handle.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// § A.6.5 + § A.9 / slice 128 — passport-fetch verify default-on
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 / slice 128 — bootstrapWebclient: enablePassportFetchVerify default-on', () => {
  it('fires passport.fetch on ws connect when no flag is passed (default-on after slice 128)', async () => {
    const fixture = buildOpts();
    const sent: unknown[] = [];
    fixture.transportControls.transport.send = async (m: unknown): Promise<void> => {
      sent.push(m);
    };
    // No `enablePassportFetchVerify` field on opts — pre-slice-128 the
    // default was OFF + this rpc would NEVER appear in the send log.
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    const fetchEnv = sent.find(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as { method?: unknown }).method === 'passport.fetch',
    );
    expect(fetchEnv).toBeDefined();
    await handle.dispose();
  });

  it('honors explicit enablePassportFetchVerify: false (opt-out for bespoke compositions)', async () => {
    const fixture = buildOpts();
    const sent: unknown[] = [];
    fixture.transportControls.transport.send = async (m: unknown): Promise<void> => {
      sent.push(m);
    };
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePassportFetchVerify: false,
    });
    await flush();
    const fetchEnv = sent.find(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as { method?: unknown }).method === 'passport.fetch',
    );
    expect(fetchEnv).toBeUndefined();
    await handle.dispose();
  });

  it('honors explicit enablePassportFetchVerify: true (production explicit-opt-in path stays working)', async () => {
    const fixture = buildOpts();
    const sent: unknown[] = [];
    fixture.transportControls.transport.send = async (m: unknown): Promise<void> => {
      sent.push(m);
    };
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePassportFetchVerify: true,
    });
    await flush();
    const fetchEnv = sent.find(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as { method?: unknown }).method === 'passport.fetch',
    );
    expect(fetchEnv).toBeDefined();
    await handle.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// § A.6.5 / slice 114 — cert-pin polling timer (DD#10)
// ══════════════════════════════════════════════════════════════════

import {
  CERT_PIN_POLL_INTERVAL_MS,
} from '../webclient-bootstrap.js';
import {
  CERT_PIN_STALE_PANEL_ATTR,
} from '../settings/cert-pin-stale-panel.js';
import type { WebclientCertPinState } from '@recued/contracts';

interface FakePollTimerControls {
  setPollTimer: (
    handler: () => void,
    intervalMs: number,
  ) => { cancel: () => void };
  /** Every `setPollTimer` invocation recorded for assertion. */
  registrations(): Array<{ intervalMs: number }>;
  /** Synthesize a tick by calling the captured handler. Throws if no
   *  timer has been registered yet. */
  tick(): void;
  /** Number of times `cancel()` has been invoked on any registered
   *  timer. */
  cancelCount(): number;
}

const buildFakePollTimer = (): FakePollTimerControls => {
  const registrations: Array<{ intervalMs: number }> = [];
  let handler: (() => void) | null = null;
  let cancels = 0;
  return {
    setPollTimer: (h, intervalMs) => {
      handler = h;
      registrations.push({ intervalMs });
      return {
        cancel: () => {
          cancels += 1;
        },
      };
    },
    registrations: () => registrations.slice(),
    tick: () => {
      if (handler === null) throw new Error('setPollTimer not yet called');
      handler();
    },
    cancelCount: () => cancels,
  };
};

const ACTIVE_PIN_STATE_114 = (current_valid_until: number): WebclientCertPinState => ({
  current_fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  next_fingerprint:
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  current_valid_until,
});

describe('D-148 § A.6.5 / slice 114 — bootstrapWebclient: cert-pin polling timer', () => {
  it('schedules the polling timer at the default 60s cadence when the watcher is constructed', async () => {
    const fixture = buildOpts();
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      setCertPinPollTimer: timer.setPollTimer,
    });
    const regs = timer.registrations();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.intervalMs).toBe(CERT_PIN_POLL_INTERVAL_MS);
    expect(CERT_PIN_POLL_INTERVAL_MS).toBe(60_000);
    await handle.dispose();
  });

  it('does NOT schedule the polling timer when enableCertPinStalePanel: false', async () => {
    const fixture = buildOpts();
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableCertPinStalePanel: false,
      setCertPinPollTimer: timer.setPollTimer,
    });
    expect(timer.registrations()).toHaveLength(0);
    expect(handle.certPinStateWatcher()).toBeNull();
    await handle.dispose();
    expect(timer.cancelCount()).toBe(0);
  });

  it('honors a custom certPinPollIntervalMs', async () => {
    const fixture = buildOpts();
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      setCertPinPollTimer: timer.setPollTimer,
      certPinPollIntervalMs: 10_000,
    });
    const regs = timer.registrations();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.intervalMs).toBe(10_000);
    await handle.dispose();
  });

  it('a tick on Reception is a no-op (no settings route → no panel)', async () => {
    const fixture = buildOpts();
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      setCertPinPollTimer: timer.setPollTimer,
    });
    expect(handle.activeRoute()).toBe('reception');
    // No throw + no DOM mutation under root from the tick.
    const beforeChildren = fixture.root.childList.length;
    expect(() => timer.tick()).not.toThrow();
    expect(fixture.root.childList.length).toBe(beforeChildren);
    await handle.dispose();
  });

  it('a tick on Settings re-renders the cert-pin panel against the current clock', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    const FLIP_AT_FUTURE = FIXED_NOW + 3 * 24 * 60 * 60 * 1000;
    const fixture = buildOpts();
    // Seed pair state with an active overlap so the watcher's cold-
    // boot refresh() picks it up.
    await fixture.localStore.set(
      'cert_pin_state',
      ACTIVE_PIN_STATE_114(FLIP_AT_FUTURE),
    );
    fixture.hashSource.setHash('#settings');
    const timer = buildFakePollTimer();
    // Explicit `now` override — the test asserts the `current_valid_until
    // > now` gate against the seeded `1_700_000_000_000` baseline. Pass
    // the seam directly rather than relying on `buildOpts()` happening
    // to default to the same value (decoupling guards against a future
    // fixture refactor silently breaking this test — Codex slice-114
    // P1 fold for test clarity).
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      now: () => FIXED_NOW,
      setCertPinPollTimer: timer.setPollTimer,
    });
    await flush();
    // Panel surface is present + view state populated.
    const settings = handle.settingsRoute()!;
    expect(settings.certPinStalePanel()?.getViewState()).not.toBeNull();
    expect(findChildByAttr(fixture.root, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    // Tick — should not change anything since `now` hasn't moved.
    timer.tick();
    expect(settings.certPinStalePanel()?.getViewState()).not.toBeNull();
    await handle.dispose();
  });

  it('a tick after `now` crosses current_valid_until auto-hides the panel (end-to-end)', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    const FLIP_AT = FIXED_NOW + 3 * 24 * 60 * 60 * 1000;
    const fixture = buildOpts();
    // Mutable clock seam — the bootstrap threads `now` through to the
    // settings route → panel mount, which reads it on every update().
    let currentNow = FIXED_NOW;
    await fixture.localStore.set(
      'cert_pin_state',
      ACTIVE_PIN_STATE_114(FLIP_AT),
    );
    fixture.hashSource.setHash('#settings');
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      now: () => currentNow,
      setCertPinPollTimer: timer.setPollTimer,
    });
    await flush();
    const settings = handle.settingsRoute()!;
    expect(settings.certPinStalePanel()?.getViewState()).not.toBeNull();
    expect(findChildByAttr(fixture.root, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    // Advance the clock past the flip + tick.
    currentNow = FLIP_AT + 1;
    timer.tick();
    expect(settings.certPinStalePanel()?.getViewState()).toBeNull();
    expect(findChildByAttr(fixture.root, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    await handle.dispose();
  });

  it('dispose cancels the polling timer BEFORE the route mount tears down', async () => {
    const fixture = buildOpts();
    const timer = buildFakePollTimer();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      setCertPinPollTimer: timer.setPollTimer,
    });
    expect(timer.cancelCount()).toBe(0);
    await handle.dispose();
    expect(timer.cancelCount()).toBe(1);
    // Idempotent — second dispose does not re-cancel.
    await handle.dispose();
    expect(timer.cancelCount()).toBe(1);
  });

  it('production default (no override) uses globalThis.setInterval-backed real timer', async () => {
    // We don't drive the real timer — only verify the bootstrap accepts
    // an absent seam + completes setup. The realInterval impl is
    // internal; tests that drive ticks always inject the fake.
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.certPinStateWatcher()).not.toBeNull();
    await handle.dispose();
  });
});

describe('D-148 § A.4 — bootstrapWebclient: bearer rotation', () => {
  it('resolveBearer reads the active store record on each open (no cache)', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    // First open used `tok-abc`.
    expect(fixture.tokenStoreControls.unwrapCalls()[0]!.record_id).toBe('tok-abc');
    // Rotate the token in the store.
    await fixture.localStore.set('webclient_token', sampleToken('tok-rotated'));
    // Fire a transport-state disconnect → reconnecting — the ws
    // client's reconnect path re-invokes `resolveBearer`. We
    // verify by checking unwrap was called with the new record id.
    // (The default `setTimer` schedules the next attempt; we use vi's
    // fake timers to flush.)
    vi.useFakeTimers();
    try {
      // Pretend the transport drops; the ws-client will queue a
      // reconnect that uses our `resolveBearer` again.
      fixture.transportControls.fireState('disconnected');
      // Drain the first scheduled reconnect tick.
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
      await flush();
    }
    // We expect at least one additional unwrap call for the rotated
    // token id. The exact count depends on backoff scheduling; the
    // important invariant is that the rotated id was used (i.e. no
    // cached bearer).
    const calls = fixture.tokenStoreControls.unwrapCalls();
    const rotated = calls.find((c) => c.record_id === 'tok-rotated');
    expect(rotated).toBeDefined();
    await handle.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════
// Tier 3 — server_heartbeat demux wire (half-open detection)
// ══════════════════════════════════════════════════════════════════

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.childList) {
    const hit = findByAttr(child, attr);
    if (hit) return hit;
  }
  return null;
};

describe('Tier 3 — bootstrapWebclient: server_heartbeat feeds half-open detection', () => {
  it('demuxes a server_heartbeat broadcast to noteHeartbeat — recovering a stalled connection', async () => {
    const fixture = buildOpts();

    // Deterministic timer for the connection-status controller so the
    // heartbeat-stale window is driven by hand (this seam ONLY feeds that
    // controller, so its grace + two-phase stale timers are the only entries).
    interface Slot {
      handler: () => void;
      delayMs: number;
      cancelled: boolean;
    }
    const slots: Slot[] = [];
    const setConnectionStatusTimer = (
      handler: () => void,
      delayMs: number,
    ): { cancel: () => void } => {
      const slot: Slot = { handler, delayMs, cancelled: false };
      slots.push(slot);
      return {
        cancel: () => {
          slot.cancelled = true;
        },
      };
    };
    // Fire the one live controller timer — asserting it is unambiguous so a
    // wrong-timer misfire can't pass silently.
    const fireOnlyLiveTimer = (): void => {
      const live = slots.filter((s) => !s.cancelled);
      expect(live.length).toBe(1);
      const target = live[0]!;
      target.cancelled = true;
      target.handler();
    };

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      setConnectionStatusTimer,
    });
    await flush();

    // The fake transport drives `connected` on open → the chip shows
    // connected and the heartbeat-stale timer is now armed.
    const chip = findByAttr(fixture.root, CONNECTION_CHIP_ATTR);
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('data-state')).toBe('connected');

    // No beats arrive → the two-phase stale timer crosses to `stalled`.
    fireOnlyLiveTimer(); // phase 1 → arms the confirmation timer
    fireOnlyLiveTimer(); // confirmation → stalled
    expect(chip!.getAttribute('data-state')).toBe('stalled');

    // THE WIRE UNDER TEST — a `server_heartbeat` broadcast must be demuxed to
    // `connectionStatus.noteHeartbeat()`, recovering the connection. If the
    // bootstrap's `type === 'server_heartbeat'` branch were missing or
    // mistyped, the frame would fall through to the event subscriber and the
    // chip would stay `stalled` — so this assertion guards the dead-path.
    fixture.transportControls.fireMessage({
      type: 'server_heartbeat',
      payload: { server_id: 'sha256:x', last_seen_at: 1, lifecycle_state: 'running' },
    });
    expect(chip!.getAttribute('data-state')).toBe('connected');

    await handle.dispose();
  });
});

describe('D-109 — bootstrapWebclient: server-status pill from server_heartbeat', () => {
  it('feeds a server_heartbeat snapshot to the topbar pill while connected', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    // The fake transport drives `connected` on open. No beat yet → the pill
    // host renders nothing (and B1 would hide it anyway until connected, which
    // it is). D-188 wraps the pill in an anchor + popover under the host, so we
    // read the whole subtree, not the host's own (never-set) innerHTML string.
    const pillHost = findByAttr(fixture.root, SERVER_PILL_HOST_ATTR);
    expect(pillHost).not.toBeNull();
    expect(subtreeInnerHtml(pillHost!)).toBe('');

    // A fresh `server_heartbeat` (last_seen_at ~ now → not stale) renders the
    // green running pill — proving the demux feeds `mountWebclientServerPill`.
    fixture.transportControls.fireMessage({
      type: 'server_heartbeat',
      payload: {
        server_id: 'sha256:pill',
        last_seen_at: Date.now(),
        lifecycle_state: 'running',
        uptime_s: 43_200,
      },
    });
    expect(subtreeInnerHtml(pillHost!)).toContain('server-pill--green');
    expect(subtreeInnerHtml(pillHost!)).toContain('Server');

    await handle.dispose();
  });
});

describe('Data accepted response → manual automation run', () => {
  it('threads recipe discovery and a routing-only manual execute request', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const rpcCall = (method: string) => [...fixture.transportControls.sendCalls()]
      .reverse()
      .find(
        (call) =>
          call !== null
          && typeof call === 'object'
          && (call as { method?: unknown }).method === method,
      ) as { request_id?: unknown; args?: unknown } | undefined;

    fixture.hashSource.setHash('#data/form_response/submission-1');
    await flush();
    const listResponses = rpcCall('form_response.list');
    expect(typeof listResponses?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: listResponses!.request_id,
      result: { responses: [] },
    });
    await flush();

    const getResponse = rpcCall('form_response.get');
    expect(typeof getResponse?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: getResponse!.request_id,
      result: {
        response: {
          _id: 'submission-1',
          _collection: 'form_response',
          submission_id: 'submission-1',
          endpoint_id: 'endpoint-1',
          form_definition_id: 'project-intake',
          definition_snapshot: {
            form_definition_id: 'project-intake',
            fields: [{ name: 'secret', label: 'Secret', type: 'text' }],
          },
          values: { secret: 'visitor answer' },
          visitor: { email: 'visitor@example.test' },
          submitted_at: 1_000,
          accepted_at: 2_000,
          updated_at: 2_000,
          origin_actor: 'anonymous',
          origin_surface: 'system',
          lifecycle_state: 'new',
          state_changed_at: 2_000,
          metadata: { private_plan: 'owner-only plan' },
        },
      },
    });
    await flush();
    await flush();

    const dataRoot = findChildByAttr(fixture.root, DATA_ROUTE_HOST_ATTR);
    expect(dataRoot).not.toBeNull();
    expect(dataRoot!.innerHTML).toContain(DATA_ROUTE_FORM_RESPONSE_RUN_ATTR);
    dataRoot!.fireAttributeClick({
      'data-recued-data-action': 'discover-form-response-automations',
    });
    expect(dataRoot!.innerHTML).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="loading"`,
    );
    await flush();
    await flush();
    const listRecipes = rpcCall('recipe.list');
    expect(typeof listRecipes?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: listRecipes!.request_id,
      result: {
        recipes: [{
          recipe_id: 'handle-project-intake',
          publisher_id: 'kitchen',
          version: 1,
          recipe_hash: 'hash-handle-project-intake',
          source: 'pair-sync',
          installed_at: 1,
          recipe: {
            recipe_id: 'handle-project-intake',
            version: 1,
            ttl: 300,
            metadata: {
              name: 'Handle project intake',
              description: '',
              author: 'local',
              supported_platforms: [],
            },
            variables: {},
            event_triggers: [{
              on: 'form_response.accepted',
              where: { form_definition_id: 'project-intake' },
            }],
            prefetch_steps: [{
              id: 'form_response',
              op: 'core.data.form-response.get',
              args: { submission_id: '{{context.event.payload.record_id}}' },
            }],
            steps: [],
            output: { render: [] },
          },
        }],
      },
    });
    await flush();
    expect(dataRoot!.innerHTML).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="ready"`,
    );

    dataRoot!.fireAttributeClick({
      'data-recued-data-action': 'review-form-response-automation',
      'data-recued-data-form-response-run-recipe': 'handle-project-intake',
    });
    const content = routeContentRoot(fixture.root);
    const runModal = content.childList.at(-1);
    expect(runModal).not.toBe(dataRoot);
    expect(runModal?.innerHTML).toContain('Context JSON (prefilled)');
    runModal?.fireAttributeClick({
      [RunModal.RUN_MODAL_ACTION_ATTR]: 'confirm-run',
    });
    await flush();

    const execute = rpcCall('execute');
    expect(execute?.args).toEqual({
      recipe_id: 'handle-project-intake',
      config: {},
      context: {
        event: {
          topic: ['data', 'form_response', 'accepted', 'response', 'created'],
          kind: 'created',
          payload: {
            record_id: 'submission-1',
            at: 2_000,
            platform: 'form_response',
            slug: 'accepted',
            entity_type: 'response',
            record: {
              _id: 'submission-1',
              _collection: 'form_response',
              submission_id: 'submission-1',
              endpoint_id: 'endpoint-1',
              form_definition_id: 'project-intake',
              submitted_at: 1_000,
              accepted_at: 2_000,
            },
          },
        },
      },
      trigger_source: 'manual',
    });
    expect(JSON.stringify(execute?.args)).not.toContain('visitor answer');
    expect(JSON.stringify(execute?.args)).not.toContain('visitor@example.test');
    expect(JSON.stringify(execute?.args)).not.toContain('owner-only plan');

    await handle.dispose();
  });
});

describe('Data → Kitchen accepted-response automation handoff', () => {
  it('checks saved automations before mounting a contextual new recipe', async () => {
    const fixture = buildOpts();
    const replaceState = vi.fn();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      history: { replaceState },
      location: { hash: '' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };
    const handle = await bootstrapWebclient(fixture.opts);

    fixture.hashSource.setHash(
      '#kitchen/new/form-response/forms%2Fclient%20intake',
    );

    expect(handle.activeRoute()).toBe('kitchen');
    await flush();
    const listCall = fixture.transportControls.sendCalls().find(
      (call) =>
        call !== null
        && typeof call === 'object'
        && (call as { method?: unknown }).method === 'recipe.list',
    ) as { request_id?: unknown } | undefined;
    expect(typeof listCall?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: listCall!.request_id,
      result: { recipes: [] },
    });
    await flush();

    const recipeId = (findChildByAttr(
      fixture.root,
      RECIPE_EDITOR_RECIPE_ID_ATTR,
    ) as HTMLInputElement | null)?.value;
    expect(recipeId).toMatch(/^handle-form-[a-f0-9]{32}-responses$/);
    expect(
      (findChildByAttr(
        fixture.root,
        RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
      ) as HTMLInputElement | null)?.value,
    ).toBe('forms/client intake');
    expect(
      findChildByAttr(
        fixture.root,
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
      )?.getAttribute(RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR),
    ).toBe('ready');
    findChildByAttr(fixture.root, RECIPE_EDITOR_SAVE_ATTR)?.click();
    const saveCall = fixture.transportControls.sendCalls().find(
      (call) =>
        call !== null
        && typeof call === 'object'
        && (call as { method?: unknown }).method === 'recipe.save',
    ) as { request_id?: unknown } | undefined;
    expect(typeof saveCall?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: saveCall!.request_id,
      result: {
        saved: true,
        recipe_id: recipeId,
        version: 1,
        name: 'Handle accepted form responses',
      },
    });
    await flush();
    expect(
      findChildByAttrValue(
        fixture.root,
        KITCHEN_ROUTE_TAB_ATTR,
        'recipe',
      )?.getAttribute('href'),
    ).toBe(`#kitchen/recipe/${recipeId}`);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      `#kitchen/recipe/${recipeId}`,
    );

    await handle.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Leave guard — unsaved route work vs hash navigation + tab close.
// ──────────────────────────────────────────────────────────────────

describe('leave guard — unsaved route work', () => {
  const buildGuardFixture = () => {
    const fixture = buildOpts();
    const confirmFn = vi.fn(() => false);
    const replaceState = vi.fn();
    const location = { hash: '' };
    const beforeUnloadListeners = new Set<(event: unknown) => void>();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      confirm: confirmFn,
      location,
      history: { replaceState },
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.add(fn);
      },
      removeEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.delete(fn);
      },
    };
    return { fixture, confirmFn, replaceState, location, beforeUnloadListeners };
  };

  /** Mount Kitchen and make it dirty via a click-only edit (Add field —
   *  an entity row counts as unsaved content). */
  const mountDirtyKitchen = (fixture: ReturnType<typeof buildOpts>): void => {
    fixture.hashSource.setHash('#kitchen');
    const addField = findChildByAttr(
      fixture.root,
      INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR,
    );
    expect(addField).not.toBeNull();
    addField!.click();
  };

  it('declining the confirm keeps the route mounted and reverts the hash', async () => {
    const { fixture, confirmFn, location } = buildGuardFixture();
    const handle = await bootstrapWebclient(fixture.opts);

    mountDirtyKitchen(fixture);
    expect(handle.activeRoute()).toBe('kitchen');

    fixture.hashSource.setHash('#recipes');

    expect(confirmFn).toHaveBeenCalledTimes(1);
    // Still on Kitchen — the editor (and its Add-field button) survived…
    expect(handle.activeRoute()).toBe('kitchen');
    expect(
      findChildByAttr(fixture.root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR),
    ).not.toBeNull();
    // …and the URL was restored by SETTING the hash (a fresh entry —
    // replaceState would destroy the entry a Back-decline traversed to).
    expect(location.hash).toBe('#kitchen/pack');

    await handle.dispose();
  });

  it('accepting the confirm navigates away; a clean route never asks', async () => {
    const { fixture, confirmFn } = buildGuardFixture();
    const handle = await bootstrapWebclient(fixture.opts);

    // Clean Kitchen (blank draft) → no confirm on leave.
    fixture.hashSource.setHash('#kitchen');
    fixture.hashSource.setHash('#recipes');
    expect(confirmFn).not.toHaveBeenCalled();
    expect(handle.activeRoute()).toBe('recipes');

    // Dirty Kitchen + accept → navigates.
    mountDirtyKitchen(fixture);
    confirmFn.mockReturnValueOnce(true);
    fixture.hashSource.setHash('#recipes');
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(handle.activeRoute()).toBe('recipes');

    await handle.dispose();
  });

  it('keeps a typed Chat draft when cross-route navigation is declined', async () => {
    const { fixture, confirmFn, location } = buildGuardFixture();
    fixture.hashSource.setHash('#chat');
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    const sessionsList = fixture.transportControls.sendCalls().find(
      (call) =>
        call !== null
        && typeof call === 'object'
        && (call as { type?: unknown }).type === 'rpc'
        && (call as { method?: unknown }).method === 'chat.sessions.list',
    ) as { request_id?: unknown } | undefined;
    expect(typeof sessionsList?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessionsList!.request_id,
      result: { sessions: [] },
    });
    await flush();

    const input = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR);
    expect(input).not.toBeNull();
    input!.fireInput('Keep this unfinished Chat thought');
    fixture.hashSource.setHash('#reception');

    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(handle.activeRoute()).toBe('chat');
    expect(location.hash).toBe('#chat');
    expect(
      findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)?.value,
    ).toBe('Keep this unfinished Chat thought');

    await handle.dispose();
  });

  it('beforeunload asks only while the mounted route is dirty; dispose detaches', async () => {
    const { fixture, beforeUnloadListeners } = buildGuardFixture();
    const handle = await bootstrapWebclient(fixture.opts);
    expect(beforeUnloadListeners.size).toBe(1);
    const fire = (): { defaultPrevented: boolean; returnValue: unknown } => {
      const event = {
        defaultPrevented: false,
        returnValue: undefined as unknown,
        preventDefault(): void {
          event.defaultPrevented = true;
        },
      };
      for (const listener of [...beforeUnloadListeners]) listener(event);
      return event;
    };

    // Clean (reception) route → no prompt.
    expect(fire().defaultPrevented).toBe(false);

    mountDirtyKitchen(fixture);
    const dirty = fire();
    expect(dirty.defaultPrevented).toBe(true);
    expect(dirty.returnValue).toBe('');

    await handle.dispose();
    expect(beforeUnloadListeners.size).toBe(0);
  });
});
